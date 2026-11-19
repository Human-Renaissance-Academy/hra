// @vitest-environment node
/**
 * #516 PR-G 분리 제출(V2) API v1 어댑터의 기능 gate·입력 검증·서비스 연결·오류 대응·최소 응답을 검증합니다.
 * 서비스는 대체하고(실제 SQL·Blob 검증은 PR-D 격리 시험이 담당) HTTP 경계와 계약 투영만 확인합니다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiV1ArtifactUploadIntentResponseSchema,
  apiV1AssignmentArtifactsResponseSchema,
  apiV1ErrorResponseSchema,
  apiV1FinalizedArtifactSubmissionResponseSchema,
} from "@hra/contracts/api-v1";

const mocks = vi.hoisted(() => ({
  detail: vi.fn(),
  issue: vi.fn(),
  verify: vi.fn(),
  cancel: vi.fn(),
  finalize: vi.fn(),
  revalidate: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/features/academics/student-assignments/queries", () => ({
  getMyAssignment: mocks.detail,
}));
vi.mock("@/features/academics/assignment-uploads/artifacts", () => ({
  createAssignmentArtifactUploadIntent: mocks.issue,
  verifyAssignmentArtifactUpload: mocks.verify,
}));
vi.mock("@/features/academics/assignment-uploads/server", () => ({
  cancelAssignmentUploadIntent: mocks.cancel,
}));
vi.mock("@/features/academics/submissions/artifacts", () => ({
  finalizeAssignmentArtifactSubmission: mocks.finalize,
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));

import { GET as readArtifacts } from "@/app/api/v1/assignments/[id]/artifacts/route";
import { POST as issueIntent } from "@/app/api/v1/uploads/artifact-intents/route";
import { DELETE as cancelIntent } from "@/app/api/v1/uploads/artifact-intents/[id]/route";
import { POST as verifyIntent } from "@/app/api/v1/uploads/artifact-intents/[id]/verify/route";
import { POST as finalize } from "@/app/api/v1/submissions/artifacts/route";
import { AcademicAccessError } from "@/lib/academic-permissions";
import { AcademicUploadError } from "@/features/academics/assignment-uploads/contract";
import { SubmissionFinalizationError } from "@/features/academics/submissions/validation";

const assignmentId = "20000000-0000-4000-8000-000000000001";
const targetId = "30000000-0000-4000-8000-000000000001";
const intentA = "40000000-0000-4000-8000-000000000001";
const intentB = "40000000-0000-4000-8000-000000000002";
const submissionKey = "50000000-0000-4000-8000-000000000001";
const submissionId = "60000000-0000-4000-8000-000000000001";
const textFileId = "70000000-0000-4000-8000-000000000001";
const slidesFileId = "70000000-0000-4000-8000-000000000002";
const HWPX = "application/hwp+zip";
const PPTX = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const privateFields = {
  storageKey: "academic-uploads/v2/비공개/original",
  checksum: "a".repeat(64),
  url: "https://private.invalid/x",
};
const summary = {
  assignmentId,
  targetId,
  title: "분리 과제",
  status: "PUBLISHED",
  dueAt: "2030-11-01T00:00:00.000Z",
  publishedAt: "2026-10-01T00:00:00.000Z",
  instructions: "지침",
};
const submission = { submissionId, submittedAt: "2026-10-28T07:00:00.123Z" };
const textFile = {
  fileId: textFileId,
  artifactType: "TEXT",
  fileFormat: "HWPX",
  originalName: "본문.hwpx",
  mimeType: HWPX,
  sizeBytes: 3000,
};
const slidesFile = {
  fileId: slidesFileId,
  artifactType: "SLIDES",
  fileFormat: "PPTX",
  originalName: "발표.pptx",
  mimeType: PPTX,
  sizeBytes: 4000,
};
const download = (fileId: string) => `/api/v1/submissions/${submissionId}/files/${fileId}`;
const intentInput = {
  assignmentId,
  requestId: intentA,
  artifactType: "TEXT",
  fileFormat: "HWPX",
  originalName: "본문.hwpx",
  sizeBytes: 3000,
  mimeType: HWPX,
};
const finalizeInput = { assignmentId, uploadIntentIds: [intentA, intentB], submissionKey };
const context = (id: string) => ({ params: Promise.resolve({ id }) });

function getRequest(path: string, headers: Record<string, string> = {}) {
  return new Request(`https://qa.invalid/api/v1${path}`, { headers });
}
function jsonRequest(
  path: string,
  body: unknown,
  options: { method?: string; origin?: string | null; raw?: string } = {},
) {
  const headers = new Headers({ "Content-Type": "application/json" });
  if (options.origin !== null) headers.set("Origin", options.origin ?? "https://qa.invalid");
  return new Request(`https://qa.invalid/api/v1${path}`, {
    method: options.method ?? "POST",
    headers,
    body: options.raw ?? JSON.stringify(body),
  });
}

function expectPrivate(response: Response) {
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("vary")?.toLowerCase()).toContain("authorization");
  expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);
}
async function expectFailure(response: Response, status: number, code: string) {
  expect(response.status).toBe(status);
  expectPrivate(response);
  const body = await response.json();
  expect(apiV1ErrorResponseSchema.parse(body)).toEqual(body);
  expect(body.error.code).toBe(code);
  expect(JSON.stringify(body)).not.toMatch(/비공개|private\.invalid|본문\.hwpx|SELECT/);
}

/** 다섯 operation을 같은 정상 입력으로 호출하는 표입니다. */
const operations = [
  {
    name: "artifacts",
    run: () =>
      readArtifacts(getRequest(`/assignments/${assignmentId}/artifacts`), context(assignmentId)),
    service: mocks.detail,
  },
  {
    name: "issue",
    run: () => issueIntent(jsonRequest("/uploads/artifact-intents", intentInput)),
    service: mocks.issue,
  },
  {
    name: "cancel",
    run: () =>
      cancelIntent(
        jsonRequest(`/uploads/artifact-intents/${intentA}`, { assignmentId }, { method: "DELETE" }),
        context(intentA),
      ),
    service: mocks.cancel,
  },
  {
    name: "verify",
    run: () =>
      verifyIntent(
        jsonRequest(`/uploads/artifact-intents/${intentA}/verify`, { assignmentId }),
        context(intentA),
      ),
    service: mocks.verify,
  },
  {
    name: "finalize",
    run: () => finalize(jsonRequest("/submissions/artifacts", finalizeInput)),
    service: mocks.finalize,
  },
] as const;

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.stubEnv("ACADEMIC_ENABLED", "true");
  vi.stubEnv("ACADEMIC_UPLOADS_ENABLED", "true");
  vi.stubEnv("ACADEMIC_SUBMISSION_ARTIFACTS_ENABLED", "true");
  mocks.detail.mockResolvedValue({
    ...summary,
    ...privateFields,
    submission,
    file: null,
    artifacts: {
      textRequirement: "REQUIRED",
      slidesRequirement: "OPTIONAL",
      files: [{ ...textFile, ...privateFields }, slidesFile],
    },
  });
  mocks.issue.mockResolvedValue({
    uploadIntentId: intentA,
    artifactType: "TEXT",
    fileFormat: "HWPX",
    pathname: `academic-uploads/v2/${intentA}/original`,
    contentType: HWPX,
    expiresAt: "2026-10-28T08:00:00.000Z",
    ...privateFields,
  });
  mocks.verify.mockResolvedValue(undefined);
  mocks.cancel.mockResolvedValue(undefined);
  mocks.finalize.mockResolvedValue({
    assignmentId,
    submissionId,
    submittedAt: "2026-10-28T07:00:00.123456+00:00",
    replayed: false,
    files: [{ ...textFile, ...privateFields }, slidesFile],
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("기능 gate", () => {
  it.each([
    "ACADEMIC_ENABLED",
    "ACADEMIC_UPLOADS_ENABLED",
    "ACADEMIC_SUBMISSION_ARTIFACTS_ENABLED",
  ])("%s가 꺼져 있으면 모든 분리 제출 operation이 서비스 전 404다", async (name) => {
    vi.stubEnv(name, "false");
    for (const operation of operations) {
      await expectFailure(await operation.run(), 404, "NOT_FOUND");
      expect(operation.service).not.toHaveBeenCalled();
    }
    expect(console.info).not.toHaveBeenCalled();
  });

  it("gate가 꺼져 있으면 잘못된 query·본문도 기능 존재를 드러내지 않는 404다", async () => {
    vi.stubEnv("ACADEMIC_SUBMISSION_ARTIFACTS_ENABLED", "TRUE");
    await expectFailure(
      await readArtifacts(
        getRequest(`/assignments/${assignmentId}/artifacts?x=1`),
        context(assignmentId),
      ),
      404,
      "NOT_FOUND",
    );
    await expectFailure(
      await issueIntent(jsonRequest("/uploads/artifact-intents", null, { raw: "{" })),
      404,
      "NOT_FOUND",
    );
  });
});

describe("인증 전송", () => {
  it("유효하지 않은 Bearer는 쿠키로 대체하지 않고 401이다", async () => {
    const response = await readArtifacts(
      getRequest(`/assignments/${assignmentId}/artifacts`, { Authorization: "Basic x" }),
      context(assignmentId),
    );
    await expectFailure(response, 401, "UNAUTHENTICATED");
    expect(mocks.detail).not.toHaveBeenCalled();
  });

  it.each([null, "https://other.invalid"])(
    "쿠키 요청의 Origin %s는 변경 operation에서 서비스 전 403이다",
    async (origin) => {
      await expectFailure(
        await issueIntent(jsonRequest("/uploads/artifact-intents", intentInput, { origin })),
        403,
        "FORBIDDEN",
      );
      await expectFailure(
        await finalize(jsonRequest("/submissions/artifacts", finalizeInput, { origin })),
        403,
        "FORBIDDEN",
      );
      expect(mocks.issue).not.toHaveBeenCalled();
      expect(mocks.finalize).not.toHaveBeenCalled();
    },
  );

  it("서비스의 세션 거부를 v1 코드로 변환한다", async () => {
    mocks.detail.mockRejectedValueOnce(new AcademicAccessError("UNAUTHENTICATED"));
    await expectFailure(await operations[0].run(), 401, "UNAUTHENTICATED");
    mocks.issue.mockRejectedValueOnce(new AcademicAccessError("FORBIDDEN"));
    await expectFailure(await operations[1].run(), 403, "FORBIDDEN");
    mocks.finalize.mockRejectedValueOnce(new SubmissionFinalizationError("FORBIDDEN"));
    await expectFailure(await operations[4].run(), 404, "NOT_FOUND");
  });
});

describe("제출 형식·파일 목록 조회", () => {
  it("V2 과제는 file=null과 항목별 files·보호 다운로드 경로만 반환한다", async () => {
    const response = await operations[0].run();
    expect(response.status).toBe(200);
    expectPrivate(response);
    expect(mocks.detail).toHaveBeenCalledExactlyOnceWith(assignmentId);
    const body = await response.json();
    expect(apiV1AssignmentArtifactsResponseSchema.parse(body)).toEqual(body);
    expect(body).toEqual({
      assignmentId,
      submissionFormat: "ARTIFACTS_V2",
      textRequirement: "REQUIRED",
      slidesRequirement: "OPTIONAL",
      submission,
      file: null,
      files: [
        { ...textFile, downloadPath: download(textFileId) },
        { ...slidesFile, downloadPath: download(slidesFileId) },
      ],
    });
    expect(JSON.stringify(body)).not.toMatch(
      /storageKey|checksum|private\.invalid|targetId|instructions/,
    );
  });

  it("미제출 V2 과제는 submission=null·빈 files다", async () => {
    mocks.detail.mockResolvedValueOnce({
      ...summary,
      submission: null,
      file: null,
      artifacts: { textRequirement: "OPTIONAL", slidesRequirement: "OPTIONAL", files: [] },
    });
    const body = await (await operations[0].run()).json();
    expect(body).toMatchObject({
      submissionFormat: "ARTIFACTS_V2",
      submission: null,
      file: null,
      files: [],
    });
  });

  it("기존 PDF 과제는 file을 유지하고 같은 파일을 LEGACY_PDF 항목으로도 제공한다", async () => {
    const file = {
      fileId: textFileId,
      originalName: "과제.pdf",
      mimeType: "application/pdf",
      sizeBytes: 2048,
    };
    mocks.detail.mockResolvedValueOnce({ ...summary, submission, file });
    const body = await (await operations[0].run()).json();
    expect(body).toEqual({
      assignmentId,
      submissionFormat: "LEGACY_SINGLE_PDF",
      textRequirement: null,
      slidesRequirement: null,
      submission,
      file,
      files: [
        {
          ...file,
          artifactType: "LEGACY_PDF",
          fileFormat: "PDF",
          downloadPath: download(textFileId),
        },
      ],
    });
    mocks.detail.mockResolvedValueOnce({ ...summary, submission: null, file: null });
    expect(await (await operations[0].run()).json()).toMatchObject({
      submissionFormat: "LEGACY_SINGLE_PDF",
      files: [],
      file: null,
    });
  });

  it("query·잘못된 UUID는 서비스 전에 거부하고, 계약에 어긋난 서비스 결과는 503이다", async () => {
    await expectFailure(
      await readArtifacts(
        getRequest(`/assignments/${assignmentId}/artifacts?userId=1`),
        context(assignmentId),
      ),
      400,
      "INVALID_INPUT",
    );
    await expectFailure(
      await readArtifacts(getRequest("/assignments/x/artifacts"), context("x")),
      404,
      "NOT_FOUND",
    );
    expect(mocks.detail).not.toHaveBeenCalled();
    mocks.detail.mockResolvedValueOnce({
      ...summary,
      submission,
      file: null,
      artifacts: {
        textRequirement: "REQUIRED",
        slidesRequirement: "OPTIONAL",
        files: [
          textFile,
          { ...slidesFile, artifactType: "TEXT", fileFormat: "HWPX", mimeType: HWPX },
        ],
      },
    });
    await expectFailure(await operations[0].run(), 503, "UNAVAILABLE");
  });
});

describe("업로드 의도·검증·취소", () => {
  it("발급은 검증된 입력만 서비스에 넘기고 v2 경로·정규 contentType만 반환한다", async () => {
    const response = await operations[1].run();
    expect(response.status).toBe(200);
    expect(mocks.issue).toHaveBeenCalledExactlyOnceWith(
      intentInput,
      expect.objectContaining({ correlationId: response.headers.get("x-request-id") }),
    );
    const body = await response.json();
    expect(apiV1ArtifactUploadIntentResponseSchema.parse(body)).toEqual(body);
    expect(body).toEqual({
      uploadIntentId: intentA,
      artifactType: "TEXT",
      fileFormat: "HWPX",
      pathname: `academic-uploads/v2/${intentA}/original`,
      contentType: HWPX,
      expiresAt: "2026-10-28T08:00:00.000Z",
    });
  });

  it.each([
    {
      ...intentInput,
      artifactType: "TEXT",
      fileFormat: "PPTX",
      originalName: "x.pptx",
      mimeType: PPTX,
    },
    { ...intentInput, originalName: "본문.hwp" },
    { ...intentInput, mimeType: "application/pdf" },
    { ...intentInput, originalName: "../본문.hwpx" },
    { ...intentInput, sizeBytes: 52_428_801 },
    { ...intentInput, artifactType: "LEGACY_PDF" },
    { ...intentInput, storageKey: "x" },
    { ...intentInput, userId: assignmentId },
  ])("유형·형식·확장자·MIME·크기·추가 속성 오류는 서비스 전 400이다 (%j)", async (body) => {
    await expectFailure(
      await issueIntent(jsonRequest("/uploads/artifact-intents", body)),
      400,
      "INVALID_INPUT",
    );
    expect(mocks.issue).not.toHaveBeenCalled();
  });

  it.each([
    [new AcademicUploadError("INVALID_FILE", undefined, "ARTIFACT_DISABLED"), 400, "INVALID_INPUT"],
    [new AcademicUploadError("CONFLICT"), 409, "CONFLICT"],
    [new AcademicUploadError("EXPIRED"), 409, "CONFLICT"],
    [new AcademicUploadError("DISABLED"), 503, "DISABLED"],
    [new AcademicUploadError("UNAVAILABLE"), 503, "STORAGE_UNAVAILABLE"],
    [new Error("SELECT 비공개"), 503, "UNAVAILABLE"],
  ] as const)("발급 실패 %s를 %s·%s로 변환한다", async (error, status, code) => {
    mocks.issue.mockRejectedValueOnce(error);
    await expectFailure(await operations[1].run(), status, code);
  });

  it("요청 제한은 Retry-After를 유지한다", async () => {
    mocks.issue.mockRejectedValueOnce(new AcademicUploadError("RATE_LIMITED", 21));
    const response = await operations[1].run();
    await expectFailure(response, 429, "RATE_LIMITED");
    expect(response.headers.get("retry-after")).toBe("21");
  });

  it("검증·취소는 경로 ID와 본문 과제 ID만 서비스에 넘긴다", async () => {
    const verified = await operations[3].run();
    expect(await verified.json()).toEqual({ state: "VERIFIED" });
    expect(mocks.verify).toHaveBeenCalledExactlyOnceWith(
      { assignmentId, uploadIntentId: intentA },
      expect.anything(),
    );
    const cancelled = await operations[2].run();
    expect(await cancelled.json()).toEqual({ state: "CANCELLED" });
    expect(mocks.cancel).toHaveBeenCalledExactlyOnceWith(
      { assignmentId, uploadIntentId: intentA },
      expect.anything(),
    );
  });

  it("검증 거부 사유는 400, 없는·V2가 아닌 의도는 404, 잘못된 경로·본문은 서비스 전 거부다", async () => {
    mocks.verify.mockRejectedValueOnce(new AcademicUploadError("INVALID_FILE", undefined, "MACRO"));
    await expectFailure(await operations[3].run(), 400, "INVALID_INPUT");
    mocks.verify.mockRejectedValueOnce(new AcademicUploadError("NOT_FOUND"));
    await expectFailure(await operations[3].run(), 404, "NOT_FOUND");
    mocks.verify.mockClear();
    await expectFailure(
      await verifyIntent(
        jsonRequest("/uploads/artifact-intents/x/verify", { assignmentId }),
        context("x"),
      ),
      404,
      "NOT_FOUND",
    );
    await expectFailure(
      await verifyIntent(
        jsonRequest(`/uploads/artifact-intents/${intentA}/verify`, {
          assignmentId,
          uploadIntentId: intentB,
        }),
        context(intentA),
      ),
      400,
      "INVALID_INPUT",
    );
    expect(mocks.verify).not.toHaveBeenCalled();
  });
});

describe("원자 최종 제출", () => {
  it("UTC 밀리초·파일별 다운로드 경로로 투영하고 Web 캐시를 갱신한다", async () => {
    const response = await operations[4].run();
    expect(response.status).toBe(200);
    expect(mocks.finalize).toHaveBeenCalledExactlyOnceWith(
      finalizeInput,
      expect.objectContaining({ correlationId: response.headers.get("x-request-id") }),
    );
    const body = await response.json();
    expect(apiV1FinalizedArtifactSubmissionResponseSchema.parse(body)).toEqual(body);
    expect(body).toEqual({
      submission: {
        assignmentId,
        submissionId,
        submittedAt: "2026-10-28T07:00:00.123Z",
        replayed: false,
        files: [
          { ...textFile, downloadPath: download(textFileId) },
          { ...slidesFile, downloadPath: download(slidesFileId) },
        ],
      },
    });
    expect(JSON.stringify(body)).not.toMatch(/storageKey|checksum|private\.invalid/);
    expect(mocks.revalidate).toHaveBeenCalledWith(
      `/admin/academics/assignments/${assignmentId}/submissions`,
    );
    expect(console.info).toHaveBeenLastCalledWith(
      "[academic/events]",
      expect.objectContaining({ outcome: "COMPLETED", resourceId: submissionId }),
    );
  });

  it("같은 키 재시도는 replayed=true로 복구한다", async () => {
    mocks.finalize.mockResolvedValueOnce({
      assignmentId,
      submissionId,
      submittedAt: submission.submittedAt,
      replayed: true,
      files: [textFile],
    });
    const body = await (await operations[4].run()).json();
    expect(body.submission).toMatchObject({ replayed: true, files: [{ fileId: textFileId }] });
  });

  it.each([
    { ...finalizeInput, uploadIntentIds: [] },
    { ...finalizeInput, uploadIntentIds: [intentA, intentB, submissionKey] },
    { ...finalizeInput, uploadIntentIds: ["x"] },
    { ...finalizeInput, uploadIntentId: intentA },
    { assignmentId, submissionKey },
  ])("묶음 개수·식별자·추가 속성 오류는 서비스 전 400이다 (%j)", async (body) => {
    await expectFailure(
      await finalize(jsonRequest("/submissions/artifacts", body)),
      400,
      "INVALID_INPUT",
    );
    expect(mocks.finalize).not.toHaveBeenCalled();
  });

  it.each([
    [new SubmissionFinalizationError("INCOMPLETE"), 400, "INVALID_INPUT"],
    [new SubmissionFinalizationError("TOO_LARGE"), 400, "INVALID_INPUT"],
    [new SubmissionFinalizationError("WRONG_FORMAT"), 409, "CONFLICT"],
    [new SubmissionFinalizationError("CONFLICT"), 409, "CONFLICT"],
    [new SubmissionFinalizationError("DEADLINE"), 409, "CONFLICT"],
    [new SubmissionFinalizationError("EXPIRED"), 409, "CONFLICT"],
    [new SubmissionFinalizationError("NOT_READY"), 409, "CONFLICT"],
    [new AcademicUploadError("INVALID_FILE", undefined, "ENCRYPTED"), 400, "INVALID_INPUT"],
    [new AcademicUploadError("UNAVAILABLE"), 503, "STORAGE_UNAVAILABLE"],
  ] as const)(
    "최종화 실패 %s를 %s·%s로 변환하고 캐시를 갱신하지 않는다",
    async (error, status, code) => {
      mocks.finalize.mockRejectedValueOnce(error);
      await expectFailure(await operations[4].run(), status, code);
      expect(mocks.revalidate).not.toHaveBeenCalled();
      expect(console.error).toHaveBeenCalledWith(
        "[academic/events]",
        expect.objectContaining({
          context: expect.objectContaining({ outcome: "FAILED" }),
        }),
      );
    },
  );
});
