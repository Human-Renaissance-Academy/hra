/**
 * #162 지정 교수 검토자가 담당 과제의 최종 제출 파일을 같은 출처의 인증된 첨부 다운로드로 받습니다.
 * 인가(can_review_assignment 재판정·자기 제출물 거부)와 열람 감사는 SQL 함수 한 번으로 확정하고,
 * 전달·응답 헤더는 G1 제출 파일 경로(`/api/academic/submissions/.../file/...`)와 같습니다.
 * 동적 경로의 두 ID 외에 URL·저장 키·기수·사용자 입력은 사용하지 않습니다.
 */
import { downloadReviewerSubmissionFile } from "@/features/academics/assignment-reviews/service";
import { getWebAcademicPrincipal } from "@/features/academics/staff/web-principal";
import type { SubmissionFileParams } from "@/features/academics/submission-files/service";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _request: Request,
  { params }: { params: Promise<SubmissionFileParams> },
): Promise<Response> {
  return downloadReviewerSubmissionFile(await getWebAcademicPrincipal(), params);
}
