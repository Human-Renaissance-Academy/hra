/**
 * 서버 원장의 파일 UUID로 비공개 Blob을 조회하고 원본의 형식과 무결성을 검증합니다.
 * 호출 서비스에서 인가와 업로드 의도 상태를 검사한 뒤 사용합니다.
 */
import "server-only";
import { createHash } from "node:crypto";
import { BlobNotFoundError, get, head } from "@vercel/blob";
import { resourceUploadStore } from "@/lib/resource-blob-store";
import { validateDeclaredDocument } from "@/features/academics/assignment-uploads/formats/detect";
import {
  CLASS_LOG_DOCUMENT_MIME_TYPES,
  classLogDocumentUploadPath,
  classLogDocumentUploadSelection,
  type ClassLogDocumentUploadSelection,
} from "./upload-contract";

const errorMessages = {
  INVALID_FILE: "PDF, HWP 또는 HWPX 원본의 형식과 크기를 확인해 주세요.",
  NOT_READY: "파일 저장을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.",
  UNAVAILABLE: "파일을 확인할 수 없습니다. 잠시 후 다시 시도해 주세요.",
};

export class ClassLogDocumentUploadError extends Error {
  constructor(readonly code: keyof typeof errorMessages) {
    super(errorMessages[code]);
    this.name = "ClassLogDocumentUploadError";
  }
}

/** 서버 설정에서 전용 비공개 저장소를 읽습니다. */
export function classLogDocumentStore() {
  try {
    const store = resourceUploadStore();
    if (store.access === "private") return store;
  } catch {
    throw new ClassLogDocumentUploadError("UNAVAILABLE");
  }
  throw new ClassLogDocumentUploadError("UNAVAILABLE");
}

// 구조 판별에는 전체 원본이 필요하므로 인스턴스마다 동시에 보관하는 원본을 하나로 제한합니다.
let verifying = false;

/** 정확한 응답 길이까지만 읽습니다. 실패한 경우 나머지 스트림을 취소합니다. */
async function readOriginal(stream: ReadableStream<Uint8Array>, sizeBytes: number) {
  const reader = stream.getReader();
  const bytes = new Uint8Array(sizeBytes);
  let sizeRead = 0;
  let complete = false;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (sizeRead + chunk.value.byteLength > sizeBytes) {
        throw new ClassLogDocumentUploadError("INVALID_FILE");
      }
      bytes.set(chunk.value, sizeRead);
      sizeRead += chunk.value.byteLength;
    }
    complete = true;
  } finally {
    if (!complete) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }

  if (sizeRead !== sizeBytes) throw new ClassLogDocumentUploadError("INVALID_FILE");
  return bytes;
}

/** 의도가 가리키는 원본의 ETag와 SHA-256을 반환합니다. */
export async function verifyClassLogDocumentUpload({
  fileId,
  ...selection
}: ClassLogDocumentUploadSelection & { fileId: string }): Promise<{
  etag: string;
  sha256: string;
}> {
  const parsed = classLogDocumentUploadSelection.safeParse(selection);
  if (!parsed.success) throw new ClassLogDocumentUploadError("INVALID_FILE");
  const { fileFormat, originalName, sizeBytes } = parsed.data;
  const pathname = classLogDocumentUploadPath(fileId);
  const contentType = CLASS_LOG_DOCUMENT_MIME_TYPES[fileFormat];
  const { host, token } = classLogDocumentStore();
  const expectedUrl = `https://${host}/${pathname}`;

  if (verifying) throw new ClassLogDocumentUploadError("UNAVAILABLE");
  verifying = true;
  try {
    const metadata = await head(pathname, { token, abortSignal: AbortSignal.timeout(10_000) });
    if (
      metadata.url !== expectedUrl ||
      metadata.pathname !== pathname ||
      metadata.size !== sizeBytes ||
      metadata.contentType !== contentType ||
      !metadata.etag ||
      metadata.etag.length > 255
    ) {
      throw new ClassLogDocumentUploadError("INVALID_FILE");
    }

    // SDK가 원본 본문을 읽는 동안에도 abortSignal을 적용합니다.
    const result = await get(pathname, {
      access: "private",
      token,
      useCache: false,
      abortSignal: AbortSignal.timeout(45_000),
    });
    if (!result || result.statusCode !== 200) {
      throw new ClassLogDocumentUploadError("NOT_READY");
    }
    if (
      result.blob.url !== expectedUrl ||
      result.blob.pathname !== pathname ||
      result.blob.etag !== metadata.etag ||
      result.blob.contentType !== contentType ||
      result.blob.size !== sizeBytes ||
      result.headers.get("content-length") !== String(sizeBytes) ||
      result.headers.has("content-range")
    ) {
      void result.stream.cancel().catch(() => undefined);
      throw new ClassLogDocumentUploadError("INVALID_FILE");
    }

    const bytes = await readOriginal(result.stream, sizeBytes);
    const checked = validateDeclaredDocument({
      bytes,
      fileName: originalName,
      declaredFormat: fileFormat,
      contentType,
      artifactType: "TEXT",
    });
    if (!checked.ok) throw new ClassLogDocumentUploadError("INVALID_FILE");

    return { etag: metadata.etag, sha256: createHash("sha256").update(bytes).digest("hex") };
  } catch (error) {
    if (error instanceof ClassLogDocumentUploadError) throw error;
    if (error instanceof BlobNotFoundError) throw new ClassLogDocumentUploadError("NOT_READY");
    throw new ClassLogDocumentUploadError("UNAVAILABLE");
  } finally {
    verifying = false;
  }
}
