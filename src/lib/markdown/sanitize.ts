/**
 * Markdown 렌더링 보안 정책 (이슈 #19)
 *
 * 역할: rehype-sanitize를 위한 화이트리스트 기반 보안 스키마를 정의한다.
 *       관리자가 작성한 Markdown 또는 가이드 파일이 렌더링될 때
 *       script/iframe/inline event handler 등 위험 요소를 차단하여
 *       XSS 공격을 무력화한다.
 *
 * 정책 요약:
 *   허용: 제목/문단/목록/표(GFM), 인용문, 코드블록, 링크, 이미지(https + 화이트리스트 도메인)
 *   차단: script, iframe, object, embed, inline event handlers (onclick 등), style attribute
 *
 * 사용 위치:
 *   - src/components/markdown/markdown-viewer.tsx (rehypePlugins로 적용)
 *   - src/lib/markdown/__tests__/sanitize.test.ts (XSS 테스트)
 */

import { defaultSchema } from "rehype-sanitize";
import type { Options } from "rehype-sanitize";
import { projectBlobHost } from "@/lib/blob-host";
import { PRODUCTION_SITE_URL } from "@/lib/site-url";

// rehype-sanitize 스키마
// defaultSchema를 베이스로, 위험한 태그·속성을 추가로 차단한다.
export const sanitizeSchema: Options = {
  ...defaultSchema,
  // tagNames에서 raw HTML 위험 태그를 명시적으로 제거
  // (defaultSchema는 안전한 기본값이지만, GFM 표 등을 위해 명시적으로 보강)
  tagNames: [
    ...(defaultSchema.tagNames ?? []),
    // GFM 표 — remark-gfm 사용 시 필수
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    // 인용/코드 블록 보강
    "blockquote",
    "pre",
    "code",
    // 표 셀 안 줄바꿈 — 양식의 조원 명단 등에서 사용
    "br",
    // 열 너비 지정용 — colwidth 있는 표를 HTML로 직렬화할 때 생성
    "colgroup",
    "col",
  ].filter(
    // 명시적 차단 태그 제거 (이중 안전장치)
    (tag) => !["script", "iframe", "object", "embed", "form", "input", "button"].includes(tag),
  ),
  attributes: {
    ...(defaultSchema.attributes ?? {}),
    // 모든 태그에 공통으로 차단되는 속성을 정의하기 위해 별도 처리하지 않고
    // defaultSchema가 이미 onclick 등 inline event handler를 차단함을 신뢰
    // 단, style attribute는 명시적으로 제외
    "*": (defaultSchema.attributes?.["*"] ?? []).filter((attr) => attr !== "style"),
    // 새 창 속성을 제거해 rel 없는 target="_blank" 링크가 만들어지지 않게 한다.
    a: [...(defaultSchema.attributes?.a ?? []), ["rel", "noopener", "noreferrer", "nofollow"]],
    // <col width="N"> 또는 <col width="N%"> — colwidth 있는 표의 열 너비 지정
    // 절대 픽셀 정수 또는 1~3자리 퍼센트만 허용
    col: [["width", /^\d+$|^\d{1,3}%$/]],
    // 이미지 src/alt만 허용 — onload 등 차단
    // style 은 "width: X%" 패턴만 허용 (이미지 크기 조정용, 다른 CSS는 차단)
    img: [
      ["src"],
      ["alt"],
      ["title"],
      ["width"],
      ["height"],
      ["loading", "lazy", "eager"],
      ["style", /^width:\s*\d+(\.\d+)?%\s*;?\s*$/],
    ],
  },
  // protocols 화이트리스트 — javascript: 등 차단
  protocols: {
    href: ["http", "https", "mailto", "tel"],
    src: ["http", "https"],
  },
  // 이미지 src 도메인 검사는 sanitize 단계에서 직접 처리하기 어렵기 때문에
  // markdown-viewer 컴포넌트에서 url 검증 후 넘기는 추가 방어선을 둔다.
};

/** 같은 문서의 경로로 안전하게 해석되는지 확인합니다. 이 검사는 정규화 결과에도 적용합니다. */
function isSafeRelativeImageUrl(url: string): boolean {
  return url.startsWith("/") && !/^\/[\/\\]/.test(url);
}

/**
 * 신뢰된 서버 설정의 같은 사이트 이미지만 안전한 상대경로로 바꿉니다.
 * 원본과 반환 경로를 모두 검증하여 URL 정규화가 외부 이미지 요청을 만들지 않게 합니다.
 * Blob·기존 운영 주소는 기존 호환을 유지하며 요청 헤더나 브라우저 주소는 신뢰하지 않습니다.
 */
export function resolveAllowedImageSrc(url: string, trustedSiteOrigin?: string): string | null {
  if (!url) return null;
  if (url.startsWith("/")) return isSafeRelativeImageUrl(url) ? url : null;
  try {
    const parsed = new URL(url);
    // URL parser가 기본 HTTPS 포트 443을 빈 port로 정규화하는 기존 의미를 유지합니다.
    if (parsed.protocol !== "https:" || parsed.port || parsed.username || parsed.password)
      return null;

    // 설정도 HTTPS·무자격정보·표준 포트인 정확한 origin만 허용 근거로 사용합니다.
    const trusted = trustedSiteOrigin ? new URL(trustedSiteOrigin) : null;
    const sameSite =
      trusted &&
      trusted.protocol === "https:" &&
      !trusted.port &&
      !trusted.username &&
      !trusted.password &&
      trusted.origin === parsed.origin;
    if (sameSite) {
      const relative = `${parsed.pathname}${parsed.search}${parsed.hash}`;
      return isSafeRelativeImageUrl(relative) ? relative : null;
    }
    return parsed.hostname === projectBlobHost || parsed.origin === PRODUCTION_SITE_URL
      ? url
      : null;
  } catch {
    return null;
  }
}

/** 기존 boolean API도 실제 img src 결정과 동일한 정책을 사용합니다. */
export function isAllowedImageUrl(url: string, trustedSiteOrigin?: string): boolean {
  return resolveAllowedImageSrc(url, trustedSiteOrigin) !== null;
}
