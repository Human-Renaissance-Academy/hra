/**
 * #516 텍스트·발표자료 분리 제출(V2)의 원자적 최종 제출·멱등 결과 복구를 연결하는 API v1 어댑터입니다.
 *
 * 역할:
 * - 검증된 업로드 의도 1~2개를 PR-D 서비스(finalizeAssignmentArtifactSubmission)로 한 트랜잭션에서 확정합니다.
 * - 같은 submissionKey·같은 의도 묶음의 재시도는 저장된 결과를 replayed=true로 복구합니다.
 * - 응답 파일마다 보호 다운로드 경로(downloadPath)를 붙이고 저장 키·체크섬·계정 ID는 반환하지 않습니다.
 *
 * 주의:
 * - 분리 제출 gate가 꺼져 있으면 본문을 읽기 전에 404입니다.
 * - 새 실패 코드는 공개 계약을 늘리지 않고 기존 코드로 대응합니다:
 *   필수 누락·미사용 첨부·중복(INCOMPLETE)·합계 초과 → INVALID_INPUT(400), 형식이 다른 과제(WRONG_FORMAT) → CONFLICT(409).
 */
import { revalidatePath } from "next/cache";
import { withApiV1Principal } from "@/lib/api-v1-principal";
import {
  apiV1FinalizeArtifactSubmissionInputSchema,
  apiV1FinalizedArtifactSubmissionResponseSchema,
  toApiV1SubmissionFileDownloadPath,
} from "@hra/contracts/api-v1";
import { finalizeAssignmentArtifactSubmission } from "@/features/academics/submissions/artifacts";
import { SubmissionFinalizationError } from "@/features/academics/submissions/validation";
import { AcademicUploadError } from "@/features/academics/assignment-uploads/contract";
import {
  AcademicApiHttpError,
  academicApiArtifactsDisabledResponse,
  academicApiErrorResponse,
  academicApiHeaders,
  readAcademicApiJson,
} from "@/features/academics/api-v1/http";
import { academicSqlState, createAcademicObservation } from "@/lib/academic-observability";
import { AcademicAccessError } from "@/lib/academic-permissions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// 최종화 직전 원본(최대 2×50MiB)을 순서대로 다시 검증합니다. 실제 저장소 시간 측정은 #516 PR-H에서 합니다.
export const maxDuration = 120;

/** 성공 재시도에서도 같은 submissionKey를 서비스에 전달하여 저장된 최종 결과를 복구합니다. */
export async function POST(request: Request): Promise<Response> {
  return withApiV1Principal(
    request,
    () => handlePost(request),
    (code) => academicApiErrorResponse(new AcademicApiHttpError(code), crypto.randomUUID()),
  );
}

async function handlePost(request: Request): Promise<Response> {
  const disabled = academicApiArtifactsDisabledResponse();
  if (disabled) return disabled;
  const observation = createAcademicObservation("SUBMISSION_FINALIZE", "SUBMISSION");
  try {
    const parsed = apiV1FinalizeArtifactSubmissionInputSchema.safeParse(
      await readAcademicApiJson(request),
    );
    if (!parsed.success) throw new AcademicApiHttpError("INVALID_INPUT");
    const result = await finalizeAssignmentArtifactSubmission(parsed.data, observation);
    const body = apiV1FinalizedArtifactSubmissionResponseSchema.parse({
      submission: {
        assignmentId: result.assignmentId,
        submissionId: result.submissionId,
        // PostgreSQL 결과의 마이크로초·오프셋을 API 공통 UTC 밀리초 계약으로 변환합니다.
        submittedAt: new Date(result.submittedAt).toISOString(),
        replayed: result.replayed,
        files: result.files.map((file) => ({
          fileId: file.fileId,
          artifactType: file.artifactType,
          fileFormat: file.fileFormat,
          originalName: file.originalName,
          mimeType: file.mimeType,
          sizeBytes: file.sizeBytes,
          downloadPath: toApiV1SubmissionFileDownloadPath(result.submissionId, file.fileId),
        })),
      },
    });
    observation.emit(result.replayed ? "REPLAYED" : "COMPLETED", {
      resourceId: result.submissionId,
    });
    revalidatePath("/member/assignments");
    revalidatePath(`/member/assignments/${result.assignmentId}`);
    revalidatePath("/admin/academics/assignments");
    revalidatePath(`/admin/academics/assignments/${result.assignmentId}/submissions`);
    return Response.json(body, {
      headers: { ...academicApiHeaders, "X-Request-Id": observation.correlationId },
    });
  } catch (error) {
    const known =
      error instanceof AcademicAccessError ||
      error instanceof AcademicUploadError ||
      error instanceof SubmissionFinalizationError ||
      error instanceof AcademicApiHttpError;
    const code = known ? error.code : null;
    const denied = code !== null && ["UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND"].includes(code);
    // 웹 분리 제출 액션과 같은 고정 분류로 기록하고 오류 원문·파일명은 전달하지 않습니다.
    // 서비스 내부(원본 재검증)에서 이미 실패를 기록했으면 중복 기록하지 않습니다.
    if (!observation.failureRecorded)
      observation.emit(denied ? "DENIED" : "FAILED", {
        failureCode: denied
          ? "AUTHORIZATION"
          : code !== null &&
              ["INVALID_INPUT", "INVALID_FILE", "INCOMPLETE", "TOO_LARGE"].includes(code)
            ? "INPUT"
            : code === "DISABLED"
              ? "GATE"
              : code !== null &&
                  ["CONFLICT", "EXPIRED", "DEADLINE", "RATE_LIMITED", "WRONG_FORMAT"].includes(code)
                ? "CONFLICT"
                : code === "NOT_READY"
                  ? "NOT_READY"
                  : "STORAGE",
        sqlState: academicSqlState(error),
      });
    return academicApiErrorResponse(error, observation.correlationId);
  }
}
