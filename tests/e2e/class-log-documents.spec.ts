/** 격리 PostgreSQL과 실제 웹 세션으로 기존 자료실의 문서 이력을 확인합니다. */
import { expect, test } from "@playwright/test";
import {
  resourcesResponsivePassword,
  resourcesResponsiveUsers,
} from "../support/resources-responsive-fixture.mjs";

const title = "합성 문서 수업일지";
const logId = "f0841000-0000-4000-8000-000000000001";

test.skip(process.env.HRA_CLASS_LOG_DOCUMENT_QA !== "true", "격리 수업일지 fixture 전용");

for (const width of [320, 390, 1280]) {
  test(`수업일지 ${width}px에서 주차·최신 파일·수정본·보호 공유가 동작합니다`, async ({
    page,
    context,
    baseURL,
  }) => {
    await page.setViewportSize({ width, height: 860 });
    const csrf = await (await page.request.get("/api/auth/csrf")).json();
    await page.request.post("/api/auth/callback/credentials", {
      form: {
        csrfToken: csrf.csrfToken,
        email: resourcesResponsiveUsers.member.email,
        password: resourcesResponsivePassword,
        callbackUrl: `${baseURL}/resources/class-logs`,
      },
      headers: { Origin: baseURL ?? "", "X-Auth-Return-Redirect": "1" },
      maxRedirects: 0,
    });
    const session = await (await page.request.get("/api/auth/session")).json();
    expect(session.user?.role).toBe("MEMBER");

    await page.goto("/resources/class-logs");
    await page.getByText("파일로 수업일지 등록", { exact: true }).click();
    await expect(page.locator('input[type="file"]').first()).toBeVisible();
    const filters = page.getByRole("form", { name: "수업일지 검색" });
    await filters.getByRole("combobox", { name: "주차" }).selectOption("7");
    await filters.getByRole("button", { name: "조회" }).click();
    await expect(page).toHaveURL(/\bweek=7\b/);
    await expect(page.getByText("7주차 · PDF · HWPX")).toBeVisible();
    await page.getByRole("link", { name: new RegExp(title) }).click();
    await expect(page).toHaveURL(new RegExp(`/resources/${logId}$`));
    await expect(page.getByRole("heading", { name: "7주차 파일" })).toBeVisible();
    await expect(page.getByRole("link", { name: "PDF 열기" })).toHaveAttribute(
      "href",
      /^\/api\/resources\/class-log-documents\/[0-9a-f-]+\/preview$/,
    );
    await expect(page.getByRole("link", { name: "합성.hwpx 내려받기" })).toHaveAttribute(
      "href",
      /^\/api\/resources\/class-log-documents\/[0-9a-f-]+\/download$/,
    );
    await page.getByText(/^버전 1 ·/).click();
    await expect(page.getByRole("link", { name: "합성.pdf 내려받기" })).toHaveCount(2);
    await page
      .locator("summary")
      .filter({ hasText: /^수정본 등록$/ })
      .click();
    await expect(page.getByRole("button", { name: "수정본 등록", exact: true })).toBeVisible();
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.getByRole("button", { name: "공유 링크 복사" }).click();
    await expect(page.getByRole("status")).toHaveText("수업일지 주소를 복사했습니다.");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      `${baseURL}/resources/${logId}`,
    );
    expect(
      await page.evaluate(() => document.body.scrollWidth <= document.documentElement.clientWidth),
    ).toBe(true);
  });
}
