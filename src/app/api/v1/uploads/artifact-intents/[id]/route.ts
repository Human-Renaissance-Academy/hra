/**
 * #516 분리 제출(V2)의 본인 업로드 의도를 취소하는 API v1 어댑터입니다.
 *
 * 역할:
 * - 기존 취소 서비스(cancelAssignmentUploadIntent)는 저장 키 기준으로 동작해 V2 의도에도 그대로 쓰입니다.
 *   이 경로는 분리 제출 gate를 먼저 확인하는 V2 전용 진입점입니다(웹 화면 서버 액션과 같은 순서).
 * - 발급 원장만 종료하고 아직 유효한 비공개 객체를 즉시 삭제하지 않습니다.
 *
 * 주의:
 * - 분리 제출 gate가 꺼져 있으면 본문을 읽기 전에 404입니다.
 */
import { z } from "zod/v4";
import { withApiV1Principal } from "@/lib/api-v1-principal";
import {
  apiV1UploadCancelledResponseSchema,
  apiV1UploadSelectionInputSchema,
} from "@hra/contracts/api-v1";
import { cancelAssignmentUploadIntent } from "@/features/academics/assignment-uploads/server";
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

/** 경로 ID와 본문 과제 ID 이외의 저장키·역할·소유자 입력은 허용하지 않습니다. */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return withApiV1Principal(
    request,
    () => handleDelete(request, { params }),
    (code) => academicApiErrorResponse(new AcademicApiHttpError(code), crypto.randomUUID()),
  );
}

async function handleDelete(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const disabled = academicApiArtifactsDisabledResponse();
  if (disabled) return disabled;
  const observation = createAcademicObservation("UPLOAD_CANCEL", "UPLOAD_INTENT");
  try {
    const input = apiV1UploadSelectionInputSchema.safeParse(await readAcademicApiJson(request));
    if (!input.success) throw new AcademicApiHttpError("INVALID_INPUT");
    const id = z.uuid().safeParse((await params).id);
    if (!id.success) throw new AcademicApiHttpError("NOT_FOUND");
    await cancelAssignmentUploadIntent(
      { assignmentId: input.data.assignmentId, uploadIntentId: id.data },
      observation,
    );
    return Response.json(apiV1UploadCancelledResponseSchema.parse({ state: "CANCELLED" }), {
      headers: { ...academicApiHeaders, "X-Request-Id": observation.correlationId },
    });
  } catch (error) {
    recordUploadFailure(observation, error);
    return academicApiErrorResponse(error, observation.correlationId);
  }
}
