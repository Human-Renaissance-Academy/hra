/**
 * #160 출결 입력·학사 운영 관리·내 출결 화면의 E2E 회귀입니다.
 *
 * - 비로그인 접근은 기존 회원 영역 Proxy 경계에서 로그인으로 이동해야 합니다(DB 불필요).
 * - 역할 조합 흐름(기수 A 운영 인력 입력 → 학사 운영 관리자 조회 → 학생 본인 확인, 다른 기수·배정 종료자·교수·
 *   홈페이지 ADMIN 거부)은 합성 계정과 세 기능 플래그를 켠 격리 PostgreSQL 실행기에서만 돌립니다.
 *   그 실행기는 아직 없으므로(`HRA_ACADEMIC_ATTENDANCE_QA`) 기본 실행에서는 건너뜁니다.
 */
import { expect, test, type Page } from "@playwright/test";

const ROUTES = [
  "/member/attendance",
  "/member/attendance/staff",
  "/member/academic-operations",
] as const;

for (const route of ROUTES) {
  test(`비로그인 ${route} 접근은 로그인 화면으로 이동한다`, async ({ page }) => {
    await page.goto(route);
    await expect(page).toHaveURL(/\/login(\?|$)/);
  });
}

/** 합성 계정으로 실제 credentials 로그인 API를 통과합니다(공개 로그인 화면은 소셜 전용). */
async function login(
  page: Page,
  baseURL: string | undefined,
  email: string | undefined,
  password: string | undefined,
) {
  const csrf = await (await page.request.get("/api/auth/csrf")).json();
  await page.request.post("/api/auth/callback/credentials", {
    form: {
      csrfToken: csrf.csrfToken,
      email: email ?? "",
      password: password ?? "",
      callbackUrl: `${baseURL}/mypage`,
    },
    headers: { Origin: baseURL ?? "", "X-Auth-Return-Redirect": "1" },
    maxRedirects: 0,
  });
}

test.describe("격리 PostgreSQL 출결 역할 흐름", () => {
  test.skip(
    process.env.HRA_ACADEMIC_ATTENDANCE_QA !== "true",
    "전용 격리 QA 실행기가 합성 계정·배정·수업일을 준비한다.",
  );

  test("기수 A 운영 인력이 출결을 입력하고 학생 본인이 확인한다", async ({ page, baseURL }) => {
    await login(
      page,
      baseURL,
      process.env.HRA_ATTENDANCE_STAFF_EMAIL,
      process.env.HRA_ATTENDANCE_STAFF_PASSWORD,
    );
    await page.goto("/member/attendance/staff");
    await page.getByRole("link", { name: /합성 A기/ }).click();
    await page
      .getByRole("link", { name: /합성 수업/ })
      .first()
      .click();
    const group = page.getByRole("group", { name: "합성 학생 출결 입력" });
    await group.getByRole("button", { name: "출석" }).click();
    await expect(group.getByRole("button", { name: "✓ 출석" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await page.context().clearCookies();
    await login(
      page,
      baseURL,
      process.env.HRA_ATTENDANCE_STUDENT_EMAIL,
      process.env.HRA_ATTENDANCE_STUDENT_PASSWORD,
    );
    await page.goto("/member/attendance");
    await expect(page.getByRole("heading", { name: "내 출결", exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: "출석" }).first()).toBeVisible();
  });

  test("홈페이지 ADMIN·교수는 학사 운영 관리·출결 입력 화면을 열 수 없다", async ({
    page,
    baseURL,
  }) => {
    for (const [email, password] of [
      [process.env.HRA_ATTENDANCE_ADMIN_EMAIL, process.env.HRA_ATTENDANCE_ADMIN_PASSWORD],
      [process.env.HRA_ATTENDANCE_FACULTY_EMAIL, process.env.HRA_ATTENDANCE_FACULTY_PASSWORD],
    ]) {
      await page.context().clearCookies();
      await login(page, baseURL, email, password);
      expect((await page.goto("/member/academic-operations"))?.status()).toBe(404);
      await page.goto("/member/attendance/staff");
      await expect(
        page.getByText("현재 출결을 입력할 수 있는 배정 기수가 없습니다.", { exact: false }),
      ).toBeVisible();
    }
  });
});
