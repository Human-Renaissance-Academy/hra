// @vitest-environment node
/**
 * #516 PR-C 텍스트·발표자료 분리 제출 추가형 마이그레이션을 운영 접속 없는 격리 PostgreSQL에서 검증한다.
 *
 * - 기존 v1(PDF 단일) 자료가 있는 DB에 적용해도 행·xmin·체크섬이 바뀌지 않고 LEGACY 복구가 유지되는지 확인한다.
 * - 같은 SQL 재실행은 함수·제약 지문을 바꾸지 않으며, 부분·변형 구조는 전체 롤백으로 거부한다.
 * - V2 발급·검증·최종화의 필수/미사용/0개/대상 혼합/동시 최종화/멱등 키/용량 경계와 v1 진입점의 실패 폐쇄를 확인한다.
 */
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const bin = process.env.HRA_TEST_PG_BIN;
const user = "10000000-0000-4000-8000-000000000001";
const peer = "10000000-0000-4000-8000-000000000002";
const cohort = "20000000-0000-4000-8000-000000000001";
const student = "30000000-0000-4000-8000-000000000001";
const peerStudent = "30000000-0000-4000-8000-000000000002";
const legacyAssignment = "40000000-0000-4000-8000-000000000001";
const legacyKey = "60000000-0000-4000-8000-000000000001";
const checksum = "a".repeat(64);
const MiB = 1024 * 1024;
// 기존 G1 SQL을 v1 상태로 먼저 적용한다. 새 SQL은 반드시 이 뒤에 적용한다.
const v1Files = [
  "students",
  "assignments",
  "submissions",
  "upload-authorizations",
  "submission-finalization",
].map((name) => `scripts/migrate-academic-${name}.sql`);
const artifactsSql = readFileSync("scripts/migrate-academic-submission-artifacts.sql", "utf8");

describe.skipIf(!bin)("텍스트·발표자료 분리 제출 마이그레이션 PostgreSQL", () => {
  let root: string;
  let started = false;
  let args: string[];
  const program = (name: string) => join(bin!, name);
  const connect = (database: string) => [
    "-X",
    "-h",
    root,
    "-p",
    "55491",
    "-U",
    "hra_test",
    "-d",
    database,
    "-v",
    "ON_ERROR_STOP=1",
    "-v",
    "VERBOSITY=verbose",
    "-Atq",
  ];
  const runIn = (database: string, query: string) =>
    execFileSync(program("psql"), connect(database), {
      input: query,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  const run = (query: string) => runIn("postgres", query);
  // 기존 자료 지문: 새 컬럼을 제외한 원래 값과 xmin(행 재작성·UPDATE 여부)을 함께 고정한다.
  const fingerprint = () =>
    run(`SELECT md5(jsonb_build_array(
    (SELECT jsonb_agg(to_jsonb(x)-'submission_format'-'text_requirement'-'slides_requirement'||jsonb_build_object('xmin',x.xmin::text) ORDER BY id) FROM assignments x),
    (SELECT jsonb_agg(to_jsonb(x)-'artifact_type'-'file_format'||jsonb_build_object('xmin',x.xmin::text) ORDER BY id) FROM assignment_upload_intents x),
    (SELECT jsonb_agg(to_jsonb(x)-'submission_format'||jsonb_build_object('xmin',x.xmin::text) ORDER BY id) FROM assignment_submissions x),
    (SELECT jsonb_agg(to_jsonb(x)-'artifact_type'-'file_format'||jsonb_build_object('xmin',x.xmin::text) ORDER BY id) FROM assignment_submission_files x),
    (SELECT jsonb_agg(to_jsonb(x)-'artifact_type'-'file_format'||jsonb_build_object('xmin',x.xmin::text) ORDER BY intent_id) FROM academic_upload_authorizations x))::text);`);
  const catalog = () =>
    run(`SELECT md5(jsonb_build_array(
    (SELECT string_agg(pg_get_functiondef(p.oid),'' ORDER BY p.oid::regprocedure::text) FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prokind='f'),
    (SELECT jsonb_agg(jsonb_build_array(conrelid::regclass::text,conname,pg_get_constraintdef(oid)) ORDER BY conrelid::regclass::text,conname) FROM pg_constraint WHERE connamespace='public'::regnamespace),
    (SELECT jsonb_agg(pg_get_indexdef(indexrelid) ORDER BY indexrelid::regclass::text) FROM pg_index WHERE indrelid::regclass::text NOT LIKE 'pg_%'))::text);`);
  const targetOf = (assignment: string, enrolledStudent = student) =>
    run(`SELECT t.id FROM assignment_targets t
    JOIN cohort_enrollments e ON e.id=t.enrollment_id WHERE t.assignment_id='${assignment}' AND e.student_id='${enrolledStudent}';`);
  // DRAFT에서만 형식을 지정할 수 있으므로 초안 생성 → 공개 순서로 V2 과제를 만든다.
  const createV2 = (text: string, slides: string) => {
    const assignment = randomUUID();
    run(`INSERT INTO assignments(id,cohort_id,title,due_at,created_by_user_id,submission_format,text_requirement,slides_requirement)
      VALUES('${assignment}','${cohort}','분리 제출 과제',clock_timestamp()+interval '1 day','${user}','ARTIFACTS_V2','${text}','${slides}');
      SELECT id FROM publish_academic_assignment('${assignment}','${user}');`);
    return { assignment, target: targetOf(assignment) };
  };
  const issueV2 = (
    target: string,
    artifact: string,
    format: string,
    name: string,
    size = 2048,
    actor = user,
    request = randomUUID(),
  ) =>
    run(
      `SELECT issue_academic_assignment_upload_v2('${request}','${target}','${actor}','${artifact}','${format}','${name}',${size});`,
    );
  const verifyV2 = (intent: string, actor = user) =>
    run(
      `SELECT verify_authorized_academic_upload_v2('${intent}','${actor}','${checksum}','etag-${intent}');`,
    );
  const uploadV2 = (
    target: string,
    artifact: string,
    format: string,
    name: string,
    size = 2048,
  ) => {
    const intent = issueV2(target, artifact, format, name, size);
    verifyV2(intent);
    return intent;
  };
  const completeV2 = (
    target: string,
    intents: string[],
    key = randomUUID(),
    finalize = true,
    actor = user,
  ) =>
    run(
      `SELECT complete_academic_assignment_submission_v2('${target}','${actor}','{${intents.join(",")}}'::uuid[],'${key}',${finalize});`,
    );
  // 같은 클러스터의 별도 DB에 v1 상태를 만들어 구조 불일치 거부를 검사한다.
  const installV1 = (database: string) => {
    runIn(
      database,
      `CREATE TABLE users(id uuid PRIMARY KEY,role text NOT NULL DEFAULT 'MEMBER');CREATE TABLE cohorts(id uuid PRIMARY KEY);
      CREATE TABLE schedule_events(id uuid PRIMARY KEY,cohort_id uuid REFERENCES cohorts(id));
      CREATE TABLE schedule_sessions(id uuid PRIMARY KEY,schedule_event_id uuid REFERENCES schedule_events(id));`,
    );
    for (const file of v1Files) {
      const sql = readFileSync(file, "utf8");
      runIn(database, sql);
      runIn(database, sql);
    }
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "hra-artifacts516-"));
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
        `-h '' -k ${root} -p 55491`,
        "-w",
        "start",
      ],
      { stdio: "pipe" },
    );
    started = true;
    args = connect("postgres");
    installV1("postgres");
    // v1 자료: 최종 제출 1건과 검증만 끝난 다른 학생의 미소비 의도 1건을 기존 경로로 만든다.
    run(`INSERT INTO cohorts VALUES('${cohort}');INSERT INTO users(id) VALUES('${user}'),('${peer}');
      INSERT INTO academic_students(id,user_id,display_name) VALUES('${student}','${user}','시험 학생'),('${peerStudent}','${peer}','다른 학생');
      INSERT INTO cohort_enrollments(student_id,cohort_id) VALUES('${student}','${cohort}'),('${peerStudent}','${cohort}');
      INSERT INTO assignments(id,cohort_id,title,due_at,created_by_user_id)
        VALUES('${legacyAssignment}','${cohort}','기존 PDF 과제',clock_timestamp()+interval '1 day','${user}');
      SELECT id FROM publish_academic_assignment('${legacyAssignment}','${user}');`);
    const target = targetOf(legacyAssignment);
    const intent = run(
      `SELECT issue_academic_assignment_upload('${randomUUID()}','${target}','${user}','기존.pdf',4096);`,
    );
    run(`SELECT verify_authorized_academic_upload('${intent}','${user}','${checksum}','etag-legacy');
      SELECT complete_academic_assignment_submission('${target}','${user}','${intent}','${legacyKey}',true);`);
    const peerIntent = run(
      `SELECT issue_academic_assignment_upload('${randomUUID()}','${targetOf(legacyAssignment, peerStudent)}','${peer}','진행중.pdf',2048);`,
    );
    run(
      `SELECT verify_authorized_academic_upload('${peerIntent}','${peer}','${checksum}','etag-peer');`,
    );
  }, 60_000);
  afterAll(() => {
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

  it("기존 v1 자료가 있는 DB에 적용해도 행·xmin·체크섬을 바꾸지 않고 LEGACY 복구를 유지한다", () => {
    const before = fingerprint();
    const checksums = run(
      "SELECT string_agg(checksum,',' ORDER BY id) FROM assignment_submission_files;",
    );
    run(artifactsSql);
    run(artifactsSql);
    expect(fingerprint()).toBe(before);
    expect(
      run("SELECT string_agg(checksum,',' ORDER BY id) FROM assignment_submission_files;"),
    ).toBe(checksums);
    // 기존 행은 카탈로그 기본값으로만 LEGACY가 보이며 재분류하지 않는다.
    expect(
      run(`SELECT jsonb_build_array((SELECT array_agg(DISTINCT submission_format::text) FROM assignments),
      (SELECT array_agg(DISTINCT artifact_type::text||'/'||file_format::text) FROM assignment_upload_intents),
      (SELECT array_agg(DISTINCT submission_format::text) FROM assignment_submissions),
      (SELECT array_agg(DISTINCT artifact_type::text||'/'||file_format::text) FROM assignment_submission_files),
      (SELECT array_agg(DISTINCT artifact_type::text||'/'||file_format::text) FROM academic_upload_authorizations));`),
    ).toBe(
      '[["LEGACY_SINGLE_PDF"], ["LEGACY_PDF/PDF"], ["LEGACY_SINGLE_PDF"], ["LEGACY_PDF/PDF"], ["LEGACY_PDF/PDF"]]',
    );
    const target = targetOf(legacyAssignment);
    const intent = run(
      `SELECT upload_intent_id FROM assignment_submissions WHERE submission_key='${legacyKey}';`,
    );
    const replay = JSON.parse(
      run(
        `SELECT complete_academic_assignment_submission('${target}','${user}','${intent}','${legacyKey}',true);`,
      ),
    );
    expect(replay).toMatchObject({
      replayed: true,
      file: { mimeType: "application/pdf", sizeBytes: 4096 },
    });
    // 새 진입점은 PUBLIC 실행 권한이 없다.
    expect(
      run(`SELECT count(*) FROM pg_proc p, LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
      WHERE p.proname IN ('issue_academic_assignment_upload_v2','verify_authorized_academic_upload_v2','complete_academic_assignment_submission_v2')
        AND a.grantee=0 AND a.privilege_type='EXECUTE';`),
    ).toBe("0");
    expect(run("SELECT count(*) FROM pg_namespace WHERE nspname LIKE 'hra_artifacts%';")).toBe("0");
  });

  it("이미 적용된 구조의 재실행은 함수·제약·인덱스 지문을 바꾸지 않는다", () => {
    const before = catalog();
    const rows = fingerprint();
    run(artifactsSql);
    expect(catalog()).toBe(before);
    expect(fingerprint()).toBe(rows);
  });

  it("v2 구조의 추가 변형은 재실행에서 전체 롤백으로 거부한다", () => {
    run("ALTER TABLE assignment_submission_files ADD CONSTRAINT qa_drift CHECK (size_bytes>0);");
    try {
      expect(() => run(artifactsSql)).toThrow(/제출 산출물 제약 불일치/);
    } finally {
      run("ALTER TABLE assignment_submission_files DROP CONSTRAINT qa_drift;");
    }
    run(
      "DROP INDEX academic_upload_authorizations_active_artifact_idx;CREATE UNIQUE INDEX academic_upload_authorizations_active_artifact_idx ON academic_upload_authorizations(target_id) WHERE retired_at IS NULL;",
    );
    try {
      expect(() => run(artifactsSql)).toThrow(/제출 산출물 인덱스 불일치/);
    } finally {
      run(
        "DROP INDEX academic_upload_authorizations_active_artifact_idx;CREATE UNIQUE INDEX academic_upload_authorizations_active_artifact_idx ON academic_upload_authorizations(target_id,artifact_type) WHERE retired_at IS NULL;",
      );
    }
    run(artifactsSql);
  });

  it("v1 제약이 변형되었거나 일부만 적용된 구조는 아무것도 바꾸지 않고 거부한다", () => {
    run("CREATE DATABASE hra_artifacts_drift;");
    try {
      installV1("hra_artifacts_drift");
      const types =
        "SELECT count(*) FROM pg_type WHERE typname IN ('assignment_submission_format','assignment_artifact_requirement','assignment_artifact_type','assignment_file_format');";
      // 교체 대상 v1 CHECK가 원문과 다르면 자동 보정하지 않는다.
      runIn(
        "hra_artifacts_drift",
        `ALTER TABLE academic_upload_authorizations DROP CONSTRAINT academic_upload_authorizations_name_check,
        ADD CONSTRAINT academic_upload_authorizations_name_check CHECK (length(btrim(original_name))>0);`,
      );
      expect(() => runIn("hra_artifacts_drift", artifactsSql)).toThrow(
        /이전 구조 불일치: academic_upload_authorizations_name_check/,
      );
      expect(runIn("hra_artifacts_drift", types)).toBe("0");
      runIn(
        "hra_artifacts_drift",
        `ALTER TABLE academic_upload_authorizations DROP CONSTRAINT academic_upload_authorizations_name_check,
        ADD CONSTRAINT academic_upload_authorizations_name_check CHECK (length(btrim(original_name))>0 AND original_name !~ '[/\\\\[:cntrl:]]' AND lower(original_name) LIKE '%.pdf');`,
      );
      // 새 타입 하나만 먼저 있는 부분 구조는 v2 전체 대조에서 거부한다.
      runIn("hra_artifacts_drift", "CREATE TYPE assignment_file_format AS ENUM ('PDF');");
      expect(() => runIn("hra_artifacts_drift", artifactsSql)).toThrow(/제출 산출물 enum 불일치/);
      expect(runIn("hra_artifacts_drift", types)).toBe("1");
      runIn("hra_artifacts_drift", "DROP TYPE assignment_file_format;");
      runIn("hra_artifacts_drift", artifactsSql);
      expect(runIn("hra_artifacts_drift", types)).toBe("4");
    } finally {
      run("DROP DATABASE hra_artifacts_drift;");
    }
  }, 60_000);

  it("텍스트(HWPX)·발표자료(PPTX)를 한 번에 원자적으로 최종 제출하고 같은 묶음 재시도는 기존 결과를 반환한다", () => {
    const { assignment, target } = createV2("REQUIRED", "REQUIRED");
    const text = uploadV2(target, "TEXT", "HWPX", "보고서.hwpx");
    const slides = uploadV2(target, "SLIDES", "PPTX", "발표.pptx", 3072);
    expect(run(`SELECT storage_key FROM assignment_upload_intents WHERE id='${text}';`)).toBe(
      `academic-uploads/v2/${text}/original`,
    );
    const key = randomUUID();
    expect(completeV2(target, [text, slides], key, false)).toBe("");
    const result = JSON.parse(completeV2(target, [text, slides], key));
    expect(result).toMatchObject({
      assignmentId: assignment,
      replayed: false,
      files: [
        {
          artifactType: "TEXT",
          fileFormat: "HWPX",
          mimeType: "application/hwp+zip",
          sizeBytes: 2048,
          originalName: "보고서.hwpx",
        },
        {
          artifactType: "SLIDES",
          fileFormat: "PPTX",
          mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
          sizeBytes: 3072,
        },
      ],
    });
    for (const field of ["storageKey", "storage_key", "checksum", "userId", "submissionKey"])
      expect(JSON.stringify(result)).not.toContain(field);
    expect(
      run(
        `SELECT count(*) FROM assignment_upload_intents WHERE id IN ('${text}','${slides}') AND state='CONSUMED';`,
      ),
    ).toBe("2");
    // 순서가 달라도 같은 묶음이면 멱등 복구다. 다른 묶음은 같은 키로 받을 수 없다.
    expect(JSON.parse(completeV2(target, [slides, text], key))).toMatchObject({
      replayed: true,
      submissionId: result.submissionId,
    });
    expect(JSON.parse(completeV2(target, [text, slides], key, false))).toMatchObject({
      replayed: true,
    });
    expect(() => completeV2(target, [text], key)).toThrow(/SUB01: 다른 제출에 사용한 요청입니다/);
    expect(() => completeV2(target, [text, slides])).toThrow(/SUB01: 이미 최종 제출한 과제입니다/);
    expect(() => issueV2(target, "TEXT", "PDF", "추가.pdf")).toThrow(/upload_conflict/);
    // 공개 후에는 제출 형식·필수 여부를 바꿀 수 없다.
    expect(() =>
      run(`UPDATE assignments SET slides_requirement='OPTIONAL' WHERE id='${assignment}';`),
    ).toThrow(/공개 후 과제/);
  });

  it("필수 누락·미사용 항목·0개·같은 항목 중복을 거부한다", () => {
    const both = createV2("REQUIRED", "REQUIRED");
    const onlyText = uploadV2(both.target, "TEXT", "PDF", "텍스트.pdf");
    expect(() => completeV2(both.target, [onlyText])).toThrow(
      /SUB06: 과제가 요구하는 제출 항목과 일치하지 않습니다/,
    );
    // (대상, 유형)당 활성 의도는 하나뿐이다.
    expect(() => issueV2(both.target, "TEXT", "HWP", "다른.hwp")).toThrow(/upload_conflict/);
    expect(() => completeV2(both.target, [onlyText, onlyText])).toThrow(
      /SUB06: 같은 업로드를 두 번 제출할 수 없습니다/,
    );

    const textOnly = createV2("REQUIRED", "DISABLED");
    expect(() => issueV2(textOnly.target, "SLIDES", "PPTX", "발표.pptx")).toThrow(
      /upload_invalid_file/,
    );
    expect(() =>
      run(`INSERT INTO assignment_upload_intents(assignment_target_id,user_id,storage_key,expires_at,artifact_type,file_format)
      SELECT '${textOnly.target}','${user}','academic-uploads/v2/'||g||'/original',clock_timestamp()+interval '5 minutes','SLIDES','PPT'
      FROM gen_random_uuid() g;`),
    ).toThrow(/과제에서 받지 않는 제출 항목입니다/);

    const optional = createV2("OPTIONAL", "OPTIONAL");
    expect(() => completeV2(optional.target, [])).toThrow(
      /SUB06: 제출할 파일이 최소 1개 필요합니다/,
    );
    const slides = uploadV2(optional.target, "SLIDES", "PPT", "발표.ppt");
    expect(JSON.parse(completeV2(optional.target, [slides])).files).toHaveLength(1);

    expect(() => createV2("DISABLED", "DISABLED")).toThrow(
      /assignments_submission_artifacts_shape/,
    );
    expect(() =>
      run(
        `INSERT INTO assignments(cohort_id,title,created_by_user_id,submission_format) VALUES('${cohort}','형식만','${user}','ARTIFACTS_V2');`,
      ),
    ).toThrow(/assignments_submission_artifacts_shape/);
  });

  it("다른 대상·다른 계정의 의도를 섞거나 미검증 의도를 최종화하지 않는다", () => {
    const first = createV2("OPTIONAL", "OPTIONAL"),
      second = createV2("OPTIONAL", "OPTIONAL");
    const foreign = uploadV2(first.target, "TEXT", "PDF", "첫째.pdf");
    const own = uploadV2(second.target, "SLIDES", "PDF", "둘째.pdf");
    expect(() => completeV2(second.target, [own, foreign])).toThrow(
      /SUB02: 본인 업로드 의도를 찾을 수 없습니다/,
    );
    const peerTarget = targetOf(second.assignment, peerStudent);
    const peerIntent = issueV2(peerTarget, "TEXT", "PDF", "동료.pdf", 2048, peer);
    verifyV2(peerIntent, peer);
    expect(() => completeV2(second.target, [own, peerIntent])).toThrow(/SUB02/);
    const pending = issueV2(second.target, "TEXT", "PDF", "미검증.pdf");
    expect(() => completeV2(second.target, [own, pending])).toThrow(
      /SUB04: 서버 파일 검증이 필요합니다/,
    );
    expect(
      run(
        `SELECT count(*) FROM assignment_submissions WHERE assignment_target_id IN ('${first.target}','${second.target}');`,
      ),
    ).toBe("0");
    expect(
      run(
        `SELECT count(*) FROM assignment_upload_intents WHERE id IN ('${foreign}','${own}','${pending}') AND state='CONSUMED';`,
      ),
    ).toBe("0");
  });

  it("형식·확장자·파일별 50MiB를 발급에서 검사하고 두 파일 합계 100MiB 경계를 수용한다", () => {
    const { target } = createV2("REQUIRED", "OPTIONAL");
    expect(() => issueV2(target, "TEXT", "PPTX", "보고서.pptx")).toThrow(/upload_invalid_file/);
    expect(() => issueV2(target, "TEXT", "HWP", "보고서.hwpx")).toThrow(/upload_invalid_file/);
    expect(() => issueV2(target, "SLIDES", "PPT", "발표.pptx")).toThrow(/upload_invalid_file/);
    expect(() => issueV2(target, "TEXT", "PDF", "큰파일.pdf", 50 * MiB + 1)).toThrow(
      /upload_invalid_file/,
    );
    const text = uploadV2(target, "TEXT", "HWP", "보고서.hwp", 50 * MiB);
    const slides = uploadV2(target, "SLIDES", "PDF", "발표.pdf", 50 * MiB);
    const result = JSON.parse(completeV2(target, [text, slides]));
    expect(result.files.map((file: { sizeBytes: number }) => file.sizeBytes)).toEqual([
      50 * MiB,
      50 * MiB,
    ]);
    expect(
      run(
        `SELECT sum(size_bytes) FROM assignment_submission_files WHERE submission_id='${result.submissionId}';`,
      ),
    ).toBe(String(100 * MiB));
  });

  it("v1 진입점은 V2 과제에서, V2 진입점은 LEGACY 과제에서 실패로 닫힌다", () => {
    const { target } = createV2("OPTIONAL", "OPTIONAL");
    expect(() =>
      run(
        `SELECT issue_academic_assignment_upload('${randomUUID()}','${target}','${user}','과제.pdf',10);`,
      ),
    ).toThrow(/upload_conflict/);
    const v2Intent = uploadV2(target, "TEXT", "PDF", "텍스트.pdf");
    expect(() =>
      run(
        `SELECT verify_authorized_academic_upload('${v2Intent}','${user}','${checksum}','etag-v1');`,
      ),
    ).toThrow(/upload_conflict/);
    expect(() =>
      run(
        `SELECT complete_academic_assignment_submission('${target}','${user}','${v2Intent}','${randomUUID()}',true);`,
      ),
    ).toThrow(/SUB01: 텍스트·발표자료 제출 과제는 새 최종 제출 경로를 사용해야 합니다/);
    expect(() =>
      run(
        `SELECT finalize_academic_assignment_submission('${target}','${user}','${v2Intent}','${randomUUID()}');`,
      ),
    ).toThrow(/upload_conflict/);
    // 트리거도 LEGACY 형식 행을 V2 과제에 저장하지 못하게 한다.
    expect(() =>
      run(`INSERT INTO assignment_submissions(assignment_target_id,submitted_by_user_id,upload_intent_id,submission_key)
      VALUES('${target}','${user}','${v2Intent}','${randomUUID()}');`),
    ).toThrow(/과제의 제출 형식과 최종 제출 형식이 다릅니다/);
    expect(
      run(`SELECT count(*) FROM assignment_submissions WHERE assignment_target_id='${target}';`),
    ).toBe("0");

    const legacy = randomUUID();
    run(`INSERT INTO assignments(id,cohort_id,title,due_at,created_by_user_id)
      VALUES('${legacy}','${cohort}','새 PDF 과제',clock_timestamp()+interval '1 day','${user}');
      SELECT id FROM publish_academic_assignment('${legacy}','${user}');`);
    const legacyTarget = targetOf(legacy);
    expect(() => issueV2(legacyTarget, "TEXT", "PDF", "텍스트.pdf")).toThrow(/upload_conflict/);
    expect(() => completeV2(legacyTarget, [v2Intent])).toThrow(
      /SUB01: 기존 PDF 단일 제출 과제는 기존 최종 제출 경로를 사용해야 합니다/,
    );
    // 새 LEGACY 과제의 v1 흐름은 그대로 동작한다.
    const intent = run(
      `SELECT issue_academic_assignment_upload('${randomUUID()}','${legacyTarget}','${user}','새.pdf',100);`,
    );
    run(
      `SELECT verify_authorized_academic_upload('${intent}','${user}','${checksum}','etag-new');`,
    );
    expect(
      JSON.parse(
        run(
          `SELECT complete_academic_assignment_submission('${legacyTarget}','${user}','${intent}','${randomUUID()}',true);`,
        ),
      ),
    ).toMatchObject({ replayed: false, file: { mimeType: "application/pdf", sizeBytes: 100 } });
  });

  it("직접 INSERT로 파일 없는 V2 제출이나 미검증 파일을 커밋할 수 없다", () => {
    const { target } = createV2("OPTIONAL", "OPTIONAL");
    expect(() =>
      run(`INSERT INTO assignment_submissions(assignment_target_id,submitted_by_user_id,submission_key,submission_format)
      VALUES('${target}','${user}','${randomUUID()}','ARTIFACTS_V2');`),
    ).toThrow(/텍스트·발표자료 최종 제출의 파일/);
    expect(() =>
      run(`INSERT INTO assignment_submissions(assignment_target_id,submitted_by_user_id,upload_intent_id,submission_key,submission_format)
      VALUES('${target}','${user}','${randomUUID()}','${randomUUID()}','ARTIFACTS_V2');`),
    ).toThrow(/assignment_submissions_format_intent_shape|단일 업로드 의도/);
    expect(
      run(`SELECT count(*) FROM assignment_submissions WHERE assignment_target_id='${target}';`),
    ).toBe("0");
  });

  it("다른 키의 동시 최종화는 한 제출만 만들고 나머지는 SUB01로 거부한다", async () => {
    const { target } = createV2("REQUIRED", "OPTIONAL");
    const text = uploadV2(target, "TEXT", "HWPX", "보고서.hwpx");
    const first = spawn(program("psql"), args, { stdio: ["pipe", "pipe", "pipe"] });
    const second = spawn(program("psql"), args, { stdio: ["pipe", "pipe", "pipe"] });
    let secondError = "";
    second.stderr.on("data", (chunk) => {
      secondError += String(chunk);
    });
    const done = (child: typeof first) =>
      new Promise<number | null>((resolve, reject) => {
        child.on("close", resolve);
        child.on("error", reject);
      });
    const firstDone = done(first),
      secondDone = done(second);
    const waitFor = async (query: string) => {
      for (let n = 0; n < 150; n++) {
        if (run(query) === "1") return;
        await delay(20);
      }
      throw new Error("최종화 잠금 상태를 확인하지 못했습니다.");
    };
    const call = (key: string) =>
      `SELECT complete_academic_assignment_submission_v2('${target}','${user}','{${text}}'::uuid[],'${key}',true);`;
    try {
      first.stdin.write(`SET application_name='artifacts_first'; BEGIN; ${call(randomUUID())}\n`);
      await waitFor(
        "SELECT count(*) FROM pg_stat_activity WHERE application_name='artifacts_first' AND state='idle in transaction';",
      );
      second.stdin.end(`SET application_name='artifacts_second'; ${call(randomUUID())}`);
      await waitFor(
        "SELECT count(*) FROM pg_stat_activity WHERE application_name='artifacts_second' AND wait_event_type='Lock';",
      );
      first.stdin.end("COMMIT;\n");
      expect(await firstDone).toBe(0);
      expect(await secondDone).toBe(3);
      expect(secondError).toMatch(/SUB01: 이미 최종 제출한 과제입니다/);
      expect(
        run(`SELECT count(*) FROM assignment_submissions WHERE assignment_target_id='${target}';`),
      ).toBe("1");
      expect(
        run(
          `SELECT count(*) FROM assignment_submission_files f JOIN assignment_submissions s ON s.id=f.submission_id WHERE s.assignment_target_id='${target}';`,
        ),
      ).toBe("1");
    } finally {
      for (const child of [first, second]) {
        if (!child.stdin.writableEnded) child.stdin.end("ROLLBACK;\n");
        if (child.exitCode === null) child.kill();
      }
      await Promise.all([firstDone, secondDone]);
    }
  }, 20_000);
});
