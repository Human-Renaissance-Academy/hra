/** 역할별 학사포털의 주요 동선과 운영 비활성 안내를 검증합니다. */
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
  vi.stubEnv("ACADEMIC_STAFF_ENABLED", "false");
  vi.stubEnv("ACADEMIC_ATTENDANCE_ENABLED", "false");
  vi.stubEnv("ACADEMIC_FACULTY_REVIEW_ENABLED", "false");
  vi.stubEnv("ACADEMIC_ASSIGNMENT_REVIEW_ENABLED", "false");
});

afterEach(() => vi.unstubAllEnvs());

describe("회원 자료실 학사포털", () => {
  it("교수에게 강의자료 등록 동선을 표시하되 출결·비활성 과제 검토를 활성화하지 않는다", () => {
    const html = renderToStaticMarkup(
      <ResourcePortal role="FACULTY" cohortName={null} userCohortId={null} items={items} />,
    );

    expect(html).toContain("교수 학사포털");
    expect(html).toContain('href="/resources/class-materials"');
    expect(html).toContain("과제 제출함·피드백은 운영 승인 후");
    expect(html).not.toContain('href="/member/reviews"');
    expect(html).not.toContain('href="/member/attendance/staff"');
  });

  it("학생은 본인 기수 자료만 최근 목록에서 보고 교수용 자료를 보지 않는다", () => {
    const html = renderToStaticMarkup(
      <ResourcePortal role="MEMBER" cohortName="20기" userCohortId={cohortId} items={items} />,
    );

    expect(html).toContain("학생 학습포털");
    expect(html).toContain("소속 20기");
    expect(html).toContain("20기 주간 학습 텍스트");
    expect(html).toContain("학생에게 공유한 강의자료");
    expect(html).not.toContain("다른 기수 텍스트");
    expect(html).not.toContain("교수용 비공개 강의자료");
    expect(html).not.toContain('href="/member/assignments"');
  });

  it("운영 기능이 승인되어 켜진 때만 역할별 과제 동선을 표시한다", () => {
    vi.stubEnv("ACADEMIC_ENABLED", "true");
    vi.stubEnv("ACADEMIC_FACULTY_REVIEW_ENABLED", "true");
    vi.stubEnv("ACADEMIC_ASSIGNMENT_REVIEW_ENABLED", "true");
    const faculty = renderToStaticMarkup(
      <ResourcePortal role="FACULTY" cohortName={null} userCohortId={null} items={items} />,
    );
    const student = renderToStaticMarkup(
      <ResourcePortal role="MEMBER" cohortName="20기" userCohortId={cohortId} items={items} />,
    );

    expect(faculty).toContain('href="/member/reviews"');
    expect(student).toContain('href="/member/assignments"');
    expect(faculty).not.toContain("출결 입력");
  });

  it("관리자 미리보기는 기능 플래그가 켜져 있어도 교수 검토 권한을 가장하지 않는다", () => {
    vi.stubEnv("ACADEMIC_ENABLED", "true");
    vi.stubEnv("ACADEMIC_FACULTY_REVIEW_ENABLED", "true");
    vi.stubEnv("ACADEMIC_ASSIGNMENT_REVIEW_ENABLED", "true");
    const html = renderToStaticMarkup(
      <ResourcePortal role="FACULTY" cohortName={null} userCohortId={null} items={items} preview />,
    );

    expect(html).toContain("실제 계정 권한과 학생의 학적은 변경되지 않습니다");
    expect(html).not.toContain('href="/member/reviews"');
  });
});
