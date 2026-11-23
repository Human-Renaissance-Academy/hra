/**
 * 수업일지 문서 선택과 비공개 업로드의 공용 계약입니다.
 * 화면과 서버가 파일 이름, 형식, 바이트 제한을 같은 규칙으로 검사합니다.
 */
import { z } from "zod/v4";
import {
  DOCUMENT_EXTENSIONS,
  DOCUMENT_MIME_TYPES,
  MAX_DOCUMENT_BYTES,
} from "@/features/academics/assignment-uploads/formats/types";

export const CLASS_LOG_DOCUMENT_FORMATS = ["PDF", "HWP", "HWPX"] as const;
export type ClassLogDocumentFormat = (typeof CLASS_LOG_DOCUMENT_FORMATS)[number];

export const MAX_CLASS_LOG_DOCUMENT_BYTES = MAX_DOCUMENT_BYTES;
export const CLASS_LOG_DOCUMENT_MIME_TYPES: Readonly<Record<ClassLogDocumentFormat, string>> =
  DOCUMENT_MIME_TYPES;

/** 브라우저가 제공한 MIME은 사용하지 않고, 확장자와 선언 형식으로 정규 MIME을 선택합니다. */
export const classLogDocumentUploadSelection = z
  .object({
    fileFormat: z.enum(CLASS_LOG_DOCUMENT_FORMATS),
    originalName: z
      .string()
      .trim()
      .min(1)
      .max(255)
      .refine((value) => !/[\x00-\x1f\x7f/\\]/.test(value), "파일 이름을 확인해 주세요."),
    sizeBytes: z.number().int().min(1).max(MAX_CLASS_LOG_DOCUMENT_BYTES),
  })
  .strict()
  .refine(
    ({ originalName, fileFormat }) => {
      const dot = originalName.lastIndexOf(".");
      return (
        dot > 0 && originalName.slice(dot + 1).toLowerCase() === DOCUMENT_EXTENSIONS[fileFormat]
      );
    },
    { path: ["originalName"], message: "파일 확장자와 형식이 일치해야 합니다." },
  );

export type ClassLogDocumentUploadSelection = z.infer<typeof classLogDocumentUploadSelection>;

/** 서버 원장의 파일 UUID에서만 객체 키를 생성합니다. */
export function classLogDocumentUploadPath(fileId: string): string {
  return `class-log-documents/${z.uuid().parse(fileId).toLowerCase()}/original`;
}
