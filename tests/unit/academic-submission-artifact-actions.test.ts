// @vitest-environment node
/**
 * #516 PR-F 분리 제출(V2) 학생 서버 액션이 실제 PR-D 서비스를 거쳐 기능 gate·세션 인가·입력 검증·고정 오류를 지키는지 확인한다.
 * DB 어댑터(업로드·최종화 리포지토리)와 세션 대상 조회만 대체하고, 서비스·계약·오류 문구는 운영 코드를 그대로 사용한다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  target: vi.fn(),
  reserve: vi.fn(),
  issue: vi.fn(),
  authorize: vi.fn(),
  retire: vi.fn(),
  complete: vi.fn(),
  revalidate: vi.fn(),
  head: vi.fn(),
  get: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("@vercel/blob", () => ({ head: mocks.head, get: mocks.get }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/academic-permissions", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/academic-permissions")>()),
  requireAssignmentTarget: mocks.target,
}));
vi.mock("@/features/academics/assignment-uploads/repository", () => ({
  reserveAssignmentUploadAttempt: mocks.reserve,
  issueUploadRecordV2: mocks.issue,
  authorizeUploadRecord: mocks.authorize,
  retireUploadRecord: mocks.retire,
  persistUploadVerificationV2: vi.fn(),
  issueUploadRecord: vi.fn(),
  persistUploadVerification: vi.fn(),
}));
vi.mock("@/features/academics/submissions/repository", () => ({
  completeArtifactSubmission: mocks.complete,
}));

import { AcademicAccessError } from "@/lib/academic-permissions";
import {
  cancelArtifactUpload,
  finalizeArtifactSubmission,
  issueArtifactUploadIntent,
  verifyArtifactUpload,
} from "@/features/academics/submissions/artifact-actions";

const user = "10000000-0000-4000-8000-000000000001";
const assignment = "20000000-0000-4000-8000-000000000001";
const target = "30000000-0000-4000-8000-000000000001";
const intent = "40000000-0000-4000-8000-000000000001";
const key = "50000000-0000-4000-8000-000000000001";
const request = "60000000-0000-4000-8000-000000000001";
const hwpMime = "application/x-hwp";
const issueInput = (overrides: Record<string, unknown> = {}) => ({
  assignmentId: assignment,
  requestId: request,
  artifactType: "TEXT",
  fileFormat: "HWP",
  originalName: "텍스트.hwp",
  sizeBytes: 2048,
  mimeType: hwpMime,
  ...overrides,
});
const flags = (artifacts: string) => {
  vi.stubEnv("ACADEMIC_ENABLED", "true");
  vi.stubEnv("ACADEMIC_UPLOADS_ENABLED", "true");
  vi.stubEnv("ACADEMIC_ENROLLMENT_WRITES_ENABLED", "true");
  vi.stubEnv("ACADEMIC_SUBMISSION_ARTIFACTS_ENABLED", artifacts);
  vi.stubEnv("ACADEMIC_SUBMISSION_BLOB_HOST", "qa516.private.blob.vercel-storage.com");
  vi.stubEnv("ACADEMIC_SUBMISSION_READ_WRITE_TOKEN", "vercel_blob_rw_qa516_qaonly");
};
const record = () => ({
  intent_id: intent,
  target_id: target,
  user_id: user,
  original_name: "텍스트.hwp",
  expected_size: 2048,
  storage_key: `academic-uploads/v2/${intent}/original`,
  expires_at: new Date("2099-01-01T00:00:00Z"),
  state: "INTENDED",
  verified_etag: null,
  artifact_type: "TEXT",
  file_format: "HWP",
});
const finalized = () => ({
  assignmentId: assignment,
  submissionId: "70000000-0000-4000-8000-000000000001",
  submittedAt: "2099-01-01T00:00:00.000Z",
  replayed: true,
  files: [
    {
      fileId: "80000000-0000-4000-8000-000000000001",
      artifactType: "TEXT",
      fileFormat: "HWP",
      originalName: "텍스트.hwp",
      mimeType: hwpMime,
      sizeBytes: 2048,
    },
  ],
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  flags("true");
  mocks.target.mockResolvedValue({
    userId: user,
    targetId: target,
    assignmentId: assignment,
    status: "PUBLISHED",
    dueAt: new Date(Date.now() + 3_600_000),
    publishedAt: new Date("2026-01-01T00:00:00Z"),
  });
  mocks.issue.mockResolvedValue(intent);
  mocks.authorize.mockResolvedValue(record());
  mocks.complete.mockResolvedValue(finalized());
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("분리 제출 V2 학생 서버 액션", () => {
  it("기능 gate가 꺼져 있으면 네 액션 모두 세션·DB 전에 DISABLED로 닫힌다", async () => {
    flags("false");
    const results = [
      await issueArtifactUploadIntent(issueInput()),
      await verifyArtifactUpload({ assignmentId: assignment, uploadIntentId: intent }),
      await cancelArtifactUpload({ assignmentId: assignment, uploadIntentId: intent }),
      await finalizeArtifactSubmission({
        assignmentId: assignment,
        uploadIntentIds: [intent],
        submissionKey: key,
      }),
    ];
    for (const result of results)
      expect(result).toMatchObject({ success: false, code: "DISABLED", status: 404 });
    expect(mocks.target).not.toHaveBeenCalled();
    expect(mocks.retire).not.toHaveBeenCalled();
    expect(mocks.complete).not.toHaveBeenCalled();
  });

  it("기존 업로드 gate가 꺼져 있어도 분리 제출 gate만으로 열리지 않는다", async () => {
    vi.stubEnv("ACADEMIC_UPLOADS_ENABLED", "false");
    expect(await issueArtifactUploadIntent(issueInput())).toMatchObject({
      success: false,
      code: "DISABLED",
    });
    expect(
      await cancelArtifactUpload({ assignmentId: assignment, uploadIntentId: intent }),
    ).toMatchObject({ code: "DISABLED" });
    expect(mocks.target).not.toHaveBeenCalled();
  });

  it("세션 주체는 입력이 아니라 서비스의 본인 대상 조회에서만 얻고, 미인증은 고정 오류로 응답한다", async () => {
    mocks.target.mockRejectedValue(new AcademicAccessError("UNAUTHENTICATED"));
    const result = await issueArtifactUploadIntent(issueInput());
    expect(result).toMatchObject({ success: false, code: "UNAUTHENTICATED", status: 401 });
    expect(mocks.issue).not.toHaveBeenCalled();
    // 입력에 사용자 ID를 섞으면 strict 입력 검증이 거부한다.
    const forged = await issueArtifactUploadIntent(issueInput({ userId: user }));
    expect(forged).toMatchObject({ success: false, code: "INVALID_FILE", reason: "SELECTION" });
  });

  it("발급은 형식·확장자·정규 MIME을 검증하고 성공 시 정규 contentType과 v2 경로만 돌려준다", async () => {
    for (const bad of [
      issueInput({
        fileFormat: "PPTX",
        originalName: "텍스트.pptx",
        mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      }),
      issueInput({ originalName: "텍스트.pdf" }),
      issueInput({ mimeType: "application/octet-stream" }),
      issueInput({ sizeBytes: 50 * 1024 * 1024 + 1 }),
    ]) {
      const result = await issueArtifactUploadIntent(bad);
      expect(result).toMatchObject({
        success: false,
        code: "INVALID_FILE",
        status: 422,
        reason: "SELECTION",
      });
      expect(result.success ? "" : result.message).toContain("50MiB");
    }
    expect(mocks.target).not.toHaveBeenCalled();
    const issued = await issueArtifactUploadIntent(issueInput());
    expect(issued).toMatchObject({
      success: true,
      uploadIntentId: intent,
      artifactType: "TEXT",
      fileFormat: "HWP",
      pathname: `academic-uploads/v2/${intent}/original`,
      contentType: hwpMime,
    });
    expect(mocks.issue).toHaveBeenCalledWith(
      expect.objectContaining({ userId: user, targetId: target, artifactType: "TEXT" }),
    );
    expect(JSON.stringify(issued)).not.toContain("vercel_blob_rw");
  });

  it("미사용 항목 발급 거부는 사유 코드와 고정 한국어 문구로 전달한다", async () => {
    const { AcademicUploadError } =
      await import("@/features/academics/assignment-uploads/contract");
    mocks.issue.mockRejectedValue(new AcademicUploadError("INVALID_FILE"));
    const result = await issueArtifactUploadIntent(issueInput());
    expect(result).toMatchObject({
      success: false,
      code: "INVALID_FILE",
      reason: "ARTIFACT_DISABLED",
      message: "이 과제는 해당 제출 항목을 받지 않습니다.",
    });
  });

  it("검증·취소는 잘못된 식별자를 NOT_FOUND로 막고 다른 키를 넘기지 않는다", async () => {
    expect(await verifyArtifactUpload({ assignmentId: "x", uploadIntentId: intent })).toMatchObject(
      { code: "NOT_FOUND" },
    );
    expect(await verifyArtifactUpload(null)).toMatchObject({ code: "NOT_FOUND" });
    expect(
      await cancelArtifactUpload({
        assignmentId: assignment,
        uploadIntentId: intent,
        userId: user,
      }),
    ).toMatchObject({ code: "NOT_FOUND" });
    expect(mocks.retire).not.toHaveBeenCalled();
    expect(
      await cancelArtifactUpload({ assignmentId: assignment, uploadIntentId: intent }),
    ).toMatchObject({ success: true, state: "CANCELLED" });
    expect(mocks.retire).toHaveBeenCalledWith(intent, user, target);
  });

  it("검증 실패는 원본 오류 대신 고정 오류를 돌려준다", async () => {
    mocks.head.mockRejectedValue(new Error("https://secret.example/academic-uploads/v2/raw"));
    const result = await verifyArtifactUpload({ assignmentId: assignment, uploadIntentId: intent });
    expect(result).toMatchObject({ success: false, code: "UNAVAILABLE", status: 503 });
    expect(JSON.stringify(result)).not.toContain("secret.example");
  });

  it("최종화는 입력을 검증하고 같은 멱등 키의 기존 결과를 복구한다", async () => {
    expect(
      await finalizeArtifactSubmission({
        assignmentId: assignment,
        uploadIntentIds: [intent, intent, intent],
        submissionKey: key,
      }),
    ).toMatchObject({ success: false, code: "INVALID_INPUT", status: 422 });
    expect(mocks.complete).not.toHaveBeenCalled();
    const result = await finalizeArtifactSubmission({
      assignmentId: assignment,
      uploadIntentIds: [intent],
      submissionKey: key,
    });
    expect(result).toMatchObject({ success: true, replayed: true, files: finalized().files });
    expect(mocks.complete).toHaveBeenCalledWith(
      expect.objectContaining({ userId: user, targetId: target }),
      { assignmentId: assignment, uploadIntentIds: [intent], submissionKey: key },
      false,
    );
    expect(mocks.revalidate).toHaveBeenCalledWith(`/member/assignments/${assignment}`);
  });

  it("최종화의 0개 제출은 Blob을 읽기 전에 INCOMPLETE로 거부한다", async () => {
    mocks.complete.mockResolvedValueOnce(null);
    const result = await finalizeArtifactSubmission({
      assignmentId: assignment,
      uploadIntentIds: [],
      submissionKey: key,
    });
    expect(result).toMatchObject({ success: false, code: "INCOMPLETE", status: 422 });
    expect(mocks.head).not.toHaveBeenCalled();
  });
});
