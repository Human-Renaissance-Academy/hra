/** 학생 과제 업로드의 공개 입력·오류 계약. 저장 경로와 원본 이름을 분리한다. */
import { z } from "zod/v4";
// 형식 상수 파일은 의존성이 없어 브라우저 번들(client.ts)에서도 안전하게 가져올 수 있습니다.
import {
  ARTIFACT_DOCUMENT_FORMATS,
  ASSIGNMENT_ARTIFACT_TYPES,
  DOCUMENT_EXTENSIONS,
  DOCUMENT_FORMATS,
  DOCUMENT_MIME_TYPES,
  type DocumentFormatReason,
} from "./formats/types";

export const MAX_ASSIGNMENT_UPLOAD_BYTES = 50 * 1024 * 1024;
export const assignmentUploadInput = z
  .object({
    assignmentId: z.uuid(),
    requestId: z.uuid(),
    originalName: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine(
        (value) => !/[\x00-\x1f\x7f/\\]/.test(value) && /\.pdf$/i.test(value),
        "PDF 파일 이름을 확인해 주세요.",
      ),
    sizeBytes: z.number().int().min(1).max(MAX_ASSIGNMENT_UPLOAD_BYTES),
    mimeType: z.literal("application/pdf"),
  })
  .strict();
/**
 * #516 텍스트·발표자료 분리 제출(V2) 업로드 의도 입력입니다.
 * 산출물 유형별 허용 형식, 확장자, 형식별 정규 MIME이 모두 선언 형식과 맞아야 합니다.
 * 실제 내용은 업로드 뒤 서버 검증(validateDeclaredDocument)이 다시 판정하므로 이 검사는 사전 차단용입니다.
 */
export const artifactUploadInput = z
  .object({
    assignmentId: z.uuid(),
    requestId: z.uuid(),
    artifactType: z.enum(ASSIGNMENT_ARTIFACT_TYPES),
    fileFormat: z.enum(DOCUMENT_FORMATS),
    originalName: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine((value) => !/[\x00-\x1f\x7f/\\]/.test(value)),
    sizeBytes: z.number().int().min(1).max(MAX_ASSIGNMENT_UPLOAD_BYTES),
    mimeType: z.string(),
  })
  .strict()
  .superRefine((value, context) => {
    // 1) 산출물 유형이 받지 않는 형식 → 2) 확장자 불일치 → 3) 정규 MIME 불일치 순으로 거부합니다.
    const extension = value.originalName
      .slice(value.originalName.lastIndexOf(".") + 1)
      .toLowerCase();
    if (
      !ARTIFACT_DOCUMENT_FORMATS[value.artifactType].includes(value.fileFormat) ||
      !value.originalName.includes(".") ||
      extension !== DOCUMENT_EXTENSIONS[value.fileFormat] ||
      value.mimeType !== DOCUMENT_MIME_TYPES[value.fileFormat]
    ) {
      context.addIssue({ code: "custom", message: "제출 항목·파일 형식을 확인해 주세요." });
    }
  });
export type ArtifactUploadInput = z.infer<typeof artifactUploadInput>;
export const assignmentUploadSelection = z
  .object({ assignmentId: z.uuid(), uploadIntentId: z.uuid() })
  .strict();

const errors = {
  INVALID_FILE: [422, "비어 있지 않은 PDF 파일 한 개를 50MiB 이하로 선택해 주세요."],
  NOT_FOUND: [404, "업로드를 찾을 수 없습니다."],
  EXPIRED: [409, "업로드 유효기간 또는 과제 마감이 지났습니다."],
  CONFLICT: [409, "진행 중이거나 이미 완료된 요청입니다. 업로드 상태를 확인해 주세요."],
  NOT_READY: [409, "파일 저장을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요."],
  RATE_LIMITED: [429, "업로드 요청이 많습니다. 잠시 후 다시 시도해 주세요."],
  DISABLED: [404, "과제 업로드를 준비하고 있습니다."],
  UNAVAILABLE: [503, "업로드를 처리할 수 없습니다. 잠시 후 다시 시도해 주세요."],
} as const;
export type AcademicUploadErrorCode = keyof typeof errors;

/**
 * V2 파일 거부 사유별 고정 한국어 안내입니다. 코드는 기존 INVALID_FILE(422)을 유지해 API 계약을 바꾸지 않고
 * 문구만 사유에 맞게 고릅니다. SELECTION은 형식 탐지 전 선택·메타 불일치(크기·MIME·저장 메타),
 * ARTIFACT_DISABLED는 과제가 미사용으로 지정한 항목(텍스트 또는 발표자료)의 업로드입니다.
 */
export type ArtifactFileReason = DocumentFormatReason | "SELECTION" | "ARTIFACT_DISABLED";
const artifactFileMessages: Record<ArtifactFileReason, string> = {
  SELECTION: "제출 항목·파일 형식·이름·크기를 확인해 주세요. 파일은 50MiB 이하여야 합니다.",
  ARTIFACT_DISABLED: "이 과제는 해당 제출 항목을 받지 않습니다.",
  TOO_LARGE: "파일은 50MiB 이하만 제출할 수 있습니다.",
  EMPTY: "빈 파일은 제출할 수 없습니다.",
  UNKNOWN_FORMAT:
    "지원하지 않는 파일 형식입니다. 텍스트는 HWP·HWPX·PDF, 발표자료는 PPT·PPTX·PDF로 제출해 주세요.",
  UNSUPPORTED:
    "지원하지 않는 파일 형식입니다. 텍스트는 HWP·HWPX·PDF, 발표자료는 PPT·PPTX·PDF로 제출해 주세요.",
  MALFORMED: "파일이 손상되었거나 내용을 확인할 수 없습니다. 원본을 다시 저장한 뒤 올려 주세요.",
  ENCRYPTED: "암호가 설정된 문서는 제출할 수 없습니다. 암호를 해제한 뒤 다시 올려 주세요.",
  MACRO:
    "매크로·VBA가 포함된 발표자료는 제출할 수 없습니다. 매크로를 제거하거나 PDF로 저장해 올려 주세요.",
  ZIP_LIMIT:
    "문서 내부 구조가 허용 범위를 넘습니다. 다른 이름으로 다시 저장하거나 PDF로 올려 주세요.",
  PATH_TRAVERSAL:
    "안전하지 않은 문서 구조가 발견되어 제출할 수 없습니다. 원본을 다시 저장한 뒤 올려 주세요.",
  POLYGLOT:
    "안전하지 않은 문서 구조가 발견되어 제출할 수 없습니다. 원본을 다시 저장한 뒤 올려 주세요.",
  EXTENSION_MISMATCH: "파일 확장자가 선택한 형식과 다릅니다.",
  MIME_MISMATCH: "파일 형식 정보가 선택한 형식과 다릅니다. 파일을 다시 선택해 주세요.",
  FORMAT_MISMATCH: "파일 내용이 확장자와 다른 형식입니다. 실제 형식에 맞게 저장해 올려 주세요.",
  ARTIFACT_NOT_ALLOWED: "이 제출 항목에서 받지 않는 파일 형식입니다.",
};

export class AcademicUploadError extends Error {
  readonly status: number;
  readonly retryAfterSeconds?: number;
  /** V2 INVALID_FILE의 거부 사유. 응답 문구 선택과 시험에만 쓰며 원본 파일 정보는 담지 않습니다. */
  readonly reason?: ArtifactFileReason;
  constructor(
    readonly code: AcademicUploadErrorCode,
    retryAfterSeconds?: number,
    reason?: ArtifactFileReason,
  ) {
    // 공용 API v1과 같은 필드명을 쓰되, 이 기능의 60초 창 밖 값은 신뢰하지 않습니다.
    const wait =
      typeof retryAfterSeconds === "number" &&
      Number.isInteger(retryAfterSeconds) &&
      retryAfterSeconds >= 1 &&
      retryAfterSeconds <= 60
        ? retryAfterSeconds
        : 60;
    const detailed =
      code === "INVALID_FILE" &&
      reason !== undefined &&
      Object.hasOwn(artifactFileMessages, reason);
    super(
      code === "RATE_LIMITED"
        ? `업로드 요청이 많습니다. ${wait}초 후 같은 요청으로 제출 결과를 다시 확인해 주세요. 전송에 실패했거나 파일을 바꾸려면 기존 업로드를 취소한 뒤 새로 올려 주세요.`
        : detailed
          ? artifactFileMessages[reason]
          : errors[code][1],
    );
    this.status = errors[code][0];
    this.name = "AcademicUploadError";
    if (code === "RATE_LIMITED") this.retryAfterSeconds = wait;
    if (detailed) this.reason = reason;
  }
}
export function academicUploadPath(id: string): string {
  return `academic-uploads/v1/${id.toLowerCase()}/document.pdf`;
}
/** V2 저장 키. DB CHECK와 같이 의도 ID 아래 고정 이름 original만 쓰고 원본 파일명·확장자를 경로에 넣지 않습니다. */
export function academicUploadPathV2(id: string): string {
  return `academic-uploads/v2/${id.toLowerCase()}/original`;
}
/** 정리·영수증 경로 비교용: 해당 의도의 v1 또는 v2 정확한 키인지 확인합니다. */
export function isAcademicUploadPath(id: string, key: string): boolean {
  return key === academicUploadPath(id) || key === academicUploadPathV2(id);
}
export function assertAcademicUploadsEnabled(): void {
  if (process.env.ACADEMIC_ENABLED !== "true" || process.env.ACADEMIC_UPLOADS_ENABLED !== "true")
    throw new AcademicUploadError("DISABLED");
}
/** V2(텍스트·발표자료 분리 제출)는 기존 업로드 gate에 별도 gate를 더해 기본 비활성으로 둡니다. */
export function assertAcademicSubmissionArtifactsEnabled(): void {
  assertAcademicUploadsEnabled();
  if (process.env.ACADEMIC_SUBMISSION_ARTIFACTS_ENABLED !== "true")
    throw new AcademicUploadError("DISABLED");
}
/**
 * 화면 분기용 V2 기능 gate 조회입니다(서버 컴포넌트에서만 호출). 예외 대신 boolean을 돌려주며,
 * 실제 쓰기·업로드 경로는 각 서비스가 assertAcademicSubmissionArtifactsEnabled로 다시 확인합니다.
 */
export function isAcademicSubmissionArtifactsEnabled(): boolean {
  return (
    process.env.ACADEMIC_ENABLED === "true" &&
    process.env.ACADEMIC_UPLOADS_ENABLED === "true" &&
    process.env.ACADEMIC_SUBMISSION_ARTIFACTS_ENABLED === "true"
  );
}
