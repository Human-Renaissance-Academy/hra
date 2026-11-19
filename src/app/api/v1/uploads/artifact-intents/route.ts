/**
 * #516 텍스트·발표자료 분리 제출(V2)의 업로드 의도를 발급하는 API v1 어댑터입니다.
 *
 * 역할:
 * - (과제, 산출물 유형, 선언 형식)마다 PR-D 서비스(createAssignmentArtifactUploadIntent)로 의도를 발급합니다.
 * - 응답의 pathname·contentType으로만 기존 SDK 토큰 경로(`POST /api/v1/uploads`)에서 비공개 업로드할 수 있습니다.
 *
 * 주의:
 * - 분리 제출 gate가 꺼져 있으면 본문을 읽기 전에 404입니다.
 * - 요청 주체는 입력이 아니라 Bearer/세션 Principal에서 얻고, 대상·기한·예산·원장 검사는 서비스와 DB 함수가 합니다.
 * - 파일 거부 사유(미사용 항목·형식 불일치 등)는 공개 코드를 늘리지 않고 INVALID_INPUT(400)으로 응답합니다.
 */
import {
  apiV1ArtifactUploadIntentInputSchema,
  apiV1ArtifactUploadIntentResponseSchema,
} from "@hra/contracts/api-v1";
import { createAssignmentArtifactUploadIntent } from "@/features/academics/assignment-uploads/artifacts";
import { recordUploadFailure } from "@/features/academics/assignment-uploads/observability";
import {
  AcademicApiHttpError,
  academicApiErrorResponse,
  academicApiHeaders,
  academicApiArtifactsDisabledResponse,
  readAcademicApiJson,
} from "@/features/academics/api-v1/http";
import { createAcademicObservation } from "@/lib/academic-observability";
import { withApiV1Principal } from "@/lib/api-v1-principal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 요청의 식별자를 인증 정보로 사용하지 않으며 서비스가 확인한 의도 결과만 반환합니다. */
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
  const observation = createAcademicObservation("UPLOAD_INTENT", "UPLOAD_INTENT");
  try {
    const input = apiV1ArtifactUploadIntentInputSchema.safeParse(
      await readAcademicApiJson(request),
    );
    if (!input.success) throw new AcademicApiHttpError("INVALID_INPUT");
    const result = await createAssignmentArtifactUploadIntent(input.data, observation);
    const body = apiV1ArtifactUploadIntentResponseSchema.parse({
      uploadIntentId: result.uploadIntentId,
      artifactType: result.artifactType,
      fileFormat: result.fileFormat,
      pathname: result.pathname,
      contentType: result.contentType,
      expiresAt: result.expiresAt,
    });
    return Response.json(body, {
      headers: { ...academicApiHeaders, "X-Request-Id": observation.correlationId },
    });
  } catch (error) {
    recordUploadFailure(observation, error);
    return academicApiErrorResponse(error, observation.correlationId);
  }
}
