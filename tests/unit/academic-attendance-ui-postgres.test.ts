// @vitest-environment node
/**
 * #160 화면용 읽기 조회(운영 현황·감사·배정 기수·수업일·정정 목록·학생 본인·메뉴 판정)의 실제 PostgreSQL 회귀입니다.
 *
 * - 소유 임시 클러스터(HRA_TEST_PG_BIN)에 화면이 읽는 컬럼(users.name, cohorts.order, schedule_events.week_number)을
 *   포함한 최소 표와 G1 학적·#165 운영 인력·#159 출결 SQL만 설치합니다. 운영 DB·환경 파일은 읽지 않습니다.
 * - Drizzle·Neon SDK 경로로 서비스를 호출해, 권한 판정이 같은 SQL 문 안에서 DB 현재 시각으로 이뤄지고
 *   홈페이지 ADMIN·교수 FACULTY·다른 기수 인력이 거부되는지 확인합니다.
 */
import { neon, neonConfig } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
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
  getAttendanceNavigation,
  getOwnAttendanceOverview,
  listClassSessions,
  listPendingCorrectionsForManager,
} from "@/features/academics/attendance/service";
import {
  getStaffManagementOverview,
  listMyStaffCohorts,
  listStaffAuditEvents,
} from "@/features/academics/staff/service";

const bin = process.env.HRA_TEST_PG_BIN;
const source = (name: string) =>
  readFileSync(new URL(`../../scripts/${name}`, import.meta.url), "utf8");

const ids = {
  approver: "16000000-0000-4000-8000-000000000101",
  manager: "16000000-0000-4000-8000-000000000102",
  advisor: "16000000-0000-4000-8000-000000000103",
  otherStaff: "16000000-0000-4000-8000-000000000104",
  admin: "16000000-0000-4000-8000-000000000105",
  faculty: "16000000-0000-4000-8000-000000000106",
  student: "16000000-0000-4000-8000-000000000107",
  assistant: "16000000-0000-4000-8000-000000000108",
};
const roles: Record<keyof typeof ids, string> = {
  approver: "MEMBER",
  manager: "MEMBER",
  advisor: "MEMBER",
  otherStaff: "MEMBER",
  admin: "ADMIN",
  faculty: "FACULTY",
  student: "MEMBER",
  assistant: "MEMBER",
};
const cohortA = "16000000-0000-4000-8000-0000000001a1";
const cohortB = "16000000-0000-4000-8000-0000000001b1";
const studentRow = "16000000-0000-4000-8000-0000000001c1";
const enrollment = "16000000-0000-4000-8000-0000000001c2";
const evidence = "16000000-0000-4000-8000-0000000001ee";
const principal = (key: keyof typeof ids) => ({ userId: ids[key], role: roles[key] });

describe.skipIf(!bin)("#160 화면용 읽기 조회(격리 PostgreSQL)", () => {
  let cluster: ReturnType<typeof createQaPostgres>;
  const previousFetch = neonConfig.fetchFunction;
  const previousEndpoint = neonConfig.fetchEndpoint;
  const events = {
    recent: randomUUID(),
    old: randomUUID(),
    nonClass: randomUUID(),
    other: randomUUID(),
  };
  let correctionId = "";

  beforeAll(() => {
    cluster = createQaPostgres(bin);
    cluster.sql(`CREATE TABLE users(id uuid PRIMARY KEY, role text NOT NULL, name text NOT NULL);
      CREATE TABLE cohorts(id uuid PRIMARY KEY, name text NOT NULL, "order" integer NOT NULL DEFAULT 0);
      CREATE TABLE schedule_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), event_date timestamp NOT NULL,
        event_type text NOT NULL, cohort_id uuid REFERENCES cohorts(id) ON DELETE SET NULL, title text NOT NULL,
        week_number integer);
      INSERT INTO users VALUES ${Object.entries(ids)
        .map(([key, id]) => `('${id}','${roles[key as keyof typeof ids]}','합성 ${key}')`)
        .join(",")};
      INSERT INTO cohorts(id,name,"order") VALUES ('${cohortA}','합성 A기',1),('${cohortB}','합성 B기',2);`);
    cluster.sql(source("migrate-academic-students.sql"));
    cluster.sql(source("migrate-academic-staff-assignments.sql"));
    cluster.sql(source("migrate-academic-attendance.sql"));
    const day = (offset: number) =>
      `((now() AT TIME ZONE 'Asia/Seoul')::date + ${offset}) + time '10:00'`;
    cluster.sql(`INSERT INTO academic_students(id,user_id,display_name) VALUES ('${studentRow}','${ids.student}','합성 학생');
      INSERT INTO cohort_enrollments(id,student_id,cohort_id,enrolled_at)
        VALUES ('${enrollment}','${studentRow}','${cohortA}',now() - interval '60 days');
      INSERT INTO schedule_events(id,event_date,event_type,cohort_id,title,week_number) VALUES
        ('${events.recent}',${day(-1)},'CLASS','${cohortA}','합성 2주차',2),
        ('${events.old}',${day(-10)},'CLASS','${cohortA}','합성 1주차',1),
        ('${events.nonClass}',${day(-2)},'EVENT','${cohortA}','합성 행사',NULL),
        ('${events.other}',${day(-1)},'CLASS','${cohortB}','합성 B 수업',1);
      SELECT public.designate_academic_operations_manager('${randomUUID()}','${ids.approver}','${ids.approver}',
        '${randomUUID()}','${ids.manager}',NULL,NULL,'IN_PERSON','${evidence}');
      SELECT public.assign_academic_cohort_staff('${randomUUID()}','${ids.manager}','${randomUUID()}',
        '${cohortA}','${ids.advisor}','ADVISOR',NULL,NULL,'IN_PERSON','${evidence}');
      SELECT public.assign_academic_cohort_staff('${randomUUID()}','${ids.manager}','${randomUUID()}',
        '${cohortA}','${ids.assistant}','ASSISTANT',NULL,NULL,'IN_PERSON','${evidence}');
      SELECT public.assign_academic_cohort_staff('${randomUUID()}','${ids.manager}','${randomUUID()}',
        '${cohortB}','${ids.otherStaff}','ASSISTANT',NULL,NULL,'IN_PERSON','${evidence}');
      SELECT public.assign_academic_cohort_staff('${randomUUID()}','${ids.manager}','${randomUUID()}',
        '${cohortB}','${ids.advisor}','ADVISOR',now() + interval '30 days',NULL,'IN_PERSON','${evidence}');`);
    // 입력 기간이 지난 수업의 정정 요청(대기)을 하나 만듭니다.
    correctionId = cluster
      .sql(
        `SELECT (public.request_academic_attendance_correction('${randomUUID()}','${ids.advisor}','${randomUUID()}',
        '${events.old}','${enrollment}','PRESENT',0,'합성 정정 사유',NULL))->'correction'->>'id';`,
      )
      .trim();

    const transport = createPsqlTransport(cluster.environment);
    neonConfig.fetchEndpoint = qaNeonEndpoint;
    neonConfig.fetchFunction = async (address: unknown, options: RequestInit) => {
      if (
        String(address) !== qaNeonEndpoint ||
        new Headers(options.headers).get("Neon-Connection-String") !== qaDatabaseUrl
      )
        throw new Error("격리 SQL 범위 이외 요청 차단");
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

  it("정정 요청 준비가 성공했습니다", () => {
    expect(correctionId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("학사 운영 관리자만 기수·현재/예정 배정과 감사 목록을 봅니다(ADMIN·운영 인력·교수 거부)", async () => {
    const overview = await getStaffManagementOverview(principal("manager"));
    expect(overview.cohorts.map((cohort) => cohort.name)).toEqual(["합성 A기", "합성 B기"]);
    const advisorRows = overview.assignments.filter((row) => row.userId === ids.advisor);
    expect(
      advisorRows.map((row) => [row.cohortId, row.staffRole, row.upcoming, row.userName]),
    ).toEqual(
      expect.arrayContaining([
        [cohortA, "ADVISOR", false, "합성 advisor"],
        [cohortB, "ADVISOR", true, "합성 advisor"],
      ]),
    );
    const audit = await listStaffAuditEvents(principal("manager"));
    expect(audit.filter((event) => event.action === "STAFF_ASSIGN")).toHaveLength(4);
    expect(
      audit.some(
        (event) => event.action === "MANAGER_DESIGNATE" && event.targetName === "합성 manager",
      ),
    ).toBe(true);
    expect(JSON.stringify(audit)).not.toContain(evidence);

    for (const denied of ["admin", "advisor", "faculty", "approver"] as const) {
      await expect(getStaffManagementOverview(principal(denied))).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
      await expect(listStaffAuditEvents(principal(denied))).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
    }
  });

  it("운영 인력은 현재 유효한 본인 배정 기수만 보고, 예정 배정은 아직 보이지 않습니다", async () => {
    expect(
      (await listMyStaffCohorts(principal("advisor"))).map((cohort) => cohort.cohortId),
    ).toEqual([cohortA]);
    expect(await listMyStaffCohorts(principal("admin"))).toEqual([]);
    expect(await listMyStaffCohorts(principal("manager"))).toEqual([]);
  });

  it("배정 기수의 CLASS 수업일만 입력 창과 함께 돌려주고, 다른 기수·관리자·ADMIN·FACULTY는 거부합니다", async () => {
    const sessions = await listClassSessions(principal("advisor"), cohortA);
    expect(sessions.map((session) => [session.id, session.weekNumber])).toEqual([
      [events.old, 1],
      [events.recent, 2],
    ]);
    const recent = sessions[1];
    expect(Date.parse(recent.windowClosesAt) - Date.parse(recent.windowOpensAt)).toBe(
      8 * 24 * 3600 * 1000,
    );

    await expect(listClassSessions(principal("advisor"), cohortB)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    for (const denied of ["manager", "admin", "faculty", "otherStaff"] as const)
      await expect(listClassSessions(principal(denied), cohortA)).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
  });

  it("대기 중 정정 목록은 관리자에게만 사유·본인 요청 여부와 함께 보입니다", async () => {
    const corrections = await listPendingCorrectionsForManager(principal("manager"));
    expect(corrections).toEqual([
      expect.objectContaining({
        id: correctionId,
        cohortName: "합성 A기",
        displayName: "합성 학생",
        previousStatus: "UNMARKED",
        requestedStatus: "PRESENT",
        reason: "합성 정정 사유",
        requestedBySelf: false,
      }),
    ]);
    expect(JSON.stringify(corrections)).not.toContain(ids.advisor);
    for (const denied of ["advisor", "admin", "student"] as const)
      await expect(listPendingCorrectionsForManager(principal(denied))).rejects.toMatchObject({
        code: "FORBIDDEN",
      });
  });

  it("학생 본인은 미입력을 포함한 자기 출결과 정정 요약만 보고 사유·운영 인력 식별자는 받지 않습니다", async () => {
    const own = await getOwnAttendanceOverview(principal("student"));
    expect(own.cohorts).toEqual([{ id: cohortA, name: "합성 A기" }]);
    expect(own.records.map((record) => [record.scheduleEventId, record.status])).toEqual([
      [events.old, "UNMARKED"],
      [events.recent, "UNMARKED"],
    ]);
    expect(own.corrections).toEqual([
      expect.objectContaining({
        id: correctionId,
        status: "PENDING",
        previousStatus: "UNMARKED",
        decidedAt: null,
      }),
    ]);
    const serialized = JSON.stringify(own);
    expect(serialized).not.toContain("합성 정정 사유");
    expect(serialized).not.toContain(ids.advisor);

    const none = await getOwnAttendanceOverview(principal("admin"));
    expect(none).toEqual({ records: [], cohorts: [], corrections: [] });
  });

  it("메뉴 판정은 관리자 지정·유효 배정·본인 학적만 반영하고 홈페이지 ADMIN에게는 아무것도 열지 않습니다", async () => {
    expect(await getAttendanceNavigation(principal("manager"))).toEqual({
      operations: true,
      staffAttendance: false,
      ownAttendance: false,
    });
    expect(await getAttendanceNavigation(principal("advisor"))).toEqual({
      operations: false,
      staffAttendance: true,
      ownAttendance: false,
    });
    expect(await getAttendanceNavigation(principal("student"))).toEqual({
      operations: false,
      staffAttendance: false,
      ownAttendance: true,
    });
    for (const denied of ["admin", "faculty", "approver"] as const)
      expect(await getAttendanceNavigation(principal(denied))).toEqual({
        operations: false,
        staffAttendance: false,
        ownAttendance: false,
      });
  });
});
