// @vitest-environment node
/**
 * #516 PR-F 학생 과제 상세 조회가 텍스트·발표자료 분리 제출(V2)을 실제 범위 SQL 구조에서 읽는지 격리 PostgreSQL로 검증한다.
 * - G1 범위 SQL과 #516 마이그레이션을 적용하고, V2 제출은 실제 issue/verify/complete V2 함수로 만든다.
 * - 인증 세션과 Neon HTTP 전송만 대체하며 학생 조회가 만든 Drizzle SQL을 그대로 실행한다.
 * - 분리 제출 gate가 꺼져 있으면 기존(v1) 조회 경로만 실행되는지도 확인한다.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), query: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@neondatabase/serverless", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@neondatabase/serverless")>();
  return { ...actual, neon: () => Object.assign(mocks.query, { query: mocks.query }) };
});
vi.mock("@/lib/db", async () => {
  const { drizzle } = await import("drizzle-orm/neon-http");
  const { neon } = await import("@neondatabase/serverless");
  // 전송 함수가 테스트용이므로 이 주소로 네트워크 연결은 발생하지 않는다.
  return { db: drizzle(neon("postgresql://fixture@localhost/isolated_test")) };
});
import { getMyAssignment } from "@/features/academics/student-assignments/queries";

const bin = process.env.HRA_TEST_PG_BIN;
const uid = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const aid = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sid = (n: number) => `40000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const cohort = "30000000-0000-4000-8000-000000000001";
const memberA = uid(1),
  memberB = uid(2),
  manager = uid(9);
// 1: V2(텍스트 필수·발표자료 선택) A 제출 완료, 2: V2(둘 다 선택) 미제출, 3: 기존 PDF 단일 제출 과제
const bothFiles = aid(1),
  optionalOnly = aid(2),
  legacy = aid(3);

// psql CSV를 Neon arrayMode 결과로 변환한다. 인용문 내부 쉼표·개행과 NULL을 구분한다.
function parseCsv(source: string): (string | null)[][] {
  const rows: (string | null)[][] = [];
  let row: (string | null)[] = [],
    value = "",
    quoted = false,
    wasQuoted = false;
  const pushValue = () => {
    row.push(value === "" && !wasQuoted ? null : value);
    value = "";
    wasQuoted = false;
  };
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    if (quoted) {
      if (char === '"' && source[i + 1] === '"') {
        value += '"';
        i++;
      } else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"' && value === "") {
      quoted = true;
      wasQuoted = true;
    } else if (char === ",") pushValue();
    else if (char === "\n") {
      pushValue();
      rows.push(row);
      row = [];
    } else if (char !== "\r") value += char;
  }
  if (row.length || value || wasQuoted) {
    pushValue();
    rows.push(row);
  }
  return rows;
}

// PREPARE 인수만 안전한 SQL 리터럴로 만들고 조회가 생성한 쿼리 본문은 그대로 실행한다.
function literal(value: unknown): string {
  if (value === null) return "NULL";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") return `'${value.replaceAll("'", "''")}'`;
  throw new Error("테스트 SQL 인수는 문자열·유한 숫자·NULL만 허용합니다.");
}

describe.skipIf(!bin)("학생 과제 상세의 V2 분리 제출 조회 (격리 PostgreSQL)", () => {
  let root: string;
  let started = false;
  let args: string[];
  const fileIds: Record<string, string> = {};
  const program = (name: string) => join(bin!, name);
  const run = (query: string) =>
    execFileSync(program("psql"), [...args, "-Atq"], {
      input: query,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  const session = (id: string) => mocks.auth.mockResolvedValue({ user: { id, role: "MEMBER" } });
  const targetOf = (assignment: string, student: string) =>
    run(`SELECT t.id FROM assignment_targets t JOIN cohort_enrollments e ON e.id=t.enrollment_id
    WHERE t.assignment_id='${assignment}' AND e.student_id='${student}';`);
  // 실제 V2 발급·검증 함수로 의도를 만든다(서버 검증 결과는 고정 체크섬·ETag로 대신 기록).
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
      `SELECT verify_authorized_academic_upload_v2('${intent}','${owner}','${"b".repeat(64)}','etag-${intent}');`,
    );
    return intent;
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "hra-student-artifact-query-"));
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
        `-h '' -k ${root} -p 55497`,
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
      "55497",
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
      INSERT INTO users(id,role) VALUES('${memberA}','MEMBER'),('${memberB}','MEMBER'),('${manager}','FACULTY');`);
    run(readFileSync("scripts/sql/rate-limit-reservations.sql", "utf8"));
    // G1 순서대로 의존 SQL을 적용한 뒤 #516 SQL을 마지막에 적용한다.
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
    for (const [n, user] of [
      [1, memberA],
      [2, memberB],
    ] as const)
      run(`INSERT INTO academic_students(id,user_id,display_name) VALUES('${sid(n)}','${user}','시험 학생 ${n}');
        INSERT INTO cohort_enrollments(student_id,cohort_id) VALUES('${sid(n)}','${cohort}');`);
    for (const [id, format, text, slides] of [
      [bothFiles, "ARTIFACTS_V2", "'REQUIRED'", "'OPTIONAL'"],
      [optionalOnly, "ARTIFACTS_V2", "'OPTIONAL'", "'OPTIONAL'"],
      [legacy, "LEGACY_SINGLE_PDF", "NULL", "NULL"],
    ] as const) {
      run(`INSERT INTO assignments(id,cohort_id,title,instructions,due_at,created_by_user_id,submission_format,text_requirement,slides_requirement)
        VALUES('${id}','${cohort}','분리 제출 조회 ${id.slice(-1)}','안내',clock_timestamp()+interval '3 days','${manager}','${format}',${text},${slides});
        SELECT id FROM publish_academic_assignment('${id}','${manager}');`);
    }
    // A와 B가 각각 텍스트·발표자료 두 파일을 한 번에 최종 제출한다.
    for (const [owner, student, label] of [
      [memberA, sid(1), "A"],
      [memberB, sid(2), "B"],
    ] as const) {
      const target = targetOf(bothFiles, student);
      const text = upload(target, owner, "TEXT", "HWPX", `본문${label}.hwpx`, 3000);
      const slides = upload(target, owner, "SLIDES", "PPTX", `발표${label}.pptx`, 4000);
      run(
        `SELECT complete_academic_assignment_submission_v2('${target}','${owner}',ARRAY['${text}','${slides}']::uuid[],gen_random_uuid(),true);`,
      );
      for (const row of run(`SELECT f.artifact_type||':'||f.id FROM assignment_submission_files f JOIN assignment_submissions s ON s.id=f.submission_id
        WHERE s.assignment_target_id='${target}';`).split("\n")) {
        const [type, id] = row.split(":");
        fileIds[`${label}-${type}`] = id;
      }
    }
    mocks.query.mockImplementation(
      async (query: string, params: unknown[], options: { arrayMode: boolean }) => {
        if (!/^select /i.test(query))
          throw new Error("학생 조회 테스트에서는 SELECT만 허용합니다.");
        if (!options.arrayMode) {
          const result = run(
            `PREPARE academic_read AS SELECT COALESCE(json_agg(row_to_json(r)),'[]') FROM (${query}) r; EXECUTE academic_read(${params.map(literal).join(",")});`,
          );
          return { rows: JSON.parse(result) };
        }
        const output = execFileSync(program("psql"), [...args, "-tq", "--csv"], {
          input: `PREPARE academic_read AS ${query}; EXECUTE academic_read(${params.map(literal).join(",")});`,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
        });
        return { rows: parseCsv(output) };
      },
    );
  }, 60000);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("ACADEMIC_ENABLED", "true");
    vi.stubEnv("ACADEMIC_UPLOADS_ENABLED", "true");
    vi.stubEnv("ACADEMIC_SUBMISSION_ARTIFACTS_ENABLED", "true");
    session(memberA);
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

  it("V2 최종 제출의 텍스트·발표자료 두 파일을 모두 읽고 본인 파일만 반환한다", async () => {
    const detail = await getMyAssignment(bothFiles);
    expect(detail.file).toBeNull();
    expect(detail.submission?.submissionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(detail.artifacts).toEqual({
      textRequirement: "REQUIRED",
      slidesRequirement: "OPTIONAL",
      files: [
        {
          fileId: fileIds["A-SLIDES"],
          artifactType: "SLIDES",
          fileFormat: "PPTX",
          originalName: "발표A.pptx",
          mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          sizeBytes: 4000,
        },
        {
          fileId: fileIds["A-TEXT"],
          artifactType: "TEXT",
          fileFormat: "HWPX",
          originalName: "본문A.hwpx",
          mimeType: "application/hwp+zip",
          sizeBytes: 3000,
        },
      ].sort((a, b) => (a.artifactType === "TEXT" ? -1 : b.artifactType === "TEXT" ? 1 : 0)),
    });
    const json = JSON.stringify(detail);
    for (const hidden of [
      fileIds["B-TEXT"],
      fileIds["B-SLIDES"],
      "본문B",
      "academic-uploads",
      "checksum",
      "etag",
      "submissionKey",
    ])
      expect(json).not.toContain(hidden);
    session(memberB);
    expect(
      (await getMyAssignment(bothFiles)).artifacts?.files.map((file) => file.fileId).sort(),
    ).toEqual([fileIds["B-TEXT"], fileIds["B-SLIDES"]].sort());
  });

  it("미제출 V2 과제는 항목별 요구와 빈 파일 목록을 돌려준다", async () => {
    const detail = await getMyAssignment(optionalOnly);
    expect(detail.submission).toBeNull();
    expect(detail.artifacts).toEqual({
      textRequirement: "OPTIONAL",
      slidesRequirement: "OPTIONAL",
      files: [],
    });
  });

  it("기존 PDF 단일 제출 과제는 gate가 켜져 있어도 기존 응답 형태(artifacts 없음)를 유지한다", async () => {
    const detail = await getMyAssignment(legacy);
    expect("artifacts" in detail).toBe(false);
    expect(detail.file).toBeNull();
  });

  it("gate가 꺼져 있으면 새 컬럼을 읽지 않는 기존 조회만 실행하고 V2 제출은 정상 제출로 표시하지 않는다", async () => {
    vi.stubEnv("ACADEMIC_SUBMISSION_ARTIFACTS_ENABLED", "false");
    const pending = await getMyAssignment(optionalOnly);
    expect("artifacts" in pending).toBe(false);
    await expect(getMyAssignment(bothFiles)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    for (const [query] of mocks.query.mock.calls)
      expect(String(query)).not.toMatch(/submission_format|artifact_type/);
  });
});
