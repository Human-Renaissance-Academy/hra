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
/** 해제 대상 엔트리의 압축 크기 상한: 출력 상한 + 작은 여유(무압축 블록 헤더 등) */
const MAX_INFLATE_INPUT_BYTES = MAX_INFLATED_ENTRY_BYTES + 64 * 1024;
/** XML 스캐너 상한: `Default`/`Override` 요소 수, 속성 이름·값 길이, 태그 이름 길이 */
const MAX_XML_ELEMENTS = 4096;
const MAX_XML_ATTRIBUTE_NAME = 256;
const MAX_XML_ATTRIBUTE_VALUE = 4096;
const MAX_XML_TAG_NAME = 256;
/** 데이터 서술자 시그니처(선택 사항) */
const DATA_DESCRIPTOR = 0x08074b50;
/** Info-ZIP Unicode Path 추가 필드 ID. 중앙 디렉터리 이름과 다른 이름을 숨길 수 있어 거부합니다. */
const EXTRA_UNICODE_PATH = 0x7075;
/** 생성 호스트 3(Unix)의 외부 속성 상위 16비트 파일 형식 중 심볼릭 링크(S_IFLNK) */
const HOST_UNIX = 3;
const UNIX_FILE_TYPE_MASK = 0xf000;
const UNIX_SYMLINK = 0xa000;

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

/** 세그먼트 끝의 공백·점을 제거합니다(Windows 경로 정규화 모사). 정규식 역추적을 피하려고 반복문을 씁니다. */
function trimTrailingDotsAndSpaces(segment: string): string {
  let end = segment.length;
  while (end > 0 && (segment[end - 1] === " " || segment[end - 1] === ".")) end -= 1;
  return segment.slice(0, end);
}

/**
 * 압축 해제 시 파일 시스템 밖을 가리키거나 판독기마다 다르게 해석될 수 있는 이름을 거부합니다.
 * - NUL·역슬래시·콜론(드라이브 문자, NTFS 대체 스트림)·선행 `/`
 * - 빈 세그먼트(`a//b`), `.`·`..` 세그먼트, 끝의 공백·점을 지우면 비거나 `..`가 되는 세그먼트
 *   (마지막 세그먼트가 빈 경우는 디렉터리 엔트리 `dir/`이므로 허용합니다)
 */
function assertSafeName(name: string): void {
  if (name.length === 0) reject();
  if (name.includes("\0") || name.includes("\\") || name.includes(":") || name.startsWith("/"))
    reject("PATH_TRAVERSAL");
  const segments = name.split("/");
  segments.forEach((segment, index) => {
    if (segment === "" && index === segments.length - 1 && index > 0) return;
    const trimmed = trimTrailingDotsAndSpaces(segment);
    if (trimmed === "" || trimmed === "..") reject("PATH_TRAVERSAL");
  });
}

/** 중앙 디렉터리 추가 필드를 범위 검사하며 순회하고, 허용하지 않는 필드를 거부합니다. */
function assertExtraFields(view: DataView, start: number, length: number): void {
  let cursor = start;
  const end = start + length;
  while (cursor < end) {
    if (cursor + 4 > end) reject();
    const id = view.getUint16(cursor, true);
    const size = view.getUint16(cursor + 2, true);
    if (cursor + 4 + size > end) reject();
    if (id === EXTRA_UNICODE_PATH) reject("UNSUPPORTED");
    cursor += 4 + size;
  }
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
    const versionMadeBy = view.getUint16(cursor + 4, true);
    const flags = view.getUint16(cursor + 8, true);
    const method = view.getUint16(cursor + 10, true);
    const crc = view.getUint32(cursor + 16, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const diskStart = view.getUint16(cursor + 34, true);
    const externalAttributes = view.getUint32(cursor + 38, true);
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
    assertExtraFields(view, cursor + CENTRAL_HEADER_BYTES + nameLength, extraLength);
    // Unix에서 만든 심볼릭 링크 엔트리는 해제 시 임의 경로를 가리킬 수 있으므로 거부합니다.
    if (
      versionMadeBy >>> 8 === HOST_UNIX &&
      ((externalAttributes >>> 16) & UNIX_FILE_TYPE_MASK) === UNIX_SYMLINK
    )
      reject("PATH_TRAVERSAL");
    // 유니코드 정규화(NFC) 후 대소문자를 무시해 중복을 비교합니다(조합형/완성형 한글 이름 우회 방지).
    const key = name.normalize("NFC").toLowerCase();
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
 * - 엔트리는 빈틈 없이 연속해야 합니다. 각 엔트리 끝(헤더+이름+추가 필드+압축 데이터+데이터 서술자)이
 *   다음 엔트리 시작과 같고, 마지막 엔트리 끝은 중앙 디렉터리 시작과 같아야 합니다.
 *   겹침 기반 압축 폭탄과 엔트리 사이에 다른 형식을 숨기는 폴리글랏을 함께 막습니다.
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
    const next = index + 1 < ordered.length ? ordered[index + 1].localOffset : directoryOffset;
    if (dataEnd > next) reject();
    const gap = next - dataEnd;
    if (!deferred) {
      if (gap !== 0) reject("POLYGLOT");
      return;
    }
    // 데이터 서술자: 시그니처 없는 12바이트(CRC·압축 크기·원본 크기) 또는 시그니처 포함 16바이트.
    // ZIP64는 거부하므로 24바이트 형식은 받지 않습니다. 내용은 중앙 디렉터리 값과 같아야 합니다.
    let descriptor = dataEnd;
    if (gap === 16 && view.getUint32(dataEnd, true) === DATA_DESCRIPTOR) descriptor += 4;
    else if (gap !== 12) reject("POLYGLOT");
    if (
      view.getUint32(descriptor, true) !== entry.crc ||
      view.getUint32(descriptor + 4, true) !== entry.compressedSize ||
      view.getUint32(descriptor + 8, true) !== entry.uncompressedSize
    )
      reject();
  });
}

/**
 * 필수 엔트리 하나를 1MiB 상한으로 해제하고 크기·CRC를 확인합니다.
 * stored 엔트리는 압축/원본 크기가 같아야 하며 그대로 복사합니다.
 */
function readEntry(bytes: Uint8Array, entry: ZipEntry): Uint8Array {
  if (entry.uncompressedSize > MAX_INFLATED_ENTRY_BYTES) reject("ZIP_LIMIT");
  if (entry.compressedSize > MAX_INFLATE_INPUT_BYTES) reject("ZIP_LIMIT");
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

/** 공백 문자(XML S 생성 규칙) 여부 */
function isXmlSpace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r";
}

/** `[Content_Types].xml`의 `Default`·`Override` 요소 하나 */
interface ContentTypeElement {
  kind: "Default" | "Override";
  attributes: Map<string, string>;
}

/**
 * 태그 하나의 속성을 왼쪽에서 오른쪽으로 한 번만 훑어 읽습니다.
 * 정규식을 쓰지 않으므로 태그 길이에 선형 시간이며, 이름·값 길이 상한을 넘거나 문법이 틀리면 손상으로 봅니다.
 */
function parseAttributes(tag: string, start: number): Map<string, string> {
  const attributes = new Map<string, string>();
  let cursor = start;
  for (;;) {
    while (cursor < tag.length && isXmlSpace(tag[cursor])) cursor += 1;
    if (cursor >= tag.length || tag[cursor] === "/") return attributes;
    // 속성 이름: 공백·`=`·`/` 전까지, 길이 상한 적용
    const nameStart = cursor;
    while (
      cursor < tag.length &&
      !isXmlSpace(tag[cursor]) &&
      tag[cursor] !== "=" &&
      tag[cursor] !== "/"
    ) {
      cursor += 1;
      if (cursor - nameStart > MAX_XML_ATTRIBUTE_NAME) reject();
    }
    const name = tag.slice(nameStart, cursor);
    if (name === "") reject();
    while (cursor < tag.length && isXmlSpace(tag[cursor])) cursor += 1;
    if (tag[cursor] !== "=") reject();
    cursor += 1;
    while (cursor < tag.length && isXmlSpace(tag[cursor])) cursor += 1;
    // 속성 값: 같은 따옴표가 다시 나올 때까지. indexOf는 태그 안에서만 한 번 수행됩니다.
    const quote = tag[cursor];
    if (quote !== '"' && quote !== "'") reject();
    const valueEnd = tag.indexOf(quote, cursor + 1);
    if (valueEnd === -1 || valueEnd - cursor - 1 > MAX_XML_ATTRIBUTE_VALUE) reject();
    if (attributes.has(name)) reject();
    attributes.set(name, tag.slice(cursor + 1, valueEnd));
    cursor = valueEnd + 1;
  }
}

/**
 * `[Content_Types].xml`에서 `Default`·`Override` 요소만 선형 스캔으로 추출합니다.
 * - `<`와 `>`를 indexOf로 찾고 닫히지 않은 태그는 손상으로 거부합니다(입력 전체를 한 번만 순회).
 * - 처리 명령(`<?`), 주석·선언(`<!`), 닫는 태그(`</`)는 건너뜁니다.
 * - 요소 수는 4096개까지 허용합니다.
 * 정규식 역추적에 의한 서비스 거부(ReDoS)를 피하려고 정규식 없이 구현합니다.
 */
function scanContentTypes(xml: string): ContentTypeElement[] {
  const elements: ContentTypeElement[] = [];
  let cursor = 0;
  for (;;) {
    const open = xml.indexOf("<", cursor);
    if (open === -1) return elements;
    const close = xml.indexOf(">", open + 1);
    if (close === -1) reject();
    cursor = close + 1;
    const tag = xml.slice(open + 1, close);
    if (tag === "" || tag[0] === "?" || tag[0] === "!" || tag[0] === "/") continue;
    // 태그 이름: 공백·`/` 전까지, 길이 상한 적용. 네임스페이스 접두어는 떼고 비교합니다.
    let nameEnd = 0;
    while (nameEnd < tag.length && !isXmlSpace(tag[nameEnd]) && tag[nameEnd] !== "/") {
      nameEnd += 1;
      if (nameEnd > MAX_XML_TAG_NAME) reject();
    }
    const qualified = tag.slice(0, nameEnd);
    const localName = qualified.slice(qualified.lastIndexOf(":") + 1);
    if (localName !== "Default" && localName !== "Override") continue;
    if (elements.length >= MAX_XML_ELEMENTS) reject("ZIP_LIMIT");
    elements.push({ kind: localName, attributes: parseAttributes(tag, nameEnd) });
  }
}

/**
 * HWPX 필수 구조와 실행 콘텐츠·암호화를 확인합니다. `mimetype`은 오프셋 0의 무압축 첫 엔트리여야 합니다.
 * 실제 한컴 샘플 확인 필요: `META-INF/manifest.xml`의 `encryption-data` 표기로 암호 문서를 판별한다는
 * 가정은 ODF 매니페스트 관례를 따른 것입니다.
 */
function checkHwpx(bytes: Uint8Array, entries: ZipEntry[]): void {
  const names = new Set(entries.map((entry) => entry.name));
  for (const required of ["Contents/content.hpf", "Contents/header.xml"]) {
    if (!names.has(required)) reject();
  }
  const hasSection = entries.some((entry) => /^Contents\/section\d+\.xml$/.test(entry.name));
  if (!hasSection) reject();
  // 스크립트 디렉터리는 실행 콘텐츠이므로 매크로로 거부합니다.
  if (entries.some((entry) => entry.name.toLowerCase().startsWith("scripts/"))) reject("MACRO");
  // 매니페스트는 1MiB 상한으로만 해제하고, includes로 선형 검색합니다.
  const manifest = entries.find((entry) => entry.name.toLowerCase() === "meta-inf/manifest.xml");
  if (manifest && decodeXml(readEntry(bytes, manifest)).toLowerCase().includes("encryption-data"))
    reject("ENCRYPTED");
}

/**
 * PPTX 필수 구조와 매크로·ActiveX 여부를 확인합니다. 발표자료가 아닌 OOXML은 미지원으로 거부합니다.
 *
 * 미탐지(한계): OLE 개체 임베드(`ppt/embeddings/`)와 외부 관계(`TargetMode="External"`)는 허용합니다.
 * 서버는 문서를 렌더링·실행하지 않고 다운로드는 attachment로만 제공하므로 열람 프로그램의 보호에 맡깁니다.
 */
function checkOfficeOpenXml(
  bytes: Uint8Array,
  entries: ZipEntry[],
  contentTypes: ZipEntry,
): DetectionResult {
  // 매크로 프로젝트와 ActiveX 파트는 경로와 무관하게(대소문자 무시) 발견되면 거부합니다.
  const lowerNames = entries.map((entry) => entry.name.toLowerCase());
  if (lowerNames.some((name) => name === "vbaproject.bin" || name.endsWith("/vbaproject.bin")))
    return fail("MACRO");
  if (lowerNames.some((name) => name.startsWith("ppt/activex/"))) return fail("MACRO");
  const elements = scanContentTypes(decodeXml(readEntry(bytes, contentTypes)));
  // Default·Override의 모든 콘텐츠 형식에서 매크로·VBA·ActiveX 표식을 찾습니다.
  const executable = elements.some((element) => {
    const type = (element.attributes.get("ContentType") ?? "").toLowerCase();
    return type.includes("macroenabled") || type.includes("vbaproject") || type.includes("activex");
  });
  if (executable) return fail("MACRO");
  // OPC 파트 이름은 대소문자를 구분하지 않습니다.
  const presentation = elements.find(
    (element) =>
      element.kind === "Override" &&
      (element.attributes.get("PartName") ?? "").toLowerCase() === "/ppt/presentation.xml",
  );
  if (!presentation) return fail("UNSUPPORTED");
  const mainType = (presentation.attributes.get("ContentType") ?? "").trim();
  if (mainType === PPTM_MAIN_CONTENT_TYPE) return fail("MACRO");
  // 슬라이드쇼(.ppsx)·서식(.potx) 등 다른 본문 형식은 받지 않습니다.
  if (mainType !== PPTX_MAIN_CONTENT_TYPE) return fail("UNSUPPORTED");
  if (!lowerNames.includes("_rels/.rels") || !lowerNames.includes("ppt/presentation.xml"))
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

    // HWPX: 오프셋 0의 첫 엔트리가 무압축 `mimetype`이고 내용이 정확히 application/hwp+zip
    const first = entries.find((entry) => entry.localOffset === 0);
    if (first && first.name === "mimetype") {
      // 길이를 먼저 비교해 큰 엔트리를 읽지 않고, 내용은 바이트 단위로 정확히 비교합니다.
      if (first.method !== METHOD_STORED || first.uncompressedSize !== HWPX_MIMETYPE.length)
        return fail("UNSUPPORTED");
      const mimetype = readEntry(bytes, first);
      if (mimetype.some((byte, at) => byte !== HWPX_MIMETYPE.charCodeAt(at)))
        return fail("UNSUPPORTED");
      checkHwpx(bytes, entries);
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
