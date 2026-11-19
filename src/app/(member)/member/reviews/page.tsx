/**
 * #162 지정 교수 검토자의 검토 과제 목록입니다.
 *
 * - 접근: 학사 운영 관리자가 교수 프로필과 계정을 연결하고 수업 검토자로 지정한 계정만 과제가 보입니다(#161 판정).
 *   홈페이지 `ADMIN`·`FACULTY` 역할만으로는 빈 목록입니다. 출결 화면·권한과 무관합니다.
 * - 기능 플래그(`ACADEMIC_ENABLED`·`ACADEMIC_FACULTY_REVIEW_ENABLED`·`ACADEMIC_ASSIGNMENT_REVIEW_ENABLED`)가 꺼져 있으면 404입니다.
 * - 페이지는 DB를 직접 호출하지 않고 Application Service만 호출합니다. 과제 메타데이터만 표시합니다.
 */
import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { isAssignmentReviewEnabled } from "@/features/academics/assignment-reviews/service";
import { FacultyReviewError } from "@/features/academics/faculty-review/contracts";
import { listReviewableAssignments } from "@/features/academics/faculty-review/service";
import { getWebAcademicPrincipal } from "@/features/academics/staff/web-principal";
import { formatKstDateTime } from "@/lib/date-time";
import { logServerError } from "@/lib/errors";

export const metadata: Metadata = { title: "과제 검토" };
export const dynamic = "force-dynamic";

const PATH = "/member/reviews";

export default async function ReviewAssignmentsPage() {
  if (!isAssignmentReviewEnabled()) notFound();
  const principal = await getWebAcademicPrincipal();
  if (!principal) redirect(`/login?callbackUrl=${encodeURIComponent(PATH)}`);

  let assignments;
  try {
    assignments = await listReviewableAssignments(principal);
  } catch (error) {
    if (error instanceof FacultyReviewError && error.code === "DISABLED") notFound();
    if (!(error instanceof FacultyReviewError))
      logServerError("assignment-review/list-page", error);
    return (
      <section className="mx-auto max-w-4xl space-y-4 px-4 py-12 text-[#1a1a1a]">
        <h1 className="text-3xl font-bold">과제 검토</h1>
        <p role="alert">과제 목록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</p>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-4xl space-y-6 px-4 py-12 text-[#1a1a1a]">
      <h1 className="text-3xl font-bold">과제 검토</h1>
      <p className="text-[#666666]">
        검토자로 지정된 수업의 공개 과제만 표시됩니다. 작성한 피드백은 학사 운영 관리자가 확인한 뒤
        학생에게 공개합니다. 시각은 한국시간입니다.
      </p>
      {assignments.length === 0 && <p>지금 검토할 수 있는 과제가 없습니다.</p>}
      <ul className="space-y-4">
        {assignments.map((assignment) => (
          <li
            key={assignment.assignmentId}
            className="rounded-xl border border-[#D9D9D9] p-5 shadow-[var(--shadow-soft)]"
          >
            <h2 className="break-words text-xl font-semibold">
              <Link
                className="text-[#2563EB] underline"
                href={`${PATH}/${assignment.assignmentId}`}
              >
                {assignment.title}
              </Link>
            </h2>
            <p className="mt-2 text-[#666666]">
              {assignment.status === "CLOSED" ? "마감됨" : "진행 중"}
              {assignment.dueAt && ` · 마감 ${formatKstDateTime(new Date(assignment.dueAt))}`}
            </p>
          </li>
        ))}
      </ul>
      <Link href="/mypage" className="inline-block underline">
        마이페이지로 돌아가기
      </Link>
    </section>
  );
}
