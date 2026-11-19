/**
 * 실제 한컴·오피스 샘플 파일로 분리 제출(#516)의 문서 형식 검증을 점검하는 오프라인 운영자 도구 (PR-H).
 *
 * 역할:
 *   - 네트워크·DB·Blob 에 접속하지 않는다. 로컬 디렉터리의 샘플 파일만 읽는다(읽기 전용).
 *   - 샘플마다 서버와 같은 `validateDeclaredDocument`(산출물 유형·확장자·MIME·원본 구조 교차 검증)를 실행하고
 *     기대 결과와 비교한 판정표를 출력한다.
 *   - HWP 샘플의 기본 `Scripts` 저장소 스트림(DefaultJScript·JScriptVersion) 실제 크기를 재서
 *     현재 한도(1KiB·64바이트)를 조일 근거를 만든다.
 *   - 파일 내용·이름은 출력하지 않는다. 케이스 ID·크기·판정 코드만 출력한다.
 *
 * 준비할 샘플(디렉터리에 아래 파일명으로 둔다; 없는 파일은 SKIPPED 로 표시):
 *   hwp-plain.hwp          한컴오피스로 저장한 일반 HWP                 -> 허용(HWP)
 *   hwp-password.hwp       문서 암호를 설정한 HWP                       -> ENCRYPTED
 *   hwp-script.hwp         스크립트(매크로)를 넣어 저장한 HWP           -> MACRO
 *   hwpx-plain.hwpx        일반 HWPX                                   -> 허용(HWPX)
 *   hwpx-encrypted.hwpx    암호를 설정한 HWPX                          -> ENCRYPTED
 *   pptx-plain.pptx        일반 PPTX                                   -> 허용(PPTX)
 *   pptx-macro-renamed.pptx 매크로 포함 .pptm 을 .pptx 로 이름만 바꾼 것 -> MACRO
 *   ppt-plain.ppt          일반 PPT(97-2003)                           -> 허용(PPT)
 *   ppt-encrypted.ppt      암호를 설정한 PPT                           -> ENCRYPTED(다른 사유 거부는 REVIEW)
 *   pdf-plain.pdf          일반 PDF                                    -> 허용(PDF)
 *   pdf-encrypted.pdf      암호를 설정한 PDF                           -> ENCRYPTED
 * 판정: PASS=기대와 일치, REVIEW=거부했지만 사유가 기대와 다름(사유 코드 확인 필요), FAIL=허용/거부가 기대와 반대.
 * 출력: 기본은 표, `--json` 이면 JSON. 종료 코드 0=FAIL 없음, 1=FAIL 있음, 2=입력 오류.
 * 사용: node scripts/ops/hancom-sample-check.mjs --dir <샘플 디렉터리> [--json]
 */
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** 샘플 케이스 정의. accept=true 면 허용 형식, 아니면 reasons 중 하나로 거부되어야 한다. */
export const SAMPLE_CASES = [
  {
    id: "hwp-plain",
    file: "hwp-plain.hwp",
    format: "HWP",
    artifact: "TEXT",
    expect: { accept: true },
  },
  {
    id: "hwp-password",
    file: "hwp-password.hwp",
    format: "HWP",
    artifact: "TEXT",
    expect: { accept: false, reasons: ["ENCRYPTED"] },
  },
  {
    id: "hwp-script",
    file: "hwp-script.hwp",
    format: "HWP",
    artifact: "TEXT",
    expect: { accept: false, reasons: ["MACRO"] },
  },
  {
    id: "hwpx-plain",
    file: "hwpx-plain.hwpx",
    format: "HWPX",
    artifact: "TEXT",
    expect: { accept: true },
  },
  {
    id: "hwpx-encrypted",
    file: "hwpx-encrypted.hwpx",
    format: "HWPX",
    artifact: "TEXT",
    expect: { accept: false, reasons: ["ENCRYPTED"] },
  },
  {
    id: "pptx-plain",
    file: "pptx-plain.pptx",
    format: "PPTX",
    artifact: "SLIDES",
    expect: { accept: true },
  },
  {
    id: "pptx-macro-renamed",
    file: "pptx-macro-renamed.pptx",
    format: "PPTX",
    artifact: "SLIDES",
    expect: { accept: false, reasons: ["MACRO"] },
  },
  {
    id: "ppt-plain",
    file: "ppt-plain.ppt",
    format: "PPT",
    artifact: "SLIDES",
    expect: { accept: true },
  },
  {
    id: "ppt-encrypted",
    file: "ppt-encrypted.ppt",
    format: "PPT",
    artifact: "SLIDES",
    expect: { accept: false, reasons: ["ENCRYPTED"] },
  },
  {
    id: "pdf-plain",
    file: "pdf-plain.pdf",
    format: "PDF",
    artifact: "TEXT",
    expect: { accept: true },
  },
  {
    id: "pdf-encrypted",
    file: "pdf-encrypted.pdf",
    format: "PDF",
    artifact: "TEXT",
    expect: { accept: false, reasons: ["ENCRYPTED"] },
  },
];

/** 현재 서버 한도(cfb.ts 의 HWP_DEFAULT_SCRIPT_LIMITS). 조정 판단의 기준값이며 테스트가 소스와 일치를 확인한다. */
export const CURRENT_SCRIPT_LIMITS = { DEFAULTJSCRIPT: 1024, JSCRIPTVERSION: 64 };

const CFB_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
const END_OF_CHAIN = 0xfffffffe;
const NO_STREAM = 0xffffffff;
const MAX_DIRECTORY_ENTRIES = 4096;

/**
 * HWP(CFB) 의 `Scripts` 저장소 안 스트림 이름·크기만 읽는다. 스트림 본문은 읽지 않는다.
 * 반환: { hasScripts, streams: [{ name, bytes }] } 또는 { error } (CFB 로 해석 불가).
 * 서버 검증기(cfb.ts)와 별개의 최소 구현이다. 크기 측정 외 판정에는 쓰지 않는다.
 */
export function measureHwpScriptStreams(bytes) {
  if (bytes.length < 512 || CFB_SIGNATURE.some((value, index) => bytes[index] !== value))
    return { error: "NOT_CFB" };
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sectorSize = 1 << view.getUint16(30, true);
  if (sectorSize !== 512 && sectorSize !== 4096) return { error: "BAD_SECTOR_SIZE" };
  const sectorCount = Math.floor((bytes.length - sectorSize) / sectorSize);
  const offsetOf = (sector) => (sector + 1) * sectorSize;
  const inRange = (sector) => sector < sectorCount;

  // FAT 섹터 목록: 헤더 DIFAT 109개 + DIFAT 섹터 체인
  const fatSectors = [];
  for (let index = 0; index < 109; index += 1) {
    const sector = view.getUint32(76 + index * 4, true);
    if (sector !== NO_STREAM) fatSectors.push(sector);
  }
  let difat = view.getUint32(68, true);
  for (
    let guard = 0;
    difat !== END_OF_CHAIN && difat !== NO_STREAM && guard < sectorCount;
    guard += 1
  ) {
    if (!inRange(difat)) return { error: "MALFORMED" };
    for (let index = 0; index < sectorSize / 4 - 1; index += 1) {
      const sector = view.getUint32(offsetOf(difat) + index * 4, true);
      if (sector !== NO_STREAM) fatSectors.push(sector);
    }
    difat = view.getUint32(offsetOf(difat) + sectorSize - 4, true);
  }
  const fat = [];
  for (const sector of fatSectors) {
    if (!inRange(sector)) return { error: "MALFORMED" };
    for (let index = 0; index < sectorSize / 4; index += 1)
      fat.push(view.getUint32(offsetOf(sector) + index * 4, true));
  }

  // 디렉터리 체인
  const entries = [];
  const visited = new Set();
  for (let sector = view.getUint32(48, true); sector !== END_OF_CHAIN; sector = fat[sector]) {
    if (sector === undefined || !inRange(sector) || visited.has(sector))
      return { error: "MALFORMED" };
    visited.add(sector);
    for (let index = 0; index < sectorSize / 128; index += 1) {
      const at = offsetOf(sector) + index * 128;
      const nameBytes = view.getUint16(at + 64, true);
      let name = "";
      for (let i = 0; i < Math.max(0, Math.min(nameBytes, 64) / 2 - 1); i += 1)
        name += String.fromCharCode(view.getUint16(at + i * 2, true));
      entries.push({
        name,
        type: bytes[at + 66],
        left: view.getUint32(at + 68, true),
        right: view.getUint32(at + 72, true),
        child: view.getUint32(at + 76, true),
        size: view.getUint32(at + 120, true),
      });
    }
    if (entries.length > MAX_DIRECTORY_ENTRIES) return { error: "MALFORMED" };
  }
  if (entries.length === 0) return { error: "MALFORMED" };

  // 부모 엔트리의 직계 자식(레드블랙 트리)을 순회한다.
  const childrenOf = (parent) => {
    const found = [];
    const seen = new Set();
    const stack = [parent.child];
    while (stack.length > 0) {
      const id = stack.pop();
      if (id === NO_STREAM || id >= entries.length || seen.has(id)) continue;
      seen.add(id);
      found.push(entries[id]);
      stack.push(entries[id].left, entries[id].right);
    }
    return found;
  };
  const scripts = childrenOf(entries[0]).find(
    (entry) => entry.type === 1 && entry.name.toUpperCase() === "SCRIPTS",
  );
  if (!scripts) return { hasScripts: false, streams: [] };
  return {
    hasScripts: true,
    streams: childrenOf(scripts).map((entry) => ({
      // 파일이 만든 이름이 출력에 섞이지 않도록 알려진 형태가 아니면 other 로 치환한다.
      name: /^[A-Za-z0-9_]{1,31}$/.test(entry.name) ? entry.name : "other",
      bytes: entry.size,
    })),
  };
}

/** 케이스 하나의 검증 결과를 기대와 비교해 판정한다. */
export function judgeCase(testCase, result) {
  if (result.ok) {
    if (testCase.expect.accept) return result.format === testCase.format ? "PASS" : "FAIL";
    return "FAIL";
  }
  if (testCase.expect.accept) return "FAIL";
  return testCase.expect.reasons.includes(result.reason) ? "PASS" : "REVIEW";
}

/**
 * 디렉터리의 샘플을 모두 검증한다.
 * deps.validate: validateDeclaredDocument, deps.readFile/deps.stat: 파일 읽기(테스트에서는 mock)
 */
export function runSampleCheck({ dir, validate, readFile = readFileSync, stat = statSync }) {
  const rows = [];
  const scriptsMaxima = {};
  for (const testCase of SAMPLE_CASES) {
    const path = join(dir, testCase.file);
    let bytes;
    try {
      stat(path);
      bytes = new Uint8Array(readFile(path));
    } catch {
      rows.push({ id: testCase.id, status: "SKIPPED", verdict: "SKIPPED" });
      continue;
    }
    const result = validate({
      bytes,
      fileName: testCase.file,
      declaredFormat: testCase.format,
      contentType: CANONICAL_MIME[testCase.format],
      artifactType: testCase.artifact,
    });
    const row = {
      id: testCase.id,
      declared: testCase.format,
      artifact: testCase.artifact,
      bytes: bytes.length,
      actual: result.ok ? `OK:${result.format}` : `REJECT:${result.reason}`,
      expected: testCase.expect.accept
        ? `OK:${testCase.format}`
        : `REJECT:${testCase.expect.reasons.join("|")}`,
      verdict: judgeCase(testCase, result),
    };
    // HWP 샘플은 기본 Scripts 스트림 크기를 함께 잰다(거부된 샘플도 측정해 한도 판단 근거로 쓴다).
    if (testCase.format === "HWP") {
      const scripts = measureHwpScriptStreams(bytes);
      row.scriptsStreams = scripts.error ? { error: scripts.error } : scripts;
      for (const stream of scripts.streams ?? []) {
        const key = stream.name.toUpperCase();
        scriptsMaxima[key] = Math.max(scriptsMaxima[key] ?? 0, stream.bytes);
      }
    }
    rows.push(row);
  }
  const limits = Object.entries(CURRENT_SCRIPT_LIMITS).map(([name, limit]) => ({
    stream: name,
    currentLimitBytes: limit,
    measuredMaxBytes: scriptsMaxima[name] ?? null,
  }));
  const unknown = Object.keys(scriptsMaxima).filter((name) => !(name in CURRENT_SCRIPT_LIMITS));
  const counts = { PASS: 0, REVIEW: 0, FAIL: 0, SKIPPED: 0 };
  for (const row of rows) counts[row.verdict] += 1;
  return {
    ok: counts.FAIL === 0,
    counts,
    rows,
    scriptLimits: limits,
    unknownScriptStreams: unknown,
  };
}

const CANONICAL_MIME = {
  PDF: "application/pdf",
  HWP: "application/x-hwp",
  HWPX: "application/hwp+zip",
  PPT: "application/vnd.ms-powerpoint",
  PPTX: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/** 사람이 읽는 표를 만든다(파일 이름·내용은 포함하지 않는다). */
export function renderTable(report) {
  const lines = ["케이스\t선언\t크기(B)\t실제\t기대\t판정"];
  for (const row of report.rows) {
    lines.push(
      row.verdict === "SKIPPED"
        ? `${row.id}\t-\t-\t-\t-\tSKIPPED(샘플 없음)`
        : `${row.id}\t${row.declared}\t${row.bytes}\t${row.actual}\t${row.expected}\t${row.verdict}`,
    );
  }
  lines.push("", "HWP 기본 Scripts 스트림 크기(바이트)");
  for (const limit of report.scriptLimits) {
    lines.push(
      `${limit.stream}\t현재 한도 ${limit.currentLimitBytes}\t측정 최댓값 ${limit.measuredMaxBytes ?? "측정 없음"}`,
    );
  }
  if (report.unknownScriptStreams.length > 0)
    lines.push(`허용 목록 밖 스트림 이름: ${report.unknownScriptStreams.join(", ")}`);
  lines.push(
    "",
    `요약: PASS ${report.counts.PASS} / REVIEW ${report.counts.REVIEW} / FAIL ${report.counts.FAIL} / SKIPPED ${report.counts.SKIPPED}`,
  );
  return `${lines.join("\n")}\n`;
}

/** 인자를 해석한다. */
export function parseArguments(argv) {
  const options = { dir: null, json: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--json") options.json = true;
    else if (
      argv[index] === "--dir" &&
      argv[index + 1] &&
      !argv[index + 1].startsWith("--") &&
      !options.dir
    ) {
      options.dir = argv[index + 1];
      index += 1;
    } else return { ok: false, code: "USAGE" };
  }
  return options.dir ? { ok: true, options } : { ok: false, code: "USAGE" };
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  if (!parsed.ok) {
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, tool: "hancom-sample-check", ok: false, code: parsed.code })}\n`,
    );
    process.exitCode = 2;
    return;
  }
  const { loadDocumentFormats } = await import("../_lib/ts-source-loader.mjs");
  const { validateDeclaredDocument } = await loadDocumentFormats();
  const report = runSampleCheck({ dir: parsed.options.dir, validate: validateDeclaredDocument });
  process.stdout.write(
    parsed.options.json
      ? `${JSON.stringify({ schemaVersion: 1, tool: "hancom-sample-check", ...report }, null, 2)}\n`
      : renderTable(report),
  );
  process.exitCode = report.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
