"use server";
/**
 * #163 학사 운영 관리자의 수료 기준 작성·수정·공개와 수료 결정 Server Action입니다.
 *
 * - 사용 위치: `/member/academic-operations/completion` 화면의 폼(useActionState).
 * - 책임: FormData → 서비스 입력 변환, Web 세션 → 요청 주체, Application Service 호출, 화면 재검증만 합니다.
 *   관리자 지정·공개 후 불변·자기 결정 금지·순번 경합·감사 기록은 서비스와 DB 함수가 매 호출 다시 판정합니다.
 * - 홈페이지 `ADMIN` 역할은 어떤 판정에도 쓰지 않습니다. 오류는 고정 한국어 문구만 돌려줍니다.
 */
import { revalidatePath } from "next/cache";
import { logServerError } from "@/lib/errors";
import { AcademicCompletionError } from "./contracts";
import {
  createCriteriaDraft,
  publishCriteria,
  recordCompletionDecision,
  updateCriteriaDraft,
} from "./service";
import { getWebCompletionPrincipal } from "./web-principal";

// 수료 심사 화면 경로. 성공 시 기준·명부를 다시 읽습니다. 학생 본인 화면도 결정 뒤 다시 읽습니다.
const COMPLETION_PATH = "/member/academic-operations/completion";
const OWN_PATH = "/member/completion";

export type CompletionActionState = {
  status: "idle" | "success" | "error";
  message?: string;
  code?: string;
};

/** 비어 있는 필드는 생략(undefined)으로 바꿉니다. 형식 검증은 서비스의 zod 스키마가 합니다. */
function field(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** 숫자 입력은 정수 문자열일 때만 숫자로 바꾸고, 그 밖의 값은 그대로 넘겨 서비스가 거부합니다. */
function integer(formData: FormData, key: string): number | string | undefined {
  const value = field(formData, key);
  return value !== undefined && /^\d{1,10}$/.test(value) ? Number(value) : value;
}

/** 기준 폼의 값을 기준 내용 객체로 바꿉니다. 체크박스는 체크되었을 때만 "on"입니다. */
function criteriaFrom(formData: FormData) {
  return {
    minAttendancePercent: integer(formData, "minAttendancePercent"),
    countLateAsAttended: formData.get("countLateAsAttended") === "on",
    countExcusedAsAttended: formData.get("countExcusedAsAttended") === "on",
    requiredSubmissionCount: integer(formData, "requiredSubmissionCount"),
    notes: field(formData, "notes"),
  };
}

/** 서비스의 고정 오류는 그대로, 예상하지 못한 오류는 기록 후 일반 문구로 바꿉니다. */
function failure(scope: string, error: unknown): CompletionActionState {
  if (error instanceof AcademicCompletionError) {
    return { status: "error", code: error.code, message: error.message };
  }
  logServerError(scope, error);
  return { status: "error", code: "UNAVAILABLE", message: "잠시 후 다시 시도해 주세요." };
}

/** 기수의 새 수료 기준 초안을 만듭니다. */
export async function createCriteriaAction(
  _previous: CompletionActionState,
  formData: FormData,
): Promise<CompletionActionState> {
  try {
    const principal = await getWebCompletionPrincipal();
    await createCriteriaDraft(principal, {
      requestId: field(formData, "requestId"),
      cohortId: field(formData, "cohortId"),
      criteria: criteriaFrom(formData),
      reason: field(formData, "reason"),
    });
  } catch (error) {
    return failure("academic-completion/create-criteria", error);
  }
  revalidatePath(COMPLETION_PATH);
  return { status: "success", message: "수료 기준 초안을 만들었습니다." };
}

/** 수료 기준 초안을 고칩니다. 공개된 기준은 서버가 거부합니다. */
export async function updateCriteriaAction(
  _previous: CompletionActionState,
  formData: FormData,
): Promise<CompletionActionState> {
  try {
    const principal = await getWebCompletionPrincipal();
    await updateCriteriaDraft(principal, {
      requestId: field(formData, "requestId"),
      criteriaVersionId: field(formData, "criteriaVersionId"),
      criteria: criteriaFrom(formData),
      reason: field(formData, "reason"),
    });
  } catch (error) {
    return failure("academic-completion/update-criteria", error);
  }
  revalidatePath(COMPLETION_PATH);
  return { status: "success", message: "수료 기준 초안을 고쳤습니다." };
}

/** 수료 기준 초안을 공개합니다. 공개 후에는 내용을 바꿀 수 없습니다. */
export async function publishCriteriaAction(
  _previous: CompletionActionState,
  formData: FormData,
): Promise<CompletionActionState> {
  try {
    const principal = await getWebCompletionPrincipal();
    await publishCriteria(principal, {
      requestId: field(formData, "requestId"),
      criteriaVersionId: field(formData, "criteriaVersionId"),
    });
  } catch (error) {
    return failure("academic-completion/publish-criteria", error);
  }
  revalidatePath(COMPLETION_PATH);
  return { status: "success", message: "수료 기준을 공개했습니다." };
}

/** 수료·미수료·수료 취소를 사유와 함께 기록합니다. 사유는 응답에 다시 싣지 않습니다. */
export async function recordDecisionAction(
  _previous: CompletionActionState,
  formData: FormData,
): Promise<CompletionActionState> {
  try {
    const principal = await getWebCompletionPrincipal();
    await recordCompletionDecision(principal, {
      requestId: field(formData, "requestId"),
      enrollmentId: field(formData, "enrollmentId"),
      criteriaVersionId: field(formData, "criteriaVersionId"),
      decision: field(formData, "decision"),
      reason: field(formData, "reason"),
      expectedSequence: integer(formData, "expectedSequence"),
    });
  } catch (error) {
    return failure("academic-completion/record-decision", error);
  }
  revalidatePath(COMPLETION_PATH);
  revalidatePath(OWN_PATH);
  return { status: "success", message: "수료 결정을 기록했습니다." };
}
