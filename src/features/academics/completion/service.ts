/**
 * #163 수료 기준 버전 관리와 수료 확정·취소 이력의 Application Service입니다.
 *
 * - 호출자: `actions.ts`(Server Action), `/member/academic-operations/completion`·`/member/completion` 화면,
 *   향후 `/api/v1` 어댑터. 요청 주체(Principal)는 호출자가 실제 세션·모바일 토큰에서 확정해 넘깁니다.
 * - 기능 플래그 `ACADEMIC_COMPLETION_ENABLED`·`ACADEMIC_STAFF_ENABLED`·`ACADEMIC_ENABLED`(모두 기본 false)가
 *   정확히 "true"가 아니면 DB에 접속하지 않고 거부합니다(정책 운영 승인 전 비활성).
 * - 권한 판정은 SQL 함수 안에서 DB 현재 시각 기준으로 다시 수행합니다. 기준 작성·공개·수료 결정·명부 조회는
 *   #165 학사 운영 관리자 지정만 근거로 하며, 홈페이지 `ADMIN`·`FACULTY` 역할은 어떤 판정에도 쓰지 않습니다.
 * - 시스템은 보조 지표만 계산하고 수료를 자동 결정하지 않습니다(P14).
 */
import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import {
  isAcademicStaffPrincipal,
  type AcademicStaffPrincipal,
} from "@/features/academics/staff/contracts";
import {
  AcademicCompletionError,
  cohortListSchema,
  createCriteriaSchema,
  criteriaResultSchema,
  decisionResultSchema,
  ownCompletionSchema,
  publishCriteriaSchema,
  recordDecisionSchema,
  rosterQuerySchema,
  rosterSchema,
  toAcademicCompletionError,
  updateCriteriaSchema,
} from "./contracts";
import {
  insertCriteriaDraft,
  insertDecision,
  saveCriteriaDraft,
  savePublication,
  selectCohorts,
  selectOwnCompletion,
  selectRoster,
} from "./repository";

/** 정책 운영 승인 전에는 false입니다. 세 플래그가 모두 정확히 "true"일 때만 켭니다. */
export function isAcademicCompletionEnabled(): boolean {
  return (
    process.env.ACADEMIC_ENABLED === "true" &&
    process.env.ACADEMIC_STAFF_ENABLED === "true" &&
    process.env.ACADEMIC_COMPLETION_ENABLED === "true"
  );
}

/** 주체 형식 → 승인 대기 계정 → 기능 플래그 순서로 확인해 비활성 환경에서는 학사 표를 조회하지 않습니다. */
function requireActor(principal: unknown): AcademicStaffPrincipal {
  if (!isAcademicStaffPrincipal(principal)) throw new AcademicCompletionError("UNAUTHENTICATED");
  if (principal.role === "PENDING") throw new AcademicCompletionError("FORBIDDEN");
  if (!isAcademicCompletionEnabled()) throw new AcademicCompletionError("DISABLED");
  return principal;
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new AcademicCompletionError("INVALID_INPUT");
  return parsed.data;
}

/** 저장소 호출과 결과 형식 검증을 묶고, 실패는 고정 오류 코드로만 바꿉니다. */
async function run<T>(schema: z.ZodType<T>, call: () => Promise<unknown>): Promise<T> {
  let raw: unknown;
  try {
    raw = await call();
  } catch (error) {
    throw toAcademicCompletionError(error);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new AcademicCompletionError("UNAVAILABLE");
  return parsed.data;
}

/** 기수의 새 수료 기준 초안을 만듭니다. 기수당 초안은 하나이며 버전 번호는 DB가 이어서 부여합니다. */
export async function createCriteriaDraft(principal: unknown, input: unknown) {
  const actor = requireActor(principal);
  const data = parse(createCriteriaSchema, input);
  return run(criteriaResultSchema, () =>
    insertCriteriaDraft({
      requestId: data.requestId,
      actorId: actor.userId,
      correlationId: randomUUID(),
      cohortId: data.cohortId,
      criteria: data.criteria,
      reason: data.reason,
    }),
  );
}

/** 초안 내용을 고칩니다. 공개된 버전은 CONFLICT로 거부합니다(공개 후 불변). */
export async function updateCriteriaDraft(principal: unknown, input: unknown) {
  const actor = requireActor(principal);
  const data = parse(updateCriteriaSchema, input);
  return run(criteriaResultSchema, () =>
    saveCriteriaDraft({
      requestId: data.requestId,
      actorId: actor.userId,
      correlationId: randomUUID(),
      criteriaVersionId: data.criteriaVersionId,
      criteria: data.criteria,
      reason: data.reason,
    }),
  );
}

/** 초안을 공개합니다. 이후 내용은 바뀌지 않고, 수료 결정은 공개된 버전만 참조합니다. */
export async function publishCriteria(principal: unknown, input: unknown) {
  const actor = requireActor(principal);
  const data = parse(publishCriteriaSchema, input);
  return run(criteriaResultSchema, () =>
    savePublication({
      requestId: data.requestId,
      actorId: actor.userId,
      correlationId: randomUUID(),
      criteriaVersionId: data.criteriaVersionId,
    }),
  );
}

/**
 * 수료·미수료·수료 취소를 사유와 함께 기록합니다. 본인 학적은 결정할 수 없고(FORBIDDEN),
 * `expectedSequence`가 현재 순번과 다르면 VERSION_CONFLICT입니다. 이전 결정은 지우지 않고 새 결정이 대체합니다.
 */
export async function recordCompletionDecision(principal: unknown, input: unknown) {
  const actor = requireActor(principal);
  const data = parse(recordDecisionSchema, input);
  return run(decisionResultSchema, () =>
    insertDecision({
      requestId: data.requestId,
      actorId: actor.userId,
      correlationId: randomUUID(),
      enrollmentId: data.enrollmentId,
      criteriaVersionId: data.criteriaVersionId,
      decision: data.decision,
      reason: data.reason,
      expectedSequence: data.expectedSequence,
    }),
  );
}

/** 학사 운영 관리자용 기수 목록입니다. */
export async function listCompletionCohorts(principal: unknown) {
  const actor = requireActor(principal);
  return run(cohortListSchema, () => selectCohorts(actor.userId));
}

/** 학사 운영 관리자용 수료 심사 명부(기준 버전·학적별 보조 지표·결정 이력)입니다. */
export async function getCompletionRoster(principal: unknown, query: unknown) {
  const actor = requireActor(principal);
  const data = parse(rosterQuerySchema, query);
  return run(rosterSchema, () =>
    selectRoster(actor.userId, data.cohortId, data.criteriaVersionId ?? null),
  );
}

/** 학생 본인 수료 상태. 로그인 계정에 연결된 본인 학적만 조회하며 다른 사람의 기록은 받을 방법이 없습니다. */
export async function listOwnCompletion(principal: unknown) {
  const actor = requireActor(principal);
  return run(ownCompletionSchema, () => selectOwnCompletion(actor.userId));
}
