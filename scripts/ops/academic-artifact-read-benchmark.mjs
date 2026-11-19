/**
 * 분리 제출(#516) 최종화 경로의 실제 비공개 Blob 읽기 성능을 재는 운영자 실행용 도구 (PR-H).
 *
 * 역할:
 *   - 운영자가 **운영이 아닌 비공개 Blob 저장소**에 미리 올려 둔 합성·샘플 객체(최대 2개)를
 *     서버 최종화와 같은 방식(`get(..., { access: "private", useCache: false })`)으로 읽는다.
 *   - 객체마다 get 응답 시간·첫 바이트까지 시간(TTFB)·전체 읽기 시간·처리량을 재고,
 *     스트리밍 SHA-256 을 계산하고, 메모리에 모은 바이트(상한 50MiB)로 detectDocumentFormat 을 실행한다.
 *   - 2개 파일을 순차로 읽는 최종화 경로의 총 시간을 maxDuration(120초)과 비교해 여유 판정을 낸다.
 * 안전 경계:
 *   - SDK 에서 `get`·`head` 만 import 한다. put/del/copy/list 는 호출하지 않는다.
 *   - 저장소 확인: `--allow-store <호스트>` 가 비공개 저장소 형식이어야 하고, 실제 응답 URL 의 호스트와 같아야 한다.
 *     다르면 본문을 읽지 않고 중단한다. 호스트·URL·토큰·경로는 출력하지 않는다(경로는 `file1`·`file2` 로만 표시).
 *   - 운영 저장소 오사용을 막기 위해 `--confirm-non-production` 을 요구한다.
 *   - 토큰은 `--store-token-file`(권한 600 이하)로만 받는다. 환경변수 대체 경로는 없다(운영 토큰 우발 사용 방지).
 * 출력: stdout 에 JSON 한 개. 종료 코드 0=PASS·WARN, 1=FAIL·읽기 실패, 2=입력 오류.
 */
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** 최종화 라우트의 maxDuration(초). src/app/api/v1/submissions/route.ts 와 같아야 한다. */
export const MAX_DURATION_MS = 120_000;
/** 안전 여유: 최악 시나리오 예상 시간이 maxDuration 의 이 비율 이하면 PASS, 80% 이하면 WARN. */
export const PASS_RATIO = 0.5;
export const WARN_RATIO = 0.8;
/** 파일 하나의 상한(50MiB). 형식 탐지 모듈의 MAX_DOCUMENT_BYTES 와 같다. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;
/** 최종화가 한 제출에서 읽는 파일 수 상한(텍스트 + 발표자료) */
export const MAX_PATHNAMES = 2;
/** 서버 최종화의 get 제한 시간(server.ts 와 같은 60초) */
const GET_TIMEOUT_MS = 60_000;
const PRIVATE_HOST = /^[a-z0-9-]+\.private\.blob\.vercel-storage\.com$/;

/** 인자를 해석한다. 알 수 없는 인자·중복·범위 위반은 USAGE 로 거부한다. */
export function parseArguments(argv) {
  const options = {
    pathnames: [],
    storeTokenFile: null,
    allowStore: null,
    confirmNonProduction: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--confirm-non-production") {
      options.confirmNonProduction = true;
      continue;
    }
    const value = argv[index + 1];
    if (
      !["--pathname", "--store-token-file", "--allow-store"].includes(flag) ||
      !value ||
      value.startsWith("--")
    ) {
      return { ok: false, code: "USAGE" };
    }
    index += 1;
    if (flag === "--pathname") options.pathnames.push(value);
    else if (flag === "--store-token-file" && !options.storeTokenFile)
      options.storeTokenFile = value;
    else if (flag === "--allow-store" && !options.allowStore) options.allowStore = value;
    else return { ok: false, code: "USAGE" };
  }
  if (options.pathnames.length < 1 || options.pathnames.length > MAX_PATHNAMES)
    return { ok: false, code: "PATHNAME_COUNT" };
  if (new Set(options.pathnames).size !== options.pathnames.length)
    return { ok: false, code: "USAGE" };
  // 경로는 상대 경로만 받는다(URL·경로 이탈·제어 문자 거부).
  if (
    options.pathnames.some(
      (p) => !/^[A-Za-z0-9._\-/]+$/.test(p) || p.startsWith("/") || p.includes(".."),
    )
  ) {
    return { ok: false, code: "PATHNAME_INVALID" };
  }
  if (!options.allowStore || !PRIVATE_HOST.test(options.allowStore))
    return { ok: false, code: "STORE_NOT_PRIVATE_HOST" };
  if (!options.confirmNonProduction) return { ok: false, code: "CONFIRM_NON_PRODUCTION_REQUIRED" };
  return { ok: true, options };
}

/** 토큰을 읽는다. 파일은 소유자 외 접근 권한이 있으면 거부한다. 값은 반환만 하고 어디에도 출력하지 않는다. */
export function readToken({ storeTokenFile, readFile = readFileSync, stat = statSync }) {
  if (!storeTokenFile) return { ok: false, code: "TOKEN_FILE_REQUIRED" };
  {
    try {
      if (stat(storeTokenFile).mode & 0o077) return { ok: false, code: "TOKEN_FILE_PERMISSIONS" };
      const token = readFile(storeTokenFile, "utf8").trim();
      return token ? { ok: true, token } : { ok: false, code: "TOKEN_MISSING" };
    } catch {
      // 파일 경로가 오류 메시지에 섞이지 않도록 고정 코드만 남긴다.
      return { ok: false, code: "TOKEN_FILE_UNREADABLE" };
    }
  }
}

/** 응답 URL 의 호스트가 허용한 비공개 저장소와 같은지만 판정한다(값은 반환하지 않는다). */
export function storeMatches(url, allowStore) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === allowStore;
  } catch {
    return false;
  }
}

const round = (value) => Math.round(value * 100) / 100;

/**
 * 객체 하나를 읽고 측정한다.
 * sdk: { get, head } (테스트에서는 mock). detect: detectDocumentFormat. now: 단조 시계(ms).
 */
export async function measureObject({ sdk, detect, now, pathname, token, allowStore, label }) {
  const started = now();
  const result = { label, ok: false };
  // 1) head 로 크기를 먼저 확인해 50MiB 초과 객체는 본문을 읽지 않는다.
  let meta;
  try {
    meta = await sdk.head(pathname, { token, abortSignal: AbortSignal.timeout(15_000) });
  } catch (error) {
    return { ...result, code: error?.name === "BlobNotFoundError" ? "NOT_FOUND" : "HEAD_FAILED" };
  }
  if (!storeMatches(meta.url, allowStore)) return { ...result, code: "WRONG_STORE" };
  if (!Number.isSafeInteger(meta.size) || meta.size > MAX_FILE_BYTES) {
    return {
      ...result,
      code: "TOO_LARGE",
      declaredBytes: Number.isSafeInteger(meta.size) ? meta.size : null,
    };
  }
  // 2) 서버 최종화와 같은 옵션으로 본문을 읽는다.
  let response;
  try {
    response = await sdk.get(pathname, {
      access: "private",
      token,
      useCache: false,
      abortSignal: AbortSignal.timeout(GET_TIMEOUT_MS),
    });
  } catch (error) {
    return { ...result, code: error?.name === "BlobNotFoundError" ? "NOT_FOUND" : "GET_FAILED" };
  }
  if (!response || response.statusCode !== 200 || !response.stream)
    return { ...result, code: "GET_EMPTY" };
  const gotResponseAt = now();
  if (!storeMatches(response.blob.url, allowStore)) {
    await response.stream.cancel().catch(() => undefined);
    return { ...result, code: "WRONG_STORE" };
  }
  const hash = createHash("sha256");
  const chunks = [];
  let total = 0;
  let firstByteAt = null;
  let hashMs = 0;
  const reader = response.stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (firstByteAt === null) firstByteAt = now();
      total += value.byteLength;
      if (total > MAX_FILE_BYTES) {
        await reader.cancel().catch(() => undefined);
        return { ...result, code: "TOO_LARGE", declaredBytes: meta.size };
      }
      const hashStart = now();
      hash.update(value);
      hashMs += now() - hashStart;
      chunks.push(value);
    }
  } catch {
    // 읽기 실패 시 연결을 열어 두지 않도록 스트림을 취소한다.
    await reader.cancel().catch(() => undefined);
    return { ...result, code: "READ_FAILED" };
  }
  const readEnd = now();
  const bytes = Buffer.concat(chunks, total);
  // 3) 메모리에 모은 바이트로 형식 탐지(최종화에서 실제로 하는 일)를 실행한다.
  const detectStart = now();
  const detected = detect(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength));
  const detectMs = now() - detectStart;
  const finished = now();
  const readMs = readEnd - gotResponseAt;
  return {
    label,
    ok: true,
    bytes: total,
    sizeMatchesHead: total === meta.size,
    sha256: hash.digest("hex"),
    timingsMs: {
      getResponse: round(gotResponseAt - started),
      timeToFirstByte: round((firstByteAt ?? readEnd) - started),
      read: round(readMs),
      hash: round(hashMs),
      detect: round(detectMs),
      total: round(finished - started),
    },
    throughputMiBps: readMs > 0 ? round(total / 1024 / 1024 / (readMs / 1000)) : null,
    detected: detected.ok
      ? { ok: true, format: detected.format }
      : { ok: false, reason: detected.reason },
  };
}

/**
 * 순차 2파일 최종화 경로를 maxDuration 과 비교한다.
 * - measuredSequentialMs: 측정한 파일의 총 시간 합(파일 1개면 2배로 가정).
 * - worstCaseMs: 파일 2개가 모두 50MiB 일 때를 측정된 실효 처리량(읽기+해시+탐지 포함)으로 외삽한 값.
 * 판정은 더 큰 쪽(worstCase 와 measured 중 최댓값)으로 한다.
 */
export function judgeFinalizePath(files) {
  const okFiles = files.filter((file) => file.ok);
  if (okFiles.length === 0 || okFiles.length !== files.length)
    return { verdict: "FAIL", reason: "MEASUREMENT_INCOMPLETE" };
  const sum = okFiles.reduce((acc, file) => acc + file.timingsMs.total, 0);
  const bytes = okFiles.reduce((acc, file) => acc + file.bytes, 0);
  const measuredSequentialMs = okFiles.length === 1 ? sum * 2 : sum;
  // 객체당 고정 지연(get 응답 대기)과 바이트당 비용을 분리하지 않고, 총 시간/총 바이트를 실효 속도로 쓴다.
  const perByteMs = bytes > 0 ? sum / bytes : 0;
  const worstCaseMs = perByteMs * MAX_FILE_BYTES * 2;
  const projectedMs = Math.max(measuredSequentialMs, worstCaseMs);
  const ratio = projectedMs / MAX_DURATION_MS;
  const verdict = ratio <= PASS_RATIO ? "PASS" : ratio <= WARN_RATIO ? "WARN" : "FAIL";
  return {
    verdict,
    maxDurationMs: MAX_DURATION_MS,
    passRatio: PASS_RATIO,
    warnRatio: WARN_RATIO,
    measuredFileCount: okFiles.length,
    measuredSequentialMs: round(measuredSequentialMs),
    worstCase2x50MiBMs: round(worstCaseMs),
    projectedMs: round(projectedMs),
    ratioOfMaxDuration: round(ratio),
    // 측정 파일이 작으면 처리량 외삽의 오차가 크므로 운영자가 큰 파일로 재측정하도록 표시한다.
    representativeSize: okFiles.some((file) => file.bytes >= 20 * 1024 * 1024),
  };
}

/** 측정 전체를 실행하고 JSON 으로 낼 값을 만든다. */
export async function runBenchmark({ options, token, sdk, detect, now }) {
  const files = [];
  // 최종화는 두 파일을 순차로 읽으므로 같은 순서로 하나씩 측정한다.
  for (const [index, pathname] of options.pathnames.entries()) {
    files.push(
      await measureObject({
        sdk,
        detect,
        now,
        pathname,
        token,
        allowStore: options.allowStore,
        label: `file${index + 1}`,
      }),
    );
  }
  const finalize = judgeFinalizePath(files);
  const failure = files.find((file) => !file.ok);
  return {
    ok: !failure && finalize.verdict !== "FAIL",
    code: failure ? failure.code : finalize.verdict,
    files,
    finalize,
  };
}

async function main() {
  const emit = (value) =>
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, tool: "academic-artifact-read-benchmark", generatedAt: new Date().toISOString(), ...value }, null, 2)}\n`,
    );
  const parsed = parseArguments(process.argv.slice(2));
  if (!parsed.ok) {
    emit({ ok: false, code: parsed.code });
    process.exitCode = 2;
    return;
  }
  const tokenResult = readToken({ storeTokenFile: parsed.options.storeTokenFile });
  if (!tokenResult.ok) {
    emit({ ok: false, code: tokenResult.code });
    process.exitCode = 2;
    return;
  }
  const { loadDocumentFormats } = await import("../_lib/ts-source-loader.mjs");
  const { detectDocumentFormat } = await loadDocumentFormats();
  // get·head 만 import 한다(쓰기 함수는 가져오지 않는다).
  const { get, head } = await import("@vercel/blob");
  try {
    const report = await runBenchmark({
      options: parsed.options,
      token: tokenResult.token,
      sdk: { get, head },
      detect: detectDocumentFormat,
      now: () => performance.now(),
    });
    emit(report);
    process.exitCode = report.ok ? 0 : 1;
  } catch (error) {
    // SDK 오류 원문에는 저장소 주소가 섞일 수 있어 오류 이름만 남긴다.
    emit({
      ok: false,
      code: "UNEXPECTED",
      error: error instanceof Error ? error.name : "UnknownError",
    });
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
