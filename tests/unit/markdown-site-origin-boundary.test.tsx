/**
 * 서버에서 직렬화한 origin을 기존 클라이언트 소비자가 실제 img까지 전달하는지 확인합니다.
 * 실제 RootLayout/RSC·CSP 검증은 production 브라우저 경계 스크립트가 별도로 수행합니다.
 */
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SiteImageOriginProvider } from "@/components/markdown/site-image-origin-provider";
import { RichTextEditor } from "@/components/admin/rich-text-editor";
import { PrintView as ClassLogPrint } from "@/app/(member)/resources/[id]/print/_print-view";
import { PrintView as WeeklyPrint } from "@/app/(member)/resources/weekly-texts/[id]/print/_print-view";
import { PrintView as TemplatePrint } from "@/app/(member)/member/templates/[slug]/print/_print-view";

const origin = "https://hra-preview.vercel.app";
const body = `![합성 표지](${origin}/images/book.png?x=1#cover)`;
const common = { title: "합성 문서", fileTitle: "합성 인쇄", body };
afterEach(cleanup);

describe("클라이언트 사이트 origin 전달", () => {
  it.each([
    [
      "수업일지",
      <ClassLogPrint
        key="class-log"
        {...common}
        classDate={new Date("2026-11-17")}
        authorName={null}
      />,
    ],
    [
      "주차별 텍스트",
      <WeeklyPrint
        key="weekly"
        {...common}
        createdAt={new Date("2026-11-17")}
        cohortName={null}
        textType={null}
      />,
    ],
    ["보고서 양식", <TemplatePrint key="template" {...common} version="1.0" description={null} />],
  ])("%s 인쇄 본문이 전달된 origin을 사용한다", (_name, child) => {
    const view = render(<SiteImageOriginProvider origin={origin}>{child}</SiteImageOriginProvider>);
    expect(view.container.querySelector("img")?.getAttribute("src")).toBe(
      "/images/book.png?x=1#cover",
    );
  });

  it("실제 에디터 미리보기가 전달된 origin을 사용한다", async () => {
    const view = render(
      <SiteImageOriginProvider origin={origin}>
        <RichTextEditor name="body" defaultValue={body} />
      </SiteImageOriginProvider>,
    );
    fireEvent.click(view.getByTitle("미리보기 (홈페이지 렌더링)"));
    const dialog = await view.findByRole("dialog", {
      name: "미리보기 — 실제 홈페이지와 동일한 렌더링",
    });
    expect(dialog.querySelector("img")?.getAttribute("src")).toBe("/images/book.png?x=1#cover");
  });
});
