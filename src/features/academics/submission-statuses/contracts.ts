/** 과제 공개 스냅샷 현황의 입력·최소 응답 및 고정 한국어 오류 계약이다. */
import { z } from "zod/v4";
import { UUID_PATTERN } from "@/lib/auth-session";
import {
  ASSIGNMENT_ARTIFACT_REQUIREMENTS,
  ASSIGNMENT_SUBMISSION_FORMATS,
  MAX_ARTIFACT_FILE_BYTES,
  MAX_ARTIFACT_SUBMISSION_BYTES,
  STORED_FILE_FORMATS,
} from "@/lib/db/academic-submission-artifacts";

// 기수는 정확한 UUID 일치 조건이고 검색은 와일드카드 없는 이름 부분 문자열이다.
export const submissionStatusInput = z
  .object({
    assignmentId: z.string().regex(UUID_PATTERN),
    cohortId: z.string().regex(UUID_PATTERN).optional(),
    status: z.enum(["ALL", "SUBMITTED", "UNSUBMITTED"]).default("ALL"),
    search: z.string().trim().max(100).default(""),
    sort: z.enum(["name", "submittedAt"]).default("name"),
    direction: z.enum(["asc", "desc"]).default("asc"),
    page: z.number().int().min(1).max(10000).default(1),
    pageSize: z.number().int().min(1).max(100).default(30),
  })
  .strict();
export type SubmissionStatusInput = z.input<typeof submissionStatusInput>;
export type ParsedSubmissionStatusInput = z.output<typeof submissionStatusInput>;

/**
 * #516 분리 제출(V2) 과제의 학생별 제출 항목 요약이다. 파일명·저장 키·파일 ID 없이 유형·형식·크기만 둔다.
 * 분리 제출 gate가 켜져 있고 V2 과제의 제출 완료 행에만 있으며, 그 밖에는 키가 없거나 null이다.
 */
export const submissionStatusArtifact = z.object({
  artifactType: z.enum(["TEXT", "SLIDES"]),
  fileFormat: z.enum(STORED_FILE_FORMATS),
  sizeBytes: z.number().int().min(1).max(MAX_ARTIFACT_FILE_BYTES),
});
export type SubmissionStatusArtifact = z.output<typeof submissionStatusArtifact>;

// 저장 키·URL·이메일·학적 계정 ID 없이 운영 확인에 필요한 필드만 고른다.
export const submissionStatusRow = z.object({
  targetId: z.string().regex(UUID_PATTERN),
  displayName: z.string(),
  accountLinked: z.boolean(),
  enrollmentActive: z.boolean(),
  submittedAt: z.iso.datetime({ offset: true }).nullable(),
  artifacts: z.array(submissionStatusArtifact).max(2).nullable().optional(),
});
const requirement = z.enum(ASSIGNMENT_ARTIFACT_REQUIREMENTS);
export const submissionStatusSnapshot = z.object({
  assignment: z.object({
    id: z.string().regex(UUID_PATTERN),
    title: z.string(),
    cohortId: z.string().regex(UUID_PATTERN),
    status: z.enum(["PUBLISHED", "CLOSED"]),
    // #516: 분리 제출 gate가 켜져 있을 때만 조회한다. 키가 없으면 기존 PDF 단일 제출 화면·CSV와 같다.
    submissionFormat: z.enum(ASSIGNMENT_SUBMISSION_FORMATS).optional(),
    textRequirement: requirement.nullable().optional(),
    slidesRequirement: requirement.nullable().optional(),
  }),
  counts: z.object({
    total: z.number().int().nonnegative(),
    submitted: z.number().int().nonnegative(),
    unsubmitted: z.number().int().nonnegative(),
  }),
  filteredCount: z.number().int().nonnegative(),
  rows: z.array(submissionStatusRow),
});
export type SubmissionStatusSnapshot = z.output<typeof submissionStatusSnapshot>;
export type SubmissionStatusRow = z.output<typeof submissionStatusRow>;
export type SubmissionStatusAssignment = SubmissionStatusSnapshot["assignment"];

/**
 * #516: 분리 제출 과제의 요구·제출 항목이 DB 제약과 맞는지 다시 확인한다.
 * 어긋나면(파일 0개·항목 중복·미사용 첨부·필수 누락·합계 초과, PDF 과제에 항목 존재) 정상 현황으로 표시하지 않는다.
 */
export function submissionStatusArtifactsConsistent(snapshot: SubmissionStatusSnapshot): boolean {
  const { assignment } = snapshot;
  if (assignment.submissionFormat !== "ARTIFACTS_V2")
    return snapshot.rows.every((row) => row.artifacts === undefined || row.artifacts === null);
  const required = { TEXT: assignment.textRequirement, SLIDES: assignment.slidesRequirement };
  if (
    !required.TEXT ||
    !required.SLIDES ||
    (required.TEXT === "DISABLED" && required.SLIDES === "DISABLED")
  )
    return false;
  return snapshot.rows.every((row) => {
    const files = row.artifacts ?? [];
    if (!row.submittedAt) return files.length === 0;
    const types = files.map((file) => file.artifactType);
    return (
      files.length > 0 &&
      new Set(types).size === types.length &&
      types.every((type) => required[type] !== "DISABLED") &&
      (["TEXT", "SLIDES"] as const).every(
        (type) => required[type] !== "REQUIRED" || types.includes(type),
      ) &&
      files.reduce((sum, file) => sum + file.sizeBytes, 0) <= MAX_ARTIFACT_SUBMISSION_BYTES
    );
  });
}

const errors = {
  FORBIDDEN: { status: 403, message: "지정된 학사 운영 책임자만 조회할 수 있습니다." },
  NOT_FOUND: { status: 404, message: "과제를 찾을 수 없습니다." },
  INVALID_INPUT: { status: 422, message: "조회 조건이 올바르지 않습니다." },
  TOO_MANY_ROWS: {
    status: 422,
    message: "내보낼 대상이 너무 많습니다. 검색이나 제출 상태로 범위를 줄여 주세요.",
  },
  UNAVAILABLE: {
    status: 503,
    message: "제출 현황을 조회할 수 없습니다. 잠시 후 다시 시도해 주세요.",
  },
} as const;
export class SubmissionStatusError extends Error {
  readonly status: number;
  constructor(readonly code: keyof typeof errors) {
    super(errors[code].message);
    this.name = "SubmissionStatusError";
    this.status = errors[code].status;
  }
}

// 페이지/API에서 중복·미지원 쿼리를 숨기지 않고 인증 뒤 입력 검증에서 거부하게 만든다.
export function submissionStatusRequestInput(
  assignmentId: string,
  params: URLSearchParams,
): unknown {
  const input: Record<string, unknown> = { assignmentId };
  const allowed = new Set([
    "cohortId",
    "status",
    "search",
    "sort",
    "direction",
    "page",
    "pageSize",
  ]);
  for (const [key, value] of params) {
    if (!allowed.has(key) || params.getAll(key).length !== 1)
      return { assignmentId, invalidQuery: true };
    input[key] = key === "page" || key === "pageSize" ? Number(value) : value;
  }
  return input;
}
