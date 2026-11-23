/**
 * 수업일지 등록 폼의 비공개 파일 전송을 담당합니다.
 * 같은 요청에서 전송을 완료한 슬롯을 기억하고 확정만 다시 요청할 수 있습니다.
 */
import { put } from "@vercel/blob/client";
import { z } from "zod/v4";

const publishedResponse = z.object({
  state: z.literal("published"),
  logId: z.uuid(),
  version: z.number().int().positive(),
});

const uploadResponse = z.object({
  state: z.literal("upload"),
  files: z.array(
    z.object({
      slot: z.enum(["pdf", "hangul"]),
      pathname: z.string().min(1),
      contentType: z.string().min(1),
      token: z.string().min(1),
    }),
  ),
});

const responseSchema = z.discriminatedUnion("state", [
  publishedResponse,
  uploadResponse,
  z.object({ state: z.literal("ready") }),
]);

type Slot = "pdf" | "hangul";
type FileMetadata = {
  fileFormat: "PDF" | "HWP" | "HWPX";
  originalName: string;
  sizeBytes: number;
};
type ReserveFields = {
  pdf?: FileMetadata;
  hangul?: FileMetadata;
} & (
  | { title: string; content: string; classDay: string; weekNumber: number; cohortId: string }
  | { logId: string; version: number; changeNote?: string }
);

export type ClassLogDocumentAttempt = {
  requestId: string;
  uploaded: Partial<Record<Slot, string>>;
  finalizeOnly: boolean;
};

export class ClassLogDocumentUploadError extends Error {
  constructor(
    message: string,
    readonly restart = false,
  ) {
    super(message);
  }
}

const retryMessage = "등록을 확정하지 못했습니다. 입력을 유지한 채 다시 시도해 주세요.";

/** 업로드 응답의 원본 오류나 파일 주소를 화면에 표시하지 않습니다. */
async function requestDocument(
  input: { requestId: string } & (({ action: "reserve" } & ReserveFields) | { action: "finalize" }),
) {
  let response: Response;
  try {
    response = await fetch("/api/resources/class-log-documents", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch {
    throw new ClassLogDocumentUploadError("연결을 확인한 뒤 같은 입력으로 다시 시도해 주세요.");
  }

  const body: unknown = await response.json().catch(() => null);
  const parsed = responseSchema.safeParse(body);
  // 파일 확인 또는 확정을 재시도할 수 있는 상태는 같은 요청 번호로 이어갑니다.
  if (parsed.success && parsed.data.state === "ready") return parsed.data;
  if (!response.ok) {
    const failure = z.object({ code: z.string() }).safeParse(body);
    if (failure.success && failure.data.code === "NOT_READY") return { state: "ready" } as const;
    if (failure.success && failure.data.code === "EXPIRED") {
      throw new ClassLogDocumentUploadError(
        "업로드 예약이 만료되었습니다. 같은 입력으로 다시 등록해 주세요.",
        true,
      );
    }
    const messages: Partial<Record<number, string>> = {
      400: "입력값과 선택한 파일을 확인해 주세요.",
      401: "로그인 상태를 확인한 뒤 다시 시도해 주세요.",
      403: "이 수업일지를 등록하거나 수정할 권한이 없습니다.",
      404: "대상 수업일지나 등록 기능을 찾을 수 없습니다.",
      409: "이미 등록된 일지나 새 수정본이 있는지 확인해 주세요.",
      413: "파일 크기가 업로드 한도를 초과했습니다.",
      415: "PDF 또는 HWP/HWPX 형식의 원본 파일을 선택해 주세요.",
      429: "요청이 많습니다. 잠시 뒤 다시 시도해 주세요.",
    };
    throw new ClassLogDocumentUploadError(messages[response.status] ?? retryMessage);
  }

  if (!parsed.success) throw new ClassLogDocumentUploadError(retryMessage);
  return parsed.data;
}

/** 예약이 돌려준 파일 경로와 형식을 그대로 사용하며 확정에는 요청 번호만 전달합니다. */
export async function submitClassLogDocument(
  attempt: ClassLogDocumentAttempt,
  fields: ReserveFields,
  files: Partial<Record<Slot, File>>,
  onStatus: (status: string) => void,
) {
  let transmissionFailed = false;
  if (!attempt.finalizeOnly) {
    onStatus("등록을 준비하고 있습니다.");
    const reserved = await requestDocument({
      action: "reserve",
      requestId: attempt.requestId,
      ...fields,
    });
    if (reserved.state === "published") return reserved;
    if (reserved.state === "upload") {
      for (const target of reserved.files) {
        if (attempt.uploaded[target.slot] === target.pathname) continue;

        const file = files[target.slot];
        if (!file) throw new ClassLogDocumentUploadError("선택한 파일을 확인해 주세요.");

        onStatus("파일을 전송하고 있습니다.");
        try {
          await put(target.pathname, file, {
            access: "private",
            token: target.token,
            contentType: target.contentType,
            multipart: file.size > 5 * 1024 * 1024,
          });
          attempt.uploaded[target.slot] = target.pathname;
        } catch {
          // 응답만 유실된 파일도 서버가 확인할 수 있도록 나머지 전송과 확정을 시도합니다.
          transmissionFailed = true;
        }
      }
    }
    attempt.finalizeOnly = !transmissionFailed;
  }

  onStatus("등록을 확정하고 있습니다.");
  const finalized = await requestDocument({ action: "finalize", requestId: attempt.requestId });
  if (finalized.state === "published") return finalized;
  if (transmissionFailed) {
    throw new ClassLogDocumentUploadError(
      "파일 전송을 확인하지 못했습니다. 같은 입력으로 다시 시도해 주세요.",
    );
  }
  throw new ClassLogDocumentUploadError(retryMessage);
}
