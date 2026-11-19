/**
 * #165 기수별 운영 인력(어드바이저·조교) 배정과 출결 권한 판정의 순수 계약입니다.
 *
 * - 사용 위치: `service.ts`(Application Service), 향후 #160 Server Action·`/api/v1` 어댑터.
 * - 입력 검증(zod/v4), 고정 오류 코드, DB 행 → DTO 변환만 담당하며 DB·세션에 접근하지 않습니다.
 * - 정책 근거: docs/ACADEMIC-OPERATIONS-POLICY.md P1~P4·P10. `ADMIN`·`FACULTY` 역할은 판정 근거가 아닙니다.
 */
import { z } from "zod/v4";
import type { UserRole } from "@hra/contracts/identity";

// 세션(Web) 또는 모바일 토큰 어댑터가 확정한 요청 주체입니다. 클라이언트 입력으로 만들지 않습니다.
export type AcademicStaffPrincipal = { userId: string; role: UserRole };

// 기수 배정 역할. 정책 초안의 표기(ADVISOR·ASSISTANT)를 그대로 따릅니다.
export const STAFF_ROLES = ["ADVISOR", "ASSISTANT"] as const;
export type StaffRole = (typeof STAFF_ROLES)[number];

// 계정 연결 확인 방식. 이메일·이름 일치만으로 연결하지 않고 확인 근거 참조 ID만 남깁니다.
const verificationMethod = z.enum(["IN_PERSON", "VERIFIED_CONTACT"]);
// 시각은 시간대가 명시된 ISO 문자열만 받습니다. 생략하면 DB의 현재 시각을 사용합니다.
const instant = z.iso.datetime({ offset: true });
const reason = z.string().trim().min(1).max(500);

export const assignStaffSchema = z.strictObject({
  requestId: z.uuid(),
  cohortId: z.uuid(),
  userId: z.uuid(),
  staffRole: z.enum(STAFF_ROLES),
  validFrom: instant.optional(),
  validTo: instant.optional(),
  verificationMethod,
  evidenceReference: z.uuid(),
});
export const endStaffSchema = z.strictObject({
  requestId: z.uuid(),
  assignmentId: z.uuid(),
  effectiveAt: instant.optional(),
  reason,
});
export const replaceStaffSchema = z.strictObject({
  requestId: z.uuid(),
  assignmentId: z.uuid(),
  userId: z.uuid(),
  effectiveAt: instant.optional(),
  reason,
  verificationMethod,
  evidenceReference: z.uuid(),
});
export const designateManagerSchema = z.strictObject({
  requestId: z.uuid(),
  userId: z.uuid(),
  validFrom: instant.optional(),
  validTo: instant.optional(),
  verificationMethod,
  evidenceReference: z.uuid(),
});
export const endManagerSchema = z.strictObject({
  requestId: z.uuid(),
  designationId: z.uuid(),
  effectiveAt: instant.optional(),
  reason,
});

// 외부에 DB 오류 원문·식별자를 노출하지 않는 고정 오류 계약입니다.
const failures = {
  UNAUTHENTICATED: { status: 401, message: "로그인이 필요합니다." },
  FORBIDDEN: { status: 403, message: "운영 인력을 관리할 권한이 없습니다." },
  DISABLED: { status: 404, message: "운영 인력 기능을 준비 중입니다." },
  NOT_FOUND: { status: 404, message: "대상을 찾을 수 없습니다." },
  CONFLICT: {
    status: 409,
    message: "이미 처리되었거나 다른 요청과 충돌했습니다. 다시 조회해 주세요.",
  },
  CAPACITY: {
    status: 409,
    message: "같은 기간의 배정 인원 상한(어드바이저 1명·조교 2명)이나 기간 중복에 걸립니다.",
  },
  INVALID_INPUT: { status: 422, message: "입력값을 확인해 주세요." },
  UNAVAILABLE: { status: 503, message: "잠시 후 다시 시도해 주세요." },
} as const;
export type AcademicStaffErrorCode = keyof typeof failures;

export class AcademicStaffError extends Error {
  readonly status: number;
  constructor(readonly code: AcademicStaffErrorCode) {
    super(failures[code].message);
    this.name = "AcademicStaffError";
    this.status = failures[code].status;
  }
}

// SQL 함수가 내보내는 SQLSTATE만 고정 코드로 바꿉니다. 그 밖의 오류는 UNAVAILABLE로 숨깁니다.
const sqlStates: Record<string, AcademicStaffErrorCode> = {
  HRA01: "FORBIDDEN",
  HRA02: "CONFLICT",
  HRA03: "NOT_FOUND",
  HRA04: "CONFLICT",
  HRA07: "INVALID_INPUT",
  "23P01": "CAPACITY",
  "23503": "NOT_FOUND",
};

/** Drizzle·Neon이 감싼 PostgreSQL 오류의 code만 제한된 깊이로 읽습니다. message·detail은 읽지 않습니다. */
export function toAcademicStaffError(error: unknown): AcademicStaffError {
  if (error instanceof AcademicStaffError) return error;
  let current: unknown = error;
  for (let depth = 0; depth < 3 && typeof current === "object" && current !== null; depth++) {
    const code = Object.getOwnPropertyDescriptor(current, "code")?.value;
    if (typeof code === "string" && Object.hasOwn(sqlStates, code))
      return new AcademicStaffError(sqlStates[code]);
    current = Object.getOwnPropertyDescriptor(current, "cause")?.value;
  }
  return new AcademicStaffError("UNAVAILABLE");
}

/** 주체 형식만 확인합니다. 현재 역할·배정 유효성은 DB에서 다시 확인합니다. */
export function isAcademicStaffPrincipal(value: unknown): value is AcademicStaffPrincipal {
  if (typeof value !== "object" || value === null) return false;
  const { userId, role } = value as Record<string, unknown>;
  return (
    typeof userId === "string" &&
    z.uuid().safeParse(userId).success &&
    (role === "ADMIN" || role === "FACULTY" || role === "MEMBER" || role === "PENDING")
  );
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
const assignmentRow = z
  .object({
    id: z.uuid(),
    cohort_id: z.uuid(),
    user_id: z.uuid(),
    staff_role: z.enum(STAFF_ROLES),
    valid_from: timestamp,
    valid_to: timestamp.nullable(),
    assigned_by_user_id: z.uuid(),
    replaces_assignment_id: z.uuid().nullable(),
    ended_by_user_id: z.uuid().nullable(),
    ended_at: timestamp.nullable(),
  })
  .transform((row) => ({
    id: row.id,
    cohortId: row.cohort_id,
    userId: row.user_id,
    staffRole: row.staff_role,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    assignedByUserId: row.assigned_by_user_id,
    replacesAssignmentId: row.replaces_assignment_id,
    endedByUserId: row.ended_by_user_id,
    endedAt: row.ended_at,
  }));
const designationRow = z
  .object({
    id: z.uuid(),
    user_id: z.uuid(),
    valid_from: timestamp,
    valid_to: timestamp.nullable(),
    designated_by_user_id: z.uuid(),
    ended_by_user_id: z.uuid().nullable(),
    ended_at: timestamp.nullable(),
  })
  .transform((row) => ({
    id: row.id,
    userId: row.user_id,
    validFrom: row.valid_from,
    validTo: row.valid_to,
    designatedByUserId: row.designated_by_user_id,
    endedByUserId: row.ended_by_user_id,
    endedAt: row.ended_at,
  }));

export const assignmentResultSchema = z.object({
  assignment: assignmentRow,
  replayed: z.boolean(),
});
export const replacementResultSchema = z.object({
  previous: assignmentRow,
  assignment: assignmentRow,
  replayed: z.boolean(),
});
export const designationResultSchema = z.object({
  designation: designationRow,
  replayed: z.boolean(),
});

export type StaffAssignment = z.infer<typeof assignmentRow>;
export type ManagerDesignation = z.infer<typeof designationRow>;

// ── #160 화면용 읽기 DTO ──────────────────────────────────────────────────────
// 확인 근거 참조·종료 사유 원문·이메일은 화면 DTO에도 포함하지 않습니다.

// 학사 운영 관리자 화면: 기수 목록과 현재·예정 배정. 관리자가 아니면 저장소가 null을 돌려줍니다.
export const staffOverviewSchema = z
  .object({
    cohorts: z.array(z.object({ id: z.uuid(), name: z.string() })),
    assignments: z.array(
      z.object({
        id: z.uuid(),
        cohortId: z.uuid(),
        userId: z.uuid(),
        userName: z.string(),
        staffRole: z.enum(STAFF_ROLES),
        validFrom: timestamp,
        validTo: timestamp.nullable(),
        // 시작 전(예정) 배정 여부. DB 현재 시각 기준입니다.
        upcoming: z.boolean(),
      }),
    ),
  })
  .nullable();

// 배정 변경 감사 목록(최근 50건). 행위 종류·행위자 이름·대상 기수/이름·시각만 담습니다.
export const STAFF_AUDIT_ACTIONS = [
  "MANAGER_DESIGNATE",
  "MANAGER_END",
  "STAFF_ASSIGN",
  "STAFF_END",
  "STAFF_REPLACE",
] as const;
export const staffAuditSchema = z
  .array(
    z.object({
      id: z.uuid(),
      action: z.enum(STAFF_AUDIT_ACTIONS),
      actorName: z.string(),
      cohortName: z.string().nullable(),
      targetName: z.string().nullable(),
      createdAt: timestamp,
    }),
  )
  .nullable();

// 운영 인력 본인의 현재 유효 배정 기수. 다른 운영 인력 정보는 포함하지 않습니다.
export const myStaffCohortsSchema = z.array(
  z.object({
    cohortId: z.uuid(),
    cohortName: z.string(),
    staffRole: z.enum(STAFF_ROLES),
    validTo: timestamp.nullable(),
  }),
);

export type StaffOverview = NonNullable<z.infer<typeof staffOverviewSchema>>;
export type StaffAuditEvent = NonNullable<z.infer<typeof staffAuditSchema>>[number];
export type MyStaffCohort = z.infer<typeof myStaffCohortsSchema>[number];
