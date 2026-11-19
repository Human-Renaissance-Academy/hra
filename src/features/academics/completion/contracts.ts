/**
 * #163 수료 기준 버전과 수료 확정·취소 이력의 순수 계약입니다.
 *
 * - 사용 위치: `service.ts`(Application Service), `actions.ts`(Server Action), 수료 화면, 향후 `/api/v1` 어댑터.
 * - 입력 검증(zod/v4), 고정 오류 코드, DB 결과 → DTO 변환만 담당하며 DB·세션에 접근하지 않습니다.
 * - 정책 근거: docs/ACADEMIC-OPERATIONS-POLICY.md P13(기준 버전·공개 후 불변)·P14(수동 확정, 자동 수료 없음).
 *   보조 지표(snapshot)는 심사 참고용이며 결정 값을 정하지 않습니다.
 */
import { z } from "zod/v4";

// 수료 결정 값. 수료·미수료·수료 취소입니다. 결정 기록이 없으면 심사 전(PENDING)으로 표시합니다.
export const COMPLETION_DECISIONS = ["COMPLETED", "NOT_COMPLETED", "REVOKED"] as const;
export type CompletionDecision = (typeof COMPLETION_DECISIONS)[number];
export type CompletionStatus = CompletionDecision | "PENDING";

// 기준 버전 상태. 초안만 고칠 수 있고 공개 후에는 불변입니다.
export const CRITERIA_STATUSES = ["DRAFT", "PUBLISHED"] as const;
export type CriteriaStatus = (typeof CRITERIA_STATUSES)[number];

/** 수료 기준 내용. DB의 `academic_completion_criteria_valid`와 같은 규칙입니다. */
export const criteriaSchema = z.strictObject({
  minAttendancePercent: z.int().min(0).max(100),
  countLateAsAttended: z.boolean(),
  countExcusedAsAttended: z.boolean(),
  requiredSubmissionCount: z.int().min(0).max(1000),
  notes: z.string().trim().min(1).max(2000).optional(),
});
export type CompletionCriteria = z.infer<typeof criteriaSchema>;

// 사유는 필수이며 개인정보·진단명 등 민감 정보를 적지 않도록 화면에서 안내합니다.
const reason = z.string().trim().min(1).max(500);

export const createCriteriaSchema = z.strictObject({
  requestId: z.uuid(),
  cohortId: z.uuid(),
  criteria: criteriaSchema,
  reason,
});
export const updateCriteriaSchema = z.strictObject({
  requestId: z.uuid(),
  criteriaVersionId: z.uuid(),
  criteria: criteriaSchema,
  reason,
});
export const publishCriteriaSchema = z.strictObject({
  requestId: z.uuid(),
  criteriaVersionId: z.uuid(),
});
/** 수료 결정. 호출자가 본 현재 순번(결정이 없으면 0)을 함께 보내 동시 확정 중 하나만 반영합니다. */
export const recordDecisionSchema = z.strictObject({
  requestId: z.uuid(),
  enrollmentId: z.uuid(),
  criteriaVersionId: z.uuid(),
  decision: z.enum(COMPLETION_DECISIONS),
  reason,
  expectedSequence: z.int().min(0).max(2_147_483_647),
});
export const rosterQuerySchema = z.strictObject({
  cohortId: z.uuid(),
  criteriaVersionId: z.uuid().optional(),
});

// 외부에 DB 오류 원문·식별자를 노출하지 않는 고정 오류 계약입니다.
const failures = {
  UNAUTHENTICATED: { status: 401, message: "로그인이 필요합니다." },
  FORBIDDEN: { status: 403, message: "수료 기록을 다룰 권한이 없습니다." },
  DISABLED: { status: 404, message: "수료 기능을 준비 중입니다." },
  NOT_FOUND: { status: 404, message: "대상을 찾을 수 없습니다." },
  CONFLICT: {
    status: 409,
    message: "이미 공개되었거나 처리된 기록입니다. 다시 조회해 주세요.",
  },
  VERSION_CONFLICT: {
    status: 409,
    message: "다른 결정이 먼저 기록되었습니다. 다시 조회해 주세요.",
  },
  INVALID_INPUT: { status: 422, message: "입력값을 확인해 주세요." },
  UNAVAILABLE: { status: 503, message: "잠시 후 다시 시도해 주세요." },
} as const;
export type AcademicCompletionErrorCode = keyof typeof failures;

export class AcademicCompletionError extends Error {
  readonly status: number;
  constructor(readonly code: AcademicCompletionErrorCode) {
    super(failures[code].message);
    this.name = "AcademicCompletionError";
    this.status = failures[code].status;
  }
}

// SQL 함수가 내보내는 SQLSTATE만 고정 코드로 바꿉니다. 그 밖의 오류는 UNAVAILABLE로 숨깁니다.
const sqlStates: Record<string, AcademicCompletionErrorCode> = {
  HRA01: "FORBIDDEN",
  HRA02: "CONFLICT",
  HRA03: "NOT_FOUND",
  HRA04: "CONFLICT",
  HRA06: "VERSION_CONFLICT",
  HRA07: "INVALID_INPUT",
  "23505": "CONFLICT",
  "23503": "NOT_FOUND",
};

/** Drizzle·Neon이 감싼 PostgreSQL 오류의 code만 제한된 깊이로 읽습니다. message·detail은 읽지 않습니다. */
export function toAcademicCompletionError(error: unknown): AcademicCompletionError {
  if (error instanceof AcademicCompletionError) return error;
  let current: unknown = error;
  for (let depth = 0; depth < 3 && typeof current === "object" && current !== null; depth++) {
    const code = Object.getOwnPropertyDescriptor(current, "code")?.value;
    if (typeof code === "string" && Object.hasOwn(sqlStates, code))
      return new AcademicCompletionError(sqlStates[code]);
    current = Object.getOwnPropertyDescriptor(current, "cause")?.value;
  }
  return new AcademicCompletionError("UNAVAILABLE");
}

// 응답 DTO. 관리자 지정 ID 같은 내부 권한 근거는 내보내지 않습니다.
const timestamp = z.string().transform((value, context) => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    context.addIssue({ code: "custom", message: "시각 형식 오류" });
    return z.NEVER;
  }
  return parsed.toISOString();
});
const count = z.int().min(0);

/** 수료 심사 보조 지표. 미입력 출결이 있으면 출석률 충족 여부(met)는 null(판단 보류)입니다. */
export const snapshotSchema = z.object({
  enrollmentId: z.uuid(),
  criteriaVersionId: z.uuid(),
  criteriaVersion: z.int().min(1),
  computedAt: timestamp,
  attendance: z.object({
    classCount: count,
    presentCount: count,
    lateCount: count,
    absentCount: count,
    excusedCount: count,
    unmarkedCount: count,
    attendedCount: count,
    attendancePercent: z.number().min(0).max(100).nullable(),
    minAttendancePercent: z.int().min(0).max(100),
    met: z.boolean().nullable(),
  }),
  submissions: z.object({
    assignedCount: count,
    submittedCount: count,
    requiredCount: count,
    met: z.boolean(),
  }),
});
export type CompletionSnapshot = z.infer<typeof snapshotSchema>;

const criteriaRow = z
  .object({
    id: z.uuid(),
    cohort_id: z.uuid(),
    version: z.int().min(1),
    criteria: criteriaSchema,
    status: z.enum(CRITERIA_STATUSES),
    change_reason: z.string(),
    created_by_user_id: z.uuid(),
    created_at: timestamp,
    updated_at: timestamp,
    published_by_user_id: z.uuid().nullable(),
    published_at: timestamp.nullable(),
  })
  .transform((row) => ({
    id: row.id,
    cohortId: row.cohort_id,
    version: row.version,
    criteria: row.criteria,
    status: row.status,
    changeReason: row.change_reason,
    createdByUserId: row.created_by_user_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedByUserId: row.published_by_user_id,
    publishedAt: row.published_at,
  }));
const decisionRow = z
  .object({
    id: z.uuid(),
    enrollment_id: z.uuid(),
    cohort_id: z.uuid(),
    criteria_version_id: z.uuid(),
    decision_sequence: z.int().min(1),
    supersedes_decision_id: z.uuid().nullable(),
    decision: z.enum(COMPLETION_DECISIONS),
    reason: z.string(),
    snapshot: snapshotSchema,
    decided_by_user_id: z.uuid(),
    decided_at: timestamp,
  })
  .transform((row) => ({
    id: row.id,
    enrollmentId: row.enrollment_id,
    cohortId: row.cohort_id,
    criteriaVersionId: row.criteria_version_id,
    sequence: row.decision_sequence,
    supersedesDecisionId: row.supersedes_decision_id,
    decision: row.decision,
    reason: row.reason,
    snapshot: row.snapshot,
    decidedByUserId: row.decided_by_user_id,
    decidedAt: row.decided_at,
  }));

export const criteriaResultSchema = z.object({ criteria: criteriaRow, replayed: z.boolean() });
export const decisionResultSchema = z.object({ decision: decisionRow, replayed: z.boolean() });

export const cohortListSchema = z.array(z.object({ id: z.uuid(), name: z.string() }));

// 학사 운영 관리자용 심사 명부. 현재 결정 = 이력의 마지막 항목입니다.
export const rosterSchema = z
  .object({
    cohortId: z.uuid(),
    cohortName: z.string(),
    selectedCriteriaVersionId: z.uuid().nullable(),
    criteriaVersions: z.array(
      z.object({
        id: z.uuid(),
        version: z.int().min(1),
        status: z.enum(CRITERIA_STATUSES),
        criteria: criteriaSchema,
        changeReason: z.string(),
        createdAt: timestamp,
        updatedAt: timestamp,
        publishedAt: timestamp.nullable(),
      }),
    ),
    entries: z.array(
      z.object({
        enrollmentId: z.uuid(),
        displayName: z.string(),
        snapshot: snapshotSchema.nullable(),
        history: z.array(
          z.object({
            id: z.uuid(),
            sequence: z.int().min(1),
            decision: z.enum(COMPLETION_DECISIONS),
            reason: z.string(),
            criteriaVersionId: z.uuid(),
            criteriaVersion: z.int().min(1),
            decidedByUserId: z.uuid(),
            decidedAt: timestamp,
          }),
        ),
      }),
    ),
  })
  .transform((roster) => ({
    ...roster,
    entries: roster.entries.map((entry) => {
      const current = entry.history.at(-1) ?? null;
      return {
        ...entry,
        status: (current?.decision ?? "PENDING") as CompletionStatus,
        currentSequence: current?.sequence ?? 0,
      };
    }),
  }));

// 학생 본인 수료 상태. 사유·결정자·보조 지표는 포함하지 않습니다.
export const ownCompletionSchema = z.array(
  z
    .object({
      enrollmentId: z.uuid(),
      cohortId: z.uuid(),
      cohortName: z.string(),
      decision: z.enum(COMPLETION_DECISIONS).nullable(),
      decidedAt: timestamp.nullable(),
      criteriaVersion: z.int().min(1).nullable(),
    })
    .transform((entry) => ({
      ...entry,
      status: (entry.decision ?? "PENDING") as CompletionStatus,
    })),
);

export type CompletionCriteriaVersion = z.infer<typeof criteriaRow>;
export type CompletionDecisionRecord = z.infer<typeof decisionRow>;
export type CompletionRoster = z.infer<typeof rosterSchema>;
export type CompletionRosterEntry = CompletionRoster["entries"][number];
export type OwnCompletionEntry = z.infer<typeof ownCompletionSchema>[number];

// 화면 표시용 한국어 라벨입니다.
export const COMPLETION_STATUS_LABELS: Record<CompletionStatus, string> = {
  PENDING: "심사 전",
  COMPLETED: "수료",
  NOT_COMPLETED: "미수료",
  REVOKED: "수료 취소",
};
export const CRITERIA_STATUS_LABELS: Record<CriteriaStatus, string> = {
  DRAFT: "초안",
  PUBLISHED: "공개",
};
export const COMPLETION_REASON_NOTICE =
  "사유에는 진단명·연락처 등 개인정보나 민감한 내용을 적지 마세요. 사유는 5년간 보존되는 수료 기록에 남습니다.";
