/**
 * #160 기수 운영 인력(어드바이저·조교)의 출결 입력 화면입니다.
 *
 * - 흐름: 배정된 기수 선택 → 그 기수의 CLASS 수업일 선택 → 학생별 출결표.
 * - 기능 플래그(`ACADEMIC_ENABLED`·`ACADEMIC_STAFF_ENABLED`·`ACADEMIC_ATTENDANCE_ENABLED`)가 꺼져 있으면 404입니다.
 * - 경로 자체는 회원 영역(Proxy·authorized 콜백·회원 레이아웃의 로그인/승인 확인)이고, 기수 배정 여부는 매 요청
 *   서비스가 DB 현재 시각으로 다시 판정합니다. 홈페이지 `ADMIN`·교수 `FACULTY` 역할만으로는 볼 수 없습니다.
 * - 페이지는 DB를 직접 호출하지 않고 Application Service만 호출합니다.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { z } from "zod/v4";
import { AcademicAttendanceError } from "@/features/academics/attendance/contracts";
import {
  isAcademicAttendanceEnabled,
  listClassSessions,
  listForCohortSession,
} from "@/features/academics/attendance/service";
import { AcademicStaffError } from "@/features/academics/staff/contracts";
import { listMyStaffCohorts } from "@/features/academics/staff/service";
import { getWebAcademicPrincipal } from "@/features/academics/staff/web-principal";
import { STAFF_ROLE_LABELS } from "@/features/academics/attendance/labels";
import { formatKstDate, formatKstDateTime } from "@/lib/date-time";
import { logServerError } from "@/lib/errors";
import { AttendanceGrid } from "./_components/attendance-grid";

export const metadata: Metadata = { title: "출결 입력" };
export const dynamic = "force-dynamic";

const PATH = "/member/attendance/staff";

/** 서비스 오류를 화면 처리로 바꿉니다. 비활성·없음은 404, 로그인 필요는 로그인 이동, 나머지는 안내 문구입니다. */
function errorMessage(error: unknown): string {
  if (error instanceof AcademicAttendanceError || error instanceof AcademicStaffError) {
    if (error.code === "DISABLED" || error.code === "NOT_FOUND") notFound();
    if (error.code === "UNAUTHENTICATED")
      redirect(`/login?callbackUrl=${encodeURIComponent(PATH)}`);
    if (error.code === "FORBIDDEN")
      return "이 기수의 출결을 다룰 권한이 없습니다. 배정이 끝났거나 다른 기수일 수 있습니다.";
    return error.message;
  }
  logServerError("academic-attendance/staff-page", error);
  return "출결 정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.";
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <section className="mx-auto max-w-5xl space-y-6 px-4 py-12 text-[#1a1a1a]">
      <h1 className="text-3xl font-bold">출결 입력</h1>
      {children}
      <Link href="/mypage" className="inline-block underline">
        마이페이지로 돌아가기
      </Link>
    </section>
  );
}

export default async function StaffAttendancePage({
  searchParams,
}: {
  searchParams: Promise<{ cohort?: string; event?: string }>;
}) {
  // 기능이 꺼져 있으면 학사 표를 조회하지 않고 경로 존재도 드러내지 않습니다.
  if (!isAcademicAttendanceEnabled()) notFound();
  const principal = await getWebAcademicPrincipal();
  if (!principal) redirect(`/login?callbackUrl=${encodeURIComponent(PATH)}`);
  const params = await searchParams;
  const cohortParam = z.uuid().safeParse(params.cohort).success ? params.cohort : undefined;
  const eventParam = z.uuid().safeParse(params.event).success ? params.event : undefined;

  // 1단계: 본인의 현재 유효 배정 기수.
  let cohorts;
  try {
    cohorts = await listMyStaffCohorts(principal);
  } catch (error) {
    return (
      <Shell>
        <p role="alert">{errorMessage(error)}</p>
      </Shell>
    );
  }
  if (cohorts.length === 0) {
    return (
      <Shell>
        <p>
          현재 출결을 입력할 수 있는 배정 기수가 없습니다. 배정은 학사 운영 관리자에게 문의해
          주세요.
        </p>
      </Shell>
    );
  }
  const selected = cohorts.find((cohort) => cohort.cohortId === cohortParam);

  // 2단계: 선택한 기수의 수업일(서비스가 배정을 다시 확인).
  let sessions = null;
  let sessionError: string | null = null;
  if (selected) {
    try {
      sessions = await listClassSessions(principal, selected.cohortId);
    } catch (error) {
      sessionError = errorMessage(error);
    }
  }
  const selectedSession = sessions?.find((session) => session.id === eventParam);

  // 3단계: 선택한 수업일의 출결표(서비스가 배정을 다시 확인).
  let sheet = null;
  let sheetError: string | null = null;
  if (selectedSession) {
    try {
      sheet = await listForCohortSession(principal, selectedSession.id);
    } catch (error) {
      sheetError = errorMessage(error);
    }
  }
  // 입력 창 안내를 위한 서버 렌더 시각. 실제 허용 여부는 DB 현재 시각으로 다시 판정합니다.
  const serverNow = new Date().toISOString();

  return (
    <Shell>
      <p className="text-[#666666]">
        배정된 기수의 수업일마다 학생별 출결을 입력합니다. 미입력은 결석과 다르며, 시각은
        한국시간입니다.
      </p>

      <nav aria-label="배정 기수">
        <h2 className="mb-2 text-xl font-semibold">기수 선택</h2>
        <ul className="flex flex-wrap gap-3">
          {cohorts.map((cohort) => (
            <li key={cohort.cohortId}>
              <Link
                href={`${PATH}?cohort=${cohort.cohortId}`}
                aria-current={cohort.cohortId === selected?.cohortId ? "page" : undefined}
                className={`inline-block rounded border px-4 py-2 ${
                  cohort.cohortId === selected?.cohortId
                    ? "border-[#1a1a1a] font-semibold"
                    : "border-[#D9D9D9] text-[#2563EB]"
                }`}
              >
                {cohort.cohortName} · {STAFF_ROLE_LABELS[cohort.staffRole]}
                {cohort.validTo && ` (${formatKstDateTime(new Date(cohort.validTo))}까지)`}
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      {selected && (
        <nav aria-label="수업일">
          <h2 className="mb-2 text-xl font-semibold">수업일 선택</h2>
          {sessionError && <p role="alert">{sessionError}</p>}
          {sessions && sessions.length === 0 && <p>이 기수에 등록된 수업일이 없습니다.</p>}
          {sessions && sessions.length > 0 && (
            <ul className="flex flex-wrap gap-3">
              {sessions.map((session) => (
                <li key={session.id}>
                  <Link
                    href={`${PATH}?cohort=${selected.cohortId}&event=${session.id}`}
                    aria-current={session.id === selectedSession?.id ? "page" : undefined}
                    className={`inline-block rounded border px-4 py-2 ${
                      session.id === selectedSession?.id
                        ? "border-[#1a1a1a] font-semibold"
                        : "border-[#D9D9D9] text-[#2563EB]"
                    }`}
                  >
                    {formatKstDate(session.classDate)} · {session.title}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </nav>
      )}

      {selectedSession && (
        <section aria-labelledby="attendance-sheet-title" className="space-y-3">
          <h2 id="attendance-sheet-title" className="text-xl font-semibold">
            {formatKstDate(selectedSession.classDate)} {selectedSession.title} 출결
          </h2>
          {sheetError && <p role="alert">{sheetError}</p>}
          {sheet && (
            <AttendanceGrid
              // 서버 값(버전·대기 정정)이 바뀌면 화면 사본을 새로 만듭니다.
              key={sheet.entries
                .map(
                  (entry) =>
                    `${entry.enrollmentId}:${entry.version}:${entry.pendingCorrection?.id ?? ""}`,
                )
                .join("|")}
              sheet={sheet}
              serverNow={serverNow}
              currentUserId={principal.userId}
            />
          )}
        </section>
      )}
    </Shell>
  );
}
