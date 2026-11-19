/**
 * #162 과제 검토·피드백의 순수 계약입니다.
 *
 * - 사용 위치: `service.ts`(Application Service), `actions.ts`(Server Action), `/member/reviews`·학사 운영 피드백 공개·
 *   학생 과제 상세 화면.
 * - 입력 검증(zod/v4), 고정 오류 코드, DB 행 → DTO 변환만 담당하며 DB·세션에 접근하지 않습니다.
 * - 정책 근거: docs/ACADEMIC-OPERATIONS-POLICY.md P11(지정된 교수 검토자만)·P12(학생 공개는 학사 운영 관리자).
 *   정성 피드백이 기본이며 숫자 점수·학점·순위는 다루지 않습니다. 평가 표기(gradeLabel)는 계산하지 않는 짧은 문구입니다.
 */
import { z } from "zod/v4";

// 피드백 본문 길이 상한(SQL CHECK와 같음).
export const FEEDBACK_BODY_MAX = 5000;
export const GRADE_LABEL_MAX = 20;
const reason = z.string().trim().min(1).max(500);
const version = z.coerce.number().int().min(0).max(1_000_000);

// 검토자의 피드백 초안 저장 입력입니다. expectedVersion은 화면이 읽은 버전이며 신규 작성은 0입니다.
export const saveReviewSchema = z.strictObject({
  submissionId: z.uuid(),
  expectedVersion: version,
  body: z.string().trim().min(1).max(FEEDBACK_BODY_MAX),
  gradeLabel: z.string().trim().max(GRADE_LABEL_MAX).optional(),
  reason: reason.optional(),
});
export const submitReviewSchema = z.strictObject({ reviewId: z.uuid(), expectedVersion: version });
export const publishFeedbackSchema = z.strictObject({
  reviewId: z.uuid(),
  expectedVersion: version,
});
export const retractFeedbackSchema = z.strictObject({
  reviewId: z.uuid(),
  expectedVersion: version,
  reason,
});

// 외부에 DB 오류 원문·식별자를 노출하지 않는 고정 오류 계약입니다.
const failures = {
  UNAUTHENTICATED: { status: 401, message: "로그인이 필요합니다." },
  FORBIDDEN: { status: 403, message: "이 피드백을 처리할 권한이 없습니다." },
  DISABLED: { status: 404, message: "과제 검토 기능을 준비 중입니다." },
  NOT_FOUND: { status: 404, message: "대상을 찾을 수 없습니다." },
  CONFLICT: {
    status: 409,
    message: "피드백이 이미 바뀌었거나 처리할 수 없는 상태입니다. 다시 조회해 주세요.",
  },
  INVALID_INPUT: { status: 422, message: "입력값을 확인해 주세요." },
  UNAVAILABLE: { status: 503, message: "잠시 후 다시 시도해 주세요." },
} as const;
export type AssignmentReviewErrorCode = keyof typeof failures;

export class AssignmentReviewError extends Error {
  readonly status: number;
  constructor(readonly code: AssignmentReviewErrorCode) {
    super(failures[code].message);
    this.name = "AssignmentReviewError";
    this.status = failures[code].status;
  }
}

// SQL 함수가 내보내는 SQLSTATE만 고정 코드로 바꿉니다. 그 밖의 오류는 UNAVAILABLE로 숨깁니다.
const sqlStates: Record<string, AssignmentReviewErrorCode> = {
  HRA01: "FORBIDDEN",
  HRA03: "NOT_FOUND",
  HRA04: "CONFLICT",
  HRA07: "INVALID_INPUT",
  "23505": "CONFLICT",
};

/** Drizzle·Neon이 감싼 PostgreSQL 오류의 code만 제한된 깊이로 읽습니다. message·detail은 읽지 않습니다. */
export function toAssignmentReviewError(error: unknown): AssignmentReviewError {
  if (error instanceof AssignmentReviewError) return error;
  let current: unknown = error;
  for (let depth = 0; depth < 3 && typeof current === "object" && current !== null; depth++) {
    const code = Object.getOwnPropertyDescriptor(current, "code")?.value;
    if (typeof code === "string" && Object.hasOwn(sqlStates, code))
      return new AssignmentReviewError(sqlStates[code]);
    current = Object.getOwnPropertyDescriptor(current, "cause")?.value;
  }
  return new AssignmentReviewError("UNAVAILABLE");
}

// DB 시각 문자열을 ISO 문자열로 정규화합니다.
const timestamp = z.string().transform((value, context) => {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    context.addIssue({ code: "custom", message: "시각 형식 오류" });
    return z.NEVER;
  }
  return parsed.toISOString();
});
const status = z.enum(["DRAFT", "SUBMITTED"]);
const visibility = z.enum(["PRIVATE", "PUBLISHED_TO_STUDENT"]);

// 변경 함수가 돌려주는 검토 행. 공개자 식별자 외 내부 값은 화면에 쓰지 않습니다.
export const reviewResultSchema = z
  .object({
    id: z.uuid(),
    submission_id: z.uuid(),
    version: z.number().int(),
    status,
    visibility,
  })
  .transform((row) => ({
    id: row.id,
    submissionId: row.submission_id,
    version: row.version,
    status: row.status,
    visibility: row.visibility,
  }));

// 검토자 화면의 제출물 행. 학생 계정 식별자·저장 키는 포함하지 않습니다.
export const reviewSubmissionListSchema = z.array(
  z
    .object({
      submission_id: z.uuid(),
      file_id: z.uuid().nullable(),
      student_display_name: z.string(),
      submitted_at: timestamp,
      review_id: z.uuid().nullable(),
      review_version: z.number().int().nullable(),
      review_status: status.nullable(),
      review_visibility: visibility.nullable(),
      review_body: z.string().nullable(),
      review_grade_label: z.string().nullable(),
      review_updated_at: timestamp.nullable(),
    })
    .transform((row) => ({
      submissionId: row.submission_id,
      fileId: row.file_id,
      studentDisplayName: row.student_display_name,
      submittedAt: row.submitted_at,
      review:
        row.review_id === null ||
        row.review_version === null ||
        row.review_status === null ||
        row.review_visibility === null ||
        row.review_body === null
          ? null
          : {
              id: row.review_id,
              version: row.review_version,
              status: row.review_status,
              visibility: row.review_visibility,
              body: row.review_body,
              gradeLabel: row.review_grade_label,
              updatedAt: row.review_updated_at,
            },
    })),
);

// 학사 운영 관리자 공개 화면 행. selfRelated는 관리자 본인이 작성자·제출 학생이라 공개할 수 없는 행입니다.
export const publicationListSchema = z.array(
  z
    .object({
      review_id: z.uuid(),
      version: z.number().int(),
      visibility,
      assignment_id: z.uuid(),
      assignment_title: z.string(),
      student_display_name: z.string(),
      reviewer_user_id: z.uuid(),
      body: z.string(),
      grade_label: z.string().nullable(),
      submitted_at: timestamp,
      published_at: timestamp.nullable(),
      self_related: z.boolean(),
    })
    .transform((row) => ({
      reviewId: row.review_id,
      version: row.version,
      visibility: row.visibility,
      assignmentId: row.assignment_id,
      assignmentTitle: row.assignment_title,
      studentDisplayName: row.student_display_name,
      reviewerUserId: row.reviewer_user_id,
      body: row.body,
      gradeLabel: row.grade_label,
      submittedAt: row.submitted_at,
      publishedAt: row.published_at,
      selfRelated: row.self_related,
    })),
);

// 학생 본인에게 공개된 피드백. 검토자 식별자·이력·초안은 포함하지 않습니다.
export const publishedFeedbackListSchema = z.array(
  z
    .object({
      review_id: z.uuid(),
      body: z.string(),
      grade_label: z.string().nullable(),
      published_at: timestamp,
    })
    .transform((row) => ({
      id: row.review_id,
      body: row.body,
      gradeLabel: row.grade_label,
      publishedAt: row.published_at,
    })),
);

export type ReviewSubmission = z.infer<typeof reviewSubmissionListSchema>[number];
export type FeedbackForPublication = z.infer<typeof publicationListSchema>[number];
export type PublishedFeedback = z.infer<typeof publishedFeedbackListSchema>[number];

// 화면 표시용 한국어 상태 문구입니다.
export const REVIEW_STATUS_LABELS = { DRAFT: "작성 중", SUBMITTED: "제출됨" } as const;
export const REVIEW_VISIBILITY_LABELS = {
  PRIVATE: "학생 비공개",
  PUBLISHED_TO_STUDENT: "학생 공개",
} as const;
