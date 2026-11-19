/**
 * #161 교수 계정 연결과 수업별 과제 검토자 지정·검토 권한 판정의 순수 계약입니다.
 *
 * - 사용 위치: `service.ts`(Application Service), 향후 #162 검토 화면 Server Action·`/api/v1` 어댑터.
 * - 입력 검증(zod/v4), 고정 오류 코드, DB 행 → DTO 변환만 담당하며 DB·세션에 접근하지 않습니다.
 * - 정책 근거: docs/ACADEMIC-OPERATIONS-POLICY.md P11. 교수 검토 권한은 출결 권한이 아니며,
 *   `ADMIN`·`FACULTY` 역할과 `schedule_sessions.facultyId`(수업 내용 담당)는 판정 근거가 아닙니다.
 */
import { z } from "zod/v4";

// 계정 연결 확인 방식. 이메일·이름 일치만으로 연결하지 않고 확인 근거 참조 ID만 남깁니다.
const verificationMethod = z.enum(["IN_PERSON", "VERIFIED_CONTACT"]);
// 시각은 시간대가 명시된 ISO 문자열만 받습니다. 생략하면 DB의 현재 시각을 사용합니다.
const instant = z.iso.datetime({ offset: true });
const reason = z.string().trim().min(1).max(500);

// 학사 운영 관리자가 교수 프로필과 로그인 계정을 연결하는 입력입니다.
export const linkFacultyAccountSchema = z.strictObject({
  requestId: z.uuid(),
  facultyId: z.uuid(),
  userId: z.uuid(),
  validFrom: instant.optional(),
  validTo: instant.optional(),
  verificationMethod,
  evidenceReference: z.uuid(),
});
// 연결 해제 입력입니다. 종료 시각은 현재 이후만 허용합니다.
export const unlinkFacultyAccountSchema = z.strictObject({
  requestId: z.uuid(),
  linkId: z.uuid(),
  effectiveAt: instant.optional(),
  reason,
});
// 수업(일정 전체 또는 그 세션 하나)의 과제 검토자 지정 입력입니다.
export const designateReviewerSchema = z.strictObject({
  requestId: z.uuid(),
  facultyId: z.uuid(),
  scheduleEventId: z.uuid(),
  scheduleSessionId: z.uuid().optional(),
  validFrom: instant.optional(),
  validTo: instant.optional(),
});
// 검토자 지정 종료 입력입니다.
export const endDesignationSchema = z.strictObject({
  requestId: z.uuid(),
  designationId: z.uuid(),
  effectiveAt: instant.optional(),
  reason,
});

// 외부에 DB 오류 원문·식별자를 노출하지 않는 고정 오류 계약입니다.
const failures = {
  UNAUTHENTICATED: { status: 401, message: "로그인이 필요합니다." },
  FORBIDDEN: { status: 403, message: "교수 검토 권한을 관리할 권한이 없습니다." },
  DISABLED: { status: 404, message: "교수 과제 검토 기능을 준비 중입니다." },
  NOT_FOUND: { status: 404, message: "대상을 찾을 수 없습니다." },
  CONFLICT: {
    status: 409,
    message: "이미 처리되었거나 다른 요청과 충돌했습니다. 다시 조회해 주세요.",
  },
  DUPLICATE: {
    status: 409,
    message: "같은 기간에 이미 유효한 연결이나 지정이 있습니다.",
  },
  INVALID_INPUT: { status: 422, message: "입력값을 확인해 주세요." },
  UNAVAILABLE: { status: 503, message: "잠시 후 다시 시도해 주세요." },
} as const;
export type FacultyReviewErrorCode = keyof typeof failures;

export class FacultyReviewError extends Error {
  readonly status: number;
  constructor(readonly code: FacultyReviewErrorCode) {
    super(failures[code].message);
    this.name = "FacultyReviewError";
    this.status = failures[code].status;
  }
}

// SQL 함수가 내보내는 SQLSTATE만 고정 코드로 바꿉니다. 그 밖의 오류는 UNAVAILABLE로 숨깁니다.
const sqlStates: Record<string, FacultyReviewErrorCode> = {
  HRA01: "FORBIDDEN",
  HRA02: "CONFLICT",
  HRA03: "NOT_FOUND",
  HRA04: "CONFLICT",
  HRA07: "INVALID_INPUT",
  "23P01": "DUPLICATE",
  "23503": "NOT_FOUND",
};

/** Drizzle·Neon이 감싼 PostgreSQL 오류의 code만 제한된 깊이로 읽습니다. message·detail은 읽지 않습니다. */
export function toFacultyReviewError(error: unknown): FacultyReviewError {
  if (error instanceof FacultyReviewError) return error;
  let current: unknown = error;
  for (let depth = 0; depth < 3 && typeof current === "object" && current !== null; depth++) {
    const code = Object.getOwnPropertyDescriptor(current, "code")?.value;
    if (typeof code === "string" && Object.hasOwn(sqlStates, code))
      return new FacultyReviewError(sqlStates[code]);
    current = Object.getOwnPropertyDescriptor(current, "cause")?.value;
  }
  return new FacultyReviewError("UNAVAILABLE");
}

// 응답 DTO. 확인 근거 참조·종료 사유 원문은 내보내지 않습니다.
const timestamp = z.string().transform((value, context) => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    context.addIssue({ code: "custom", message: "시각 형식 오류" });
    return z.NEVER;
  }
  return parsed.toISOString();
});
const linkRow = z
  .object({
    id: z.uuid(),
    faculty_id: z.uuid(),
    user_id: z.uuid(),
    valid_from: timestamp,
    valid_to: timestamp.nullable(),
    verified_by_user_id: z.uuid(),
    ended_by_user_id: z.uuid().nullable(),
    ended_at: timestamp.nullable(),
  })
  .transform((row) => ({
    id: row.id,
    facultyId: row.faculty_id,
    userId: row.user_id,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    verifiedByUserId: row.verified_by_user_id,
    endedByUserId: row.ended_by_user_id,
    endedAt: row.ended_at,
  }));
const designationRow = z
  .object({
    id: z.uuid(),
    faculty_id: z.uuid(),
    schedule_event_id: z.uuid(),
    schedule_session_id: z.uuid().nullable(),
    valid_from: timestamp,
    valid_to: timestamp.nullable(),
    designated_by_user_id: z.uuid(),
    ended_by_user_id: z.uuid().nullable(),
    ended_at: timestamp.nullable(),
  })
  .transform((row) => ({
    id: row.id,
    facultyId: row.faculty_id,
    scheduleEventId: row.schedule_event_id,
    scheduleSessionId: row.schedule_session_id,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    designatedByUserId: row.designated_by_user_id,
    endedByUserId: row.ended_by_user_id,
    endedAt: row.ended_at,
  }));
// 검토 가능한 과제 메타데이터. 지시사항 본문·제출물·학생 정보는 포함하지 않습니다.
const reviewableRow = z
  .object({
    assignment_id: z.uuid(),
    cohort_id: z.uuid(),
    schedule_event_id: z.uuid(),
    schedule_session_id: z.uuid().nullable(),
    title: z.string(),
    status: z.enum(["PUBLISHED", "CLOSED"]),
    due_at: timestamp.nullable(),
  })
  .transform((row) => ({
    assignmentId: row.assignment_id,
    cohortId: row.cohort_id,
    scheduleEventId: row.schedule_event_id,
    scheduleSessionId: row.schedule_session_id,
    title: row.title,
    status: row.status,
    dueAt: row.due_at,
  }));

export const linkResultSchema = z.object({ link: linkRow, replayed: z.boolean() });
export const designationResultSchema = z.object({
  designation: designationRow,
  replayed: z.boolean(),
});
export const reviewableListSchema = z.array(reviewableRow);

export type FacultyAccountLink = z.infer<typeof linkRow>;
export type ReviewerDesignation = z.infer<typeof designationRow>;
export type ReviewableAssignment = z.infer<typeof reviewableRow>;
