/** 로그인한 웹 회원의 수업일지 문서 예약·확정 HTTP 경계입니다. */
import { auth } from "@/lib/auth";
import { canReadSharedResource } from "@/features/resources/access";
import { reserveUploadAttempt } from "@/lib/rate-limit";
import { extractClientIp } from "@/lib/rate-limit-core";
import { isSameRequestOrigin } from "@/lib/request-origin";
import { logServerError } from "@/lib/errors";
import { ClassLogDocumentUploadError } from "@/features/class-logs/documents/upload-storage";
import {
  classLogDocumentWriteInput,
  submitClassLogDocument,
} from "@/features/class-logs/documents/write-service";

const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" };
const maximumBodyBytes = 64 * 1024;

// 같은 예약의 두 파일을 순서대로 검증하므로 기존 문서 검증 함수의 실행 상한을 적용합니다.
export const maxDuration = 120;

function fail(status: number, error: string, code: string, retryAfter?: number) {
  return Response.json(
    { error, code },
    {
      status,
      headers: { ...headers, ...(retryAfter ? { "Retry-After": String(retryAfter) } : {}) },
    },
  );
}

/** 실제 읽은 바이트 기준으로 본문 크기를 제한합니다. */
async function readJson(request: Request): Promise<unknown> {
  if (
    !request.body ||
    request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
  ) {
    return null;
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximumBodyBytes) return null;
      chunks.push(next.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  } finally {
    try {
      await reader.cancel();
    } catch {
      logServerError("class-log-documents/body-cancel", null);
    } finally {
      reader.releaseLock();
    }
  }
}

export async function POST(request: Request): Promise<Response> {
  if (
    process.env.CLASS_LOG_DOCUMENTS_ENABLED !== "true" ||
    process.env.CLASS_LOG_DOCUMENT_WRITES_ENABLED !== "true"
  ) {
    return fail(404, "수업일지 문서를 찾을 수 없습니다.", "DISABLED");
  }
  if (!isSameRequestOrigin(request)) return fail(403, "허용되지 않은 요청입니다.", "FORBIDDEN");

  try {
    const session = await auth();
    if (!session?.user?.id || !canReadSharedResource(session.user.role)) {
      return fail(403, "승인된 회원만 파일을 등록할 수 있습니다.", "FORBIDDEN");
    }
    const parsed = classLogDocumentWriteInput.safeParse(await readJson(request));
    if (!parsed.success)
      return fail(400, "수업일지 날짜와 파일 정보를 확인해 주세요.", "INVALID_INPUT");

    const limit = await reserveUploadAttempt(extractClientIp(request.headers));
    if (limit.unavailable) return fail(503, "잠시 후 다시 시도해 주세요.", "UNAVAILABLE");
    if (limit.blocked) {
      return fail(
        429,
        "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
        "RATE_LIMITED",
        limit.retryAfterSec,
      );
    }
    const userId = session.user.id;
    const result = await submitClassLogDocument(userId, parsed.data, async () => {
      // 외부 파일 검증을 기다린 사이 세션이 무효화됐는지 현재 요청 쿠키를 재확인합니다.
      const current = await auth();
      return current?.user?.id === userId && canReadSharedResource(current.user.role);
    });
    switch (result.state) {
      case "published":
      case "upload":
        return Response.json(result, { headers });
      case "forbidden":
        return fail(403, "이 수업일지를 등록하거나 수정할 권한이 없습니다.", "FORBIDDEN");
      case "busy":
        return fail(429, "처리 중인 등록이 있습니다. 잠시 후 다시 시도해 주세요.", "BUSY");
      case "conflict":
        return fail(409, "이미 등록된 수업일지이거나 최신 버전이 변경되었습니다.", "CONFLICT");
      case "expired":
      case "missing":
        return fail(409, "업로드 예약이 만료되었습니다. 파일을 다시 선택해 주세요.", "EXPIRED");
      default:
        return fail(503, "잠시 후 다시 시도해 주세요.", "UNAVAILABLE");
    }
  } catch (error) {
    if (error instanceof ClassLogDocumentUploadError) {
      if (error.code === "NOT_READY")
        return fail(409, "파일 전송이 아직 완료되지 않았습니다.", "NOT_READY");
      if (error.code === "INVALID_FILE")
        return fail(400, "파일의 실제 형식이나 크기를 확인해 주세요.", "INVALID_FILE");
    }
    logServerError("class-log-documents/write", null);
    return fail(503, "문서 등록을 완료할 수 없습니다. 잠시 후 다시 시도해 주세요.", "UNAVAILABLE");
  }
}
