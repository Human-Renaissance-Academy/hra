/**
 * #160 출결·운영 인력 화면의 한국어 표시 문구입니다(클라이언트·서버 공용 순수 상수).
 * 상태를 색만으로 구분하지 않도록 모든 상태에 글자 표기를 둡니다.
 */
import type { AttendanceCellStatus } from "./contracts";

// 출결 상태 표기. 미입력(UNMARKED)은 결석과 다르게 표시합니다(P5).
export const ATTENDANCE_STATUS_LABELS: Record<AttendanceCellStatus, string> = {
  PRESENT: "출석",
  LATE: "지각",
  ABSENT: "결석",
  EXCUSED: "인정결석",
  UNMARKED: "미입력",
};

// 정정 요청 처리 상태 표기.
export const CORRECTION_STATUS_LABELS = {
  PENDING: "결정 대기",
  APPROVED: "승인",
  REJECTED: "반려",
} as const;

// 인정결석 확인 방식 표기(운영 확정 전 임시값, 증빙 원본은 저장하지 않음).
export const EXCUSE_METHOD_LABELS = {
  DOCUMENT_SIGHTED: "증빙 서류 열람 확인",
  VERIFIED_CONTACT: "검증된 연락 경로 확인",
} as const;

// 기수 운영 인력 역할 표기.
export const STAFF_ROLE_LABELS = {
  ADVISOR: "어드바이저",
  ASSISTANT: "조교",
} as const;

// 배정 감사 행위 표기.
export const STAFF_AUDIT_ACTION_LABELS = {
  MANAGER_DESIGNATE: "학사 운영 관리자 지정",
  MANAGER_END: "학사 운영 관리자 지정 종료",
  STAFF_ASSIGN: "운영 인력 배정",
  STAFF_END: "운영 인력 배정 종료",
  STAFF_REPLACE: "운영 인력 교체",
} as const;

// 사유 입력란 공통 안내. 진단명·연락처 같은 개인정보를 적지 않도록 알립니다.
export const REASON_PRIVACY_NOTICE =
  '사유에는 진단명·병명·연락처·주민등록번호 같은 개인정보나 민감정보를 적지 마세요. 필요한 경우 "개인 사정"처럼 간단히 적어 주세요.';
