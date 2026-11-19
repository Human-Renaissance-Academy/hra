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

// ── #160 화면용 읽기 ─────────────────────────────────────────────────────────
// 인가가 필요한 조회는 같은 SQL 문 안에서 DB 현재 시각 기준 권한을 다시 판정하고, 권한이 없으면 null을 돌려줍니다.
// 홈페이지 ADMIN·FACULTY 역할은 판정 근거가 아니며(계정 상태 확인에만 사용), 쓰기 함수와 같은 조건을 따릅니다.

/** DB 현재 시각 기준 유효한 학사 운영 관리자 지정이 있는지 나타내는 SQL 조건입니다. */
export function activeManagerCondition(actorId: string): SQL {
  return sql`EXISTS (SELECT 1 FROM public.academic_operations_managers m
    JOIN public.users u ON u.id = m.user_id
    WHERE m.user_id = ${actorId}::uuid AND m.valid_from <= now() AND (m.valid_to IS NULL OR now() < m.valid_to)
      AND u.role::text IN ('ADMIN', 'FACULTY', 'MEMBER'))`;
}

/** 학사 운영 관리자에게만 기수 목록과 현재·예정(종료 전) 배정을 돌려줍니다. 예정 여부도 DB 현재 시각으로 계산합니다. 사유·확인 근거·이메일은 제외합니다. */
export function selectStaffOverview(actorId: string) {
  return single(sql`SELECT CASE WHEN ${activeManagerCondition(actorId)} THEN jsonb_build_object(
    'cohorts', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name)
      ORDER BY c."order", c.name, c.id) FROM public.cohorts c), '[]'::jsonb),
    'assignments', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', s.id, 'cohortId', s.cohort_id, 'userId', s.user_id, 'userName', u.name,
        'staffRole', s.staff_role, 'validFrom', s.valid_from, 'validTo', s.valid_to,
        'upcoming', now() < s.valid_from)
      ORDER BY s.cohort_id, s.staff_role, s.valid_from, s.id)
      FROM public.academic_cohort_staff_assignments s JOIN public.users u ON u.id = s.user_id
      WHERE s.valid_to IS NULL OR now() < s.valid_to), '[]'::jsonb)) END AS result`);
}

/** 학사 운영 관리자에게만 최근 감사 50건을 돌려줍니다. 입력 요약값·사유는 내보내지 않습니다. */
export function selectStaffAudit(actorId: string) {
  return single(sql`SELECT CASE WHEN ${activeManagerCondition(actorId)} THEN COALESCE((SELECT jsonb_agg(
      jsonb_build_object('id', x.request_id, 'action', x.action, 'actorName', x.actor_name,
        'cohortName', x.cohort_name, 'targetName', x.target_name, 'createdAt', x.created_at)
      ORDER BY x.created_at DESC, x.request_id)
    FROM (SELECT e.request_id, e.action, actor.name AS actor_name, c.name AS cohort_name,
        COALESCE(target.name, manager_user.name) AS target_name, e.created_at
      FROM public.academic_staff_events e
      JOIN public.users actor ON actor.id = e.actor_user_id
      LEFT JOIN public.academic_cohort_staff_assignments s
        ON s.id = COALESCE(e.replacement_assignment_id, e.assignment_id)
      LEFT JOIN public.cohorts c ON c.id = s.cohort_id
      LEFT JOIN public.users target ON target.id = s.user_id
      LEFT JOIN public.academic_operations_managers m ON m.id = e.manager_designation_id
      LEFT JOIN public.users manager_user ON manager_user.id = m.user_id
      ORDER BY e.created_at DESC, e.request_id LIMIT 50) x), '[]'::jsonb) END AS result`);
}

/** 로그인 계정 본인의 DB 현재 시각 기준 유효 배정 기수만 돌려줍니다. */
export function selectMyStaffCohorts(actorId: string) {
  return single(sql`SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'cohortId', s.cohort_id, 'cohortName', c.name, 'staffRole', s.staff_role, 'validTo', s.valid_to)
    ORDER BY c.name, s.cohort_id), '[]'::jsonb) AS result
    FROM public.academic_cohort_staff_assignments s
    JOIN public.cohorts c ON c.id = s.cohort_id
    JOIN public.users u ON u.id = s.user_id
    WHERE s.user_id = ${actorId}::uuid AND s.valid_from <= now() AND (s.valid_to IS NULL OR now() < s.valid_to)
      AND u.role::text IN ('ADMIN', 'FACULTY', 'MEMBER')`);
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
