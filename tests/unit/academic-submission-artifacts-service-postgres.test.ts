// @vitest-environment node
/**
 * #516 PR-D 텍스트·발표자료 분리 제출(V2) 서비스·리포지토리를 격리 PostgreSQL의 실제 범위 SQL 함수에 연결해 검증한다.
 *
 * - DB 호출(db.execute)만 격리 PostgreSQL로 바꾸고, 서비스가 만든 실제 SQL·매개변수·오류 SQLSTATE를 그대로 실행한다.
 * - 비공개 Blob은 메모리 저장소로 대신한다. 업로드는 토큰 승인 뒤 정규 MIME으로 저장한 것처럼 기록한다.
 * - 관리자 과제 생성(제출 형식 지정)·발급·토큰·검증·최종화·멱등 복구·동시성·기능 gate·v1/v2 경로 혼동을 확인한다.
 */
import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DOCUMENT_MIME_TYPES,
  type DocumentFormat,
} from "@/features/academics/assignment-uploads/formats/types";
import {
  PPTM_MAIN,
  buildZip,
  hwpxEntries,
  pptxEntries,
  syntheticHwp,
  syntheticPdf,
  syntheticPpt,
} from "../support/academic-document-fixtures";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  target: vi.fn(),
  head: vi.fn(),
  get: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: { execute: mocks.execute } }));
vi.mock("@vercel/blob", () => ({ head: mocks.head, get: mocks.get }));
vi.mock("@/lib/academic-permissions", () => ({
  requireAssignmentTarget: mocks.target,
  AcademicAccessError: class extends Error {},
}));
vi.mock("@/lib/academic-admin", () => ({
  requireAcademicApprover: async () => manager,
  getAcademicApproverId: () => manager,
  assertAcademicWritesEnabled: () => undefined,
}));
import { createAssignment, updateDraftAssignment } from "@/features/academics/assignments/service";
import {
  createAssignmentArtifactUploadIntent,
  verifyAssignmentArtifactUpload,
} from "@/features/academics/assignment-uploads/artifacts";
import { authorizeAssignmentUploadToken } from "@/features/academics/assignment-uploads/server";
import { finalizeAssignmentArtifactSubmission } from "@/features/academics/submissions/artifacts";
import { finalizeAssignmentSubmission } from "@/features/academics/submissions/service";
import { translateFinalizationError } from "@/features/academics/submissions/validation";

const bin = process.env.HRA_TEST_PG_BIN;
const execFileAsync = promisify(execFile);
const manager = "10000000-0000-4000-8000-0000000000aa";
const student = "10000000-0000-4000-8000-000000000001";
const cohort = "20000000-0000-4000-8000-000000000001";
const host = "qa516.private.blob.vercel-storage.com";
const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;
const encoder = new TextEncoder();

// 형식별 정상 합성 원본과 산출물 조합
const samples: Record<DocumentFormat, () => Uint8Array> = {
  PDF: () => syntheticPdf(),
  HWP: () => syntheticHwp().bytes,
  HWPX: () => buildZip(hwpxEntries()),
  PPT: () => syntheticPpt().bytes,
  PPTX: () => buildZip(pptxEntries()),
};
const extension: Record<DocumentFormat, string> = {
  PDF: "pdf",
  HWP: "hwp",
  HWPX: "hwpx",
  PPT: "ppt",
  PPTX: "pptx",
};

describe.skipIf(!bin)("텍스트·발표자료 분리 제출 V2 서비스 PostgreSQL", () => {
  let root: string;
  let started = false;
  let args: string[];
  const targets = new Map<string, string>();
  const blobs = new Map<string, { bytes: Uint8Array; contentType: string; etag: string }>();
  const program = (name: string) => join(bin!, name);
  const run = (query: string) =>
    execFileSync(program("psql"), args, {
      input: query,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

  /** 서비스 SQL을 PREPARE로 실행하고, 실패하면 PostgreSQL SQLSTATE·고정 메시지만 가진 오류로 바꾼다. */
  async function execute(statement: SQL) {
    const query = new PgDialect().sqlToQuery(statement);
    const parameters = query.params.map((value) =>
      value === null
        ? "NULL"
        : typeof value === "number" || typeof value === "boolean"
          ? String(value)
          : quote(String(value)),
    );
    const text = `PREPARE service_query AS SELECT row_to_json(q) FROM (${query.sql}) q;
      EXECUTE service_query${parameters.length ? `(${parameters.join(",")})` : ""};`;
    try {
      const { stdout } = await execFileAsync(
        program("psql"),
        [...args, "-v", "VERBOSITY=verbose", "-c", text],
        { encoding: "utf8" },
      );
      const output = stdout.trim();
      return { rows: output ? output.split("\n").map((line) => JSON.parse(line)) : [] };
    } catch (error) {
      const stderr =
        typeof error === "object" && error !== null && "stderr" in error
          ? String(error.stderr)
          : "";
      const match = /ERROR:\s+([0-9A-Z]{5}): (.*)/.exec(stderr);
      if (!match) throw error;
      throw Object.assign(new Error(match[2]), { code: match[1], message: match[2] });
    }
  }

  // 관리 서비스로 DRAFT를 만든 뒤 공개해 학생 대상을 만든다.
  async function publishedAssignment(policy?: {
    submissionFormat: string;
    textRequirement: string | null;
    slidesRequirement: string | null;
  }) {
    const created = await createAssignment({
      requestId: randomUUID(),
      cohortId: cohort,
      title: "분리 제출 서비스 시험",
      dueAtKst: "2099-12-31T23:00",
      ...(policy ?? {}),
    });
    run(`SELECT id FROM publish_academic_assignment('${created.assignment.id}','${manager}');`);
    targets.set(
      created.assignment.id,
      run(`SELECT id FROM assignment_targets WHERE assignment_id='${created.assignment.id}';`),
    );
    return created.assignment.id;
  }
  const v2 = (text: string, slides: string) =>
    publishedAssignment({
      submissionFormat: "ARTIFACTS_V2",
      textRequirement: text,
      slidesRequirement: slides,
    });

  /** 의도 발급 → SDK 토큰 승인(정규 MIME) → 비공개 저장소 기록. 저장 내용·MIME은 시험이 바꿀 수 있다. */
  async function upload(
    assignmentId: string,
    artifactType: "TEXT" | "SLIDES",
    fileFormat: DocumentFormat,
    bytes = samples[fileFormat](),
    stored: { bytes?: Uint8Array; contentType?: string } = {},
  ) {
    const intent = await createAssignmentArtifactUploadIntent({
      assignmentId,
      requestId: randomUUID(),
      artifactType,
      fileFormat,
      originalName: `합성 ${artifactType}.${extension[fileFormat]}`,
      sizeBytes: bytes.length,
      mimeType: DOCUMENT_MIME_TYPES[fileFormat],
    });
    expect(intent.pathname).toBe(`academic-uploads/v2/${intent.uploadIntentId}/original`);
    expect(intent.contentType).toBe(DOCUMENT_MIME_TYPES[fileFormat]);
    const token = await authorizeAssignmentUploadToken(
      { assignmentId, uploadIntentId: intent.uploadIntentId },
      intent.pathname,
      false,
    );
    expect(token.allowedContentTypes).toEqual([DOCUMENT_MIME_TYPES[fileFormat]]);
    expect(token.maximumSizeInBytes).toBe(bytes.length);
    blobs.set(intent.pathname, {
      bytes: stored.bytes ?? bytes,
      contentType: stored.contentType ?? intent.contentType,
      etag: `etag-${intent.uploadIntentId}`,
    });
    return intent.uploadIntentId;
  }
  const finalize = (
    assignmentId: string,
    uploadIntentIds: string[],
    submissionKey = randomUUID(),
  ) => finalizeAssignmentArtifactSubmission({ assignmentId, uploadIntentIds, submissionKey });
  const counts = () =>
    run(`SELECT (SELECT count(*) FROM assignment_submissions)||','||(SELECT count(*) FROM assignment_submission_files)
    ||','||(SELECT count(*) FROM assignment_upload_intents WHERE state='CONSUMED');`);

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "hra-artifacts-service-"));
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
        `-h '' -k ${root} -p 55493`,
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
      "55493",
      "-U",
      "hra_test",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-Atq",
    ];
    run(`CREATE TABLE users(id uuid PRIMARY KEY,role text NOT NULL DEFAULT 'MEMBER');
      CREATE TABLE cohorts(id uuid PRIMARY KEY);
      CREATE TABLE schedule_events(id uuid PRIMARY KEY,cohort_id uuid REFERENCES cohorts(id));
      CREATE TABLE schedule_sessions(id uuid PRIMARY KEY,schedule_event_id uuid REFERENCES schedule_events(id));
      CREATE TABLE application_submissions(id uuid PRIMARY KEY);
      INSERT INTO cohorts VALUES('${cohort}'); INSERT INTO users(id,role) VALUES('${student}','MEMBER'),('${manager}','FACULTY');`);
    run(readFileSync("scripts/sql/rate-limit-reservations.sql", "utf8"));
    // G1 순서대로 새 SQL이 의존하는 원문을 적용한 뒤 #516 SQL을 마지막에 적용한다.
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
    run(`INSERT INTO academic_students(id,user_id,display_name) VALUES('30000000-0000-4000-8000-000000000001','${student}','시험학생');
      INSERT INTO cohort_enrollments(student_id,cohort_id) VALUES('30000000-0000-4000-8000-000000000001','${cohort}');`);
  }, 60000);
  beforeEach(() => {
    vi.spyOn(console, "info").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    for (const [name, value] of [
      ["ACADEMIC_ENABLED", "true"],
      ["ACADEMIC_UPLOADS_ENABLED", "true"],
      ["ACADEMIC_SUBMISSION_ARTIFACTS_ENABLED", "true"],
      ["ACADEMIC_ENROLLMENT_WRITES_ENABLED", "true"],
      ["ACADEMIC_SUBMISSION_BLOB_HOST", host],
      ["ACADEMIC_SUBMISSION_READ_WRITE_TOKEN", "vercel_blob_rw_qa516_fixture"],
    ]) {
      vi.stubEnv(name, value);
    }
    // 시험 사이 업로드 예산을 초기화해 각 시나리오가 독립된 60초 창을 사용한다.
    run("TRUNCATE rate_limit_events;");
    mocks.execute.mockReset().mockImplementation(execute);
    mocks.target
      .mockReset()
      .mockImplementation(async ({ assignmentId }: { assignmentId: string }) => {
        const targetId = targets.get(assignmentId);
        if (!targetId) throw new Error("시험 대상 없음");
        return {
          userId: student,
          targetId,
          assignmentId,
          status: "PUBLISHED",
          dueAt: new Date(Date.now() + 3_600_000),
        };
      });
    mocks.head.mockReset().mockImplementation(async (pathname: string) => {
      const blob = blobs.get(pathname);
      if (!blob) throw new Error("없는 객체");
      return {
        url: `https://${host}/${pathname}`,
        pathname,
        size: blob.bytes.length,
        contentType: blob.contentType,
        etag: blob.etag,
      };
    });
    mocks.get.mockReset().mockImplementation(async (pathname: string) => {
      const blob = blobs.get(pathname);
      if (!blob) return null;
      return {
        statusCode: 200,
        blob: {
          url: `https://${host}/${pathname}`,
          pathname,
          size: blob.bytes.length,
          contentType: blob.contentType,
          etag: blob.etag,
        },
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            // 실제 공급자처럼 여러 조각으로 나누어 전달한다.
            for (let offset = 0; offset < blob.bytes.length; offset += 700)
              controller.enqueue(blob.bytes.subarray(offset, offset + 700));
            controller.close();
          },
        }),
      };
    });
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

  describe("과제 생성·초안 수정의 제출 형식", () => {
    it("기능 gate가 켜지면 V2 초안을 만들고, 키 없는 수정은 형식을 유지하며 LEGACY로 되돌릴 수 있다", async () => {
      const created = await createAssignment({
        requestId: randomUUID(),
        cohortId: cohort,
        title: "V2 초안",
        submissionFormat: "ARTIFACTS_V2",
        textRequirement: "REQUIRED",
        slidesRequirement: "OPTIONAL",
      });
      expect(created.assignment).toMatchObject({
        status: "DRAFT",
        submissionFormat: "ARTIFACTS_V2",
        textRequirement: "REQUIRED",
        slidesRequirement: "OPTIONAL",
      });
      const kept = await updateDraftAssignment({
        requestId: randomUUID(),
        assignmentId: created.assignment.id,
        cohortId: cohort,
        title: "제목만 수정",
        expectedUpdatedAt: created.assignment.updatedAt,
      });
      expect(kept.assignment).toMatchObject({
        title: "제목만 수정",
        submissionFormat: "ARTIFACTS_V2",
        textRequirement: "REQUIRED",
      });
      const reverted = await updateDraftAssignment({
        requestId: randomUUID(),
        assignmentId: created.assignment.id,
        cohortId: cohort,
        title: "다시 PDF",
        expectedUpdatedAt: kept.assignment.updatedAt,
        submissionFormat: "LEGACY_SINGLE_PDF",
        textRequirement: null,
        slidesRequirement: null,
      });
      expect(reverted.assignment).toMatchObject({
        submissionFormat: "LEGACY_SINGLE_PDF",
        textRequirement: null,
        slidesRequirement: null,
      });
    });

    it("기존 payload(형식 키 없음)는 LEGACY로 만든다", async () => {
      const created = await createAssignment({
        requestId: randomUUID(),
        cohortId: cohort,
        title: "기존 과제",
      });
      expect(created.assignment).toMatchObject({
        submissionFormat: "LEGACY_SINGLE_PDF",
        textRequirement: null,
        slidesRequirement: null,
      });
    });

    it("두 항목 모두 미사용·LEGACY 요구 지정·일부 키만 보낸 요청은 저장 전에 거부한다", async () => {
      for (const policy of [
        {
          submissionFormat: "ARTIFACTS_V2",
          textRequirement: "DISABLED",
          slidesRequirement: "DISABLED",
        },
        {
          submissionFormat: "LEGACY_SINGLE_PDF",
          textRequirement: "REQUIRED",
          slidesRequirement: null,
        },
        { submissionFormat: "ARTIFACTS_V2", textRequirement: "REQUIRED" },
        { textRequirement: "REQUIRED" },
      ]) {
        await expect(
          createAssignment({
            requestId: randomUUID(),
            cohortId: cohort,
            title: "잘못된 형식",
            ...policy,
          }),
        ).rejects.toThrow(
          "제출 형식과 텍스트·발표자료 요구를 확인해 주세요. 두 항목을 모두 미사용으로 둘 수 없습니다.",
        );
      }
    });

    it("SQL 함수도 모순된 형식·일부 키 payload를 HRA07 고정 문구로 거부한다", () => {
      const payload = JSON.stringify({
        cohortId: cohort,
        scheduleEventId: null,
        scheduleSessionId: null,
        title: "직접 호출",
        instructions: "",
        dueAt: null,
        submissionFormat: "ARTIFACTS_V2",
        textRequirement: "DISABLED",
        slidesRequirement: "DISABLED",
      });
      expect(() =>
        run(
          `SELECT mutate_academic_assignment('CREATE','${manager}','${manager}','${randomUUID()}','${randomUUID()}',${quote(payload)}::jsonb);`,
        ),
      ).toThrow("과제 제출 형식과 텍스트·발표자료 요구를 확인해 주세요.");
      const partial = JSON.stringify({
        cohortId: cohort,
        scheduleEventId: null,
        scheduleSessionId: null,
        title: "일부 키",
        instructions: "",
        dueAt: null,
        submissionFormat: "ARTIFACTS_V2",
      });
      expect(() =>
        run(
          `SELECT mutate_academic_assignment('CREATE','${manager}','${manager}','${randomUUID()}','${randomUUID()}',${quote(partial)}::jsonb);`,
        ),
      ).toThrow("과제 입력 필드가 올바르지 않습니다.");
    });

    it("공개된 과제의 제출 형식은 바꿀 수 없다(DRAFT만 전환)", async () => {
      const assignmentId = await v2("REQUIRED", "REQUIRED");
      const updatedAt = run(
        `SELECT to_json(updated_at) FROM assignments WHERE id='${assignmentId}';`,
      ).replaceAll('"', "");
      await expect(
        updateDraftAssignment({
          requestId: randomUUID(),
          assignmentId,
          cohortId: cohort,
          title: "공개 후 변경",
          expectedUpdatedAt: updatedAt,
          submissionFormat: "ARTIFACTS_V2",
          textRequirement: "OPTIONAL",
          slidesRequirement: "OPTIONAL",
        }),
      ).rejects.toThrow("공개된 과제는 수정할 수 없습니다.");
      expect(
        run(
          `SELECT text_requirement||','||slides_requirement FROM assignments WHERE id='${assignmentId}';`,
        ),
      ).toBe("REQUIRED,REQUIRED");
    });

    it("기능 gate가 꺼지면 제출 형식 지정을 받지 않는다", async () => {
      vi.stubEnv("ACADEMIC_SUBMISSION_ARTIFACTS_ENABLED", "false");
      await expect(
        createAssignment({
          requestId: randomUUID(),
          cohortId: cohort,
          title: "비활성",
          submissionFormat: "ARTIFACTS_V2",
          textRequirement: "REQUIRED",
          slidesRequirement: "OPTIONAL",
        }),
      ).rejects.toThrow("텍스트·발표자료 분리 제출은 아직 사용할 수 없습니다.");
    });
  });

  describe("정상 제출", () => {
    it.each([
      ["텍스트만(HWP)", "REQUIRED", "OPTIONAL", [["TEXT", "HWP"]]],
      ["텍스트만(HWPX)", "REQUIRED", "DISABLED", [["TEXT", "HWPX"]]],
      ["발표자료만(PPTX)", "DISABLED", "REQUIRED", [["SLIDES", "PPTX"]]],
      ["발표자료만(PPT)", "OPTIONAL", "REQUIRED", [["SLIDES", "PPT"]]],
      [
        "두 항목(PDF·PPTX)",
        "REQUIRED",
        "REQUIRED",
        [
          ["TEXT", "PDF"],
          ["SLIDES", "PPTX"],
        ],
      ],
      ["둘 다 선택에서 발표자료 PDF만", "OPTIONAL", "OPTIONAL", [["SLIDES", "PDF"]]],
    ] as const)(
      "%s를 검증·원자 확정하고 같은 키로 복구한다",
      async (_name, text, slides, files) => {
        const assignmentId = await v2(text, slides);
        const intents: string[] = [];
        for (const [artifact, format] of files)
          intents.push(await upload(assignmentId, artifact, format));
        const key = randomUUID();
        const result = await finalize(assignmentId, intents, key);
        expect(result).toMatchObject({ assignmentId, replayed: false });
        expect(result.files.map((file) => [file.artifactType, file.fileFormat, file.mimeType]))
          // DB enum 선언 순서(TEXT → SLIDES)로 고정된다.
          .toEqual(
            [...files]
              .sort((a, b) => (a[0] === "TEXT" ? 0 : 1) - (b[0] === "TEXT" ? 0 : 1))
              .map(([artifact, format]) => [artifact, format, DOCUMENT_MIME_TYPES[format]]),
          );
        const text_ = JSON.stringify(result);
        for (const field of ["storageKey", "storage_key", "checksum", "userId", "academic-uploads"])
          expect(text_).not.toContain(field);
        // 저장 행: V2 제출은 단일 의도를 참조하지 않고(NULL), 파일은 서버가 계산한 SHA-256·정규 MIME으로 기록된다.
        expect(
          run(
            `SELECT submission_format||','||(upload_intent_id IS NULL) FROM assignment_submissions WHERE id='${result.submissionId}';`,
          ),
        ).toBe("ARTIFACTS_V2,true");
        expect(
          run(
            `SELECT bool_and(checksum ~ '^[0-9a-f]{64}$' AND storage_key LIKE 'academic-uploads/v2/%/original') FROM assignment_submission_files WHERE submission_id='${result.submissionId}';`,
          ),
        ).toBe("t");
        // 같은 키·같은 묶음(순서 무관)은 Blob을 다시 읽지 않고 같은 결과를 돌려준다.
        mocks.get.mockClear();
        const replay = await finalize(assignmentId, [...intents].reverse(), key);
        expect(replay).toMatchObject({
          submissionId: result.submissionId,
          submittedAt: result.submittedAt,
          replayed: true,
        });
        expect(mocks.get).not.toHaveBeenCalled();
      },
    );
  });

  describe("구성·경로 오류", () => {
    it("필수 항목 누락은 SUB06 안내로 거부하고 아무것도 확정하지 않는다", async () => {
      const assignmentId = await v2("REQUIRED", "REQUIRED");
      const before = counts();
      const intent = await upload(assignmentId, "TEXT", "HWP");
      await expect(finalize(assignmentId, [intent])).rejects.toMatchObject({
        code: "INCOMPLETE",
        status: 422,
        message:
          "과제가 요구하는 제출 항목과 맞지 않습니다. 필수 항목을 모두 올리고, 받지 않는 항목은 빼 주세요. 항목마다 파일은 1개만 제출할 수 있습니다.",
      });
      expect(counts()).toBe(before);
      expect(run(`SELECT state FROM assignment_upload_intents WHERE id='${intent}';`)).toBe(
        "VERIFIED",
      );
    });

    it("0개·같은 의도 중복은 Blob을 읽기 전에 거부한다", async () => {
      const assignmentId = await v2("OPTIONAL", "OPTIONAL");
      const intent = await upload(assignmentId, "TEXT", "PDF");
      mocks.get.mockClear();
      await expect(finalize(assignmentId, [])).rejects.toMatchObject({ code: "INCOMPLETE" });
      await expect(finalize(assignmentId, [intent, intent])).rejects.toMatchObject({
        code: "INCOMPLETE",
      });
      expect(mocks.get).not.toHaveBeenCalled();
    });

    it("미사용 항목은 발급 단계에서 거부한다", async () => {
      const assignmentId = await v2("REQUIRED", "DISABLED");
      await expect(upload(assignmentId, "SLIDES", "PPTX")).rejects.toMatchObject({
        code: "INVALID_FILE",
        status: 422,
        reason: "ARTIFACT_DISABLED",
        message: "이 과제는 해당 제출 항목을 받지 않습니다.",
      });
    });

    it("v1 최종화는 V2 과제, V2 최종화는 기존 PDF 과제에서 다른 제출 방식 안내로 거부한다", async () => {
      const assignmentId = await v2("REQUIRED", "OPTIONAL");
      await expect(
        finalizeAssignmentSubmission({
          assignmentId,
          uploadIntentId: randomUUID(),
          submissionKey: randomUUID(),
        }),
      ).rejects.toMatchObject({
        code: "WRONG_FORMAT",
        status: 409,
        message:
          "이 과제는 다른 제출 방식을 사용합니다. 과제 화면을 새로 고친 뒤 다시 제출해 주세요.",
      });
      const legacy = await publishedAssignment();
      await expect(finalize(legacy, [randomUUID()])).rejects.toMatchObject({
        code: "WRONG_FORMAT",
        status: 409,
      });
      // V2 발급 함수도 기존 PDF 과제에는 의도를 만들지 않는다.
      await expect(upload(legacy, "TEXT", "PDF")).rejects.toMatchObject({ code: "CONFLICT" });
    });

    it("같은 멱등 키를 다른 묶음에 쓰면 충돌이며 첫 제출은 그대로다", async () => {
      const assignmentId = await v2("OPTIONAL", "OPTIONAL");
      const first = await upload(assignmentId, "TEXT", "PDF");
      const key = randomUUID();
      const result = await finalize(assignmentId, [first], key);
      await expect(finalize(assignmentId, [first, randomUUID()], key)).rejects.toMatchObject({
        code: "CONFLICT",
        status: 409,
      });
      await expect(finalize(assignmentId, [first], randomUUID())).rejects.toMatchObject({
        code: "CONFLICT",
      });
      expect(
        run(
          `SELECT count(*) FROM assignment_submission_files WHERE submission_id='${result.submissionId}';`,
        ),
      ).toBe("1");
    });

    it("23505(같은 키·다른 대상 동시 사용)는 v1·V2 모두 충돌로 대응한다", () => {
      expect(
        translateFinalizationError({
          cause: { code: "23505", message: "duplicate key value violates unique constraint" },
        }),
      ).toMatchObject({ code: "CONFLICT", status: 409 });
      expect(
        translateFinalizationError({
          code: "SUB07",
          message: "제출 파일 합계 용량을 초과했습니다.",
        }),
      ).toMatchObject({
        code: "TOO_LARGE",
        status: 422,
        message: "제출 파일의 합계 용량은 100MiB 이하여야 합니다.",
      });
      // 형식 경로 문구가 아닌 SUB01은 기존 충돌로 남는다.
      expect(
        translateFinalizationError({ code: "SUB01", message: "이미 최종 제출한 과제입니다." }),
      ).toMatchObject({ code: "CONFLICT" });
    });
  });

  describe("서버 파일 검증", () => {
    const hwpEncrypted = () => syntheticHwp({ properties: 0x3 }).bytes;
    const pdfEncrypted = () =>
      encoder.encode(
        "%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R /Encrypt 2 0 R >>\n%%EOF\n",
      );
    it.each([
      [
        "PDF를 HWP로 위장",
        "TEXT",
        "HWP",
        () => syntheticPdf(),
        "FORMAT_MISMATCH",
        "파일 내용이 확장자와 다른 형식입니다. 실제 형식에 맞게 저장해 올려 주세요.",
      ],
      [
        "매크로 포함 PPTX(PPTM)",
        "SLIDES",
        "PPTX",
        () => buildZip(pptxEntries(PPTM_MAIN)),
        "MACRO",
        "매크로·VBA가 포함된 발표자료는 제출할 수 없습니다. 매크로를 제거하거나 PDF로 저장해 올려 주세요.",
      ],
      [
        "암호 설정 HWP",
        "TEXT",
        "HWP",
        hwpEncrypted,
        "ENCRYPTED",
        "암호가 설정된 문서는 제출할 수 없습니다. 암호를 해제한 뒤 다시 올려 주세요.",
      ],
      [
        "암호화 PDF",
        "SLIDES",
        "PDF",
        pdfEncrypted,
        "ENCRYPTED",
        "암호가 설정된 문서는 제출할 수 없습니다. 암호를 해제한 뒤 다시 올려 주세요.",
      ],
      [
        "알 수 없는 내용",
        "TEXT",
        "HWPX",
        () => encoder.encode("plain text, not a document"),
        "UNKNOWN_FORMAT",
        "지원하지 않는 파일 형식입니다. 텍스트는 HWP·HWPX·PDF, 발표자료는 PPT·PPTX·PDF로 제출해 주세요.",
      ],
    ] as const)(
      "%s는 검증에서 거부하고 의도를 검증 완료로 만들지 않는다",
      async (_name, artifact, format, make, reason, message) => {
        const assignmentId = await v2("OPTIONAL", "OPTIONAL");
        const intent = await upload(assignmentId, artifact, format, make());
        await expect(
          verifyAssignmentArtifactUpload({ assignmentId, uploadIntentId: intent }),
        ).rejects.toMatchObject({ code: "INVALID_FILE", status: 422, reason, message });
        expect(run(`SELECT state FROM assignment_upload_intents WHERE id='${intent}';`)).toBe(
          "INTENDED",
        );
        const before = counts();
        await expect(finalize(assignmentId, [intent])).rejects.toMatchObject({
          code: "INVALID_FILE",
          reason,
        });
        expect(counts()).toBe(before);
      },
    );

    it("검증 뒤 저장 객체가 바뀌면(ETag·내용) 최종화가 충돌·파일 오류로 거부하고 아무것도 확정하지 않는다", async () => {
      const assignmentId = await v2("OPTIONAL", "OPTIONAL");
      const intent = await upload(assignmentId, "TEXT", "PDF");
      await verifyAssignmentArtifactUpload({ assignmentId, uploadIntentId: intent });
      expect(run(`SELECT state FROM assignment_upload_intents WHERE id='${intent}';`)).toBe(
        "VERIFIED",
      );
      const key = `academic-uploads/v2/${intent}/original`;
      const original = blobs.get(key)!;
      const before = counts();
      // 1) 같은 크기의 다른 정상 PDF로 덮어쓴 경우: 기록된 ETag·체크섬과 달라 충돌이다.
      const replaced = new Uint8Array(original.bytes);
      replaced[12] = replaced[12] === 0x41 ? 0x42 : 0x41;
      blobs.set(key, { ...original, bytes: replaced, etag: `${original.etag}-replaced` });
      await expect(finalize(assignmentId, [intent])).rejects.toMatchObject({ code: "CONFLICT" });
      expect(counts()).toBe(before);
      // 2) 같은 크기의 형식 위반 내용으로 바뀐 경우: 형식 검증에서 먼저 거부한다.
      blobs.set(key, {
        ...original,
        bytes: new Uint8Array(original.bytes.length).fill(0x20),
        etag: `${original.etag}-broken`,
      });
      await expect(finalize(assignmentId, [intent])).rejects.toMatchObject({
        code: "INVALID_FILE",
      });
      expect(counts()).toBe(before);
      expect(run(`SELECT state FROM assignment_upload_intents WHERE id='${intent}';`)).toBe(
        "VERIFIED",
      );
    });

    it("다른 과제 대상의 의도는 서비스 계층에서 거부하고 Blob을 읽지 않는다", async () => {
      const first = await v2("OPTIONAL", "OPTIONAL");
      const second = await v2("OPTIONAL", "OPTIONAL");
      const intent = await upload(first, "TEXT", "PDF");
      const before = counts();
      mocks.head.mockClear();
      mocks.get.mockClear();
      await expect(
        verifyAssignmentArtifactUpload({ assignmentId: second, uploadIntentId: intent }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(finalize(second, [intent])).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(mocks.head).not.toHaveBeenCalled();
      expect(mocks.get).not.toHaveBeenCalled();
      expect(counts()).toBe(before);
      expect(run(`SELECT state FROM assignment_upload_intents WHERE id='${intent}';`)).toBe(
        "INTENDED",
      );
    });

    it("두 파일 중 하나라도 실패하면 아무것도 확정하지 않는다", async () => {
      const assignmentId = await v2("REQUIRED", "REQUIRED");
      const text = await upload(assignmentId, "TEXT", "HWPX");
      const slides = await upload(assignmentId, "SLIDES", "PPTX", buildZip(pptxEntries(PPTM_MAIN)));
      const before = counts();
      await expect(finalize(assignmentId, [text, slides])).rejects.toMatchObject({
        code: "INVALID_FILE",
        reason: "MACRO",
      });
      expect(counts()).toBe(before);
    });

    it("저장 Content-Type·크기가 원장과 다르면 내용을 판정하기 전에 거부한다", async () => {
      const assignmentId = await v2("OPTIONAL", "OPTIONAL");
      const wrongMime = await upload(assignmentId, "TEXT", "HWP", undefined, {
        contentType: "application/pdf",
      });
      await expect(
        verifyAssignmentArtifactUpload({ assignmentId, uploadIntentId: wrongMime }),
      ).rejects.toMatchObject({ code: "INVALID_FILE", reason: "SELECTION" });
      const bytes = samples.PPTX();
      const grown = await upload(assignmentId, "SLIDES", "PPTX", bytes, {
        bytes: new Uint8Array([...bytes, 0]),
      });
      await expect(
        verifyAssignmentArtifactUpload({ assignmentId, uploadIntentId: grown }),
      ).rejects.toMatchObject({ code: "INVALID_FILE", reason: "SELECTION" });
    });

    it("50MiB 초과·확장자/형식/MIME 불일치 선언은 의도를 발급하지 않는다", async () => {
      const assignmentId = await v2("OPTIONAL", "OPTIONAL");
      const base = {
        assignmentId,
        requestId: randomUUID(),
        artifactType: "TEXT",
        fileFormat: "HWP",
        originalName: "과제.hwp",
        sizeBytes: 1024,
        mimeType: DOCUMENT_MIME_TYPES.HWP,
      };
      for (const change of [
        { sizeBytes: 52_428_801 },
        { sizeBytes: 0 },
        { originalName: "과제.pdf" },
        { fileFormat: "PPTX", originalName: "과제.pptx", mimeType: DOCUMENT_MIME_TYPES.PPTX },
        { mimeType: "application/pdf" },
        { originalName: "../과제.hwp" },
      ]) {
        await expect(
          createAssignmentArtifactUploadIntent({ ...base, ...change }),
        ).rejects.toMatchObject({ code: "INVALID_FILE", reason: "SELECTION" });
      }
      expect(
        run(
          `SELECT count(*) FROM academic_upload_authorizations a JOIN assignment_targets t ON t.id=a.target_id WHERE t.assignment_id='${assignmentId}';`,
        ),
      ).toBe("0");
      // 정확히 50MiB 선언은 발급한다(저장 검증은 실제 크기로 다시 확인).
      await expect(
        createAssignmentArtifactUploadIntent({
          ...base,
          requestId: randomUUID(),
          sizeBytes: 52_428_800,
        }),
      ).resolves.toMatchObject({ fileFormat: "HWP" });
    });

    it("같은 요청 ID 재시도는 같은 의도를 돌려주고, 같은 유형의 다른 활성 의도는 거부한다", async () => {
      const assignmentId = await v2("OPTIONAL", "OPTIONAL");
      const request = {
        assignmentId,
        requestId: randomUUID(),
        artifactType: "TEXT",
        fileFormat: "PDF",
        originalName: "과제.pdf",
        sizeBytes: 100,
        mimeType: "application/pdf",
      };
      const first = await createAssignmentArtifactUploadIntent(request);
      expect((await createAssignmentArtifactUploadIntent(request)).uploadIntentId).toBe(
        first.uploadIntentId,
      );
      await expect(
        createAssignmentArtifactUploadIntent({ ...request, requestId: randomUUID() }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      // 다른 유형(발표자료)은 같은 대상이라도 별도 활성 의도를 가질 수 있다.
      await expect(
        createAssignmentArtifactUploadIntent({
          ...request,
          requestId: randomUUID(),
          artifactType: "SLIDES",
        }),
      ).resolves.toMatchObject({ artifactType: "SLIDES" });
    });
  });

  describe("동시성·기능 gate", () => {
    it("다른 키의 동시 최종화는 한 제출만 만들고 나머지는 충돌이다", async () => {
      const assignmentId = await v2("REQUIRED", "OPTIONAL");
      const intent = await upload(assignmentId, "TEXT", "HWP");
      const results = await Promise.allSettled([
        finalize(assignmentId, [intent]),
        finalize(assignmentId, [intent]),
        finalize(assignmentId, [intent]),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      for (const result of results)
        if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "CONFLICT" });
      expect(
        run(
          `SELECT count(*) FROM assignment_submissions s JOIN assignment_targets t ON t.id=s.assignment_target_id WHERE t.assignment_id='${assignmentId}';`,
        ),
      ).toBe("1");
    });

    it("같은 키의 동시 재시도는 같은 제출 하나로 수렴한다", async () => {
      const assignmentId = await v2("OPTIONAL", "REQUIRED");
      const intent = await upload(assignmentId, "SLIDES", "PPT");
      const key = randomUUID();
      const results = await Promise.allSettled([
        finalize(assignmentId, [intent], key),
        finalize(assignmentId, [intent], key),
      ]);
      const fulfilled = results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);
      expect(new Set(fulfilled.map((result) => result.submissionId)).size).toBe(1);
      const settled = await finalize(assignmentId, [intent], key);
      expect(settled).toMatchObject({ submissionId: fulfilled[0].submissionId, replayed: true });
    });

    it("기능 gate가 꺼지면 V2 발급·토큰·검증·최종화를 DB 접근 전에 막고 v1 업로드 gate는 그대로다", async () => {
      const assignmentId = await v2("OPTIONAL", "OPTIONAL");
      const intent = await upload(assignmentId, "TEXT", "PDF");
      vi.stubEnv("ACADEMIC_SUBMISSION_ARTIFACTS_ENABLED", "false");
      mocks.execute.mockClear();
      await expect(
        createAssignmentArtifactUploadIntent({
          assignmentId,
          requestId: randomUUID(),
          artifactType: "TEXT",
          fileFormat: "PDF",
          originalName: "과제.pdf",
          sizeBytes: 100,
          mimeType: "application/pdf",
        }),
      ).rejects.toMatchObject({ code: "DISABLED" });
      await expect(
        verifyAssignmentArtifactUpload({ assignmentId, uploadIntentId: intent }),
      ).rejects.toMatchObject({ code: "DISABLED" });
      await expect(finalize(assignmentId, [intent])).rejects.toMatchObject({ code: "DISABLED" });
      expect(mocks.execute).not.toHaveBeenCalled();
      // 토큰 승인은 원장을 읽어야 V2 여부를 알 수 있으므로 원장 조회 뒤, 예산·토큰 발급 전에 막는다.
      await expect(
        authorizeAssignmentUploadToken(
          { assignmentId, uploadIntentId: intent },
          `academic-uploads/v2/${intent}/original`,
          false,
        ),
      ).rejects.toMatchObject({ code: "DISABLED" });
      expect(
        run(
          `SELECT count(*) FROM rate_limit_events WHERE scope='academic-upload-artifact-target';`,
        ),
      ).toBe("1");
      // 상위 업로드 gate가 꺼지면 V2 gate만 켜도 열리지 않는다.
      vi.stubEnv("ACADEMIC_SUBMISSION_ARTIFACTS_ENABLED", "true");
      vi.stubEnv("ACADEMIC_UPLOADS_ENABLED", "false");
      await expect(finalize(assignmentId, [intent])).rejects.toMatchObject({ code: "DISABLED" });
    });
  });
});
