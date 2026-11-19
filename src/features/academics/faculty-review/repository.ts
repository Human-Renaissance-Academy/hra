/**
 * #161 교수 계정 연결·수업별 과제 검토자 지정의 PostgreSQL 저장소입니다.
 *
 * - 변경은 `scripts/migrate-academic-faculty-reviewers.sql`의 범위 SQL 함수 한 번으로 확정합니다.
 *   (Neon HTTP는 대화형 트랜잭션이 없으므로 관리자 재검사·잠금·중복 금지·감사를 함수 안에서 함께 처리합니다.)
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

/** DB 현재 시각 기준 과제 검토 권한을 DB 함수로 판정합니다(시각 인자 없음). */
export async function hasAssignmentReviewAuthority(
  userId: string,
  assignmentId: string,
): Promise<boolean> {
  const result = await db.execute(sql`SELECT public.can_review_assignment(
    ${userId}::uuid, ${assignmentId}::uuid) AS result`);
  return result.rows[0]?.result === true;
}

/** 검토 가능한 과제 메타데이터 행을 DB 함수로 조회합니다. 판정 규칙은 SQL 판정 함수와 같습니다. */
export async function selectReviewableAssignments(userId: string): Promise<unknown[]> {
  const result = await db.execute(sql`SELECT assignment_id, cohort_id, schedule_event_id,
    schedule_session_id, title, status, due_at
    FROM public.list_reviewable_academic_assignments(${userId}::uuid)`);
  return result.rows;
}

export function insertFacultyAccountLink(input: {
  requestId: string;
  actorId: string;
  correlationId: string;
  facultyId: string;
  userId: string;
  validFrom: Instant;
  validTo: Instant;
  verificationMethod: string;
  evidenceReference: string;
}) {
  return single(sql`SELECT public.link_academic_faculty_account(
    ${input.requestId}::uuid, ${input.actorId}::uuid, ${input.correlationId}::uuid,
    ${input.facultyId}::uuid, ${input.userId}::uuid, ${input.validFrom}::timestamptz,
    ${input.validTo}::timestamptz, ${input.verificationMethod}::text,
    ${input.evidenceReference}::uuid) AS result`);
}

export function closeFacultyAccountLink(input: {
  requestId: string;
  actorId: string;
  correlationId: string;
  linkId: string;
  effectiveAt: Instant;
  reason: string;
}) {
  return single(sql`SELECT public.end_academic_faculty_account_link(
    ${input.requestId}::uuid, ${input.actorId}::uuid, ${input.correlationId}::uuid,
    ${input.linkId}::uuid, ${input.effectiveAt}::timestamptz, ${input.reason}::text) AS result`);
}

export function insertReviewerDesignation(input: {
  requestId: string;
  actorId: string;
  correlationId: string;
  facultyId: string;
  scheduleEventId: string;
  scheduleSessionId: string | null;
  validFrom: Instant;
  validTo: Instant;
}) {
  return single(sql`SELECT public.designate_academic_class_reviewer(
    ${input.requestId}::uuid, ${input.actorId}::uuid, ${input.correlationId}::uuid,
    ${input.facultyId}::uuid, ${input.scheduleEventId}::uuid, ${input.scheduleSessionId}::uuid,
    ${input.validFrom}::timestamptz, ${input.validTo}::timestamptz) AS result`);
}

export function closeReviewerDesignation(input: {
  requestId: string;
  actorId: string;
  correlationId: string;
  designationId: string;
  effectiveAt: Instant;
  reason: string;
}) {
  return single(sql`SELECT public.end_academic_class_reviewer(
    ${input.requestId}::uuid, ${input.actorId}::uuid, ${input.correlationId}::uuid,
    ${input.designationId}::uuid, ${input.effectiveAt}::timestamptz, ${input.reason}::text) AS result`);
}
