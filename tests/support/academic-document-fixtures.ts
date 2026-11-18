/**
 * 과제 문서 형식 탐지 테스트용 합성 원본 생성기 (#516 PR-B)
 *
 * 역할:
 * - 네트워크·실제 학생 파일·개인정보 없이 최소 구조의 PDF, CFB(HWP·PPT), ZIP(HWPX·PPTX)을 만듭니다.
 * - 작은 CFB(주 버전 3, 512바이트 섹터) 작성기와 ZIP 작성기(`node:zlib`의 deflateRawSync·crc32)를 포함합니다.
 * - 악성·손상 변형을 만들 수 있도록 섹터 배치 정보와 필드 덮어쓰기 옵션을 노출합니다.
 *
 * 주의: 이 합성 원본은 형식 판별 규칙의 회귀 검증용이며, 실제 한컴·PowerPoint 저장본 검증을 대신하지 않습니다.
 */
import { crc32, deflateRawSync } from "node:zlib";

const encoder = new TextEncoder();

/** 문자열 또는 바이트를 바이트로 통일합니다. */
function toBytes(data: Uint8Array | string): Uint8Array {
  return typeof data === "string" ? encoder.encode(data) : data;
}

/** 최소 PDF 원본 */
export function syntheticPdf(): Uint8Array {
  return encoder.encode(
    "%PDF-1.7\n%합성 과제 문서\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
  );
}

// ---------------------------------------------------------------------------
// CFB(OLE2) 작성기
// ---------------------------------------------------------------------------

const SECTOR = 512;
const MINI_SECTOR = 64;
const MINI_CUTOFF = 4096;
const END_OF_CHAIN = 0xfffffffe;
const FREE_SECTOR = 0xffffffff;
const FAT_SECTOR = 0xfffffffd;
const NO_STREAM = 0xffffffff;

/** 루트 저장소 바로 아래 스트림 하나 */
export interface CfbStreamInput {
  name: string;
  data: Uint8Array;
}

/** 작성된 CFB와 변형 테스트용 섹터 배치 정보 */
export interface CfbFixture {
  bytes: Uint8Array;
  fatSectors: number[];
  directorySectors: number[];
  miniFatSectors: number[];
}

/**
 * 주 버전 3 CFB를 만듭니다.
 * - 4096바이트 미만 스트림은 미니 스트림에, 이상은 일반 섹터에 저장합니다.
 * - 디렉터리 트리는 루트 child → 1번, 각 엔트리 right → 다음 엔트리로 단순 연결합니다.
 */
export function buildCfb(streams: CfbStreamInput[]): CfbFixture {
  const sectors: Uint8Array[] = [];
  const fat: number[] = [];
  // 데이터를 512바이트 섹터로 나눠 FAT 체인을 만들고 시작 섹터 번호를 돌려줍니다.
  const allocate = (data: Uint8Array): number[] => {
    const ids: number[] = [];
    for (let offset = 0; offset < data.length; offset += SECTOR) {
      const sector = new Uint8Array(SECTOR);
      sector.set(data.subarray(offset, offset + SECTOR));
      ids.push(sectors.length);
      sectors.push(sector);
      fat.push(END_OF_CHAIN);
    }
    ids.forEach((id, index) => {
      fat[id] = index + 1 < ids.length ? ids[index + 1] : END_OF_CHAIN;
    });
    return ids;
  };

  // 1) 작은 스트림을 64바이트 미니 섹터로 모읍니다.
  const miniFat: number[] = [];
  const miniChunks: Uint8Array[] = [];
  const starts = new Map<number, number>();
  streams.forEach((stream, index) => {
    if (stream.data.length >= MINI_CUTOFF || stream.data.length === 0) return;
    const count = Math.ceil(stream.data.length / MINI_SECTOR);
    const first = miniFat.length;
    for (let at = 0; at < count; at += 1) {
      miniFat.push(at + 1 < count ? first + at + 1 : END_OF_CHAIN);
      const chunk = new Uint8Array(MINI_SECTOR);
      chunk.set(stream.data.subarray(at * MINI_SECTOR, (at + 1) * MINI_SECTOR));
      miniChunks.push(chunk);
    }
    starts.set(index, first);
  });
  // 2) 큰 스트림은 일반 섹터에 저장합니다.
  streams.forEach((stream, index) => {
    if (stream.data.length >= MINI_CUTOFF) starts.set(index, allocate(stream.data)[0]);
  });
  // 3) 미니 스트림(루트 엔트리 데이터)과 미니 FAT
  const miniStream = new Uint8Array(miniChunks.length * MINI_SECTOR);
  miniChunks.forEach((chunk, index) => miniStream.set(chunk, index * MINI_SECTOR));
  const rootSectors = allocate(miniStream);
  const miniFatBytes = new Uint8Array(Math.ceil((miniFat.length * 4) / SECTOR) * SECTOR).fill(0xff);
  const miniFatView = new DataView(miniFatBytes.buffer);
  miniFat.forEach((value, index) => miniFatView.setUint32(index * 4, value, true));
  const miniFatSectors = allocate(miniFatBytes);

  // 4) 디렉터리: 루트 + 스트림, 4개 단위로 빈 엔트리를 채웁니다.
  const entryCount = Math.ceil((streams.length + 1) / 4) * 4;
  const directory = new Uint8Array(entryCount * 128);
  const directoryView = new DataView(directory.buffer);
  const writeEntry = (
    index: number,
    name: string,
    type: number,
    child: number,
    right: number,
    start: number,
    size: number,
  ) => {
    const base = index * 128;
    for (let at = 0; at < name.length; at += 1) {
      directoryView.setUint16(base + at * 2, name.charCodeAt(at), true);
    }
    directoryView.setUint16(base + 64, (name.length + 1) * 2, true);
    directory[base + 66] = type;
    directory[base + 67] = 1;
    directoryView.setUint32(base + 68, NO_STREAM, true);
    directoryView.setUint32(base + 72, right, true);
    directoryView.setUint32(base + 76, child, true);
    directoryView.setUint32(base + 116, start, true);
    directoryView.setUint32(base + 120, size, true);
  };
  for (let index = 0; index < entryCount; index += 1) {
    const base = index * 128;
    directoryView.setUint32(base + 68, NO_STREAM, true);
    directoryView.setUint32(base + 72, NO_STREAM, true);
    directoryView.setUint32(base + 76, NO_STREAM, true);
  }
  writeEntry(
    0,
    "Root Entry",
    5,
    streams.length > 0 ? 1 : NO_STREAM,
    NO_STREAM,
    rootSectors.length > 0 ? rootSectors[0] : END_OF_CHAIN,
    miniStream.length,
  );
  streams.forEach((stream, index) => {
    writeEntry(
      index + 1,
      stream.name,
      2,
      NO_STREAM,
      index + 1 < streams.length ? index + 2 : NO_STREAM,
      starts.get(index) ?? END_OF_CHAIN,
      stream.data.length,
    );
  });
  const directorySectors = allocate(directory);

  // 5) FAT 섹터 수를 정하고 FAT 자신을 FATSECT로 표시합니다.
  let fatCount = 1;
  while (fatCount * (SECTOR / 4) < sectors.length + fatCount) fatCount += 1;
  const fatSectors: number[] = [];
  for (let index = 0; index < fatCount; index += 1) {
    fatSectors.push(sectors.length);
    sectors.push(new Uint8Array(SECTOR));
    fat.push(FAT_SECTOR);
  }
  while (fat.length < fatCount * (SECTOR / 4)) fat.push(FREE_SECTOR);
  fatSectors.forEach((sectorId, sectorIndex) => {
    const view = new DataView(sectors[sectorId].buffer);
    for (let at = 0; at < SECTOR / 4; at += 1) {
      view.setUint32(at * 4, fat[sectorIndex * (SECTOR / 4) + at], true);
    }
  });

  // 6) 헤더(512바이트)
  const header = new Uint8Array(SECTOR);
  const headerView = new DataView(header.buffer);
  header.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  headerView.setUint16(24, 0x3e, true);
  headerView.setUint16(26, 3, true);
  headerView.setUint16(28, 0xfffe, true);
  headerView.setUint16(30, 9, true);
  headerView.setUint16(32, 6, true);
  headerView.setUint32(44, fatCount, true);
  headerView.setUint32(48, directorySectors[0], true);
  headerView.setUint32(56, MINI_CUTOFF, true);
  headerView.setUint32(60, miniFatSectors.length > 0 ? miniFatSectors[0] : END_OF_CHAIN, true);
  headerView.setUint32(64, miniFatSectors.length, true);
  headerView.setUint32(68, END_OF_CHAIN, true);
  headerView.setUint32(72, 0, true);
  for (let index = 0; index < 109; index += 1) {
    headerView.setUint32(76 + index * 4, index < fatCount ? fatSectors[index] : FREE_SECTOR, true);
  }

  const bytes = new Uint8Array(SECTOR * (sectors.length + 1));
  bytes.set(header);
  sectors.forEach((sector, index) => bytes.set(sector, (index + 1) * SECTOR));
  return { bytes, fatSectors, directorySectors, miniFatSectors };
}

/** CFB 파일 안의 FAT 항목 하나를 덮어씁니다(순환·범위 밖 체인 변형용). */
export function setCfbFatEntry(fixture: CfbFixture, sector: number, value: number): void {
  const perSector = SECTOR / 4;
  const fatSector = fixture.fatSectors[Math.floor(sector / perSector)];
  new DataView(fixture.bytes.buffer).setUint32(
    (fatSector + 1) * SECTOR + (sector % perSector) * 4,
    value,
    true,
  );
}

/** HWP 5.0 FileHeader 스트림. 속성 기본값은 bit 0(압축)만 켭니다. */
export function hwpFileHeader(properties = 0x1, size = 256): Uint8Array {
  const data = new Uint8Array(size);
  data.set(encoder.encode("HWP Document File"));
  const view = new DataView(data.buffer);
  view.setUint32(32, 0x05010000, true);
  view.setUint32(36, properties, true);
  return data;
}

/** 최소 HWP(CFB) 원본 */
export function syntheticHwp(
  options: { properties?: number; fileHeaderSize?: number } = {},
): CfbFixture {
  return buildCfb([
    { name: "FileHeader", data: hwpFileHeader(options.properties, options.fileHeaderSize) },
    { name: "DocInfo", data: new Uint8Array(100).fill(7) },
  ]);
}

/** 최소 PPT(CFB) 원본. `PowerPoint Document`는 일반 섹터 경로를 쓰도록 4096바이트 이상으로 만듭니다. */
export function syntheticPpt(): CfbFixture {
  return buildCfb([
    { name: "Current User", data: new Uint8Array(40).fill(1) },
    { name: "PowerPoint Document", data: new Uint8Array(5000).fill(2) },
  ]);
}

// ---------------------------------------------------------------------------
// ZIP 작성기
// ---------------------------------------------------------------------------

/** ZIP 엔트리 입력. 위험 변형을 위해 플래그·방식·선언 크기·CRC를 덮어쓸 수 있습니다. */
export interface ZipEntryInput {
  name: string;
  data?: Uint8Array | string;
  /** 0 무압축, 8 deflate. 그 밖의 값은 데이터를 그대로 저장하며 방식 필드만 바꿉니다. */
  method?: number;
  flags?: number;
  /** 로컬·중앙 헤더의 원본 크기 필드를 덮어씁니다(압축 폭탄 선언 변형). */
  declaredSize?: number;
  crc?: number;
}

/** ZIP 전체 변형 옵션 */
export interface ZipOptions {
  comment?: Uint8Array;
  /** EOCD 레코드를 만든 뒤 직접 수정합니다. 인자는 전체 바이트 DataView와 EOCD 오프셋입니다. */
  patchEndRecord?: (view: DataView, offset: number) => void;
  /** 중앙 디렉터리와 EOCD 사이에 끼워 넣을 바이트(ZIP64 위치 레코드 변형용) */
  beforeEndRecord?: Uint8Array;
}

/** 단일 디스크 ZIP을 만듭니다. 이름에 ASCII 외 문자가 있으면 UTF-8 플래그를 켭니다. */
export function buildZip(entries: ZipEntryInput[], options: ZipOptions = {}): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const raw = toBytes(entry.data ?? "");
    const method = entry.method ?? 8;
    const stored = method === 8 ? new Uint8Array(deflateRawSync(raw)) : raw;
    const name = encoder.encode(entry.name);
    const flags = (entry.flags ?? 0) | (/^[\x00-\x7f]*$/.test(entry.name) ? 0 : 0x800);
    const crc = entry.crc ?? crc32(raw);
    const size = entry.declaredSize ?? raw.length;

    const local = new Uint8Array(30 + name.length + stored.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, flags, true);
    localView.setUint16(8, method, true);
    localView.setUint32(14, crc, true);
    localView.setUint32(18, stored.length, true);
    localView.setUint32(22, size, true);
    localView.setUint16(26, name.length, true);
    local.set(name, 30);
    local.set(stored, 30 + name.length);

    const central = new Uint8Array(46 + name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, flags, true);
    centralView.setUint16(10, method, true);
    centralView.setUint32(16, crc, true);
    centralView.setUint32(20, stored.length, true);
    centralView.setUint32(24, size, true);
    centralView.setUint16(28, name.length, true);
    centralView.setUint32(42, offset, true);
    central.set(name, 46);

    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const directorySize = centrals.reduce((sum, part) => sum + part.length, 0);
  const between = options.beforeEndRecord ?? new Uint8Array(0);
  const comment = options.comment ?? new Uint8Array(0);
  const end = new Uint8Array(22 + comment.length);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, directorySize + between.length, true);
  endView.setUint32(16, offset, true);
  endView.setUint16(20, comment.length, true);
  end.set(comment, 22);

  const bytes = new Uint8Array(offset + directorySize + between.length + end.length);
  let cursor = 0;
  for (const part of [...locals, ...centrals, between, end]) {
    bytes.set(part, cursor);
    cursor += part.length;
  }
  options.patchEndRecord?.(new DataView(bytes.buffer), offset + directorySize + between.length);
  return bytes;
}

/** HWPX 기본 엔트리. 첫 엔트리는 무압축 `mimetype`입니다. */
export function hwpxEntries(): ZipEntryInput[] {
  return [
    { name: "mimetype", data: "application/hwp+zip", method: 0 },
    { name: "version.xml", data: '<?xml version="1.0"?><hv:HCFVersion xmlns:hv="urn:hwp"/>' },
    { name: "META-INF/manifest.xml", data: '<?xml version="1.0"?><manifest/>' },
    { name: "Contents/content.hpf", data: '<?xml version="1.0"?><opf:package/>' },
    { name: "Contents/header.xml", data: '<?xml version="1.0"?><hh:head/>' },
    { name: "Contents/section0.xml", data: '<?xml version="1.0"?><hs:sec>합성 본문</hs:sec>' },
  ];
}

/** OOXML `[Content_Types].xml` 본문을 만듭니다. */
export function contentTypesXml(overrides: { partName: string; contentType: string }[]): string {
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    overrides
      .map(
        (override) =>
          `<Override PartName="${override.partName}" ContentType="${override.contentType}"/>`,
      )
      .join("") +
    "</Types>"
  );
}

export const PPTX_MAIN =
  "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml";
export const PPTM_MAIN = "application/vnd.ms-powerpoint.presentation.macroEnabled.main+xml";

/** PPTX 기본 엔트리. 본문 콘텐츠 형식을 바꿔 매크로·슬라이드쇼 변형을 만들 수 있습니다. */
export function pptxEntries(mainContentType = PPTX_MAIN): ZipEntryInput[] {
  return [
    {
      name: "[Content_Types].xml",
      data: contentTypesXml([{ partName: "/ppt/presentation.xml", contentType: mainContentType }]),
    },
    { name: "_rels/.rels", data: '<?xml version="1.0"?><Relationships/>' },
    { name: "ppt/presentation.xml", data: '<?xml version="1.0"?><p:presentation/>' },
    { name: "ppt/_rels/presentation.xml.rels", data: '<?xml version="1.0"?><Relationships/>' },
    { name: "ppt/slides/slide1.xml", data: '<?xml version="1.0"?><p:sld/>' },
  ];
}

/** DOCX 기본 엔트리(미지원 형식 확인용) */
export function docxEntries(): ZipEntryInput[] {
  return [
    {
      name: "[Content_Types].xml",
      data: contentTypesXml([
        {
          partName: "/word/document.xml",
          contentType:
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml",
        },
      ]),
    },
    { name: "_rels/.rels", data: '<?xml version="1.0"?><Relationships/>' },
    { name: "word/document.xml", data: '<?xml version="1.0"?><w:document/>' },
  ];
}

/** 두 바이트 배열을 이어 붙입니다(앞 데이터·폴리글랏 변형용). */
export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let cursor = 0;
  for (const part of parts) {
    result.set(part, cursor);
    cursor += part.length;
  }
  return result;
}
