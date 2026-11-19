/**
 * #163 학사 운영 관리자의 수료 기준 버전 관리·수료 심사 화면입니다.
 *
 * - 접근: DB의 유효한 학사 운영 관리자 지정이 있는 계정만. 홈페이지 `ADMIN`·`FACULTY` 역할만으로는 열리지 않습니다.
 * - 기능 플래그 `ACADEMIC_ENABLED`·`ACADEMIC_STAFF_ENABLED`·`ACADEMIC_COMPLETION_ENABLED`가 꺼져 있거나
 *   관리자 지정이 없으면 404입니다.
 * - 기수를 고르면 기준 버전(초안 수정·공개, 새 버전 작성)과 학적별 보조 지표·현재 결정·결정 이력을 보여 줍니다.
 *   보조 지표는 참고용이며 수료는 관리자가 사유와 함께 직접 기록합니다(자동 수료 없음).
 * - 페이지는 DB를 직접 호출하지 않고 Application Service만 호출합니다.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  AcademicCompletionError,
  COMPLETION_REASON_NOTICE,
  COMPLETION_STATUS_LABELS,
  CRITERIA_STATUS_LABELS,
  type CompletionCriteria,
  type CompletionSnapshot,
} from "@/features/academics/completion/contracts";
import {
  getCompletionRoster,
  isAcademicCompletionEnabled,
  listCompletionCohorts,
} from "@/features/academics/completion/service";
import { getWebCompletionPrincipal } from "@/features/academics/completion/web-principal";
import { formatKstDateTime } from "@/lib/date-time";
import { logServerError } from "@/lib/errors";
import {
  CreateCriteriaForm,
  DecisionForm,
  PublishCriteriaForm,
  UpdateCriteriaForm,
} from "./_components/completion-forms";

export const metadata: Metadata = { title: "수료 심사" };
export const dynamic = "force-dynamic";

const PATH = "/member/academic-operations/completion";

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <section className="mx-auto max-w-6xl space-y-10 px-4 py-12 text-[#1a1a1a]">
      <h1 className="text-3xl font-bold">수료 심사</h1>
      {children}
      <Link href="/mypage" className="inline-block underline">
        마이페이지로 돌아가기
      </Link>
    </section>
  );
}

/** 관리자 지정이 없거나 기능이 꺼져 있으면 404, 로그인 필요는 로그인 이동, 그 밖은 오류 안내로 바꿉니다. */
function handleAccessError(error: unknown): string {
  if (error instanceof AcademicCompletionError) {
    if (error.code === "DISABLED" || error.code === "FORBIDDEN") notFound();
    if (error.code === "UNAUTHENTICATED")
      redirect(`/login?callbackUrl=${encodeURIComponent(PATH)}`);
    return error.message;
  }
  logServerError("academic-completion/operations-page", error);
  return "정보를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.";
}

/** 기준 내용을 한 줄 설명으로 바꿉니다. */
function describeCriteria(criteria: CompletionCriteria): string {
  const counted = [
    criteria.countLateAsAttended ? "지각" : null,
    criteria.countExcusedAsAttended ? "인정결석" : null,
  ].filter(Boolean);
  return `최소 출석률 ${criteria.minAttendancePercent}%${
    counted.length > 0 ? `(${counted.join("·")} 포함)` : ""
  } · 과제 제출 ${criteria.requiredSubmissionCount}건 이상`;
}

/** 보조 지표의 충족 여부 표시. 시작된 수업이 없거나 미입력 출결이 있으면 판단 보류입니다. */
function metLabel(met: boolean | null): string {
  if (met === null) return "판단 보류(수업 없음 또는 미입력 있음)";
  return met ? "기준 충족" : "기준 미달";
}

function SnapshotSummary({ snapshot }: { snapshot: CompletionSnapshot }) {
  const { attendance, submissions } = snapshot;
  return (
    <dl className="space-y-1 text-sm">
      <div>
        <dt className="inline font-medium">출결: </dt>
        <dd className="inline">
          수업 {attendance.classCount}회 중 출석 {attendance.presentCount}·지각{" "}
          {attendance.lateCount}
          ·결석 {attendance.absentCount}·인정결석 {attendance.excusedCount}·미입력{" "}
          {attendance.unmarkedCount} / 출석률{" "}
          {attendance.attendancePercent === null ? "-" : `${attendance.attendancePercent}%`}(기준{" "}
          {attendance.minAttendancePercent}%) · {metLabel(attendance.met)}
        </dd>
      </div>
      <div>
        <dt className="inline font-medium">과제: </dt>
        <dd className="inline">
          대상 {submissions.assignedCount}건 중 제출 {submissions.submittedCount}건(기준{" "}
          {submissions.requiredCount}건) · {metLabel(submissions.met)}
        </dd>
      </div>
    </dl>
  );
}

export default async function CompletionReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ cohort?: string; version?: string }>;
}) {
  if (!isAcademicCompletionEnabled()) notFound();
  const principal = await getWebCompletionPrincipal();
  if (!principal) redirect(`/login?callbackUrl=${encodeURIComponent(PATH)}`);
  const params = await searchParams;

  let cohorts;
  try {
    cohorts = await listCompletionCohorts(principal);
  } catch (error) {
    return (
      <Shell>
        <p role="alert">{handleAccessError(error)}</p>
      </Shell>
    );
  }

  // 선택한 기수가 있을 때만 명부를 읽습니다. 잘못된 식별자는 서비스가 입력 오류·없음으로 거부합니다.
  let roster = null;
  let rosterError: string | null = null;
  if (params.cohort) {
    try {
      roster = await getCompletionRoster(principal, {
        cohortId: params.cohort,
        criteriaVersionId: params.version || undefined,
      });
    } catch (error) {
      rosterError = handleAccessError(error);
    }
  }
  const selected = roster?.criteriaVersions.find(
    (version) => version.id === roster?.selectedCriteriaVersionId,
  );
  const draft = roster?.criteriaVersions.find((version) => version.status === "DRAFT");

  return (
    <Shell>
      <p className="text-[#666666]">
        기수별 수료 기준을 버전으로 관리하고, 출결·과제 보조 지표를 참고해 학생별 수료를 직접
        기록합니다. 시스템은 수료를 자동으로 결정하지 않으며, 공개한 기준과 기록한 결정은 바꾸지
        않고 새 버전·새 결정으로 이어 갑니다. 본인 학적은 결정할 수 없습니다. 시각은 한국시간입니다.
      </p>
      <p className="rounded-xl border border-[#D9D9D9] p-4 text-sm">{COMPLETION_REASON_NOTICE}</p>

      <nav aria-label="기수 선택" className="space-y-2">
        <h2 className="text-2xl font-semibold">기수</h2>
        {cohorts.length === 0 ? (
          <p>등록된 기수가 없습니다.</p>
        ) : (
          <ul className="flex flex-wrap gap-3">
            {cohorts.map((cohort) => (
              <li key={cohort.id}>
                <Link
                  href={`?cohort=${cohort.id}`}
                  aria-current={cohort.id === params.cohort ? "page" : undefined}
                  className="text-[#2563EB] underline"
                >
                  {cohort.name}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </nav>

      {rosterError && <p role="alert">{rosterError}</p>}
      {roster && (
        <>
          <section aria-labelledby="criteria-versions" className="space-y-4">
            <h2 id="criteria-versions" className="text-2xl font-semibold">
              {roster.cohortName} 수료 기준
            </h2>
            {roster.criteriaVersions.length === 0 && <p>아직 만든 수료 기준이 없습니다.</p>}
            <ul className="space-y-3">
              {roster.criteriaVersions.map((version) => (
                <li
                  key={version.id}
                  className="space-y-2 rounded-xl border border-[#D9D9D9] p-4 shadow-[var(--shadow-soft)]"
                >
                  <h3 className="text-lg font-semibold">
                    {version.version}판 · {CRITERIA_STATUS_LABELS[version.status]}
                    {version.id === roster.selectedCriteriaVersionId && " · 심사 기준으로 보는 중"}
                  </h3>
                  <p>{describeCriteria(version.criteria)}</p>
                  {version.criteria.notes && (
                    <p className="text-sm text-[#666666]">비고: {version.criteria.notes}</p>
                  )}
                  <p className="text-sm text-[#666666]">
                    사유: {version.changeReason} ·{" "}
                    {version.publishedAt
                      ? `공개 ${formatKstDateTime(new Date(version.publishedAt))}`
                      : `수정 ${formatKstDateTime(new Date(version.updatedAt))}`}
                  </p>
                  {version.id !== roster.selectedCriteriaVersionId && (
                    <Link
                      href={`?cohort=${roster.cohortId}&version=${version.id}`}
                      className="text-sm text-[#2563EB] underline"
                    >
                      이 기준으로 보조 지표 보기
                    </Link>
                  )}
                  {version.status === "DRAFT" && (
                    <div className="space-y-4 border-t border-[#D9D9D9] pt-3">
                      <UpdateCriteriaForm
                        criteriaVersionId={version.id}
                        defaults={version.criteria}
                      />
                      <PublishCriteriaForm
                        criteriaVersionId={version.id}
                        version={version.version}
                      />
                    </div>
                  )}
                </li>
              ))}
            </ul>
            {!draft && (
              <div className="space-y-2 rounded-xl border border-[#D9D9D9] p-4">
                <h3 className="text-lg font-semibold">새 기준 버전 만들기</h3>
                <CreateCriteriaForm cohortId={roster.cohortId} />
              </div>
            )}
          </section>

          <section aria-labelledby="completion-roster" className="space-y-4">
            <h2 id="completion-roster" className="text-2xl font-semibold">
              학생별 수료 심사
            </h2>
            {!selected && <p>공개된 수료 기준이 없어 보조 지표를 계산할 수 없습니다.</p>}
            {selected?.status === "DRAFT" && (
              <p className="text-sm text-[#666666]">
                초안 기준으로 본 보조 지표입니다. 수료 결정은 공개된 기준으로만 기록할 수 있습니다.
              </p>
            )}
            {roster.entries.length === 0 && <p>이 기수에 등록된 학생이 없습니다.</p>}
            <ul className="space-y-4">
              {roster.entries.map((entry) => (
                <li
                  key={entry.enrollmentId}
                  className="space-y-3 rounded-xl border border-[#D9D9D9] p-4 shadow-[var(--shadow-soft)]"
                >
                  <h3 className="text-lg font-semibold">
                    {entry.displayName} · {COMPLETION_STATUS_LABELS[entry.status]}
                  </h3>
                  {entry.snapshot && <SnapshotSummary snapshot={entry.snapshot} />}
                  {entry.history.length > 0 && (
                    <details>
                      <summary className="cursor-pointer text-sm">
                        결정 이력 {entry.history.length}건
                      </summary>
                      <ol className="mt-2 space-y-1 text-sm">
                        {entry.history.map((item) => (
                          <li key={item.id}>
                            {item.sequence}. {COMPLETION_STATUS_LABELS[item.decision]} ·{" "}
                            {item.criteriaVersion}판 기준 ·{" "}
                            {formatKstDateTime(new Date(item.decidedAt))} · 사유: {item.reason}
                          </li>
                        ))}
                      </ol>
                    </details>
                  )}
                  {selected?.status === "PUBLISHED" && (
                    <DecisionForm
                      enrollmentId={entry.enrollmentId}
                      displayName={entry.displayName}
                      criteriaVersionId={selected.id}
                      criteriaVersion={selected.version}
                      currentStatus={entry.status}
                      currentSequence={entry.currentSequence}
                    />
                  )}
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </Shell>
  );
}
