/**
 * #516 텍스트·발표자료 분리 제출(V2) 학생 화면의 순수 규칙
 *
 * 역할:
 * - 항목별 표시 이름·허용 확장자(파일 선택 필터)·선언 형식 판정을 제공합니다.
 * - 브라우저에서 먼저 확인하는 파일별 50MiB·제출 합계 100MiB·필수 항목·최소 1개 규칙을 계산합니다.
 *
 * 사용 위치:
 * - `src/app/(member)/member/assignments/_components/artifact-submission-form.tsx`
 *
 * 주의:
 * - 이 검사는 사용자 안내용 사전 차단입니다. 실제 판정은 서버 검증(형식 탐지)과 DB 최종화 제약이 다시 수행합니다.
 * - 브라우저 번들에서도 쓰므로 서버 전용 모듈을 가져오지 않습니다.
 */
import { z } from "zod/v4";
import {
  ARTIFACT_DOCUMENT_FORMATS,
  DOCUMENT_EXTENSIONS,
  DOCUMENT_MIME_TYPES,
  type AssignmentArtifactType,
  type DocumentFormat,
} from "@/features/academics/assignment-uploads/formats/types";
import {
  MAX_ARTIFACT_FILE_BYTES,
  MAX_ARTIFACT_SUBMISSION_BYTES,
  type AssignmentArtifactRequirement,
} from "@/lib/db/academic-submission-artifacts";

/** 화면에 보여 줄 항목 순서와 이름 */
export const ARTIFACT_ORDER: readonly AssignmentArtifactType[] = ["TEXT", "SLIDES"];
export const ARTIFACT_LABELS: Record<AssignmentArtifactType, string> = {
  TEXT: "텍스트",
  SLIDES: "발표자료",
};
export const REQUIREMENT_LABELS: Record<AssignmentArtifactRequirement, string> = {
  REQUIRED: "필수",
  OPTIONAL: "선택",
  DISABLED: "미사용",
};

/** 항목별 허용 형식 안내 문구. 정책 문서(ASSIGNMENT-SUBMISSION-SCOPE.md)의 표기 순서를 따릅니다. */
const FORMAT_LABELS: Record<AssignmentArtifactType, string> = {
  TEXT: "HWP·HWPX·PDF",
  SLIDES: "PPT·PPTX·PDF",
};
export function artifactFormatLabel(type: AssignmentArtifactType): string {
  return FORMAT_LABELS[type];
}

/** 파일 선택 창의 accept 값. 확장자와 정규 MIME을 함께 넣어 운영체제별 선택 필터를 맞춥니다. */
export function artifactAccept(type: AssignmentArtifactType): string {
  const formats = ARTIFACT_DOCUMENT_FORMATS[type];
  return [
    ...formats.map((format) => `.${DOCUMENT_EXTENSIONS[format]}`),
    ...formats.map((format) => DOCUMENT_MIME_TYPES[format]),
  ].join(",");
}

/** 파일 이름의 확장자로 항목이 받는 선언 형식을 고릅니다. 받지 않는 확장자면 null입니다. */
export function declaredArtifactFormat(
  type: AssignmentArtifactType,
  fileName: string,
): DocumentFormat | null {
  const dot = fileName.lastIndexOf(".");
  if (dot < 1) return null;
  const extension = fileName.slice(dot + 1).toLowerCase();
  return (
    ARTIFACT_DOCUMENT_FORMATS[type].find((format) => DOCUMENT_EXTENSIONS[format] === extension) ??
    null
  );
}

export type ArtifactFileCheck =
  { ok: true; format: DocumentFormat } | { ok: false; message: string };

/** 선택한 파일의 이름·확장자·크기를 업로드 전에 확인합니다. */
export function checkArtifactFile(
  type: AssignmentArtifactType,
  file: { name: string; size: number },
): ArtifactFileCheck {
  if (!file.name.trim() || /[\x00-\x1f\x7f/\\]/.test(file.name) || file.name.length > 255)
    return {
      ok: false,
      message: "파일 이름을 확인해 주세요. 255자 이하의 일반 파일 이름만 받을 수 있습니다.",
    };
  const format = declaredArtifactFormat(type, file.name);
  if (!format)
    return {
      ok: false,
      message: `${ARTIFACT_LABELS[type]}은(는) ${artifactFormatLabel(type)} 파일만 제출할 수 있습니다.`,
    };
  if (file.size < 1) return { ok: false, message: "빈 파일은 제출할 수 없습니다." };
  if (file.size > MAX_ARTIFACT_FILE_BYTES)
    return { ok: false, message: "파일은 하나당 50MiB 이하만 제출할 수 있습니다." };
  return { ok: true, format };
}

/** 파일 크기를 KiB/MiB 단위로 표시합니다(상한 안내와 같은 이진 단위). */
export function formatArtifactSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.ceil(bytes / 1024))}KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MiB`;
}

export type ArtifactRequirements = Record<AssignmentArtifactType, AssignmentArtifactRequirement>;

/** 이미 고른 다른 항목과 합친 크기가 제출 합계 상한(100MiB)을 넘는지 확인합니다. */
export function exceedsArtifactTotal(
  sizes: Partial<Record<AssignmentArtifactType, number>>,
): boolean {
  return (sizes.TEXT ?? 0) + (sizes.SLIDES ?? 0) > MAX_ARTIFACT_SUBMISSION_BYTES;
}

/**
 * 새로고침 뒤 같은 요청으로 복구하기 위해 탭 저장소에 남기는 V2 시도 정보입니다.
 * 멱등 키·요청 ID·의도 ID·크기·검증 여부만 저장하고 파일·파일명·계정 정보는 저장하지 않습니다.
 */
const attemptSectionSchema = z
  .object({
    requestId: z.uuid(),
    uploadIntentId: z.uuid().optional(),
    sizeBytes: z.number().int().min(1).max(MAX_ARTIFACT_FILE_BYTES).optional(),
    verified: z.boolean(),
  })
  .strict();
const artifactAttemptSchema = z
  .object({
    submissionKey: z.uuid(),
    sections: z
      .object({ TEXT: attemptSectionSchema.optional(), SLIDES: attemptSectionSchema.optional() })
      .strict(),
  })
  .strict();
export type ArtifactAttempt = z.infer<typeof artifactAttemptSchema>;
export function readArtifactAttempt(
  storage: Pick<Storage, "getItem">,
  key: string,
): ArtifactAttempt | null {
  try {
    const raw = storage.getItem(key);
    if (!raw) return null;
    const parsed = artifactAttemptSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
export function saveArtifactAttempt(
  storage: Pick<Storage, "setItem">,
  key: string,
  value: ArtifactAttempt,
): boolean {
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

export type ArtifactReadiness = { ready: true } | { ready: false; message: string };

/**
 * 최종 제출 버튼을 켤 수 있는지 계산합니다.
 * - 검증 완료(verified)된 항목만 제출 대상으로 셉니다.
 * - 필수 항목이 모두 있어야 하고, 두 항목이 모두 선택이어도 최소 1개 파일이 있어야 합니다(정책 2).
 * - 미사용 항목에는 파일이 있을 수 없으며, 합계는 100MiB 이하여야 합니다.
 * - 아직 업로드·검증 중인 항목이 있으면 끝날 때까지 기다리게 합니다.
 */
export function artifactSubmissionReadiness(
  requirements: ArtifactRequirements,
  sections: Record<
    AssignmentArtifactType,
    { verified: boolean; sizeBytes?: number; pending: boolean }
  >,
): ArtifactReadiness {
  if (ARTIFACT_ORDER.some((type) => sections[type].pending))
    return { ready: false, message: "업로드와 파일 확인이 끝난 뒤 최종 제출할 수 있습니다." };
  const missing = ARTIFACT_ORDER.filter(
    (type) => requirements[type] === "REQUIRED" && !sections[type].verified,
  );
  if (missing.length > 0)
    return {
      ready: false,
      message: `필수 항목(${missing.map((type) => ARTIFACT_LABELS[type]).join("·")})을 올리고 확인을 마쳐 주세요.`,
    };
  if (ARTIFACT_ORDER.some((type) => requirements[type] === "DISABLED" && sections[type].verified))
    return { ready: false, message: "이 과제가 받지 않는 항목은 제출할 수 없습니다." };
  const verified = ARTIFACT_ORDER.filter((type) => sections[type].verified);
  if (verified.length === 0)
    return { ready: false, message: "최소 1개 파일을 올리고 확인을 마쳐야 제출할 수 있습니다." };
  if (
    exceedsArtifactTotal({
      TEXT: sections.TEXT.verified ? sections.TEXT.sizeBytes : 0,
      SLIDES: sections.SLIDES.verified ? sections.SLIDES.sizeBytes : 0,
    })
  )
    return { ready: false, message: "제출 파일의 합계 용량은 100MiB 이하여야 합니다." };
  return { ready: true };
}
