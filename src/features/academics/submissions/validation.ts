/** 제출 최종화의 공개 입력·최소 결과·고정 오류 계약입니다. 저장 키와 메타는 입력받지 않습니다. */
import { z } from "zod/v4";
import {
  DOCUMENT_FORMATS,
  DOCUMENT_MIME_TYPES,
} from "@/features/academics/assignment-uploads/formats/types";

const identifier = z.uuid().toLowerCase();
export const finalizeSubmissionSchema = z
  .object({
    assignmentId: identifier,
    uploadIntentId: identifier,
    submissionKey: identifier,
  })
  .strict();
export type FinalizeSubmissionInput = z.infer<typeof finalizeSubmissionSchema>;

export const finalizedSubmissionSchema = z
  .object({
    assignmentId: identifier,
    submissionId: identifier,
    submittedAt: z.iso.datetime({ offset: true }),
    replayed: z.boolean(),
    file: z
      .object({
        fileId: identifier,
        originalName: z.string().min(1).max(255),
        mimeType: z.literal("application/pdf"),
        sizeBytes: z.number().int().min(1).max(52428800),
      })
      .strict(),
  })
  .strict();
export type FinalizedSubmission = z.infer<typeof finalizedSubmissionSchema>;

/**
 * #516 텍스트·발표자료 분리 제출(V2) 최종화 입력입니다. 의도 0~2개를 한 번에 원자적으로 확정합니다.
 * 0개·중복은 형식상 받되 서비스가 Blob을 읽기 전에 INCOMPLETE로 거부합니다(DB SUB06과 같은 의미).
 */
export const finalizeArtifactSubmissionSchema = z
  .object({
    assignmentId: identifier,
    uploadIntentIds: z.array(identifier).max(2),
    submissionKey: identifier,
  })
  .strict();
export type FinalizeArtifactSubmissionInput = z.infer<typeof finalizeArtifactSubmissionSchema>;

// 파일 형식과 MIME은 DB CHECK와 같이 형식별 정규값 하나로만 대응합니다.
const artifactFileSchema = z
  .object({
    fileId: identifier,
    artifactType: z.enum(["TEXT", "SLIDES"]),
    fileFormat: z.enum(DOCUMENT_FORMATS),
    originalName: z.string().min(1).max(255),
    mimeType: z.string(),
    sizeBytes: z.number().int().min(1).max(52428800),
  })
  .strict()
  .refine((file) => file.mimeType === DOCUMENT_MIME_TYPES[file.fileFormat]);
export const finalizedArtifactSubmissionSchema = z
  .object({
    assignmentId: identifier,
    submissionId: identifier,
    submittedAt: z.iso.datetime({ offset: true }),
    replayed: z.boolean(),
    files: z.array(artifactFileSchema).min(1).max(2),
  })
  .strict();
export type FinalizedArtifactSubmission = z.infer<typeof finalizedArtifactSubmissionSchema>;

const failureDetails = {
  DISABLED: { status: 404, message: "과제 제출을 준비 중입니다." },
  INVALID_INPUT: { status: 422, message: "제출 요청을 확인해 주세요." },
  FORBIDDEN: { status: 404, message: "제출할 과제를 찾을 수 없습니다." },
  CONFLICT: {
    status: 409,
    message: "이미 제출했거나 다른 제출에 사용한 요청입니다. 제출 내역을 확인해 주세요.",
  },
  EXPIRED: { status: 409, message: "업로드 유효기간이 지났습니다. 파일을 다시 올려 주세요." },
  NOT_READY: { status: 409, message: "파일 업로드 검증이 완료되지 않았습니다." },
  DEADLINE: { status: 409, message: "과제가 종료되었거나 제출 마감 시각이 지났습니다." },
  // #516: 과제의 제출 형식(PDF 단일 / 텍스트·발표자료)과 다른 최종 제출 경로를 사용한 경우(SUB01 중 형식 불일치)
  WRONG_FORMAT: {
    status: 409,
    message: "이 과제는 다른 제출 방식을 사용합니다. 과제 화면을 새로 고친 뒤 다시 제출해 주세요.",
  },
  // #516 SUB06: 필수 누락·미사용 항목 첨부·0개·같은 항목 중복
  INCOMPLETE: {
    status: 422,
    message:
      "과제가 요구하는 제출 항목과 맞지 않습니다. 필수 항목을 모두 올리고, 받지 않는 항목은 빼 주세요. 항목마다 파일은 1개만 제출할 수 있습니다.",
  },
  // #516 SUB07: 제출 1건 합계 100MiB 초과(정상 경로에서는 도달하지 않는 방어 상한)
  TOO_LARGE: { status: 422, message: "제출 파일의 합계 용량은 100MiB 이하여야 합니다." },
  UNAVAILABLE: {
    status: 503,
    message: "제출을 확인하지 못했습니다. 같은 요청으로 다시 시도해 주세요.",
  },
} as const;
export type SubmissionFailureCode = keyof typeof failureDetails;

export class SubmissionFinalizationError extends Error {
  readonly status: number;
  constructor(readonly code: SubmissionFailureCode) {
    super(failureDetails[code].message);
    this.name = "SubmissionFinalizationError";
    this.status = failureDetails[code].status;
  }
}

/**
 * SUB01 중 과제 제출 형식과 경로가 다른 경우의 고정 DB 문구입니다(scripts/migrate-academic-submission-artifacts.sql).
 * 같은 SQLSTATE의 다른 충돌과 구분하는 데만 쓰고, 문구 자체는 응답에 복사하지 않습니다.
 */
const wrongFormatMessages = new Set([
  "텍스트·발표자료 제출 과제는 새 최종 제출 경로를 사용해야 합니다.",
  "기존 PDF 단일 제출 과제는 기존 최종 제출 경로를 사용해야 합니다.",
]);

/**
 * 알려진 SQLSTATE만 해석하고 SQL·params·원본 message는 응답에 복사하지 않습니다.
 * 같은 멱등 키를 다른 대상에 동시에 쓰면 대상 행 잠금이 달라 SUB01 대신 고유 제약 23505가 날 수 있으며,
 * v1·V2 모두 같은 충돌(CONFLICT)로 대응합니다.
 */
export function translateFinalizationError(error: unknown): SubmissionFinalizationError {
  const codes: Record<string, SubmissionFailureCode> = {
    SUB01: "CONFLICT",
    SUB02: "FORBIDDEN",
    SUB03: "EXPIRED",
    SUB04: "NOT_READY",
    SUB05: "DEADLINE",
    SUB06: "INCOMPLETE",
    SUB07: "TOO_LARGE",
    "23505": "CONFLICT",
  };
  let current: unknown = error;
  try {
    for (let depth = 0; depth < 3 && typeof current === "object" && current !== null; depth++) {
      if (
        "code" in current &&
        current.code === "SUB01" &&
        "message" in current &&
        typeof current.message === "string" &&
        wrongFormatMessages.has(current.message)
      ) {
        return new SubmissionFinalizationError("WRONG_FORMAT");
      }
      if (
        "code" in current &&
        typeof current.code === "string" &&
        Object.hasOwn(codes, current.code)
      ) {
        return new SubmissionFinalizationError(codes[current.code]);
      }
      if ("code" in current && current.code === "P0001" && "message" in current) {
        if (current.message === "upload_conflict")
          return new SubmissionFinalizationError("CONFLICT");
        if (current.message === "upload_expired") return new SubmissionFinalizationError("EXPIRED");
        if (current.message === "upload_not_found")
          return new SubmissionFinalizationError("FORBIDDEN");
      }
      current = "cause" in current ? current.cause : null;
    }
  } catch {
    return new SubmissionFinalizationError("UNAVAILABLE");
  }
  return new SubmissionFinalizationError("UNAVAILABLE");
}
