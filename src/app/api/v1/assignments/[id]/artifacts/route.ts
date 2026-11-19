/**
 * #516 본인 과제의 제출 형식·항목별 요구·최종 제출 파일 목록을 제공하는 API v1 어댑터입니다.
 *
 * 역할:
 * - 기존 `GET /api/v1/assignments/{id}`(PDF 단일 파일 계약)를 바꾸지 않고, 텍스트·발표자료 분리 제출(V2)을
 *   포함한 파일 목록(`files[]`)을 새 operation으로 추가합니다(OpenAPI 추가 전용 규칙).
 * - 기존 PDF 과제는 `file`을 그대로 두고 같은 파일을 `files`의 LEGACY_PDF 한 항목으로도 보여 줍니다.
 * - V2 과제는 `file`이 항상 null이고 `files`에 항목별 파일(최대 2개)과 보호 다운로드 경로를 담습니다.
 *
 * 주의:
 * - 분리 제출 gate가 꺼져 있으면 입력 검사·서비스 호출 전에 404입니다.
 * - 인가·대상 확인은 학생 상세 조회 서비스(getMyAssignment)가 매 요청 수행하며 저장 키·URL은 응답하지 않습니다.
 */
import { z } from "zod/v4";
import { withApiV1Principal } from "@/lib/api-v1-principal";
import {
  apiV1AssignmentArtifactsResponseSchema,
  toApiV1SubmissionFileDownloadPath,
} from "@hra/contracts/api-v1";
import { getMyAssignment } from "@/features/academics/student-assignments/queries";
import {
  AcademicApiHttpError,
  academicApiErrorResponse,
  academicApiHeaders,
  academicApiArtifactsDisabledResponse,
  assertNoAcademicApiQuery,
} from "@/features/academics/api-v1/http";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 잘못된 식별자·타인 과제·기능 비활성은 모두 같은 고정 404입니다. */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return withApiV1Principal(
    request,
    () => handleGet(request, { params }),
    (code) => academicApiErrorResponse(new AcademicApiHttpError(code), crypto.randomUUID()),
  );
}

async function handleGet(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const disabled = academicApiArtifactsDisabledResponse();
  if (disabled) return disabled;
  const requestId = crypto.randomUUID();
  try {
    assertNoAcademicApiQuery(request);
    const { id } = await params;
    if (!z.uuid().safeParse(id).success) throw new AcademicApiHttpError("NOT_FOUND");
    const item = await getMyAssignment(id);
    const submission = item.submission
      ? { submissionId: item.submission.submissionId, submittedAt: item.submission.submittedAt }
      : null;
    // 1) V2 과제: 항목별 파일과 요구를 허용 필드로만 다시 투영합니다.
    // 2) 기존 PDF 과제: 기존 file 메타를 유지하고 같은 파일을 LEGACY_PDF 항목으로도 제공합니다.
    const body = item.artifacts
      ? apiV1AssignmentArtifactsResponseSchema.parse({
          assignmentId: item.assignmentId,
          submissionFormat: "ARTIFACTS_V2",
          textRequirement: item.artifacts.textRequirement,
          slidesRequirement: item.artifacts.slidesRequirement,
          submission,
          file: null,
          files: submission
            ? item.artifacts.files.map((file) => ({
                fileId: file.fileId,
                artifactType: file.artifactType,
                fileFormat: file.fileFormat,
                originalName: file.originalName,
                mimeType: file.mimeType,
                sizeBytes: file.sizeBytes,
                downloadPath: toApiV1SubmissionFileDownloadPath(
                  submission.submissionId,
                  file.fileId,
                ),
              }))
            : [],
        })
      : apiV1AssignmentArtifactsResponseSchema.parse({
          assignmentId: item.assignmentId,
          submissionFormat: "LEGACY_SINGLE_PDF",
          textRequirement: null,
          slidesRequirement: null,
          submission,
          file: item.file
            ? {
                fileId: item.file.fileId,
                originalName: item.file.originalName,
                mimeType: item.file.mimeType,
                sizeBytes: item.file.sizeBytes,
              }
            : null,
          files:
            submission && item.file
              ? [
                  {
                    fileId: item.file.fileId,
                    artifactType: "LEGACY_PDF",
                    fileFormat: "PDF",
                    originalName: item.file.originalName,
                    mimeType: item.file.mimeType,
                    sizeBytes: item.file.sizeBytes,
                    downloadPath: toApiV1SubmissionFileDownloadPath(
                      submission.submissionId,
                      item.file.fileId,
                    ),
                  },
                ]
              : [],
        });
    return Response.json(body, { headers: { ...academicApiHeaders, "X-Request-Id": requestId } });
  } catch (error) {
    return academicApiErrorResponse(error, requestId);
  }
}
