/**
 * #163 수료 기준 버전·수료 결정의 PostgreSQL 저장소입니다.
 *
 * - 변경과 인가가 필요한 조회는 `scripts/migrate-academic-completion.sql`의 SQL 함수 한 번으로 확정합니다.
 *   (Neon HTTP는 대화형 트랜잭션이 없으므로 관리자 재판정·자기 결정 금지·순번 경합·감사를 함수 안에서 함께 처리합니다.)
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

export function insertCriteriaDraft(input: {
  requestId: string;
  actorId: string;
  correlationId: string;
  cohortId: string;
  criteria: unknown;
  reason: string;
}) {
  return single(sql`SELECT public.create_academic_completion_criteria(
    ${input.requestId}::uuid, ${input.actorId}::uuid, ${input.correlationId}::uuid,
    ${input.cohortId}::uuid, ${JSON.stringify(input.criteria)}::jsonb, ${input.reason}::text) AS result`);
}

export function saveCriteriaDraft(input: {
  requestId: string;
  actorId: string;
  correlationId: string;
  criteriaVersionId: string;
  criteria: unknown;
  reason: string;
}) {
  return single(sql`SELECT public.update_academic_completion_criteria(
    ${input.requestId}::uuid, ${input.actorId}::uuid, ${input.correlationId}::uuid,
    ${input.criteriaVersionId}::uuid, ${JSON.stringify(input.criteria)}::jsonb, ${input.reason}::text) AS result`);
}

export function savePublication(input: {
  requestId: string;
  actorId: string;
  correlationId: string;
  criteriaVersionId: string;
}) {
  return single(sql`SELECT public.publish_academic_completion_criteria(
    ${input.requestId}::uuid, ${input.actorId}::uuid, ${input.correlationId}::uuid,
    ${input.criteriaVersionId}::uuid) AS result`);
}

export function insertDecision(input: {
  requestId: string;
  actorId: string;
  correlationId: string;
  enrollmentId: string;
  criteriaVersionId: string;
  decision: string;
  reason: string;
  expectedSequence: number;
}) {
  return single(sql`SELECT public.record_academic_completion_decision(
    ${input.requestId}::uuid, ${input.actorId}::uuid, ${input.correlationId}::uuid,
    ${input.enrollmentId}::uuid, ${input.criteriaVersionId}::uuid, ${input.decision}::text,
    ${input.reason}::text, ${input.expectedSequence}::integer) AS result`);
}

/** 학사 운영 관리자 지정을 SQL 함수 안에서 확인한 뒤 기수 목록을 돌려줍니다. */
export function selectCohorts(actorId: string) {
  return single(sql`SELECT public.list_academic_completion_cohorts(${actorId}::uuid) AS result`);
}

/** 학사 운영 관리자 지정을 SQL 함수 안에서 확인한 뒤 수료 심사 명부를 돌려줍니다. */
export function selectRoster(actorId: string, cohortId: string, criteriaVersionId: string | null) {
  return single(sql`SELECT public.list_academic_completion_roster(
    ${actorId}::uuid, ${cohortId}::uuid, ${criteriaVersionId}::uuid) AS result`);
}

/** 로그인 계정에 연결된 본인 학적의 수료 상태만 돌려줍니다. */
export function selectOwnCompletion(actorId: string) {
  return single(sql`SELECT public.list_own_academic_completion(${actorId}::uuid) AS result`);
}
