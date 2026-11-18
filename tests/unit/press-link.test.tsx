/**
 * 조회수 예약이 대기·억제·실패해도 실제 기사 링크의 기본 이동을 막지 않는지 검증합니다.
 * 테스트의 문서 리스너만 마지막에 이동을 막아 외부 사이트를 호출하지 않습니다.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ track: vi.fn() }));
vi.mock("@/features/press/actions", () => ({ trackPressView: mocks.track }));
import { PressLink } from "@/app/(public)/press/_components/press-link";

beforeEach(() => vi.resetAllMocks());
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it.each(["pending", "suppressed", "rejected"])(
  "기록 상태 %s와 무관하게 anchor의 기본 이동을 유지한다",
  async (mode) => {
    const pending = Promise.withResolvers<void>();
    if (mode === "pending") mocks.track.mockReturnValueOnce(pending.promise);
    else if (mode === "rejected") mocks.track.mockRejectedValueOnce(new Error("합성 기록 실패"));
    else mocks.track.mockResolvedValueOnce(undefined);
    const diagnostic = vi.spyOn(console, "error").mockImplementation(() => undefined);
    render(
      <PressLink articleId="article-id" href="https://press.invalid/article">
        기사 원문
      </PressLink>,
    );
    const link = screen.getByRole("link", { name: "기사 원문" });
    let appPrevented = true;
    const stopExternalNavigation = (event: Event) => {
      appPrevented = event.defaultPrevented;
      event.preventDefault();
    };
    document.addEventListener("click", stopExternalNavigation, { once: true });
    await act(async () => {
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(appPrevented).toBe(false);
    expect(link.getAttribute("href")).toBe("https://press.invalid/article");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noreferrer");
    expect(mocks.track).toHaveBeenCalledExactlyOnceWith("article-id");
    expect(diagnostic).toHaveBeenCalledTimes(mode === "rejected" ? 1 : 0);
    pending.resolve();
  },
);
