/**
 * #165 기수별 운영 인력 배정과 출결 권한 판정의 Application Service입니다.
 *
 * - 호출자: 향후 #160 Server Action·`/api/v1` 어댑터와 #159 출결 서비스. 이 PR에는 화면·라우트가 없습니다.
 * - 요청 주체(Principal)는 호출자가 실제 세션·모바일 토큰에서 확정해 넘깁니다. 클라이언트 입력으로 받지 않습니다.
 * - 기능 플래그 `ACADEMIC_STAFF_ENABLED`(기본 false)와 `ACADEMIC_ENABLED`가 모두 정확히 "true"가 아니면
 *   DB에 접속하지 않고 거부하며, 출결 권한 판정은 항상 false입니다(정책 운영 승인 전 비활성).
 * - 홈페이지 `ADMIN`·`FACULTY` 역할은 어떤 판정에도 쓰지 않습니다. 관리자 권한은 DB의 학사 운영 관리자 지정,
 *   관리자 지정 권한은 G1 지정 승인자(`ACADEMIC_APPROVER_USER_ID`)로만 판단합니다.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { getAcademicApproverId } from "@/lib/academic-admin";
import {
  AcademicStaffError,
  assignStaffSchema,
  assignmentResultSchema,
  designateManagerSchema,
  designationResultSchema,
  endManagerSchema,
  endStaffSchema,
  isAcademicStaffPrincipal,
  replaceStaffSchema,
  replacementResultSchema,
  toAcademicStaffError,
  type AcademicStaffPrincipal,
} from "./contracts";
import {
  closeManagerDesignation,
  closeStaffAssignment,
  hasActiveStaffAssignment,
  insertManagerDesignation,
  insertStaffAssignment,
  swapStaffAssignment,
} from "./repository";

/** 정책 운영 승인 전에는 false입니다. 두 플래그가 정확히 "true"일 때만 켭니다. */
export function isAcademicStaffEnabled(): boolean {
  return process.env.ACADEMIC_ENABLED === "true" && process.env.ACADEMIC_STAFF_ENABLED === "true";
}

/** 주체 형식 → 승인 대기 계정 → 기능 플래그 순서로 확인해 비활성 환경에서는 학사 표를 조회하지 않습니다. */
function requireActor(principal: unknown): AcademicStaffPrincipal {
  if (!isAcademicStaffPrincipal(principal)) throw new AcademicStaffError("UNAUTHENTICATED");
  if (principal.role === "PENDING") throw new AcademicStaffError("FORBIDDEN");
  if (!isAcademicStaffEnabled()) throw new AcademicStaffError("DISABLED");
  return principal;
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new AcademicStaffError("INVALID_INPUT");
  return parsed.data;
}

/** 저장소 호출과 결과 형식 검증을 묶고, 실패는 고정 오류 코드로만 바꿉니다. */
async function run<T>(schema: z.ZodType<T>, call: () => Promise<unknown>): Promise<T> {
  let raw: unknown;
  try {
    raw = await call();
  } catch (error) {
    throw toAcademicStaffError(error);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new AcademicStaffError("UNAVAILABLE");
  return parsed.data;
}

/**
 * 출결 기록 권한의 중앙 판정입니다(#159·#160의 모든 출결 경로가 사용).
 * 해당 기수에 시각 `at` 기준 유효한 ADVISOR·ASSISTANT 배정이 있고 계정이 승인 대기 상태가 아닐 때만 true입니다.
 * `at`은 서버가 정한 기록 시각이어야 하며 클라이언트 값을 그대로 넘기지 않습니다. 기본값은 현재 시각입니다.
 * 배정 종료·계정 PENDING 전환은 다음 호출부터 즉시 반영됩니다(세션에 권한을 저장하지 않음).
 */
export async function canRecordAttendance(
  principal: unknown,
  cohortId: string,
  at: Date = new Date(),
): Promise<boolean> {
  if (!isAcademicStaffPrincipal(principal) || principal.role === "PENDING") return false;
  if (!isAcademicStaffEnabled()) return false;
  if (!z.uuid().safeParse(cohortId).success || !(at instanceof Date) || Number.isNaN(at.getTime()))
    return false;
  try {
    return await hasActiveStaffAssignment(principal.userId, cohortId, at.toISOString());
  } catch (error) {
    // 판정 불가를 거부(false)로 숨기지 않고 503 계열로 알립니다. 호출자는 실패 시 기록하지 않습니다.
    throw toAcademicStaffError(error);
  }
}

/** 학사 운영 관리자가 기수에 어드바이저·조교를 배정합니다. 자기 배정·상한 초과·기간 중복은 DB가 거부합니다. */
export async function assignCohortStaff(principal: unknown, input: unknown) {
  const actor = requireActor(principal);
  const data = parse(assignStaffSchema, input);
  return run(assignmentResultSchema, () =>
    insertStaffAssignment({
      requestId: data.requestId,
      actorId: actor.userId,
      correlationId: randomUUID(),
      cohortId: data.cohortId,
      userId: data.userId,
      staffRole: data.staffRole,
      validFrom: data.validFrom ?? null,
      validTo: data.validTo ?? null,
      verificationMethod: data.verificationMethod,
      evidenceReference: data.evidenceReference,
    }),
  );
}

/** 배정을 종료(해제)합니다. 종료 시각은 현재 이후만 허용하며 과거 행은 종료 기록 외에 바뀌지 않습니다. */
export async function endCohortStaffAssignment(principal: unknown, input: unknown) {
  const actor = requireActor(principal);
  const data = parse(endStaffSchema, input);
  return run(assignmentResultSchema, () =>
    closeStaffAssignment({
      requestId: data.requestId,
      actorId: actor.userId,
      correlationId: randomUUID(),
      assignmentId: data.assignmentId,
      effectiveAt: data.effectiveAt ?? null,
      reason: data.reason,
    }),
  );
}

/** 교체: 기존 배정 종료와 같은 기수·역할의 새 배정 추가를 한 번에 확정합니다(P3). */
export async function replaceCohortStaff(principal: unknown, input: unknown) {
  const actor = requireActor(principal);
  const data = parse(replaceStaffSchema, input);
  return run(replacementResultSchema, () =>
    swapStaffAssignment({
      requestId: data.requestId,
      actorId: actor.userId,
      correlationId: randomUUID(),
      assignmentId: data.assignmentId,
      userId: data.userId,
      effectiveAt: data.effectiveAt ?? null,
      reason: data.reason,
      verificationMethod: data.verificationMethod,
      evidenceReference: data.evidenceReference,
    }),
  );
}

/** 설정된 G1 지정 승인자 ID를 읽습니다. 미설정이면 누구도 관리자 지정을 할 수 없습니다. */
function requireApprover(actor: AcademicStaffPrincipal): string {
  let approverId: string;
  try {
    approverId = getAcademicApproverId();
  } catch {
    throw new AcademicStaffError("FORBIDDEN");
  }
  if (approverId !== actor.userId) throw new AcademicStaffError("FORBIDDEN");
  return approverId;
}

/** G1 지정 승인자가 다른 검증된 계정을 학사 운영 관리자로 지정합니다(P1). 자기 지정은 금지합니다. */
export async function designateOperationsManager(principal: unknown, input: unknown) {
  const actor = requireActor(principal);
  const approverId = requireApprover(actor);
  const data = parse(designateManagerSchema, input);
  return run(designationResultSchema, () =>
    insertManagerDesignation({
      requestId: data.requestId,
      actorId: actor.userId,
      approverId,
      correlationId: randomUUID(),
      userId: data.userId,
      validFrom: data.validFrom ?? null,
      validTo: data.validTo ?? null,
      verificationMethod: data.verificationMethod,
      evidenceReference: data.evidenceReference,
    }),
  );
}

/** G1 지정 승인자가 학사 운영 관리자 지정을 종료합니다. 종료 이후 그 계정의 배정·교체 요청은 거부됩니다. */
export async function endOperationsManagerDesignation(principal: unknown, input: unknown) {
  const actor = requireActor(principal);
  const approverId = requireApprover(actor);
  const data = parse(endManagerSchema, input);
  return run(designationResultSchema, () =>
    closeManagerDesignation({
      requestId: data.requestId,
      actorId: actor.userId,
      approverId,
      correlationId: randomUUID(),
      designationId: data.designationId,
      effectiveAt: data.effectiveAt ?? null,
      reason: data.reason,
    }),
  );
}
