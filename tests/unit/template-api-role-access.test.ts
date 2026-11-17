// @vitest-environment node
/**
 * 양식 본문·다운로드 API의 공동 자료 열람 인가를 직접 실행합니다 (#509).
 * 승인 역할만 조회하고, 거부 시 리졸버에 접근하지 않으며 기존 응답 계약을 유지합니다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  resolveTemplate: vi.fn(),
  resolveGuide: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/markdown/resolve", () => ({
  resolveTemplate: mocks.resolveTemplate,
  resolveGuide: mocks.resolveGuide,
}));

import { GET as getContent } from "@/app/api/templates/[slug]/content/route";
import { GET as getDownload } from "@/app/api/templates/[slug]/download/route";

// 실제 자료 대신 한글 제목과 마크다운을 가진 합성 양식을 사용합니다.
const template = { title: "독서 보고서! (양식)", body: "# 보고서\n\n본문입니다.\n" };
const guide = { title: "작성 가이드", body: "# 가이드\n\n작성 안내입니다.\n" };
const userId = "11111111-1111-4111-8111-111111111111";

describe.each([
  { name: "본문", handler: getContent, path: "content" },
  { name: "다운로드", handler: getDownload, path: "download" },
])("양식 $name API", ({ handler, path }) => {
  // 각 호출은 Next 16의 Promise params 계약을 그대로 사용합니다.
  function callHandler() {
    return handler(new Request(`http://localhost/api/templates/report/${path}`), {
      params: Promise.resolve({ slug: "report" }),
    });
  }

  beforeEach(() => {
    vi.resetAllMocks();
    mocks.auth.mockResolvedValue({ user: { id: userId, role: "MEMBER" } });
    mocks.resolveTemplate.mockResolvedValue(template);
    mocks.resolveGuide.mockResolvedValue(null);
  });

  it.each([
    ["익명", null, 401],
    ["사용자 없는 세션", {}, 401],
    ["승인 대기", { user: { id: userId, role: "PENDING" } }, 403],
    ["미인식 역할", { user: { id: userId, role: "UNKNOWN" } }, 403],
    ["예상 밖 역할", { user: { id: userId, role: "OWNER" } }, 403],
    ["소문자 역할", { user: { id: userId, role: "member" } }, 403],
    ["공백 포함 역할", { user: { id: userId, role: " ADMIN " } }, 403],
    ["빈 역할", { user: { id: userId, role: "" } }, 403],
    ["null 역할", { user: { id: userId, role: null } }, 403],
    ["역할 누락", { user: { id: userId } }, 403],
  ])("%s 요청은 양식·가이드 조회 전에 거부한다", async (_label, session, status) => {
    mocks.auth.mockResolvedValueOnce(session);

    const response = await callHandler();

    expect(response.status).toBe(status);
    expect(response.headers.get("Location")).toBeNull();
    if (path === "content") {
      expect(await response.json()).toEqual({
        message:
          status === 401
            ? "로그인이 필요합니다."
            : "승인 대기 중입니다. 관리자 승인 후 이용해주세요.",
      });
    } else {
      expect(await response.text()).toBe(
        status === 401 ? "로그인이 필요합니다." : "승인 대기 중입니다.",
      );
    }
    expect(mocks.resolveTemplate).not.toHaveBeenCalled();
    expect(mocks.resolveGuide).not.toHaveBeenCalled();
  });

  it.each(["ADMIN", "FACULTY", "MEMBER"])("%s는 기존 양식 응답을 받는다", async (role) => {
    mocks.auth.mockResolvedValueOnce({ user: { id: userId, role } });

    const response = await callHandler();

    expect(response.status).toBe(200);
    expect(mocks.resolveTemplate).toHaveBeenCalledExactlyOnceWith("report");
    expect(mocks.resolveGuide).not.toHaveBeenCalled();
    if (path === "content") {
      expect(await response.json()).toEqual(template);
      expect(response.headers.get("Content-Type")).toContain("application/json");
    } else {
      expect(await response.text()).toBe(template.body);
      expect(response.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8");
      expect(response.headers.get("Content-Disposition")).toBe(
        `attachment; filename*=UTF-8''${encodeURIComponent("독서-보고서-양식.md")}`,
      );
    }
  });

  it("양식이 없으면 같은 slug의 가이드를 조회한다", async () => {
    mocks.resolveTemplate.mockResolvedValueOnce(null);
    mocks.resolveGuide.mockResolvedValueOnce(guide);

    const response = await callHandler();

    expect(response.status).toBe(200);
    expect(mocks.resolveGuide).toHaveBeenCalledExactlyOnceWith("report");
    expect(mocks.resolveTemplate.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.resolveGuide.mock.invocationCallOrder[0],
    );
    if (path === "content") {
      expect(await response.json()).toEqual(guide);
    } else {
      expect(await response.text()).toBe(guide.body);
      expect(response.headers.get("Content-Disposition")).toBe(
        `attachment; filename*=UTF-8''${encodeURIComponent("작성-가이드.md")}`,
      );
    }
  });

  it("양식과 가이드가 모두 없으면 기존 404 응답을 유지한다", async () => {
    mocks.resolveTemplate.mockResolvedValueOnce(null);

    const response = await callHandler();

    expect(response.status).toBe(404);
    if (path === "content") {
      expect(await response.json()).toEqual({ message: "템플릿을 찾을 수 없습니다." });
    } else {
      expect(await response.text()).toBe("양식을 찾을 수 없습니다.");
    }
  });
});
