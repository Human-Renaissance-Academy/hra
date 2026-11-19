/**
 * #159 학생별 출결의 PostgreSQL 저장소입니다.
 *
 * - 변경과 인가가 필요한 조회는 `scripts/migrate-academic-attendance.sql`의 SQL 함수 한 번으로 확정합니다.
 *   (Neon HTTP는 대화형 트랜잭션이 없으므로 운영 인력 재판정·입력 창·셀 잠금·버전·이력을 함수 안에서 함께 처리합니다.)
 * - 입력 검증과 오류 변환은 서비스가 맡고, 여기서는 이미 검증된 값만 SQL 매개변수로 전달합니다.
 */
import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";

// 공통: 첫 행의 jsonb 결과만 꺼냅니다. 형식 검증은 서비스의 DTO 스키마가 수행합니다.
async function single(query: SQL): Promise<unknown> {
  const result = await db.execute(query);
  return result.rows[0]?.result;
}

export function saveAttendance(input: {
  requestId: string;
  actorId: string;
  correlationId: string;
  scheduleEventId: string;
  enrollmentId: string;
  status: string;
  expectedVersion: number;
}) {
  return single(sql`SELECT public.record_academic_attendance(
    ${input.requestId}::uuid, ${input.actorId}::uuid, ${input.correlationId}::uuid,
    ${input.scheduleEventId}::uuid, ${input.enrollmentId}::uuid, ${input.status}::text,
    ${input.expectedVersion}::integer) AS result`);
}

export function insertCorrectionRequest(input: {
  requestId: string;
  actorId: string;
  correlationId: string;
  scheduleEventId: string;
  enrollmentId: string;
  requestedStatus: string;
  expectedVersion: number;
  reason: string;
  excuseVerificationMethod: string | null;
}) {
  return single(sql`SELECT public.request_academic_attendance_correction(
    ${input.requestId}::uuid, ${input.actorId}::uuid, ${input.correlationId}::uuid,
    ${input.scheduleEventId}::uuid, ${input.enrollmentId}::uuid, ${input.requestedStatus}::text,
    ${input.expectedVersion}::integer, ${input.reason}::text, ${input.excuseVerificationMethod}::text) AS result`);
}

export function saveCorrectionDecision(input: {
  requestId: string;
  actorId: string;
  correlationId: string;
  correctionId: string;
  decision: string;
}) {
  return single(sql`SELECT public.decide_academic_attendance_correction(
    ${input.requestId}::uuid, ${input.actorId}::uuid, ${input.correlationId}::uuid,
    ${input.correctionId}::uuid, ${input.decision}::text) AS result`);
}

/** 운영 인력 인가를 SQL 함수 안에서 다시 확인한 뒤 수업일 출결표를 돌려줍니다. */
export function selectEventSheet(actorId: string, scheduleEventId: string) {
  return single(sql`SELECT public.list_academic_attendance_for_event(
    ${actorId}::uuid, ${scheduleEventId}::uuid) AS result`);
}

/** 로그인 계정에 연결된 본인 학적의 출결만 돌려줍니다. */
export function selectOwnAttendance(actorId: string) {
  return single(sql`SELECT public.list_own_academic_attendance(${actorId}::uuid) AS result`);
}
