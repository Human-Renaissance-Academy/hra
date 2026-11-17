/**
 * 별도 데이터 자원이 없는 Vercel Preview의 업무 요청을 실행 전에 거부합니다.
 * 설정·Proxy·순수 Route가 공유하며 인증·DB·스토리지 모듈을 참조하지 않습니다.
 */
export function isRestrictedPreview(vercel: string | undefined, environment: string | undefined) {
  return vercel === "1" && environment === "preview";
}

/** metadata 읽기만 예외로 두며 쓰기 메서드나 유사 경로를 허용하지 않습니다. */
export function isSafePreviewMetadata(pathname: string, method: string) {
  return (
    (method === "GET" || method === "HEAD") &&
    (pathname === "/robots.txt" || pathname === "/sitemap.xml")
  );
}

/** 본문·쿠키를 읽지 않는 고정 응답으로 복구 시각이나 세션을 발급하지 않습니다. */
export function previewUnavailableResponse(method: string) {
  return new Response(
    method === "HEAD" ? null : "미리보기에서는 서비스 기능을 제공하지 않습니다.",
    {
      status: 503,
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex, nofollow",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
