"use server";
/**
 * #160 학사 운영 관리자의 기수 운영 인력 배정·종료·교체 Server Action입니다.
 *
 * - 사용 위치: `/member/academic-operations` 화면의 폼(useActionState).
 * - 책임: FormData → 서비스 입력 변환, Web 세션 → 요청 주체, Application Service 호출, 화면 재검증만 합니다.
 *   관리자 지정 여부·자기 배정 금지·상한·기간 중복·감사 기록은 서비스와 DB 함수가 매 호출 다시 판정합니다.
 * - 홈페이지 `ADMIN` 역할은 어떤 판정에도 쓰지 않습니다. 오류는 고정 한국어 문구만 돌려줍니다.
 */
import { revalidatePath } from "next/cache";
import { logServerError } from "@/lib/errors";
import { AcademicStaffError } from "./contracts";
import { assignCohortStaff, endCohortStaffAssignment, replaceCohortStaff } from "./service";
import { getWebAcademicPrincipal } from "./web-principal";

// 운영 인력 관리 화면 경로. 성공 시 이 화면의 배정·감사 목록을 다시 읽습니다.
const OPERATIONS_PATH = "/member/academic-operations";

export type StaffActionState = {
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

/** `datetime-local`(한국시간 벽시계) 값을 시간대가 명시된 ISO 문자열로 바꿉니다. 그 밖의 형식은 그대로 넘겨 서비스가 거부합니다. */
function kstInstant(formData: FormData, key: string): string | undefined {
  const value = field(formData, key);
  if (value && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return `${value}:00+09:00`;
  return value;
}

/** 서비스의 고정 오류는 그대로, 예상하지 못한 오류는 기록 후 일반 문구로 바꿉니다. */
function failure(scope: string, error: unknown): StaffActionState {
  if (error instanceof AcademicStaffError) {
    return { status: "error", code: error.code, message: error.message };
  }
  logServerError(scope, error);
  return { status: "error", code: "UNAVAILABLE", message: "잠시 후 다시 시도해 주세요." };
}

/** 기수에 어드바이저·조교를 배정합니다. */
export async function assignStaffAction(
  _previous: StaffActionState,
  formData: FormData,
): Promise<StaffActionState> {
  try {
    const principal = await getWebAcademicPrincipal();
    await assignCohortStaff(principal, {
      requestId: field(formData, "requestId"),
      cohortId: field(formData, "cohortId"),
      userId: field(formData, "userId"),
      staffRole: field(formData, "staffRole"),
      validFrom: kstInstant(formData, "validFrom"),
      validTo: kstInstant(formData, "validTo"),
      verificationMethod: field(formData, "verificationMethod"),
      evidenceReference: field(formData, "evidenceReference"),
    });
  } catch (error) {
    return failure("academic-staff/assign", error);
  }
  revalidatePath(OPERATIONS_PATH);
  return { status: "success", message: "운영 인력을 배정했습니다." };
}

/** 배정을 종료(해제)합니다. 사유는 필수이며 응답·화면에는 다시 표시하지 않습니다. */
export async function endStaffAction(
  _previous: StaffActionState,
  formData: FormData,
): Promise<StaffActionState> {
  try {
    const principal = await getWebAcademicPrincipal();
    await endCohortStaffAssignment(principal, {
      requestId: field(formData, "requestId"),
      assignmentId: field(formData, "assignmentId"),
      effectiveAt: kstInstant(formData, "effectiveAt"),
      reason: field(formData, "reason"),
    });
  } catch (error) {
    return failure("academic-staff/end", error);
  }
  revalidatePath(OPERATIONS_PATH);
  return { status: "success", message: "배정을 종료했습니다." };
}

/** 기존 배정을 종료하고 같은 기수·역할에 다른 계정을 배정합니다(한 번에 확정). */
export async function replaceStaffAction(
  _previous: StaffActionState,
  formData: FormData,
): Promise<StaffActionState> {
  try {
    const principal = await getWebAcademicPrincipal();
    await replaceCohortStaff(principal, {
      requestId: field(formData, "requestId"),
      assignmentId: field(formData, "assignmentId"),
      userId: field(formData, "userId"),
      effectiveAt: kstInstant(formData, "effectiveAt"),
      reason: field(formData, "reason"),
      verificationMethod: field(formData, "verificationMethod"),
      evidenceReference: field(formData, "evidenceReference"),
    });
  } catch (error) {
    return failure("academic-staff/replace", error);
  }
  revalidatePath(OPERATIONS_PATH);
  return { status: "success", message: "운영 인력을 교체했습니다." };
}
