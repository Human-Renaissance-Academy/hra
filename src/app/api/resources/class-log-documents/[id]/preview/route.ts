/** 공동 열람 권한으로 확정된 PDF 원본을 보호된 브라우저 탭에 표시합니다. */
import { getClassLogDocumentDownload } from "@/features/class-logs/documents/read-service";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  return getClassLogDocumentDownload(params, true);
}
