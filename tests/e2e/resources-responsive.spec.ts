/**
 * 회원 자료실(/resources) 반응형 회귀 (#601)
 *
 * 역할:
 * - 전용 실행기(scripts/verify-resources-responsive.mjs)가 준비한 격리 PostgreSQL·합성 계정으로 실제 로그인합니다.
 * - 320·375·390·768·1280px에서 본문 가로 넘침, 모바일 카드의 분류·제목·날짜·작성자, 다섯 카테고리의 줄바꿈과
 *   aria-pressed 선택 상태, 기수 선택·검색·업로드 버튼의 줄바꿈·조작, 상세/다운로드 링크, 빈 상태, 페이지네이션을 확인합니다.
 * - 화면별 스크린샷을 test-results/resources-responsive/에 남깁니다(.gitignore 대상, 커밋하지 않음).
 * - 실제 기기·Safari가 아닌 Chromium 화면 폭 에뮬레이션입니다.
 */
import { expect, test, type Locator, type Page } from "@playwright/test";
import {
  resourcesResponsiveIds as ids,
  resourcesResponsivePassword,
  resourcesResponsiveSlugs as slugs,
  resourcesResponsiveTitles as titles,
  resourcesResponsiveUsers as users,
} from "../support/resources-responsive-fixture.mjs";

const WIDTHS = [320, 375, 390, 768, 1280] as const;
const CATEGORIES = [
  "가이드북",
  "강의 자료",
  "주차별 텍스트",
  "주차별 수업일지",
  "보고서 양식",
] as const;
const SCREENSHOT_DIR = "test-results/resources-responsive";
// Tailwind md 경계(768px)부터 데스크톱 표, 그 미만은 모바일 카드입니다.
const isMobile = (width: number) => width < 768;

/** 공개 로그인 화면은 소셜 전용이므로 합성 계정은 실제 credentials API로 세션을 만듭니다. */
async function login(
  page: Page,
  baseURL: string | undefined,
  user: { email: string; role: string },
) {
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  await page.request.post("/api/auth/callback/credentials", {
    form: {
      csrfToken: csrf.csrfToken,
      email: user.email,
      password: resourcesResponsivePassword,
      callbackUrl: `${baseURL}/resources`,
    },
    headers: { Origin: baseURL ?? "", "X-Auth-Return-Redirect": "1" },
    maxRedirects: 0,
  });
  const session = await (await page.request.get("/api/auth/session")).json();
  expect(session.user?.role).toBe(user.role);
}

/** 문서 전체와 main 영역이 화면 폭보다 넓어지지 않는지(가로 스크롤·잘림 없음) 확인합니다. */
async function expectNoHorizontalOverflow(page: Page) {
  const geometry = await page.evaluate(() => {
    const root = document.documentElement;
    const main = document.querySelector("main");
    return {
      client: root.clientWidth,
      document: root.scrollWidth,
      body: document.body.scrollWidth,
      main: main ? main.scrollWidth : Number.POSITIVE_INFINITY,
      mainRight: main ? main.getBoundingClientRect().right : Number.POSITIVE_INFINITY,
    };
  });
  expect(geometry.document, "문서 가로 넘침").toBeLessThanOrEqual(geometry.client);
  expect(geometry.body, "body 가로 넘침").toBeLessThanOrEqual(geometry.client);
  expect(geometry.main, "main 가로 넘침").toBeLessThanOrEqual(geometry.client);
  expect(geometry.mainRight).toBeLessThanOrEqual(geometry.client + 1);
}

/** 요소가 화면 가로 범위 안에 완전히 들어오는지 확인합니다(가로 스크롤 없이 보임). */
async function expectWithinViewport(locator: Locator, label: string) {
  const box = await locator.boundingBox();
  const width = await locator.page().evaluate(() => document.documentElement.clientWidth);
  expect(box, `${label} 표시`).not.toBeNull();
  expect(box!.x, `${label} 왼쪽`).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width, `${label} 오른쪽`).toBeLessThanOrEqual(width + 1);
}

/** 현재 폭에서 보이는 목록(모바일 카드 또는 데스크톱 표)을 반환합니다. 숨겨진 쪽은 표시되지 않아야 합니다. */
async function visibleList(page: Page, width: number) {
  const mobile = page.getByTestId("mobile-resource-list");
  const desktop = page.getByTestId("desktop-resource-table");
  if (isMobile(width)) {
    await expect(mobile).toBeVisible();
    await expect(desktop).toBeHidden();
    return mobile;
  }
  await expect(desktop).toBeVisible();
  await expect(mobile).toBeHidden();
  return desktop;
}

/** 목록 항목(카드 article 또는 표 tbody 행)을 현재 표현 방식에 맞게 찾습니다. */
const entries = (list: Locator, width: number) =>
  isMobile(width) ? list.locator("article") : list.locator("tbody tr");

async function screenshot(page: Page, name: string) {
  await page.screenshot({ path: `${SCREENSHOT_DIR}/${name}.png`, fullPage: true });
}

test.describe("회원 자료실 반응형 (#601)", () => {
  test.skip(
    process.env.HRA_RESOURCES_RESPONSIVE_QA !== "true",
    "전용 격리 실행기가 합성 계정과 자료를 준비한다.",
  );

  for (const width of WIDTHS) {
    test(`[MEMBER ${width}px] 넘침 없이 카테고리·필터·링크·빈 상태·페이지네이션이 동작한다`, async ({
      page,
      baseURL,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await login(page, baseURL, users.member);
      await page.goto("/resources");
      await expect(
        page.getByRole("heading", { name: "자료실", exact: true, level: 1 }),
      ).toBeVisible();
      const portal = page.getByRole("region", { name: "학생 학습포털" });
      await expect(portal.getByRole("heading", { name: "학생 학습포털" })).toBeVisible();
      await expectWithinViewport(
        portal.getByRole("link", { name: "내 학습자료 보기" }),
        "학생 학습자료 바로가기",
      );
      await expect(page.getByRole("heading", { name: "자료실 전체 보기", level: 2 })).toBeVisible();
      await expectNoHorizontalOverflow(page);

      // 1) 다섯 카테고리: 모두 화면 안에 있고 기본 선택은 가이드북, 클릭하면 aria-pressed가 하나만 바뀝니다.
      const group = page.getByRole("group", { name: "자료 종류" });
      const groupWidth = await group.evaluate((element) => ({
        scroll: element.scrollWidth,
        client: element.clientWidth,
      }));
      expect(groupWidth.scroll, "카테고리 묶음 가로 스크롤").toBeLessThanOrEqual(groupWidth.client);
      for (const category of CATEGORIES) {
        const button = group.getByRole("button", { name: category, exact: true });
        await expectWithinViewport(button, `카테고리 ${category}`);
        await expect(button).toHaveAttribute(
          "aria-pressed",
          category === "가이드북" ? "true" : "false",
        );
        if (isMobile(width))
          expect(
            (await button.boundingBox())!.height,
            `${category} 터치 높이`,
          ).toBeGreaterThanOrEqual(44);
      }

      // 2) 가이드북 첫 페이지: 긴 제목도 줄바꿈되고 분류 배지·등록일이 보이며 상세 링크가 유지됩니다.
      const list = await visibleList(page, width);
      await expect(entries(list, width)).toHaveCount(10);
      const longLink = list.getByRole("link", { name: titles.guidebook(0), exact: true });
      await expect(longLink).toHaveAttribute("href", `/resources/guidebooks/${ids.guidebooks[0]}`);
      const first = entries(list, width).first();
      await expectWithinViewport(first, "첫 자료 항목");
      // 데스크톱 표는 overflow-x-auto 안에 있으므로, 문서 넘침과 별도로 표 내부 가로 스크롤도 없어야 합니다.
      const listWidth = await list.evaluate((element) => ({
        scroll: element.scrollWidth,
        client: element.clientWidth,
      }));
      expect(listWidth.scroll, "자료 목록 내부 가로 스크롤").toBeLessThanOrEqual(listWidth.client);
      await expect(first.getByText("가이드북", { exact: true })).toBeVisible();
      if (isMobile(width)) await expect(first.getByText(/^등록일: \d{4}/)).toBeVisible();
      else await expect(first.locator("td").nth(3)).toHaveText(/\d{4}/);
      await screenshot(page, `member-${width}-guidebooks`);

      // 3) 페이지네이션: 12개 → 2쪽. 640px 미만은 "현재 / 전체 페이지" 요약, 그 이상은 쪽 번호 버튼입니다.
      const next = page.getByRole("button", { name: "다음 페이지" });
      const previous = page.getByRole("button", { name: "이전 페이지" });
      await expectWithinViewport(next, "다음 페이지 버튼");
      await expect(previous).toBeDisabled();
      if (width < 640) await expect(page.getByText("1 / 2 페이지", { exact: true })).toBeVisible();
      else await expect(page.getByRole("button", { name: "2", exact: true })).toBeVisible();
      await next.click();
      await expect(entries(list, width)).toHaveCount(2);
      await expect(next).toBeDisabled();
      if (width < 640) await expect(page.getByText("2 / 2 페이지", { exact: true })).toBeVisible();
      await expect(
        list.getByRole("link", { name: titles.guidebook(11), exact: true }),
      ).toHaveAttribute("href", `/resources/guidebooks/${ids.guidebooks[11]}`);
      await expectNoHorizontalOverflow(page);
      await previous.click();
      await expect(entries(list, width)).toHaveCount(10);

      // 4) 빈 검색 상태: 현재 폭에서 보이는 목록에 안내 문구가 표시됩니다.
      const search = page.getByRole("searchbox", { name: "자료 검색" });
      await expectWithinViewport(search, "검색 입력");
      if (isMobile(width))
        expect((await search.boundingBox())!.height, "검색 터치 높이").toBeGreaterThanOrEqual(44);
      await search.fill("존재하지않는합성검색어");
      await expect(list.getByText("검색 결과가 없습니다.", { exact: true })).toBeVisible();
      await expect(next).toHaveCount(0);
      await expectNoHorizontalOverflow(page);
      await screenshot(page, `member-${width}-empty-search`);
      await search.fill("");

      // 5) 강의 자료: 학생용만 보이며 주차·강의명·작성자와 상세 링크를 유지합니다.
      await group.getByRole("button", { name: "강의 자료", exact: true }).click();
      await expect(group.getByRole("button", { name: "강의 자료", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(group.getByRole("button", { name: "가이드북", exact: true })).toHaveAttribute(
        "aria-pressed",
        "false",
      );
      await expect(entries(list, width)).toHaveCount(1);
      await expect(
        list.getByRole("link", { name: titles.materialStudent, exact: true }),
      ).toHaveAttribute("href", `/resources/class-materials/${ids.materialStudent}`);
      await expect(list.getByText("3주차", { exact: true })).toBeVisible();
      await expect(
        list.getByText(isMobile(width) ? `작성자: ${users.faculty.name}` : users.faculty.name, {
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.getByRole("link", { name: "자료 업로드" })).toHaveCount(0);

      // 6) 주차별 텍스트: 본인 기수 자료만, 본문은 상세 링크·첨부만 있으면 다운로드 링크입니다.
      await group.getByRole("button", { name: "주차별 텍스트", exact: true }).click();
      await expect(entries(list, width)).toHaveCount(2);
      await expect(
        list.getByRole("link", { name: titles.weeklyBody, exact: true }),
      ).toHaveAttribute("href", `/resources/weekly-texts/${ids.weeklyBody}`);
      const download = list.getByRole("link", { name: titles.weeklyFile, exact: true });
      await expect(download).toHaveAttribute(
        "href",
        `/api/resources/weekly-texts/${ids.weeklyFile}/download`,
      );
      await expect(download).toHaveAttribute("download", "");
      await expect(list.getByText(titles.weeklyOther)).toHaveCount(0);

      // 7) 기수 선택: 화면 안에서 열리고, 본인 기수를 고르면 업로드 버튼이 같은 줄 묶음 안에 줄바꿈되어 나타납니다.
      const cohort = page.getByRole("combobox");
      await expectWithinViewport(cohort, "기수 선택");
      if (isMobile(width))
        expect((await cohort.boundingBox())!.height, "기수 선택 터치 높이").toBeGreaterThanOrEqual(
          44,
        );
      await cohort.click();
      await page.getByRole("option", { name: titles.cohortA, exact: true }).click();
      await expect(cohort).toContainText(titles.cohortA);
      const upload = page.getByRole("link", { name: "업로드", exact: true });
      await expect(upload).toHaveAttribute(
        "href",
        `/resources/weekly-texts?cohortId=${ids.cohortA}`,
      );
      await expectWithinViewport(upload, "주차별 텍스트 업로드");
      await expectWithinViewport(search, "업로드 옆 검색 입력");
      await expectNoHorizontalOverflow(page);
      await screenshot(page, `member-${width}-weekly-texts-cohort`);

      // 8) 다른 기수 선택 시 빈 상태 문구와 업로드 버튼 숨김을 확인합니다.
      await cohort.click();
      await page.getByRole("option", { name: titles.cohortB, exact: true }).click();
      await expect(list.getByText("해당 기수의 자료가 없습니다.", { exact: true })).toBeVisible();
      await expect(upload).toHaveCount(0);
      await cohort.click();
      await page.getByRole("option", { name: "전체", exact: true }).click();

      // 9) 수업일지: 작성자가 보이고 작성 버튼이 화면 안에 있으며 상세 링크로 이동합니다.
      await group.getByRole("button", { name: "주차별 수업일지", exact: true }).click();
      const logLink = list.getByRole("link", { name: titles.log, exact: true });
      await expect(logLink).toHaveAttribute("href", `/resources/${ids.log}`);
      await expect(
        list.getByText(isMobile(width) ? `작성자: ${users.member.name}` : users.member.name, {
          exact: true,
        }),
      ).toBeVisible();
      const write = page.getByRole("link", { name: "수업일지 작성" });
      await expect(write).toHaveAttribute("href", "/resources/class-logs");
      await expectWithinViewport(write, "수업일지 작성");
      await expectNoHorizontalOverflow(page);
      await screenshot(page, `member-${width}-class-logs`);

      // 10) 보고서 양식: 양식·안내서 상세 경로 분기를 유지하고, 마지막 카테고리도 스크롤 없이 선택됩니다.
      await group.getByRole("button", { name: "보고서 양식", exact: true }).click();
      await expect(group.getByRole("button", { name: "보고서 양식", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      await expect(list.getByRole("link", { name: titles.template, exact: true })).toHaveAttribute(
        "href",
        `/member/templates/${slugs.template}`,
      );
      await expect(list.getByRole("link", { name: titles.guide, exact: true })).toHaveAttribute(
        "href",
        `/member/guides/${slugs.guide}`,
      );
      await expectNoHorizontalOverflow(page);

      // 11) 수업일지 상세의 목록 링크는 수업일지 분류를 다시 선택합니다.
      await group.getByRole("button", { name: "주차별 수업일지", exact: true }).click();
      await logLink.click();
      await expect(page).toHaveURL(new RegExp(`/resources/${ids.log}$`));
      await expect(page.getByText(titles.log).first()).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await page.getByRole("link", { name: "목록으로" }).click();
      await expect(page).toHaveURL(
        (url) =>
          url.pathname === "/resources" && url.searchParams.get("category") === "주차별 수업일지",
      );
      await expect(
        group.getByRole("button", { name: "주차별 수업일지", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");

      // 학습자료 바로가기에서 기수 텍스트를 열고 돌아오면 URL의 자료 분류가 유지됩니다.
      await page.setViewportSize({ width, height: 480 });
      await page.goto("/resources");
      const library = page.getByRole("heading", { name: "자료실 전체 보기", level: 2 });
      const initialLibraryY = await library.evaluate(
        (element) => element.getBoundingClientRect().top,
      );
      await portal.getByRole("link", { name: "내 학습자료 보기" }).click();
      await expect(page).toHaveURL(
        `/resources?category=${encodeURIComponent("주차별 텍스트")}#resource-library-heading`,
      );
      await expect(
        group.getByRole("button", { name: "주차별 텍스트", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
      await expect
        .poll(async () => {
          const y = (await library.boundingBox())?.y;
          return y !== undefined && y > 64 && y < initialLibraryY;
        })
        .toBe(true);
      await list.getByRole("link", { name: titles.weeklyBody, exact: true }).click();
      await expect(page).toHaveURL(new RegExp(`/resources/weekly-texts/${ids.weeklyBody}$`));
      await page.goBack();
      await expect(
        group.getByRole("button", { name: "주차별 텍스트", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");

      // 브라우저 뒤로가기와 상세 화면의 목록 링크 모두 주차별 텍스트 분류로 돌아옵니다.
      await list.getByRole("link", { name: titles.weeklyBody, exact: true }).click();
      await page.getByRole("link", { name: "목록으로" }).click();
      await expect(page).toHaveURL(
        (url) =>
          url.pathname === "/resources" && url.searchParams.get("category") === "주차별 텍스트",
      );
      await expect(
        group.getByRole("button", { name: "주차별 텍스트", exact: true }),
      ).toHaveAttribute("aria-pressed", "true");
    });
  }

  for (const width of [375, 1280]) {
    test(`[FACULTY ${width}px] 교수 업로드 버튼과 교수용 자료가 넘침 없이 보인다`, async ({
      page,
      baseURL,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await login(page, baseURL, users.faculty);
      await page.goto("/resources?category=강의 자료");
      const portal = page.getByRole("region", { name: "교수 학사포털" });
      await expect(portal.getByRole("heading", { name: "교수 학사포털" })).toBeVisible();
      const portalUpload = portal.getByRole("link", { name: "강의자료 등록" });
      await expect(portalUpload).toHaveAttribute("href", "/resources/class-materials");
      await expectWithinViewport(portalUpload, "교수 강의자료 등록");
      const group = page.getByRole("group", { name: "자료 종류" });
      await expect(group.getByRole("button", { name: "강의 자료", exact: true })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      const list = await visibleList(page, width);
      await expect(entries(list, width)).toHaveCount(2);
      await expect(
        list.getByRole("link", { name: titles.materialFaculty, exact: true }),
      ).toHaveAttribute("href", `/resources/class-materials/${ids.materialFaculty}`);
      const upload = page.getByRole("link", { name: "자료 업로드" });
      await expect(upload).toHaveAttribute("href", "/resources/class-materials");
      await expectWithinViewport(upload, "강의 자료 업로드");
      await expectNoHorizontalOverflow(page);
      await screenshot(page, `faculty-${width}-class-materials`);

      // 교수는 전체 기수의 주차별 텍스트를 보고, 특정 기수를 고를 때만 업로드 버튼이 나타납니다.
      await group.getByRole("button", { name: "주차별 텍스트", exact: true }).click();
      await expect(entries(list, width)).toHaveCount(3);
      await expect(page.getByRole("link", { name: "업로드", exact: true })).toHaveCount(0);
      await page.getByRole("combobox").click();
      await page.getByRole("option", { name: titles.cohortB, exact: true }).click();
      await expect(page.getByRole("link", { name: "업로드", exact: true })).toHaveAttribute(
        "href",
        `/resources/weekly-texts?cohortId=${ids.cohortB}`,
      );
      await expect(entries(list, width)).toHaveCount(1);
      await expectNoHorizontalOverflow(page);
    });
  }
});
