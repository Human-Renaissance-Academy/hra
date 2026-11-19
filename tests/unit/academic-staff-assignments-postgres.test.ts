// @vitest-environment node
/**
 * #165 기수별 운영 인력 배정·학사 운영 관리자 지정·출결 권한 판정의 실제 PostgreSQL 회귀입니다.
 *
 * - 소유 임시 클러스터(HRA_TEST_PG_BIN)에 최소 users·cohorts 표와 검토 SQL만 설치합니다. 운영 DB·환경 파일은 읽지 않습니다.
 * - SQL 직접 호출로 상한·동시성·불변성·감사·멱등성을, Drizzle·Neon SDK 경로로 서비스 플래그·오류 변환·판정을 확인합니다.
 */
import { neon, neonConfig } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { createQaPostgres } from "../support/resource-qa-postgres.mjs";
import {
  createPsqlTransport,
  qaDatabaseUrl,
  qaNeonEndpoint,
} from "../support/neon-psql-transport.mjs";

const mocks = vi.hoisted(() => ({
  database: undefined as NeonHttpDatabase<typeof schema> | undefined,
  calls: 0,
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({
  get db() {
    if (!mocks.database) throw new Error("격리 DB 준비 전 호출");
    return mocks.database;
  },
}));

import {
  assignCohortStaff,
  canRecordAttendance,
  designateOperationsManager,
  endCohortStaffAssignment,
} from "@/features/academics/staff/service";

const bin = process.env.HRA_TEST_PG_BIN;
const execFileAsync = promisify(execFile);
const migration = readFileSync(
  new URL("../../scripts/migrate-academic-staff-assignments.sql", import.meta.url),
  "utf8",
);

// 합성 계정. 전역 역할은 판정 근거가 아니며 ADMIN·FACULTY도 배정 없이는 거부되어야 합니다.
const ids = {
  approver: "16500000-0000-4000-8000-000000000001",
  manager: "16500000-0000-4000-8000-000000000002",
  advisor: "16500000-0000-4000-8000-000000000003",
  advisorB: "16500000-0000-4000-8000-000000000004",
  assistantA: "16500000-0000-4000-8000-000000000005",
  assistantB: "16500000-0000-4000-8000-000000000006",
  assistantC: "16500000-0000-4000-8000-000000000007",
  admin: "16500000-0000-4000-8000-000000000008",
  faculty: "16500000-0000-4000-8000-000000000009",
  pending: "16500000-0000-4000-8000-00000000000a",
  otherManager: "16500000-0000-4000-8000-00000000000b",
};
const evidence = "16500000-0000-4000-8000-0000000000ee";
const roles: Record<string, string> = {
  approver: "MEMBER",
  manager: "MEMBER",
  advisor: "MEMBER",
  advisorB: "FACULTY",
  assistantA: "MEMBER",
  assistantB: "MEMBER",
  assistantC: "MEMBER",
  admin: "ADMIN",
  faculty: "FACULTY",
  pending: "PENDING",
  otherManager: "MEMBER",
};

type Outcome = { ok: true; out: string } | { ok: false; code: string };
const lit = (value: string | null) =>
  value === null ? "NULL" : `'${value.replaceAll("'", "''")}'`;

describe.skipIf(!bin)("#165 운영 인력 배정과 출결 권한(격리 PostgreSQL)", () => {
  let cluster: ReturnType<typeof createQaPostgres>;
  const previousFetch = neonConfig.fetchFunction;
  const previousEndpoint = neonConfig.fetchEndpoint;
  let managerDesignation: string;

  /** 원문 오류 대신 성공 출력 또는 SQLSTATE만 돌려줍니다. */
  const run = (statement: string): Outcome => {
    const result = spawnSync(
      join(bin!, "psql"),
      ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"],
      {
        input: statement,
        encoding: "utf8",
        env: { LC_ALL: "C", NODE_ENV: "test", ...cluster.environment },
        timeout: 30_000,
      },
    );
    if (result.status === 0) return { ok: true, out: result.stdout.trim() };
    return { ok: false, code: /ERROR:\s+([0-9A-Z]{5}):/.exec(result.stderr)?.[1] ?? "UNKNOWN" };
  };
  const runAsync = async (statement: string): Promise<Outcome> => {
    try {
      const { stdout } = await execFileAsync(
        join(bin!, "psql"),
        ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-c", statement],
        { env: { LC_ALL: "C", NODE_ENV: "test", ...cluster.environment }, timeout: 30_000 },
      );
      return { ok: true, out: stdout.trim() };
    } catch (error) {
      const stderr =
        error && typeof error === "object" && "stderr" in error ? String(error.stderr) : "";
      return { ok: false, code: /ERROR:\s+([0-9A-Z]{5}):/.exec(stderr)?.[1] ?? "UNKNOWN" };
    }
  };
  const value = (statement: string) => {
    const outcome = run(statement);
    if (!outcome.ok) throw new Error(`예상하지 못한 SQL 실패 ${outcome.code}`);
    return outcome.out;
  };
  const newCohort = () => {
    const id = randomUUID();
    value(`INSERT INTO cohorts(id,name) VALUES('${id}','합성 기수');`);
    return id;
  };
  /** 배정 SQL. 시각은 DB now() 기준 상대 간격으로 지정합니다. */
  const assignSql = (
    cohort: string,
    user: string,
    role: string,
    options: {
      actor?: string;
      request?: string;
      from?: string | null;
      to?: string | null;
    } = {},
  ) => `SELECT (public.assign_academic_cohort_staff('${options.request ?? randomUUID()}', '${options.actor ?? ids.manager}',
    '${randomUUID()}', '${cohort}', '${user}', '${role}', ${options.from ? `now() + interval ${lit(options.from)}` : "NULL"},
    ${options.to ? `now() + interval ${lit(options.to)}` : "NULL"}, 'IN_PERSON', '${evidence}'))->'assignment'->>'id';`;
  const assign = (
    cohort: string,
    user: string,
    role: string,
    options?: Parameters<typeof assignSql>[3],
  ) => run(assignSql(cohort, user, role, options));
  const canRecord = (user: string, cohort: string, offset = "0 seconds") =>
    value(
      `SELECT public.can_record_academic_attendance('${user}','${cohort}', now() + interval ${lit(offset)});`,
    ) === "t";

  beforeAll(() => {
    cluster = createQaPostgres(bin);
    cluster.sql(`CREATE TABLE users(id uuid PRIMARY KEY, role text NOT NULL);
      CREATE TABLE cohorts(id uuid PRIMARY KEY, name text NOT NULL);
      INSERT INTO users VALUES ${Object.entries(ids)
        .map(([key, id]) => `('${id}','${roles[key]}')`)
        .join(",")};`);
    // 같은 DB에 두 번 적용해도 성공해야 합니다(재실행 멱등성).
    cluster.sql(migration);
    cluster.sql(migration);
    const designated =
      run(`SELECT (public.designate_academic_operations_manager('${randomUUID()}','${ids.approver}',
      '${ids.approver}','${randomUUID()}','${ids.manager}',NULL,NULL,'IN_PERSON','${evidence}'))->'designation'->>'id';`);
    if (!designated.ok) throw new Error(`관리자 지정 준비 실패 ${designated.code}`);
    managerDesignation = designated.out;

    const transport = createPsqlTransport(cluster.environment);
    neonConfig.fetchEndpoint = qaNeonEndpoint;
    neonConfig.fetchFunction = async (address: unknown, options: RequestInit) => {
      if (
        String(address) !== qaNeonEndpoint ||
        new Headers(options.headers).get("Neon-Connection-String") !== qaDatabaseUrl
      )
        throw new Error("격리 SQL 범위 이외 요청 차단");
      mocks.calls++;
      try {
        return Response.json(await transport(JSON.parse(String(options.body))));
      } catch (error) {
        return Response.json(
          {
            message: "격리 SQL 실행 거부",
            ...(error && typeof error === "object" && "code" in error ? { code: error.code } : {}),
          },
          { status: 400 },
        );
      }
    };
    mocks.database = drizzle(neon(qaDatabaseUrl), { schema });
  }, 60_000);

  beforeEach(() => {
    mocks.calls = 0;
    vi.unstubAllEnvs();
    vi.stubEnv("ACADEMIC_ENABLED", "true");
    vi.stubEnv("ACADEMIC_STAFF_ENABLED", "true");
    vi.stubEnv("ACADEMIC_APPROVER_USER_ID", ids.approver);
  });

  afterAll(() => {
    mocks.database = undefined;
    neonConfig.fetchFunction = previousFetch;
    neonConfig.fetchEndpoint = previousEndpoint;
    vi.unstubAllEnvs();
    cluster?.close();
  });

  describe("SQL 설치 형태", () => {
    it("다른 구조의 같은 이름 표가 있으면 전체를 롤백하고, 원래 구조로 돌아오면 다시 통과합니다", () => {
      value("ALTER TABLE academic_staff_events ADD COLUMN extra integer;");
      expect(run(migration)).toMatchObject({ ok: false });
      value("ALTER TABLE academic_staff_events DROP COLUMN extra;");
      value(
        "ALTER TABLE academic_cohort_staff_assignments DROP CONSTRAINT academic_cohort_staff_assignments_role_check;",
      );
      value(
        "ALTER TABLE academic_cohort_staff_assignments ADD CONSTRAINT academic_cohort_staff_assignments_role_check CHECK (staff_role IN ('ADVISOR','ASSISTANT','TEACHER'));",
      );
      expect(run(migration)).toMatchObject({ ok: false });
      value(
        "ALTER TABLE academic_cohort_staff_assignments DROP CONSTRAINT academic_cohort_staff_assignments_role_check;",
      );
      value(
        "ALTER TABLE academic_cohort_staff_assignments ADD CONSTRAINT academic_cohort_staff_assignments_role_check CHECK (staff_role IN ('ADVISOR','ASSISTANT'));",
      );
      expect(run(migration)).toMatchObject({ ok: true });
    });

    it("PUBLIC에는 함수 실행 권한이 없습니다", () => {
      value(
        "DO $$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='staff_probe') THEN CREATE ROLE staff_probe NOLOGIN; END IF; END$$;",
      );
      expect(
        value(`SELECT bool_or(has_function_privilege('staff_probe', p.oid, 'EXECUTE')) FROM pg_proc p
        JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN (
        'assign_academic_cohort_staff','end_academic_cohort_staff','replace_academic_cohort_staff',
        'designate_academic_operations_manager','end_academic_operations_manager','can_record_academic_attendance',
        'close_academic_cohort_staff','require_academic_operations_manager','require_academic_staff_account',
        'academic_staff_replay');`),
      ).toBe("f");
    });
  });

  describe("학사 운영 관리자 지정", () => {
    it("지정 승인자가 아니면 지정할 수 없고, 승인자의 자기 지정도 거부합니다", () => {
      expect(
        run(`SELECT public.designate_academic_operations_manager('${randomUUID()}','${ids.admin}','${ids.approver}',
        '${randomUUID()}','${ids.otherManager}',NULL,NULL,'IN_PERSON','${evidence}');`),
      ).toEqual({ ok: false, code: "HRA01" });
      expect(
        run(`SELECT public.designate_academic_operations_manager('${randomUUID()}','${ids.approver}','${ids.approver}',
        '${randomUUID()}','${ids.approver}',NULL,NULL,'IN_PERSON','${evidence}');`),
      ).toEqual({ ok: false, code: "HRA01" });
      expect(
        run(`SELECT public.designate_academic_operations_manager('${randomUUID()}','${ids.approver}','${ids.approver}',
        '${randomUUID()}','${ids.pending}',NULL,NULL,'IN_PERSON','${evidence}');`),
      ).toEqual({ ok: false, code: "HRA03" });
    });

    it("지정 종료 후 그 계정의 배정 요청은 거부되고 감사가 남습니다", () => {
      const cohort = newCohort();
      const designation =
        value(`SELECT (public.designate_academic_operations_manager('${randomUUID()}','${ids.approver}',
        '${ids.approver}','${randomUUID()}','${ids.otherManager}',NULL,NULL,'VERIFIED_CONTACT','${evidence}'))->'designation'->>'id';`);
      expect(
        assign(cohort, ids.assistantA, "ASSISTANT", { actor: ids.otherManager }),
      ).toMatchObject({ ok: true });
      value(`SELECT public.end_academic_operations_manager('${randomUUID()}','${ids.approver}','${ids.approver}',
        '${randomUUID()}','${designation}',NULL,'합성 종료 사유');`);
      expect(assign(cohort, ids.assistantB, "ASSISTANT", { actor: ids.otherManager })).toEqual({
        ok: false,
        code: "HRA01",
      });
      expect(
        value(`SELECT string_agg(action, ',' ORDER BY created_at, action) FROM academic_staff_events
        WHERE manager_designation_id='${designation}';`),
      ).toBe("MANAGER_DESIGNATE,MANAGER_END");
    });
  });

  describe("배정 인가", () => {
    it("지정되지 않은 ADMIN·FACULTY 계정은 배정할 수 없습니다", () => {
      const cohort = newCohort();
      expect(assign(cohort, ids.advisor, "ADVISOR", { actor: ids.admin })).toEqual({
        ok: false,
        code: "HRA01",
      });
      expect(assign(cohort, ids.advisor, "ADVISOR", { actor: ids.faculty })).toEqual({
        ok: false,
        code: "HRA01",
      });
      expect(assign(cohort, ids.advisor, "ADVISOR", { actor: ids.approver })).toEqual({
        ok: false,
        code: "HRA01",
      });
    });

    it("관리자의 자기 배정, 승인 대기 계정 배정, 소급 시작을 거부합니다", () => {
      const cohort = newCohort();
      expect(assign(cohort, ids.manager, "ADVISOR")).toEqual({ ok: false, code: "HRA01" });
      expect(assign(cohort, ids.pending, "ASSISTANT")).toEqual({ ok: false, code: "HRA03" });
      expect(assign(cohort, ids.advisor, "ADVISOR", { from: "-1 hour" })).toEqual({
        ok: false,
        code: "HRA07",
      });
      expect(assign(randomUUID(), ids.advisor, "ADVISOR")).toEqual({ ok: false, code: "HRA03" });
    });
  });

  describe("동시 유효 상한과 기간 중복", () => {
    it("어드바이저 1명·조교 2명을 넘는 겹친 배정과 같은 계정의 중복 배정을 거부합니다", () => {
      const cohort = newCohort();
      expect(assign(cohort, ids.advisor, "ADVISOR")).toMatchObject({ ok: true });
      expect(assign(cohort, ids.advisorB, "ADVISOR", { from: "1 day" })).toEqual({
        ok: false,
        code: "23P01",
      });
      expect(assign(cohort, ids.assistantA, "ASSISTANT", { to: "1 day" })).toMatchObject({
        ok: true,
      });
      expect(assign(cohort, ids.assistantB, "ASSISTANT")).toMatchObject({ ok: true });
      expect(assign(cohort, ids.assistantC, "ASSISTANT")).toEqual({ ok: false, code: "23P01" });
      // 조교 A의 계획 종료 이후에는 동시 유효 조교가 1명이므로 새 조교를 둘 수 있습니다.
      expect(assign(cohort, ids.assistantC, "ASSISTANT", { from: "2 days" })).toMatchObject({
        ok: true,
      });
      // 같은 계정은 역할이 달라도 같은 기수에서 기간이 겹칠 수 없습니다.
      expect(assign(cohort, ids.assistantB, "ADVISOR", { from: "3 days" })).toEqual({
        ok: false,
        code: "23P01",
      });
    });

    it("두 연결이 동시에 두 번째 어드바이저를 배정하면 하나만 성공합니다", async () => {
      const cohort = newCohort();
      const race = (user: string) =>
        runAsync(`BEGIN; ${assignSql(cohort, user, "ADVISOR")} SELECT pg_sleep(0.4); COMMIT;`);
      const results = await Promise.all([race(ids.advisor), race(ids.advisorB)]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, code: "23P01" }]);
      expect(
        value(
          `SELECT count(*) FROM academic_cohort_staff_assignments WHERE cohort_id='${cohort}';`,
        ),
      ).toBe("1");
    });

    it("세 연결이 동시에 조교를 배정하면 두 명만 성공합니다", async () => {
      const cohort = newCohort();
      const race = (user: string) =>
        runAsync(`BEGIN; ${assignSql(cohort, user, "ASSISTANT")} SELECT pg_sleep(0.3); COMMIT;`);
      const results = await Promise.all([
        race(ids.assistantA),
        race(ids.assistantB),
        race(ids.assistantC),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(2);
      expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, code: "23P01" }]);
    });
  });

  describe("출결 권한 판정", () => {
    it("유효 배정자만 자기 기수에서 참이며 다른 기수·미배정 ADMIN·FACULTY·관리자는 거부합니다", () => {
      const cohort = newCohort();
      const other = newCohort();
      assign(cohort, ids.advisor, "ADVISOR");
      assign(cohort, ids.assistantA, "ASSISTANT");
      assign(other, ids.assistantB, "ASSISTANT");
      expect(canRecord(ids.advisor, cohort)).toBe(true);
      expect(canRecord(ids.assistantA, cohort)).toBe(true);
      expect(canRecord(ids.assistantB, cohort)).toBe(false);
      expect(canRecord(ids.advisor, other)).toBe(false);
      for (const user of [ids.admin, ids.faculty, ids.manager, ids.approver, ids.pending])
        expect(canRecord(user, cohort)).toBe(false);
    });

    it("배정 종료 뒤와 계정이 승인 대기로 바뀐 뒤에는 권한이 없습니다", () => {
      const cohort = newCohort();
      const assignment = assign(cohort, ids.assistantC, "ASSISTANT");
      expect(assignment.ok).toBe(true);
      const id = assignment.ok ? assignment.out : "";
      expect(canRecord(ids.assistantC, cohort)).toBe(true);
      value(`UPDATE users SET role='PENDING' WHERE id='${ids.assistantC}';`);
      expect(canRecord(ids.assistantC, cohort)).toBe(false);
      value(`UPDATE users SET role='MEMBER' WHERE id='${ids.assistantC}';`);
      value(
        `SELECT public.end_academic_cohort_staff('${randomUUID()}','${ids.manager}','${randomUUID()}','${id}',NULL,'합성 해제');`,
      );
      expect(canRecord(ids.assistantC, cohort)).toBe(false);
    });

    it("학기 중 교체는 기존 행 종료 + 새 행 추가이며 교체 시각을 경계로 권한이 넘어갑니다", () => {
      const cohort = newCohort();
      const original = assign(cohort, ids.assistantA, "ASSISTANT", { to: "30 days" });
      const originalId = original.ok ? original.out : "";
      const replaced =
        value(`SELECT (public.replace_academic_cohort_staff('${randomUUID()}','${ids.manager}','${randomUUID()}',
        '${originalId}','${ids.assistantB}',now() + interval '1 hour','합성 교체','IN_PERSON','${evidence}'))->'assignment'->>'id';`);
      expect(canRecord(ids.assistantA, cohort, "30 minutes")).toBe(true);
      expect(canRecord(ids.assistantB, cohort, "30 minutes")).toBe(false);
      expect(canRecord(ids.assistantA, cohort, "2 hours")).toBe(false);
      expect(canRecord(ids.assistantB, cohort, "2 hours")).toBe(true);
      expect(canRecord(ids.assistantB, cohort, "31 days")).toBe(false);
      expect(
        value(`SELECT concat_ws('|', o.user_id = '${ids.assistantA}', o.valid_to = n.valid_from, o.ended_by_user_id = '${ids.manager}',
        n.replaces_assignment_id = o.id, n.staff_role, n.valid_to IS NOT NULL)
        FROM academic_cohort_staff_assignments o JOIN academic_cohort_staff_assignments n ON n.id='${replaced}'
        WHERE o.id='${originalId}';`),
      ).toBe("t|t|t|t|ASSISTANT|t");
      expect(
        value(`SELECT count(*) FROM academic_staff_events WHERE action='STAFF_REPLACE'
        AND assignment_id='${originalId}' AND replacement_assignment_id='${replaced}' AND actor_user_id='${ids.manager}';`),
      ).toBe("1");
    });
  });

  describe("불변성·감사·멱등성", () => {
    it("배정·감사 행은 종료 기록 외 수정·삭제·비우기가 거부됩니다", () => {
      const cohort = newCohort();
      const created = assign(cohort, ids.advisor, "ADVISOR");
      const id = created.ok ? created.out : "";
      expect(
        run(
          `UPDATE academic_cohort_staff_assignments SET user_id='${ids.advisorB}' WHERE id='${id}';`,
        ),
      ).toEqual({ ok: false, code: "HRA04" });
      expect(run(`DELETE FROM academic_cohort_staff_assignments WHERE id='${id}';`)).toEqual({
        ok: false,
        code: "HRA04",
      });
      expect(run("TRUNCATE academic_cohort_staff_assignments CASCADE;")).toEqual({
        ok: false,
        code: "HRA04",
      });
      expect(
        run(
          `UPDATE academic_staff_events SET correlation_id='${randomUUID()}' WHERE assignment_id='${id}';`,
        ),
      ).toEqual({ ok: false, code: "HRA04" });
      expect(run(`DELETE FROM academic_staff_events WHERE assignment_id='${id}';`)).toEqual({
        ok: false,
        code: "HRA04",
      });
      expect(
        run(`DELETE FROM academic_operations_managers WHERE id='${managerDesignation}';`),
      ).toEqual({ ok: false, code: "HRA04" });
      value(
        `SELECT public.end_academic_cohort_staff('${randomUUID()}','${ids.manager}','${randomUUID()}','${id}',NULL,'합성 해제');`,
      );
      expect(
        run(
          `SELECT public.end_academic_cohort_staff('${randomUUID()}','${ids.manager}','${randomUUID()}','${id}',NULL,'재종료');`,
        ),
      ).toEqual({ ok: false, code: "HRA04" });
      expect(
        value(`SELECT concat_ws('|', count(*), bool_and(actor_user_id='${ids.manager}'))
        FROM academic_staff_events WHERE assignment_id='${id}';`),
      ).toBe("2|t");
    });

    it("같은 요청 ID 재시도는 이전 결과를 돌려주고, 다른 입력에 재사용하면 거부합니다", () => {
      const cohort = newCohort();
      const request = randomUUID();
      const first = value(
        `${assignSql(cohort, ids.advisor, "ADVISOR", { request }).replace("->'assignment'->>'id'", "->>'replayed'")}`,
      );
      const second = value(
        `${assignSql(cohort, ids.advisor, "ADVISOR", { request }).replace("->'assignment'->>'id'", "->>'replayed'")}`,
      );
      expect([first, second]).toEqual(["false", "true"]);
      expect(assign(cohort, ids.advisorB, "ADVISOR", { request })).toEqual({
        ok: false,
        code: "HRA02",
      });
      expect(
        value(
          `SELECT count(*) FROM academic_cohort_staff_assignments WHERE cohort_id='${cohort}';`,
        ),
      ).toBe("1");
    });
  });

  describe("Application Service", () => {
    const principal = (key: keyof typeof ids, role = roles[key]) => ({ userId: ids[key], role });

    it("기능 플래그가 꺼져 있으면 DB에 접속하지 않고 판정은 false, 변경은 DISABLED입니다", async () => {
      vi.stubEnv("ACADEMIC_STAFF_ENABLED", "false");
      const cohort = newCohort();
      expect(await canRecordAttendance(principal("advisor"), cohort)).toBe(false);
      await expect(assignCohortStaff(principal("manager"), {})).rejects.toMatchObject({
        code: "DISABLED",
      });
      expect(mocks.calls).toBe(0);
    });

    it("관리자 배정·판정·종료가 서비스 경계를 통해 동작하고 DB 오류를 고정 코드로 바꿉니다", async () => {
      const cohort = newCohort();
      const result = await assignCohortStaff(principal("manager"), {
        requestId: randomUUID(),
        cohortId: cohort,
        userId: ids.advisor,
        staffRole: "ADVISOR",
        verificationMethod: "IN_PERSON",
        evidenceReference: evidence,
      });
      expect(result).toMatchObject({
        replayed: false,
        assignment: { cohortId: cohort, userId: ids.advisor, staffRole: "ADVISOR", validTo: null },
      });
      expect(result.assignment).not.toHaveProperty("evidenceReference");
      expect(await canRecordAttendance(principal("advisor"), cohort)).toBe(true);
      // 같은 계정이어도 주체가 승인 대기로 전달되면 DB 조회 없이 거부합니다.
      expect(await canRecordAttendance(principal("advisor", "PENDING"), cohort)).toBe(false);
      expect(await canRecordAttendance(principal("admin"), cohort)).toBe(false);
      expect(await canRecordAttendance(principal("faculty"), cohort)).toBe(false);
      await expect(
        assignCohortStaff(principal("manager"), {
          requestId: randomUUID(),
          cohortId: cohort,
          userId: ids.advisorB,
          staffRole: "ADVISOR",
          verificationMethod: "IN_PERSON",
          evidenceReference: evidence,
        }),
      ).rejects.toMatchObject({ code: "CAPACITY", status: 409 });
      await expect(
        assignCohortStaff(principal("admin"), {
          requestId: randomUUID(),
          cohortId: cohort,
          userId: ids.assistantA,
          staffRole: "ASSISTANT",
          verificationMethod: "IN_PERSON",
          evidenceReference: evidence,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
      await expect(
        assignCohortStaff(principal("manager"), { cohortId: cohort, staffRole: "TA" }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      const ended = await endCohortStaffAssignment(principal("manager"), {
        requestId: randomUUID(),
        assignmentId: result.assignment.id,
        reason: "합성 해제",
      });
      expect(ended.assignment.endedByUserId).toBe(ids.manager);
      expect(await canRecordAttendance(principal("advisor"), cohort)).toBe(false);
    });

    it("관리자 지정은 설정된 지정 승인자만 요청할 수 있으며 다른 주체는 DB 전에 거부합니다", async () => {
      await expect(
        designateOperationsManager(principal("admin"), {
          requestId: randomUUID(),
          userId: ids.faculty,
          verificationMethod: "IN_PERSON",
          evidenceReference: evidence,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      vi.stubEnv("ACADEMIC_APPROVER_USER_ID", "");
      await expect(
        designateOperationsManager(principal("approver"), {
          requestId: randomUUID(),
          userId: ids.faculty,
          verificationMethod: "IN_PERSON",
          evidenceReference: evidence,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(mocks.calls).toBe(0);
    });
  });
});
