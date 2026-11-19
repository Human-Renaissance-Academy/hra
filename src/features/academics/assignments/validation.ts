/** 과제 서버 입력 검증입니다. 한국시간 벽시계를 명시적으로 UTC 시각으로 변환합니다. */
import { z } from "zod/v4";
import {
  ASSIGNMENT_ARTIFACT_REQUIREMENTS,
  ASSIGNMENT_SUBMISSION_FORMATS,
} from "@/lib/db/academic-submission-artifacts";

const identifier = z.uuid().toLowerCase();

/** 자동 날짜 보정(예: 2월 30일)을 허용하지 않고 서버 로컬 TZ와 독립적으로 해석합니다. */
export function parseAssignmentKst(value: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(value);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
  if (
    year < 1000 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    hour > 23 ||
    minute > 59 ||
    (second || 0) > 59
  )
    return null;
  const wallClock = new Date(Date.UTC(year, month - 1, day, hour, minute, second || 0));
  if (
    wallClock.getUTCFullYear() !== year ||
    wallClock.getUTCMonth() !== month - 1 ||
    wallClock.getUTCDate() !== day
  )
    return null;
  return new Date(wallClock.getTime() - 9 * 60 * 60 * 1000).toISOString();
}

const dueAtKst = z
  .string()
  .refine(
    (value) => parseAssignmentKst(value) !== null,
    "마감은 유효한 한국시간 날짜와 시각으로 입력해 주세요.",
  )
  .nullable()
  .default(null);
const draftFields = {
  cohortId: identifier,
  scheduleEventId: identifier.nullable().default(null),
  scheduleSessionId: identifier.nullable().default(null),
  title: z
    .string()
    .trim()
    .min(1, "과제 제목을 입력해 주세요.")
    .max(200, "과제 제목은 200자 이하여야 합니다."),
  instructions: z.string().max(50000, "과제 안내는 50,000자 이하여야 합니다.").default(""),
  dueAtKst,
  // #516 제출 형식과 텍스트·발표자료 요구. 세 값은 함께 보내며, 보내지 않으면 기존 동작(LEGACY 생성·기존 값 유지)입니다.
  // LEGACY는 두 요구를 비우고(null), V2는 둘 다 지정하되 둘 다 미사용일 수 없습니다. 기능 gate는 서비스가 확인합니다.
  submissionFormat: z.enum(ASSIGNMENT_SUBMISSION_FORMATS).optional(),
  textRequirement: z.enum(ASSIGNMENT_ARTIFACT_REQUIREMENTS).nullable().optional(),
  slidesRequirement: z.enum(ASSIGNMENT_ARTIFACT_REQUIREMENTS).nullable().optional(),
};
const submissionPolicyMessage =
  "제출 형식과 텍스트·발표자료 요구를 확인해 주세요. 두 항목을 모두 미사용으로 둘 수 없습니다.";
type SubmissionPolicyFields = {
  submissionFormat?: string;
  textRequirement?: string | null;
  slidesRequirement?: string | null;
};
const validSubmissionPolicy = (data: SubmissionPolicyFields) => {
  const text = data.textRequirement ?? null,
    slides = data.slidesRequirement ?? null;
  if (data.submissionFormat === undefined)
    return data.textRequirement === undefined && data.slidesRequirement === undefined;
  if (data.submissionFormat === "LEGACY_SINGLE_PDF") return text === null && slides === null;
  return text !== null && slides !== null && !(text === "DISABLED" && slides === "DISABLED");
};
const requestFields = { requestId: identifier, correlationId: identifier.optional() };
const matchingSession = (data: {
  scheduleSessionId: string | null;
  scheduleEventId: string | null;
}) => data.scheduleSessionId === null || data.scheduleEventId !== null;

export const createAssignmentSchema = z
  .object({ ...requestFields, ...draftFields })
  .strict()
  .refine(matchingSession, "수업 세션을 지정하려면 수업도 선택해 주세요.")
  .refine(validSubmissionPolicy, submissionPolicyMessage);
export const updateDraftAssignmentSchema = z
  .object({
    ...requestFields,
    ...draftFields,
    assignmentId: identifier,
    expectedUpdatedAt: z.iso.datetime({ offset: true }),
  })
  .strict()
  .refine(matchingSession, "수업 세션을 지정하려면 수업도 선택해 주세요.")
  .refine(validSubmissionPolicy, submissionPolicyMessage);
export const assignmentTransitionSchema = z
  .object({ ...requestFields, assignmentId: identifier })
  .strict();
export const publishAssignmentSchema = z
  .object({
    ...requestFields,
    assignmentId: identifier,
    expectedUpdatedAt: z.iso.datetime({ offset: true }),
    expectedTargetFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export const listAssignmentsSchema = z
  .object({
    cohortId: identifier.optional(),
    status: z.enum(["DRAFT", "PUBLISHED", "CLOSED"]).optional(),
    limit: z.number().int().min(1).max(100).default(50),
    offset: z.number().int().min(0).max(10000).default(0),
  })
  .strict();

// PostgreSQL JSON의 정밀한 updated_at을 문자열로 유지해 낙관적 잠금 비교에 사용합니다.
const timestamp = z.iso.datetime({ offset: true });
export const assignmentResultSchema = z.object({
  assignment: z
    .object({
      id: identifier,
      cohort_id: identifier,
      schedule_event_id: identifier.nullable(),
      schedule_session_id: identifier.nullable(),
      title: z.string(),
      instructions: z.string(),
      due_at: timestamp.nullable(),
      status: z.enum(["DRAFT", "PUBLISHED", "CLOSED"]),
      created_by_user_id: identifier,
      published_by_user_id: identifier.nullable(),
      published_at: timestamp.nullable(),
      created_at: timestamp,
      updated_at: timestamp,
      // #516 이전 DB에는 컬럼이 없으므로 기존 PDF 단일 제출로 해석합니다.
      submission_format: z.enum(ASSIGNMENT_SUBMISSION_FORMATS).default("LEGACY_SINGLE_PDF"),
      text_requirement: z.enum(ASSIGNMENT_ARTIFACT_REQUIREMENTS).nullable().default(null),
      slides_requirement: z.enum(ASSIGNMENT_ARTIFACT_REQUIREMENTS).nullable().default(null),
    })
    .transform((row) => ({
      id: row.id,
      cohortId: row.cohort_id,
      scheduleEventId: row.schedule_event_id,
      scheduleSessionId: row.schedule_session_id,
      title: row.title,
      instructions: row.instructions,
      dueAt: row.due_at,
      status: row.status,
      createdByUserId: row.created_by_user_id,
      publishedByUserId: row.published_by_user_id,
      publishedAt: row.published_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      submissionFormat: row.submission_format,
      textRequirement: row.text_requirement,
      slidesRequirement: row.slides_requirement,
    })),
  targetCount: z.number().int().nonnegative(),
  replayed: z.boolean().default(false),
});
export type AssignmentMutationResult = z.infer<typeof assignmentResultSchema>;

/** 화면에는 검증의 고정 한국어 메시지만 전달하고 임의 입력값·키 이름은 노출하지 않습니다. */
export class AssignmentInputError extends Error {
  constructor(message = "과제 입력값을 확인해 주세요.") {
    super(message);
  }
}

// DB의 고정 상태 코드만 사용자 메시지로 바꿉니다. 오류 원문을 메시지로 복사하지 않습니다.
export class AssignmentOperationError extends Error {}
const operationMessages: Record<string, string> = {
  HRA01: "학사 운영 책임자 권한을 확인해 주세요.",
  HRA02: "이미 사용한 요청 ID입니다. 새 작업에는 새 요청 ID를 사용해 주세요.",
  HRA03: "과제를 찾을 수 없습니다.",
  HRA04: "공개된 과제는 수정할 수 없습니다.",
  HRA05: "다른 요청이 과제를 수정했습니다. 최신 내용을 불러온 뒤 다시 저장해 주세요.",
  HRA06: "초안은 바로 종료할 수 없습니다. 먼저 공개해 주세요.",
  HRA07: "과제 입력값을 확인해 주세요.",
  HRA08: "공개하려면 현재보다 미래인 마감 시각을 지정해 주세요.",
  HRA09: "공개 대상 명부가 변경되었습니다. 미리보기를 다시 확인해 주세요.",
};

export function rethrowAssignmentStorageError(error: unknown): never {
  let current: unknown = error;
  // Drizzle가 감싼 PostgreSQL cause를 제한된 깊이만 확인합니다.
  for (let depth = 0; depth < 3 && typeof current === "object" && current !== null; depth++) {
    if (
      "code" in current &&
      typeof current.code === "string" &&
      Object.hasOwn(operationMessages, current.code)
    ) {
      throw new AssignmentOperationError(operationMessages[current.code]);
    }
    current = "cause" in current ? current.cause : null;
  }
  throw error;
}

export function parseAssignmentInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    const knownMessages = new Set([
      "과제 제목을 입력해 주세요.",
      "과제 제목은 200자 이하여야 합니다.",
      "과제 안내는 50,000자 이하여야 합니다.",
      "수업 세션을 지정하려면 수업도 선택해 주세요.",
      "마감은 유효한 한국시간 날짜와 시각으로 입력해 주세요.",
      submissionPolicyMessage,
    ]);
    const message = parsed.error.issues.find((issue) => knownMessages.has(issue.message))?.message;
    throw new AssignmentInputError(message);
  }
  return parsed.data;
}
