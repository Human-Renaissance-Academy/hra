/**
 * #162 지정 교수 검토자의 과제별 제출물 검토 화면입니다(제출 파일 다운로드·피드백 초안 저장·제출).
 *
 * - 접근: #161 검토 권한 판정이 참인 과제만. 권한이 없거나 과제가 없으면 같은 404로 응답합니다(정책 초안 P11).
 * - 본인 제출물은 목록에서 제외되고 저장·열람도 DB가 거부합니다(자기 검토 금지).
 * - 파일 다운로드는 `/api/academic/reviews/submissions/[id]/file/[fileId]`로만 하며 매 요청 권한 재판정과 감사를 남깁니다.
 * - 피드백은 제출해도 바로 공개되지 않고 학사 운영 관리자가 공개합니다. 학생 계정 식별자·저장 키는 표시하지 않습니다.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import {
  AssignmentReviewError,
  REVIEW_STATUS_LABELS,
  REVIEW_VISIBILITY_LABELS,
} from "@/features/academics/assignment-reviews/contracts";
import {
  isAssignmentReviewEnabled,
  listReviewSubmissions,
} from "@/features/academics/assignment-reviews/service";
import { FacultyReviewError } from "@/features/academics/faculty-review/contracts";
import { listReviewableAssignments } from "@/features/academics/faculty-review/service";
import { getWebAcademicPrincipal } from "@/features/academics/staff/web-principal";
import { formatKstDateTime } from "@/lib/date-time";
import { logServerError } from "@/lib/errors";
import { ReviewForm, SubmitReviewForm } from "./_components/review-forms";

export const metadata: Metadata = { title: "제출물 검토" };
export const dynamic = "force-dynamic";

export default async function ReviewSubmissionsPage({
  params,
}: {
  params: Promise<{ assignmentId: string }>;
}) {
  const { assignmentId } = await params;
  if (!isAssignmentReviewEnabled()) notFound();
  const principal = await getWebAcademicPrincipal();
  if (!principal) redirect(`/login?callbackUrl=${encodeURIComponent("/member/reviews")}`);

  let assignment;
  let submissions;
  try {
    // 과제 메타데이터도 같은 판정(can_review_assignment)을 거친 목록에서만 찾습니다.
    assignment = (await listReviewableAssignments(principal)).find(
      (item) => item.assignmentId === assignmentId,
    );
    submissions = assignment ? await listReviewSubmissions(principal, assignmentId) : [];
  } catch (error) {
    const known = error instanceof AssignmentReviewError || error instanceof FacultyReviewError;
    if (known && (error.code === "DISABLED" || error.code === "INVALID_INPUT")) notFound();
    if (!known) logServerError("assignment-review/submissions-page", error);
    return (
      <section className="mx-auto max-w-4xl space-y-4 px-4 py-12 text-[#1a1a1a]">
        <h1 className="text-3xl font-bold">제출물 검토</h1>
        <p role="alert">제출물을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</p>
        <Link href="/member/reviews" className="underline">
          검토 과제 목록
        </Link>
      </section>
    );
  }
  // 담당하지 않은 과제와 없는 과제는 같은 404입니다.
  if (!assignment) notFound();

  return (
    <article className="mx-auto max-w-4xl space-y-6 px-4 py-12 text-[#1a1a1a]">
      <Link href="/member/reviews" className="text-[#2563EB] underline">
        검토 과제 목록
      </Link>
      <h1 className="break-words text-3xl font-bold">{assignment.title}</h1>
      <p className="text-[#666666]">
        제출 파일은 검토 목적으로만 내려받고 외부에 공유하지 마세요. 다운로드할 때마다 열람 기록이
        남습니다. 숫자 점수나 순위는 기록하지 않으며, 평가 표기는 필요한 경우에만 짧게 적습니다.
      </p>
      {submissions.length === 0 && <p>아직 검토할 제출물이 없습니다.</p>}
      <ul className="space-y-6">
        {submissions.map((submission) => (
          <li
            key={submission.submissionId}
            className="space-y-3 rounded-xl border border-[#D9D9D9] p-5 shadow-[var(--shadow-soft)]"
          >
            <h2 className="text-xl font-semibold">{submission.studentDisplayName}</h2>
            <p className="text-[#666666]">
              제출 {formatKstDateTime(new Date(submission.submittedAt))}
            </p>
            {submission.fileId && (
              <a
                className="inline-block text-[#2563EB] underline"
                href={`/api/academic/reviews/submissions/${submission.submissionId}/file/${submission.fileId}`}
              >
                제출 파일 내려받기
              </a>
            )}
            {submission.review && (
              <p className="text-sm">
                내 피드백: {REVIEW_STATUS_LABELS[submission.review.status]} ·{" "}
                {REVIEW_VISIBILITY_LABELS[submission.review.visibility]} ·{" "}
                {submission.review.version}판
              </p>
            )}
            {submission.review?.visibility === "PUBLISHED_TO_STUDENT" ? (
              <p className="whitespace-pre-wrap break-words rounded border border-[#D9D9D9] p-3">
                {submission.review.body}
              </p>
            ) : (
              <ReviewForm
                assignmentId={assignmentId}
                submissionId={submission.submissionId}
                version={submission.review?.version ?? 0}
                body={submission.review?.body ?? ""}
                gradeLabel={submission.review?.gradeLabel ?? ""}
                requiresReason={submission.review?.status === "SUBMITTED"}
              />
            )}
            {submission.review?.status === "DRAFT" && (
              <SubmitReviewForm
                assignmentId={assignmentId}
                reviewId={submission.review.id}
                version={submission.review.version}
              />
            )}
          </li>
        ))}
      </ul>
    </article>
  );
}
