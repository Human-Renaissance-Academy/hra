/**
 * 자료실의 상세 복귀 탭과 기수 없는 공통 자료 필터를 확인합니다 (#130).
 */
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  ResourcesTabs,
  type ResourceItem,
} from "@/app/(member)/resources/_components/resources-tabs";

const cohortId = "11111111-1111-4111-8111-111111111111";
const items: ResourceItem[] = [
  {
    id: "shared",
    title: "공통 강의 자료",
    category: "강의 자료",
    date: new Date("2026-01-01"),
    cohortId: null,
  },
  {
    id: "template",
    title: "공통 보고서 양식",
    category: "보고서 양식",
    date: new Date("2026-01-01"),
    cohortId: null,
  },
  {
    id: "cohort",
    title: "1기 수업일지",
    category: "주차별 수업일지",
    date: new Date("2026-01-01"),
    cohortId,
  },
];

beforeAll(() => {
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

afterEach(cleanup);

describe("자료실 탭", () => {
  it("상세 페이지에서 지정한 카테고리로 돌아온다", () => {
    render(
      createElement(ResourcesTabs, {
        initialCategory: "강의 자료",
        items,
        cohorts: [],
        userCohortId: null,
        userRole: "MEMBER",
      }),
    );

    expect(screen.getAllByText("공통 강의 자료")).toHaveLength(2);
    expect(screen.queryByText("공통 보고서 양식")).toBeNull();
  });

  it("기수를 선택해도 공통 강의 자료와 보고서 양식이 보인다", () => {
    render(
      createElement(ResourcesTabs, {
        initialCategory: "강의 자료",
        items,
        cohorts: [{ id: cohortId, name: "1기" }],
        userCohortId: cohortId,
        userRole: "MEMBER",
      }),
    );

    fireEvent.click(screen.getByRole("combobox"));
    fireEvent.click(screen.getByRole("option", { name: "1기" }));
    expect(screen.getAllByText("공통 강의 자료")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "보고서 양식" }));
    expect(screen.getAllByText("공통 보고서 양식")).toHaveLength(2);
  });
  it("모바일 카드는 목록의 상세 링크·분류·날짜를 유지하고 다섯 종류를 선택할 수 있다", () => {
    const guidebook: ResourceItem = {
      id: "guide-19",
      title: "HRA 19기 가이드북",
      category: "가이드북",
      date: new Date("2026-11-20T03:00:00Z"),
      href: "/resources/guidebooks/19",
    };
    render(
      createElement(ResourcesTabs, {
        items: [guidebook],
        cohorts: [],
        userCohortId: null,
        userRole: "MEMBER",
      }),
    );

    const mobileList = within(screen.getByTestId("mobile-resource-list"));
    const desktopTable = within(screen.getByTestId("desktop-resource-table"));
    expect(mobileList.getByRole("link", { name: guidebook.title }).getAttribute("href")).toBe(
      guidebook.href,
    );
    expect(desktopTable.getByRole("link", { name: guidebook.title }).getAttribute("href")).toBe(
      guidebook.href,
    );
    expect(mobileList.getByText("가이드북")).toBeTruthy();
    expect(mobileList.getByText(/등록일:/)).toBeTruthy();
    for (const category of [
      "가이드북",
      "강의 자료",
      "주차별 텍스트",
      "주차별 수업일지",
      "보고서 양식",
    ]) {
      expect(screen.getByRole("button", { name: category }).getAttribute("aria-pressed")).toBe(
        category === "가이드북" ? "true" : "false",
      );
    }
    fireEvent.change(screen.getByRole("searchbox", { name: "자료 검색" }), {
      target: { value: "존재하지 않는 검색어" },
    });
    expect(mobileList.getByRole("status").textContent).toContain("검색 결과가 없습니다.");
  });

  it("모바일 다운로드 전용 자료도 기존 파일 링크를 유지한다", () => {
    render(
      createElement(ResourcesTabs, {
        initialCategory: "주차별 텍스트",
        items: [
          {
            id: "file",
            title: "주간 독서 자료",
            category: "주차별 텍스트",
            date: new Date("2026-11-19"),
            cohortId,
            textType: "경영서",
            downloadUrl: "/api/resources/weekly-texts/file/download",
          },
        ],
        cohorts: [],
        userCohortId: cohortId,
        userRole: "MEMBER",
      }),
    );
    const mobileList = within(screen.getByTestId("mobile-resource-list"));
    const link = mobileList.getByRole("link", { name: "주간 독서 자료" });
    expect(link.getAttribute("href")).toBe("/api/resources/weekly-texts/file/download");
    expect(link.hasAttribute("download")).toBe(true);
    expect(mobileList.getByText("경영서")).toBeTruthy();
  });
});
