/**
 * 비공개 학사 업로드 정리의 명시적 운영 진입점이다.
 *
 * - vercel.json 에 자동 예약되어 있지 않으며, 운영자가 승인한 뒤에만 호출한다.
 * - CRON_SECRET 이 설정되기 전에는 저장소·DB 에 접근하지 않고 503 으로 거절한다.
 * - 삭제는 ACADEMIC_UPLOAD_CLEANUP_DELETE_ENABLED 가 정확히 "true" 일 때만 수행하며,
 *   그 외에는 항상 dryRun 으로 동작한다.
 */
import { timingSafeEqual } from "node:crypto";
import { cleanupAcademicUploads } from "@/features/academics/assignment-uploads/cleanup";
import { uploadErrorResponse } from "@/features/academics/assignment-uploads/http";
import { createAcademicObservation } from "@/lib/academic-observability";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const observation = createAcademicObservation("UPLOAD_CLEANUP", "UPLOAD_INTENT");
  const headers = { "Cache-Control": "no-store", "X-Request-Id": observation.correlationId };
  // 인증 비밀이 없으면 어떤 작업도 시작하지 않는다(설정 전 접근 차단).
  const secret = process.env.CRON_SECRET;
  const supplied = request.headers.get("authorization");
  if (!secret) {
    observation.emit("FAILED", { failureCode: "GATE" });
    return Response.json(
      { error: "정리 작업을 준비하고 있습니다.", referenceId: observation.correlationId },
      { status: 503, headers },
    );
  }
  // 길이를 먼저 비교한 뒤 상수 시간 비교로 Bearer 토큰을 검증해 타이밍 정보 노출을 막는다.
  const actual = Buffer.from(supplied?.startsWith("Bearer ") ? supplied.slice(7) : "");
  const expected = Buffer.from(secret);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    observation.emit("DENIED", { failureCode: "AUTHORIZATION" });
    return Response.json(
      { error: "인증이 필요합니다.", referenceId: observation.correlationId },
      { status: 401, headers },
    );
  }
  // 삭제 플래그가 명시적으로 켜진 경우에만 실제 삭제하고, 기본값은 dryRun 이다.
  try {
    return Response.json(
      {
        ...(await cleanupAcademicUploads(
          { dryRun: process.env.ACADEMIC_UPLOAD_CLEANUP_DELETE_ENABLED !== "true" },
          observation,
        )),
        referenceId: observation.correlationId,
      },
      { headers },
    );
  } catch (error) {
    return uploadErrorResponse(error, observation);
  }
}
