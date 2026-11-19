"use server";
/**
 * #162 과제 검토·피드백 Server Action입니다.
 *
 * - 사용 위치: `/member/reviews/[assignmentId]`(검토자 초안 저장·제출), `/member/academic-operations/feedback`
 *   (학사 운영 관리자 공개·공개 취소)의 폼(useActionState).
 * - 책임: FormData → 서비스 입력 변환, Web 세션 → 요청 주체, Application Service 호출, 화면 재검증만 합니다.
 *   검토 권한·자기 검토 금지·버전 충돌·관리자 지정은 서비스와 DB 함수가 매 호출 다시 판정합니다.
 * - 오류는 고정 한국어 문구만 돌려줍니다.
 */
import { revalidatePath } from "next/cache";
import { logServerError } from "@/lib/errors";
import { getWebAcademicPrincipal } from "@/features/academics/staff/web-principal";
import { AssignmentReviewError } from "./contracts";
import {
  publishAssignmentFeedback,
  retractAssignmentFeedback,
  saveAssignmentReview,
  submitAssignmentReview,
} from "./service";

export type ReviewActionState = {
  status: "idle" | "success" | "error";
  message?: string;
  code?: string;
};

// 공개 처리 화면 경로입니다.
const PUBLICATION_PATH = "/member/academic-operations/feedback";

/** 비어 있는 필드는 생략(undefined)으로 바꿉니다. 형식 검증은 서비스의 zod 스키마가 합니다. */
function field(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** 검토 화면 재검증 경로입니다. 과제 ID 형식이 아니면 목록만 다시 읽습니다. */
function reviewPath(formData: FormData): string {
  const assignmentId = field(formData, "assignmentId");
  return assignmentId && /^[0-9a-f-]{36}$/i.test(assignmentId)
    ? `/member/reviews/${assignmentId}`
    : "/member/reviews";
}

/** 서비스의 고정 오류는 그대로, 예상하지 못한 오류는 기록 후 일반 문구로 바꿉니다. */
function failure(scope: string, error: unknown): ReviewActionState {
  if (error instanceof AssignmentReviewError) {
    return { status: "error", code: error.code, message: error.message };
  }
  logServerError(scope, error);
  return { status: "error", code: "UNAVAILABLE", message: "잠시 후 다시 시도해 주세요." };
}

/** 검토자의 피드백 초안 저장(신규·수정)입니다. */
export async function saveReviewAction(
  _previous: ReviewActionState,
  formData: FormData,
): Promise<ReviewActionState> {
  try {
    const principal = await getWebAcademicPrincipal();
    await saveAssignmentReview(principal, {
      submissionId: field(formData, "submissionId"),
      expectedVersion: field(formData, "expectedVersion"),
      body: field(formData, "body"),
      gradeLabel: field(formData, "gradeLabel"),
      reason: field(formData, "reason"),
    });
  } catch (error) {
    return failure("assignment-review/save", error);
  }
  revalidatePath(reviewPath(formData));
  return { status: "success", message: "피드백 초안을 저장했습니다." };
}

/** 검토자의 피드백 제출입니다. 제출해도 학생에게 바로 공개되지 않습니다. */
export async function submitReviewAction(
  _previous: ReviewActionState,
  formData: FormData,
): Promise<ReviewActionState> {
  try {
    const principal = await getWebAcademicPrincipal();
    await submitAssignmentReview(principal, {
      reviewId: field(formData, "reviewId"),
      expectedVersion: field(formData, "expectedVersion"),
    });
  } catch (error) {
    return failure("assignment-review/submit", error);
  }
  revalidatePath(reviewPath(formData));
  return {
    status: "success",
    message: "피드백을 제출했습니다. 학사 운영 관리자가 확인 후 학생에게 공개합니다.",
  };
}

/** 학사 운영 관리자의 학생 공개입니다. */
export async function publishFeedbackAction(
  _previous: ReviewActionState,
  formData: FormData,
): Promise<ReviewActionState> {
  try {
    const principal = await getWebAcademicPrincipal();
    await publishAssignmentFeedback(principal, {
      reviewId: field(formData, "reviewId"),
      expectedVersion: field(formData, "expectedVersion"),
    });
  } catch (error) {
    return failure("assignment-review/publish", error);
  }
  revalidatePath(PUBLICATION_PATH);
  return { status: "success", message: "피드백을 학생에게 공개했습니다." };
}

/** 학사 운영 관리자의 공개 취소입니다. 사유는 필수이며 화면에 다시 표시하지 않습니다. */
export async function retractFeedbackAction(
  _previous: ReviewActionState,
  formData: FormData,
): Promise<ReviewActionState> {
  try {
    const principal = await getWebAcademicPrincipal();
    await retractAssignmentFeedback(principal, {
      reviewId: field(formData, "reviewId"),
      expectedVersion: field(formData, "expectedVersion"),
      reason: field(formData, "reason"),
    });
  } catch (error) {
    return failure("assignment-review/retract", error);
  }
  revalidatePath(PUBLICATION_PATH);
  return { status: "success", message: "피드백 공개를 취소했습니다." };
}
