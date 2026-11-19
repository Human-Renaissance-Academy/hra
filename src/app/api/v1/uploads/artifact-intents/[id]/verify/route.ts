/**
 * #516 분리 제출(V2) 업로드 원본을 서버가 검증하는 API v1 어댑터입니다.
 *
 * 역할:
 * - PR-D 서비스(verifyAssignmentArtifactUpload)가 비공개 Blob 메타·전체 원본·SHA-256과 실제 문서 형식
 *   (확장자·선언 형식·정규 MIME·산출물 허용 목록)을 교차 검증한 뒤에만 VERIFIED로 기록합니다.
 * - VERIFIED는 최종 제출이 아니며 같은 의도의 재검증은 멱등입니다.
 *
 * 주의:
 * - 분리 제출 gate가 꺼져 있으면 본문을 읽기 전에 404입니다.
 * - V2가 아닌 의도(기존 PDF)는 서비스가 없는 업로드와 같은 404로 거부합니다.
 * - 검증 거부 사유는 공개 코드를 늘리지 않고 INVALID_INPUT(400)으로 응답합니다.
 */
import { z } from "zod/v4";
import { withApiV1Principal } from "@/lib/api-v1-principal";
import {
  apiV1UploadSelectionInputSchema,
  apiV1UploadVerifiedResponseSchema,
} from "@hra/contracts/api-v1";
import { verifyAssignmentArtifactUpload } from "@/features/academics/assignment-uploads/artifacts";
import { recordUploadFailure } from "@/features/academics/assignment-uploads/observability";
import {
  AcademicApiHttpError,
  academicApiArtifactsDisabledResponse,
  academicApiErrorResponse,
  academicApiHeaders,
  readAcademicApiJson,
} from "@/features/academics/api-v1/http";
import { createAcademicObservation } from "@/lib/academic-observability";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// 원본 전체(≤50MiB)를 읽어 검증하므로 기존 PDF 검증 경로와 같은 실행 시간 상한을 둡니다.
export const maxDuration = 120;

/** 경로 의도 ID와 본문 과제 ID 외의 저장 키·파일 메타는 입력받지 않고 서버 원장을 다시 읽습니다. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return withApiV1Principal(
    request,
    () => handlePost(request, { params }),
    (code) => academicApiErrorResponse(new AcademicApiHttpError(code), crypto.randomUUID()),
  );
}

async function handlePost(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const disabled = academicApiArtifactsDisabledResponse();
  if (disabled) return disabled;
  const observation = createAcademicObservation("UPLOAD_VERIFY", "UPLOAD_INTENT");
  try {
    const input = apiV1UploadSelectionInputSchema.safeParse(await readAcademicApiJson(request));
    if (!input.success) throw new AcademicApiHttpError("INVALID_INPUT");
    const id = z.uuid().safeParse((await params).id);
    if (!id.success) throw new AcademicApiHttpError("NOT_FOUND");
    await verifyAssignmentArtifactUpload(
      { assignmentId: input.data.assignmentId, uploadIntentId: id.data },
      observation,
    );
    return Response.json(apiV1UploadVerifiedResponseSchema.parse({ state: "VERIFIED" }), {
      headers: { ...academicApiHeaders, "X-Request-Id": observation.correlationId },
    });
  } catch (error) {
    recordUploadFailure(observation, error);
    return academicApiErrorResponse(error, observation.correlationId);
  }
}
