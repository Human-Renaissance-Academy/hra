/**
 * 확정된 수업일지 원본을 자료실의 보호 다운로드 경로에서 제공합니다.
 * 인가, 조회 및 비공개 저장소 접근은 읽기 서비스에서 수행합니다.
 */
import { getClassLogDocumentDownload } from "@/features/class-logs/documents/read-service";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  return getClassLogDocumentDownload(params);
}
