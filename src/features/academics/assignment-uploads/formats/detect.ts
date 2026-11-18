/**
 * 과제 문서 형식 탐지·선언 교차 검증 진입점 (#516 PR-B)
 *
 * 역할:
 * - `detectDocumentFormat()`: 원본 바이트만 보고 PDF·HWP·HWPX·PPT·PPTX를 판별합니다.
 *   매직 바이트로 컨테이너를 고른 뒤 PDF는 폴리글랏 검사, CFB/ZIP은 내부 구조 검증을 수행합니다.
 * - `validateDeclaredDocument()`: 파일 확장자 ↔ 선언 형식 ↔ 정규 MIME ↔ 실제 탐지 형식,
 *   그리고 산출물 유형(텍스트/발표자료) 허용 목록을 모두 교차 검증합니다.
 * - 잘못되었거나 악의적인 입력에도 예외를 던지지 않고 안정적인 사유 코드를 반환합니다.
 *   50MiB 입력 상한은 어떤 파싱보다 먼저 검사합니다.
 *
 * 사용 위치:
 * - 아직 호출하는 곳이 없습니다(기능 비활성). 업로드 검증·최종화(`server.ts`) 연결은 후속 PR에서
 *   기존 Private Blob·소유권·SHA-256 검증을 유지한 채 진행합니다.
 * - 이 모듈은 서버 전용입니다(`node:zlib` 사용).
 */
import "server-only";
import { detectCfbDocument } from "./cfb";
import { detectZipDocument } from "./zip";
import {
  type AssignmentArtifactType,
  type DetectionResult,
  type DocumentFormat,
  type DocumentFormatReason,
  ARTIFACT_DOCUMENT_FORMATS,
  CFB_SIGNATURE,
  DOCUMENT_EXTENSIONS,
  DOCUMENT_FORMATS,
  DOCUMENT_MIME_TYPES,
  MAX_DOCUMENT_BYTES,
  PDF_SIGNATURE,
  ZIP_LOCAL_SIGNATURE,
  fail,
  indexOfBytes,
  startsWithAt,
} from "./types";

/** 폴리글랏 검사 범위: 앞 1KiB */
const POLYGLOT_SCAN_BYTES = 1024;

/** 앞 1KiB 안에 `signatures` 중 하나라도 나타나는지 확인합니다. */
function hasSignatureNearStart(
  bytes: Uint8Array,
  signatures: readonly (readonly number[])[],
  from = 0,
): boolean {
  return signatures.some(
    (signature) => indexOfBytes(bytes, signature, from, POLYGLOT_SCAN_BYTES) !== -1,
  );
}

/**
 * 원본 바이트로 문서 형식을 판별합니다.
 * 1) 크기 상한·빈 파일 검사 → 2) 선두 시그니처로 컨테이너 선택 → 3) 컨테이너별 구조 검증
 */
export function detectDocumentFormat(bytes: Uint8Array): DetectionResult {
  // 1) 어떤 파싱보다 먼저 입력 크기를 제한합니다.
  if (bytes.length > MAX_DOCUMENT_BYTES) return fail("TOO_LARGE");
  if (bytes.length === 0) return fail("EMPTY");

  // 2-a) PDF: `%PDF-`로 시작해야 하며, 앞 1KiB에 ZIP/CFB 시그니처가 섞이면 폴리글랏으로 거부합니다.
  //      PDF 본문 구조(xref·trailer)는 검증하지 않습니다. 렌더링·변환을 하지 않으므로 헤더 판별까지만 수행합니다.
  if (startsWithAt(bytes, 0, PDF_SIGNATURE)) {
    if (hasSignatureNearStart(bytes, [ZIP_LOCAL_SIGNATURE, CFB_SIGNATURE], PDF_SIGNATURE.length))
      return fail("POLYGLOT");
    return { ok: true, format: "PDF" };
  }
  // 2-b) CFB(OLE2): HWP·PPT 후보
  if (startsWithAt(bytes, 0, CFB_SIGNATURE)) return detectCfbDocument(bytes);
  // 2-c) ZIP: HWPX·PPTX 후보. 첫 로컬 헤더가 오프셋 0이어야 하므로 선두 일치만 받습니다.
  if (startsWithAt(bytes, 0, ZIP_LOCAL_SIGNATURE)) return detectZipDocument(bytes);

  // 3) 선두에 임의 데이터를 붙여 다른 형식을 숨긴 경우(앞 1KiB 안의 시그니처)는 폴리글랏으로 구분합니다.
  if (hasSignatureNearStart(bytes, [PDF_SIGNATURE, ZIP_LOCAL_SIGNATURE, CFB_SIGNATURE]))
    return fail("POLYGLOT");
  return fail("UNKNOWN_FORMAT");
}

/** 문자열이 지원 형식 이름인지 확인합니다. */
function isDocumentFormat(value: string): value is DocumentFormat {
  return (DOCUMENT_FORMATS as readonly string[]).includes(value);
}

/** 파일 이름의 마지막 확장자를 소문자로 반환합니다(없으면 빈 문자열). */
function extensionOf(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot <= 0 || dot === fileName.length - 1 ? "" : fileName.slice(dot + 1).toLowerCase();
}

/** 교차 검증 입력. 호출자가 받은 값을 그대로 넘기고, 형식 판단은 이 함수에 맡깁니다. */
export interface DeclaredDocumentInput {
  /** 원본 바이트 전체 */
  bytes: Uint8Array;
  /** 학생이 선택한 원본 파일 이름(확장자 확인용) */
  fileName: string;
  /** 클라이언트가 선언한 형식(PDF·HWP·HWPX·PPT·PPTX) */
  declaredFormat: string;
  /** 저장소/요청의 Content-Type. 형식별 정규 MIME과 정확히 같아야 합니다(대소문자·앞뒤 공백 무시). */
  contentType: string;
  /** 제출 항목의 산출물 유형(텍스트/발표자료) */
  artifactType: AssignmentArtifactType;
}

/** 교차 검증 결과. 성공하면 저장에 쓸 정규 MIME도 함께 돌려줍니다. */
export type DeclaredDocumentResult =
  | { ok: true; format: DocumentFormat; contentType: string }
  | { ok: false; reason: DocumentFormatReason };

/**
 * 선언 메타데이터와 실제 원본을 교차 검증합니다.
 * 순서: 크기 → 선언 형식 → 산출물 허용 목록 → 확장자 → MIME → 원본 탐지 → 탐지/선언 일치
 */
export function validateDeclaredDocument(input: DeclaredDocumentInput): DeclaredDocumentResult {
  const { bytes, fileName, declaredFormat, contentType, artifactType } = input;
  if (bytes.length > MAX_DOCUMENT_BYTES) return fail("TOO_LARGE");
  if (!isDocumentFormat(declaredFormat)) return fail("UNSUPPORTED");
  const allowed = Object.hasOwn(ARTIFACT_DOCUMENT_FORMATS, artifactType)
    ? ARTIFACT_DOCUMENT_FORMATS[artifactType]
    : [];
  if (!allowed.includes(declaredFormat)) return fail("ARTIFACT_NOT_ALLOWED");
  if (extensionOf(fileName) !== DOCUMENT_EXTENSIONS[declaredFormat])
    return fail("EXTENSION_MISMATCH");
  const canonicalMime = DOCUMENT_MIME_TYPES[declaredFormat];
  if (contentType.trim().toLowerCase() !== canonicalMime) return fail("MIME_MISMATCH");

  const detected = detectDocumentFormat(bytes);
  if (!detected.ok) return detected;
  if (detected.format !== declaredFormat) return fail("FORMAT_MISMATCH");
  return { ok: true, format: detected.format, contentType: canonicalMime };
}
