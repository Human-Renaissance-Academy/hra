/**
 * Preview 전용 rewrite 목적지입니다. RootLayout·인증·DB·외부 SDK를 실행하지 않습니다.
 * 직접 접근도 환경과 무관하게 같은 503이며 요청 본문은 해석하지 않습니다.
 */
import { previewUnavailableResponse } from "@/lib/preview-boundary";

// 고정 응답도 정적 캐시로 바뀌지 않도록 모든 메서드에 요청별 계약을 적용합니다.
export const dynamic = "force-dynamic";

/** 요청의 메서드만 참조하며 body·headers·session을 읽지 않습니다. */
function unavailable(request: Request) {
  return previewUnavailableResponse(request.method);
}

export {
  unavailable as GET,
  unavailable as HEAD,
  unavailable as POST,
  unavailable as PUT,
  unavailable as PATCH,
  unavailable as DELETE,
  unavailable as OPTIONS,
};
