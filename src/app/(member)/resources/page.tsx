/**
 * 자료실 메인 페이지
 *
 * 역할: 가이드북(파일+보고서양식), 주차별 텍스트, 주차별 수업일지를
 *       기수 드롭다운 + 카테고리 탭으로 표시한다.
 * 사용 위치: /resources (로그인 필요)
 */

import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { redirect } from "next/navigation";
import { requireSharedResourceReader } from "@/lib/resource-access";
import { getResourcesOverview } from "@/features/resources/overview/service";
import { ResourcesTabs, type ResourceItem } from "./_components/resources-tabs";
import { ResourcePortal } from "./_components/resource-portal";

export const metadata: Metadata = {
  title: "HRA 학사포털 · 자료실",
};

export const dynamic = "force-dynamic";

type Props = {
  searchParams: Promise<{ category?: string | string[]; view?: string | string[] }>;
};

export default async function ResourcesPage({ searchParams }: Props) {
  const query = await searchParams;
  const requestedCategory = query.category;
  const initialCategory = typeof requestedCategory === "string" ? requestedCategory : undefined;
  const session = await requireSharedResourceReader();
  // Page는 Web 세션만 전달하고, 현재 계정·역할 및 자료 조회는 공용 서비스에 맡깁니다.
  const overview = await getResourcesOverview({ userId: session.user.id, role: session.user.role });
  if (overview.kind === "unauthenticated") redirect("/login");
  if (overview.kind === "forbidden") redirect("/pending");

  const userRole = overview.role;
  const isAdmin = userRole === "ADMIN";
  const {
    cohorts: cohortRows,
    userCohortId,
    logs,
    weeklyTexts: allWeeklyTexts,
    classMaterials: allClassMaterials,
    guidebooks: allGuidebooks,
    templates: allTemplates,
  } = overview;
  // 화면 미리보기는 ADMIN에게만 허용하며 서버 인가 주체는 언제나 원래 계정입니다.
  const previewRole =
    isAdmin && query.view === "faculty"
      ? "FACULTY"
      : isAdmin && query.view === "student"
        ? "MEMBER"
        : null;
  const portalRole = userRole === "FACULTY" || userRole === "MEMBER" ? userRole : previewRole;
  const cohortName = userCohortId
    ? (cohortRows.find((cohort) => cohort.id === userCohortId)?.name ?? null)
    : null;

  // 모든 자료를 ResourceItem 배열로 통합
  const items: ResourceItem[] = [
    // 주차별 수업일지
    ...logs.map((log) => ({
      id: `log-${log.id}`,
      title: log.title,
      category: "주차별 수업일지" as const,
      date: log.classDate,
      cohortId: log.cohortId,
      author: log.authorName,
      href: `/resources/${log.id}`,
    })),
    // 주차별 텍스트
    ...allWeeklyTexts.map((text) => ({
      id: `text-${text.id}`,
      title: text.title,
      category: "주차별 텍스트" as const,
      date: text.classDate ?? text.createdAt,
      cohortId: text.cohortId,
      textType: text.textType ?? null,
      href: text.hasBody ? `/resources/weekly-texts/${text.id}` : undefined,
      downloadUrl:
        !text.hasBody && text.hasFile
          ? `/api/resources/weekly-texts/${text.id}/download`
          : undefined,
    })),
    ...allClassMaterials.map((material) => ({
      id: `cm-${material.id}`,
      title: material.title,
      category: "강의 자료" as const,
      date: material.classDate ?? material.createdAt,
      cohortId: null,
      audience: material.audience,
      weekNumber: material.weekNumber,
      lectureTitle: material.lectureTitle,
      author: material.uploaderName,
      href: `/resources/class-materials/${material.id}`,
    })),
    // 가이드북 파일 — 클릭 시 뷰어 페이지(/resources/guidebooks/[id])로 이동
    ...allGuidebooks.map((book) => ({
      id: `guide-${book.id}`,
      title: book.title,
      category: "가이드북" as const,
      date: book.createdAt,
      cohortId: null,
      href: `/resources/guidebooks/${book.id}`,
    })),
    // 보고서 양식/가이드 — category에 따라 상세 경로 분기
    ...allTemplates.map((tmpl) => ({
      id: `tmpl-${tmpl.id}`,
      title: tmpl.title,
      category: "보고서 양식" as const,
      date: tmpl.createdAt,
      cohortId: null,
      href:
        tmpl.category === "guide"
          ? `/member/guides/${tmpl.slug}`
          : `/member/templates/${tmpl.slug}`,
    })),
  ];

  // 최신순 정렬
  items.sort((a, b) => b.date.getTime() - a.date.getTime());

  return (
    <div
      className={
        portalRole
          ? "mx-auto max-w-7xl px-4 pt-6 pb-12 sm:px-6 sm:py-8 md:py-10"
          : "mx-auto max-w-7xl px-4 pt-6 pb-12 sm:px-6 sm:py-20 md:py-32"
      }
    >
      <section className={portalRole && !isAdmin ? "sr-only" : "mb-8 space-y-3 sm:mb-14 sm:space-y-4"}>
        <div className="flex items-center gap-3">
          <div
            className={
              portalRole
                ? "h-6 w-1 rounded-full bg-[#2563EB]"
                : "h-9 w-1 rounded-full bg-[#2563EB] sm:h-12"
            }
          />
          <h1
            className={
              portalRole
                ? "text-sm font-semibold tracking-wide text-[#2563EB]"
                : "text-2xl font-bold text-[#1a1a1a] sm:text-3xl md:text-4xl lg:text-5xl"
            }
          >
            {portalRole ? "학사포털" : "자료실"}
          </h1>
        </div>
        {!portalRole && (
          <p className="max-w-2xl text-sm leading-6 text-[#666666] md:text-base">
            가이드북, 주차별 텍스트, 수업일지 등 HRA 교육 자료를 확인하세요.
          </p>
        )}
        {isAdmin && (
          <nav aria-label="자료실 화면 모드" className="flex flex-wrap items-center gap-2 text-sm">
            <Link
              href="/resources"
              className={
                !portalRole
                  ? "rounded-full bg-slate-900 px-3 py-2 text-white"
                  : "rounded-full border border-slate-200 px-3 py-2 text-slate-700 hover:bg-slate-50"
              }
            >
              관리자 자료실
            </Link>
            <Link
              href="/resources?view=faculty"
              className={
                previewRole === "FACULTY"
                  ? "rounded-full bg-slate-900 px-3 py-2 text-white"
                  : "rounded-full border border-slate-200 px-3 py-2 text-slate-700 hover:bg-slate-50"
              }
            >
              교수 화면 미리보기
            </Link>
            <Link
              href="/resources?view=student"
              className={
                previewRole === "MEMBER"
                  ? "rounded-full bg-slate-900 px-3 py-2 text-white"
                  : "rounded-full border border-slate-200 px-3 py-2 text-slate-700 hover:bg-slate-50"
              }
            >
              학생 화면 미리보기
            </Link>
          </nav>
        )}
        {/* 기존 관리자 자료 등록 동선은 그대로 유지합니다. */}
        {isAdmin && (
          <div className="flex flex-wrap gap-2">
            <Link
              href="/admin/resources/new"
              className="inline-flex items-center gap-1 rounded-md bg-[#1a1a1a] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#333333]"
            >
              <Plus className="size-4" />
              수업일지 추가
            </Link>
            <Link
              href="/admin/resources/weekly-texts/new"
              className="inline-flex items-center gap-1 rounded-md bg-[#1a1a1a] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#333333]"
            >
              <Plus className="size-4" />
              주차별 텍스트 추가
            </Link>
            <Link
              href="/admin/resources/guidebooks/new"
              className="inline-flex items-center gap-1 rounded-md bg-[#1a1a1a] px-3 py-1.5 text-sm font-medium text-white hover:bg-[#333333]"
            >
              <Plus className="size-4" />
              가이드북 추가
            </Link>
          </div>
        )}
      </section>

      {portalRole && (
        <div className="mb-6">
          <ResourcePortal
            role={portalRole}
            cohortName={isAdmin ? null : cohortName}
            userCohortId={isAdmin ? null : userCohortId}
            items={items}
            preview={isAdmin}
          />
        </div>
      )}

      <section aria-labelledby="resource-library-heading" className="space-y-5">
        <h2 id="resource-library-heading" className="text-xl font-bold text-slate-900 sm:text-2xl">
          {portalRole ? "전체 자료 찾아보기" : "자료 목록"}
        </h2>
        <ResourcesTabs
          key={initialCategory}
          initialCategory={initialCategory}
          items={items}
          cohorts={cohortRows}
          userCohortId={userCohortId}
          userRole={userRole ?? null}
        />
      </section>
    </div>
  );
}
