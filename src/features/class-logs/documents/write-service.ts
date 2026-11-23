/** 비공개 직접 업로드 예약과 서버 파일 검증을 기존 일지의 원자적 확정에 연결합니다. */
import "server-only";

import { generateClientTokenFromReadWriteToken } from "@vercel/blob/client";
import { z } from "zod/v4";
import {
  CLASS_LOG_DOCUMENT_MIME_TYPES,
  classLogDocumentUploadPath,
  classLogDocumentUploadSelection,
} from "./upload-contract";
import { classLogDocumentStore, verifyClassLogDocumentUpload } from "./upload-storage";
import { writeClassLogDocumentRequest } from "./write-repository";

const fileSelections = {
  pdf: classLogDocumentUploadSelection.refine((file) => file.fileFormat === "PDF").optional(),
  hangul: classLogDocumentUploadSelection.refine((file) => file.fileFormat !== "PDF").optional(),
};
const requestId = z.uuid();
const reserve = { action: z.literal("reserve"), requestId, ...fileSelections };

export const classLogDocumentWriteInput = z.union([
  z
    .strictObject({
      ...reserve,
      title: z.string().trim().min(1).max(300),
      content: z.string().max(15_000),
      classDay: z.iso.date(),
      weekNumber: z.number().int().positive().max(999),
      cohortId: z.uuid().nullable(),
    })
    .refine((input) => input.pdf || input.hangul),
  z
    .strictObject({
      ...reserve,
      logId: z.uuid(),
      version: z.number().int().positive().max(2_147_483_646),
      changeNote: z.string().trim().max(500).optional(),
    })
    .refine((input) => input.pdf || input.hangul),
  z.strictObject({ action: z.literal("finalize"), requestId }),
]);

/** 모든 파일은 한 요청에 묶이며 성공 재시도는 저장소 읽기보다 먼저 종료합니다. */
export async function submitClassLogDocument(
  actorId: string,
  input: z.infer<typeof classLogDocumentWriteInput>,
  checkSession: () => Promise<boolean>,
) {
  const { action, requestId, ...payload } = input;
  const result = await writeClassLogDocumentRequest(
    actorId,
    requestId,
    action === "reserve" ? "reserve" : "inspect",
    action === "reserve" ? payload : undefined,
  );
  if (result.state !== "reserved") return result;

  if (action === "finalize") {
    // 서버가 예약으로 확보한 파일만 순서대로 확인하고 확정합니다.
    for (const file of [result.pdf, result.hangul]) {
      if (file) await verifyClassLogDocumentUpload(file);
    }
    if (!(await checkSession())) return { state: "forbidden" } as const;
    return writeClassLogDocumentRequest(actorId, requestId, "publish");
  }

  const store = classLogDocumentStore();
  const files = [];
  for (const slot of ["pdf", "hangul"] as const) {
    const file = result[slot];
    if (!file) continue;
    const contentType = CLASS_LOG_DOCUMENT_MIME_TYPES[file.fileFormat];
    const pathname = classLogDocumentUploadPath(file.fileId);
    const token = await generateClientTokenFromReadWriteToken({
      token: store.token,
      pathname,
      allowedContentTypes: [contentType],
      maximumSizeInBytes: file.sizeBytes,
      validUntil: Date.parse(result.expiresAt),
      addRandomSuffix: false,
      allowOverwrite: false,
    });
    files.push({ slot, pathname, contentType, token });
  }
  return { state: "upload", files } as const;
}
