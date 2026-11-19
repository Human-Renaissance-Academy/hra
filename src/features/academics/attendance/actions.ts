"use server";
/**
 * #160 출결 입력·정정 요청·정정 결정 Server Action입니다.
 *
 * - 사용 위치: `/member/attendance/staff`(운영 인력 출결표)와 `/member/academic-operations`(학사 운영 관리자 정정 결정).
 * - 책임: 입력 변환, Web 세션 → 요청 주체, Application Service 호출, 화면 재검증만 합니다.
 *   기수 배정·7일 입력 창·버전 충돌·자기 승인 금지·인정결석 관리자 승인은 서비스와 DB 함수가 매 호출 다시 판정합니다.
 * - 홈페이지 `ADMIN`·교수 `FACULTY` 역할은 어떤 판정에도 쓰지 않습니다. 오류는 고정 한국어 문구만 돌려줍니다.
 */
import { revalidatePath } from "next/cache";
import { logServerError } from "@/lib/errors";
import { getWebAcademicPrincipal } from "@/features/academics/staff/web-principal";
import { AcademicAttendanceError, type AttendanceStatus } from "./contracts";
import { decideCorrection, recordAttendance, requestCorrection } from "./service";

// 출결 결과가 보이는 화면들. 변경 후 서버 데이터를 다시 읽게 합니다.
const STAFF_PATH = "/member/attendance/staff";
const OPERATIONS_PATH = "/member/academic-operations";
const OWN_PATH = "/member/attendance";

export type AttendanceActionState = {
  status: "idle" | "success" | "error";
  message?: string;
  code?: string;
};

export type RecordAttendanceResult =
  | { ok: true; status: AttendanceStatus; version: number; recordedAt: string }
  | { ok: false; code: string; message: string };

/** 비어 있는 필드는 생략(undefined)으로 바꿉니다. 형식 검증은 서비스의 zod 스키마가 합니다. */
function field(formData: FormData, key: string): string | undefined {
  const value = formData.get(key);
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** 폼의 버전 문자열을 숫자로 바꿉니다. 정수가 아니면 그대로 넘겨 서비스가 INVALID_INPUT으로 거부합니다. */
function version(formData: FormData, key: string): number | string | undefined {
  const value = field(formData, key);
  return value !== undefined && /^\d{1,10}$/.test(value) ? Number(value) : value;
}

/** 서비스의 고정 오류는 그대로, 예상하지 못한 오류는 기록 후 일반 문구로 바꿉니다. */
function failure(scope: string, error: unknown): { code: string; message: string } {
  if (error instanceof AcademicAttendanceError) return { code: error.code, message: error.message };
  logServerError(scope, error);
  return { code: "UNAVAILABLE", message: "잠시 후 다시 시도해 주세요." };
}

/**
 * 출결표의 상태 버튼 한 번을 저장합니다. 호출자가 본 버전(`expectedVersion`)과 다르면 VERSION_CONFLICT를 돌려
 * 화면이 덮어쓰지 않고 최신 값을 다시 읽게 합니다. 입력 객체는 서비스의 strict 스키마가 검증합니다.
 */
export async function recordAttendanceAction(input: unknown): Promise<RecordAttendanceResult> {
  let result;
  try {
    const principal = await getWebAcademicPrincipal();
    result = await recordAttendance(principal, input);
  } catch (error) {
    return { ok: false, ...failure("academic-attendance/record", error) };
  }
  revalidatePath(STAFF_PATH);
  return {
    ok: true,
    status: result.record.status,
    version: result.record.version,
    recordedAt: result.record.recordedAt,
  };
}

/** 입력 창 이후 변경·인정결석 지정/해제를 사유와 함께 요청합니다. 승인 전에는 현재 값이 바뀌지 않습니다. */
export async function requestCorrectionAction(
  _previous: AttendanceActionState,
  formData: FormData,
): Promise<AttendanceActionState> {
  try {
    const principal = await getWebAcademicPrincipal();
    await requestCorrection(principal, {
      requestId: field(formData, "requestId"),
      scheduleEventId: field(formData, "scheduleEventId"),
      enrollmentId: field(formData, "enrollmentId"),
      requestedStatus: field(formData, "requestedStatus"),
      expectedVersion: version(formData, "expectedVersion"),
      reason: field(formData, "reason"),
      // 인정결석이 아닌 요청에 확인 방식이 남아 있으면 서비스가 거부하므로, 인정결석일 때만 넘깁니다.
      excuseVerificationMethod:
        field(formData, "requestedStatus") === "EXCUSED"
          ? field(formData, "excuseVerificationMethod")
          : undefined,
    });
  } catch (error) {
    return { status: "error", ...failure("academic-attendance/correction", error) };
  }
  revalidatePath(STAFF_PATH);
  revalidatePath(OPERATIONS_PATH);
  revalidatePath(OWN_PATH);
  return {
    status: "success",
    message: "정정 요청을 접수했습니다. 다른 담당자의 승인 후 반영됩니다.",
  };
}

/** 정정 요청을 승인·반려합니다. 요청자 본인의 결정과 권한 밖 결정은 서비스·DB가 거부합니다. */
export async function decideCorrectionAction(
  _previous: AttendanceActionState,
  formData: FormData,
): Promise<AttendanceActionState> {
  const decision = field(formData, "decision");
  try {
    const principal = await getWebAcademicPrincipal();
    await decideCorrection(principal, {
      requestId: field(formData, "requestId"),
      correctionId: field(formData, "correctionId"),
      decision,
    });
  } catch (error) {
    return { status: "error", ...failure("academic-attendance/decide", error) };
  }
  revalidatePath(STAFF_PATH);
  revalidatePath(OPERATIONS_PATH);
  revalidatePath(OWN_PATH);
  return {
    status: "success",
    message: decision === "APPROVE" ? "정정을 승인했습니다." : "정정을 반려했습니다.",
  };
}
