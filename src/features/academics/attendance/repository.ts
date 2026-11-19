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
import { activeManagerCondition } from "@/features/academics/staff/repository";

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

// ── #160 화면용 읽기 ─────────────────────────────────────────────────────────
// 인가가 필요한 조회는 같은 SQL 문 안에서 DB 현재 시각 기준 권한을 다시 판정하고, 권한이 없으면 null을 돌려줍니다.

/** 해당 기수에 유효하게 배정된 운영 인력에게만 그 기수의 CLASS 수업일과 7일 입력 창을 돌려줍니다. */
export function selectClassSessions(actorId: string, cohortId: string) {
  return single(sql`SELECT CASE WHEN public.can_record_academic_attendance(${actorId}::uuid, ${cohortId}::uuid)
    THEN COALESCE((SELECT jsonb_agg(jsonb_build_object('id', e.id, 'title', e.title, 'weekNumber', e.week_number,
        'classDate', public.academic_attendance_class_date(e.event_date),
        'windowOpensAt', lower(w.win), 'windowClosesAt', upper(w.win)) ORDER BY e.event_date, e.id)
      FROM public.schedule_events e
      CROSS JOIN LATERAL public.academic_attendance_window(public.academic_attendance_class_date(e.event_date)) AS w(win)
      WHERE e.cohort_id = ${cohortId}::uuid AND e.event_type::text = 'CLASS' AND e.event_date IS NOT NULL), '[]'::jsonb)
    END AS result`);
}

/** 학사 운영 관리자에게만 대기 중 정정 요청을 돌려줍니다. 요청자 신원 대신 본인 요청 여부만 계산합니다. */
export function selectPendingCorrectionsForManager(actorId: string) {
  return single(sql`SELECT CASE WHEN ${activeManagerCondition(actorId)} THEN COALESCE((SELECT jsonb_agg(
      jsonb_build_object('id', c.id, 'scheduleEventId', c.schedule_event_id, 'cohortName', co.name,
        'eventTitle', e.title, 'classDate', c.class_date, 'displayName', st.display_name,
        'previousStatus', c.previous_status, 'requestedStatus', c.requested_status, 'reason', c.reason,
        'excuseVerificationMethod', c.excuse_verification_method, 'requestedAt', c.requested_at,
        'requestedBySelf', c.requested_by_user_id = ${actorId}::uuid)
      ORDER BY c.requested_at, c.id)
    FROM public.academic_attendance_corrections c
    JOIN public.cohorts co ON co.id = c.cohort_id
    JOIN public.schedule_events e ON e.id = c.schedule_event_id
    JOIN public.cohort_enrollments ce ON ce.id = c.enrollment_id
    JOIN public.academic_students st ON st.id = ce.student_id
    WHERE c.status = 'PENDING'), '[]'::jsonb) END AS result`);
}

/** 로그인 계정에 연결된 본인 학적의 기수 이름과 정정 요약만 돌려줍니다(사유·운영 인력 식별자 제외). */
export function selectOwnAttendanceContext(actorId: string) {
  return single(sql`SELECT jsonb_build_object(
    'cohorts', COALESCE((SELECT jsonb_agg(DISTINCT jsonb_build_object('id', co.id, 'name', co.name))
      FROM public.academic_students st
      JOIN public.users u ON u.id = st.user_id AND u.role::text IN ('ADMIN', 'FACULTY', 'MEMBER')
      JOIN public.cohort_enrollments ce ON ce.student_id = st.id
      JOIN public.cohorts co ON co.id = ce.cohort_id
      WHERE st.user_id = ${actorId}::uuid), '[]'::jsonb),
    'corrections', COALESCE((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'cohortId', c.cohort_id,
        'classDate', c.class_date, 'previousStatus', c.previous_status, 'requestedStatus', c.requested_status,
        'status', c.status, 'requestedAt', c.requested_at, 'decidedAt', c.decided_at)
      ORDER BY c.requested_at DESC, c.id)
      FROM public.academic_attendance_corrections c
      JOIN public.cohort_enrollments ce ON ce.id = c.enrollment_id
      JOIN public.academic_students st ON st.id = ce.student_id
      JOIN public.users u ON u.id = st.user_id AND u.role::text IN ('ADMIN', 'FACULTY', 'MEMBER')
      WHERE st.user_id = ${actorId}::uuid), '[]'::jsonb)) AS result`);
}

/** 메뉴 노출용 판정(관리자 지정·유효 배정·연결된 학생 학적 여부). 각 화면·액션은 권한을 다시 확인합니다. */
export function selectAttendanceAccess(actorId: string) {
  return single(sql`SELECT jsonb_build_object(
    'manager', ${activeManagerCondition(actorId)},
    'staff', EXISTS (SELECT 1 FROM public.academic_cohort_staff_assignments s
      JOIN public.users u ON u.id = s.user_id
      WHERE s.user_id = ${actorId}::uuid AND s.valid_from <= now() AND (s.valid_to IS NULL OR now() < s.valid_to)
        AND u.role::text IN ('ADMIN', 'FACULTY', 'MEMBER')),
    'student', EXISTS (SELECT 1 FROM public.academic_students st
      JOIN public.users u ON u.id = st.user_id AND u.role::text IN ('ADMIN', 'FACULTY', 'MEMBER')
      JOIN public.cohort_enrollments ce ON ce.student_id = st.id
      WHERE st.user_id = ${actorId}::uuid)) AS result`);
}

/** 로그인 계정에 연결된 본인 학적의 출결만 돌려줍니다. */
export function selectOwnAttendance(actorId: string) {
  return single(sql`SELECT public.list_own_academic_attendance(${actorId}::uuid) AS result`);
}
