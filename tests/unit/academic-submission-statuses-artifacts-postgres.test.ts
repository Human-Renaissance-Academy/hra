// @vitest-environment node
/**
 * #516 PR-G 제출 현황 SQL이 분리 제출(V2) 과제의 항목별 형식·크기를 실제 범위 SQL 구조에서 읽는지 격리 PostgreSQL로 검증한다.
 * - G1 범위 SQL과 #516 마이그레이션을 적용하고 V2 제출은 실제 issue/verify/complete V2 함수로 만든다.
 * - 인증 세션만 대체하며 현황 조회가 만든 SQL을 그대로 실행한다. gate가 꺼지면 새 컬럼을 읽지 않는지도 확인한다.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), execute: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/db", () => ({ db: { execute: mocks.execute } }));
import {
  exportAssignmentSubmissionStatuses,
  listAssignmentSubmissionStatuses,
} from "@/features/academics/submission-statuses/queries";
import { renderSubmissionStatusesCsv } from "@/features/academics/submission-statuses/csv";

const bin = process.env.HRA_TEST_PG_BIN;
const uid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const aid = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sid = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const cohort = "30000000-0000-4000-8000-000000000001";
const approver = uid(9);
// 1: V2(텍스트 필수·발표자료 선택), 2: V2(텍스트 미사용·발표자료 필수) 미제출, 3: 기존 PDF 단일 제출 과제
const split = aid(1),
  slidesOnly = aid(2),
  legacy = aid(3);

// PREPARE 인수만 안전한 SQL 리터럴로 만든다.
function literal(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  throw new Error("테스트 SQL 인수는 문자열·유한 숫자·NULL만 허용합니다.");
}

describe.skipIf(!bin)("제출 현황의 분리 제출 항목 열 (격리 PostgreSQL)", () => {
  let root: string;
  let started = false;
  let args: string[];
  const program = (name: string) => join(bin!, name);
  const run = (query: string) =>
    execFileSync(program("psql"), [...args, "-Atq"], {
      input: query,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  const targetOf = (assignment: string, student: string) =>
    run(`SELECT t.id FROM assignment_targets t JOIN cohort_enrollments e ON e.id=t.enrollment_id
      WHERE t.assignment_id='${assignment}' AND e.student_id='${student}';`);
  const upload = (
    target: string,
    owner: string,
    artifact: string,
    format: string,
    name: string,
    size: number,
  ) => {
    const intent = run(
      `SELECT issue_academic_assignment_upload_v2(gen_random_uuid(),'${target}','${owner}','${artifact}','${format}','${name}',${size});`,
    );
    run(
      `SELECT verify_authorized_academic_upload_v2('${intent}','${owner}','${"c".repeat(64)}','etag-${intent}');`,
    );
    return intent;
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "hra-status-artifacts-"));
    execFileSync(
      program("initdb"),
      ["-D", join(root, "data"), "-A", "trust", "-U", "hra_test", "--no-locale", "-E", "UTF8"],
      { stdio: "pipe" },
    );
    execFileSync(
      program("pg_ctl"),
      [
        "-D",
        join(root, "data"),
        "-l",
        join(root, "server.log"),
        "-o",
        `-h '' -k ${root} -p 55499`,
        "-w",
        "start",
      ],
      { stdio: "pipe" },
    );
    started = true;
    args = [
      "-X",
      "-h",
      root,
      "-p",
      "55499",
      "-U",
      "hra_test",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
    ];
    run(`CREATE TABLE users(id uuid PRIMARY KEY,role text NOT NULL DEFAULT 'MEMBER');
      CREATE TABLE cohorts(id uuid PRIMARY KEY);
      CREATE TABLE schedule_events(id uuid PRIMARY KEY,cohort_id uuid REFERENCES cohorts(id));
      CREATE TABLE schedule_sessions(id uuid PRIMARY KEY,schedule_event_id uuid REFERENCES schedule_events(id));
      CREATE TABLE application_submissions(id uuid PRIMARY KEY);
      INSERT INTO cohorts VALUES('${cohort}');
      INSERT INTO users(id,role) VALUES('${uid(1)}','MEMBER'),('${uid(2)}','MEMBER'),('${uid(3)}','MEMBER'),('${approver}','ADMIN');`);
    run(readFileSync("scripts/sql/rate-limit-reservations.sql", "utf8"));
    for (const name of [
      "students",
      "assignments",
      "submissions",
      "assignment-actions",
      "upload-authorizations",
      "submission-finalization",
      "submission-artifacts",
    ])
      run(readFileSync(`scripts/migrate-academic-${name}.sql`, "utf8"));
    for (const n of [1, 2, 3])
      run(`INSERT INTO academic_students(id,user_id,display_name) VALUES('${sid(n)}','${uid(n)}','학생 ${n}');
        INSERT INTO cohort_enrollments(student_id,cohort_id) VALUES('${sid(n)}','${cohort}');`);
    for (const [id, format, text, slides] of [
      [split, "ARTIFACTS_V2", "'REQUIRED'", "'OPTIONAL'"],
      [slidesOnly, "ARTIFACTS_V2", "'DISABLED'", "'REQUIRED'"],
      [legacy, "LEGACY_SINGLE_PDF", "NULL", "NULL"],
    ] as const)
      run(`INSERT INTO assignments(id,cohort_id,title,instructions,due_at,created_by_user_id,submission_format,text_requirement,slides_requirement)
        VALUES('${id}','${cohort}','현황 ${id.slice(-1)}','안내',clock_timestamp()+interval '3 days','${approver}','${format}',${text},${slides});
        SELECT id FROM publish_academic_assignment('${id}','${approver}');`);
    // 학생 1은 텍스트·발표자료 두 파일, 학생 2는 텍스트만 제출하고 학생 3은 미제출이다.
    const t1 = targetOf(split, sid(1)),
      t2 = targetOf(split, sid(2));
    const a = upload(t1, uid(1), "TEXT", "HWPX", "본문1.hwpx", 3000),
      b = upload(t1, uid(1), "SLIDES", "PPTX", "발표1.pptx", 4000);
    run(
      `SELECT complete_academic_assignment_submission_v2('${t1}','${uid(1)}',ARRAY['${a}','${b}']::uuid[],gen_random_uuid(),true);`,
    );
    const c = upload(t2, uid(2), "TEXT", "PDF", "본문2.pdf", 1234);
    run(
      `SELECT complete_academic_assignment_submission_v2('${t2}','${uid(2)}',ARRAY['${c}']::uuid[],gen_random_uuid(),true);`,
    );
    mocks.execute.mockImplementation(async (query: Parameters<PgDialect["sqlToQuery"]>[0]) => {
      const compiled = new PgDialect().sqlToQuery(query);
      return {
        rows: [
          JSON.parse(
            run(
              `PREPARE status_query AS SELECT row_to_json(snapshot) FROM (${compiled.sql}) snapshot; EXECUTE status_query(${compiled.params.map(literal).join(",")});`,
            ),
          ),
        ],
      };
    });
  }, 60000);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("ACADEMIC_ENABLED", "true");
    vi.stubEnv("ACADEMIC_UPLOADS_ENABLED", "true");
    vi.stubEnv("ACADEMIC_SUBMISSION_ARTIFACTS_ENABLED", "true");
    vi.stubEnv("ACADEMIC_APPROVER_USER_ID", approver);
    mocks.auth.mockResolvedValue({ user: { id: approver, role: "ADMIN" } });
  });
  afterAll(() => {
    vi.unstubAllEnvs();
    try {
      if (started)
        execFileSync(
          program("pg_ctl"),
          ["-D", join(root, "data"), "-m", "immediate", "-w", "stop"],
          { stdio: "pipe" },
        );
    } finally {
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  it("V2 과제는 학생별 항목 형식·크기를 텍스트→발표자료 순으로 읽고 파일명·ID는 읽지 않는다", async () => {
    const result = await listAssignmentSubmissionStatuses({ assignmentId: split });
    expect(result.assignment).toMatchObject({
      submissionFormat: "ARTIFACTS_V2",
      textRequirement: "REQUIRED",
      slidesRequirement: "OPTIONAL",
    });
    expect(result.counts).toEqual({ total: 3, submitted: 2, unsubmitted: 1 });
    const byName = Object.fromEntries(result.rows.map((row) => [row.displayName, row.artifacts]));
    expect(byName).toEqual({
      "학생 1": [
        { artifactType: "TEXT", fileFormat: "HWPX", sizeBytes: 3000 },
        { artifactType: "SLIDES", fileFormat: "PPTX", sizeBytes: 4000 },
      ],
      "학생 2": [{ artifactType: "TEXT", fileFormat: "PDF", sizeBytes: 1234 }],
      "학생 3": null,
    });
    expect(JSON.stringify(result)).not.toMatch(/본문1|발표1|academic-uploads|etag/);
  });

  it("CSV는 실제 조회 결과로 항목 열을 만든다", async () => {
    const result = await exportAssignmentSubmissionStatuses({ assignmentId: split });
    const csv = renderSubmissionStatusesCsv(result.rows, result.assignment);
    expect(csv).toContain('"학생 1","제출",');
    expect(csv).toContain('"제출","HWPX","3000","제출","PPTX","4000"');
    expect(csv).toContain('"제출","PDF","1234","미제출","",""');
    expect(csv).toContain('"학생 3","미제출","","미제출","","","미제출","",""');
  });

  it("미제출 V2 과제와 기존 PDF 과제는 항목 값이 없다", async () => {
    const pending = await listAssignmentSubmissionStatuses({ assignmentId: slidesOnly });
    expect(pending.assignment).toMatchObject({
      submissionFormat: "ARTIFACTS_V2",
      textRequirement: "DISABLED",
      slidesRequirement: "REQUIRED",
    });
    expect(pending.rows.every((row) => row.artifacts === null)).toBe(true);
    const pdf = await listAssignmentSubmissionStatuses({ assignmentId: legacy });
    expect(pdf.assignment).toMatchObject({
      submissionFormat: "LEGACY_SINGLE_PDF",
      textRequirement: null,
      slidesRequirement: null,
    });
    expect(pdf.rows.every((row) => row.artifacts === null)).toBe(true);
  });

  it("gate가 꺼지면 새 컬럼을 읽지 않는 기존 SQL로 기존 결과만 반환한다", async () => {
    vi.stubEnv("ACADEMIC_SUBMISSION_ARTIFACTS_ENABLED", "false");
    const result = await listAssignmentSubmissionStatuses({ assignmentId: split });
    expect(result.counts).toEqual({ total: 3, submitted: 2, unsubmitted: 1 });
    expect("submissionFormat" in result.assignment).toBe(false);
    expect(result.rows.every((row) => !("artifacts" in row))).toBe(true);
    const compiled = new PgDialect().sqlToQuery(mocks.execute.mock.calls[0][0]);
    expect(compiled.sql).not.toMatch(/submission_format|artifact_type|file_format/);
  });
});
