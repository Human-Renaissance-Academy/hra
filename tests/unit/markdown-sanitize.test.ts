/**
 * Markdown 보안 정책 단위 테스트 (이슈 #19)
 *
 * 검증 대상:
 *   - sanitizeSchema가 script/iframe/onclick 등 위험 요소를 차단
 *   - isAllowedImageUrl 도메인 화이트리스트
 */
import { describe, expect, it } from "vitest";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import { isAllowedImageUrl, resolveAllowedImageSrc, sanitizeSchema } from "@/lib/markdown/sanitize";

async function renderMarkdown(input: string): Promise<string> {
  const file = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSanitize, sanitizeSchema)
    .use(rehypeStringify)
    .process(input);
  return String(file);
}

describe("sanitizeSchema", () => {
  it("script 태그를 제거한다", async () => {
    const out = await renderMarkdown("<script>alert(1)</script>안녕");
    expect(out).not.toContain("<script>");
    expect(out).not.toContain("alert(1)");
  });

  it("iframe 태그를 제거한다", async () => {
    const out = await renderMarkdown('<iframe src="https://evil.com"></iframe>');
    expect(out).not.toContain("<iframe");
  });

  it("inline onclick 핸들러를 제거한다", async () => {
    const out = await renderMarkdown('<a href="#" onclick="alert(1)">click</a>');
    expect(out).not.toContain("onclick");
  });

  it("style 속성을 제거한다", async () => {
    const out = await renderMarkdown('<p style="color:red">텍스트</p>');
    expect(out).not.toContain("style=");
  });

  it("javascript: URL을 차단한다", async () => {
    const out = await renderMarkdown("[클릭](javascript:alert(1))");
    expect(out).not.toContain("javascript:");
  });

  it('rel 없는 새 창 링크에서 target="_blank"를 제거한다', async () => {
    const out = await renderMarkdown('<a href="https://example.com" target="_blank">링크</a>');
    expect(out).toContain('href="https://example.com"');
    expect(out).not.toContain('target="_blank"');
  });

  it("정상 표/링크/이미지는 유지한다", async () => {
    const out = await renderMarkdown(
      "| A | B |\n|---|---|\n| 1 | 2 |\n\n[링크](https://example.com)",
    );
    expect(out).toContain("<table>");
    expect(out).toContain('href="https://example.com"');
  });

  it("표 셀 안의 <br> 태그를 유지한다 (조원 명단 등)", async () => {
    const out = await renderMarkdown(
      "| 항목 | 값 |\n|---|---|\n| 조원 | 김철수<br>이영희<br>박민수 |",
    );
    expect(out).toContain("<br>");
    expect(out).toContain("김철수");
    expect(out).toContain("이영희");
  });
});

describe("isAllowedImageUrl", () => {
  it("프로젝트 Blob 저장소의 이미지는 허용한다", () => {
    expect(isAllowedImageUrl("https://4sompt13gxwuz2x8.public.blob.vercel-storage.com/x.png")).toBe(
      true,
    );
  });

  it("다른 Blob 저장소와 허용 호스트의 하위 도메인은 거부한다", () => {
    expect(isAllowedImageUrl("https://other.public.blob.vercel-storage.com/x.png")).toBe(false);
    expect(isAllowedImageUrl("https://sub.hra-website-theta.vercel.app/x.png")).toBe(false);
  });

  it("동일 출처 상대 경로는 허용한다", () => {
    expect(isAllowedImageUrl("/images/foo.png")).toBe(true);
  });

  it("외부 호스트로 해석되는 상대 경로는 거부한다", () => {
    expect(isAllowedImageUrl("//evil.com/image.png")).toBe(false);
    expect(isAllowedImageUrl("/\\evil.com/image.png")).toBe(false);
  });

  it("외부 임의 도메인은 거부한다", () => {
    expect(isAllowedImageUrl("https://evil.com/foo.png")).toBe(false);
  });

  it("data: 스킴은 거부한다", () => {
    expect(isAllowedImageUrl("data:image/png;base64,iVBOR")).toBe(false);
  });

  it("http(비암호화)는 거부한다", () => {
    expect(isAllowedImageUrl("http://blob.vercel-storage.com/x.png")).toBe(false);
  });
});

// 현재 배포 origin은 서버 설정으로만 주입하며 반환 경로도 외부 origin이 되지 않아야 합니다.
describe("환경별 사이트 이미지 origin", () => {
  const origin = "https://hra-custom.invalid";
  it.each([origin, "https://hra-preview.vercel.app", "https://localhost"])(
    "%s를 정확히 일치하는 HTTPS origin으로 허용한다",
    (trusted) => {
      expect(isAllowedImageUrl(`${trusted}/images/a.png?x=1#표지`, trusted)).toBe(true);
    },
  );
  it.each([
    "http://hra-custom.invalid/x.png",
    "data:image/png;base64,eA==",
    "javascript:alert(1)",
    "//outside.invalid/x.png",
    "/\\outside.invalid/x.png",
    "https://outside.invalid/x.png",
    "https://sub.hra-custom.invalid/x.png",
    "https://user@hra-custom.invalid/x.png",
    "https://user:pass@hra-custom.invalid/x.png",
    "https://hra-custom.invalid:444/x.png",
    "https://hra-custom.invalid//outside.invalid/x.png",
    "https://hra-custom.invalid/a/..//outside.invalid/x.png",
    "https://hra-custom.invalid/\\outside.invalid/x.png",
  ])("위험 URL을 거부한다: %s", (url) => {
    expect(isAllowedImageUrl(url, origin)).toBe(false);
  });
  it("HTTP 개발 설정은 절대 HTTP 이미지 허용 근거가 아니다", () => {
    expect(isAllowedImageUrl("http://localhost:3000/a.png", "http://localhost:3000")).toBe(false);
    expect(isAllowedImageUrl("/a.png", "http://localhost:3000")).toBe(true);
  });
  it("경로·검색어·조각은 URL parser의 인코딩 결과 그대로 반환한다", () => {
    expect(resolveAllowedImageSrc(`${origin}/images/표지.png?x=1&y=2#cover`, origin)).toBe(
      "/images/%ED%91%9C%EC%A7%80.png?x=1&y=2#cover",
    );
  });
  it("기본 443 정규화와 기존 Blob·운영 URL 호환을 유지한다", () => {
    expect(isAllowedImageUrl("https://hra-custom.invalid:443/a.png", origin)).toBe(true);
    expect(isAllowedImageUrl("https://hra-website-theta.vercel.app/a.png", origin)).toBe(true);
    expect(
      isAllowedImageUrl("https://4sompt13gxwuz2x8.public.blob.vercel-storage.com/a.png", origin),
    ).toBe(true);
  });
});
