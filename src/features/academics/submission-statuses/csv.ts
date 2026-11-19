/** 운영 보고 CSV의 최소 필드·한국 시각·UTF-8 BOM·수식 주입 방어를 담당한다. */
import { formatKstCsvDateTime } from "@/lib/date-time";
import type { SubmissionStatusAssignment, SubmissionStatusRow } from "./contracts";

// 공백·제어문자 뒤의 수식 시작 문자도 접두 작은따옴표로 무력화하고 모든 필드를 인용한다.
export function submissionCsvCell(value: string): string {
  const protectedValue =
    /^[\s\u0000-\u001f\u007f]*[=+\-@]/u.test(value) || /^[\t\r\n]/u.test(value)
      ? `'${value}`
      : value;
  return `"${protectedValue.replaceAll('"', '""')}"`;
}

const artifactColumns = [
  ["TEXT", "텍스트"],
  ["SLIDES", "발표자료"],
] as const;

/**
 * #516: 분리 제출 과제의 한 항목 상태(제출 여부·형식·크기 바이트)를 만든다.
 * 미사용 항목은 "미사용", 미제출 학생이나 제출에 없는 선택 항목은 "미제출"이며 형식·크기는 비운다.
 */
export function submissionArtifactCells(
  row: SubmissionStatusRow,
  type: "TEXT" | "SLIDES",
  requirement: SubmissionStatusAssignment["textRequirement"],
): [string, string, string] {
  if (requirement === "DISABLED") return ["미사용", "", ""];
  const file = row.submittedAt
    ? row.artifacts?.find((item) => item.artifactType === type)
    : undefined;
  return file ? ["제출", file.fileFormat, String(file.sizeBytes)] : ["미제출", "", ""];
}

/**
 * 기존 PDF 과제(또는 분리 제출 gate 꺼짐)는 기존 세 열을 그대로 쓴다.
 * 분리 제출 과제는 항목별 제출 여부·형식·크기(바이트) 열을 덧붙인다. 파일명·파일 ID·링크는 넣지 않는다.
 */
export function renderSubmissionStatusesCsv(
  rows: SubmissionStatusRow[],
  assignment?: SubmissionStatusAssignment,
): string {
  const split = assignment?.submissionFormat === "ARTIFACTS_V2";
  const header = ["이름", "제출 상태", "제출 시각(한국시간)"];
  if (split)
    for (const [, label] of artifactColumns)
      header.push(`${label} 제출`, `${label} 형식`, `${label} 크기(바이트)`);
  const records = [header];
  for (const row of rows) {
    const record = [
      row.displayName,
      row.submittedAt ? "제출" : "미제출",
      row.submittedAt ? formatKstCsvDateTime(new Date(row.submittedAt)) : "",
    ];
    if (split)
      for (const [type] of artifactColumns)
        record.push(
          ...submissionArtifactCells(
            row,
            type,
            type === "TEXT" ? assignment.textRequirement : assignment.slidesRequirement,
          ),
        );
    records.push(record);
  }
  return (
    "\uFEFF" +
    records.map((record) => record.map(submissionCsvCell).join(",")).join("\r\n") +
    "\r\n"
  );
}

// 경로·헤더 제어 문자와 과도한 길이를 제거한 이름을 RFC 5987로 제공한다.
export function submissionCsvDisposition(title: string): string {
  const name =
    [...title.replace(/[\x00-\x1f\x7f/\\"]/gu, "_").trim()].slice(0, 80).join("") || "과제";
  return `attachment; filename="assignment-submissions.csv"; filename*=UTF-8''${encodeURIComponent(`${name}-제출현황.csv`)}`;
}
