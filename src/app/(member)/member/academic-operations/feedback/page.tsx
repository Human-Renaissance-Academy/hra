/**
 * #162 학사 운영 관리자의 과제 피드백 학생 공개 화면입니다(정책 초안 P12).
 *
 * - 접근: DB의 유효한 학사 운영 관리자 지정이 있는 계정만. 홈페이지 `ADMIN` 역할만으로는 열리지 않습니다.
 *   (#160 학사 운영 관리 화면과 같은 회원 영역 `/member/academic-operations` 아래에 둡니다.)
 * - 기능 플래그가 꺼져 있거나 관리자 지정이 없으면 404입니다.
 * - 검토자가 제출한 피드백의 오기·민감 표현을 확인한 뒤 공개하거나, 공개한 피드백을 사유와 함께 취소합니다.
 *   관리자 본인이 작성했거나 본인 제출물인 피드백은 공개할 수 없습니다(DB가 다시 거부).
 * - 페이지는 DB를 직접 호출하지 않고 Application Service만 호출합니다.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  AssignmentReviewError,
  REVIEW_VISIBILITY_LABELS,
} from "@/features/academics/assignment-reviews/contracts";
import {
  isAssignmentReviewEnabled,
  listFeedbackForPublication,
} from "@/features/academics/assignment-reviews/service";
import { getWebAcademicPrincipal } from "@/features/academics/staff/web-principal";
import { formatKstDateTime } from "@/lib/date-time";
import { logServerError } from "@/lib/errors";
import { PublishFeedbackForm, RetractFeedbackForm } from "./_components/publication-forms";

export const metadata: Metadata = { title: "과제 피드백 공개" };
export const dynamic = "force-dynamic";

const PATH = "/member/academic-operations/feedback";

export default async function FeedbackPublicationPage() {
  if (!isAssignmentReviewEnabled()) notFound();
  const principal = await getWebAcademicPrincipal();
  if (!principal) redirect(`/login?callbackUrl=${encodeURIComponent(PATH)}`);

  let items;
  try {
    items = await listFeedbackForPublication(principal);
  } catch (error) {
    if (
      error instanceof AssignmentReviewError &&
      (error.code === "DISABLED" || error.code === "FORBIDDEN" || error.code === "NOT_FOUND")
    )
      notFound();
    if (!(error instanceof AssignmentReviewError))
      logServerError("assignment-review/publication-page", error);
    return (
      <section className="mx-auto max-w-5xl space-y-4 px-4 py-12 text-[#1a1a1a]">
        <h1 className="text-3xl font-bold">과제 피드백 공개</h1>
        <p role="alert">피드백 목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</p>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-5xl space-y-6 px-4 py-12 text-[#1a1a1a]">
      <h1 className="text-3xl font-bold">과제 피드백 공개</h1>
      <p className="text-[#666666]">
        교수 검토자가 제출한 피드백을 확인하고 학생 본인에게 공개합니다. 공개와 공개 취소는 모두
        이력에 남고, 공개 취소 사유는 다시 표시하지 않습니다. 사유에 개인정보를 적지 마세요. 시각은
        한국시간입니다.
      </p>
      {items.length === 0 && <p>공개를 기다리는 피드백이 없습니다.</p>}
      <ul className="space-y-6">
        {items.map((item) => (
          <li
            key={item.reviewId}
            className="space-y-3 rounded-xl border border-[#D9D9D9] p-5 shadow-[var(--shadow-soft)]"
          >
            <h2 className="break-words text-xl font-semibold">
              {item.assignmentTitle} · {item.studentDisplayName}
            </h2>
            <p className="text-sm text-[#666666]">
              {REVIEW_VISIBILITY_LABELS[item.visibility]} · 제출{" "}
              {formatKstDateTime(new Date(item.submittedAt))}
              {item.publishedAt &&
                ` · 공개 ${formatKstDateTime(new Date(item.publishedAt))}`} · {item.version}판
            </p>
            <p className="whitespace-pre-wrap break-words rounded border border-[#D9D9D9] p-3">
              {item.body}
            </p>
            {item.gradeLabel && <p>평가 표기: {item.gradeLabel}</p>}
            {item.selfRelated ? (
              <p className="text-sm">
                본인이 작성했거나 본인 제출물인 피드백은 다른 관리자가 처리해야 합니다.
              </p>
            ) : item.visibility === "PRIVATE" ? (
              <PublishFeedbackForm reviewId={item.reviewId} version={item.version} />
            ) : (
              <RetractFeedbackForm reviewId={item.reviewId} version={item.version} />
            )}
          </li>
        ))}
      </ul>
      <Link href="/mypage" className="inline-block underline">
        마이페이지로 돌아가기
      </Link>
    </section>
  );
}
