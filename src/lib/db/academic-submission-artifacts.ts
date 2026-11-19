/**
 * #516 텍스트·발표자료 분리 제출(ARTIFACTS_V2)의 DB 값 미러
 *
 * 역할:
 * - `scripts/migrate-academic-submission-artifacts.sql`이 추가하는 enum 값과 상한을 TypeScript 상수·타입으로 고정합니다.
 * - 후속 서비스·리포지토리(#516 PR-D)가 SQL 함수 인자와 결과를 같은 값으로 다루게 합니다.
 *
 * 사용 위치:
 * - 과제 생성·초안 수정 입력 검증(`features/academics/assignments/validation.ts`)이 enum 값을 공유합니다.
 * - V2 업로드·최종화 서비스(#516 PR-D)는 ACADEMIC_SUBMISSION_ARTIFACTS_ENABLED가 true일 때만 V2 함수를 호출합니다.
 *
 * 주의:
 * - 이 파일은 `schema.ts`에서 재수출하지 않으며 pgTable·pgEnum을 선언하지 않습니다.
 *   신규 설치는 Drizzle export(v1 구조) → G1 범위 SQL(v1 구조 대조) → 이 마이그레이션 순서로 진행합니다.
 *   Drizzle 모델에 새 컬럼을 먼저 선언하면 export가 v2 구조를 만들어 G1 SQL의 v1 구조 대조가 실패하므로,
 *   새 컬럼·enum의 정본은 범위 SQL이 소유합니다. 이 상수는 SQL의 enum 라벨과 같은 순서를 유지해야 합니다.
 */

/** 과제 제출 형식: 기존 PDF 단일 제출과 텍스트·발표자료 분리 제출 */
export const ASSIGNMENT_SUBMISSION_FORMATS = ["LEGACY_SINGLE_PDF", "ARTIFACTS_V2"] as const;
export type AssignmentSubmissionFormat = (typeof ASSIGNMENT_SUBMISSION_FORMATS)[number];

/** 산출물별 제출 요구: 필수·선택·미사용. 두 항목 모두 미사용인 V2 과제는 DB CHECK가 거부합니다. */
export const ASSIGNMENT_ARTIFACT_REQUIREMENTS = ["REQUIRED", "OPTIONAL", "DISABLED"] as const;
export type AssignmentArtifactRequirement = (typeof ASSIGNMENT_ARTIFACT_REQUIREMENTS)[number];

/** 저장된 업로드·파일의 산출물 유형. LEGACY_PDF는 기존 단일 PDF 제출에만 쓰입니다. */
export const STORED_ARTIFACT_TYPES = ["LEGACY_PDF", "TEXT", "SLIDES"] as const;
export type StoredArtifactType = (typeof STORED_ARTIFACT_TYPES)[number];

/** 저장된 파일 형식. MIME과 산출물 유형의 대응은 DB CHECK가 강제합니다. */
export const STORED_FILE_FORMATS = ["PDF", "HWP", "HWPX", "PPT", "PPTX"] as const;
export type StoredFileFormat = (typeof STORED_FILE_FORMATS)[number];

/** 파일별 상한(50MiB)과 V2 제출 1건의 합계 상한(100MiB). 최종화 함수와 지연 트리거가 같은 값을 사용합니다. */
export const MAX_ARTIFACT_FILE_BYTES = 52_428_800;
export const MAX_ARTIFACT_SUBMISSION_BYTES = 104_857_600;

/** V2 SQL 함수의 추가 SQLSTATE. 기존 SUB01~SUB05 의미는 바꾸지 않습니다. */
export const ARTIFACT_SUBMISSION_SQLSTATES = {
  /** 필수 누락·미사용 항목 첨부·0개·같은 항목 중복 */
  INVALID_COMPOSITION: "SUB06",
  /** 제출 합계 100MiB 초과(파일별 50MiB·최대 2개라 정상 경로에서는 도달하지 않는 방어 상한) */
  TOTAL_TOO_LARGE: "SUB07",
} as const;
