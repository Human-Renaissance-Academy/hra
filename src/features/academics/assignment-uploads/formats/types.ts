/**
 * 과제 문서 형식 탐지 공용 타입·상수 (#516 PR-B)
 *
 * 역할:
 * - 학생 과제 업로드에서 허용할 문서 형식(PDF·HWP·HWPX·PPT·PPTX)과 정규 MIME, 확장자를 정의합니다.
 * - 산출물 유형(텍스트/발표자료)별 허용 형식 목록을 정의합니다.
 * - 탐지·검증 실패 시 반환하는 안정적인 사유 코드(reason code)를 한곳에 모읍니다.
 *
 * 사용 위치:
 * - `detect.ts`, `zip.ts`, `cfb.ts`가 이 파일의 상수와 타입을 공유합니다.
 * - 아직 업로드 의도·최종화 코드에서 호출하지 않습니다. 연결은 후속 PR에서 진행합니다.
 *
 * 주의:
 * - 사유 코드는 로그·API 오류 매핑에 쓰일 수 있으므로 이름을 바꾸지 않습니다(추가만 허용).
 */

/** 서버가 구분하는 과제 문서 형식 */
export const DOCUMENT_FORMATS = ["PDF", "HWP", "HWPX", "PPT", "PPTX"] as const;
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

/** 형식별 정규 MIME. 업로드 저장 시 Content-Type도 이 값으로만 기록합니다. */
export const DOCUMENT_MIME_TYPES: Readonly<Record<DocumentFormat, string>> = {
  PDF: "application/pdf",
  HWP: "application/x-hwp",
  HWPX: "application/hwp+zip",
  PPT: "application/vnd.ms-powerpoint",
  PPTX: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** 형식별 허용 확장자(소문자, 점 제외). 한 형식에 확장자 하나만 대응합니다. */
export const DOCUMENT_EXTENSIONS: Readonly<Record<DocumentFormat, string>> = {
  PDF: "pdf",
  HWP: "hwp",
  HWPX: "hwpx",
  PPT: "ppt",
  PPTX: "pptx",
};

/** 과제 산출물 유형: 텍스트(TEXT)와 발표자료(SLIDES) */
export const ASSIGNMENT_ARTIFACT_TYPES = ["TEXT", "SLIDES"] as const;
export type AssignmentArtifactType = (typeof ASSIGNMENT_ARTIFACT_TYPES)[number];

/** 산출물 유형별 허용 형식. 텍스트는 PDF·HWP·HWPX, 발표자료는 PDF·PPT·PPTX만 받습니다. */
export const ARTIFACT_DOCUMENT_FORMATS: Readonly<
  Record<AssignmentArtifactType, readonly DocumentFormat[]>
> = {
  TEXT: ["PDF", "HWP", "HWPX"],
  SLIDES: ["PDF", "PPT", "PPTX"],
};

/** 입력 원본 최대 크기(50MiB). 기존 PDF 업로드 계약과 같은 파일별 상한입니다. */
export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

/**
 * 안정적인 실패 사유 코드
 * - TOO_LARGE: 50MiB 초과
 * - EMPTY: 0바이트
 * - UNKNOWN_FORMAT: 알려진 문서 시그니처가 없음
 * - UNSUPPORTED: 구조는 읽히지만 허용하지 않는 형식(DOCX·XLSX·DOC·XLS·일반 ZIP·ZIP64·다중 디스크 등)
 * - MALFORMED: 손상·잘림·범위 밖 오프셋·순환 체인·모순된 메타데이터
 * - ENCRYPTED: 암호화된 ZIP 엔트리, 암호 설정 HWP, 암호화된 OOXML(EncryptionInfo/EncryptedPackage)
 * - MACRO: 매크로 포함 발표자료(macroEnabled 콘텐츠 형식, vbaProject.bin)
 * - ZIP_LIMIT: 엔트리 수·선언 압축 해제량·필수 엔트리 해제 상한 초과(압축 폭탄 방지)
 * - PATH_TRAVERSAL: `..` 세그먼트, 절대 경로, 역슬래시, NUL, 드라이브 문자가 있는 엔트리 이름
 * - POLYGLOT: 다른 형식의 시그니처가 앞부분에 섞여 있거나 시그니처 앞에 임의 데이터가 붙음
 * - EXTENSION_MISMATCH: 파일 확장자와 선언 형식 불일치
 * - MIME_MISMATCH: 요청 Content-Type과 선언 형식의 정규 MIME 불일치
 * - FORMAT_MISMATCH: 실제 탐지 형식과 선언 형식 불일치
 * - ARTIFACT_NOT_ALLOWED: 산출물 유형에서 허용하지 않는 형식
 */
export const DOCUMENT_FORMAT_REASONS = [
  "TOO_LARGE",
  "EMPTY",
  "UNKNOWN_FORMAT",
  "UNSUPPORTED",
  "MALFORMED",
  "ENCRYPTED",
  "MACRO",
  "ZIP_LIMIT",
  "PATH_TRAVERSAL",
  "POLYGLOT",
  "EXTENSION_MISMATCH",
  "MIME_MISMATCH",
  "FORMAT_MISMATCH",
  "ARTIFACT_NOT_ALLOWED",
] as const;
export type DocumentFormatReason = (typeof DOCUMENT_FORMAT_REASONS)[number];

/** 탐지 결과. 실패해도 예외를 던지지 않고 사유 코드만 반환합니다. */
export type DetectionResult =
  | { ok: true; format: DocumentFormat }
  | { ok: false; reason: DocumentFormatReason };

/** 내부 파서 사이에서 쓰는 실패 값 생성 도우미 */
export function fail(reason: DocumentFormatReason): { ok: false; reason: DocumentFormatReason } {
  return { ok: false, reason };
}

/** 리틀엔디언 정수 읽기를 위해 입력 바이트 전체를 감싸는 DataView를 만듭니다. */
export function viewOf(bytes: Uint8Array): DataView {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

/** `bytes[offset..]`가 `signature`와 같은지 범위를 확인하며 비교합니다. */
export function startsWithAt(
  bytes: Uint8Array,
  offset: number,
  signature: readonly number[],
): boolean {
  if (offset < 0 || offset + signature.length > bytes.length) return false;
  for (let index = 0; index < signature.length; index += 1) {
    if (bytes[offset + index] !== signature[index]) return false;
  }
  return true;
}

/** `bytes[start..end)` 안에서 `signature`가 처음 나타나는 위치(없으면 -1) */
export function indexOfBytes(
  bytes: Uint8Array,
  signature: readonly number[],
  start = 0,
  end = bytes.length,
): number {
  const last = Math.min(end, bytes.length) - signature.length;
  for (let offset = Math.max(0, start); offset <= last; offset += 1) {
    if (startsWithAt(bytes, offset, signature)) return offset;
  }
  return -1;
}

/** ZIP 로컬 파일 헤더 시그니처 `PK\x03\x04` */
export const ZIP_LOCAL_SIGNATURE = [0x50, 0x4b, 0x03, 0x04] as const;
/** CFB(OLE2 복합 문서) 시그니처 D0 CF 11 E0 A1 B1 1A E1 */
export const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1] as const;
/** PDF 헤더 시그니처 `%PDF-` */
export const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d] as const;
