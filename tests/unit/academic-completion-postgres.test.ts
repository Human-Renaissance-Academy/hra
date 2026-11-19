// @vitest-environment node
/**
 * #163 수료 기준 버전과 수료 확정·취소 이력의 실제 PostgreSQL 회귀입니다.
 *
 * - 소유 임시 클러스터(HRA_TEST_PG_BIN)에 최소 users·cohorts·schedule_events·schedule_sessions 표와 G1 학적·과제·제출 SQL,
 *   #165 운영 인력 SQL, #159 출결 SQL, 이번 수료 SQL만 설치합니다. 운영 DB·환경 파일은 읽지 않습니다.
 * - SQL 직접 호출로 기준 공개 후 불변·관리자 전용·자기 결정 금지·이력 대체·동시 확정·보조 지표를,
 *   Drizzle·Neon SDK 경로로 서비스 플래그·오류 변환·학생 본인 조회를 확인합니다.
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
  createCriteriaDraft,
  getCompletionRoster,
  listCompletionCohorts,
  listOwnCompletion,
  publishCriteria,
  recordCompletionDecision,
  updateCriteriaDraft,
} from "@/features/academics/completion/service";

const bin = process.env.HRA_TEST_PG_BIN;
const execFileAsync = promisify(execFile);
const source = (name: string) =>
  readFileSync(new URL(`../../scripts/${name}`, import.meta.url), "utf8");
const migration = source("migrate-academic-completion.sql");

// 합성 계정. 전역 역할은 판정 근거가 아니며 ADMIN·FACULTY도 관리자 지정 없이는 거부되어야 합니다.
const ids = {
  approver: "16300000-0000-4000-8000-000000000001",
  manager: "16300000-0000-4000-8000-000000000002",
  managerStudent: "16300000-0000-4000-8000-000000000003",
  advisor: "16300000-0000-4000-8000-000000000004",
  admin: "16300000-0000-4000-8000-000000000005",
  faculty: "16300000-0000-4000-8000-000000000006",
  pending: "16300000-0000-4000-8000-000000000007",
  student1: "16300000-0000-4000-8000-000000000008",
  student2: "16300000-0000-4000-8000-000000000009",
};
const roles: Record<keyof typeof ids, string> = {
  approver: "MEMBER",
  manager: "FACULTY",
  managerStudent: "MEMBER",
  advisor: "MEMBER",
  admin: "ADMIN",
  faculty: "FACULTY",
  pending: "PENDING",
  student1: "MEMBER",
  student2: "MEMBER",
};
const students = {
  one: "16300000-0000-4000-8000-0000000000a1",
  two: "16300000-0000-4000-8000-0000000000a2",
  manager: "16300000-0000-4000-8000-0000000000a3",
};
const evidence = "16300000-0000-4000-8000-0000000000ee";
const criteria = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    minAttendancePercent: 80,
    countLateAsAttended: true,
    countExcusedAsAttended: true,
    requiredSubmissionCount: 1,
    ...overrides,
  });

type Outcome = { ok: true; out: string } | { ok: false; code: string };

describe.skipIf(!bin)("#163 수료 기준 버전과 수료 확정 이력(격리 PostgreSQL)", () => {
  let cluster: ReturnType<typeof createQaPostgres>;
  const previousFetch = neonConfig.fetchFunction;
  const previousEndpoint = neonConfig.fetchEndpoint;

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

  /** 기수 하나에 어드바이저를 배정하고 학생 1·2와 관리자 겸 학생을 60일 전부터 등록합니다. */
  const newCohort = () => {
    const cohort = randomUUID();
    const enrollments = { one: randomUUID(), two: randomUUID(), manager: randomUUID() };
    value(`INSERT INTO cohorts(id,name) VALUES('${cohort}','합성 기수 ${cohort.slice(0, 8)}');
      INSERT INTO cohort_enrollments(id,student_id,cohort_id,enrolled_at) VALUES
        ('${enrollments.one}','${students.one}','${cohort}',now() - interval '60 days'),
        ('${enrollments.two}','${students.two}','${cohort}',now() - interval '60 days'),
        ('${enrollments.manager}','${students.manager}','${cohort}',now() - interval '60 days');
      SELECT public.assign_academic_cohort_staff('${randomUUID()}','${ids.manager}','${randomUUID()}','${cohort}',
        '${ids.advisor}','ADVISOR',NULL,NULL,'IN_PERSON','${evidence}');`);
    return { cohort, enrollments };
  };
  const createSql = (
    actor: keyof typeof ids,
    cohort: string,
    body = criteria(),
    reason = "합성 기준",
  ) =>
    `SELECT (public.create_academic_completion_criteria('${randomUUID()}','${ids[actor]}','${randomUUID()}',
      '${cohort}','${body}'::jsonb,'${reason}'))->'criteria'->>'id';`;
  const publishSql = (actor: keyof typeof ids, version: string) =>
    `SELECT (public.publish_academic_completion_criteria('${randomUUID()}','${ids[actor]}','${randomUUID()}',
      '${version}'))->'criteria'->>'status';`;
  /** 관리자가 기준을 만들고 바로 공개합니다. */
  const published = (cohort: string, body = criteria()) => {
    const version = value(createSql("manager", cohort, body));
    value(publishSql("manager", version));
    return version;
  };
  const decideSql = (
    actor: keyof typeof ids,
    enrollment: string,
    version: string,
    decision: string,
    expected: number,
    request = randomUUID(),
  ) => `SELECT (public.record_academic_completion_decision('${request}','${ids[actor]}','${randomUUID()}',
    '${enrollment}','${version}','${decision}','합성 결정 사유',${expected}))->'decision'->>'decision_sequence';`;
  const decide = (...args: Parameters<typeof decideSql>) => run(decideSql(...args));
  /** KST 기준 오늘에서 dayOffset일 떨어진 날의 CLASS 수업을 한국 벽시계 값 그대로 만듭니다. */
  const classOn = (cohort: string, dayOffset: number) => {
    const id = randomUUID();
    value(`INSERT INTO schedule_events(id,event_date,event_type,cohort_id,title) VALUES ('${id}',
      ((now() AT TIME ZONE 'Asia/Seoul')::date + ${dayOffset}) + time '10:00','CLASS','${cohort}','합성 수업');`);
    return id;
  };
  const attend = (event: string, enrollment: string, status: string) =>
    value(`SELECT public.record_academic_attendance('${randomUUID()}','${ids.advisor}','${randomUUID()}',
      '${event}','${enrollment}','${status}',0);`);
  /** 과제를 공개해 대상 스냅샷을 만들고, 필요하면 학생 1이 PDF 최종 제출까지 마칩니다. */
  const assignment = (cohort: string, enrollment: string, submit: boolean) => {
    const id = randomUUID();
    value(`INSERT INTO assignments(id,cohort_id,title,due_at,created_by_user_id)
        VALUES('${id}','${cohort}','합성 과제',clock_timestamp()+interval '1 hour','${ids.manager}');
      SELECT publish_academic_assignment('${id}','${ids.manager}');`);
    if (!submit) return;
    const target = value(
      `SELECT id FROM assignment_targets WHERE assignment_id='${id}' AND enrollment_id='${enrollment}';`,
    );
    const intent = randomUUID();
    value(`INSERT INTO assignment_upload_intents(id,assignment_target_id,user_id,storage_key,expires_at)
        VALUES('${intent}','${target}','${ids.student1}','assignments/${intent}/document.pdf',clock_timestamp()+interval '30 minutes');
      SELECT verify_academic_assignment_upload('${intent}','${ids.student1}','과제.pdf','application/pdf',2048,'${"a".repeat(64)}');
      SELECT finalize_academic_assignment_submission('${target}','${ids.student1}','${intent}','${randomUUID()}');`);
  };

  beforeAll(() => {
    cluster = createQaPostgres(bin);
    cluster.sql(`CREATE TABLE users(id uuid PRIMARY KEY, role text NOT NULL);
      CREATE TABLE cohorts(id uuid PRIMARY KEY, name text NOT NULL);
      CREATE TABLE schedule_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_date timestamp NOT NULL,
        event_type text NOT NULL, cohort_id uuid REFERENCES cohorts(id) ON DELETE SET NULL, title text NOT NULL);
      CREATE TABLE schedule_sessions(id uuid PRIMARY KEY, schedule_event_id uuid REFERENCES schedule_events(id));
      INSERT INTO users VALUES ${Object.entries(ids)
        .map(([key, id]) => `('${id}','${roles[key as keyof typeof ids]}')`)
        .join(",")};`);
    cluster.sql(source("migrate-academic-students.sql"));
    cluster.sql(source("migrate-academic-assignments.sql"));
    cluster.sql(source("migrate-academic-submissions.sql"));
    cluster.sql(source("migrate-academic-staff-assignments.sql"));
    cluster.sql(source("migrate-academic-attendance.sql"));
    // 같은 DB에 두 번 적용해도 성공해야 합니다(재실행 멱등성).
    cluster.sql(migration);
    cluster.sql(migration);
    cluster.sql(`INSERT INTO academic_students(id,user_id,display_name) VALUES
      ('${students.one}','${ids.student1}','합성 학생 1'),('${students.two}','${ids.student2}','합성 학생 2'),
      ('${students.manager}','${ids.managerStudent}','합성 관리자 겸 학생');
      SELECT public.designate_academic_operations_manager('${randomUUID()}','${ids.approver}','${ids.approver}',
        '${randomUUID()}','${ids.manager}',NULL,NULL,'IN_PERSON','${evidence}');
      SELECT public.designate_academic_operations_manager('${randomUUID()}','${ids.approver}','${ids.approver}',
        '${randomUUID()}','${ids.managerStudent}',NULL,NULL,'IN_PERSON','${evidence}');`);

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
  }, 90_000);

  beforeEach(() => {
    mocks.calls = 0;
    vi.unstubAllEnvs();
    vi.stubEnv("ACADEMIC_ENABLED", "true");
    vi.stubEnv("ACADEMIC_STAFF_ENABLED", "true");
    vi.stubEnv("ACADEMIC_COMPLETION_ENABLED", "true");
  });

  afterAll(() => {
    mocks.database = undefined;
    neonConfig.fetchFunction = previousFetch;
    neonConfig.fetchEndpoint = previousEndpoint;
    vi.unstubAllEnvs();
    cluster?.close();
  });

  describe("SQL 설치 형태", () => {
    it("다른 구조의 같은 이름 표·CHECK·추가 트리거가 있으면 전체를 롤백하고, 원래 구조로 돌아오면 다시 통과합니다", () => {
      value("ALTER TABLE completion_events ADD COLUMN extra integer;");
      expect(run(migration)).toMatchObject({ ok: false });
      value("ALTER TABLE completion_events DROP COLUMN extra;");
      value("ALTER TABLE completion_decisions DROP CONSTRAINT completion_decisions_revoke_check;");
      expect(run(migration)).toMatchObject({ ok: false });
      value(
        "ALTER TABLE completion_decisions ADD CONSTRAINT completion_decisions_revoke_check CHECK (decision <> 'REVOKED' OR decision_sequence > 1);",
      );
      value(
        "CREATE TRIGGER extra_probe BEFORE UPDATE ON completion_decisions FOR EACH ROW EXECUTE FUNCTION guard_completion_events();",
      );
      expect(run(migration)).toMatchObject({ ok: false });
      value("DROP TRIGGER extra_probe ON completion_decisions;");
      expect(run(migration)).toMatchObject({ ok: true });
    });

    it("PUBLIC에는 수료 함수 실행 권한이 없고, 소유자 외 EXECUTE가 남아 있으면 전체를 롤백합니다", () => {
      value(
        "DO $$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='completion_probe') THEN CREATE ROLE completion_probe NOLOGIN; END IF; END$$;",
      );
      expect(
        value(`SELECT count(*) || '|' || bool_or(has_function_privilege('completion_probe', p.oid, 'EXECUTE'))
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
          AND (p.proname LIKE '%completion%');`),
      ).toBe("12|false");
      value(
        "GRANT EXECUTE ON FUNCTION public.compute_completion_snapshot(uuid, uuid) TO completion_probe;",
      );
      expect(run(migration)).toMatchObject({ ok: false });
      value(
        "REVOKE EXECUTE ON FUNCTION public.compute_completion_snapshot(uuid, uuid) FROM completion_probe;",
      );
      expect(run(migration)).toMatchObject({ ok: true });
      // 같은 이름의 다른 인자 다중 정의(우회 경로)가 남아 있어도 전체를 롤백합니다.
      value(`CREATE FUNCTION public.compute_completion_snapshot(uuid) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
        REVOKE ALL ON FUNCTION public.compute_completion_snapshot(uuid) FROM PUBLIC;`);
      expect(run(migration)).toMatchObject({ ok: false });
      value("DROP FUNCTION public.compute_completion_snapshot(uuid);");
      expect(run(migration)).toMatchObject({ ok: true });
    });
  });

  describe("수료 기준 버전(P13)", () => {
    it("초안만 고칠 수 있고 공개 후에는 함수·직접 쓰기 모두 불변이며 변경은 새 버전입니다", () => {
      const { cohort } = newCohort();
      // 형식이 틀린 기준·사유는 입력 오류입니다.
      expect(run(createSql("manager", cohort, criteria({ minAttendancePercent: 101 })))).toEqual({
        ok: false,
        code: "HRA07",
      });
      expect(run(createSql("manager", cohort, criteria({ extra: 1 })))).toEqual({
        ok: false,
        code: "HRA07",
      });
      expect(run(createSql("manager", cohort, criteria({ minAttendancePercent: 80.5 })))).toEqual({
        ok: false,
        code: "HRA07",
      });
      expect(run(createSql("manager", cohort, criteria(), " "))).toEqual({
        ok: false,
        code: "HRA07",
      });
      const first = value(createSql("manager", cohort));
      // 기수당 초안은 하나입니다.
      expect(run(createSql("manager", cohort))).toEqual({ ok: false, code: "HRA04" });
      expect(
        value(`SELECT (public.update_academic_completion_criteria('${randomUUID()}','${ids.manager}','${randomUUID()}',
          '${first}','${criteria({ minAttendancePercent: 70 })}'::jsonb,'수정 사유'))->'criteria'->'criteria'->>'minAttendancePercent';`),
      ).toBe("70");
      expect(value(publishSql("manager", first))).toBe("PUBLISHED");
      expect(run(publishSql("manager", first))).toEqual({ ok: false, code: "HRA04" });
      expect(
        run(`SELECT public.update_academic_completion_criteria('${randomUUID()}','${ids.manager}','${randomUUID()}',
          '${first}','${criteria({ minAttendancePercent: 10 })}'::jsonb,'소급 변경');`),
      ).toEqual({ ok: false, code: "HRA04" });
      // 함수 표지를 켠 직접 UPDATE·DELETE도 공개된 기준을 바꾸지 못합니다.
      expect(
        run(`BEGIN; SET LOCAL hra.academic_completion_write='on';
          UPDATE completion_criteria_versions SET criteria='${criteria({ minAttendancePercent: 10 })}' WHERE id='${first}'; COMMIT;`),
      ).toEqual({ ok: false, code: "HRA04" });
      expect(run(`DELETE FROM completion_criteria_versions WHERE id='${first}';`)).toEqual({
        ok: false,
        code: "HRA04",
      });
      expect(
        run(`UPDATE completion_criteria_versions SET change_reason='x' WHERE id='${first}';`),
      ).toEqual({
        ok: false,
        code: "HRA04",
      });
      const second = value(createSql("manager", cohort, criteria({ minAttendancePercent: 90 })));
      expect(value(`SELECT version FROM completion_criteria_versions WHERE id='${second}';`)).toBe(
        "2",
      );
      expect(
        value(
          `SELECT criteria->>'minAttendancePercent' || '|' || status FROM completion_criteria_versions WHERE id='${first}';`,
        ),
      ).toBe("70|PUBLISHED");
      expect(
        value(
          `SELECT string_agg(action, ',' ORDER BY created_at) FROM completion_events WHERE criteria_version_id IN ('${first}','${second}');`,
        ),
      ).toBe("CRITERIA_CREATE,CRITERIA_UPDATE,CRITERIA_PUBLISH,CRITERIA_CREATE");
    });

    it("학사 운영 관리자 지정이 없는 ADMIN·FACULTY·지정 승인자·운영 인력·학생·PENDING은 기준·결정·명부 모두 거부됩니다", () => {
      const { cohort, enrollments } = newCohort();
      const version = published(cohort);
      for (const actor of [
        "admin",
        "faculty",
        "approver",
        "advisor",
        "student1",
        "pending",
      ] as const) {
        expect(run(createSql(actor, randomUUID()))).toEqual({ ok: false, code: "HRA01" });
        expect(run(publishSql(actor, version))).toEqual({ ok: false, code: "HRA01" });
        expect(decide(actor, enrollments.one, version, "COMPLETED", 0)).toEqual({
          ok: false,
          code: "HRA01",
        });
        expect(
          run(`SELECT public.list_academic_completion_roster('${ids[actor]}','${cohort}',NULL);`),
        ).toEqual({ ok: false, code: "HRA01" });
        expect(run(`SELECT public.list_academic_completion_cohorts('${ids[actor]}');`)).toEqual({
          ok: false,
          code: "HRA01",
        });
      }
      expect(
        value(
          `SELECT count(*) FROM completion_decisions WHERE enrollment_id='${enrollments.one}';`,
        ),
      ).toBe("0");
    });
  });

  describe("수료 결정(P14)", () => {
    it("관리자 본인 학적은 결정할 수 없고 다른 관리자는 결정할 수 있습니다", () => {
      const { cohort, enrollments } = newCohort();
      const version = published(cohort);
      expect(decide("managerStudent", enrollments.manager, version, "COMPLETED", 0)).toEqual({
        ok: false,
        code: "HRA01",
      });
      expect(decide("manager", enrollments.manager, version, "COMPLETED", 0)).toEqual({
        ok: true,
        out: "1",
      });
      // 관리자 겸 학생도 다른 학생의 결정은 할 수 있습니다.
      expect(decide("managerStudent", enrollments.one, version, "NOT_COMPLETED", 0)).toEqual({
        ok: true,
        out: "1",
      });
    });

    it("결정은 추가만 되고 새 결정이 이전 결정을 대체하며, 취소는 수료 상태에서만 가능하고 결정한 기준 버전을 유지합니다", () => {
      const { cohort, enrollments } = newCohort();
      const v1 = published(cohort);
      const draft = value(createSql("manager", cohort, criteria({ minAttendancePercent: 90 })));
      expect(decide("manager", enrollments.one, draft, "COMPLETED", 0)).toEqual({
        ok: false,
        code: "HRA04",
      });
      const other = newCohort();
      const foreign = published(other.cohort);
      expect(decide("manager", enrollments.one, foreign, "COMPLETED", 0)).toEqual({
        ok: false,
        code: "HRA03",
      });
      expect(decide("manager", enrollments.one, v1, "REVOKED", 0)).toEqual({
        ok: false,
        code: "HRA04",
      });
      expect(decide("manager", enrollments.one, v1, "NOT_COMPLETED", 0)).toEqual({
        ok: true,
        out: "1",
      });
      // 오래된 순번으로는 상충하는 결정을 기록할 수 없습니다.
      expect(decide("manager", enrollments.one, v1, "COMPLETED", 0)).toEqual({
        ok: false,
        code: "HRA06",
      });
      expect(decide("manager", enrollments.one, v1, "REVOKED", 1)).toEqual({
        ok: false,
        code: "HRA04",
      });
      expect(decide("manager", enrollments.one, v1, "COMPLETED", 1)).toEqual({
        ok: true,
        out: "2",
      });
      // 기준이 새 버전으로 바뀌어도 이미 확정된 결정은 당시 버전을 유지합니다.
      value(publishSql("manager", draft));
      expect(decide("managerStudent", enrollments.one, draft, "REVOKED", 2)).toEqual({
        ok: true,
        out: "3",
      });
      expect(
        value(`SELECT string_agg(concat_ws('|', d.decision_sequence, d.decision, v.version, d.decided_by_user_id,
            d.supersedes_decision_id IS NOT NULL), ',' ORDER BY d.decision_sequence)
          FROM completion_decisions d JOIN completion_criteria_versions v ON v.id=d.criteria_version_id
          WHERE d.enrollment_id='${enrollments.one}';`),
      ).toBe(
        `1|NOT_COMPLETED|1|${ids.manager}|f,2|COMPLETED|1|${ids.manager}|t,3|REVOKED|2|${ids.managerStudent}|t`,
      );
      // 함수 밖 수정·삭제와 감사 기록 변경은 거부합니다.
      expect(
        run(`BEGIN; SET LOCAL hra.academic_completion_write='on';
          UPDATE completion_decisions SET decision='COMPLETED' WHERE enrollment_id='${enrollments.one}'; COMMIT;`),
      ).toEqual({ ok: false, code: "HRA04" });
      expect(
        run(`DELETE FROM completion_decisions WHERE enrollment_id='${enrollments.one}';`),
      ).toEqual({
        ok: false,
        code: "HRA04",
      });
      expect(run(`DELETE FROM completion_events;`)).toEqual({ ok: false, code: "HRA04" });
      expect(run(`TRUNCATE completion_decisions CASCADE;`)).toEqual({ ok: false, code: "HRA04" });
      // 참조된 학적·기수·기준은 삭제할 수 없습니다.
      expect(run(`DELETE FROM cohort_enrollments WHERE id='${enrollments.one}';`)).toMatchObject({
        ok: false,
      });
      expect(run(`DELETE FROM cohorts WHERE id='${cohort}';`)).toMatchObject({ ok: false });
    });

    it("같은 학적에 동시에 확정하면 하나만 반영되고 같은 요청 ID 재시도는 같은 결과를 돌려줍니다", async () => {
      const { cohort, enrollments } = newCohort();
      const version = published(cohort);
      const results = await Promise.all([
        runAsync(decideSql("manager", enrollments.two, version, "COMPLETED", 0)),
        runAsync(decideSql("managerStudent", enrollments.two, version, "NOT_COMPLETED", 0)),
      ]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, code: "HRA06" }]);
      expect(
        value(
          `SELECT count(*) FROM completion_decisions WHERE enrollment_id='${enrollments.two}';`,
        ),
      ).toBe("1");
      const request = randomUUID();
      expect(decide("manager", enrollments.two, version, "COMPLETED", 1, request)).toEqual({
        ok: true,
        out: "2",
      });
      expect(decide("manager", enrollments.two, version, "COMPLETED", 1, request)).toEqual({
        ok: true,
        out: "2",
      });
      expect(decide("manager", enrollments.two, version, "NOT_COMPLETED", 1, request)).toEqual({
        ok: false,
        code: "HRA02",
      });
    });
  });

  describe("보조 지표(compute_completion_snapshot)", () => {
    it("시작된 수업만 세고 미입력은 결석이 아니며, 기준 버전의 지각·인정결석 포함 규칙과 과제 제출 수를 반영합니다", () => {
      const { cohort, enrollments } = newCohort();
      const days = [-4, -3, -2, -1, 0].map((offset) => classOn(cohort, offset));
      classOn(cohort, 3);
      attend(days[0], enrollments.one, "PRESENT");
      attend(days[1], enrollments.one, "LATE");
      attend(days[2], enrollments.one, "ABSENT");
      attend(days[3], enrollments.one, "PRESENT");
      // 인정결석은 정정 요청과 학사 운영 관리자 승인으로만 지정됩니다.
      const correction =
        value(`SELECT (public.request_academic_attendance_correction('${randomUUID()}','${ids.advisor}',
        '${randomUUID()}','${days[2]}','${enrollments.one}','EXCUSED',1,'합성 사유','DOCUMENT_SIGHTED'))->'correction'->>'id';`);
      value(`SELECT public.decide_academic_attendance_correction('${randomUUID()}','${ids.manager}','${randomUUID()}',
        '${correction}','APPROVE');`);
      assignment(cohort, enrollments.one, true);
      assignment(cohort, enrollments.one, false);
      const lenient = published(cohort);
      const strict = value(
        createSql(
          "manager",
          cohort,
          criteria({
            countLateAsAttended: false,
            countExcusedAsAttended: false,
            requiredSubmissionCount: 2,
          }),
        ),
      );
      const snapshot = (version: string) =>
        JSON.parse(
          value(`SELECT public.compute_completion_snapshot('${enrollments.one}','${version}');`),
        );
      expect(snapshot(lenient)).toMatchObject({
        criteriaVersion: 1,
        attendance: {
          classCount: 5,
          presentCount: 2,
          lateCount: 1,
          absentCount: 0,
          excusedCount: 1,
          unmarkedCount: 1,
          attendedCount: 4,
          attendancePercent: 80,
          minAttendancePercent: 80,
          met: null,
        },
        submissions: { assignedCount: 2, submittedCount: 1, requiredCount: 1, met: true },
      });
      attend(days[4], enrollments.one, "ABSENT");
      expect(snapshot(lenient).attendance).toMatchObject({
        unmarkedCount: 0,
        attendancePercent: 80,
        met: true,
      });
      expect(snapshot(strict)).toMatchObject({
        criteriaVersion: 2,
        attendance: { attendedCount: 2, attendancePercent: 40, met: false },
        submissions: { submittedCount: 1, requiredCount: 2, met: false },
      });
      // 다른 기수의 기준으로는 계산하지 않습니다.
      expect(
        run(
          `SELECT public.compute_completion_snapshot('${enrollments.one}','${published(newCohort().cohort)}');`,
        ),
      ).toEqual({ ok: false, code: "HRA03" });
      // 결정에는 확정 당시 지표가 고정되고, 결정 값은 지표와 무관하게 관리자가 정합니다.
      expect(decide("manager", enrollments.one, lenient, "NOT_COMPLETED", 0)).toEqual({
        ok: true,
        out: "1",
      });
      expect(
        value(`SELECT concat_ws('|', snapshot->'attendance'->>'attendedCount', snapshot->'submissions'->>'submittedCount')
          FROM completion_decisions WHERE enrollment_id='${enrollments.one}';`),
      ).toBe("4|1");
    });
  });

  describe("Application Service", () => {
    const principal = (key: keyof typeof ids, role = roles[key]) => ({ userId: ids[key], role });

    it("기능 플래그가 꺼져 있으면 DB에 접속하지 않고 DISABLED이며, 주체 오류는 DB 전에 거부합니다", async () => {
      vi.stubEnv("ACADEMIC_COMPLETION_ENABLED", "false");
      await expect(listOwnCompletion(principal("student1"))).rejects.toMatchObject({
        code: "DISABLED",
      });
      await expect(createCriteriaDraft(principal("manager"), {})).rejects.toMatchObject({
        code: "DISABLED",
      });
      vi.stubEnv("ACADEMIC_COMPLETION_ENABLED", "true");
      vi.stubEnv("ACADEMIC_STAFF_ENABLED", "false");
      await expect(listCompletionCohorts(principal("manager"))).rejects.toMatchObject({
        code: "DISABLED",
      });
      vi.stubEnv("ACADEMIC_STAFF_ENABLED", "true");
      vi.stubEnv("ACADEMIC_ENABLED", "false");
      await expect(
        getCompletionRoster(principal("manager"), { cohortId: randomUUID() }),
      ).rejects.toMatchObject({ code: "DISABLED" });
      vi.stubEnv("ACADEMIC_ENABLED", "true");
      await expect(listOwnCompletion(principal("student1", "PENDING"))).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(listOwnCompletion(undefined)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
      await expect(
        createCriteriaDraft(principal("manager"), { requestId: randomUUID(), cohortId: "x" }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      expect(mocks.calls).toBe(0);
    });

    it("기준 작성·수정·공개·명부·결정이 서비스 경계를 통해 동작하고 DB 오류를 고정 코드로 바꿉니다", async () => {
      const { cohort, enrollments } = newCohort();
      const body = {
        minAttendancePercent: 75,
        countLateAsAttended: true,
        countExcusedAsAttended: false,
        requiredSubmissionCount: 0,
        notes: "합성 비고",
      };
      await expect(
        createCriteriaDraft(principal("admin"), {
          requestId: randomUUID(),
          cohortId: cohort,
          criteria: body,
          reason: "합성",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
      const created = await createCriteriaDraft(principal("manager"), {
        requestId: randomUUID(),
        cohortId: cohort,
        criteria: body,
        reason: "첫 기준",
      });
      expect(created.criteria).toMatchObject({ version: 1, status: "DRAFT", criteria: body });
      expect(created.criteria).not.toHaveProperty("createdByManagerDesignationId");
      await updateCriteriaDraft(principal("manager"), {
        requestId: randomUUID(),
        criteriaVersionId: created.criteria.id,
        criteria: { ...body, minAttendancePercent: 70 },
        reason: "수정",
      });
      const publishedResult = await publishCriteria(principal("manager"), {
        requestId: randomUUID(),
        criteriaVersionId: created.criteria.id,
      });
      expect(publishedResult.criteria).toMatchObject({
        status: "PUBLISHED",
        criteria: { minAttendancePercent: 70 },
      });
      await expect(
        updateCriteriaDraft(principal("manager"), {
          requestId: randomUUID(),
          criteriaVersionId: created.criteria.id,
          criteria: body,
          reason: "소급",
        }),
      ).rejects.toMatchObject({ code: "CONFLICT", status: 409 });

      const cohorts = await listCompletionCohorts(principal("manager"));
      expect(cohorts.map((entry) => entry.id)).toContain(cohort);
      await expect(listCompletionCohorts(principal("faculty"))).rejects.toMatchObject({
        code: "FORBIDDEN",
      });

      const roster = await getCompletionRoster(principal("manager"), { cohortId: cohort });
      expect(roster.selectedCriteriaVersionId).toBe(created.criteria.id);
      const entry = roster.entries.find((row) => row.enrollmentId === enrollments.two);
      expect(entry).toMatchObject({ status: "PENDING", currentSequence: 0, history: [] });
      expect(entry?.snapshot?.attendance).toMatchObject({
        classCount: 0,
        attendancePercent: null,
        // 시작된 수업이 없으면 출석률 충족 여부는 판단 보류입니다.
        met: null,
      });

      const decided = await recordCompletionDecision(principal("manager"), {
        requestId: randomUUID(),
        enrollmentId: enrollments.two,
        criteriaVersionId: created.criteria.id,
        decision: "COMPLETED",
        reason: "기준 충족 확인",
        expectedSequence: 0,
      });
      expect(decided.decision).toMatchObject({
        sequence: 1,
        decision: "COMPLETED",
        decidedByUserId: ids.manager,
      });
      await expect(
        recordCompletionDecision(principal("manager"), {
          requestId: randomUUID(),
          enrollmentId: enrollments.two,
          criteriaVersionId: created.criteria.id,
          decision: "NOT_COMPLETED",
          reason: "오래된 화면",
          expectedSequence: 0,
        }),
      ).rejects.toMatchObject({ code: "VERSION_CONFLICT" });
      await expect(
        recordCompletionDecision(principal("managerStudent"), {
          requestId: randomUUID(),
          enrollmentId: enrollments.manager,
          criteriaVersionId: created.criteria.id,
          decision: "COMPLETED",
          reason: "자기 결정",
          expectedSequence: 0,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      const after = await getCompletionRoster(principal("manager"), {
        cohortId: cohort,
        criteriaVersionId: created.criteria.id,
      });
      expect(after.entries.find((row) => row.enrollmentId === enrollments.two)).toMatchObject({
        status: "COMPLETED",
        currentSequence: 1,
        history: [
          { sequence: 1, decision: "COMPLETED", reason: "기준 충족 확인", criteriaVersion: 1 },
        ],
      });
      await expect(
        getCompletionRoster(principal("manager"), {
          cohortId: cohort,
          criteriaVersionId: randomUUID(),
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });

    it("학생은 본인 학적의 현재 수료 상태만 보며 사유·결정자·지표는 받지 않습니다", async () => {
      const { cohort, enrollments } = newCohort();
      const version = published(cohort);
      value(decideSql("manager", enrollments.one, version, "COMPLETED", 0));
      value(decideSql("manager", enrollments.two, version, "NOT_COMPLETED", 0));
      const own = (await listOwnCompletion(principal("student1"))).filter(
        (entry) => entry.cohortId === cohort,
      );
      expect(own).toEqual([
        expect.objectContaining({
          enrollmentId: enrollments.one,
          status: "COMPLETED",
          criteriaVersion: 1,
        }),
      ]);
      expect(Object.keys(own[0]).sort()).toEqual(
        [
          "cohortId",
          "cohortName",
          "criteriaVersion",
          "decidedAt",
          "decision",
          "enrollmentId",
          "status",
        ].sort(),
      );
      const other = (await listOwnCompletion(principal("student2"))).filter(
        (entry) => entry.cohortId === cohort,
      );
      expect(other.map((entry) => [entry.enrollmentId, entry.status])).toEqual([
        [enrollments.two, "NOT_COMPLETED"],
      ]);
      // 관리자 겸 학생의 결정 전 학적은 심사 전입니다. 학생 학적이 없는 계정은 빈 목록입니다.
      expect(
        (await listOwnCompletion(principal("managerStudent"))).find(
          (entry) => entry.cohortId === cohort,
        ),
      ).toMatchObject({ status: "PENDING", decision: null });
      expect(await listOwnCompletion(principal("admin"))).toEqual([]);
    });
  });
});
