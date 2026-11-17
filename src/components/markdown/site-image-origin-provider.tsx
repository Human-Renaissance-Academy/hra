"use client";

/**
 * 루트 서버 레이아웃이 결정한 사이트 origin 문자열만 기존 클라이언트 소비자에 전달합니다.
 * Markdown 파서나 URL 검사 모듈을 import하지 않아 공개 본문의 서버 렌더 경계를 유지합니다.
 */
import { createContext, useContext } from "react";

// 독립 에디터 fixture 등 provider 밖의 소비자는 기존 상대경로·Blob 정책을 사용합니다.
const SiteImageOriginContext = createContext<string | undefined>(undefined);

/** 신뢰된 설정을 직렬화해 전달하며 요청 헤더·브라우저 주소를 조회하지 않습니다. */
export function SiteImageOriginProvider({
  origin,
  children,
}: {
  origin: string;
  children: React.ReactNode;
}) {
  return (
    <SiteImageOriginContext.Provider value={origin}>{children}</SiteImageOriginContext.Provider>
  );
}

/** 에디터 미리보기와 인쇄 뷰에서 서버가 전달한 값만 읽습니다. */
export function useSiteImageOrigin() {
  return useContext(SiteImageOriginContext);
}
