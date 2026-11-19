/**
 * #161 교수 계정 연결과 수업별 과제 검토자 지정·검토 권한 판정의 Application Service입니다.
 *
 * - 호출자: 향후 #162 검토 화면 Server Action·`/api/v1` 어댑터. 이 PR에는 화면·라우트가 없습니다.
 * - 요청 주체(Principal)는 호출자가 실제 세션·모바일 토큰에서 확정해 넘깁니다. 클라이언트 입력으로 받지 않습니다.
 * - 기능 플래그 `ACADEMIC_FACULTY_REVIEW_ENABLED`(기본 false)와 `ACADEMIC_ENABLED`가 모두 정확히 "true"가 아니면
 *   DB에 접속하지 않고 거부하며, 검토 권한 판정은 항상 false입니다(정책 운영 승인 전 비활성).
 * - 연결·지정 변경 권한은 DB의 학사 운영 관리자 지정(#165)으로만 판단합니다. 홈페이지 `ADMIN`·`FACULTY` 역할과
 *   `schedule_sessions.facultyId`는 어떤 판정에도 쓰지 않습니다. 이 서비스는 출결 권한을 다루지 않습니다.
 * - 제출물·파일 열람은 범위 밖입니다(#162). 목록은 과제 메타데이터만 돌려줍니다.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import {
  isAcademicStaffPrincipal,
  type AcademicStaffPrincipal,
} from "@/features/academics/staff/contracts";
import {
  FacultyReviewError,
  designateReviewerSchema,
  designationResultSchema,
  endDesignationSchema,
  linkFacultyAccountSchema,
  linkResultSchema,
  reviewableListSchema,
  toFacultyReviewError,
  unlinkFacultyAccountSchema,
} from "./contracts";
import {
  closeFacultyAccountLink,
  closeReviewerDesignation,
  hasAssignmentReviewAuthority,
  insertFacultyAccountLink,
  insertReviewerDesignation,
  selectReviewableAssignments,
} from "./repository";

/** 정책 운영 승인 전에는 false입니다. 두 플래그가 정확히 "true"일 때만 켭니다. */
export function isFacultyReviewEnabled(): boolean {
  return (
    process.env.ACADEMIC_ENABLED === "true" &&
    process.env.ACADEMIC_FACULTY_REVIEW_ENABLED === "true"
  );
}

/** 주체 형식 → 승인 대기 계정 → 기능 플래그 순서로 확인해 비활성 환경에서는 학사 표를 조회하지 않습니다. */
function requireActor(principal: unknown): AcademicStaffPrincipal {
  if (!isAcademicStaffPrincipal(principal)) throw new FacultyReviewError("UNAUTHENTICATED");
  if (principal.role === "PENDING") throw new FacultyReviewError("FORBIDDEN");
  if (!isFacultyReviewEnabled()) throw new FacultyReviewError("DISABLED");
  return principal;
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new FacultyReviewError("INVALID_INPUT");
  return parsed.data;
}

/** 저장소 호출과 결과 형식 검증을 묶고, 실패는 고정 오류 코드로만 바꿉니다. */
async function run<T>(schema: z.ZodType<T>, call: () => Promise<unknown>): Promise<T> {
  let raw: unknown;
  try {
    raw = await call();
  } catch (error) {
    throw toFacultyReviewError(error);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new FacultyReviewError("UNAVAILABLE");
  return parsed.data;
}

/**
 * 과제 검토 권한의 중앙 판정입니다(#162의 모든 검토·피드백 경로가 사용).
 * **DB 현재 시각** 기준으로 계정이 유효하게 연결된 교수가 과제의 수업에 유효한 검토자로 지정되어 있을 때만 true입니다.
 * 연결 해제·지정 종료·계정 PENDING 전환은 다음 호출부터 즉시 반영됩니다(세션에 권한을 저장하지 않음).
 */
export async function canReviewAssignment(
  principal: unknown,
  assignmentId: string,
): Promise<boolean> {
  if (!isAcademicStaffPrincipal(principal) || principal.role === "PENDING") return false;
  if (!isFacultyReviewEnabled()) return false;
  if (!z.uuid().safeParse(assignmentId).success) return false;
  try {
    return await hasAssignmentReviewAuthority(principal.userId, assignmentId);
  } catch (error) {
    // 판정 불가를 거부(false)로 숨기지 않고 503 계열로 알립니다. 호출자는 실패 시 열람을 허용하지 않습니다.
    throw toFacultyReviewError(error);
  }
}

/** 요청 주체가 지금 검토할 수 있는 과제의 메타데이터 목록입니다. 제출물·학생 정보는 포함하지 않습니다. */
export async function listReviewableAssignments(principal: unknown) {
  const actor = requireActor(principal);
  return run(reviewableListSchema, () => selectReviewableAssignments(actor.userId));
}

/** 학사 운영 관리자가 교수 프로필과 검증된 로그인 계정을 연결합니다. 자기 연결·중복 연결은 DB가 거부합니다. */
export async function linkFacultyAccount(principal: unknown, input: unknown) {
  const actor = requireActor(principal);
  const data = parse(linkFacultyAccountSchema, input);
  return run(linkResultSchema, () =>
    insertFacultyAccountLink({
      requestId: data.requestId,
      actorId: actor.userId,
      correlationId: randomUUID(),
      facultyId: data.facultyId,
      userId: data.userId,
      validFrom: data.validFrom ?? null,
      validTo: data.validTo ?? null,
      verificationMethod: data.verificationMethod,
      evidenceReference: data.evidenceReference,
    }),
  );
}

/** 교수 계정 연결을 해제합니다. 종료 시각 이후 그 계정의 검토 권한은 즉시 사라집니다. */
export async function unlinkFacultyAccount(principal: unknown, input: unknown) {
  const actor = requireActor(principal);
  const data = parse(unlinkFacultyAccountSchema, input);
  return run(linkResultSchema, () =>
    closeFacultyAccountLink({
      requestId: data.requestId,
      actorId: actor.userId,
      correlationId: randomUUID(),
      linkId: data.linkId,
      effectiveAt: data.effectiveAt ?? null,
      reason: data.reason,
    }),
  );
}

/** 학사 운영 관리자가 교수를 수업(일정 전체 또는 세션 하나)의 과제 검토자로 지정합니다. 자기 지정은 DB가 거부합니다. */
export async function designateReviewer(principal: unknown, input: unknown) {
  const actor = requireActor(principal);
  const data = parse(designateReviewerSchema, input);
  return run(designationResultSchema, () =>
    insertReviewerDesignation({
      requestId: data.requestId,
      actorId: actor.userId,
      correlationId: randomUUID(),
      facultyId: data.facultyId,
      scheduleEventId: data.scheduleEventId,
      scheduleSessionId: data.scheduleSessionId ?? null,
      validFrom: data.validFrom ?? null,
      validTo: data.validTo ?? null,
    }),
  );
}

/** 과제 검토자 지정을 종료합니다. 종료 시각 이후 해당 수업 과제의 검토 권한은 즉시 사라집니다. */
export async function endDesignation(principal: unknown, input: unknown) {
  const actor = requireActor(principal);
  const data = parse(endDesignationSchema, input);
  return run(designationResultSchema, () =>
    closeReviewerDesignation({
      requestId: data.requestId,
      actorId: actor.userId,
      correlationId: randomUUID(),
      designationId: data.designationId,
      effectiveAt: data.effectiveAt ?? null,
      reason: data.reason,
    }),
  );
}
