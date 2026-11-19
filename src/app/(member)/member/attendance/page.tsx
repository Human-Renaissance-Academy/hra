/**
 * #160 학생 본인의 "내 출결" 화면입니다.
 *
 * - 로그인 계정에 연결된 본인 학적의 이미 시작된 CLASS 수업일 출결만 보여줍니다(P9). 미입력은 결석과 다르게 표시합니다.
 * - 정정 요청은 처리 상태 요약(이전 → 요청 상태, 결정 대기/승인/반려)만 보여주며 사유·운영 인력 신원은 표시하지 않습니다.
 * - 기능 플래그가 꺼져 있으면 404입니다. 페이지는 DB를 직접 호출하지 않고 Application Service만 호출합니다.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  AcademicAttendanceError,
  type AttendanceCellStatus,
} from "@/features/academics/attendance/contracts";
import {
  getOwnAttendanceOverview,
  isAcademicAttendanceEnabled,
} from "@/features/academics/attendance/service";
import {
  ATTENDANCE_STATUS_LABELS,
  CORRECTION_STATUS_LABELS,
} from "@/features/academics/attendance/labels";
import { getWebAcademicPrincipal } from "@/features/academics/staff/web-principal";
import { formatKstDate, formatKstDateTime } from "@/lib/date-time";
import { logServerError } from "@/lib/errors";

export const metadata: Metadata = { title: "내 출결" };
export const dynamic = "force-dynamic";

const PATH = "/member/attendance";
// 요약 표의 상태 순서. 미입력을 별도 항목으로 둡니다.
const SUMMARY_ORDER: AttendanceCellStatus[] = ["PRESENT", "LATE", "ABSENT", "EXCUSED", "UNMARKED"];

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <section className="mx-auto max-w-4xl space-y-6 px-4 py-12 text-[#1a1a1a]">
      <h1 className="text-3xl font-bold">내 출결</h1>
      {children}
      <Link href="/mypage" className="inline-block underline">
        마이페이지로 돌아가기
      </Link>
    </section>
  );
}

export default async function MyAttendancePage() {
  if (!isAcademicAttendanceEnabled()) notFound();
  const principal = await getWebAcademicPrincipal();
  if (!principal) redirect(`/login?callbackUrl=${encodeURIComponent(PATH)}`);

  let overview;
  try {
    overview = await getOwnAttendanceOverview(principal);
  } catch (error) {
    if (error instanceof AcademicAttendanceError) {
      if (error.code === "DISABLED" || error.code === "FORBIDDEN") notFound();
      if (error.code === "UNAUTHENTICATED")
        redirect(`/login?callbackUrl=${encodeURIComponent(PATH)}`);
    } else {
      logServerError("academic-attendance/own-page", error);
    }
    return (
      <Shell>
        <p role="alert">출결을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</p>
      </Shell>
    );
  }

  const { records, cohorts, corrections } = overview;
  if (cohorts.length === 0) {
    return (
      <Shell>
        <p>
          현재 계정에 연결된 학생 학적이 없습니다. 운영 담당자에게 계정 연결과 기수 등록을 문의해
          주세요.
        </p>
      </Shell>
    );
  }
  const cohortName = (id: string) => cohorts.find((cohort) => cohort.id === id)?.name ?? "기수";

  return (
    <Shell>
      <p className="text-[#666666]">
        이미 시작된 수업일의 본인 출결입니다. &quot;미입력&quot;은 아직 기록되지 않았다는 뜻이며
        결석이 아닙니다. 출결이 사실과 다르면 기수 운영 담당자에게 문의해 주세요.
      </p>

      {cohorts.map((cohort) => {
        const rows = records.filter((record) => record.cohortId === cohort.id);
        return (
          <section key={cohort.id} aria-labelledby={`cohort-${cohort.id}`} className="space-y-3">
            <h2 id={`cohort-${cohort.id}`} className="text-2xl font-semibold">
              {cohort.name}
            </h2>
            {rows.length === 0 ? (
              <p>아직 시작된 수업일이 없습니다.</p>
            ) : (
              <>
                <ul aria-label={`${cohort.name} 출결 요약`} className="flex flex-wrap gap-3">
                  {SUMMARY_ORDER.map((status) => (
                    <li key={status} className="rounded border border-[#D9D9D9] px-3 py-1.5">
                      {ATTENDANCE_STATUS_LABELS[status]}{" "}
                      {rows.filter((row) => row.status === status).length}회
                    </li>
                  ))}
                </ul>
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <caption className="sr-only">{cohort.name} 수업일별 출결</caption>
                    <thead>
                      <tr className="border-b border-[#D9D9D9]">
                        <th scope="col" className="p-3">
                          수업일
                        </th>
                        <th scope="col" className="p-3">
                          출결
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((row) => (
                        <tr
                          key={`${row.enrollmentId}:${row.scheduleEventId}`}
                          className="border-b border-[#D9D9D9]"
                        >
                          <td className="p-3">{formatKstDate(row.classDate)}</td>
                          <td
                            className={`p-3 ${row.status === "UNMARKED" ? "text-[#666666]" : "font-semibold"}`}
                          >
                            {ATTENDANCE_STATUS_LABELS[row.status]}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </section>
        );
      })}

      <section aria-labelledby="my-corrections" className="space-y-3">
        <h2 id="my-corrections" className="text-2xl font-semibold">
          출결 정정 내역
        </h2>
        {corrections.length === 0 ? (
          <p>정정 내역이 없습니다.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <caption className="sr-only">본인 출결 정정 요청과 처리 상태</caption>
              <thead>
                <tr className="border-b border-[#D9D9D9]">
                  <th scope="col" className="p-3">
                    기수
                  </th>
                  <th scope="col" className="p-3">
                    수업일
                  </th>
                  <th scope="col" className="p-3">
                    변경 내용
                  </th>
                  <th scope="col" className="p-3">
                    처리 상태
                  </th>
                  <th scope="col" className="p-3">
                    처리 시각
                  </th>
                </tr>
              </thead>
              <tbody>
                {corrections.map((correction) => (
                  <tr key={correction.id} className="border-b border-[#D9D9D9]">
                    <td className="p-3">{cohortName(correction.cohortId)}</td>
                    <td className="p-3">{formatKstDate(correction.classDate)}</td>
                    <td className="p-3">
                      {ATTENDANCE_STATUS_LABELS[correction.previousStatus]} →{" "}
                      {ATTENDANCE_STATUS_LABELS[correction.requestedStatus]}
                    </td>
                    <td className="p-3 font-semibold">
                      {CORRECTION_STATUS_LABELS[correction.status]}
                    </td>
                    <td className="p-3">
                      {correction.decidedAt
                        ? formatKstDateTime(new Date(correction.decidedAt))
                        : `요청 ${formatKstDateTime(new Date(correction.requestedAt))}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </Shell>
  );
}
