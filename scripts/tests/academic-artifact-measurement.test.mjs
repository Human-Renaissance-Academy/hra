/**
 * #516 PR-H 운영자 측정 도구의 안전 성질을 mock 으로 검증한다. 네트워크·실제 Blob·운영 자격정보를 쓰지 않는다.
 *   - academic-artifact-read-benchmark: 인자 검증, 읽기 전용 호출(get·head 만), 출력 비밀 제거, 판정 경계.
 *   - hancom-sample-check: 판정 로직, 합성 CFB 의 Scripts 스트림 크기 측정, 서버 한도와 일치, 실제 검증기 연결.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  MAX_DURATION_MS,
  judgeFinalizePath,
  measureObject,
  parseArguments,
  readToken,
  runBenchmark,
  storeMatches,
} from "../ops/academic-artifact-read-benchmark.mjs";
import {
  CURRENT_SCRIPT_LIMITS,
  SAMPLE_CASES,
  judgeCase,
  measureHwpScriptStreams,
  parseArguments as parseSampleArguments,
  renderTable,
  runSampleCheck,
} from "../ops/hancom-sample-check.mjs";
import { loadDocumentFormats } from "../_lib/ts-source-loader.mjs";

const HOST = "teststore123.private.blob.vercel-storage.com";
const SECRET_TOKEN = "vercel_blob_rw_TESTSECRET_abcdef";
const SECRET_PATH = "academic-uploads/v2/secret-intent/original";
const baseArgs = ["--pathname", SECRET_PATH, "--allow-store", HOST, "--confirm-non-production"];

/** 스트림을 돌려주는 SDK mock. 호출 이름을 기록한다. */
function mockSdk({ size = 1024, host = HOST, content, chunks = 2 } = {}) {
  const calls = [];
  const data = content ?? new TextEncoder().encode("%PDF-1.4\n%%EOF\n".padEnd(size, " "));
  const url = `https://${host}/${SECRET_PATH}`;
  return {
    calls,
    sdk: {
      async head(pathname, options) {
        calls.push({ name: "head", pathname, options });
        return { url, size: data.length };
      },
      async get(pathname, options) {
        calls.push({ name: "get", pathname, options });
        const step = Math.ceil(data.length / chunks);
        let offset = 0;
        const stream = new ReadableStream({
          pull(controller) {
            if (offset >= data.length) return controller.close();
            controller.enqueue(data.slice(offset, offset + step));
            offset += step;
          },
        });
        return {
          statusCode: 200,
          stream,
          headers: new Headers(),
          blob: { url, size: data.length },
        };
      },
    },
  };
}

function fakeClock(step = 10) {
  let current = 0;
  return () => {
    current += step;
    return current;
  };
}

test("벤치마크 인자: 경로 1~2개, 비공개 호스트, 비운영 확인이 모두 필요하다", () => {
  assert.equal(parseArguments(baseArgs).ok, true);
  assert.equal(parseArguments(baseArgs.slice(2)).code, "PATHNAME_COUNT");
  assert.equal(
    parseArguments([...baseArgs, "--pathname", "b/c", "--pathname", "d/e"]).code,
    "PATHNAME_COUNT",
  );
  assert.equal(parseArguments([...baseArgs, "--pathname", SECRET_PATH]).code, "USAGE");
  assert.equal(
    parseArguments([
      "--pathname",
      "a/b",
      "--allow-store",
      "x.public.blob.vercel-storage.com",
      "--confirm-non-production",
    ]).code,
    "STORE_NOT_PRIVATE_HOST",
  );
  assert.equal(
    parseArguments(["--pathname", "a/b", "--allow-store", HOST]).code,
    "CONFIRM_NON_PRODUCTION_REQUIRED",
  );
  assert.equal(parseArguments([...baseArgs, "--unknown", "x"]).code, "USAGE");
  assert.equal(
    parseArguments(["--pathname", "https://x/y", "--allow-store", HOST, "--confirm-non-production"])
      .code,
    "PATHNAME_INVALID",
  );
  assert.equal(
    parseArguments(["--pathname", "../x", "--allow-store", HOST, "--confirm-non-production"]).code,
    "PATHNAME_INVALID",
  );
});

test("토큰: 파일 권한이 넓으면 거부하고 오류에 경로·값이 없다", () => {
  const loose = readToken({
    storeTokenFile: "/x/t",
    env: {},
    stat: () => ({ mode: 0o644 }),
    readFile: () => SECRET_TOKEN,
  });
  assert.deepEqual(loose, { ok: false, code: "TOKEN_FILE_PERMISSIONS" });
  const good = readToken({
    storeTokenFile: "/x/t",
    env: {},
    stat: () => ({ mode: 0o600 }),
    readFile: () => `${SECRET_TOKEN}\n`,
  });
  assert.equal(good.token, SECRET_TOKEN);
  const broken = readToken({
    storeTokenFile: "/x/t",
    env: {},
    stat: () => {
      throw new Error("/x/t ENOENT");
    },
  });
  assert.deepEqual(broken, { ok: false, code: "TOKEN_FILE_UNREADABLE" });
  assert.equal(readToken({ storeTokenFile: null, env: {} }).code, "TOKEN_MISSING");
  assert.equal(
    readToken({ storeTokenFile: null, env: { ACADEMIC_SUBMISSION_READ_WRITE_TOKEN: "t" } }).token,
    "t",
  );
});

test("측정: head·get 만 호출하고 서버와 같은 비공개·무캐시 옵션을 쓴다", async () => {
  const { sdk, calls } = mockSdk();
  const parsed = parseArguments(baseArgs).options;
  const report = await runBenchmark({
    options: parsed,
    token: SECRET_TOKEN,
    sdk,
    detect: () => ({ ok: true, format: "PDF" }),
    now: fakeClock(),
  });
  assert.deepEqual([...new Set(calls.map((call) => call.name))].sort(), ["get", "head"]);
  const get = calls.find((call) => call.name === "get");
  assert.equal(get.options.access, "private");
  assert.equal(get.options.useCache, false);
  assert.equal(report.files[0].ok, true);
  assert.equal(report.files[0].detected.format, "PDF");
  assert.equal(report.files[0].sizeMatchesHead, true);
  assert.match(report.files[0].sha256, /^[0-9a-f]{64}$/);
  assert.ok(report.files[0].timingsMs.timeToFirstByte > 0);
});

test("출력에 토큰·호스트·경로·URL 이 없다", async () => {
  const { sdk } = mockSdk();
  const report = await runBenchmark({
    options: parseArguments(baseArgs).options,
    token: SECRET_TOKEN,
    sdk,
    detect: () => ({ ok: false, reason: "UNKNOWN_FORMAT" }),
    now: fakeClock(),
  });
  const text = JSON.stringify(report);
  for (const secret of [SECRET_TOKEN, HOST, SECRET_PATH, "https://", "secret-intent"])
    assert.ok(!text.includes(secret), secret);
  assert.equal(report.files[0].label, "file1");
  assert.equal(report.files[0].detected.reason, "UNKNOWN_FORMAT");
});

test("다른 저장소 응답이면 본문을 읽지 않고 WRONG_STORE", async () => {
  const { sdk, calls } = mockSdk({ host: "other.private.blob.vercel-storage.com" });
  const result = await measureObject({
    sdk,
    detect: () => ({ ok: true, format: "PDF" }),
    now: fakeClock(),
    pathname: "a/b",
    token: "t",
    allowStore: HOST,
    label: "file1",
  });
  assert.equal(result.code, "WRONG_STORE");
  assert.ok(!calls.some((call) => call.name === "get"));
  assert.equal(storeMatches("not a url", HOST), false);
  assert.equal(storeMatches(`http://${HOST}/x`, HOST), false);
});

test("50MiB 초과 객체는 get 을 호출하지 않는다", async () => {
  const calls = [];
  const sdk = {
    async head() {
      calls.push("head");
      return { url: `https://${HOST}/x`, size: 50 * 1024 * 1024 + 1 };
    },
    async get() {
      calls.push("get");
      return null;
    },
  };
  const result = await measureObject({
    sdk,
    detect: () => ({ ok: true }),
    now: fakeClock(),
    pathname: "a/b",
    token: "t",
    allowStore: HOST,
    label: "file1",
  });
  assert.equal(result.code, "TOO_LARGE");
  assert.deepEqual(calls, ["head"]);
});

test("판정: 120초 대비 50% 이하 PASS, 80% 이하 WARN, 초과 FAIL, 측정 실패는 FAIL", () => {
  const file = (totalMs, bytes) => ({ ok: true, bytes, timingsMs: { total: totalMs } });
  const mb = 1024 * 1024;
  // 50MiB 두 개가 각 10초면 외삽도 20초 -> PASS
  assert.equal(judgeFinalizePath([file(10_000, 50 * mb), file(10_000, 50 * mb)]).verdict, "PASS");
  // 합계 60초 이하는 PASS, 초과 ~96초까지 WARN
  assert.equal(judgeFinalizePath([file(30_000, 50 * mb), file(30_000, 50 * mb)]).verdict, "PASS");
  assert.equal(judgeFinalizePath([file(40_000, 50 * mb), file(40_000, 50 * mb)]).verdict, "WARN");
  assert.equal(judgeFinalizePath([file(50_000, 50 * mb), file(50_000, 50 * mb)]).verdict, "FAIL");
  // 작은 파일 1개: 처리량을 50MiB 두 개로 외삽한다(1MiB 1초 -> 100초 -> FAIL)
  const small = judgeFinalizePath([file(1_000, mb)]);
  assert.equal(small.verdict, "FAIL");
  assert.equal(small.representativeSize, false);
  assert.equal(judgeFinalizePath([{ ok: false }]).verdict, "FAIL");
  assert.equal(MAX_DURATION_MS, 120_000);
});

test("maxDuration 상수가 실제 최종화 라우트와 같다", () => {
  const route = readFileSync(
    new URL("../../src/app/api/v1/submissions/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /export const maxDuration = 120;/);
});

test("벤치마크 소스는 읽기 함수 외 SDK 쓰기 함수를 쓰지 않는다", () => {
  const source = readFileSync(
    new URL("../ops/academic-artifact-read-benchmark.mjs", import.meta.url),
    "utf8",
  );
  assert.match(source, /const \{ get, head \} = await import\("@vercel\/blob"\)/);
  assert.ok(
    !/\b(put|del|copy|list|putFromUrl|rename)\(/.test(source.replace(/\/\*[\s\S]*?\*\//, "")),
  );
});

/** 합성 CFB: 헤더 + FAT 섹터 + 디렉터리 섹터. 디렉터리 크기 필드만 쓰므로 스트림 본문은 없다. */
function syntheticCfb(scriptStreams) {
  const buffer = new Uint8Array(512 * 3);
  const view = new DataView(buffer.buffer);
  buffer.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  view.setUint16(26, 3, true);
  view.setUint16(28, 0xfffe, true);
  view.setUint16(30, 9, true);
  view.setUint32(44, 1, true); // FAT 섹터 수
  view.setUint32(48, 1, true); // 디렉터리 시작 섹터
  view.setUint32(68, 0xfffffffe, true); // DIFAT 없음
  for (let index = 0; index < 109; index += 1) view.setUint32(76 + index * 4, 0xffffffff, true);
  view.setUint32(76, 0, true); // FAT 는 섹터 0
  // FAT: 섹터 0 = FAT, 섹터 1 = 디렉터리(체인 끝)
  const fat = 512;
  view.setUint32(fat, 0xfffffffd, true);
  view.setUint32(fat + 4, 0xfffffffe, true);
  const entry = (
    index,
    name,
    type,
    { left = 0xffffffff, right = 0xffffffff, child = 0xffffffff, size = 0 } = {},
  ) => {
    const at = 1024 + index * 128;
    for (let i = 0; i < name.length; i += 1) view.setUint16(at + i * 2, name.charCodeAt(i), true);
    view.setUint16(at + 64, (name.length + 1) * 2, true);
    buffer[at + 66] = type;
    view.setUint32(at + 68, left, true);
    view.setUint32(at + 72, right, true);
    view.setUint32(at + 76, child, true);
    view.setUint32(at + 120, size, true);
  };
  entry(0, "Root Entry", 5, { child: 1 });
  entry(1, "Scripts", 1, { child: scriptStreams.length > 0 ? 2 : 0xffffffff });
  scriptStreams.forEach(([name, size], index) => {
    entry(2 + index, name, 2, {
      right: index + 1 < scriptStreams.length ? 3 + index : 0xffffffff,
      size,
    });
  });
  return buffer;
}

test("HWP 합성 CFB 에서 Scripts 스트림 크기를 읽는다", () => {
  const measured = measureHwpScriptStreams(
    syntheticCfb([
      ["DefaultJScript", 37],
      ["JScriptVersion", 8],
    ]),
  );
  assert.equal(measured.hasScripts, true);
  assert.deepEqual(
    measured.streams.map((s) => [s.name, s.bytes]),
    [
      ["DefaultJScript", 37],
      ["JScriptVersion", 8],
    ],
  );
  assert.deepEqual(measureHwpScriptStreams(new Uint8Array(600)), { error: "NOT_CFB" });
});

test("판정 로직: 허용·거부 사유 일치 PASS, 다른 사유 REVIEW, 반대 결과 FAIL", () => {
  const accept = SAMPLE_CASES.find((c) => c.id === "hwp-plain");
  const reject = SAMPLE_CASES.find((c) => c.id === "hwp-password");
  assert.equal(judgeCase(accept, { ok: true, format: "HWP" }), "PASS");
  assert.equal(judgeCase(accept, { ok: false, reason: "MALFORMED" }), "FAIL");
  assert.equal(judgeCase(reject, { ok: false, reason: "ENCRYPTED" }), "PASS");
  assert.equal(judgeCase(reject, { ok: false, reason: "MALFORMED" }), "REVIEW");
  assert.equal(judgeCase(reject, { ok: true, format: "HWP" }), "FAIL");
});

test("샘플 점검: 없는 파일은 SKIPPED, 출력에 파일 이름이 없고 한도 표가 나온다", () => {
  const files = new Map([
    [
      "hwp-plain.hwp",
      syntheticCfb([
        ["DefaultJScript", 37],
        ["JScriptVersion", 8],
      ]),
    ],
  ]);
  const report = runSampleCheck({
    dir: "/private/dir/name",
    validate: () => ({ ok: true, format: "HWP", contentType: "application/x-hwp" }),
    stat: () => undefined,
    readFile: (path) => {
      const name = path.split("/").pop();
      if (!files.has(name)) throw new Error("ENOENT");
      return files.get(name);
    },
  });
  assert.equal(report.ok, true);
  assert.equal(report.counts.PASS, 1);
  assert.equal(report.counts.SKIPPED, SAMPLE_CASES.length - 1);
  const limit = report.scriptLimits.find((item) => item.stream === "DEFAULTJSCRIPT");
  assert.equal(limit.measuredMaxBytes, 37);
  const text = renderTable(report) + JSON.stringify(report);
  assert.ok(!text.includes("/private/dir/name"));
  assert.ok(!text.includes("hwp-plain.hwp"));
});

test("샘플 점검: 기대와 반대 결과는 FAIL 이고 종료 판정이 실패다", () => {
  const report = runSampleCheck({
    dir: "/d",
    validate: () => ({ ok: true, format: "PPTX", contentType: "x" }),
    stat: () => undefined,
    readFile: (path) =>
      path.endsWith("pptx-macro-renamed.pptx")
        ? new Uint8Array([1])
        : (() => {
            throw new Error("x");
          })(),
  });
  assert.equal(report.ok, false);
  assert.equal(report.rows.find((r) => r.id === "pptx-macro-renamed").verdict, "FAIL");
});

test("샘플 점검 인자: --dir 필수, 알 수 없는 인자 거부", () => {
  assert.equal(parseSampleArguments([]).code, "USAGE");
  assert.equal(parseSampleArguments(["--dir", "/x", "--bad"]).code, "USAGE");
  assert.deepEqual(parseSampleArguments(["--dir", "/x", "--json"]).options, {
    dir: "/x",
    json: true,
  });
});

test("스크립트 한도 상수가 cfb.ts 의 서버 한도와 같다", () => {
  const source = readFileSync(
    new URL("../../src/features/academics/assignment-uploads/formats/cfb.ts", import.meta.url),
    "utf8",
  );
  for (const [name, limit] of Object.entries(CURRENT_SCRIPT_LIMITS)) {
    assert.ok(source.includes(`["${name}", ${limit}]`), name);
  }
});

test("실제 검증기 연결: 합성 PDF 는 허용, 확장자 불일치는 거부", async () => {
  const { validateDeclaredDocument, detectDocumentFormat } = await loadDocumentFormats();
  const bytes = new TextEncoder().encode("%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n");
  assert.deepEqual(detectDocumentFormat(bytes), { ok: true, format: "PDF" });
  const ok = validateDeclaredDocument({
    bytes,
    fileName: "a.pdf",
    declaredFormat: "PDF",
    contentType: "application/pdf",
    artifactType: "TEXT",
  });
  assert.equal(ok.ok, true);
  const bad = validateDeclaredDocument({
    bytes,
    fileName: "a.hwp",
    declaredFormat: "PDF",
    contentType: "application/pdf",
    artifactType: "TEXT",
  });
  assert.equal(bad.reason, "EXTENSION_MISMATCH");
});
