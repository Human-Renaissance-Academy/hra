/** 역할별 최소 포털의 링크·자료 노출·기수 및 비활성 정책 회귀. */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResourcePortal } from "@/app/(member)/resources/_components/resource-portal";
import type { ResourceItem } from "@/app/(member)/resources/_components/resources-tabs";

const cohortId = "11111111-1111-4111-8111-111111111111";
const otherCohortId = "22222222-2222-4222-8222-222222222222";
const date = new Date("2026-11-20T00:00:00Z");
const items: ResourceItem[] = [
  {
    id: "student-class",
    category: "강의 자료",
    title: "학생에게 공유한 강의자료",
    href: "/resources/class-materials/student",
    audience: "STUDENT",
    date,
  },
  {
    id: "faculty-class",
    category: "강의 자료",
    title: "교수용 비공개 강의자료",
    href: "/resources/class-materials/faculty",
    audience: "FACULTY",
    date,
  },
  {
    id: "own-text",
    category: "주차별 텍스트",
    title: "20기 주간 학습 텍스트",
    href: "/resources/weekly-texts/own",
    cohortId,
    date,
  },
  {
    id: "other-text",
    category: "주차별 텍스트",
    title: "다른 기수 텍스트",
    href: "/resources/weekly-texts/other",
    cohortId: otherCohortId,
    date,
  },
];

beforeEach(() => {
  vi.stubEnv("ACADEMIC_ENABLED", "false");
  vi.stubEnv("ACADEMIC_FACULTY_REVIEW_ENABLED", "false");
  vi.stubEnv("ACADEMIC_ASSIGNMENT_REVIEW_ENABLED", "false");
});

afterEach(() => vi.unstubAllEnvs());

describe("회원 자료실 최소 학사포털", () => {
  it("교수에게 강의자료 등록·목록만 보여주고 출결/비지정 검토는 제공하지 않는다", () => {
    const html = renderToStaticMarkup(
      <ResourcePortal role="FACULTY" cohortName={null} userCohortId={null} items={items} />,
    );

    expect(html).toContain("교수 학사포털");
    expect(html).toContain('href="/resources/class-materials"');
    expect(html).toContain("강의자료 목록");
    expect(html).toContain("최근 강의자료");
    expect(html).not.toContain('href="/member/reviews"');
    expect(html).not.toContain('href="/member/attendance/staff"');
    expect(html).not.toContain("0건");
  });

  it("학생은 자기 기수 텍스트와 학생용 자료만 보고 교수용/타 기수 텍스트는 보지 않는다", () => {
    const html = renderToStaticMarkup(
      <ResourcePortal role="MEMBER" cohortName="20기" userCohortId={cohortId} items={items} />,
    );

    expect(html).toContain("학생 학습포털");
    expect(html).toContain("20기 · 내 학습자료");
    expect(html).toContain("내 학습자료 보기");
    expect(html).toContain("20기 주간 학습 텍스트");
    expect(html).toContain("학생에게 공유한 강의자료");
    expect(html).not.toContain("다른 기수 텍스트");
    expect(html).not.toContain("교수용 비공개 강의자료");
    expect(html).not.toContain('href="/member/assignments"');
  });

  it("기수 없는 학생은 허용된 공통 자료만 보여준다", () => {
    const html = renderToStaticMarkup(
      <ResourcePortal role="MEMBER" cohortName={null} userCohortId={null} items={items} />,
    );

    expect(html).toContain("기수가 배정되지 않았습니다");
    expect(html).toContain("공통 강의자료 보기");
    expect(html).toContain("학생에게 공유한 강의자료");
    expect(html).not.toContain("20기 주간 학습 텍스트");
    expect(html).not.toContain("교수용 비공개 강의자료");
  });

  it("학사 기능이 켜져도 확인되지 않은 학적/검토자 권한을 메뉴로 가장하지 않는다", () => {
    vi.stubEnv("ACADEMIC_ENABLED", "true");
    vi.stubEnv("ACADEMIC_FACULTY_REVIEW_ENABLED", "true");
    vi.stubEnv("ACADEMIC_ASSIGNMENT_REVIEW_ENABLED", "true");
    const faculty = renderToStaticMarkup(
      <ResourcePortal role="FACULTY" cohortName={null} userCohortId={null} items={items} />,
    );
    const student = renderToStaticMarkup(
      <ResourcePortal role="MEMBER" cohortName="20기" userCohortId={cohortId} items={items} />,
    );

    expect(faculty).not.toContain('href="/member/reviews"');
    expect(student).not.toContain('href="/member/assignments"');
  });

  it("관리자 미리보기에는 교수 전용 업로드와 권한을 가장하지 않는다", () => {
    const html = renderToStaticMarkup(
      <ResourcePortal role="FACULTY" cohortName={null} userCohortId={null} items={items} preview />,
    );

    expect(html).toContain("관리자 화면 미리보기");
    expect(html).not.toContain('href="/resources/class-materials"');
    expect(html).not.toContain('href="/member/reviews"');
  });

  it("최근 자료는 최대 3개만 보여주고 보호 다운로드 링크를 재사용한다", () => {
    const extra: ResourceItem[] = [
      ...items,
      ...[1, 2, 3].map((i) => ({
        id: "file-" + i,
        title: "다운로드 전용 텍스트 " + i,
        category: "주차별 텍스트" as const,
        cohortId,
        date,
        downloadUrl: "/api/resources/weekly-texts/file-" + i + "/download",
      })),
    ];
    const html = renderToStaticMarkup(
      <ResourcePortal role="MEMBER" cohortName="20기" userCohortId={cohortId} items={extra} />,
    );

    expect(html).toContain("다운로드 전용 텍스트 1");
    expect(html).toContain("/api/resources/weekly-texts/file-1/download");
    expect(html).not.toContain("다운로드 전용 텍스트 2");
    expect(html).not.toContain("다운로드 전용 텍스트 3");
    expect(html).toContain("download");
  });
});
