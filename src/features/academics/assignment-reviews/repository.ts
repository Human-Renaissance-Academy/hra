/**
 * #162 과제 검토·피드백의 PostgreSQL 저장소입니다.
 *
 * - 변경·열람 허가는 `scripts/migrate-academic-assignment-reviews.sql`의 범위 SQL 함수 한 번으로 확정합니다.
 *   (Neon HTTP는 대화형 트랜잭션이 없으므로 권한 재판정·자기 검토 금지·버전 확인·이력·감사를 함수 안에서 함께 처리합니다.)
 * - 입력 검증과 오류 변환은 서비스가 맡고, 여기서는 이미 검증된 값만 SQL 매개변수로 전달합니다.
 */
import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";

// 첫 행의 단일 결과만 꺼냅니다. 형식 검증은 서비스의 DTO 스키마가 수행합니다.
async function single(query: SQL): Promise<unknown> {
  const result = await db.execute(query);
  return result.rows[0]?.result;
}

/** 검토자가 볼 수 있는 과제의 제출물과 본인 피드백 행입니다. 권한이 없으면 빈 목록입니다. */
export async function selectReviewSubmissions(
  userId: string,
  assignmentId: string,
): Promise<unknown[]> {
  const result =
    await db.execute(sql`SELECT submission_id, file_id, student_display_name, submitted_at,
    review_id, review_version, review_status, review_visibility, review_body, review_grade_label, review_updated_at
    FROM public.list_academic_review_submissions(${userId}::uuid, ${assignmentId}::uuid)`);
  return result.rows;
}

export function saveReview(input: {
  actorId: string;
  submissionId: string;
  expectedVersion: number;
  body: string;
  gradeLabel: string | null;
  reason: string | null;
}) {
  return single(sql`SELECT public.save_academic_assignment_review(${input.actorId}::uuid,
    ${input.submissionId}::uuid, ${input.expectedVersion}::integer, ${input.body}::text,
    ${input.gradeLabel}::text, ${input.reason}::text) AS result`);
}

export function submitReview(input: {
  actorId: string;
  reviewId: string;
  expectedVersion: number;
}) {
  return single(sql`SELECT public.submit_academic_assignment_review(${input.actorId}::uuid,
    ${input.reviewId}::uuid, ${input.expectedVersion}::integer) AS result`);
}

export function publishFeedback(input: {
  actorId: string;
  reviewId: string;
  expectedVersion: number;
}) {
  return single(sql`SELECT public.publish_academic_assignment_feedback(${input.actorId}::uuid,
    ${input.reviewId}::uuid, ${input.expectedVersion}::integer) AS result`);
}

export function retractFeedback(input: {
  actorId: string;
  reviewId: string;
  expectedVersion: number;
  reason: string;
}) {
  return single(sql`SELECT public.retract_academic_assignment_feedback(${input.actorId}::uuid,
    ${input.reviewId}::uuid, ${input.expectedVersion}::integer, ${input.reason}::text) AS result`);
}

/** 학사 운영 관리자의 공개 대상 목록(jsonb 배열)입니다. 관리자 지정은 DB가 다시 확인합니다. */
export function selectFeedbackForPublication(actorId: string) {
  return single(
    sql`SELECT public.list_academic_feedback_for_publication(${actorId}::uuid) AS result`,
  );
}

/** 학생 본인에게 공개된 피드백 행입니다. */
export async function selectPublishedFeedback(
  userId: string,
  assignmentId: string,
): Promise<unknown[]> {
  const result = await db.execute(sql`SELECT review_id, body, grade_label, published_at
    FROM public.list_published_academic_feedback(${userId}::uuid, ${assignmentId}::uuid)`);
  return result.rows;
}

/** 검토자 파일 전달 허가와 감사 행을 한 SQL 함수로 확정하고 파일 메타데이터(jsonb)를 받습니다. */
export function authorizeReviewerFileRead(userId: string, submissionId: string, fileId: string) {
  return single(sql`SELECT public.authorize_academic_review_file_read(${userId}::uuid,
    ${submissionId}::uuid, ${fileId}::uuid) AS result`);
}
