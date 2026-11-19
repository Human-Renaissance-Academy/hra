/**
 * CFB(Compound File Binary, OLE2) 기반 과제 문서 구조 검증 (#516 PR-B)
 *
 * 역할:
 * - HWP 5.0과 PowerPoint 97-2003(PPT) 원본이 공통으로 쓰는 CFB 컨테이너를 외부 의존성 없이 읽습니다.
 * - 헤더·DIFAT·FAT·디렉터리·미니 FAT·미니 스트림을 모두 범위 검사하며 따라가고,
 *   순환 체인과 과도한 섹터 수를 사유 코드로 거부합니다. 잘못된 입력에도 예외를 던지지 않습니다.
 * - 루트 저장소의 스트림 이름으로 HWP·PPT·암호화 OOXML·기타(DOC·XLS 등)를 구분합니다.
 *
 * 사용 위치: `detect.ts`의 `detectDocumentFormat()`이 CFB 시그니처를 만나면 호출합니다.
 *
 * 근거(공개 명세):
 * - [MS-CFB] Compound File Binary File Format: 헤더 512바이트, 주 버전 3은 섹터 512바이트(shift 9),
 *   주 버전 4는 섹터 4096바이트(shift 12), 미니 섹터 64바이트(shift 6), 미니 스트림 기준 4096바이트.
 * - 한글 문서 파일 형식 5.0(한글과컴퓨터 공개 문서): `FileHeader` 스트림 256바이트,
 *   0~31 서명 "HWP Document File", 32~35 버전, 36~39 속성 DWORD.
 *   속성 bit 0 압축, bit 1 암호 설정, bit 2 배포용 문서, bit 3 스크립트 저장, bit 4 DRM 보안 문서.
 *   → 기억에 기반한 해석이므로 실제 한컴 샘플(암호/DRM 문서)로 확인이 필요합니다.
 * - [MS-PPT]: 루트에 `PowerPoint Document`와 `Current User` 스트림이 있어야 합니다.
 * - [MS-OFFCRYPTO]: 암호화된 OOXML은 CFB 안에 `EncryptionInfo`/`EncryptedPackage` 스트림으로 저장됩니다.
 *
 * 미탐지(한계, 후속 과제):
 * - PPT RC4 CryptoAPI 암호화는 `EncryptedSummary` 스트림만 확인합니다. 이 스트림 없이
 *   `PowerPoint Document` 내부 CryptSession10Container만 있는 경우는 탐지하지 않습니다.
 * - `PowerPoint Document` 스트림 안의 VBA 레코드, OLE 개체 임베드는 해석하지 않습니다.
 *   서버는 업로드 문서를 렌더링·실행하지 않으며 다운로드는 attachment로만 제공합니다.
 */
import {
  type DetectionResult,
  type DocumentFormatReason,
  fail,
  startsWithAt,
  viewOf,
  CFB_SIGNATURE,
} from "./types";

/** CFB 특수 섹터 번호 */
const MAX_REGULAR_SECTOR = 0xfffffffa;
const END_OF_CHAIN = 0xfffffffe;
const NO_STREAM = 0xffffffff;

/** 헤더 고정 크기와 DIFAT 배열 정보 */
const HEADER_BYTES = 512;
const HEADER_DIFAT_ENTRIES = 109;
const DIRECTORY_ENTRY_BYTES = 128;
/** 디렉터리 엔트리 상한. 과제 문서에 필요한 수준을 넉넉히 넘는 값입니다. */
const MAX_DIRECTORY_ENTRIES = 4096;
/** 미니 스트림 기준 크기와 미니 섹터 크기(명세 고정값) */
const MINI_STREAM_CUTOFF = 4096;
const MINI_SECTOR_BYTES = 64;

/** 디렉터리 엔트리 객체 유형 */
const OBJECT_STORAGE = 1;
const OBJECT_STREAM = 2;
const OBJECT_ROOT = 5;

/** HWP FileHeader 서명과 속성 비트 */
const HWP_SIGNATURE = "HWP Document File";
const HWP_PROPERTY_PASSWORD = 1 << 1;
/**
 * bit 2(배포용 문서)는 의도적으로 허용합니다. 배포용 문서는 본문이 `ViewText`에 보관되며
 * 한글에서 열람은 가능하므로 제출물로 받되, 서버는 내용을 해석하지 않습니다.
 */
const HWP_PROPERTY_SCRIPT = 1 << 3;
const HWP_PROPERTY_DRM = 1 << 4;
/** 서명(32) + 버전(4) + 속성(4)까지 읽을 수 있어야 합니다. */
const HWP_FILE_HEADER_MIN_BYTES = 40;

/**
 * HWP 기본 `Scripts` 저장소의 두 스트림 이름과 크기 상한(명세 기억 기반의 가정).
 * 한글은 사용자 스크립트가 없어도 `DefaultJScript`(압축된 빈 기본 스크립트, 수십 바이트)와
 * `JScriptVersion`(버전 정보, 수 바이트)을 담은 `Scripts`를 기본으로 저장하는 것으로 알려져 있습니다.
 * → 실제 한컴 샘플로 확인이 필요합니다. 상한은 보수적으로 잡아, 이를 넘으면 실행 가능한
 *   스크립트가 들어 있을 수 있다고 보고 거부합니다.
 */
const HWP_DEFAULT_SCRIPT_LIMITS = new Map<string, number>([
  ["DEFAULTJSCRIPT", 1024],
  ["JSCRIPTVERSION", 64],
]);

/** 다른 Office 형식(DOC·XLS)의 루트 이름. HWP·PPT와 공존하면 폴리글랏으로 보고 거부합니다. */
const FOREIGN_ROOT_NAMES = ["WordDocument", "Workbook", "Book"] as const;
/** VBA 매크로 저장소 이름(PPT의 `_VBA_PROJECT_CUR`, 일부 저장본의 `Macros`/`VBA`) */
const MACRO_ROOT_NAMES = ["_VBA_PROJECT_CUR", "Macros", "VBA"] as const;

/** 파싱 중 실패를 전달하기 위한 내부 예외. 모듈 밖으로 새지 않고 사유 코드로 변환됩니다. */
class CfbFailure {
  constructor(readonly reason: DocumentFormatReason) {}
}
function reject(reason: DocumentFormatReason = "MALFORMED"): never {
  throw new CfbFailure(reason);
}

/** 디렉터리 엔트리 중 판별에 필요한 필드 */
interface DirectoryEntry {
  name: string;
  type: number;
  left: number;
  right: number;
  child: number;
  start: number;
  size: number;
}

/** 헤더를 읽은 뒤 공유하는 파서 상태 */
interface CfbContext {
  bytes: Uint8Array;
  view: DataView;
  sectorSize: number;
  sectorCount: number;
  fat: Uint32Array;
}

/** 섹터 번호의 파일 내 시작 오프셋. 헤더가 섹터 하나 크기를 차지하므로 (번호+1)×크기입니다. */
function sectorOffset(context: CfbContext, sector: number): number {
  return (sector + 1) * context.sectorSize;
}

/** 일반 섹터 번호가 파일 안의 완전한 섹터인지 확인합니다. */
function assertSector(context: CfbContext, sector: number): void {
  if (sector > MAX_REGULAR_SECTOR || sector >= context.sectorCount) reject();
}

/**
 * FAT 체인을 따라 섹터 번호 목록을 만듭니다.
 * - 각 섹터 번호를 범위 검사하고, 방문 표시로 순환을 거부합니다.
 * - 방문 표시 배열 크기가 곧 섹터 수 상한이므로 체인 길이는 파일 섹터 수를 넘지 못합니다.
 */
function followChain(context: CfbContext, start: number): number[] {
  const chain: number[] = [];
  const visited = new Uint8Array(context.sectorCount);
  let sector = start;
  while (sector !== END_OF_CHAIN) {
    assertSector(context, sector);
    if (visited[sector]) reject();
    visited[sector] = 1;
    chain.push(sector);
    if (sector >= context.fat.length) reject();
    sector = context.fat[sector];
  }
  return chain;
}

/**
 * 헤더의 DIFAT 배열과 DIFAT 섹터 체인을 읽어 FAT 섹터 번호를 모읍니다.
 * DIFAT 섹터 마지막 4바이트는 다음 DIFAT 섹터 번호입니다.
 */
function readFatSectorList(
  context: Omit<CfbContext, "fat">,
  fatSectorCount: number,
  firstDifat: number,
  difatSectorCount: number,
): number[] {
  const { view, sectorSize, sectorCount } = context;
  const result: number[] = [];
  for (let index = 0; index < HEADER_DIFAT_ENTRIES && result.length < fatSectorCount; index += 1) {
    result.push(view.getUint32(76 + index * 4, true));
  }
  const perDifatSector = sectorSize / 4 - 1;
  const visited = new Uint8Array(sectorCount);
  let sector = firstDifat;
  let readDifatSectors = 0;
  while (result.length < fatSectorCount) {
    // 헤더가 선언한 DIFAT 섹터 수를 넘기거나 체인이 끝나면 FAT 목록이 부족한 손상 파일입니다.
    if (readDifatSectors >= difatSectorCount) reject();
    if (sector > MAX_REGULAR_SECTOR || sector >= sectorCount || visited[sector]) reject();
    visited[sector] = 1;
    readDifatSectors += 1;
    const base = (sector + 1) * sectorSize;
    for (let index = 0; index < perDifatSector && result.length < fatSectorCount; index += 1) {
      result.push(view.getUint32(base + index * 4, true));
    }
    sector = view.getUint32(base + perDifatSector * 4, true);
  }
  return result;
}

/** 헤더를 검증하고 FAT까지 읽은 파서 상태를 만듭니다. */
function openContainer(bytes: Uint8Array): { context: CfbContext; header: DataView } {
  if (bytes.length < HEADER_BYTES || !startsWithAt(bytes, 0, CFB_SIGNATURE)) reject();
  const view = viewOf(bytes);
  const majorVersion = view.getUint16(26, true);
  const byteOrder = view.getUint16(28, true);
  const sectorShift = view.getUint16(30, true);
  const miniSectorShift = view.getUint16(32, true);
  // 주 버전 3은 shift 9, 주 버전 4는 shift 12만 허용합니다. 다른 조합은 손상 또는 비표준입니다.
  if (byteOrder !== 0xfffe) reject();
  if (!((majorVersion === 3 && sectorShift === 9) || (majorVersion === 4 && sectorShift === 12)))
    reject();
  if (miniSectorShift !== 6) reject();
  if (view.getUint32(56, true) !== MINI_STREAM_CUTOFF) reject();
  const sectorSize = 1 << sectorShift;
  if (bytes.length < sectorSize) reject();
  // 마지막 불완전 섹터는 읽지 않습니다. 완전한 섹터만 유효 범위로 봅니다.
  const sectorCount = Math.floor((bytes.length - sectorSize) / sectorSize);
  if (sectorCount < 1) reject();

  const fatSectorCount = view.getUint32(44, true);
  const firstDifat = view.getUint32(68, true);
  const difatSectorCount = view.getUint32(72, true);
  // FAT 섹터 하나는 (섹터 크기/4)개 섹터를 기술하므로 필요한 수보다 많은 선언은 손상으로 봅니다.
  const maxFatSectors = Math.ceil(sectorCount / (sectorSize / 4)) + 1;
  if (fatSectorCount < 1 || fatSectorCount > maxFatSectors) reject();
  if (difatSectorCount > sectorCount) reject();

  const base = { bytes, view, sectorSize, sectorCount };
  const fatSectors = readFatSectorList(base, fatSectorCount, firstDifat, difatSectorCount);
  const entriesPerSector = sectorSize / 4;
  const fat = new Uint32Array(fatSectorCount * entriesPerSector);
  const seen = new Uint8Array(sectorCount);
  fatSectors.forEach((sector, sectorIndex) => {
    if (sector > MAX_REGULAR_SECTOR || sector >= sectorCount || seen[sector]) reject();
    seen[sector] = 1;
    const offset = (sector + 1) * sectorSize;
    for (let index = 0; index < entriesPerSector; index += 1) {
      fat[sectorIndex * entriesPerSector + index] = view.getUint32(offset + index * 4, true);
    }
  });
  return { context: { ...base, fat }, header: view };
}

/** UTF-16LE 디렉터리 이름을 읽습니다. 길이 필드는 종료 NUL을 포함한 바이트 수입니다. */
function readEntryName(view: DataView, offset: number): string {
  const nameBytes = view.getUint16(offset + 64, true);
  if (nameBytes === 0) return "";
  if (nameBytes > 64 || nameBytes % 2 !== 0) reject();
  let name = "";
  for (let index = 0; index < nameBytes / 2 - 1; index += 1) {
    name += String.fromCharCode(view.getUint16(offset + index * 2, true));
  }
  // 종료 문자 위치가 NUL이 아니면 길이 필드와 이름이 모순됩니다.
  if (view.getUint16(offset + nameBytes - 2, true) !== 0) reject();
  return name;
}

/** 디렉터리 체인을 읽어 엔트리 배열을 만듭니다(최대 4096개). */
function readDirectory(context: CfbContext, firstDirectorySector: number, majorVersion: number) {
  const chain = followChain(context, firstDirectorySector);
  const perSector = context.sectorSize / DIRECTORY_ENTRY_BYTES;
  if (chain.length * perSector > MAX_DIRECTORY_ENTRIES) reject();
  const entries: DirectoryEntry[] = [];
  for (const sector of chain) {
    for (let index = 0; index < perSector; index += 1) {
      const offset = sectorOffset(context, sector) + index * DIRECTORY_ENTRY_BYTES;
      const type = context.bytes[offset + 66];
      const sizeLow = context.view.getUint32(offset + 120, true);
      const sizeHigh = context.view.getUint32(offset + 124, true);
      // 주 버전 3은 상위 32비트가 정의되지 않아 무시하고, 버전 4는 50MiB 상한 때문에 0이어야 합니다.
      if (majorVersion === 4 && sizeHigh !== 0) reject();
      entries.push({
        name: type === 0 ? "" : readEntryName(context.view, offset),
        type,
        left: context.view.getUint32(offset + 68, true),
        right: context.view.getUint32(offset + 72, true),
        child: context.view.getUint32(offset + 76, true),
        start: context.view.getUint32(offset + 116, true),
        size: sizeLow,
      });
    }
  }
  return entries;
}

/**
 * 루트 저장소의 직계 자식(레드블랙 트리)을 순회해 대문자 이름 → 엔트리 맵을 만듭니다.
 * CFB 이름 비교는 대소문자를 구분하지 않으므로 대문자로 정규화하고, 같은 이름 중복은 손상으로 봅니다.
 */
function rootChildren(entries: DirectoryEntry[]): Map<string, DirectoryEntry> {
  return childrenOf(entries, entries[0]);
}

/** 저장소 엔트리(루트 포함)의 직계 자식 맵. 순회·중복 규칙은 `rootChildren`과 같습니다. */
function childrenOf(
  entries: DirectoryEntry[],
  parent: DirectoryEntry,
): Map<string, DirectoryEntry> {
  const children = new Map<string, DirectoryEntry>();
  const visited = new Uint8Array(entries.length);
  const stack = [parent.child];
  while (stack.length > 0) {
    const id = stack.pop() as number;
    if (id === NO_STREAM) continue;
    if (id >= entries.length || id === 0 || visited[id]) reject();
    visited[id] = 1;
    const entry = entries[id];
    if (entry.type !== OBJECT_STREAM && entry.type !== OBJECT_STORAGE) reject();
    const key = entry.name.toUpperCase();
    if (key === "" || children.has(key)) reject();
    children.set(key, entry);
    stack.push(entry.left, entry.right);
  }
  return children;
}

/**
 * 스트림의 앞부분 `limit` 바이트를 읽습니다.
 * - 4096바이트 미만 스트림은 미니 FAT/미니 스트림(루트 엔트리의 일반 섹터 체인)에서 읽습니다.
 * - 체인 전체를 끝까지 따라가 스트림 크기만큼 섹터가 있는지 확인한 뒤 필요한 부분만 복사합니다.
 */
function readStreamPrefix(
  context: CfbContext,
  header: DataView,
  root: DirectoryEntry,
  entry: DirectoryEntry,
  limit: number,
): Uint8Array {
  const length = Math.min(entry.size, limit);
  const output = new Uint8Array(length);
  if (entry.size >= MINI_STREAM_CUTOFF) {
    const chain = followChain(context, entry.start);
    if (chain.length * context.sectorSize < entry.size) reject();
    for (let copied = 0; copied < length; ) {
      const sector = chain[Math.floor(copied / context.sectorSize)];
      const within = copied % context.sectorSize;
      const take = Math.min(context.sectorSize - within, length - copied);
      const from = sectorOffset(context, sector) + within;
      output.set(context.bytes.subarray(from, from + take), copied);
      copied += take;
    }
    return output;
  }
  if (entry.size === 0) return output;

  // 미니 FAT: 헤더가 가리키는 일반 섹터 체인에 4바이트 항목으로 저장됩니다.
  const miniFatChain = followChain(context, header.getUint32(60, true));
  if (miniFatChain.length !== header.getUint32(64, true)) reject();
  const perSector = context.sectorSize / 4;
  const miniFat = new Uint32Array(miniFatChain.length * perSector);
  miniFatChain.forEach((sector, sectorIndex) => {
    for (let index = 0; index < perSector; index += 1) {
      miniFat[sectorIndex * perSector + index] = context.view.getUint32(
        sectorOffset(context, sector) + index * 4,
        true,
      );
    }
  });
  // 미니 스트림 자체는 루트 엔트리의 시작 섹터와 크기로 정의됩니다.
  const rootChain = followChain(context, root.start);
  if (rootChain.length * context.sectorSize < root.size) reject();
  const miniSectorCount = Math.floor(root.size / MINI_SECTOR_BYTES);
  const visited = new Uint8Array(Math.min(miniFat.length, miniSectorCount));
  const miniChain: number[] = [];
  for (let sector = entry.start; sector !== END_OF_CHAIN; sector = miniFat[sector]) {
    if (sector >= visited.length || visited[sector]) reject();
    visited[sector] = 1;
    miniChain.push(sector);
  }
  if (miniChain.length * MINI_SECTOR_BYTES < entry.size) reject();
  for (let copied = 0; copied < length; ) {
    const miniSector = miniChain[Math.floor(copied / MINI_SECTOR_BYTES)];
    const within = copied % MINI_SECTOR_BYTES;
    const take = Math.min(MINI_SECTOR_BYTES - within, length - copied);
    // 미니 스트림 안의 위치를 루트 체인의 실제 파일 오프셋으로 변환합니다.
    const streamOffset = miniSector * MINI_SECTOR_BYTES + within;
    const sector = rootChain[Math.floor(streamOffset / context.sectorSize)];
    const from = sectorOffset(context, sector) + (streamOffset % context.sectorSize);
    output.set(context.bytes.subarray(from, from + take), copied);
    copied += take;
  }
  return output;
}

/** HWP FileHeader의 서명과 암호/DRM 속성을 검사합니다. */
function checkHwpFileHeader(fileHeader: Uint8Array): void {
  if (fileHeader.length < HWP_FILE_HEADER_MIN_BYTES) reject();
  for (let index = 0; index < HWP_SIGNATURE.length; index += 1) {
    if (fileHeader[index] !== HWP_SIGNATURE.charCodeAt(index)) reject();
  }
  const properties = viewOf(fileHeader).getUint32(36, true);
  // 암호 설정 문서와 DRM 보안 문서는 서버나 검토자가 열 수 없으므로 암호화로 거부합니다.
  if (properties & (HWP_PROPERTY_PASSWORD | HWP_PROPERTY_DRM)) reject("ENCRYPTED");
  // 스크립트가 저장된 문서는 실행 콘텐츠를 포함하므로 매크로로 거부합니다.
  if (properties & HWP_PROPERTY_SCRIPT) reject("MACRO");
}

/**
 * CFB 원본을 검증하고 HWP/PPT 형식을 판별합니다.
 * 실패 시 예외 대신 사유 코드를 반환합니다.
 */
export function detectCfbDocument(bytes: Uint8Array): DetectionResult {
  try {
    const { context, header } = openContainer(bytes);
    const majorVersion = header.getUint16(26, true);
    const entries = readDirectory(context, header.getUint32(48, true), majorVersion);
    const root = entries[0];
    if (!root || root.type !== OBJECT_ROOT) reject();
    const children = rootChildren(entries);
    const stream = (name: string) => {
      const entry = children.get(name.toUpperCase());
      return entry && entry.type === OBJECT_STREAM ? entry : undefined;
    };
    const storage = (name: string) => children.get(name.toUpperCase())?.type === OBJECT_STORAGE;
    const has = (names: readonly string[]) =>
      names.some((name) => children.has(name.toUpperCase()));

    // 1) 암호화된 OOXML(PPTX·DOCX 등)은 CFB로 감싸지므로 내용 확인 없이 암호화로 거부합니다.
    if (has(["EncryptionInfo", "EncryptedPackage"])) return fail("ENCRYPTED");
    // 2) 다른 Office 형식의 루트 스트림이 섞이면 어느 판독기로 여느냐에 따라 해석이 갈리므로 거부합니다.
    if (has(FOREIGN_ROOT_NAMES)) return fail("UNSUPPORTED");
    // 3) VBA 프로젝트 저장소는 실행 콘텐츠이므로 매크로로 거부합니다.
    if (has(MACRO_ROOT_NAMES)) return fail("MACRO");
    const hwpMarkers = has(["FileHeader", "DocInfo", "BodyText", "ViewText"]);
    const pptMarkers = has(["PowerPoint Document", "Current User"]);
    if (hwpMarkers && pptMarkers) return fail("UNSUPPORTED");

    // 4) HWP: FileHeader·DocInfo 스트림과 BodyText 또는 ViewText(배포용) 저장소가 모두 있어야 합니다.
    if (hwpMarkers) {
      const fileHeader = stream("FileHeader");
      if (!fileHeader || !stream("DocInfo") || !(storage("BodyText") || storage("ViewText")))
        return fail("MALFORMED");
      checkHwpFileHeader(readStreamPrefix(context, header, root, fileHeader, 256));
      // 스크립트 저장 속성(bit 3)은 위에서 이미 거부했습니다. 속성 없이 `Scripts` 저장소가 있으면
      // 기본 두 스트림(작은 크기)만 허용하고, 그 밖의 내용은 실행 콘텐츠로 보아 거부합니다.
      const scripts = children.get("SCRIPTS");
      if (scripts) {
        if (scripts.type !== OBJECT_STORAGE) return fail("MACRO");
        for (const [name, child] of childrenOf(entries, scripts)) {
          const limit = HWP_DEFAULT_SCRIPT_LIMITS.get(name);
          if (limit === undefined || child.type !== OBJECT_STREAM || child.size > limit)
            return fail("MACRO");
        }
      }
      return { ok: true, format: "HWP" };
    }
    // 5) PPT: 두 필수 스트림이 있어야 하며, RC4 CryptoAPI 암호화 문서에 흔한
    //    `EncryptedSummary` 스트림이 있으면 암호화로 거부합니다.
    if (pptMarkers) {
      if (!stream("PowerPoint Document") || !stream("Current User")) return fail("UNSUPPORTED");
      if (has(["EncryptedSummary"])) return fail("ENCRYPTED");
      return { ok: true, format: "PPT" };
    }
    // DOC·XLS·MSI 등 다른 CFB 문서는 과제 형식이 아닙니다.
    return fail("UNSUPPORTED");
  } catch (error) {
    if (error instanceof CfbFailure) return fail(error.reason);
    // 범위 검사 누락으로 DataView가 RangeError를 내는 등 예상하지 못한 오류도
    // 밖으로 던지지 않고 손상 파일로 처리합니다(잘못된 입력에 예외를 던지지 않는다는 계약).
    return fail("MALFORMED");
  }
}
