/**
 * 공동 수업일지의 확정본 이력과 원본 첨부를 승인된 회원에게 제공합니다.
 * 기능 활성화 및 조회 제한을 통과한 다운로드만 비공개 저장소에 접근합니다.
 */
import "server-only";

import { get } from "@vercel/blob";
import { z } from "zod/v4";
import {
  enforceResourceReadLimit,
  ResourceReadLimitUnavailableError,
  ResourceReadRateLimitError,
} from "@/features/resources/read-limit";
import { logServerError } from "@/lib/errors";
import { requireSharedResourceReader } from "@/lib/resource-access";
import { resourceBlobToken } from "@/lib/resource-blob-store";
import { attachmentDisposition } from "@/lib/resource-download";
import {
  findClassLogDocumentDownload,
  findClassLogDocumentHistory,
  findClassLogDocumentSummaries,
  type ClassLogDocumentHistory,
} from "./read-repository";
import { protectedClassLogDocumentStream } from "./read-stream";

export type { ClassLogDocumentFile, ClassLogDocumentHistory } from "./read-repository";

const privateHeaders = {
  "Cache-Control": "private, no-store",
  "X-Content-Type-Options": "nosniff",
  "Content-Security-Policy": "sandbox; default-src 'none'",
};

function missingDocument(): Response {
  return new Response("파일을 찾을 수 없습니다.", { status: 404, headers: privateHeaders });
}

/** 기존 상세 화면은 승인 인가 후 문서형 일지에서만 별도 이력을 표시합니다. */
export async function listClassLogDocumentHistory(
  classLogId: string,
): Promise<ClassLogDocumentHistory | null> {
  await requireSharedResourceReader();
  if (process.env.CLASS_LOG_DOCUMENTS_ENABLED !== "true") return null;
  const parsed = z.uuid().safeParse(classLogId);
  if (!parsed.success) return null;
  return findClassLogDocumentHistory(parsed.data);
}

/** 브라우저에는 원본 이름과 첨부 스트림만 제공하고 비공개 저장소 좌표는 서버에 남깁니다. */
export async function getClassLogDocumentDownload(
  params: Promise<{ id: string }>,
  preview = false,
): Promise<Response> {
  const session = await requireSharedResourceReader();
  if (process.env.CLASS_LOG_DOCUMENTS_ENABLED !== "true") return missingDocument();
  const parsed = z.uuid().safeParse((await params).id);
  if (!parsed.success) return missingDocument();

  try {
    await enforceResourceReadLimit(session.user.id);
    const file = await findClassLogDocumentDownload(parsed.data);
    // UUID 입력의 대소문자 표기와 무관하게 DB 계약의 소문자 저장 키를 대조합니다.
    const key = `class-log-documents/${parsed.data.toLowerCase()}/original`;
    if (!file || file.storageKey !== key || (preview && file.format !== "PDF")) {
      return missingDocument();
    }

    const host = process.env.RESOURCE_PRIVATE_BLOB_HOST;
    const expectedUrl = `https://${host}/${key}`;
    const token = resourceBlobToken(expectedUrl);
    if (!host || !token) throw new Error("비공개 자료 저장소가 연결되지 않았습니다.");
    const blob = await get(key, {
      access: "private",
      token,
      storeId: host.split(".")[0],
      useCache: false,
      abortSignal: AbortSignal.timeout(45_000),
    });
    if (!blob || blob.statusCode !== 200) return missingDocument();

    if (
      blob.headers?.has("content-range") ||
      blob.blob.pathname !== key ||
      URL.parse(blob.blob.url)?.href !== expectedUrl ||
      blob.blob.size !== file.byteSize ||
      (preview && blob.blob.contentType !== "application/pdf")
    ) {
      await blob.stream.cancel();
      throw new Error("저장된 원본의 정보가 일치하지 않습니다.");
    }

    return new Response(protectedClassLogDocumentStream(blob.stream, file.byteSize), {
      headers: {
        ...privateHeaders,
        "Content-Type": preview ? "application/pdf" : "application/octet-stream",
        "Content-Disposition": attachmentDisposition(file.fileName, preview),
        "Content-Length": String(file.byteSize),
      },
    });
  } catch (error) {
    if (error instanceof ResourceReadRateLimitError) {
      return new Response("요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.", {
        status: 429,
        headers: { ...privateHeaders, "Retry-After": String(error.retryAfterSeconds) },
      });
    }
    if (error instanceof ResourceReadLimitUnavailableError) {
      return new Response("잠시 후 다시 시도해 주세요.", { status: 503, headers: privateHeaders });
    }
    logServerError("class-log-documents/download", null);
    return new Response("파일을 내려받을 수 없습니다.", { status: 502, headers: privateHeaders });
  }
}

/** 화면에 이미 허가된 일지에만 검색·최신 파일 형식을 덧붙입니다. */
export async function listClassLogDocumentSummaries(ids: string[]) {
  await requireSharedResourceReader();
  if (process.env.CLASS_LOG_DOCUMENTS_ENABLED !== "true") return [];
  return findClassLogDocumentSummaries(ids);
}
