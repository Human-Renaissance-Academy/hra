/**
 * #163 학생 본인 수료 상태 화면입니다.
 *
 * - 로그인 계정에 연결된 본인 학적의 현재 수료 상태(심사 전·수료·미수료·수료 취소)와 확정 시각·적용 기준 버전만 보여 줍니다.
 *   결정 사유·결정자·보조 지표와 다른 학생의 기록은 서비스가 내보내지 않습니다.
 * - 기능 플래그 `ACADEMIC_ENABLED`·`ACADEMIC_STAFF_ENABLED`·`ACADEMIC_COMPLETION_ENABLED`가 꺼져 있으면 404입니다.
 * - 페이지는 DB를 직접 호출하지 않고 Application Service만 호출합니다.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  AcademicCompletionError,
  COMPLETION_STATUS_LABELS,
} from "@/features/academics/completion/contracts";
import {
  isAcademicCompletionEnabled,
  listOwnCompletion,
} from "@/features/academics/completion/service";
import { getWebCompletionPrincipal } from "@/features/academics/completion/web-principal";
import { formatKstDateTime } from "@/lib/date-time";
import { logServerError } from "@/lib/errors";

export const metadata: Metadata = { title: "내 수료 상태" };
export const dynamic = "force-dynamic";

const PATH = "/member/completion";

export default async function MyCompletionPage() {
  if (!isAcademicCompletionEnabled()) notFound();
  const principal = await getWebCompletionPrincipal();
  if (!principal) redirect(`/login?callbackUrl=${encodeURIComponent(PATH)}`);

  let entries;
  let failure: string | null = null;
  try {
    entries = await listOwnCompletion(principal);
  } catch (error) {
    if (error instanceof AcademicCompletionError) {
      if (error.code === "DISABLED") notFound();
      if (error.code === "UNAUTHENTICATED")
        redirect(`/login?callbackUrl=${encodeURIComponent(PATH)}`);
      failure = error.message;
    } else {
      logServerError("academic-completion/own-page", error);
      failure = "수료 상태를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.";
    }
  }

  return (
    <section className="mx-auto max-w-4xl space-y-6 px-4 py-12 text-[#1a1a1a]">
      <h1 className="text-3xl font-bold">내 수료 상태</h1>
      <p className="text-[#666666]">
        학사 운영 담당자가 공개된 수료 기준에 따라 확정한 본인 수료 상태입니다. 이의가 있으면 운영
        담당자에게 문의해 주세요. 시각은 한국시간입니다.
      </p>
      {failure && <p role="alert">{failure}</p>}
      {entries && entries.length === 0 && (
        <p>현재 계정에 연결된 학생 학적이 없습니다. 운영 담당자에게 계정 연결을 문의해 주세요.</p>
      )}
      {entries && entries.length > 0 && (
        <ul className="space-y-4">
          {entries.map((entry) => (
            <li
              key={entry.enrollmentId}
              className="rounded-xl border border-[#D9D9D9] p-5 shadow-[var(--shadow-soft)]"
            >
              <h2 className="text-xl font-semibold">{entry.cohortName}</h2>
              <p className="mt-2">상태: {COMPLETION_STATUS_LABELS[entry.status]}</p>
              {entry.decidedAt && (
                <p className="text-sm text-[#666666]">
                  확정 {formatKstDateTime(new Date(entry.decidedAt))}
                  {entry.criteriaVersion !== null && ` · ${entry.criteriaVersion}판 기준`}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}
      <Link href="/mypage" className="inline-block underline">
        마이페이지로 돌아가기
      </Link>
    </section>
  );
}
