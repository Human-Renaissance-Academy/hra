/**
 * #165 운영 인력 배정의 PostgreSQL 저장소입니다.
 *
 * - 변경은 `scripts/migrate-academic-staff-assignments.sql`의 범위 SQL 함수 한 번으로 확정합니다.
 *   (Neon HTTP는 대화형 트랜잭션이 없으므로 권한 재검사·잠금·상한·감사를 함수 안에서 함께 처리합니다.)
 * - 입력 검증과 오류 변환은 서비스가 맡고, 여기서는 이미 검증된 값만 SQL 매개변수로 전달합니다.
 */
import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";

type Instant = string | null;

// 공통: 첫 행의 jsonb 결과만 꺼냅니다. 형식 검증은 서비스의 DTO 스키마가 수행합니다.
async function single(query: SQL): Promise<unknown> {
  const result = await db.execute(query);
  return result.rows[0]?.result;
}

/** 해당 기수에 DB 현재 시각 기준 유효한 어드바이저·조교 배정이 있는지 DB 함수로 판정합니다(시각 인자 없음). */
export async function hasActiveStaffAssignment(userId: string, cohortId: string): Promise<boolean> {
  const result = await db.execute(sql`SELECT public.can_record_academic_attendance(
    ${userId}::uuid, ${cohortId}::uuid) AS result`);
  return result.rows[0]?.result === true;
}

export function insertStaffAssignment(input: {
  requestId: string;
  actorId: string;
  correlationId: string;
  cohortId: string;
  userId: string;
  staffRole: string;
  validFrom: Instant;
  validTo: Instant;
  verificationMethod: string;
  evidenceReference: string;
}) {
  return single(sql`SELECT public.assign_academic_cohort_staff(
    ${input.requestId}::uuid, ${input.actorId}::uuid, ${input.correlationId}::uuid,
    ${input.cohortId}::uuid, ${input.userId}::uuid, ${input.staffRole}::text,
    ${input.validFrom}::timestamptz, ${input.validTo}::timestamptz,
    ${input.verificationMethod}::text, ${input.evidenceReference}::uuid) AS result`);
}

export function closeStaffAssignment(input: {
  requestId: string;
  actorId: string;
  correlationId: string;
  assignmentId: string;
  effectiveAt: Instant;
  reason: string;
}) {
  return single(sql`SELECT public.end_academic_cohort_staff(
    ${input.requestId}::uuid, ${input.actorId}::uuid, ${input.correlationId}::uuid,
    ${input.assignmentId}::uuid, ${input.effectiveAt}::timestamptz, ${input.reason}::text) AS result`);
}

export function swapStaffAssignment(input: {
  requestId: string;
  actorId: string;
  correlationId: string;
  assignmentId: string;
  userId: string;
  effectiveAt: Instant;
  reason: string;
  verificationMethod: string;
  evidenceReference: string;
}) {
  return single(sql`SELECT public.replace_academic_cohort_staff(
    ${input.requestId}::uuid, ${input.actorId}::uuid, ${input.correlationId}::uuid,
    ${input.assignmentId}::uuid, ${input.userId}::uuid, ${input.effectiveAt}::timestamptz,
    ${input.reason}::text, ${input.verificationMethod}::text, ${input.evidenceReference}::uuid) AS result`);
}

export function insertManagerDesignation(input: {
  requestId: string;
  actorId: string;
  approverId: string;
  correlationId: string;
  userId: string;
  validFrom: Instant;
  validTo: Instant;
  verificationMethod: string;
  evidenceReference: string;
}) {
  return single(sql`SELECT public.designate_academic_operations_manager(
    ${input.requestId}::uuid, ${input.actorId}::uuid, ${input.approverId}::uuid, ${input.correlationId}::uuid,
    ${input.userId}::uuid, ${input.validFrom}::timestamptz, ${input.validTo}::timestamptz,
    ${input.verificationMethod}::text, ${input.evidenceReference}::uuid) AS result`);
}

export function closeManagerDesignation(input: {
  requestId: string;
  actorId: string;
  approverId: string;
  correlationId: string;
  designationId: string;
  effectiveAt: Instant;
  reason: string;
}) {
  return single(sql`SELECT public.end_academic_operations_manager(
    ${input.requestId}::uuid, ${input.actorId}::uuid, ${input.approverId}::uuid, ${input.correlationId}::uuid,
    ${input.designationId}::uuid, ${input.effectiveAt}::timestamptz, ${input.reason}::text) AS result`);
}
