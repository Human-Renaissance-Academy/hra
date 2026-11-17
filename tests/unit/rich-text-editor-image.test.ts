/**
 * 이미지 저장 형식의 왕복 회귀를 실제 에디터와 공개 MarkdownViewer로 검증합니다 (#292).
 * 운영 DB·업로드 없이 합성 이미지를 편집하고 hidden input의 저장값을 다시 열어 비교합니다.
 */
import { createElement } from "react";
import type { Editor, JSONContent } from "@tiptap/core";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { RichTextEditor } from "@/components/admin/rich-text-editor";
import { MarkdownViewer } from "@/components/markdown/markdown-viewer";

beforeAll(() => {
  // ProseMirror의 위치 계산에 필요한 브라우저 API만 jsdom에 보충합니다.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const rectangle = {
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  };
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => rectangle;
  document.elementFromPoint = () => null;
});
afterEach(cleanup);

const imageAttrs = {
  src: '/images/book(가).png?label="A&B"&literal=&lt;&slash=\\&tag=<표지>',
  alt: "설명 [표지] *강조* _안내_ ~취소~ `코드` \\ \"인용\" '인용' <각괄호> &amp; &#34;\r\n설명 끝\t계속",
  title: '제목 "인용" (괄호) [대괄호] \\ <꺾쇠> &amp; &#34;\r\n제목 끝',
};

/** 실제 에디터 인스턴스에 접근하며 화면 저장에 사용하는 hidden input만 읽습니다. */
async function open(markdown = "") {
  const view = render(createElement(RichTextEditor, { name: "body", defaultValue: markdown }));
  await waitFor(() => expect(view.container.querySelector(".ProseMirror")).not.toBeNull());
  const element = view.container.querySelector(".ProseMirror") as HTMLElement & { editor: Editor };
  const saved = () => {
    const input = view.container.querySelector<HTMLInputElement>(
      'input[type="hidden"][name="body"]',
    );
    if (!input) throw new Error("이미지 저장값을 찾지 못했습니다.");
    return input.value;
  };
  return { view, editor: element.editor, saved };
}

/** 다른 문단을 수정하여 초기 문자열 대신 실제 직렬화 결과를 저장하도록 합니다. */
async function edit(editor: Editor) {
  await act(async () => {
    editor.commands.insertContentAt(editor.state.doc.content.size, {
      type: "paragraph",
      content: [{ type: "text", text: "수정" }],
    });
  });
}
function imageNode(editor: Editor): JSONContent {
  let image: JSONContent | undefined;
  editor.state.doc.descendants((node) => {
    if (node.type.name === "image") image = node.toJSON();
  });
  if (!image) throw new Error("저장한 이미지 노드를 다시 열지 못했습니다.");
  return image;
}

/** 공개 렌더러의 실제 정제·URL 허용 목록까지 적용한 최종 이미지 속성을 대조합니다. */
function expectPreview(markdown: string, width: string | null) {
  const preview = render(createElement(MarkdownViewer, { body: markdown }));
  const image = preview.container.querySelector("img");
  expect(image).not.toBeNull();
  // Markdown 경로는 공개 파서가 한글·따옴표를 URL 퍼센트 인코딩하고 HTML 경로는 원문을 유지합니다.
  expect(image?.getAttribute("src")).toBe(width ? imageAttrs.src : encodeURI(imageAttrs.src));
  expect(image?.getAttribute("alt")).toBe(imageAttrs.alt);
  expect(image?.getAttribute("title")).toBe(imageAttrs.title);
  expect(image?.style.width ?? "").toBe(width ?? "");
  // 기존 뷰어의 ReactMarkdown node 메타데이터 전달과 별개로 저장값에서 속성이 생기지 않아야 합니다.
  expect(
    image
      ?.getAttributeNames()
      .filter((name) => name !== "node")
      .sort(),
  ).toEqual((width ? ["src", "alt", "title", "style"] : ["src", "alt", "title"]).sort());
  preview.unmount();
}

describe("RichTextEditor 이미지 직렬화", () => {
  it.each([null, "50%"])(
    "특수문자·제목·이미지 주소를 두 번 저장하고 공개 표시해도 보존한다 (너비 %s)",
    async (width) => {
      const first = await open();
      await act(async () => {
        first.editor.commands.insertContent({ type: "image", attrs: { ...imageAttrs, width } });
      });
      const markdown = first.saved();
      first.view.unmount();
      const second = await open(markdown);
      expect(imageNode(second.editor).attrs).toMatchObject({ ...imageAttrs, width });
      await edit(second.editor);
      const savedAgain = second.saved();
      second.view.unmount();
      const third = await open(savedAgain);
      expect(imageNode(third.editor).attrs).toMatchObject({ ...imageAttrs, width });
      third.view.unmount();
      expectPreview(savedAgain, width);
    },
  );

  it("크기 조정 UI → 저장 → 다시 열기 → 전체화면 미리보기에서 제목과 설명을 유지한다", async () => {
    const first = await open();
    await act(async () => {
      first.editor.commands.insertContent({ type: "image", attrs: imageAttrs });
      first.editor.commands.setNodeSelection(0);
    });
    fireEvent.click(first.view.getByRole("button", { name: /^75%$/ }));
    const markdown = first.saved();
    first.view.unmount();
    const second = await open(markdown);
    expect(imageNode(second.editor).attrs).toMatchObject({ ...imageAttrs, width: "75%" });
    fireEvent.click(second.view.getByTitle("미리보기 (홈페이지 렌더링)"));
    const image = document.body.querySelector("article img");
    expect(image?.getAttribute("title")).toBe(imageAttrs.title);
    expect(image?.getAttribute("alt")).toBe(imageAttrs.alt);
    expect(image?.getAttribute("src")).toBe(imageAttrs.src);
    expect(image instanceof HTMLImageElement && image.style.width).toBe("75%");
  });

  it("직접 작성한 Markdown의 이스케이프와 인라인 서식은 이미지 설명의 원래 글자로 복원한다", async () => {
    const first = await open(
      String.raw`![설명 \*별표\* \`코드\` \\ \[대괄호\]](</images/book(가).png?x=1&amp;y=2> "제목 \"인용\"")`,
    );
    expect(imageNode(first.editor).attrs).toMatchObject({
      src: "/images/book(가).png?x=1&y=2",
      alt: "설명 *별표* `코드` \\ [대괄호]",
      title: '제목 "인용"',
    });
  });

  it.each([
    "0%",
    "101%",
    "-1%",
    "50px",
    "auto",
    "calc(50% + 1px)",
    "50%; color: red",
    '50%\" onerror=\"실행',
  ])("지원하지 않는 너비 %s를 저장하지 않고 원본 이미지로 되돌린다", async (width) => {
    const first = await open();
    await act(async () => {
      first.editor.commands.insertContent({
        type: "image",
        attrs: { src: "/images/book.png", width },
      });
    });
    const markdown = first.saved();
    expect(markdown).not.toContain("style=");
    expect(first.editor.getHTML()).not.toContain("style=");
    first.view.unmount();
    const second = await open(markdown);
    expect(imageNode(second.editor).attrs?.width).toBeNull();
  });

  it.each(["1%", "33.3%", "100%"])(
    "지원 범위의 퍼센트 너비 %s는 저장 후 복원한다",
    async (width) => {
      const first = await open(`<img src="/images/book.png" style="width: ${width}" />`);
      expect(imageNode(first.editor).attrs?.width).toBe(width);
      await edit(first.editor);
      expect(first.saved()).toContain(`style="width: ${width}"`);
    },
  );

  it.each(["0%", "101%", "50px", "auto"])(
    "기존 HTML의 지원하지 않는 너비 %s도 다시 열 때 제거한다",
    async (width) => {
      const first = await open(`<img src="/images/book.png" style="width: ${width}" />`);
      expect(imageNode(first.editor).attrs?.width).toBeNull();
      await edit(first.editor);
      expect(first.saved()).not.toContain("style=");
    },
  );

  it("공개 정제와 이미지 URL 제한이 위험 속성·외부 이미지를 계속 차단한다", () => {
    const preview = render(
      createElement(MarkdownViewer, {
        body: '<img src="/images/book.png" onerror="실행" style="width: 50%; position: fixed"><img src="https://outside.invalid/book.png"><script>실행</script>',
      }),
    );
    expect(preview.container.querySelectorAll("img")).toHaveLength(1);
    expect(preview.container.querySelector("img")?.hasAttribute("onerror")).toBe(false);
    expect(preview.container.querySelector("img")?.hasAttribute("style")).toBe(false);
    expect(preview.container.querySelector("script")).toBeNull();
  });
});

// 설정 origin을 실제 img 출력까지 전달하여 검사 함수만 바뀌는 불완전한 수정을 방지합니다.
describe("신뢰된 사이트 이미지 렌더링", () => {
  it.each(["https://hra-custom.invalid", "https://hra-preview.vercel.app"])(
    "%s 이미지의 경로·검색어·조각을 보존한다",
    (trustedSiteOrigin) => {
      const preview = render(
        createElement(MarkdownViewer, {
          body: `![표지](<${trustedSiteOrigin}/images/book.png?label=one&page=2#cover>)\n\n<img src="${trustedSiteOrigin}/images/book.png?label=one&amp;page=2#cover" alt="표지">`,
          trustedSiteOrigin,
        }),
      );
      expect(
        [...preview.container.querySelectorAll("img")].map((image) => image.getAttribute("src")),
      ).toEqual([
        "/images/book.png?label=one&page=2#cover",
        "/images/book.png?label=one&page=2#cover",
      ]);
    },
  );
});

// raw HTML과 Markdown 경로 모두 정규화 후 외부 주소가 되는 이미지를 렌더하지 않습니다.
it.each([
  "https://hra-custom.invalid//outside.invalid/x.png",
  "https://hra-custom.invalid/a/..//outside.invalid/x.png",
  "https://hra-custom.invalid/\\outside.invalid/x.png",
])("안전한 상대경로가 아닌 정규화 결과를 렌더하지 않는다: %s", (url) => {
  const preview = render(
    createElement(MarkdownViewer, {
      body: `<img src="${url}">`,
      trustedSiteOrigin: "https://hra-custom.invalid",
    }),
  );
  expect(preview.container.querySelectorAll("img")).toHaveLength(0);
});

// Markdown 문법에서 원문 경로가 보존되는 경우도 raw HTML과 같은 거부 정책을 적용합니다.
it.each([
  "https://hra-custom.invalid//outside.invalid/x.png",
  "https://hra-custom.invalid/a/..//outside.invalid/x.png",
])("Markdown의 안전하지 않은 상대경로 변환을 거부한다: %s", (url) => {
  const preview = render(
    createElement(MarkdownViewer, {
      body: `![합성 표지](<${url}>)`,
      trustedSiteOrigin: "https://hra-custom.invalid",
    }),
  );
  expect(preview.container.querySelectorAll("img")).toHaveLength(0);
});
