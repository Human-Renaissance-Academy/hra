/**
 * ZIP 기반 과제 문서(HWPX·PPTX) 구조 검증 (#516 PR-B)
 *
 * 역할:
 * - 외부 의존성 없이 ZIP 중앙 디렉터리를 읽고, 압축 폭탄·경로 traversal·암호화·ZIP64·다중 디스크·
 *   중복 이름·엔트리 겹침 같은 위험 구조를 사유 코드로 거부합니다.
 * - 판별에 꼭 필요한 엔트리(`mimetype`, `[Content_Types].xml`)만 `node:zlib`의
 *   `inflateRawSync`로 1MiB 상한을 두고 해제합니다. 나머지 엔트리는 해제하지 않습니다.
 * - HWPX와 PPTX를 구분하고, 일반 ZIP·DOCX·XLSX·ODF·EPUB 등은 미지원으로 거부합니다.
 * - 업로드된 문서의 매크로나 실행 콘텐츠를 실행하지 않습니다. 매크로 포함 PPTX는 MACRO로 거부합니다.
 *
 * 사용 위치: `detect.ts`의 `detectDocumentFormat()`이 ZIP 로컬 헤더 시그니처를 만나면 호출합니다.
 *
 * 근거: PKWARE APPNOTE.TXT(로컬 헤더 30바이트, 중앙 디렉터리 헤더 46바이트, EOCD 22바이트,
 * 주석 최대 65,535바이트), ECMA-376 Part 2(OPC `[Content_Types].xml`), KS X 6101(OWPML/HWPX).
 *
 * 실제 샘플 확인 필요:
 * - HWPX 필수 구조(`mimetype` 첫 엔트리·무압축, `Contents/content.hpf`, `Contents/header.xml`,
 *   `Contents/section<N>.xml`)는 공개 명세 기반 가정이며, 실제 한컴오피스 저장본으로 검증이 남아 있습니다.
 */
import { crc32, inflateRawSync } from "node:zlib";
import { type DetectionResult, type DocumentFormatReason, fail, viewOf } from "./types";

/** ZIP 레코드 시그니처(리틀엔디언 정수) */
const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;

/** 레코드 고정 길이 */
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const EOCD_BYTES = 22;
/** EOCD 탐색 범위: EOCD 22바이트 + 최대 주석 65,535바이트 */
const EOCD_SEARCH_BYTES = EOCD_BYTES + 0xffff;

/** 자원 상한: 엔트리 수, 선언 압축 해제 총량, 필수 엔트리 해제 크기 */
const MAX_ENTRIES = 2000;
const MAX_TOTAL_UNCOMPRESSED_BYTES = 300 * 1024 * 1024;
const MAX_INFLATED_ENTRY_BYTES = 1024 * 1024;

/** 일반 목적 비트 플래그: bit 0 암호화, bit 3 데이터 서술자, bit 6 강한 암호화, bit 11 UTF-8 이름 */
const FLAG_ENCRYPTED = 1 << 0;
const FLAG_DATA_DESCRIPTOR = 1 << 3;
const FLAG_STRONG_ENCRYPTION = 1 << 6;
const FLAG_UTF8 = 1 << 11;
/** 압축 방식: 0 무압축(stored), 8 deflate, 99 AES 암호화(WinZip) */
const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;
const METHOD_AES = 99;

/** HWPX `mimetype` 엔트리 내용 */
const HWPX_MIMETYPE = "application/hwp+zip";
/** PPTX 본문 파트의 콘텐츠 형식과 매크로 포함 변형 */
const PPTX_MAIN_CONTENT_TYPE =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml";
const PPTM_MAIN_CONTENT_TYPE = "application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml";

/** 파싱 중 실패를 전달하는 내부 예외. 모듈 밖으로 새지 않고 사유 코드로 변환됩니다. */
class ZipFailure {
  constructor(readonly reason: DocumentFormatReason) {}
}
function reject(reason: DocumentFormatReason = "MALFORMED"): never {
  throw new ZipFailure(reason);
}

/** 중앙 디렉터리에서 읽은 엔트리 정보 */
interface ZipEntry {
  name: string;
  nameBytes: Uint8Array;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  /** 로컬 헤더 검증 후 채워지는 압축 데이터 시작 위치 */
  dataOffset: number;
}

/**
 * 파일 끝 65,557바이트 안에서 EOCD를 찾습니다.
 * 후보는 (1) 주석 길이가 정확히 파일 끝에 닿고 (2) 중앙 디렉터리가 EOCD 바로 앞에서 끝나야 유효합니다.
 * 유효 후보가 정확히 하나가 아니면 판독기마다 해석이 갈릴 수 있으므로 거부합니다.
 */
function findEndOfCentralDirectory(bytes: Uint8Array, view: DataView): number {
  const searchStart = Math.max(0, bytes.length - EOCD_SEARCH_BYTES);
  let found = -1;
  for (let offset = bytes.length - EOCD_BYTES; offset >= searchStart; offset -= 1) {
    if (view.getUint32(offset, true) !== END_OF_CENTRAL_DIRECTORY) continue;
    const commentLength = view.getUint16(offset + 20, true);
    if (offset + EOCD_BYTES + commentLength !== bytes.length) continue;
    const directorySize = view.getUint32(offset + 12, true);
    const directoryOffset = view.getUint32(offset + 16, true);
    if (directoryOffset + directorySize !== offset) continue;
    if (found !== -1) reject();
    found = offset;
  }
  if (found === -1) reject();
  return found;
}

/** 엔트리 이름 바이트를 문자열로 바꿉니다. UTF-8 플래그가 있으면 엄격하게 디코딩합니다. */
function decodeName(nameBytes: Uint8Array, flags: number): string {
  if (flags & FLAG_UTF8) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(nameBytes);
    } catch {
      return reject();
    }
  }
  // CP437 이름은 위험 문자 검사에 필요한 ASCII 범위만 정확하면 충분하므로 latin1로 해석합니다.
  return String.fromCharCode(...nameBytes);
}

/** 압축 해제 시 파일 시스템 밖을 가리킬 수 있는 이름을 거부합니다. */
function assertSafeName(name: string): void {
  if (name.length === 0) reject();
  if (name.includes("\0") || name.includes("\\") || name.startsWith("/")) reject("PATH_TRAVERSAL");
  if (/^[A-Za-z]:/.test(name)) reject("PATH_TRAVERSAL");
  if (name.split("/").some((segment) => segment === "..")) reject("PATH_TRAVERSAL");
}

/** EOCD 레코드를 검증하고 중앙 디렉터리 위치·엔트리 수를 반환합니다. */
function readEndRecord(bytes: Uint8Array, view: DataView) {
  const eocd = findEndOfCentralDirectory(bytes, view);
  const diskNumber = view.getUint16(eocd + 4, true);
  const directoryDisk = view.getUint16(eocd + 6, true);
  const entriesOnDisk = view.getUint16(eocd + 8, true);
  const totalEntries = view.getUint16(eocd + 10, true);
  const directorySize = view.getUint32(eocd + 12, true);
  const directoryOffset = view.getUint32(eocd + 16, true);
  // ZIP64 위치 레코드가 EOCD 바로 앞에 있거나 필드가 ZIP64 표식이면 지원하지 않습니다.
  if (eocd >= 20 && view.getUint32(eocd - 20, true) === ZIP64_LOCATOR) reject("UNSUPPORTED");
  if (
    totalEntries === 0xffff ||
    entriesOnDisk === 0xffff ||
    directorySize === 0xffffffff ||
    directoryOffset === 0xffffffff
  )
    reject("UNSUPPORTED");
  // 분할(다중 디스크) ZIP은 지원하지 않습니다.
  if (diskNumber !== 0 || directoryDisk !== 0 || entriesOnDisk !== totalEntries)
    reject("UNSUPPORTED");
  if (totalEntries === 0) reject();
  if (totalEntries > MAX_ENTRIES) reject("ZIP_LIMIT");
  return { directoryOffset, directorySize, totalEntries };
}

/** 중앙 디렉터리 전체를 읽고 엔트리별 정책(암호화·압축 방식·이름·크기)을 검사합니다. */
function readCentralDirectory(bytes: Uint8Array, view: DataView): ZipEntry[] {
  const { directoryOffset, directorySize, totalEntries } = readEndRecord(bytes, view);
  const directoryEnd = directoryOffset + directorySize;
  const entries: ZipEntry[] = [];
  const names = new Set<string>();
  let totalUncompressed = 0;
  let cursor = directoryOffset;
  for (let index = 0; index < totalEntries; index += 1) {
    if (cursor + CENTRAL_HEADER_BYTES > directoryEnd) reject();
    if (view.getUint32(cursor, true) !== CENTRAL_HEADER) reject();
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const diskStart = view.getUint16(cursor + 34, true);
    const localOffset = view.getUint32(cursor + 42, true);
    const recordEnd = cursor + CENTRAL_HEADER_BYTES + nameLength + extraLength + commentLength;
    if (recordEnd > directoryEnd) reject();

    // 1) 암호화·압축 방식·ZIP64·디스크 번호 정책
    if (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION) || method === METHOD_AES)
      reject("ENCRYPTED");
    if (method !== METHOD_STORED && method !== METHOD_DEFLATE) reject("UNSUPPORTED");
    if (
      compressedSize === 0xffffffff ||
      uncompressedSize === 0xffffffff ||
      localOffset === 0xffffffff
    )
      reject("UNSUPPORTED");
    if (diskStart !== 0) reject("UNSUPPORTED");
    if (method === METHOD_STORED && compressedSize !== uncompressedSize) reject();

    // 2) 이름 안전성과 대소문자 무시 중복 검사
    const nameBytes = bytes.subarray(
      cursor + CENTRAL_HEADER_BYTES,
      cursor + CENTRAL_HEADER_BYTES + nameLength,
    );
    const name = decodeName(nameBytes, flags);
    assertSafeName(name);
    const key = name.toLowerCase();
    if (names.has(key)) reject();
    names.add(key);

    // 3) 선언된 압축 해제 총량 상한(압축 폭탄 방지)
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_TOTAL_UNCOMPRESSED_BYTES) reject("ZIP_LIMIT");

    entries.push({
      name,
      nameBytes,
      flags,
      method,
      crc,
      compressedSize,
      uncompressedSize,
      localOffset,
      dataOffset: -1,
    });
    cursor = recordEnd;
  }
  // 선언된 중앙 디렉터리 크기와 실제 소비 바이트가 같아야 숨은 레코드가 없습니다.
  if (cursor !== directoryEnd) reject();
  verifyLocalHeaders(bytes, view, entries, directoryOffset);
  return entries;
}

/**
 * 로컬 헤더를 중앙 디렉터리와 교차 검증합니다.
 * - 첫 로컬 헤더는 오프셋 0에 있어야 합니다(앞에 붙은 데이터 거부).
 * - 이름·플래그·압축 방식·크기·CRC가 중앙 디렉터리와 일치해야 합니다(데이터 서술자 사용 시 크기·CRC는 0 허용).
 * - 엔트리 데이터가 서로 겹치거나 중앙 디렉터리를 침범하면 거부합니다(겹침 기반 압축 폭탄 방지).
 */
function verifyLocalHeaders(
  bytes: Uint8Array,
  view: DataView,
  entries: ZipEntry[],
  directoryOffset: number,
): void {
  const ordered = [...entries].sort((left, right) => left.localOffset - right.localOffset);
  if (ordered[0].localOffset !== 0) reject();
  ordered.forEach((entry, index) => {
    const offset = entry.localOffset;
    if (offset + LOCAL_HEADER_BYTES > directoryOffset) reject();
    if (view.getUint32(offset, true) !== LOCAL_HEADER) reject();
    const flags = view.getUint16(offset + 6, true);
    const method = view.getUint16(offset + 8, true);
    const crc = view.getUint32(offset + 14, true);
    const compressedSize = view.getUint32(offset + 18, true);
    const uncompressedSize = view.getUint32(offset + 22, true);
    const nameLength = view.getUint16(offset + 26, true);
    const extraLength = view.getUint16(offset + 28, true);
    if (flags & (FLAG_ENCRYPTED | FLAG_STRONG_ENCRYPTION)) reject("ENCRYPTED");
    if (flags !== entry.flags || method !== entry.method) reject();
    const nameStart = offset + LOCAL_HEADER_BYTES;
    if (nameStart + nameLength > directoryOffset) reject();
    const localName = bytes.subarray(nameStart, nameStart + nameLength);
    if (
      localName.length !== entry.nameBytes.length ||
      localName.some((byte, at) => byte !== entry.nameBytes[at])
    )
      reject();
    const deferred = (flags & FLAG_DATA_DESCRIPTOR) !== 0;
    if (!deferred || compressedSize !== 0 || uncompressedSize !== 0 || crc !== 0) {
      if (
        compressedSize !== entry.compressedSize ||
        uncompressedSize !== entry.uncompressedSize ||
        crc !== entry.crc
      )
        reject();
    }
    entry.dataOffset = nameStart + nameLength + extraLength;
    const dataEnd = entry.dataOffset + entry.compressedSize;
    const limit = index + 1 < ordered.length ? ordered[index + 1].localOffset : directoryOffset;
    if (dataEnd > limit) reject();
  });
}

/**
 * 필수 엔트리 하나를 1MiB 상한으로 해제하고 크기·CRC를 확인합니다.
 * stored 엔트리는 압축/원본 크기가 같아야 하며 그대로 복사합니다.
 */
function readEntry(bytes: Uint8Array, entry: ZipEntry): Uint8Array {
  if (entry.uncompressedSize > MAX_INFLATED_ENTRY_BYTES) reject("ZIP_LIMIT");
  const data = bytes.subarray(entry.dataOffset, entry.dataOffset + entry.compressedSize);
  let output: Uint8Array;
  if (entry.method === METHOD_STORED) {
    output = data;
  } else {
    try {
      output = inflateRawSync(data, { maxOutputLength: MAX_INFLATED_ENTRY_BYTES });
    } catch (error) {
      // 출력 상한 초과는 압축 폭탄, 그 밖의 zlib 오류는 손상 데이터로 구분합니다.
      const code = (error as { code?: unknown } | null)?.code;
      return reject(code === "ERR_BUFFER_TOO_LARGE" ? "ZIP_LIMIT" : "MALFORMED");
    }
  }
  if (output.length !== entry.uncompressedSize || crc32(output) >>> 0 !== entry.crc) reject();
  return output;
}

/** UTF-8 XML 텍스트로 해석합니다(BOM 제거). 잘못된 UTF-8은 손상으로 봅니다. */
function decodeXml(data: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(data);
  } catch {
    return reject();
  }
}

/** `<Override .../>` 태그 속성을 단순 파싱합니다. 정규식은 태그 하나 범위로 제한됩니다. */
function parseOverrides(xml: string): { partName: string; contentType: string }[] {
  const overrides: { partName: string; contentType: string }[] = [];
  for (const tag of xml.matchAll(/<(?:[A-Za-z_][\w.-]*:)?Override\b([^>]*)>/g)) {
    const attributes = new Map<string, string>();
    for (const attribute of tag[1].matchAll(/([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
      attributes.set(attribute[1], attribute[2] ?? attribute[3] ?? "");
    }
    overrides.push({
      partName: attributes.get("PartName") ?? "",
      contentType: (attributes.get("ContentType") ?? "").trim(),
    });
  }
  return overrides;
}

/** HWPX 필수 구조를 확인합니다. `mimetype`은 오프셋 0의 무압축 첫 엔트리여야 합니다. */
function checkHwpx(entries: Map<string, ZipEntry>): void {
  for (const required of ["Contents/content.hpf", "Contents/header.xml"]) {
    if (!entries.has(required)) reject();
  }
  const hasSection = [...entries.keys()].some((name) => /^Contents\/section\d+\.xml$/.test(name));
  if (!hasSection) reject();
}

/** PPTX 필수 구조와 매크로 여부를 확인합니다. 발표자료가 아닌 OOXML은 미지원으로 거부합니다. */
function checkOfficeOpenXml(
  bytes: Uint8Array,
  entries: ZipEntry[],
  contentTypes: ZipEntry,
): DetectionResult {
  // 매크로 프로젝트 파트는 경로와 무관하게 발견되면 거부합니다.
  if (entries.some((entry) => /(^|\/)vbaProject\.bin$/i.test(entry.name))) return fail("MACRO");
  const overrides = parseOverrides(decodeXml(readEntry(bytes, contentTypes)));
  if (overrides.some((override) => override.contentType.toLowerCase().includes("macroenabled")))
    return fail("MACRO");
  // OPC 파트 이름은 대소문자를 구분하지 않습니다.
  const presentation = overrides.find(
    (override) => override.partName.toLowerCase() === "/ppt/presentation.xml",
  );
  if (!presentation) return fail("UNSUPPORTED");
  if (presentation.contentType === PPTM_MAIN_CONTENT_TYPE) return fail("MACRO");
  // 슬라이드쇼(.ppsx)·서식(.potx) 등 다른 본문 형식은 받지 않습니다.
  if (presentation.contentType !== PPTX_MAIN_CONTENT_TYPE) return fail("UNSUPPORTED");
  const lowerNames = new Set(entries.map((entry) => entry.name.toLowerCase()));
  if (!lowerNames.has("_rels/.rels") || !lowerNames.has("ppt/presentation.xml"))
    return fail("MALFORMED");
  return { ok: true, format: "PPTX" };
}

/**
 * ZIP 원본을 검증하고 HWPX/PPTX 형식을 판별합니다.
 * 실패 시 예외 대신 사유 코드를 반환합니다.
 */
export function detectZipDocument(bytes: Uint8Array): DetectionResult {
  try {
    const view = viewOf(bytes);
    const entries = readCentralDirectory(bytes, view);
    const byName = new Map(entries.map((entry) => [entry.name, entry]));

    // HWPX: 오프셋 0의 첫 엔트리가 무압축 `mimetype`이고 내용이 정확히 application/hwp+zip
    const first = entries.find((entry) => entry.localOffset === 0);
    if (first && first.name === "mimetype") {
      // 길이를 먼저 비교해 큰 엔트리를 읽지 않고, 내용은 바이트 단위로 정확히 비교합니다.
      if (first.method !== METHOD_STORED || first.uncompressedSize !== HWPX_MIMETYPE.length)
        return fail("UNSUPPORTED");
      const mimetype = readEntry(bytes, first);
      if (mimetype.some((byte, at) => byte !== HWPX_MIMETYPE.charCodeAt(at)))
        return fail("UNSUPPORTED");
      checkHwpx(byName);
      return { ok: true, format: "HWPX" };
    }

    // OOXML: `[Content_Types].xml`이 있으면 PPTX 여부와 매크로를 판별합니다.
    const contentTypes = entries.find(
      (entry) => entry.name.toLowerCase() === "[content_types].xml",
    );
    if (contentTypes) return checkOfficeOpenXml(bytes, entries, contentTypes);

    // 그 밖의 일반 ZIP은 문서로 받지 않습니다.
    return fail("UNSUPPORTED");
  } catch (error) {
    if (error instanceof ZipFailure) return fail(error.reason);
    // DataView 범위 오류 등 예상하지 못한 오류도 던지지 않고 손상 파일로 처리합니다.
    return fail("MALFORMED");
  }
}
