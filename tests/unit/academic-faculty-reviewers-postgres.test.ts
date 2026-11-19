// @vitest-environment node
/**
 * #161 교수 계정 연결·수업별 과제 검토자 지정·과제 검토 권한 판정의 실제 PostgreSQL 회귀입니다.
 *
 * - 소유 임시 클러스터(HRA_TEST_PG_BIN)에 최소 users·cohorts·faculty·일정·과제 표와 #165·#161 검토 SQL만 설치합니다.
 *   운영 DB·환경 파일은 읽지 않습니다.
 * - SQL 직접 호출로 인가·중복 금지·동시성·불변성·감사·멱등성을, Drizzle·Neon SDK 경로로 서비스 플래그·판정을 확인합니다.
 * - 교수 검토 권한이 출결 권한(#165 can_record_academic_attendance)을 만들지 않는다는 것도 함께 확인합니다.
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
  canReviewAssignment,
  designateReviewer,
  endDesignation,
  linkFacultyAccount,
  listReviewableAssignments,
  unlinkFacultyAccount,
} from "@/features/academics/faculty-review/service";

const bin = process.env.HRA_TEST_PG_BIN;
const execFileAsync = promisify(execFile);
const staffMigration = readFileSync(
  new URL("../../scripts/migrate-academic-staff-assignments.sql", import.meta.url),
  "utf8",
);
const migration = readFileSync(
  new URL("../../scripts/migrate-academic-faculty-reviewers.sql", import.meta.url),
  "utf8",
);

// 합성 계정. 전역 역할은 판정 근거가 아니며 ADMIN·FACULTY도 연결·지정 없이는 거부되어야 합니다.
const ids = {
  approver: "16100000-0000-4000-8000-000000000001",
  manager: "16100000-0000-4000-8000-000000000002",
  otherManager: "16100000-0000-4000-8000-000000000003",
  admin: "16100000-0000-4000-8000-000000000004",
  faculty: "16100000-0000-4000-8000-000000000005",
  member: "16100000-0000-4000-8000-000000000006",
  pending: "16100000-0000-4000-8000-000000000007",
};
const roles: Record<keyof typeof ids, string> = {
  approver: "MEMBER",
  manager: "MEMBER",
  otherManager: "MEMBER",
  admin: "ADMIN",
  faculty: "FACULTY",
  member: "MEMBER",
  pending: "PENDING",
};
const evidence = "16100000-0000-4000-8000-0000000000ee";

type Outcome = { ok: true; out: string } | { ok: false; code: string };

describe.skipIf(!bin)("#161 교수 계정 연결과 과제 검토 권한(격리 PostgreSQL)", () => {
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
  // 동시 연결 경합용 비동기 실행입니다.
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

  // 합성 fixture 생성기. 테스트마다 새 교수·수업·과제를 만들어 서로 간섭하지 않게 합니다.
  const newUser = (role: string) => {
    const id = randomUUID();
    value(`INSERT INTO users VALUES('${id}','${role}');`);
    return id;
  };
  const newFaculty = () => {
    const id = randomUUID();
    value(`INSERT INTO faculty(id,name) VALUES('${id}','합성 교수');`);
    return id;
  };
  let cohort: string;
  /** 수업 일정 하나와 세션 두 개를 만듭니다. 세션의 담당 교수(faculty_id)는 선택적으로 채웁니다. */
  const newClass = (sessionFaculty: string | null = null) => {
    const event = randomUUID();
    const first = randomUUID();
    const second = randomUUID();
    value(`INSERT INTO schedule_events(id,cohort_id) VALUES('${event}','${cohort}');
      INSERT INTO schedule_sessions(id,schedule_event_id,faculty_id) VALUES
        ('${first}','${event}',${sessionFaculty ? `'${sessionFaculty}'` : "NULL"}),
        ('${second}','${event}',${sessionFaculty ? `'${sessionFaculty}'` : "NULL"});`);
    return { event, first, second };
  };
  const newAssignment = (
    event: string | null,
    session: string | null,
    status: "DRAFT" | "PUBLISHED" | "CLOSED" = "PUBLISHED",
  ) => {
    const id = randomUUID();
    value(`INSERT INTO assignments(id,cohort_id,schedule_event_id,schedule_session_id,title,status,due_at)
      VALUES('${id}','${cohort}',${event ? `'${event}'` : "NULL"},${session ? `'${session}'` : "NULL"},
      '합성 과제','${status}',now() + interval '7 days');`);
    return id;
  };
  const linkSql = (
    faculty: string,
    user: string,
    options: { actor?: string; request?: string; from?: string } = {},
  ) => `SELECT (public.link_academic_faculty_account('${options.request ?? randomUUID()}',
    '${options.actor ?? ids.manager}','${randomUUID()}','${faculty}','${user}',
    ${options.from ? `now() + interval '${options.from}'` : "NULL"},NULL,'IN_PERSON','${evidence}'))->'link'->>'id';`;
  const link = (faculty: string, user: string, options?: Parameters<typeof linkSql>[2]) =>
    run(linkSql(faculty, user, options));
  const designateSql = (
    faculty: string,
    event: string,
    session: string | null,
    options: { actor?: string; request?: string; from?: string } = {},
  ) => `SELECT (public.designate_academic_class_reviewer('${options.request ?? randomUUID()}',
    '${options.actor ?? ids.manager}','${randomUUID()}','${faculty}','${event}',
    ${session ? `'${session}'` : "NULL"},${options.from ? `now() + interval '${options.from}'` : "NULL"},NULL))
    ->'designation'->>'id';`;
  const designate = (
    faculty: string,
    event: string,
    session: string | null,
    options?: Parameters<typeof designateSql>[3],
  ) => run(designateSql(faculty, event, session, options));
  const canReview = (user: string, assignment: string) =>
    value(`SELECT public.can_review_assignment('${user}','${assignment}');`) === "t";
  const created = (outcome: Outcome) => {
    if (!outcome.ok) throw new Error(`준비 실패 ${outcome.code}`);
    return outcome.out;
  };

  beforeAll(() => {
    cluster = createQaPostgres(bin);
    cohort = randomUUID();
    // 실제 스키마의 최소 부분만 만듭니다. 과제 상태는 G1 enum 대신 text로 두며 판정 함수는 텍스트로 비교합니다.
    cluster.sql(`CREATE TABLE users(id uuid PRIMARY KEY, role text NOT NULL);
      CREATE TABLE cohorts(id uuid PRIMARY KEY, name text NOT NULL);
      CREATE TABLE faculty(id uuid PRIMARY KEY, name text NOT NULL);
      CREATE TABLE schedule_events(id uuid PRIMARY KEY, cohort_id uuid REFERENCES cohorts(id));
      CREATE TABLE schedule_sessions(id uuid PRIMARY KEY,
        schedule_event_id uuid NOT NULL REFERENCES schedule_events(id) ON DELETE CASCADE,
        faculty_id uuid REFERENCES faculty(id) ON DELETE SET NULL);
      CREATE TABLE assignments(id uuid PRIMARY KEY, cohort_id uuid NOT NULL REFERENCES cohorts(id),
        schedule_event_id uuid REFERENCES schedule_events(id), schedule_session_id uuid REFERENCES schedule_sessions(id),
        title varchar(200) NOT NULL, status text NOT NULL, due_at timestamptz);
      INSERT INTO cohorts VALUES ('${cohort}','합성 기수');
      INSERT INTO users VALUES ${Object.entries(ids)
        .map(([key, id]) => `('${id}','${roles[key as keyof typeof ids]}')`)
        .join(",")};`);
    cluster.sql(staffMigration);
    // 같은 DB에 두 번 적용해도 성공해야 합니다(재실행 멱등성).
    cluster.sql(migration);
    cluster.sql(migration);
    for (const manager of [ids.manager, ids.otherManager])
      created(
        run(`SELECT (public.designate_academic_operations_manager('${randomUUID()}','${ids.approver}',
        '${ids.approver}','${randomUUID()}','${manager}',NULL,NULL,'IN_PERSON','${evidence}'))->'designation'->>'id';`),
      );

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
    vi.stubEnv("ACADEMIC_FACULTY_REVIEW_ENABLED", "true");
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
      value("ALTER TABLE academic_faculty_review_events ADD COLUMN extra integer;");
      expect(run(migration)).toMatchObject({ ok: false });
      value("ALTER TABLE academic_faculty_review_events DROP COLUMN extra;");
      value(
        "ALTER TABLE academic_faculty_account_links DROP CONSTRAINT academic_faculty_account_links_self_check;",
      );
      expect(run(migration)).toMatchObject({ ok: false });
      value(
        "ALTER TABLE academic_faculty_account_links ADD CONSTRAINT academic_faculty_account_links_self_check CHECK (verified_by_user_id <> user_id);",
      );
      // 활성 연결 유일성을 대신하려는 임의 인덱스도 같은 구조로 보지 않습니다.
      value("CREATE INDEX probe_extra_idx ON academic_class_reviewer_designations (faculty_id);");
      expect(run(migration)).toMatchObject({ ok: false });
      value("DROP INDEX probe_extra_idx;");
      expect(run(migration)).toMatchObject({ ok: true });
    });

    it("숨긴 트리거·꺼진 보호 트리거·남은 EXECUTE 권한·판정 함수 다중 정의를 거부합니다", () => {
      value(`CREATE TRIGGER faculty_probe_hidden BEFORE INSERT ON academic_faculty_review_events
        FOR EACH ROW EXECUTE FUNCTION public.guard_academic_faculty_review_events();
        ALTER TABLE academic_faculty_review_events DISABLE TRIGGER faculty_probe_hidden;`);
      expect(run(migration)).toMatchObject({ ok: false });
      value("DROP TRIGGER faculty_probe_hidden ON academic_faculty_review_events;");
      value(
        "ALTER TABLE academic_faculty_account_links DISABLE TRIGGER academic_faculty_account_links_guard;",
      );
      // 재적용은 트리거를 다시 만들어 켜므로 통과하고, 그 결과 보호 트리거가 다시 활성화됩니다.
      expect(run(migration)).toMatchObject({ ok: true });
      expect(
        value(
          "SELECT tgenabled FROM pg_trigger WHERE tgname='academic_faculty_account_links_guard';",
        ),
      ).toBe("O");
      value(
        "DO $$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='faculty_probe') THEN CREATE ROLE faculty_probe NOLOGIN; END IF; END$$;",
      );
      value("GRANT EXECUTE ON FUNCTION public.can_review_assignment(uuid,uuid) TO faculty_probe;");
      expect(run(migration)).toMatchObject({ ok: false });
      value(
        "REVOKE EXECUTE ON FUNCTION public.can_review_assignment(uuid,uuid) FROM faculty_probe;",
      );
      value(`CREATE FUNCTION public.can_review_assignment(uuid, uuid, timestamptz) RETURNS boolean
        LANGUAGE sql AS 'SELECT true';`);
      expect(run(migration)).toMatchObject({ ok: false });
      value("DROP FUNCTION public.can_review_assignment(uuid, uuid, timestamptz);");
      expect(run(migration)).toMatchObject({ ok: true });
    });

    it("PUBLIC에는 함수 실행 권한이 없습니다", () => {
      value(
        "DO $$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='faculty_probe') THEN CREATE ROLE faculty_probe NOLOGIN; END IF; END$$;",
      );
      expect(
        value(`SELECT bool_or(has_function_privilege('faculty_probe', p.oid, 'EXECUTE')) FROM pg_proc p
        JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN (
        'link_academic_faculty_account','end_academic_faculty_account_link','designate_academic_class_reviewer',
        'end_academic_class_reviewer','can_review_assignment','list_reviewable_academic_assignments',
        'academic_faculty_review_replay','guard_academic_faculty_review_period','guard_academic_faculty_review_events');`),
      ).toBe("f");
    });
  });

  describe("교수 계정 연결", () => {
    it("학사 운영 관리자만 연결할 수 있고 ADMIN·FACULTY·지정 승인자는 거부합니다", () => {
      const faculty = newFaculty();
      for (const actor of [ids.admin, ids.faculty, ids.approver, ids.member])
        expect(link(faculty, ids.faculty, { actor })).toEqual({ ok: false, code: "HRA01" });
      expect(
        value(`SELECT count(*) FROM academic_faculty_account_links WHERE faculty_id='${faculty}';`),
      ).toBe("0");
    });

    it("자기 연결, 승인 대기 계정, 없는 교수 프로필, 소급 시작을 거부합니다", () => {
      const faculty = newFaculty();
      expect(link(faculty, ids.manager)).toEqual({ ok: false, code: "HRA01" });
      expect(link(faculty, ids.pending)).toEqual({ ok: false, code: "HRA03" });
      expect(link(randomUUID(), newUser("FACULTY"))).toEqual({ ok: false, code: "HRA03" });
      expect(link(faculty, newUser("FACULTY"), { from: "-1 hour" })).toEqual({
        ok: false,
        code: "HRA07",
      });
    });

    it("교수 프로필과 계정은 각각 동시에 하나의 유효 연결만 가집니다", () => {
      const faculty = newFaculty();
      const otherFaculty = newFaculty();
      const user = newUser("FACULTY");
      expect(link(faculty, user)).toMatchObject({ ok: true });
      expect(link(faculty, newUser("FACULTY"))).toEqual({ ok: false, code: "23P01" });
      expect(link(otherFaculty, user)).toEqual({ ok: false, code: "23P01" });
    });

    it("두 연결이 같은 교수에 다른 계정을, 또는 같은 계정에 다른 교수를 동시에 연결하면 하나만 성공합니다", async () => {
      const faculty = newFaculty();
      const sameFaculty = (user: string) =>
        runAsync(`BEGIN; ${linkSql(faculty, user)} SELECT pg_sleep(0.4); COMMIT;`);
      const first = await Promise.all([
        sameFaculty(newUser("FACULTY")),
        sameFaculty(newUser("FACULTY")),
      ]);
      expect(first.filter((result) => result.ok)).toHaveLength(1);
      expect(first.filter((result) => !result.ok)).toEqual([{ ok: false, code: "23P01" }]);
      expect(
        value(`SELECT count(*) FROM academic_faculty_account_links WHERE faculty_id='${faculty}';`),
      ).toBe("1");

      const user = newUser("FACULTY");
      const sameUser = (target: string) =>
        runAsync(`BEGIN; ${linkSql(target, user)} SELECT pg_sleep(0.4); COMMIT;`);
      const second = await Promise.all([sameUser(newFaculty()), sameUser(newFaculty())]);
      expect(second.filter((result) => result.ok)).toHaveLength(1);
      expect(second.filter((result) => !result.ok)).toEqual([{ ok: false, code: "23P01" }]);
      expect(
        value(`SELECT count(*) FROM academic_faculty_account_links WHERE user_id='${user}';`),
      ).toBe("1");
    });

    it("REPEATABLE READ·SERIALIZABLE 트랜잭션의 연결은 HRA07로 거부합니다", () => {
      const faculty = newFaculty();
      for (const level of ["REPEATABLE READ", "SERIALIZABLE"])
        expect(
          run(`BEGIN ISOLATION LEVEL ${level}; ${linkSql(faculty, newUser("FACULTY"))} COMMIT;`),
        ).toEqual({ ok: false, code: "HRA07" });
    });
  });

  describe("과제 검토 권한 판정", () => {
    it("연결·지정이 없는 FACULTY·ADMIN, 연결만 된 교수, 다른 수업 담당 교수는 거부합니다", () => {
      const faculty = newFaculty();
      // 세션의 수업 내용 담당 교수(faculty_id)로 기록되어 있어도 지정 없이는 권한이 없습니다.
      const lesson = newClass(faculty);
      const assignment = newAssignment(lesson.event, lesson.first);
      for (const user of [ids.faculty, ids.admin, ids.member, ids.pending, ids.manager])
        expect(canReview(user, assignment)).toBe(false);
      const user = newUser("FACULTY");
      created(link(faculty, user));
      expect(canReview(user, assignment)).toBe(false);
      // 다른 수업의 검토자로 지정되어도 이 수업 과제는 거부합니다.
      const other = newClass();
      created(designate(faculty, other.event, null));
      expect(canReview(user, assignment)).toBe(false);
      expect(canReview(user, newAssignment(other.event, other.second))).toBe(true);
    });

    it("세션 지정은 그 세션 과제만, 일정 지정은 일정의 모든 과제를 허용하며 초안·수업 미연결 과제는 거부합니다", () => {
      const sessionFaculty = newFaculty();
      const eventFaculty = newFaculty();
      const sessionUser = newUser("FACULTY");
      const eventUser = newUser("FACULTY");
      created(link(sessionFaculty, sessionUser));
      created(link(eventFaculty, eventUser));
      const lesson = newClass();
      const first = newAssignment(lesson.event, lesson.first);
      const second = newAssignment(lesson.event, lesson.second, "CLOSED");
      const whole = newAssignment(lesson.event, null);
      const draft = newAssignment(lesson.event, lesson.first, "DRAFT");
      const unlinked = newAssignment(null, null);
      created(designate(sessionFaculty, lesson.event, lesson.first));
      created(designate(eventFaculty, lesson.event, null));
      expect(
        [first, second, whole, draft, unlinked].map((id) => canReview(sessionUser, id)),
      ).toEqual([true, false, false, false, false]);
      expect([first, second, whole, draft, unlinked].map((id) => canReview(eventUser, id))).toEqual(
        [true, true, true, false, false],
      );
      // 목록 함수도 같은 판정만 따르며 메타데이터만 돌려줍니다.
      expect(
        value(`SELECT string_agg(assignment_id::text, ',' ORDER BY assignment_id)
          FROM public.list_reviewable_academic_assignments('${eventUser}');`),
      ).toBe([first, second, whole].sort().join(","));
      // 다른 세션의 세션 ID를 섞은 지정은 거부합니다.
      expect(designate(sessionFaculty, lesson.event, newClass().first)).toEqual({
        ok: false,
        code: "HRA03",
      });
    });

    it("검토자로 지정된 교수에게도 출결 권한은 생기지 않습니다", () => {
      const faculty = newFaculty();
      const user = newUser("FACULTY");
      created(link(faculty, user));
      const lesson = newClass(faculty);
      created(designate(faculty, lesson.event, null));
      expect(canReview(user, newAssignment(lesson.event, lesson.first))).toBe(true);
      expect(value(`SELECT public.can_record_academic_attendance('${user}','${cohort}');`)).toBe(
        "f",
      );
    });

    it("지정 종료·연결 해제·계정 승인 대기 전환 즉시 권한이 사라집니다", () => {
      const faculty = newFaculty();
      const user = newUser("FACULTY");
      const linkId = created(link(faculty, user));
      const lesson = newClass();
      const assignment = newAssignment(lesson.event, lesson.first);
      const designation = created(designate(faculty, lesson.event, null));
      expect(canReview(user, assignment)).toBe(true);
      value(`UPDATE users SET role='PENDING' WHERE id='${user}';`);
      expect(canReview(user, assignment)).toBe(false);
      value(`UPDATE users SET role='FACULTY' WHERE id='${user}';`);
      expect(canReview(user, assignment)).toBe(true);
      value(`SELECT public.end_academic_class_reviewer('${randomUUID()}','${ids.manager}','${randomUUID()}',
        '${designation}',NULL,'합성 지정 종료');`);
      expect(canReview(user, assignment)).toBe(false);
      created(designate(faculty, lesson.event, lesson.first));
      expect(canReview(user, assignment)).toBe(true);
      value(`SELECT public.end_academic_faculty_account_link('${randomUUID()}','${ids.otherManager}','${randomUUID()}',
        '${linkId}',NULL,'합성 연결 해제');`);
      expect(canReview(user, assignment)).toBe(false);
      // 해제 뒤 같은 교수에 다른 계정을 연결할 수 있고, 지정은 교수 기준이므로 새 계정이 이어받습니다.
      const successor = newUser("FACULTY");
      created(link(faculty, successor));
      expect(canReview(successor, assignment)).toBe(true);
      expect(canReview(user, assignment)).toBe(false);
    });

    it("예약된 시작 전에는 권한이 없습니다", () => {
      const faculty = newFaculty();
      const user = newUser("FACULTY");
      const lesson = newClass();
      const assignment = newAssignment(lesson.event, null);
      created(link(faculty, user));
      created(designate(faculty, lesson.event, null, { from: "1 hour" }));
      expect(canReview(user, assignment)).toBe(false);
    });
  });

  describe("관리자 전용 변경과 자기 지정 금지", () => {
    it("학사 운영 관리자가 아니면 지정·지정 종료·연결 해제를 할 수 없습니다", () => {
      const faculty = newFaculty();
      const lesson = newClass();
      const linkId = created(link(faculty, newUser("FACULTY")));
      for (const actor of [ids.admin, ids.faculty, ids.approver])
        expect(designate(faculty, lesson.event, null, { actor })).toEqual({
          ok: false,
          code: "HRA01",
        });
      const designation = created(designate(faculty, lesson.event, null));
      for (const actor of [ids.admin, ids.faculty])
        expect(
          run(`SELECT public.end_academic_class_reviewer('${randomUUID()}','${actor}','${randomUUID()}',
          '${designation}',NULL,'권한 없음');`),
        ).toEqual({ ok: false, code: "HRA01" });
      expect(
        run(`SELECT public.end_academic_faculty_account_link('${randomUUID()}','${ids.admin}','${randomUUID()}',
        '${linkId}',NULL,'권한 없음');`),
      ).toEqual({ ok: false, code: "HRA01" });
    });

    it("관리자 자신과 연결된 교수는 지정할 수 없고, 지정자가 나중에 연결되어도 그 지정으로는 검토할 수 없습니다", () => {
      const own = newFaculty();
      const lesson = newClass();
      const assignment = newAssignment(lesson.event, null);
      created(link(own, ids.manager, { actor: ids.otherManager }));
      expect(designate(own, lesson.event, null)).toEqual({ ok: false, code: "HRA01" });
      // 다른 관리자가 지정하면 정상적인 검토 권한입니다.
      created(designate(own, lesson.event, null, { actor: ids.otherManager }));
      expect(canReview(ids.manager, assignment)).toBe(true);

      // 지정 후 지정자 본인이 연결된 경우: 판정 함수가 지정자=연결 계정 조합을 제외합니다.
      const later = newFaculty();
      const another = newClass();
      const laterAssignment = newAssignment(another.event, null);
      created(designate(later, another.event, null, { actor: ids.otherManager }));
      // otherManager는 manager와 이미 다른 교수(own)로 연결되어 있지 않으므로 later에 연결할 수 있습니다.
      created(link(later, ids.otherManager));
      expect(canReview(ids.otherManager, laterAssignment)).toBe(false);
    });
  });

  describe("불변성·감사·멱등성", () => {
    it("연결·지정·감사 행은 종료 기록 외 수정·삭제·비우기가 거부됩니다", () => {
      const faculty = newFaculty();
      const lesson = newClass();
      const linkId = created(link(faculty, newUser("FACULTY")));
      const designation = created(designate(faculty, lesson.event, null));
      expect(
        run(
          `UPDATE academic_faculty_account_links SET user_id='${ids.member}' WHERE id='${linkId}';`,
        ),
      ).toEqual({ ok: false, code: "HRA04" });
      expect(
        run(
          `UPDATE academic_class_reviewer_designations SET schedule_session_id='${lesson.first}' WHERE id='${designation}';`,
        ),
      ).toEqual({ ok: false, code: "HRA04" });
      expect(run(`DELETE FROM academic_faculty_account_links WHERE id='${linkId}';`)).toEqual({
        ok: false,
        code: "HRA04",
      });
      expect(run("TRUNCATE academic_class_reviewer_designations CASCADE;")).toEqual({
        ok: false,
        code: "HRA04",
      });
      expect(
        run(`UPDATE academic_faculty_review_events SET correlation_id='${randomUUID()}'
          WHERE link_id='${linkId}';`),
      ).toEqual({ ok: false, code: "HRA04" });
      expect(run(`DELETE FROM academic_faculty_review_events WHERE link_id='${linkId}';`)).toEqual({
        ok: false,
        code: "HRA04",
      });
      // 함수 밖 직접 UPDATE로도 현재 이전 시각으로 소급 종료할 수 없습니다.
      expect(
        run(`UPDATE academic_class_reviewer_designations SET valid_to=now() - interval '1 hour',
          ended_by_user_id='${ids.manager}', ended_at=now(), end_reason='소급' WHERE id='${designation}';`),
      ).toEqual({ ok: false, code: "HRA07" });
      value(`SELECT public.end_academic_faculty_account_link('${randomUUID()}','${ids.manager}','${randomUUID()}',
        '${linkId}',NULL,'합성 해제');`);
      expect(
        run(`SELECT public.end_academic_faculty_account_link('${randomUUID()}','${ids.manager}','${randomUUID()}',
        '${linkId}',NULL,'재해제');`),
      ).toEqual({ ok: false, code: "HRA04" });
      expect(
        value(`SELECT string_agg(action, ',' ORDER BY created_at, action) FROM academic_faculty_review_events
        WHERE link_id='${linkId}' OR designation_id='${designation}';`),
      ).toBe("LINK,DESIGNATE,UNLINK");
    });

    it("같은 요청 ID 재시도는 이전 결과를 돌려주고, 다른 입력에 재사용하면 거부합니다", () => {
      const faculty = newFaculty();
      const user = newUser("FACULTY");
      const request = randomUUID();
      const replayed = () =>
        value(linkSql(faculty, user, { request }).replace("->'link'->>'id'", "->>'replayed'"));
      expect([replayed(), replayed()]).toEqual(["false", "true"]);
      expect(link(faculty, newUser("FACULTY"), { request })).toEqual({ ok: false, code: "HRA02" });
      expect(
        value(`SELECT concat_ws('|', (SELECT count(*) FROM academic_faculty_account_links WHERE faculty_id='${faculty}'),
          (SELECT count(*) FROM academic_faculty_review_events WHERE request_id='${request}'));`),
      ).toBe("1|1");
    });
  });

  describe("Application Service", () => {
    const principal = (key: keyof typeof ids, role = roles[key]) => ({ userId: ids[key], role });

    it("기능 플래그가 꺼져 있으면 DB에 접속하지 않고 판정은 false, 목록·변경은 DISABLED입니다", async () => {
      vi.stubEnv("ACADEMIC_FACULTY_REVIEW_ENABLED", "false");
      const faculty = newFaculty();
      const user = newUser("FACULTY");
      created(link(faculty, user));
      const lesson = newClass();
      const assignment = newAssignment(lesson.event, null);
      created(designate(faculty, lesson.event, null));
      expect(canReview(user, assignment)).toBe(true);
      mocks.calls = 0;
      expect(await canReviewAssignment({ userId: user, role: "FACULTY" }, assignment)).toBe(false);
      await expect(
        listReviewableAssignments({ userId: user, role: "FACULTY" }),
      ).rejects.toMatchObject({ code: "DISABLED" });
      await expect(linkFacultyAccount(principal("manager"), {})).rejects.toMatchObject({
        code: "DISABLED",
      });
      vi.stubEnv("ACADEMIC_FACULTY_REVIEW_ENABLED", "true");
      vi.stubEnv("ACADEMIC_ENABLED", "false");
      expect(await canReviewAssignment({ userId: user, role: "FACULTY" }, assignment)).toBe(false);
      expect(mocks.calls).toBe(0);
    });

    it("관리자 연결·지정·판정·목록·종료가 서비스 경계를 통해 동작하고 DB 오류를 고정 코드로 바꿉니다", async () => {
      const faculty = newFaculty();
      const user = newUser("FACULTY");
      const lesson = newClass();
      const assignment = newAssignment(lesson.event, lesson.first);
      const reviewer = { userId: user, role: "FACULTY" as const };
      await expect(
        linkFacultyAccount(principal("admin"), {
          requestId: randomUUID(),
          facultyId: faculty,
          userId: user,
          verificationMethod: "IN_PERSON",
          evidenceReference: evidence,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 });
      const linked = await linkFacultyAccount(principal("manager"), {
        requestId: randomUUID(),
        facultyId: faculty,
        userId: user,
        verificationMethod: "VERIFIED_CONTACT",
        evidenceReference: evidence,
      });
      expect(linked).toMatchObject({ replayed: false, link: { facultyId: faculty, userId: user } });
      expect(linked.link).not.toHaveProperty("evidenceReference");
      await expect(
        linkFacultyAccount(principal("manager"), {
          requestId: randomUUID(),
          facultyId: faculty,
          userId: newUser("FACULTY"),
          verificationMethod: "IN_PERSON",
          evidenceReference: evidence,
        }),
      ).rejects.toMatchObject({ code: "DUPLICATE", status: 409 });
      expect(await canReviewAssignment(reviewer, assignment)).toBe(false);
      const designated = await designateReviewer(principal("manager"), {
        requestId: randomUUID(),
        facultyId: faculty,
        scheduleEventId: lesson.event,
        scheduleSessionId: lesson.first,
      });
      expect(designated.designation).toMatchObject({
        facultyId: faculty,
        scheduleSessionId: lesson.first,
        designatedByUserId: ids.manager,
      });
      expect(await canReviewAssignment(reviewer, assignment)).toBe(true);
      // 같은 계정이라도 주체가 승인 대기로 전달되면 DB 조회 없이 거부합니다.
      expect(await canReviewAssignment({ ...reviewer, role: "PENDING" }, assignment)).toBe(false);
      expect(await canReviewAssignment(principal("admin"), assignment)).toBe(false);
      expect(await canReviewAssignment(principal("faculty"), assignment)).toBe(false);
      expect(await canReviewAssignment(reviewer, "not-a-uuid")).toBe(false);
      const list = await listReviewableAssignments(reviewer);
      expect(list).toEqual([
        expect.objectContaining({ assignmentId: assignment, scheduleSessionId: lesson.first }),
      ]);
      expect(list[0]).not.toHaveProperty("instructions");
      expect(await listReviewableAssignments(principal("faculty"))).toEqual([]);
      await expect(
        designateReviewer(principal("manager"), { facultyId: faculty, scheduleEventId: "x" }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
      await expect(
        endDesignation(principal("faculty"), {
          requestId: randomUUID(),
          designationId: designated.designation.id,
          reason: "권한 없음",
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      const ended = await endDesignation(principal("manager"), {
        requestId: randomUUID(),
        designationId: designated.designation.id,
        reason: "합성 지정 종료",
      });
      expect(ended.designation.endedByUserId).toBe(ids.manager);
      expect(await canReviewAssignment(reviewer, assignment)).toBe(false);
      const unlinked = await unlinkFacultyAccount(principal("manager"), {
        requestId: randomUUID(),
        linkId: linked.link.id,
        reason: "합성 해제",
      });
      expect(unlinked.link.endedByUserId).toBe(ids.manager);
    });
  });
});
