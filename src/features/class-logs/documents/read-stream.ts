/**
 * 비공개 수업일지 원본을 스트리밍하며 메타데이터에 확정된 바이트 수를 확인합니다.
 * 저장소 오류와 취소 사유는 응답으로 전달하지 않습니다.
 */
import { logServerError } from "@/lib/errors";

/** 원본 스트림의 읽기, 종료 및 클라이언트 취소를 고정 오류로 처리합니다. */
export function protectedClassLogDocumentStream(
  source: ReadableStream<Uint8Array>,
  expectedBytes: number,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  let cancelled = false;
  let transferredBytes = 0;

  async function cancelReader() {
    try {
      await reader.cancel();
    } catch {
      logServerError("class-log-documents/cancel", new Error("파일 전송 취소에 실패했습니다."));
    } finally {
      reader.releaseLock();
    }
  }

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (cancelled) return;
        if (chunk.done) {
          if (transferredBytes !== expectedBytes) throw new Error("전송 크기가 일치하지 않습니다.");
          reader.releaseLock();
          controller.close();
          return;
        }
        transferredBytes += chunk.value.byteLength;
        if (transferredBytes > expectedBytes) throw new Error("전송 크기가 일치하지 않습니다.");
        controller.enqueue(chunk.value);
      } catch {
        if (cancelled) return;
        const error = new Error("파일 전송이 중단되었습니다.");
        logServerError("class-log-documents/stream", error);
        controller.error(error);
        await cancelReader();
      }
    },
    async cancel() {
      cancelled = true;
      await cancelReader();
    },
  });
}
