/** 로그인 후 최소 학사포털 요약. 자료와 권한은 기존 공통 서비스·상세 URL에서 검증합니다. */
import Link from "next/link";
import { formatKstDate } from "@/lib/date-time";
import type { ResourceItem } from "./resources-tabs";

type Props = {
  role: "MEMBER" | "FACULTY";
  cohortName: string | null;
  userCohortId: string | null;
  items: ResourceItem[];
  preview?: boolean;
};

export function ResourcePortal({
  role,
  cohortName,
  userCohortId,
  items,
  preview = false,
}: Props) {
  const faculty = role === "FACULTY";
  const suffix = preview ? "&view=" + (faculty ? "faculty" : "student") : "";
  const resourceHref = (category: string) =>
    "/resources?category=" + encodeURIComponent(category) + suffix + "#resource-library-heading";

  const recent = items
    .filter((item) => {
      if (!item.href && !item.downloadUrl) return false;
      if (faculty) return item.category === "강의 자료";
      if (item.category === "강의 자료") return item.audience !== "FACULTY";
      if (item.category === "주차별 텍스트") {
        return Boolean(userCohortId) && item.cohortId === userCohortId;
      }
      if (item.category === "주차별 수업일지") {
        return Boolean(userCohortId) && item.cohortId === userCohortId;
      }
      return item.category === "가이드북" || item.category === "보고서 양식";
    })
    .slice(0, 3);

  const mainAction = faculty
    ? preview
      ? { href: resourceHref("강의 자료"), label: "강의자료 보기" }
      : { href: "/resources/class-materials", label: "강의자료 등록" }
    : userCohortId
      ? { href: resourceHref("주차별 텍스트"), label: "내 학습자료 보기" }
      : { href: resourceHref("강의 자료"), label: "공통 강의자료 보기" };

  const secondaryAction = faculty
    ? { href: resourceHref("강의 자료"), label: "강의자료 목록" }
    : { href: resourceHref("가이드북"), label: "가이드북" };

  return (
    <section
      aria-label={faculty ? "교수 학사포털" : "학생 학습포털"}
      className="space-y-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold text-slate-900 sm:text-2xl">
            {faculty ? "교수 학사포털" : "학생 학습포털"}
          </h2>
          <p className="mt-1 text-sm text-slate-600">
            {faculty
              ? "강의자료를 관리하고 수업을 준비하세요."
              : cohortName
                ? cohortName + " · 내 학습자료"
                : "기수가 배정되지 않았습니다. 공통 자료를 이용할 수 있습니다."}
          </p>
        </div>
        {preview && <span className="text-xs text-slate-500">관리자 화면 미리보기</span>}
      </div>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-slate-900">
            {faculty ? "강의 준비" : "학습 바로가기"}
          </h3>
          <div className="mt-3 flex flex-wrap gap-2">
            <Link
              href={mainAction.href}
              className="inline-flex min-h-11 items-center rounded-lg bg-blue-700 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
            >
              {mainAction.label}
            </Link>
            {mainAction.href !== secondaryAction.href && (
              <Link
                href={secondaryAction.href}
                className="inline-flex min-h-11 items-center rounded-lg border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-700"
              >
                {secondaryAction.label}
              </Link>
            )}
          </div>
        </div>

        <section
          aria-labelledby="portal-recent-heading"
          className="min-w-0 rounded-xl border border-slate-200 bg-white p-4"
        >
          <h3 id="portal-recent-heading" className="text-sm font-semibold text-slate-900">
            {faculty ? "최근 강의자료" : "최근 학습자료"}
          </h3>
          {recent.length === 0 ? (
            <p className="mt-3 text-sm text-slate-600">
              {faculty ? "등록된 강의자료가 없습니다." : "표시할 자료가 없습니다."}
            </p>
          ) : (
            <ul className="mt-2 divide-y divide-slate-100">
              {recent.map((item) => (
                <li key={item.id} className="min-w-0 py-2.5">
                  <div className="flex min-w-0 items-start justify-between gap-3">
                    {item.href ? (
                      <Link
                        href={item.href}
                        className="min-w-0 break-words text-sm font-medium text-slate-800 hover:text-blue-700 focus-visible:outline-2 focus-visible:outline-blue-700"
                      >
                        {item.title}
                      </Link>
                    ) : (
                      <a
                        href={item.downloadUrl}
                        download
                        className="min-w-0 break-words text-sm font-medium text-slate-800 hover:text-blue-700 focus-visible:outline-2 focus-visible:outline-blue-700"
                      >
                        {item.title}
                      </a>
                    )}
                    <span className="shrink-0 text-xs text-slate-500">
                      {formatKstDate(item.date)}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </section>
  );
}
