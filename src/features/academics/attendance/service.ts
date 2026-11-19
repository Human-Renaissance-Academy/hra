/**
 * #159 학생별 출결 기록·정정 승인의 Application Service입니다.
 *
 * - 호출자: 향후 #160 Server Action·`/api/v1` 어댑터. 이 PR에는 화면·라우트가 없습니다.
 * - 요청 주체(Principal)는 호출자가 실제 세션·모바일 토큰에서 확정해 넘깁니다. 클라이언트 입력으로 받지 않습니다.
 * - 기능 플래그 `ACADEMIC_ATTENDANCE_ENABLED`·`ACADEMIC_STAFF_ENABLED`·`ACADEMIC_ENABLED`(모두 기본 false)가
 *   정확히 "true"가 아니면 DB에 접속하지 않고 거부합니다(정책 운영 승인 전 비활성).
 * - 권한 판정은 모두 DB 현재 시각 기준으로 SQL 함수 안에서 다시 수행합니다. 운영 인력 권한은 #165
 *   `can_record_academic_attendance`, 결정 권한은 학사 운영 관리자 지정 또는 같은 기수 유효 배정이며,
 *   홈페이지 `ADMIN`·`FACULTY` 역할은 어떤 판정에도 쓰지 않습니다.
 */
import "server-only";
import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import {
  isAcademicStaffPrincipal,
  type AcademicStaffPrincipal,
} from "@/features/academics/staff/contracts";
import { isAcademicStaffEnabled } from "@/features/academics/staff/service";
import {
  AcademicAttendanceError,
  attendanceAccessSchema,
  classSessionsSchema,
  correctionResultSchema,
  decideCorrectionSchema,
  decisionResultSchema,
  eventSheetSchema,
  managerCorrectionsSchema,
  ownAttendanceSchema,
  ownContextSchema,
  recordAttendanceSchema,
  recordResultSchema,
  requestCorrectionSchema,
  toAcademicAttendanceError,
} from "./contracts";
import {
  insertCorrectionRequest,
  saveAttendance,
  saveCorrectionDecision,
  selectAttendanceAccess,
  selectClassSessions,
  selectEventSheet,
  selectOwnAttendance,
  selectOwnAttendanceContext,
  selectPendingCorrectionsForManager,
} from "./repository";

/** 정책 운영 승인 전에는 false입니다. 세 플래그가 모두 정확히 "true"일 때만 켭니다. */
export function isAcademicAttendanceEnabled(): boolean {
  return (
    process.env.ACADEMIC_ENABLED === "true" &&
    process.env.ACADEMIC_STAFF_ENABLED === "true" &&
    process.env.ACADEMIC_ATTENDANCE_ENABLED === "true"
  );
}

/** 주체 형식 → 승인 대기 계정 → 기능 플래그 순서로 확인해 비활성 환경에서는 학사 표를 조회하지 않습니다. */
function requireActor(principal: unknown): AcademicStaffPrincipal {
  if (!isAcademicStaffPrincipal(principal)) throw new AcademicAttendanceError("UNAUTHENTICATED");
  if (principal.role === "PENDING") throw new AcademicAttendanceError("FORBIDDEN");
  if (!isAcademicAttendanceEnabled()) throw new AcademicAttendanceError("DISABLED");
  return principal;
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new AcademicAttendanceError("INVALID_INPUT");
  return parsed.data;
}

/** 저장소 호출과 결과 형식 검증을 묶고, 실패는 고정 오류 코드로만 바꿉니다. */
async function run<T>(schema: z.ZodType<T>, call: () => Promise<unknown>): Promise<T> {
  let raw: unknown;
  try {
    raw = await call();
  } catch (error) {
    throw toAcademicAttendanceError(error);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new AcademicAttendanceError("UNAVAILABLE");
  return parsed.data;
}

/**
 * 7일 입력 창(수업일 KST 00:00 ~ 수업일+7일 KST 24:00 미만) 안에서 유효 배정자가 출결을 입력·수정합니다.
 * `expectedVersion`이 현재 버전과 다르면 VERSION_CONFLICT로, 창 밖·인정결석 변경은 CORRECTION_REQUIRED로 거부합니다.
 */
export async function recordAttendance(principal: unknown, input: unknown) {
  const actor = requireActor(principal);
  const data = parse(recordAttendanceSchema, input);
  return run(recordResultSchema, () =>
    saveAttendance({
      requestId: data.requestId,
      actorId: actor.userId,
      correlationId: randomUUID(),
      scheduleEventId: data.scheduleEventId,
      enrollmentId: data.enrollmentId,
      status: data.status,
      expectedVersion: data.expectedVersion,
    }),
  );
}

/** 입력 창 이후 변경과 인정결석 지정·해제를 사유와 함께 요청합니다. 승인 전에는 현재 값이 바뀌지 않습니다. */
export async function requestCorrection(principal: unknown, input: unknown) {
  const actor = requireActor(principal);
  const data = parse(requestCorrectionSchema, input);
  return run(correctionResultSchema, () =>
    insertCorrectionRequest({
      requestId: data.requestId,
      actorId: actor.userId,
      correlationId: randomUUID(),
      scheduleEventId: data.scheduleEventId,
      enrollmentId: data.enrollmentId,
      requestedStatus: data.requestedStatus,
      expectedVersion: data.expectedVersion,
      reason: data.reason,
      excuseVerificationMethod: data.excuseVerificationMethod ?? null,
    }),
  );
}

/**
 * 정정 요청을 승인·반려합니다. 요청자 본인은 결정할 수 없습니다(자기 승인 금지).
 * 인정결석 지정·해제는 학사 운영 관리자만, 그 밖의 정정은 관리자 또는 같은 기수의 다른 유효 배정자가 결정합니다.
 */
export async function decideCorrection(principal: unknown, input: unknown) {
  const actor = requireActor(principal);
  const data = parse(decideCorrectionSchema, input);
  return run(decisionResultSchema, () =>
    saveCorrectionDecision({
      requestId: data.requestId,
      actorId: actor.userId,
      correlationId: randomUUID(),
      correctionId: data.correctionId,
      decision: data.decision,
    }),
  );
}

/** 운영 인력 전용 수업일 출결표. 요청 시각에 그 기수에 유효하게 배정된 운영 인력만 조회합니다(P10). */
export async function listForCohortSession(principal: unknown, scheduleEventId: unknown) {
  const actor = requireActor(principal);
  const eventId = parse(z.uuid(), scheduleEventId);
  return run(eventSheetSchema, () => selectEventSheet(actor.userId, eventId));
}

/** 학생 본인 출결. 로그인 계정에 연결된 본인 학적만 조회하며 다른 사람의 기록은 받을 방법이 없습니다(P9). */
export async function listOwn(principal: unknown) {
  const actor = requireActor(principal);
  return run(ownAttendanceSchema, () => selectOwnAttendance(actor.userId));
}

// ── #160 화면용 읽기 ─────────────────────────────────────────────────────────

/** 운영 인력이 고른 기수의 CLASS 수업일 목록. 그 기수의 유효 배정이 없으면 FORBIDDEN입니다(P10). */
export async function listClassSessions(principal: unknown, cohortId: unknown) {
  const actor = requireActor(principal);
  const cohort = parse(z.uuid(), cohortId);
  const sessions = await run(classSessionsSchema, () => selectClassSessions(actor.userId, cohort));
  if (!sessions) throw new AcademicAttendanceError("FORBIDDEN");
  return sessions;
}

/** 학사 운영 관리자의 대기 중 정정 목록. 관리자 지정이 없으면(홈페이지 ADMIN 포함) FORBIDDEN입니다. */
export async function listPendingCorrectionsForManager(principal: unknown) {
  const actor = requireActor(principal);
  const corrections = await run(managerCorrectionsSchema, () =>
    selectPendingCorrectionsForManager(actor.userId),
  );
  if (!corrections) throw new AcademicAttendanceError("FORBIDDEN");
  return corrections;
}

/** 학생 본인 출결 화면: 본인 출결(미입력 포함)과 기수 이름, 정정 요약. 다른 사람 기록은 받을 수 없습니다(P9). */
export async function getOwnAttendanceOverview(principal: unknown) {
  const actor = requireActor(principal);
  const [records, context] = await Promise.all([
    run(ownAttendanceSchema, () => selectOwnAttendance(actor.userId)),
    run(ownContextSchema, () => selectOwnAttendanceContext(actor.userId)),
  ]);
  return { records, ...context };
}

export type AttendanceNavigation = {
  operations: boolean;
  staffAttendance: boolean;
  ownAttendance: boolean;
};
const hiddenNavigation: AttendanceNavigation = {
  operations: false,
  staffAttendance: false,
  ownAttendance: false,
};

/**
 * 메뉴 노출 판정. 플래그가 꺼져 있거나 주체가 형식 오류·PENDING이면 DB 조회 없이 모두 숨깁니다.
 * 운영 인력 관리 메뉴는 `ACADEMIC_STAFF_ENABLED`, 출결 메뉴는 `ACADEMIC_ATTENDANCE_ENABLED`까지 켜져야 보입니다.
 * 이 결과는 표시용이며 권한 토큰이 아닙니다. 각 화면·액션이 서비스에서 다시 판정합니다.
 */
export async function getAttendanceNavigation(principal: unknown): Promise<AttendanceNavigation> {
  if (!isAcademicStaffPrincipal(principal) || principal.role === "PENDING") return hiddenNavigation;
  if (!isAcademicStaffEnabled()) return hiddenNavigation;
  const access = await run(attendanceAccessSchema, () => selectAttendanceAccess(principal.userId));
  const attendance = isAcademicAttendanceEnabled();
  return {
    operations: access.manager,
    staffAttendance: attendance && access.staff,
    ownAttendance: attendance && access.student,
  };
}
