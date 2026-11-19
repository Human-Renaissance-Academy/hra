// @vitest-environment node
/**
 * #159 학생별 출결 기록·정정 승인의 실제 PostgreSQL 회귀입니다.
 *
 * - 소유 임시 클러스터(HRA_TEST_PG_BIN)에 최소 users·cohorts·schedule_events 표와 G1 학적 SQL, #165 운영 인력 SQL,
 *   이번 출결 SQL만 설치합니다. 운영 DB·환경 파일은 읽지 않습니다.
 * - SQL 직접 호출로 입력 창(KST)·인가·버전 경합·정정·자기 승인·불변성·멱등성을,
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
  decideCorrection,
  listForCohortSession,
  listOwn,
  recordAttendance,
  requestCorrection,
} from "@/features/academics/attendance/service";

const bin = process.env.HRA_TEST_PG_BIN;
const execFileAsync = promisify(execFile);
const source = (name: string) =>
  readFileSync(new URL(`../../scripts/${name}`, import.meta.url), "utf8");
const migration = source("migrate-academic-attendance.sql");

// 합성 계정. 전역 역할은 판정 근거가 아니며 ADMIN·FACULTY도 배정 없이는 거부되어야 합니다.
const ids = {
  approver: "15900000-0000-4000-8000-000000000001",
  manager: "15900000-0000-4000-8000-000000000002",
  advisor: "15900000-0000-4000-8000-000000000003",
  assistantA: "15900000-0000-4000-8000-000000000004",
  assistantB: "15900000-0000-4000-8000-000000000005",
  otherStaff: "15900000-0000-4000-8000-000000000006",
  admin: "15900000-0000-4000-8000-000000000007",
  faculty: "15900000-0000-4000-8000-000000000008",
  pending: "15900000-0000-4000-8000-000000000009",
  student1: "15900000-0000-4000-8000-00000000000a",
  student2: "15900000-0000-4000-8000-00000000000b",
};
const roles: Record<string, string> = {
  approver: "MEMBER",
  manager: "MEMBER",
  advisor: "MEMBER",
  assistantA: "MEMBER",
  assistantB: "FACULTY",
  otherStaff: "MEMBER",
  admin: "ADMIN",
  faculty: "FACULTY",
  pending: "PENDING",
  student1: "MEMBER",
  student2: "MEMBER",
};
const students = {
  one: "15900000-0000-4000-8000-0000000000a1",
  two: "15900000-0000-4000-8000-0000000000a2",
};
const evidence = "15900000-0000-4000-8000-0000000000ee";

type Outcome = { ok: true; out: string } | { ok: false; code: string };

describe.skipIf(!bin)("#159 학생별 출결과 정정 승인(격리 PostgreSQL)", () => {
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

  /** 기수 하나에 어드바이저 1명·조교 2명을 배정하고 학생 두 명을 수업 전부터 등록합니다. */
  const newCohort = () => {
    const cohort = randomUUID();
    const enrollments = { one: randomUUID(), two: randomUUID() };
    const assignments: Record<string, string> = {};
    value(`INSERT INTO cohorts(id,name) VALUES('${cohort}','합성 기수');
      INSERT INTO cohort_enrollments(id,student_id,cohort_id,enrolled_at) VALUES
        ('${enrollments.one}','${students.one}','${cohort}',now() - interval '60 days'),
        ('${enrollments.two}','${students.two}','${cohort}',now() - interval '60 days');`);
    for (const [user, role] of [
      ["advisor", "ADVISOR"],
      ["assistantA", "ASSISTANT"],
      ["assistantB", "ASSISTANT"],
    ] as const)
      assignments[user] =
        value(`SELECT (public.assign_academic_cohort_staff('${randomUUID()}','${ids.manager}',
        '${randomUUID()}','${cohort}','${ids[user]}','${role}',NULL,NULL,'IN_PERSON','${evidence}'))->'assignment'->>'id';`);
    return { cohort, enrollments, assignments };
  };
  /** KST 기준 오늘에서 dayOffset일 떨어진 날 KST 10:00 수업(UTC 저장)을 만듭니다. */
  const classOn = (cohort: string, dayOffset: number, type = "CLASS") => {
    const id = randomUUID();
    value(`INSERT INTO schedule_events(id,event_date,event_type,cohort_id,title) VALUES ('${id}',
      ((((now() AT TIME ZONE 'Asia/Seoul')::date + ${dayOffset}) + time '10:00') AT TIME ZONE 'Asia/Seoul') AT TIME ZONE 'UTC',
      '${type}','${cohort}','합성 수업');`);
    return id;
  };
  const recordSql = (
    actor: string,
    event: string,
    enrollment: string,
    status: string,
    expected: number,
    request = randomUUID(),
  ) => `SELECT (public.record_academic_attendance('${request}','${ids[actor as keyof typeof ids] ?? actor}',
    '${randomUUID()}','${event}','${enrollment}','${status}',${expected}))->'record'->>'version';`;
  const record = (...args: Parameters<typeof recordSql>) => run(recordSql(...args));
  const requestSql = (
    actor: keyof typeof ids,
    event: string,
    enrollment: string,
    status: string,
    expected: number,
    method: string | null = null,
  ) => `SELECT (public.request_academic_attendance_correction('${randomUUID()}','${ids[actor]}','${randomUUID()}',
    '${event}','${enrollment}','${status}',${expected},'합성 정정 사유',${method ? `'${method}'` : "NULL"}))->'correction'->>'id';`;
  const decide = (actor: keyof typeof ids, correction: string, decision = "APPROVE") =>
    run(`SELECT (public.decide_academic_attendance_correction('${randomUUID()}','${ids[actor]}','${randomUUID()}',
      '${correction}','${decision}'))->'correction'->>'status';`);
  const cell = (event: string, enrollment: string) =>
    value(`SELECT coalesce(string_agg(concat_ws('|', status, version, recorded_by_user_id), ','), 'UNMARKED')
      FROM academic_attendance_records WHERE schedule_event_id='${event}' AND enrollment_id='${enrollment}';`);

  beforeAll(() => {
    cluster = createQaPostgres(bin);
    cluster.sql(`CREATE TABLE users(id uuid PRIMARY KEY, role text NOT NULL);
      CREATE TABLE cohorts(id uuid PRIMARY KEY, name text NOT NULL);
      CREATE TABLE schedule_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_date timestamp NOT NULL,
        event_type text NOT NULL, cohort_id uuid REFERENCES cohorts(id) ON DELETE SET NULL, title text NOT NULL);
      INSERT INTO users VALUES ${Object.entries(ids)
        .map(([key, id]) => `('${id}','${roles[key]}')`)
        .join(",")};`);
    cluster.sql(source("migrate-academic-students.sql"));
    cluster.sql(source("migrate-academic-staff-assignments.sql"));
    // 같은 DB에 두 번 적용해도 성공해야 합니다(재실행 멱등성).
    cluster.sql(migration);
    cluster.sql(migration);
    cluster.sql(`INSERT INTO academic_students(id,user_id,display_name) VALUES
      ('${students.one}','${ids.student1}','합성 학생 1'),('${students.two}','${ids.student2}','합성 학생 2');
      SELECT public.designate_academic_operations_manager('${randomUUID()}','${ids.approver}','${ids.approver}',
        '${randomUUID()}','${ids.manager}',NULL,NULL,'IN_PERSON','${evidence}');`);

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
    vi.stubEnv("ACADEMIC_ATTENDANCE_ENABLED", "true");
  });

  afterAll(() => {
    mocks.database = undefined;
    neonConfig.fetchFunction = previousFetch;
    neonConfig.fetchEndpoint = previousEndpoint;
    vi.unstubAllEnvs();
    cluster?.close();
  });

  describe("SQL 설치 형태", () => {
    it("다른 구조의 같은 이름 표·추가 트리거가 있으면 전체를 롤백하고, 원래 구조로 돌아오면 다시 통과합니다", () => {
      value("ALTER TABLE academic_attendance_events ADD COLUMN extra integer;");
      expect(run(migration)).toMatchObject({ ok: false });
      value("ALTER TABLE academic_attendance_events DROP COLUMN extra;");
      value(
        "ALTER TABLE academic_attendance_corrections DROP CONSTRAINT academic_attendance_corrections_self_approval_check;",
      );
      expect(run(migration)).toMatchObject({ ok: false });
      value(
        "ALTER TABLE academic_attendance_corrections ADD CONSTRAINT academic_attendance_corrections_self_approval_check CHECK (decided_by_user_id IS NULL OR decided_by_user_id <> requested_by_user_id);",
      );
      value(
        "CREATE TRIGGER extra_probe BEFORE UPDATE ON academic_attendance_records FOR EACH ROW EXECUTE FUNCTION guard_academic_attendance_events();",
      );
      expect(run(migration)).toMatchObject({ ok: false });
      value("DROP TRIGGER extra_probe ON academic_attendance_records;");
      expect(run(migration)).toMatchObject({ ok: true });
    });

    it("PUBLIC에는 출결 함수 실행 권한이 없습니다", () => {
      value(
        "DO $$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='attendance_probe') THEN CREATE ROLE attendance_probe NOLOGIN; END IF; END$$;",
      );
      expect(
        value(`SELECT count(*) || '|' || bool_or(has_function_privilege('attendance_probe', p.oid, 'EXECUTE'))
        FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.proname LIKE '%academic_attendance%');`),
      ).toBe("14|false");
    });
  });

  describe("7일 입력 창(KST)", () => {
    it("수업일은 UTC 저장값을 KST 날짜로 해석하고, 창은 수업일 00:00부터 +7일 24:00 미만입니다", () => {
      // UTC 3/6 15:30은 KST 3/7 00:30이므로 수업일은 3/7입니다.
      expect(value("SELECT academic_attendance_class_date('2026-03-06 15:30:00');")).toBe(
        "2026-03-07",
      );
      expect(value("SELECT academic_attendance_class_date('2026-03-06 14:59:59');")).toBe(
        "2026-03-06",
      );
      const inside = (instant: string) =>
        value(`SELECT '${instant}'::timestamptz <@ academic_attendance_window('2026-03-07');`);
      expect(inside("2026-03-06T14:59:59.999999Z")).toBe("f");
      expect(inside("2026-03-07T00:00:00+09:00")).toBe("t");
      expect(inside("2026-03-14T23:59:59.999999+09:00")).toBe("t");
      expect(inside("2026-03-15T00:00:00+09:00")).toBe("f");
    });

    it("수업 7일 뒤까지는 직접 입력, 8일째부터는 정정 필요, 수업일 전에는 입력 불가입니다", () => {
      const { cohort, enrollments } = newCohort();
      expect(record("advisor", classOn(cohort, -7), enrollments.one, "PRESENT", 0)).toEqual({
        ok: true,
        out: "1",
      });
      expect(record("advisor", classOn(cohort, -8), enrollments.one, "PRESENT", 0)).toEqual({
        ok: false,
        code: "HRA08",
      });
      expect(record("advisor", classOn(cohort, 1), enrollments.one, "PRESENT", 0)).toEqual({
        ok: false,
        code: "HRA05",
      });
    });
  });

  describe("입력 인가와 셀 검증", () => {
    it("배정된 어드바이저·조교만 입력하고 ADMIN·FACULTY·관리자·다른 기수 배정자·승인 대기는 거부합니다", () => {
      const { cohort, enrollments } = newCohort();
      // 다른 기수에만 배정된 운영 인력입니다.
      const other = randomUUID();
      value(`INSERT INTO cohorts(id,name) VALUES('${other}','다른 합성 기수');
        SELECT public.assign_academic_cohort_staff('${randomUUID()}','${ids.manager}','${randomUUID()}',
        '${other}','${ids.otherStaff}','ASSISTANT',NULL,NULL,'IN_PERSON','${evidence}');`);
      const event = classOn(cohort, 0);
      for (const actor of [
        "admin",
        "faculty",
        "manager",
        "approver",
        "pending",
        "otherStaff",
        "student1",
      ])
        expect(record(actor, event, enrollments.one, "PRESENT", 0)).toEqual({
          ok: false,
          code: "HRA01",
        });
      expect(cell(event, enrollments.one)).toBe("UNMARKED");
      expect(record("assistantB", event, enrollments.one, "LATE", 0)).toEqual({
        ok: true,
        out: "1",
      });
      expect(record("advisor", event, enrollments.one, "PRESENT", 1)).toEqual({
        ok: true,
        out: "2",
      });
      expect(cell(event, enrollments.one)).toBe(`PRESENT|2|${ids.advisor}`);
      // 다른 학생 셀은 여전히 미입력이며 결석으로 간주하지 않습니다.
      expect(cell(event, enrollments.two)).toBe("UNMARKED");
    });

    it("CLASS가 아닌 일정, 다른 기수 학적, 수업 뒤 등록한 학적, 인정결석 직접 입력을 거부합니다", () => {
      const { cohort, enrollments } = newCohort();
      const other = newCohort();
      expect(record("advisor", classOn(cohort, 0, "EVENT"), enrollments.one, "PRESENT", 0)).toEqual(
        {
          ok: false,
          code: "HRA03",
        },
      );
      expect(record("advisor", classOn(cohort, 0), other.enrollments.one, "PRESENT", 0)).toEqual({
        ok: false,
        code: "HRA03",
      });
      const late = randomUUID();
      const lateStudent = randomUUID();
      value(`INSERT INTO academic_students(id,display_name) VALUES ('${lateStudent}','합성 늦은 등록');
        INSERT INTO cohort_enrollments(id,student_id,cohort_id,enrolled_at) VALUES ('${late}','${lateStudent}','${cohort}',now());`);
      expect(record("advisor", classOn(cohort, -2), late, "PRESENT", 0)).toEqual({
        ok: false,
        code: "HRA03",
      });
      expect(record("advisor", classOn(cohort, 0), enrollments.one, "EXCUSED", 0)).toEqual({
        ok: false,
        code: "HRA08",
      });
    });

    it("배정이 종료되면 즉시 입력할 수 없고, 과거 기록의 입력자와 당시 배정은 남습니다", () => {
      const { cohort, enrollments, assignments } = newCohort();
      const event = classOn(cohort, 0);
      expect(record("assistantA", event, enrollments.one, "ABSENT", 0)).toMatchObject({ ok: true });
      value(`SELECT public.end_academic_cohort_staff('${randomUUID()}','${ids.manager}','${randomUUID()}',
        '${assignments.assistantA}',NULL,'합성 해제');`);
      expect(record("assistantA", event, enrollments.one, "PRESENT", 1)).toEqual({
        ok: false,
        code: "HRA01",
      });
      expect(
        value(`SELECT concat_ws('|', r.recorded_by_user_id='${ids.assistantA}', r.recorded_by_assignment_id='${assignments.assistantA}',
          e.actor_assignment_id='${assignments.assistantA}', e.previous_status IS NULL, e.next_status)
          FROM academic_attendance_records r JOIN academic_attendance_events e ON e.record_id=r.id
          WHERE r.schedule_event_id='${event}' AND r.enrollment_id='${enrollments.one}';`),
      ).toBe("t|t|t|t|ABSENT");
      // 수업·학적이 출결에 참조되면 기존 일정·학적 삭제가 과거 기록을 지우지 못합니다.
      expect(run(`DELETE FROM schedule_events WHERE id='${event}';`)).toEqual({
        ok: false,
        code: "23503",
      });
    });
  });

  describe("동시 입력", () => {
    it("두 운영 인력이 같은 미입력 셀에 동시에 입력하면 하나만 반영되고 다른 쪽은 버전 충돌입니다", async () => {
      const { cohort, enrollments } = newCohort();
      const event = classOn(cohort, 0);
      const race = (actor: string, status: string) =>
        runAsync(
          `BEGIN; ${recordSql(actor, event, enrollments.one, status, 0)} SELECT pg_sleep(0.4); COMMIT;`,
        );
      const results = await Promise.all([race("advisor", "PRESENT"), race("assistantA", "LATE")]);
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toEqual([{ ok: false, code: "HRA06" }]);
      expect(
        value(`SELECT count(*) || '|' || max(version) FROM academic_attendance_records r
          JOIN academic_attendance_events e ON e.record_id=r.id WHERE r.schedule_event_id='${event}';`),
      ).toBe("1|1");
    });
  });

  describe("정정 요청과 승인", () => {
    it("창이 지난 셀은 요청 → 다른 배정자 승인으로만 바뀌며 자기 승인·ADMIN 승인은 거부합니다", () => {
      const { cohort, enrollments } = newCohort();
      const event = classOn(cohort, -10);
      const correction = value(requestSql("advisor", event, enrollments.one, "LATE", 0));
      // 승인 전에는 현재 값(미입력)이 그대로입니다.
      expect(cell(event, enrollments.one)).toBe("UNMARKED");
      expect(run(requestSql("assistantA", event, enrollments.one, "ABSENT", 0))).toEqual({
        ok: false,
        code: "HRA04",
      });
      expect(decide("advisor", correction)).toEqual({ ok: false, code: "HRA01" });
      expect(decide("admin", correction)).toEqual({ ok: false, code: "HRA01" });
      expect(decide("faculty", correction)).toEqual({ ok: false, code: "HRA01" });
      expect(decide("assistantA", correction)).toEqual({ ok: true, out: "APPROVED" });
      expect(cell(event, enrollments.one)).toBe(`LATE|1|${ids.advisor}`);
      expect(decide("assistantB", correction)).toEqual({ ok: false, code: "HRA04" });
      expect(
        value(`SELECT string_agg(concat_ws(':', action, actor_user_id=requested_by), ',' ORDER BY ev.created_at, action)
          FROM academic_attendance_events ev, LATERAL (SELECT '${ids.advisor}'::uuid AS requested_by) r
          WHERE ev.correction_id='${correction}';`),
      ).toBe("CORRECTION_REQUEST:t,CORRECTION_APPROVE:f");
    });

    it("창 안의 일반 변경은 정정이 아니라 직접 입력이며, 관리자는 일반 정정도 승인할 수 있습니다", () => {
      const { cohort, enrollments } = newCohort();
      const open = classOn(cohort, 0);
      expect(run(requestSql("advisor", open, enrollments.one, "PRESENT", 0))).toEqual({
        ok: false,
        code: "HRA07",
      });
      const closed = classOn(cohort, -9);
      const correction = value(requestSql("assistantA", closed, enrollments.two, "ABSENT", 0));
      expect(decide("manager", correction)).toEqual({ ok: true, out: "APPROVED" });
      expect(cell(closed, enrollments.two)).toBe(`ABSENT|1|${ids.assistantA}`);
    });

    it("인정결석 지정·해제는 학사 운영 관리자만 승인하고, 지정된 값은 직접 바꿀 수 없습니다", () => {
      const { cohort, enrollments } = newCohort();
      const event = classOn(cohort, 0);
      expect(record("advisor", event, enrollments.one, "ABSENT", 0)).toMatchObject({ ok: true });
      expect(run(requestSql("advisor", event, enrollments.one, "EXCUSED", 1))).toEqual({
        ok: false,
        code: "HRA07",
      });
      const excuse = value(
        requestSql("advisor", event, enrollments.one, "EXCUSED", 1, "DOCUMENT_SIGHTED"),
      );
      // 대기 중 정정이 있는 셀은 직접 입력도 막습니다.
      expect(record("assistantA", event, enrollments.one, "PRESENT", 1)).toEqual({
        ok: false,
        code: "HRA04",
      });
      expect(decide("assistantA", excuse)).toEqual({ ok: false, code: "HRA01" });
      expect(decide("manager", excuse)).toEqual({ ok: true, out: "APPROVED" });
      expect(cell(event, enrollments.one)).toBe(`EXCUSED|2|${ids.advisor}`);
      expect(record("assistantA", event, enrollments.one, "PRESENT", 2)).toEqual({
        ok: false,
        code: "HRA08",
      });
      // 해제 요청도 조교는 승인할 수 없고, 관리자 반려는 현재 값을 바꾸지 않습니다.
      const lift = value(requestSql("assistantA", event, enrollments.one, "PRESENT", 2));
      expect(decide("advisor", lift)).toEqual({ ok: false, code: "HRA01" });
      expect(decide("manager", lift, "REJECT")).toEqual({ ok: true, out: "REJECTED" });
      expect(cell(event, enrollments.one)).toBe(`EXCUSED|2|${ids.advisor}`);
    });

    it("요청 당시 버전이 아니면 요청을 거부합니다", () => {
      const { cohort, enrollments } = newCohort();
      const event = classOn(cohort, 0);
      record("advisor", event, enrollments.one, "ABSENT", 0);
      expect(
        run(requestSql("advisor", event, enrollments.one, "EXCUSED", 0, "VERIFIED_CONTACT")),
      ).toEqual({ ok: false, code: "HRA06" });
    });
  });

  describe("불변성·멱등성", () => {
    it("출결·정정·이력 표는 함수 밖에서 바꾸거나 지울 수 없고 표 제약도 자기 승인을 막습니다", () => {
      const { cohort, enrollments } = newCohort();
      const event = classOn(cohort, -10);
      const correction = value(requestSql("advisor", event, enrollments.one, "LATE", 0));
      decide("assistantA", correction);
      expect(
        run(
          `UPDATE academic_attendance_records SET status='ABSENT', version=version+1 WHERE schedule_event_id='${event}';`,
        ),
      ).toEqual({ ok: false, code: "HRA04" });
      expect(
        run(`DELETE FROM academic_attendance_records WHERE schedule_event_id='${event}';`),
      ).toEqual({
        ok: false,
        code: "HRA04",
      });
      expect(run("TRUNCATE academic_attendance_events CASCADE;")).toEqual({
        ok: false,
        code: "HRA04",
      });
      expect(
        run(
          `UPDATE academic_attendance_events SET correlation_id='${randomUUID()}' WHERE correction_id='${correction}';`,
        ),
      ).toEqual({ ok: false, code: "HRA04" });
      expect(
        run(`INSERT INTO academic_attendance_events(request_id,action,actor_user_id,schedule_event_id,enrollment_id,
          previous_version,next_version,correlation_id,payload_digest) VALUES ('${randomUUID()}','CORRECTION_REJECT',
          '${ids.admin}','${event}','${enrollments.one}',0,0,'${randomUUID()}','${"0".repeat(64)}');`),
      ).toEqual({ ok: false, code: "HRA04" });
      const pending = value(requestSql("advisor", event, enrollments.two, "LATE", 0));
      expect(
        run(`BEGIN; SET LOCAL hra.academic_attendance_write='on'; UPDATE academic_attendance_corrections SET status='APPROVED',
          decided_by_user_id='${ids.advisor}', decided_by_manager_designation_id=(SELECT id FROM academic_operations_managers LIMIT 1),
          decided_at=now() WHERE id='${pending}'; COMMIT;`),
      ).toEqual({ ok: false, code: "23514" });
    });

    it("같은 요청 ID 재시도는 이전 결과를 돌려주고, 다른 입력에 재사용하면 거부합니다", () => {
      const { cohort, enrollments } = newCohort();
      const event = classOn(cohort, 0);
      const request = randomUUID();
      const replayed = (sql: string) => sql.replace("->'record'->>'version'", "->>'replayed'");
      expect(
        value(replayed(recordSql("advisor", event, enrollments.one, "PRESENT", 0, request))),
      ).toBe("false");
      expect(
        value(replayed(recordSql("advisor", event, enrollments.one, "PRESENT", 0, request))),
      ).toBe("true");
      expect(record("advisor", event, enrollments.one, "LATE", 0, request)).toEqual({
        ok: false,
        code: "HRA02",
      });
      expect(cell(event, enrollments.one)).toBe(`PRESENT|1|${ids.advisor}`);
    });
  });

  describe("Application Service", () => {
    const principal = (key: keyof typeof ids, role = roles[key]) => ({ userId: ids[key], role });

    it("기능 플래그가 꺼져 있으면 DB에 접속하지 않고 DISABLED입니다", async () => {
      vi.stubEnv("ACADEMIC_ATTENDANCE_ENABLED", "false");
      await expect(recordAttendance(principal("advisor"), {})).rejects.toMatchObject({
        code: "DISABLED",
      });
      await expect(listOwn(principal("student1"))).rejects.toMatchObject({ code: "DISABLED" });
      vi.stubEnv("ACADEMIC_ATTENDANCE_ENABLED", "true");
      vi.stubEnv("ACADEMIC_STAFF_ENABLED", "false");
      await expect(listForCohortSession(principal("advisor"), randomUUID())).rejects.toMatchObject({
        code: "DISABLED",
      });
      await expect(listOwn(principal("student1", "PENDING"))).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(listOwn(undefined)).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
      expect(mocks.calls).toBe(0);
    });

    it("입력·정정·결정·출결표가 서비스 경계를 통해 동작하고 DB 오류를 고정 코드로 바꿉니다", async () => {
      const { cohort, enrollments } = newCohort();
      const event = classOn(cohort, 0);
      const recorded = await recordAttendance(principal("advisor"), {
        requestId: randomUUID(),
        scheduleEventId: event,
        enrollmentId: enrollments.one,
        status: "ABSENT",
        expectedVersion: 0,
      });
      expect(recorded).toMatchObject({
        changed: true,
        replayed: false,
        record: { status: "ABSENT", version: 1, recordedByUserId: ids.advisor },
      });
      expect(recorded.record).not.toHaveProperty("recordedByAssignmentId");
      await expect(
        recordAttendance(principal("assistantA"), {
          requestId: randomUUID(),
          scheduleEventId: event,
          enrollmentId: enrollments.one,
          status: "PRESENT",
          expectedVersion: 0,
        }),
      ).rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409 });
      await expect(
        recordAttendance(principal("admin"), {
          requestId: randomUUID(),
          scheduleEventId: event,
          enrollmentId: enrollments.one,
          status: "PRESENT",
          expectedVersion: 1,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
      await expect(
        requestCorrection(principal("advisor"), {
          requestId: randomUUID(),
          scheduleEventId: event,
          enrollmentId: enrollments.one,
          requestedStatus: "EXCUSED",
          expectedVersion: 1,
          reason: "합성 사유",
        }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      const requested = await requestCorrection(principal("advisor"), {
        requestId: randomUUID(),
        scheduleEventId: event,
        enrollmentId: enrollments.one,
        requestedStatus: "EXCUSED",
        expectedVersion: 1,
        reason: "합성 사유",
        excuseVerificationMethod: "DOCUMENT_SIGHTED",
      });
      expect(requested.correction).toMatchObject({ status: "PENDING", previousStatus: "ABSENT" });
      await expect(
        decideCorrection(principal("advisor"), {
          requestId: randomUUID(),
          correctionId: requested.correction.id,
          decision: "APPROVE",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      const decided = await decideCorrection(principal("manager"), {
        requestId: randomUUID(),
        correctionId: requested.correction.id,
        decision: "APPROVE",
      });
      expect(decided).toMatchObject({
        correction: { status: "APPROVED", decidedByUserId: ids.manager },
        record: { status: "EXCUSED", version: 2 },
      });
      const sheet = await listForCohortSession(principal("assistantB"), event);
      expect(sheet.entries.map((entry) => [entry.enrollmentId, entry.status])).toEqual(
        expect.arrayContaining([
          [enrollments.one, "EXCUSED"],
          [enrollments.two, "UNMARKED"],
        ]),
      );
      await expect(listForCohortSession(principal("faculty"), event)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(listForCohortSession(principal("manager"), event)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    });

    it("학생은 본인 학적의 시작된 수업 출결만 보며 미입력은 UNMARKED입니다", async () => {
      const { cohort, enrollments } = newCohort();
      const today = classOn(cohort, 0);
      const past = classOn(cohort, -3);
      classOn(cohort, 5);
      record("advisor", today, enrollments.one, "LATE", 0);
      record("advisor", today, enrollments.two, "ABSENT", 0);
      const own = (await listOwn(principal("student1"))).filter(
        (entry) => entry.cohortId === cohort,
      );
      expect(own.map((entry) => [entry.scheduleEventId, entry.status])).toEqual([
        [past, "UNMARKED"],
        [today, "LATE"],
      ]);
      expect(own.every((entry) => entry.enrollmentId === enrollments.one)).toBe(true);
      // 학생 계정이 아닌 운영 인력·관리자는 본인 학적이 없으므로 빈 목록입니다.
      expect(await listOwn(principal("advisor"))).toEqual([]);
      expect(await listOwn(principal("admin"))).toEqual([]);
    });
  });
});
