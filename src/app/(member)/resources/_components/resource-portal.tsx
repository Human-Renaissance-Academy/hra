/** 역할별 자료실 첫 화면. 기존 자료 조회·다운로드 권한은 상위 서비스와 각 URL에서 검증합니다. */
import Link from "next/link";
import {
  ArrowUpRight,
  BookOpenText,
  ClipboardCheck,
  FileText,
  FolderOpen,
  GraduationCap,
  NotebookPen,
  UploadCloud,
  type LucideIcon,
} from "lucide-react";
import { formatKstDate } from "@/lib/date-time";
import type { ResourceItem } from "./resources-tabs";

type Role = "MEMBER" | "FACULTY";
type Shortcut = {
  title: string;
  description: string;
  href: string;
  icon: LucideIcon;
};

type Props = {
  role: Role;
  cohortName: string | null;
  userCohortId: string | null;
  items: ResourceItem[];
  preview?: boolean;
};

export function ResourcePortal({ role, cohortName, userCohortId, items, preview = false }: Props) {
  const faculty = role === "FACULTY";
  const suffix = preview ? "&view=" + (faculty ? "faculty" : "student") : "";
  const resourceHref = (category: string) =>
    "/resources?category=" + encodeURIComponent(category) + suffix;
  const academicEnabled = !preview && process.env.ACADEMIC_ENABLED === "true";
  const reviewEnabled =
    academicEnabled &&
    process.env.ACADEMIC_FACULTY_REVIEW_ENABLED === "true" &&
    process.env.ACADEMIC_ASSIGNMENT_REVIEW_ENABLED === "true";
  const attendanceEnabled =
    academicEnabled &&
    process.env.ACADEMIC_STAFF_ENABLED === "true" &&
    process.env.ACADEMIC_ATTENDANCE_ENABLED === "true";

  // 서비스가 전달한 공개 가능 메타데이터만 사용합니다. 관리자 미리보기 역시 학생용 자료만 보입니다.
  const recent = items
    .filter((item) => {
      if (!item.href) return false;
      if (faculty) return item.category === "강의 자료";
      if (item.category === "강의 자료") return item.audience !== "FACULTY";
      return (
        Boolean(userCohortId) &&
        item.cohortId === userCohortId &&
        (item.category === "주차별 텍스트" || item.category === "주차별 수업일지")
      );
    })
    .slice(0, 4);

  const sharedMaterialCount = items.filter(
    (item) => item.category === "강의 자료" && (faculty || item.audience !== "FACULTY"),
  ).length;
  const ownTextCount = userCohortId
    ? items.filter((item) => item.category === "주차별 텍스트" && item.cohortId === userCohortId)
        .length
    : 0;

  const shortcuts: Shortcut[] = faculty
    ? [
        {
          title: "강의자료 등록",
          description: "수업용 파일 업로드",
          href: "/resources/class-materials",
          icon: UploadCloud,
        },
        {
          title: "강의자료 보기",
          description: "등록 자료 조회",
          href: resourceHref("강의 자료"),
          icon: FolderOpen,
        },
        {
          title: "주차별 텍스트",
          description: "경영서·고전·기업실무",
          href: resourceHref("주차별 텍스트"),
          icon: BookOpenText,
        },
        {
          title: "수업일지",
          description: "수업 내용 확인",
          href: resourceHref("주차별 수업일지"),
          icon: NotebookPen,
        },
      ]
    : [
        {
          title: "주차별 텍스트",
          description: "내 기수 학습자료",
          href: resourceHref("주차별 텍스트"),
          icon: BookOpenText,
        },
        {
          title: "강의자료",
          description: "교수진 공유 파일",
          href: resourceHref("강의 자료"),
          icon: FolderOpen,
        },
        {
          title: "수업일지",
          description: "수업 내용과 기록",
          href: resourceHref("주차별 수업일지"),
          icon: NotebookPen,
        },
        {
          title: "가이드북·양식",
          description: "학습 안내와 서식",
          href: resourceHref("가이드북"),
          icon: FileText,
        },
      ];

  return (
    <section aria-label={faculty ? "교수 학사포털" : "학생 학습포털"} className="space-y-5">
      <div className="relative overflow-hidden rounded-3xl bg-slate-950 px-5 py-7 text-white sm:px-8 sm:py-9">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-12 -top-14 size-52 rounded-full bg-blue-500/15 blur-3xl"
        />
        <div className="relative">
          <p className="mb-3 flex items-center gap-2 text-xs font-semibold tracking-[0.15em] text-blue-200">
            <GraduationCap className="size-4" aria-hidden="true" />
            HRA ACADEMIC
          </p>
          <h2 className="text-2xl font-bold tracking-tight sm:text-3xl">
            {faculty ? "교수 학사포털" : "학생 학습포털"}
          </h2>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-slate-300 sm:text-base">
            {faculty
              ? "강의자료와 주차별 수업 기록을 확인하고 수업을 준비하세요."
              : "내 기수의 학습자료와 수업 기록을 한곳에서 확인하세요."}
          </p>
          <div className="mt-5 inline-flex rounded-full border border-white/20 px-3 py-1.5 text-xs font-semibold text-blue-100">
            {faculty
              ? "교수 계정 · 접근 가능한 전체 기수"
              : cohortName
                ? "소속 " + cohortName
                : "기수 연결 확인 필요"}
          </div>
        </div>
      </div>

      {preview && (
        <p className="rounded-lg bg-blue-50 px-3 py-2 text-sm text-blue-900">
          관리자 화면 미리보기입니다. 실제 계정 권한과 학생의 학적은 변경되지 않습니다.
        </p>
      )}

      <nav aria-label="학사포털 바로가기" className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {shortcuts.map(({ title, description, href, icon: Icon }) => (
          <Link
            key={title}
            href={href}
            className="group flex min-w-0 flex-col rounded-2xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-blue-300 hover:shadow-md focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-blue-600"
          >
            <span className="mb-3 inline-flex size-10 items-center justify-center rounded-xl bg-blue-50 text-blue-700">
              <Icon className="size-5" aria-hidden="true" />
            </span>
            <span className="break-keep text-sm font-semibold text-slate-900 sm:text-base">
              {title}
            </span>
            <span className="mt-1 text-xs leading-5 text-slate-500">{description}</span>
            <ArrowUpRight
              className="mt-2 size-4 self-end text-slate-400 group-hover:text-blue-600"
              aria-hidden="true"
            />
          </Link>
        ))}
      </nav>

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <section
          aria-labelledby="portal-recent-heading"
          className="rounded-2xl border border-slate-200 bg-white p-4 sm:p-5"
        >
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 id="portal-recent-heading" className="text-base font-bold text-slate-900">
              {faculty ? "최근 강의자료" : "최근 학습자료"}
            </h3>
            <span className="text-xs text-slate-500">권한 내 자료만 표시</span>
          </div>
          {recent.length === 0 ? (
            <p className="rounded-lg bg-slate-50 px-3 py-6 text-sm text-slate-600">
              {faculty
                ? "등록된 강의자료가 없습니다."
                : userCohortId
                  ? "아직 표시할 학습자료가 없습니다."
                  : "기수 배정 후 내 기수 자료를 확인할 수 있습니다."}
            </p>
          ) : (
            <ul className="divide-y divide-slate-100">
              {recent.map((item) => (
                <li key={item.id} className="py-3 first:pt-1">
                  {item.href && (
                    <Link
                      href={item.href}
                      className="flex min-w-0 items-start justify-between gap-3 rounded-md text-sm hover:text-blue-700 focus-visible:outline-2 focus-visible:outline-blue-600"
                    >
                      <span className="min-w-0 break-words font-medium text-slate-900">
                        {item.title}
                      </span>
                      <span className="shrink-0 text-xs text-slate-500">
                        {formatKstDate(item.date)}
                      </span>
                    </Link>
                  )}
                  <p className="mt-1 text-xs text-slate-500">{item.category}</p>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section
          aria-labelledby="portal-actions-heading"
          className="rounded-2xl border border-slate-200 bg-slate-50 p-4 sm:p-5"
        >
          <h3 id="portal-actions-heading" className="text-base font-bold text-slate-900">
            {faculty ? "강의 운영" : "나의 학습"}
          </h3>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <div className="rounded-xl bg-white p-3">
              <p className="text-xs text-slate-500">
                {faculty ? "공유 강의자료" : "열람 가능 강의자료"}
              </p>
              <p className="mt-1 text-2xl font-bold text-slate-900">
                {sharedMaterialCount}
                <span className="ml-1 text-sm font-normal">건</span>
              </p>
            </div>
            <div className="rounded-xl bg-white p-3">
              <p className="text-xs text-slate-500">
                {faculty ? "최근 강의자료" : "내 기수 텍스트"}
              </p>
              <p className="mt-1 text-2xl font-bold text-slate-900">
                {faculty ? recent.length : ownTextCount}
                <span className="ml-1 text-sm font-normal">건</span>
              </p>
            </div>
          </div>
          {faculty ? (
            reviewEnabled ? (
              <Link
                href="/member/reviews"
                className="mt-3 flex items-center justify-between rounded-xl border border-blue-200 bg-white p-3 text-sm font-semibold text-blue-700 hover:bg-blue-50"
              >
                <span className="flex items-center gap-2">
                  <ClipboardCheck className="size-4" aria-hidden="true" /> 담당 과제 검토
                </span>
                <ArrowUpRight className="size-4" aria-hidden="true" />
              </Link>
            ) : (
              <p className="mt-3 flex items-start gap-2 rounded-xl bg-white p-3 text-sm text-slate-600">
                <ClipboardCheck className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
                과제 제출함·피드백은 운영 승인 후 이용할 수 있습니다.
              </p>
            )
          ) : academicEnabled ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <Link
                href="/member/assignments"
                className="inline-flex items-center gap-2 rounded-lg bg-blue-700 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-800"
              >
                <ClipboardCheck className="size-4" aria-hidden="true" /> 내 과제
              </Link>
              {attendanceEnabled && (
                <Link
                  href="/member/attendance"
                  className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-semibold text-slate-800 hover:bg-slate-100"
                >
                  내 출결
                </Link>
              )}
            </div>
          ) : (
            <p className="mt-3 text-sm leading-6 text-slate-600">
              개인별 과제·출결 기능은 운영 승인 후 제공됩니다.
            </p>
          )}
        </section>
      </div>
    </section>
  );
}
