/**
 * #160 학사 운영 관리자 화면입니다(운영 인력 배정·교체·종료, 출결 정정 결정, 배정 감사).
 *
 * - 접근: DB의 유효한 학사 운영 관리자 지정이 있는 계정만. 홈페이지 `ADMIN` 역할이나 G1 지정 승인자 설정만으로는 열리지 않습니다.
 *   (홈페이지 `/admin`·`/admin/academics` 경계는 각각 ADMIN·지정 승인자 전용이라 사용하지 않고 회원 영역에 둡니다.)
 * - 기능 플래그 `ACADEMIC_ENABLED`·`ACADEMIC_STAFF_ENABLED`가 꺼져 있거나 관리자 지정이 없으면 404입니다.
 *   정정 결정 목록은 `ACADEMIC_ATTENDANCE_ENABLED`까지 켜졌을 때만 보입니다.
 * - 페이지는 DB를 직접 호출하지 않고 Application Service만 호출합니다. 사유·확인 근거 원문은 표시하지 않습니다.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { CorrectionDecisionForm } from "@/components/academics/correction-decision-form";
import { AcademicAttendanceError } from "@/features/academics/attendance/contracts";
import {
  ATTENDANCE_STATUS_LABELS,
  EXCUSE_METHOD_LABELS,
  REASON_PRIVACY_NOTICE,
  STAFF_AUDIT_ACTION_LABELS,
  STAFF_ROLE_LABELS,
} from "@/features/academics/attendance/labels";
import {
  isAcademicAttendanceEnabled,
  listPendingCorrectionsForManager,
} from "@/features/academics/attendance/service";
import { AcademicStaffError } from "@/features/academics/staff/contracts";
import {
  getStaffManagementOverview,
  isAcademicStaffEnabled,
  listStaffAuditEvents,
} from "@/features/academics/staff/service";
import { getWebAcademicPrincipal } from "@/features/academics/staff/web-principal";
import { formatKstDate, formatKstDateTime } from "@/lib/date-time";
import { logServerError } from "@/lib/errors";
import { AssignStaffForm, EndStaffForm, ReplaceStaffForm } from "./_components/staff-forms";

export const metadata: Metadata = { title: "학사 운영 관리" };
export const dynamic = "force-dynamic";

const PATH = "/member/academic-operations";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <section className="mx-auto max-w-6xl space-y-10 px-4 py-12 text-[#1a1a1a]">
      <h1 className="text-3xl font-bold">학사 운영 관리</h1>
      {children}
      <Link href="/mypage" className="inline-block underline">
        마이페이지로 돌아가기
      </Link>
    </section>
  );
}

/** 관리자 지정이 없거나 기능이 꺼져 있으면 404, 로그인 필요는 로그인 이동, 그 밖은 오류 안내로 바꿉니다. */
function handleAccessError(error: unknown): string {
  if (error instanceof AcademicStaffError || error instanceof AcademicAttendanceError) {
    if (error.code === "DISABLED" || error.code === "FORBIDDEN" || error.code === "NOT_FOUND")
      notFound();
    if (error.code === "UNAUTHENTICATED")
      redirect(`/login?callbackUrl=${encodeURIComponent(PATH)}`);
    return error.message;
  }
  logServerError("academic-staff/operations-page", error);
  return "정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.";
}

export default async function AcademicOperationsPage() {
  if (!isAcademicStaffEnabled()) notFound();
  const principal = await getWebAcademicPrincipal();
  if (!principal) redirect(`/login?callbackUrl=${encodeURIComponent(PATH)}`);

  let overview;
  let audit;
  try {
    // 관리자 지정 확인을 먼저 끝낸 뒤 감사 목록을 읽습니다(둘 다 서비스가 관리자 지정을 다시 확인).
    overview = await getStaffManagementOverview(principal);
    audit = await listStaffAuditEvents(principal);
  } catch (error) {
    return (
      <Shell>
        <p role="alert">{handleAccessError(error)}</p>
      </Shell>
    );
  }

  let corrections = null;
  let correctionError: string | null = null;
  if (isAcademicAttendanceEnabled()) {
    try {
      corrections = await listPendingCorrectionsForManager(principal);
    } catch (error) {
      correctionError = handleAccessError(error);
    }
  }
  return (
    <Shell>
      <p className="text-[#666666]">
        기수별 어드바이저 1명·조교 2명의 배정과 교체, 출결 정정 결정을 관리합니다. 모든 변경은 감사
        기록에 남고 지난 시각으로 소급할 수 없습니다. 시각은 한국시간입니다.
      </p>
      <p className="rounded-xl border border-[#D9D9D9] p-4 text-sm">{REASON_PRIVACY_NOTICE}</p>

      <section aria-labelledby="staff-assignments" className="space-y-6">
        <h2 id="staff-assignments" className="text-2xl font-semibold">
          기수별 운영 인력
        </h2>
        {overview.cohorts.length === 0 && <p>등록된 기수가 없습니다.</p>}
        {overview.cohorts.map((cohort) => {
          const rows = overview.assignments.filter(
            (assignment) => assignment.cohortId === cohort.id,
          );
          return (
            <div
              key={cohort.id}
              className="space-y-2 rounded-xl border border-[#D9D9D9] p-4 shadow-[var(--shadow-soft)]"
            >
              <h3 className="text-xl font-semibold">{cohort.name}</h3>
              {rows.length === 0 ? (
                <p className="text-[#666666]">현재·예정 배정이 없습니다.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <caption className="sr-only">{cohort.name} 현재·예정 운영 인력</caption>
                    <thead>
                      <tr className="border-b border-[#D9D9D9]">
                        <th scope="col" className="p-2">
                          이름
                        </th>
                        <th scope="col" className="p-2">
                          역할
                        </th>
                        <th scope="col" className="p-2">
                          상태
                        </th>
                        <th scope="col" className="p-2">
                          기간
                        </th>
                        <th scope="col" className="p-2">
                          변경
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((assignment) => {
                        const label = `${cohort.name} ${STAFF_ROLE_LABELS[assignment.staffRole]} ${assignment.userName}`;
                        return (
                          <tr key={assignment.id} className="border-b border-[#D9D9D9] align-top">
                            <th scope="row" className="p-2 font-medium">
                              {assignment.userName}
                            </th>
                            <td className="p-2">{STAFF_ROLE_LABELS[assignment.staffRole]}</td>
                            <td className="p-2">{assignment.upcoming ? "예정" : "현재"}</td>
                            <td className="p-2">
                              {formatKstDateTime(new Date(assignment.validFrom))} ~{" "}
                              {assignment.validTo
                                ? `${formatKstDateTime(new Date(assignment.validTo))} 전`
                                : "종료 예정 없음"}
                            </td>
                            <td className="space-y-2 p-2">
                              <details>
                                <summary className="cursor-pointer text-[#2563EB] underline">
                                  배정 종료
                                </summary>
                                <EndStaffForm assignmentId={assignment.id} label={label} />
                              </details>
                              <details>
                                <summary className="cursor-pointer text-[#2563EB] underline">
                                  교체
                                </summary>
                                <ReplaceStaffForm assignmentId={assignment.id} label={label} />
                              </details>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
      </section>

      <section aria-labelledby="assign-staff" className="space-y-4">
        <h2 id="assign-staff" className="text-2xl font-semibold">
          운영 인력 배정
        </h2>
        <AssignStaffForm cohorts={overview.cohorts} />
      </section>

      {(corrections || correctionError) && (
        <section aria-labelledby="pending-corrections" className="space-y-4">
          <h2 id="pending-corrections" className="text-2xl font-semibold">
            결정 대기 중인 출결 정정
          </h2>
          {correctionError && <p role="alert">{correctionError}</p>}
          {corrections && corrections.length === 0 && <p>결정 대기 중인 정정 요청이 없습니다.</p>}
          {corrections && corrections.length > 0 && (
            <ul className="space-y-3">
              {corrections.map((correction) => (
                <li
                  key={correction.id}
                  className="space-y-2 rounded-xl border border-[#D9D9D9] p-4"
                >
                  <p className="font-semibold">
                    {correction.cohortName} · {formatKstDate(correction.classDate)}{" "}
                    {correction.eventTitle} · {correction.displayName}
                  </p>
                  <p>
                    {ATTENDANCE_STATUS_LABELS[correction.previousStatus]} →{" "}
                    {ATTENDANCE_STATUS_LABELS[correction.requestedStatus]}
                    {correction.excuseVerificationMethod &&
                      ` (확인 방식: ${EXCUSE_METHOD_LABELS[correction.excuseVerificationMethod]})`}
                  </p>
                  <p className="text-sm text-[#666666]">사유: {correction.reason}</p>
                  <p className="text-sm text-[#666666]">
                    요청 {formatKstDateTime(new Date(correction.requestedAt))}
                  </p>
                  {correction.requestedBySelf ? (
                    <p className="text-sm text-[#666666]">
                      본인이 요청한 정정은 다른 담당자가 결정합니다.
                    </p>
                  ) : (
                    <CorrectionDecisionForm
                      correctionId={correction.id}
                      label={`${correction.displayName} ${formatKstDate(correction.classDate)}`}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      <section aria-labelledby="staff-audit" className="space-y-4">
        <h2 id="staff-audit" className="text-2xl font-semibold">
          최근 배정 변경 기록
        </h2>
        {audit.length === 0 ? (
          <p>기록이 없습니다.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <caption className="sr-only">최근 50건의 운영 인력 배정 변경 감사 기록</caption>
              <thead>
                <tr className="border-b border-[#D9D9D9]">
                  <th scope="col" className="p-2">
                    시각
                  </th>
                  <th scope="col" className="p-2">
                    변경
                  </th>
                  <th scope="col" className="p-2">
                    기수
                  </th>
                  <th scope="col" className="p-2">
                    대상
                  </th>
                  <th scope="col" className="p-2">
                    처리자
                  </th>
                </tr>
              </thead>
              <tbody>
                {audit.map((event) => (
                  <tr key={event.id} className="border-b border-[#D9D9D9]">
                    <td className="p-2">{formatKstDateTime(new Date(event.createdAt))}</td>
                    <td className="p-2">{STAFF_AUDIT_ACTION_LABELS[event.action]}</td>
                    <td className="p-2">{event.cohortName ?? "-"}</td>
                    <td className="p-2">{event.targetName ?? "-"}</td>
                    <td className="p-2">{event.actorName}</td>
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
