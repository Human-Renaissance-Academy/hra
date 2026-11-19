/** 과제 관리 화면에서 공유하는 한국어 상태와 한국시간 표시다. 브라우저 현지 시간대에 의존하지 않는다. */
export const assignmentStatusLabels = { DRAFT: "초안", PUBLISHED: "공개", CLOSED: "종료" } as const;

// #516 제출 형식과 텍스트·발표자료 요구의 한국어 표시입니다.
export const submissionFormatLabels = {
  LEGACY_SINGLE_PDF: "PDF 1개 (기존 방식)",
  ARTIFACTS_V2: "텍스트·발표자료 분리 제출",
} as const;
export const artifactRequirementLabels = {
  REQUIRED: "필수",
  OPTIONAL: "선택",
  DISABLED: "미사용",
} as const;

/** 과제 상세의 읽기 전용 제출 형식 요약입니다. 예: "텍스트·발표자료 분리 제출 (텍스트 필수 · 발표자료 선택)" */
export function describeSubmissionPolicy(assignment: {
  submissionFormat: keyof typeof submissionFormatLabels;
  textRequirement: keyof typeof artifactRequirementLabels | null;
  slidesRequirement: keyof typeof artifactRequirementLabels | null;
}): string {
  if (
    assignment.submissionFormat !== "ARTIFACTS_V2" ||
    !assignment.textRequirement ||
    !assignment.slidesRequirement
  )
    return submissionFormatLabels.LEGACY_SINGLE_PDF;
  return `${submissionFormatLabels.ARTIFACTS_V2} (텍스트 ${artifactRequirementLabels[assignment.textRequirement]} · 발표자료 ${artifactRequirementLabels[assignment.slidesRequirement]})`;
}

export function formatAssignmentKst(value: string | null): string {
  if (!value) return "마감 미정";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

/** datetime-local의 값은 한국시간 벽시계로 채우고 UTC 접미사를 넣지 않는다. */
export function assignmentKstInput(value: string | null): string {
  if (!value) return "";
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  const get = (name: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === name)?.value;
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}:${get("second")}`;
}

export const sessionCategoryLabels: Record<string, string> = {
  CLASSICS: "고전명작",
  ENGLISH: "영어",
  SPEECH: "스피치",
  SPECIAL_LECTURE: "특강",
  CASE_STUDY: "케이스스터디",
};
