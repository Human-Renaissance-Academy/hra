"use client";

/**
 * 자료실 필터 + 목록 컴포넌트
 *
 * 역할: 기수 드롭다운 + 카테고리 탭 + (주차별 텍스트 전용) 서브필터로
 *       자료를 필터링해 페이지네이션 테이블로 표시한다.
 *
 * 탭 순서: 가이드북 → 강의 자료 → 주차별 텍스트 → 주차별 수업일지 → 보고서 양식 ("전체" 없음)
 * 기수 기본값: 최신 기수 (page.tsx에서 desc 정렬된 cohorts[0])
 * ALL_COHORT sentinel: "__all__" (UUID와 절대 충돌하지 않는 내부 상수)
 * 주차별 텍스트 서브필터: 전체 / 고전명작 / 경영서 / 기업실무
 *
 * 사용 위치: src/app/(member)/resources/page.tsx
 */

import { useState } from "react";
import Link from "next/link";
import { Search, ChevronLeft, ChevronRight, Upload } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { formatKstDate } from "@/lib/date-time";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** 기수 "전체" 상태를 나타내는 sentinel 값 — UUID와 충돌하지 않음 */
const ALL_COHORT = "__all__";

/** 주차별 텍스트 분류 목록 */
export const WEEKLY_TEXT_TYPES = ["고전명작", "경영서", "기업실무"] as const;
export type WeeklyTextType = (typeof WEEKLY_TEXT_TYPES)[number];

const CLASS_MATERIAL_AUDIENCE_FILTERS = ["전체", "학생용", "교수용"] as const;
type ClassMaterialAudienceFilter = (typeof CLASS_MATERIAL_AUDIENCE_FILTERS)[number];

/** 카테고리 탭 — 표시 순서 그대로 */
export type ResourceCategory = "가이드북" | "강의 자료" | "주차별 텍스트" | "주차별 수업일지" | "보고서 양식";

const CATEGORY_TABS: ResourceCategory[] = [
  "가이드북",
  "강의 자료",
  "주차별 텍스트",
  "주차별 수업일지",
  "보고서 양식",
];

export type ResourceItem = {
  id: number | string;
  title: string;
  category: ResourceCategory;
  date: Date;
  cohortId?: string | null;
  /** 주차별 텍스트 분류 (null = 미분류) */
  textType?: string | null;
  audience?: string | null;
  weekNumber?: number | null;
  lectureTitle?: string | null;
  author?: string | null;
  href?: string;
  downloadUrl?: string;
};

interface ResourcesTabsProps {
  initialCategory?: string;
  items: ResourceItem[];
  cohorts: { id: string; name: string }[];
  userCohortId: string | null;
  userRole: "ADMIN" | "FACULTY" | "MEMBER" | "PENDING" | null;
}

/** 카테고리별 배지 색상 */
const getCategoryColor = (category: ResourceCategory): string => {
  switch (category) {
    case "가이드북":
      return "bg-orange-50 text-orange-700 border-orange-200";
    case "강의 자료":
      return "bg-purple-50 text-purple-700 border-purple-200";
    case "주차별 텍스트":
      return "bg-green-50 text-green-700 border-green-200";
    case "주차별 수업일지":
      return "bg-blue-50 text-blue-700 border-blue-200";
    case "보고서 양식":
      return "bg-blue-50 text-blue-700 border-blue-200";
  }
};

export function ResourcesTabs({ initialCategory, items, cohorts, userCohortId, userRole }: ResourcesTabsProps) {
  // 기수 기본값: 전체
  const defaultCohort = ALL_COHORT;

  const [activeCohort, setActiveCohort] = useState<string>(defaultCohort);
  // 상세 화면에서 돌아온 카테고리만 허용하고, 잘못된 쿼리는 기본 탭으로 돌립니다.
  const [activeCategory, setActiveCategory] = useState<ResourceCategory>(
    CATEGORY_TABS.find((category) => category === initialCategory) ?? "가이드북",
  );
  // 주차별 텍스트 서브필터 — 탭 전환 시 초기화하지 않고 유지
  const [activeTextType, setActiveTextType] = useState<WeeklyTextType | "전체">("전체");
  const [activeClassMaterialAudience, setActiveClassMaterialAudience] =
    useState<ClassMaterialAudienceFilter>("전체");
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const itemsPerPage = 10;

  const isAdminOrFaculty = userRole === "ADMIN" || userRole === "FACULTY";
  const isMember = userRole === "MEMBER";

  const showWeeklyTextUploadButton =
    activeCategory === "주차별 텍스트" &&
    ((isAdminOrFaculty && activeCohort !== ALL_COHORT) ||
      (isMember && userCohortId !== null && activeCohort === userCohortId));

  const showClassMaterialUploadButton =
    activeCategory === "강의 자료" && (userRole === "ADMIN" || userRole === "FACULTY");

  const showClassLogUploadButton =
    activeCategory === "주차별 수업일지" &&
    (isAdminOrFaculty || (isMember && userCohortId !== null));

  // 업로드 링크에 넘길 cohortId
  const uploadCohortId =
    isMember ? userCohortId : activeCohort !== ALL_COHORT ? activeCohort : null;

  // 필터링 로직
  const filteredItems = items.filter((item) => {
    // 기수가 없는 공통 자료는 특정 기수를 선택해도 계속 표시합니다.
    const matchesCohort =
      activeCohort === ALL_COHORT ||
      (item.cohortId == null &&
        (item.category === "가이드북" || item.category === "강의 자료" || item.category === "보고서 양식")) ||
      item.cohortId === activeCohort;

    // 카테고리 탭 필터
    const matchesCategory = item.category === activeCategory;

    // 주차별 텍스트 서브필터
    const matchesTextType =
      activeCategory !== "주차별 텍스트" ||
      activeTextType === "전체" ||
      item.textType === activeTextType;

    const matchesClassMaterialAudience =
      activeCategory !== "강의 자료" ||
      activeClassMaterialAudience === "전체" ||
      (activeClassMaterialAudience === "학생용" && item.audience === "STUDENT") ||
      (activeClassMaterialAudience === "교수용" && item.audience === "FACULTY");

    // 검색어 필터
    const matchesSearch = [item.title, item.lectureTitle, item.author]
      .filter((value): value is string => typeof value === "string")
      .some((value) => value.toLowerCase().includes(searchQuery.toLowerCase()));

    return (
      matchesCohort &&
      matchesCategory &&
      matchesTextType &&
      matchesClassMaterialAudience &&
      matchesSearch
    );
  });

  const totalPages = Math.ceil(filteredItems.length / itemsPerPage) || 1;
  const startIndex = (currentPage - 1) * itemsPerPage;
  const currentItems = filteredItems.slice(startIndex, startIndex + itemsPerPage);

  /** 기수 드롭다운용 items (ALL_COHORT + 기수 목록) */
  const cohortSelectItems = [
    { value: ALL_COHORT, label: "전체" },
    ...cohorts.map((c) => ({ value: c.id, label: c.name })),
  ];

  const handleCohortChange = (value: string | null) => {
    setActiveCohort(value ?? ALL_COHORT);
    setCurrentPage(1);
  };

  const handleCategoryChange = (category: ResourceCategory) => {
    setActiveCategory(category);
    setCurrentPage(1);
  };

  const handleTextTypeChange = (type: WeeklyTextType | "전체") => {
    setActiveTextType(type);
    setCurrentPage(1);
  };

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setSearchQuery(e.target.value);
    setCurrentPage(1);
  };

  return (
    <div className="space-y-6">
      {/* 카테고리 탭 + 기수 필터 + 검색 + 업로드 버튼 */}
      <div className="flex flex-col gap-4 xl:flex-row xl:items-center xl:justify-between">
        <div role="group" aria-label="자료 종류" className="flex w-full flex-wrap gap-2 md:w-auto md:flex-nowrap md:gap-6 md:border-b md:border-[#D9D9D9] xl:shrink-0">
          {CATEGORY_TABS.map((tab) => (
            <button
              key={tab}
              type="button"
              onClick={() => handleCategoryChange(tab)}
              aria-pressed={activeCategory === tab}
              className={`min-h-11 whitespace-nowrap rounded-lg border px-3 py-2 text-sm transition-colors md:min-h-0 md:rounded-none md:border-0 md:px-0 md:pb-3 md:pt-0 md:text-base ${
                activeCategory === tab
                  ? "border-[#2563EB] bg-blue-50 font-semibold text-[#2563EB] md:border-b-2 md:bg-transparent"
                  : "border-[#D9D9D9] bg-white text-[#666666] hover:text-[#1a1a1a]"
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        <div className="flex w-full min-w-0 flex-wrap items-center gap-2 xl:w-auto">
          {/* 기수 필터 드롭다운 — 검색창 왼쪽에 위치 */}
          {cohorts.length > 0 && (
            <Select
              items={cohortSelectItems}
              value={activeCohort}
              onValueChange={handleCohortChange}
            >
              <SelectTrigger className="min-h-11 w-28 shrink-0 border-[#D9D9D9] bg-white text-sm text-[#1a1a1a] sm:w-32">
                <SelectValue placeholder="전체" />
              </SelectTrigger>
              <SelectContent>
                {cohortSelectItems.map((option) => (
                  <SelectItem key={option.value} value={option.value} label={option.label}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {showClassLogUploadButton && (
            <Link
              href="/resources/class-logs"
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg bg-[#1a1a1a] text-white hover:bg-[#333333] transition-colors whitespace-nowrap"
            >
              <Upload className="size-3.5" />
              수업일지 작성
            </Link>
          )}
          {showWeeklyTextUploadButton && uploadCohortId && (
            <Link
              href={`/resources/weekly-texts?cohortId=${uploadCohortId}`}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-lg bg-[#1a1a1a] text-white hover:bg-[#333333] transition-colors whitespace-nowrap"
            >
              <Upload className="size-3.5" />
              업로드
            </Link>
          )}
          {showClassMaterialUploadButton && (
            <Link
              href="/resources/class-materials"
              className="inline-flex items-center gap-1.5 rounded-lg bg-[#1a1a1a] px-3 py-2 text-sm font-medium whitespace-nowrap text-white transition-colors hover:bg-[#333333]"
            >
              <Upload className="size-3.5" />
              자료 업로드
            </Link>
          )}
          <div className="relative min-w-0 flex-1 basis-40 sm:basis-56 xl:w-64 xl:flex-none">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[#666666]" />
            <input
              type="search"
              aria-label="자료 검색"
              placeholder="자료 검색..."
              className="min-h-11 w-full rounded-lg border border-[#D9D9D9] py-1.5 pl-10 pr-4 text-sm transition-colors focus:border-[#2563EB] focus:outline-none"
              value={searchQuery}
              onChange={handleSearchChange}
            />
          </div>
        </div>
      </div>

      {/* 주차별 텍스트 서브필터 (탭이 "주차별 텍스트"일 때만 표시) */}
      {activeCategory === "주차별 텍스트" && (
        <div className="flex gap-2 flex-wrap">
          {(["전체", ...WEEKLY_TEXT_TYPES] as const).map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => handleTextTypeChange(type)}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                activeTextType === type
                  ? "bg-[#2563EB] text-white"
                  : "bg-white border border-[#D9D9D9] text-[#666666] hover:border-[#2563EB] hover:text-[#2563EB]"
              }`}
            >
              {type}
            </button>
          ))}
        </div>
      )}

      {activeCategory === "강의 자료" && (
        <div className="flex gap-2 flex-wrap">
          {CLASS_MATERIAL_AUDIENCE_FILTERS.map((type) => (
            <button
              key={type}
              type="button"
              onClick={() => {
                setActiveClassMaterialAudience(type);
                setCurrentPage(1);
              }}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
                activeClassMaterialAudience === type
                  ? "bg-[#2563EB] text-white"
                  : "bg-white border border-[#D9D9D9] text-[#666666] hover:border-[#2563EB] hover:text-[#2563EB]"
              }`}
            >
              {type}
            </button>
          ))}
        </div>
      )}

      {/* 모바일: 고정 폭 표 대신 제목·분류·날짜를 모두 볼 수 있는 세로 카드 목록 */}
      <div data-testid="mobile-resource-list" className="space-y-3 md:hidden">
        {currentItems.length > 0 ? (
          currentItems.map((item) => (
            <article key={item.id} className="min-w-0 rounded-xl border border-[#D9D9D9] bg-white p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  {item.href ? (
                    <Link href={item.href} className="block break-words py-1 font-medium leading-6 text-[#1a1a1a] hover:text-[#2563EB]">
                      {item.title}
                    </Link>
                  ) : item.downloadUrl ? (
                    <a href={item.downloadUrl} download className="block break-words py-1 font-medium leading-6 text-[#1a1a1a] hover:text-[#2563EB]">
                      {item.title}
                    </a>
                  ) : (
                    <span className="block break-words py-1 font-medium leading-6 text-[#1a1a1a]">{item.title}</span>
                  )}
                  {item.category === "강의 자료" && (item.weekNumber || item.lectureTitle) ? (
                    <div className="mt-1 flex flex-wrap gap-2 text-xs text-[#666666]">
                      {item.weekNumber ? <span>{item.weekNumber}주차</span> : null}
                      {item.lectureTitle ? <span>{item.lectureTitle}</span> : null}
                    </div>
                  ) : null}
                </div>
                {item.category === "주차별 텍스트" ? (
                  <Badge variant="outline" className={`shrink-0 whitespace-nowrap ${
                    item.textType
                      ? "border-green-200 bg-green-50 text-green-700"
                      : "border-[#D9D9D9] bg-gray-50 text-[#666666]"
                  }`}>
                    {item.textType ?? "미분류"}
                  </Badge>
                ) : (
                  <Badge variant="outline" className={`${getCategoryColor(item.category)} shrink-0 whitespace-nowrap`}>
                    {item.category}
                  </Badge>
                )}
              </div>
              <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[#666666]">
                <span>등록일: {formatKstDate(item.date)}</span>
                {item.author ? <span>작성자: {item.author}</span> : null}
              </div>
            </article>
          ))
        ) : (
          <div role="status" className="rounded-xl border border-[#D9D9D9] bg-white px-4 py-10 text-center text-sm text-[#666666]">
            {searchQuery
              ? "검색 결과가 없습니다."
              : activeCohort !== ALL_COHORT
                ? "해당 기수의 자료가 없습니다."
                : "등록된 자료가 없습니다."}
          </div>
        )}
      </div>
      {/* 데스크톱: 기존 표와 모든 열을 유지 */}
      <div data-testid="desktop-resource-table" className="hidden overflow-x-auto rounded-lg border border-[#D9D9D9] bg-white md:block">
        <table className="w-full border-collapse text-left">
          <thead>
            <tr className="bg-gray-50 text-[#666666] text-sm border-b border-[#D9D9D9]">
              <th className="px-4 py-3 font-medium min-w-[300px]">제목</th>
              <th className="px-4 py-3 font-medium whitespace-nowrap w-32">분류</th>
              <th className="px-4 py-3 font-medium whitespace-nowrap w-32">작성자</th>
              <th className="px-4 py-3 font-medium whitespace-nowrap w-32">날짜</th>
            </tr>
          </thead>
          <tbody>
            {currentItems.length > 0 ? (
              currentItems.map((item) => (
                <tr
                  key={item.id}
                  className="border-b border-[#D9D9D9] hover:bg-gray-50 transition-colors last:border-0"
                >
                  <td className="px-4 py-3.5">
                    {item.href ? (
                      <Link
                        href={item.href}
                        className="text-[#1a1a1a] hover:text-[#2563EB] font-medium transition-colors block"
                      >
                        {item.title}
                      </Link>
                   ) : item.downloadUrl ? (
                      <a
                        href={item.downloadUrl}
                        download
                        className="text-[#1a1a1a] hover:text-[#2563EB] font-medium transition-colors block"
                      >
                        {item.title}
                      </a>
                    ) : (
                      <span className="text-[#1a1a1a] font-medium">{item.title}</span>
                    )}
                    {item.category === "강의 자료" && (item.weekNumber || item.lectureTitle) ? (
                      <div className="mt-1 flex flex-wrap gap-2 text-xs text-[#666666]">
                        {item.weekNumber ? <span>{item.weekNumber}주차</span> : null}
                        {item.lectureTitle ? <span>{item.lectureTitle}</span> : null}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3.5">
                    {/* 주차별 텍스트는 textType 배지, 나머지는 카테고리 배지 */}
                    {item.category === "주차별 텍스트" ? (
                      <Badge
                        variant="outline"
                        className={`whitespace-nowrap ${
                          item.textType
                            ? "bg-green-50 text-green-700 border-green-200"
                            : "bg-gray-50 text-[#666666] border-[#D9D9D9]"
                        }`}
                      >
                        {item.textType ?? "미분류"}
                      </Badge>
                    ) : (
                      <Badge
                        variant="outline"
                        className={`${getCategoryColor(item.category)} whitespace-nowrap`}
                      >
                        {item.category}
                      </Badge>
                    )}
                  </td>
                  <td className="px-4 py-3.5 text-sm text-[#666666] whitespace-nowrap">
                    {item.author || "-"}
                  </td>
                  <td className="px-4 py-3.5 text-sm text-[#666666] whitespace-nowrap">
                    {formatKstDate(item.date)}
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={4} className="px-4 py-12 text-center text-[#666666]">
                  {searchQuery
                    ? "검색 결과가 없습니다."
                    : activeCohort !== ALL_COHORT
                      ? "해당 기수의 자료가 없습니다."
                      : "등록된 자료가 없습니다."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* 페이지네이션 */}
      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2 mt-6">
          <Button
            variant="outline"
            size="icon"
            onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
            disabled={currentPage === 1}
            className="border-[#D9D9D9] text-[#666666]"
          >
            <ChevronLeft className="w-4 h-4" />
          </Button>
          <span aria-live="polite" className="px-2 text-sm text-[#666666] sm:hidden">{currentPage} / {totalPages} 페이지</span>
          <div className="hidden max-w-[65vw] gap-1 overflow-x-auto sm:flex">
            {Array.from({ length: totalPages }, (_, i) => i + 1).map((page) => (
              <Button
                key={page}
                variant={currentPage === page ? "default" : "outline"}
                onClick={() => setCurrentPage(page)}
                className={`w-9 h-9 p-0 ${
                  currentPage === page
                    ? "bg-[#2563EB] text-white hover:bg-[#1d4ed8]"
                    : "border border-[#D9D9D9] text-[#666666] hover:bg-gray-50"
                }`}
              >
                {page}
              </Button>
            ))}
          </div>
          <Button
            variant="outline"
            size="icon"
            onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
            disabled={currentPage === totalPages}
            className="border-[#D9D9D9] text-[#666666]"
          >
            <ChevronRight className="w-4 h-4" />
          </Button>
        </div>
      )}
    </div>
  );
}
