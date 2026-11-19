/**
 * #159 학생별 출결 기록과 정정 승인의 순수 계약입니다.
 *
 * - 사용 위치: `service.ts`(Application Service), 향후 #160 Server Action·`/api/v1` 어댑터.
 * - 입력 검증(zod/v4), 고정 오류 코드, DB 결과 → DTO 변환만 담당하며 DB·세션에 접근하지 않습니다.
 * - 정책 근거: docs/ACADEMIC-OPERATIONS-POLICY.md P5~P10. 미입력(기록 없음)은 결석이 아니며 `UNMARKED`로 표현합니다.
 */
import { z } from "zod/v4";

// 출결 상태(P5). 출석·지각·결석·인정결석. 기록 행이 없으면 미입력(UNMARKED)입니다.
export const ATTENDANCE_STATUSES = ["PRESENT", "LATE", "ABSENT", "EXCUSED"] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];
export type AttendanceCellStatus = AttendanceStatus | "UNMARKED";

const status = z.enum(ATTENDANCE_STATUSES);
// 호출자가 본 현재 버전. 미입력 셀은 0입니다(낙관적 동시성 제어).
const expectedVersion = z.int().min(0).max(2_147_483_647);

/** 7일 입력 창 안의 직접 입력. 인정결석은 정정 절차로만 지정하므로 DB가 거부합니다. */
export const recordAttendanceSchema = z.strictObject({
  requestId: z.uuid(),
  scheduleEventId: z.uuid(),
  enrollmentId: z.uuid(),
  status,
  expectedVersion,
});
/** 정정 요청. 사유는 필수이며 인정결석 요청은 증빙 원본 대신 확인 방식만 받습니다(P8). */
export const requestCorrectionSchema = z
  .strictObject({
    requestId: z.uuid(),
    scheduleEventId: z.uuid(),
    enrollmentId: z.uuid(),
    requestedStatus: status,
    expectedVersion,
    reason: z.string().trim().min(1).max(500),
    excuseVerificationMethod: z.enum(["DOCUMENT_SIGHTED", "VERIFIED_CONTACT"]).optional(),
  })
  .refine(
    (input) =>
      (input.requestedStatus === "EXCUSED") === (input.excuseVerificationMethod !== undefined),
  );
/** 정정 결정. 요청자 본인은 결정할 수 없고 권한 범위는 DB가 다시 확인합니다. */
export const decideCorrectionSchema = z.strictObject({
  requestId: z.uuid(),
  correctionId: z.uuid(),
  decision: z.enum(["APPROVE", "REJECT"]),
});

// 외부에 DB 오류 원문·식별자를 노출하지 않는 고정 오류 계약입니다.
const failures = {
  UNAUTHENTICATED: { status: 401, message: "로그인이 필요합니다." },
  FORBIDDEN: { status: 403, message: "출결을 다룰 권한이 없습니다." },
  DISABLED: { status: 404, message: "출결 기능을 준비 중입니다." },
  NOT_FOUND: { status: 404, message: "대상을 찾을 수 없습니다." },
  CONFLICT: {
    status: 409,
    message: "이미 처리되었거나 다른 요청과 충돌했습니다. 다시 조회해 주세요.",
  },
  VERSION_CONFLICT: {
    status: 409,
    message: "다른 사람이 먼저 출결을 바꿨습니다. 다시 조회해 주세요.",
  },
  OUTSIDE_WINDOW: { status: 409, message: "아직 출결 입력 기간이 아닙니다." },
  CORRECTION_REQUIRED: {
    status: 409,
    message: "입력 기간이 지났거나 인정결석 변경이므로 정정 요청과 승인이 필요합니다.",
  },
  INVALID_INPUT: { status: 422, message: "입력값을 확인해 주세요." },
  UNAVAILABLE: { status: 503, message: "잠시 후 다시 시도해 주세요." },
} as const;
export type AcademicAttendanceErrorCode = keyof typeof failures;

export class AcademicAttendanceError extends Error {
  readonly status: number;
  constructor(readonly code: AcademicAttendanceErrorCode) {
    super(failures[code].message);
    this.name = "AcademicAttendanceError";
    this.status = failures[code].status;
  }
}

// SQL 함수가 내보내는 SQLSTATE만 고정 코드로 바꿉니다. 그 밖의 오류는 UNAVAILABLE로 숨깁니다.
const sqlStates: Record<string, AcademicAttendanceErrorCode> = {
  HRA01: "FORBIDDEN",
  HRA02: "CONFLICT",
  HRA03: "NOT_FOUND",
  HRA04: "CONFLICT",
  HRA05: "OUTSIDE_WINDOW",
  HRA06: "VERSION_CONFLICT",
  HRA07: "INVALID_INPUT",
  HRA08: "CORRECTION_REQUIRED",
  "23505": "CONFLICT",
  "23503": "NOT_FOUND",
};

/** Drizzle·Neon이 감싼 PostgreSQL 오류의 code만 제한된 깊이로 읽습니다. message·detail은 읽지 않습니다. */
export function toAcademicAttendanceError(error: unknown): AcademicAttendanceError {
  if (error instanceof AcademicAttendanceError) return error;
  let current: unknown = error;
  for (let depth = 0; depth < 3 && typeof current === "object" && current !== null; depth++) {
    const code = Object.getOwnPropertyDescriptor(current, "code")?.value;
    if (typeof code === "string" && Object.hasOwn(sqlStates, code))
      return new AcademicAttendanceError(sqlStates[code]);
    current = Object.getOwnPropertyDescriptor(current, "cause")?.value;
  }
  return new AcademicAttendanceError("UNAVAILABLE");
}

// 응답 DTO. 내부 배정 ID·결정 권한 근거 ID는 내보내지 않습니다.
const timestamp = z.string().transform((value, context) => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    context.addIssue({ code: "custom", message: "시각 형식 오류" });
    return z.NEVER;
  }
  return parsed.toISOString();
});
const classDate = z.iso.date();
const recordRow = z
  .object({
    id: z.uuid(),
    schedule_event_id: z.uuid(),
    enrollment_id: z.uuid(),
    cohort_id: z.uuid(),
    class_date: classDate,
    status,
    version: z.int().min(1),
    recorded_by_user_id: z.uuid(),
    last_correction_id: z.uuid().nullable(),
    recorded_at: timestamp,
  })
  .transform((row) => ({
    id: row.id,
    scheduleEventId: row.schedule_event_id,
    enrollmentId: row.enrollment_id,
    cohortId: row.cohort_id,
    classDate: row.class_date,
    status: row.status,
    version: row.version,
    recordedByUserId: row.recorded_by_user_id,
    lastCorrectionId: row.last_correction_id,
    recordedAt: row.recorded_at,
  }));
const correctionRow = z
  .object({
    id: z.uuid(),
    schedule_event_id: z.uuid(),
    enrollment_id: z.uuid(),
    cohort_id: z.uuid(),
    class_date: classDate,
    base_version: z.int().min(0),
    previous_status: status.nullable(),
    requested_status: status,
    reason: z.string(),
    excuse_verification_method: z.enum(["DOCUMENT_SIGHTED", "VERIFIED_CONTACT"]).nullable(),
    requested_by_user_id: z.uuid(),
    requested_at: timestamp,
    status: z.enum(["PENDING", "APPROVED", "REJECTED"]),
    decided_by_user_id: z.uuid().nullable(),
    decided_at: timestamp.nullable(),
  })
  .transform((row) => ({
    id: row.id,
    scheduleEventId: row.schedule_event_id,
    enrollmentId: row.enrollment_id,
    cohortId: row.cohort_id,
    classDate: row.class_date,
    baseVersion: row.base_version,
    previousStatus: (row.previous_status ?? "UNMARKED") as AttendanceCellStatus,
    requestedStatus: row.requested_status,
    reason: row.reason,
    excuseVerificationMethod: row.excuse_verification_method,
    requestedByUserId: row.requested_by_user_id,
    requestedAt: row.requested_at,
    status: row.status,
    decidedByUserId: row.decided_by_user_id,
    decidedAt: row.decided_at,
  }));

export const recordResultSchema = z.object({
  record: recordRow,
  changed: z.boolean(),
  replayed: z.boolean(),
});
export const correctionResultSchema = z.object({
  correction: correctionRow,
  replayed: z.boolean(),
});
export const decisionResultSchema = z.object({
  correction: correctionRow,
  record: recordRow.nullable(),
  replayed: z.boolean(),
});

// 운영 인력용 수업일 출결표. 최소 명단(학적 UUID·표시 이름)과 셀 상태만 담습니다(P10).
export const eventSheetSchema = z
  .object({
    scheduleEventId: z.uuid(),
    cohortId: z.uuid(),
    classDate: classDate,
    windowOpensAt: timestamp,
    windowClosesAt: timestamp,
    entries: z.array(
      z.object({
        enrollmentId: z.uuid(),
        displayName: z.string(),
        status: status.nullable(),
        version: z.int().min(0),
        recordedAt: timestamp.nullable(),
        pendingCorrection: z
          .object({
            id: z.uuid(),
            requestedStatus: status,
            previousStatus: status.nullable(),
            // 인정결석 관련 요청의 사유·요청자는 학사 운영 관리자가 아니면 null입니다.
            reason: z.string().nullable(),
            requestedByUserId: z.uuid().nullable(),
            requestedAt: timestamp,
          })
          .nullable(),
      }),
    ),
  })
  .transform((sheet) => ({
    ...sheet,
    entries: sheet.entries.map((entry) => ({
      ...entry,
      status: (entry.status ?? "UNMARKED") as AttendanceCellStatus,
      pendingCorrection: entry.pendingCorrection && {
        ...entry.pendingCorrection,
        previousStatus: (entry.pendingCorrection.previousStatus ??
          "UNMARKED") as AttendanceCellStatus,
      },
    })),
  }));

// 학생 본인 출결 목록. 다른 학생·운영 인력 식별자와 정정 사유는 포함하지 않습니다(P9).
export const ownAttendanceSchema = z.array(
  z
    .object({
      enrollmentId: z.uuid(),
      cohortId: z.uuid(),
      scheduleEventId: z.uuid(),
      classDate: classDate,
      status: status.nullable(),
    })
    .transform((entry) => ({
      ...entry,
      status: (entry.status ?? "UNMARKED") as AttendanceCellStatus,
    })),
);

export type AttendanceRecord = z.infer<typeof recordRow>;
export type AttendanceCorrection = z.infer<typeof correctionRow>;
export type AttendanceEventSheet = z.infer<typeof eventSheetSchema>;
export type OwnAttendanceEntry = z.infer<typeof ownAttendanceSchema>[number];

// ── #160 화면용 읽기 DTO ──────────────────────────────────────────────────────

// 운영 인력의 배정 기수 CLASS 수업일 목록. 해당 기수의 유효 배정이 없으면 저장소가 null을 돌려줍니다.
export const classSessionsSchema = z
  .array(
    z.object({
      id: z.uuid(),
      title: z.string(),
      weekNumber: z.int().nullable(),
      classDate: classDate,
      windowOpensAt: timestamp,
      windowClosesAt: timestamp,
    }),
  )
  .nullable();

// 학사 운영 관리자의 대기 중 정정 목록. 요청자 신원 대신 본인 요청 여부만 내보냅니다.
export const managerCorrectionsSchema = z
  .array(
    z
      .object({
        id: z.uuid(),
        scheduleEventId: z.uuid(),
        cohortName: z.string(),
        eventTitle: z.string(),
        classDate: classDate,
        displayName: z.string(),
        previousStatus: status.nullable(),
        requestedStatus: status,
        reason: z.string(),
        excuseVerificationMethod: z.enum(["DOCUMENT_SIGHTED", "VERIFIED_CONTACT"]).nullable(),
        requestedAt: timestamp,
        requestedBySelf: z.boolean(),
      })
      .transform((entry) => ({
        ...entry,
        previousStatus: (entry.previousStatus ?? "UNMARKED") as AttendanceCellStatus,
      })),
  )
  .nullable();

// 학생 본인 화면 보조 정보: 본인 학적의 기수 이름과 정정 요약(사유·운영 인력 식별자 제외, P9).
export const ownContextSchema = z.object({
  cohorts: z.array(z.object({ id: z.uuid(), name: z.string() })),
  corrections: z.array(
    z
      .object({
        id: z.uuid(),
        cohortId: z.uuid(),
        classDate: classDate,
        previousStatus: status.nullable(),
        requestedStatus: status,
        status: z.enum(["PENDING", "APPROVED", "REJECTED"]),
        requestedAt: timestamp,
        decidedAt: timestamp.nullable(),
      })
      .transform((entry) => ({
        ...entry,
        previousStatus: (entry.previousStatus ?? "UNMARKED") as AttendanceCellStatus,
      })),
  ),
});

// 메뉴 노출 판정. 실제 권한은 각 화면·액션이 서비스에서 다시 확인합니다.
export const attendanceAccessSchema = z.object({
  manager: z.boolean(),
  staff: z.boolean(),
  student: z.boolean(),
});

export type ClassSession = NonNullable<z.infer<typeof classSessionsSchema>>[number];
export type ManagerCorrection = NonNullable<z.infer<typeof managerCorrectionsSchema>>[number];
export type OwnAttendanceContext = z.infer<typeof ownContextSchema>;
