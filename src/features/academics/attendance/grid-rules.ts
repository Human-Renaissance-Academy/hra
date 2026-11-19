/**
 * #160 출결표 화면의 표시 규칙(순수 함수)입니다. 서버 규칙(P6~P8)을 안내용으로만 반영하며,
 * 실제 허용 여부는 매 요청 DB 함수가 DB 현재 시각으로 다시 판정합니다.
 */
import type { AttendanceCellStatus, AttendanceStatus } from "./contracts";

export type EntryWindowState = "BEFORE" | "OPEN" | "CLOSED";

// 직접 입력 가능한 상태. 인정결석은 정정 요청으로만 지정합니다(P8).
export const DIRECT_STATUSES = [
  "PRESENT",
  "LATE",
  "ABSENT",
] as const satisfies readonly AttendanceStatus[];

/** 서버가 렌더한 시각 기준 입력 창 상태. 창은 [열림, 닫힘) 반열린 구간입니다. */
export function entryWindowState(now: string, opensAt: string, closesAt: string): EntryWindowState {
  const current = Date.parse(now);
  if (current < Date.parse(opensAt)) return "BEFORE";
  if (current >= Date.parse(closesAt)) return "CLOSED";
  return "OPEN";
}

/**
 * 정정 요청에서 고를 수 있는 상태.
 * - 입력 기간 전: 없음(서버가 OUTSIDE_WINDOW로 거부)
 * - 입력 기간 중: 인정결석 지정, 또는 인정결석인 셀의 해제만(그 밖의 변경은 직접 입력)
 * - 입력 기간 후: 현재 값을 제외한 모든 상태
 */
export function correctionOptions(
  current: AttendanceCellStatus,
  window: EntryWindowState,
): AttendanceStatus[] {
  if (window === "BEFORE") return [];
  if (window === "OPEN") return current === "EXCUSED" ? [...DIRECT_STATUSES] : ["EXCUSED"];
  return (["PRESENT", "LATE", "ABSENT", "EXCUSED"] as const).filter((status) => status !== current);
}
