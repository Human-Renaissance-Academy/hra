/**
 * #279의 실제 Next build/start 경계를 합성 PG·정상 로그인 쿠키·외부 IO 감시로 검증합니다.
 * .env·운영 자원을 사용하지 않으며 결과는 로컬 next start의 증거입니다.
 * Vercel adapter/minimalMode·최종 비밀값 scope 보장을 대신하지 않습니다.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { request as rawRequest } from "node:http";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createQaPostgres, qaPassword } from "../tests/support/resource-qa-postgres.mjs";
import { academicG1Actors, installAcademicG1Base } from "../tests/support/academic-g1-fixture.mjs";
import { qaDatabaseUrl } from "../tests/support/neon-psql-transport.mjs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const artifact = join(root, ".omx/artifacts/issue279");
const secret = randomBytes(48).toString("hex");
const methods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const message = "미리보기에서는 서비스 기능을 제공하지 않습니다.";
const results = [];
let cluster,
  server,
  building,
  stage = "SETUP",
  checks = 0;
const check = (condition, code) => {
  checks++;
  if (!condition) throw new Error(`PREVIEW_${code}`);
};

/** 기존 여섯 시스템 값만 전달하고 앱·운영 환경을 상속하지 않습니다. */
function safeEnvironment() {
  return Object.fromEntries(
    ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT"]
      .filter((name) => process.env[name])
      .map((name) => [name, process.env[name]]),
  );
}

/** tuple은 child마다 명시하며 QA용 앱 bypass를 만들지 않습니다. */
function environment(tuple, sentinel = true) {
  return {
    ...safeEnvironment(),
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    ...(tuple === "preview"
      ? { VERCEL: "1", VERCEL_ENV: "preview" }
      : tuple === "production"
        ? { VERCEL: "1", VERCEL_ENV: "production" }
        : tuple === "tag-only"
          ? { VERCEL_ENV: "preview" }
          : {}),
    ...(sentinel
      ? {
          AUTH_SECRET: secret,
          AUTH_TRUST_HOST: "true",
          ACADEMIC_ENABLED: "false",
          DATABASE_URL: qaDatabaseUrl,
          BLOB_READ_WRITE_TOKEN: "synthetic-preview-only",
          RESOURCE_PRIVATE_READ_WRITE_TOKEN: "synthetic-preview-only",
          RESOURCE_PRIVATE_BLOB_HOST: "preview-boundary.private.blob.vercel-storage.com",
          ACADEMIC_SUBMISSION_READ_WRITE_TOKEN: "synthetic-preview-only",
          ACADEMIC_SUBMISSION_BLOB_HOST: "preview-academic.private.blob.vercel-storage.com",
          AUTH_GOOGLE_ID: "synthetic.invalid",
          AUTH_GOOGLE_SECRET: "synthetic-preview-only",
          AUTH_KAKAO_ID: "synthetic.invalid",
          AUTH_KAKAO_SECRET: "synthetic-preview-only",
          CRON_SECRET: "synthetic-preview-only",
          HEALTH_CHECK_SECRET: "synthetic-preview-only",
        }
      : {}),
    NODE_OPTIONS: `--import=${JSON.stringify(join(root, "tests/support/preview-boundary-preload.mjs"))}`,
  };
}

/** 자식 로그에서 공개 가능한 고정 호출 횟수만 결과에 집계합니다. */
function launch(args, env, label) {
  const child = spawn(args[0], args.slice(1), {
    cwd: root,
    env,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const state = {
    child,
    counts: { DB: 0, IMAGE: 0, IMAGE_DNS: 0, DNS: 0, FETCH: 0, HTTP: 0, TCP: 0 },
    log: "",
    traceUnsupported: 0,
  };
  for (const stream of [child.stdout, child.stderr])
    stream.on("data", (chunk) => {
      const text = String(chunk);
      state.log += text;
      state.traceUnsupported = [
        ...state.log.matchAll(/TypeError: 'TRACE' HTTP method is unsupported\./g),
      ].length;
      // 파이프 chunk가 진단 줄 중간에서 나뉘어도 호출을 누락하지 않습니다.
      for (const code of Object.keys(state.counts)) {
        state.counts[code] = [
          ...state.log.matchAll(new RegExp(`PREVIEW_IO:${code}(?=\\r?\\n|$)`, "g")),
        ].length;
      }
    });
  state.done = new Promise((resolve) => {
    child.once("error", () => resolve(-1));
    child.once("close", resolve);
  });
  state.label = label;
  return state;
}
function record(state) {
  writeFileSync(join(artifact, `${state.label}.log`), state.log);
  results.push({ label: state.label, counts: { ...state.counts } });
}
/** 분리된 자식 프로세스 그룹까지 정리하여 빌드·서버가 남지 않게 합니다. */
async function terminate(state) {
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    try {
      process.kill(-state.child.pid, signal);
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
    if (signal === "SIGTERM") await Promise.race([state.done, delay(5_000)]);
  }
}
async function stop() {
  if (!server) return;
  await terminate(server);
  record(server);
  server = undefined;
}

/** 빌드와 기동 IO를 분리하며 빌드 산출물의 실제 rewrite도 검사합니다. */
async function build(tuple) {
  stage = `BUILD_${tuple.toUpperCase()}`;
  const state = launch(["npm", "run", "build"], environment(tuple), `build-${tuple}`);
  building = state;
  const code = await state.done;
  building = undefined;
  record(state);
  check(code === 0, `${stage}_EXIT`);
  if (tuple !== "production")
    check(
      Object.values(state.counts).every((n) => n === 0),
      `${stage}_IO`,
    );
  const manifest = JSON.parse(readFileSync(join(root, ".next/routes-manifest.json"), "utf8"));
  const rules = manifest.rewrites.beforeFiles;
  check(
    rules.some((rule) => rule.source === "/api/:path*") === (tuple === "preview"),
    `${stage}_MANIFEST`,
  );
  results.push({
    label: `manifest-${tuple}`,
    buildId: readFileSync(join(root, ".next/BUILD_ID"), "utf8").trim(),
    beforeFiles: rules.map(({ source, destination }) => ({ source, destination })),
  });
}
async function start(tuple, sentinel = true, control = false) {
  stage = `START_${tuple.toUpperCase()}`;
  const listener = createServer();
  await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const env = {
    ...environment(tuple, sentinel),
    AUTH_URL: origin,
    NEXTAUTH_URL: origin,
    NEXT_PUBLIC_APP_URL: origin,
    ...(control ? cluster.environment : {}),
  };
  if (control)
    env.NODE_OPTIONS = `--import=${JSON.stringify(join(root, "tests/support/resource-qa-preload.mjs"))} ${env.NODE_OPTIONS}`;
  server = launch(
    [
      process.execPath,
      join(root, "node_modules/next/dist/bin/next"),
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    env,
    `start-${tuple}-${control ? "control" : sentinel ? "sentinel" : "minimal"}-${results.length}`,
  );
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && server.child.exitCode === null) {
    try {
      const response = await fetch(`${origin}/preview-unavailable`, {
        signal: AbortSignal.timeout(2_000),
      });
      await response.body?.cancel();
      if (response.status === 503) {
        results.push({ label: `${server.label}-startup`, counts: { ...server.counts } });
        return origin;
      }
    } catch {
      await delay(100);
      continue;
    }
    await delay(100);
  }
  throw new Error("PREVIEW_START_TIMEOUT");
}
async function request(origin, path, method = "GET", headers = {}) {
  return fetch(`${origin}${path}`, {
    method,
    redirect: "manual",
    signal: AbortSignal.timeout(30_000),
    headers,
    ...(["GET", "HEAD"].includes(method) ? {} : { body: "합성 본문" }),
  });
}
async function denied(origin, path, method = "GET", headers = {}) {
  stage = `DENY_${method}_${path.split("?")[0]}`;
  const response = await request(origin, path, method, headers);
  const body = await response.text();
  check(response.status === 503, `DENY_${method}_HTTP_${response.status}`);
  check(body === (method === "HEAD" ? "" : message), "BODY");
  check(response.headers.get("cache-control") === "no-store", "CACHE");
  check(response.headers.get("x-robots-tag") === "noindex, nofollow", "ROBOTS");
  check(response.headers.get("content-type") === "text/plain; charset=utf-8", "TYPE");
  check(
    !response.headers.has("set-cookie") && !response.headers.has("location"),
    "SESSION_REDIRECT",
  );
}

/** 고정 정적 자원의 기존 프레임워크 거부를 503과 구분하고 IO 증가가 없는지 확인합니다. */
async function staticWriteControl(origin, label) {
  const before = { ...server.counts };
  const responses = [];
  for (const path of ["/globe.svg", "/favicon.ico"]) {
    stage = `STATIC_WRITE_${label}_${path}`;
    const response = await request(origin, path, "POST");
    const body = await response.text();
    // Next 16.4.5의 public file 405 렌더는 이 고정 fixture에서 plain 500으로 끝납니다.
    // 별도 V8 coverage로 이 요청의 app/chunks 함수 실행 0을 확인했습니다.
    const expected = path === "/globe.svg" ? 500 : 405;
    check(response.status === expected, "STATIC_WRITE_FIXED_STATUS");
    if (expected === 500) check(body === "Internal Server Error", "STATIC_WRITE_FIXED_BODY");
    responses.push({ path, method: "POST", status: response.status, application503: false });
  }
  await delay(100);
  check(
    Object.keys(before).every((code) => before[code] === server.counts[code]),
    "STATIC_WRITE_IO_ZERO",
  );
  results.push({ label: `static-write-${label}`, responses });
}

/** 고정 TRACE 두 경로의 Next Request adapter 거부를 지원 메서드의 503과 구분합니다. */
async function unsupportedTraceControl(origin, label) {
  const before = { ...server.counts };
  const responses = [];
  for (const path of ["/api/health", "/resources"]) {
    stage = `TRACE_${label}_${path}`;
    const diagnostics = server.traceUnsupported;
    const response = await new Promise((resolve, reject) => {
      const request = rawRequest(
        `${origin}${path}`,
        { method: "TRACE", timeout: 10_000 },
        (response) => {
          let body = "";
          response.on("data", (chunk) => {
            body += String(chunk);
          });
          response.once("end", () => resolve({ status: response.statusCode, body }));
        },
      );
      request.once("timeout", () => request.destroy(new Error("PREVIEW_TRACE_TIMEOUT")));
      request.once("error", reject);
      request.end();
    });
    await delay(100);
    // 임의 500을 허용하지 않습니다. 경로·메서드·고정 본문·프레임워크 진단을 함께 묶습니다.
    check(
      response.status === 500 && response.body === "Internal Server Error",
      "TRACE_FIXED_RESPONSE",
    );
    check(server.traceUnsupported === diagnostics + 1, "TRACE_FRAMEWORK_DIAGNOSTIC");
    responses.push({
      path,
      method: "TRACE",
      status: response.status,
      application503: false,
      requestAdapterRejected: true,
    });
  }
  check(
    Object.keys(before).every((code) => before[code] === server.counts[code]),
    "TRACE_IO_ZERO",
  );
  results.push({ label: `unsupported-trace-${label}`, responses });
}

/** route inventory를 읽어 새 API가 matrix에서 빠지지 않게 합니다. */
function apiPaths(directory = join(root, "src/app/api")) {
  const paths = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) paths.push(...apiPaths(path));
    else if (entry.name === "route.ts")
      paths.push(
        "/" +
          relative(join(root, "src/app"), directory)
            .split("/")
            .map((part) =>
              part.startsWith("[...")
                ? "session"
                : part.startsWith("[")
                  ? "10000000-0000-4000-8000-000000000001"
                  : part,
            )
            .join("/"),
      );
  }
  return paths;
}
const optimizer =
  "/_next/image?url=" +
  encodeURIComponent(
    "https://4sompt13gxwuz2x8.public.blob.vercel-storage.com/preview-boundary-sentinel.png",
  ) +
  "&w=64&q=75";

/** 실제 로그인으로 받은 쿠키를 세션 API와 DB가 검증하는 대조군을 만듭니다. */
async function sessions(origin) {
  const cookies = [];
  for (const name of ["pending", "studentA", "faculty", "admin"]) {
    const actor = academicG1Actors[name];
    const csrfResponse = await fetch(`${origin}/api/auth/csrf`);
    const pairs = csrfResponse.headers.getSetCookie().map((value) => value.split(";", 1)[0]);
    const csrf = await csrfResponse.json();
    const response = await fetch(`${origin}/api/auth/callback/credentials`, {
      method: "POST",
      redirect: "manual",
      headers: {
        Origin: origin,
        Cookie: pairs.join("; "),
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Auth-Return-Redirect": "1",
      },
      body: new URLSearchParams({
        csrfToken: csrf.csrfToken,
        email: actor.email,
        password: qaPassword,
        callbackUrl: origin,
      }),
    });
    const cookie = [
      ...pairs,
      ...response.headers.getSetCookie().map((value) => value.split(";", 1)[0]),
    ].join("; ");
    await response.body?.cancel();
    check(cookie.includes("authjs.session-token="), "SIGNED_COOKIE");
    const sessionResponse = await fetch(`${origin}/api/auth/session`, {
      headers: { Cookie: cookie },
    });
    const session = await sessionResponse.json();
    check(session.user?.id === actor.id && session.user?.role === actor.role, "CONTROL_SESSION");
    cookies.push(cookie);
  }
  check(server.counts.DB > 0, "CONTROL_DB_OBSERVED");
  return cookies;
}

/** 최소/합성 자격정보 양쪽에서 API 전수·쿠키·Action·metadata·정적 경계를 확인합니다. */
async function matrix(cookies, sentinel) {
  const origin = await start("preview", sentinel);
  stage = "PREVIEW_MATRIX";
  const apis = ["/api", "/api/missing", ...apiPaths()];
  for (const path of [
    ...new Set(apis),
    "/preview-unavailable",
    optimizer,
    "/_next/data/fixture/member.json",
    "/_next",
    "/_next/unknown",
  ]) {
    for (const method of methods) await denied(origin, path, method);
  }
  for (const path of [
    "/",
    "/login",
    "/admin",
    "/resources",
    "/member/assignments/10000000-0000-4000-8000-000000000001",
    "/mypage",
    "/recruitment/apply",
    "/resources/fixture/print",
    "/missing.pdf",
    "/images/missing.svg",
    "/opengraph-image",
    "/apiary",
  ]) {
    for (const cookie of ["", "authjs.session-token=forged", ...cookies]) {
      for (const method of ["GET", "HEAD", "POST"])
        await denied(origin, path, method, {
          Cookie: cookie,
          "Next-Action": "fixture",
          RSC: "1",
          "X-Forwarded-Host": "production.invalid",
          "X-Vercel-Env": "production",
        });
    }
  }
  for (const contentType of [
    "application/json",
    "application/x-www-form-urlencoded",
    "multipart/form-data; boundary=fixture",
  ])
    await denied(origin, "/resources", "POST", { "Content-Type": contentType });
  for (const path of ["/robots.txt", "/sitemap.xml"]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await request(origin, path, method);
      const body = await response.text();
      check(response.status === 200, "METADATA_STATUS");
      check(response.headers.get("x-robots-tag") === "noindex, nofollow", "METADATA_NOINDEX");
      if (method === "GET")
        check(
          path === "/robots.txt" ? body.includes("Disallow: /") : !body.includes("<loc>"),
          "METADATA_BODY",
        );
    }
    await denied(origin, path, "POST");
  }
  for (const path of [
    "/favicon.ico",
    "/globe.svg",
    "/next.svg",
    "/window.svg",
    "/file.svg",
    "/vercel.svg",
    ...["hero-bg", "faculty-classics", "faculty-casestudy", "faculty-lecture", "cohort-17"].map(
      (name) => `/images/${name}.jpeg`,
    ),
  ]) {
    for (const method of ["GET", "HEAD"]) {
      const response = await request(origin, path, method);
      await response.body?.cancel();
      check(response.status === 200, "STATIC");
    }
  }
  const staticFiles = [];
  function chunks(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) chunks(path);
      else if (entry.name.endsWith(".js")) staticFiles.push(path);
    }
  }
  chunks(join(root, ".next/static"));
  const response = await request(
    origin,
    "/_next/static/" + relative(join(root, ".next/static"), staticFiles[0]),
  );
  await response.body?.cancel();
  check(response.status === 200, "CHUNK");
  for (const path of ["/_next/static/missing.js"]) {
    const response = await request(origin, path);
    await response.body?.cancel();
    check([404, 503].includes(response.status), "FRAMEWORK_REJECTION");
  }
  // 경로 정규화·프레임워크 거부를 앱 503과 구분하여 기록합니다.
  const normalization = [];
  for (const path of [
    "/%61pi/health",
    "/api%2fhealth",
    "/api//health",
    "/api/",
    "/robots.txt%2f",
    "/robots.txt/",
    "/_next/image/",
  ]) {
    const response = await request(origin, path);
    await response.body?.cancel();
    check([308, 400, 503].includes(response.status), "NORMALIZATION");
    normalization.push({ path, status: response.status });
  }
  await staticWriteControl(origin, sentinel ? "preview-sentinel" : "preview-minimal");
  await unsupportedTraceControl(origin, sentinel ? "preview-sentinel" : "preview-minimal");
  results.push({ label: "normalization", sentinel, responses: normalization });
  await delay(100);
  check(
    Object.values(server.counts).every((n) => n === 0),
    "REQUEST_IO_ZERO",
  );
  results.push({ label: "preview-matrix", sentinel, apiPatterns: apiPaths().length, checks });
  await stop();
}

// 중단 신호에서도 이번 실행의 자식·임시 DB만 정리합니다.
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    (async () => {
      if (building) await terminate(building);
      await stop();
      cluster?.close();
    })().then(
      () => process.exit(1),
      () => process.exit(1),
    );
  });

try {
  mkdirSync(artifact, { recursive: true });
  check(process.argv.length === 2, "ARGUMENTS");
  check(
    ![
      ".env",
      ".env.local",
      ".env.production",
      ".env.production.local",
      ".env.development",
      ".env.development.local",
    ].some((name) => existsSync(join(root, name))),
    "ENV_FILE",
  );
  cluster = createQaPostgres(process.env.HRA_TEST_PG_BIN);
  installAcademicG1Base(cluster);
  await build("local");
  let origin = await start("local", true, true);
  const cookies = await sessions(origin);
  // 이전 빌드의 optimizer 캐시를 양성 공급자 호출로 오인하지 않습니다.
  rmSync(join(root, ".next/cache/images"), { recursive: true, force: true });
  const before = server.counts.IMAGE;
  const image = await request(origin, optimizer);
  await image.body?.cancel();
  await delay(100);
  check(server.counts.IMAGE > before, "IMAGE_POSITIVE_CONTROL");
  check(image.status === 200, "IMAGE_CONTROL_STATUS");
  const csrf = await request(origin, "/api/auth/csrf");
  await csrf.body?.cancel();
  check(csrf.status === 200, "LOCAL_API_CONTROL");
  await staticWriteControl(origin, "local");
  await unsupportedTraceControl(origin, "local");
  await stop();
  origin = await start("tag-only", true, true);
  const tag = await request(origin, "/api/auth/csrf");
  await tag.body?.cancel();
  check(tag.status === 200, "TAG_ONLY_CONTROL");
  await stop();
  // 음성: local artifact를 Preview 실행으로 바꾸어도 rewrite가 새로 생기지 않습니다.
  origin = await start("preview");
  await denied(origin, "/admin");
  const mismatch = await request(origin, "/api/auth/csrf");
  await mismatch.body?.cancel();
  check(mismatch.status !== 503, "MISMATCH_DETECTED");
  results.push({ label: "local-build-preview-runtime", deploymentValidation: "FAIL_EXPECTED" });
  await stop();
  await build("preview");
  await matrix(cookies, false);
  await matrix(cookies, true);
  // 반대 음성: Preview artifact의 rewrite는 Production 실행에서도 남습니다.
  origin = await start("production");
  await denied(origin, "/api/auth/csrf");
  results.push({
    label: "preview-build-production-runtime",
    deploymentValidation: "FAIL_EXPECTED",
  });
  await stop();
  await build("production");
  origin = await start("production", true, true);
  await sessions(origin);
  rmSync(join(root, ".next/cache/images"), { recursive: true, force: true });
  const productionImageCount = server.counts.IMAGE;
  const productionImage = await request(origin, optimizer);
  await productionImage.body?.cancel();
  await delay(100);
  check(
    productionImage.status === 200 && server.counts.IMAGE > productionImageCount,
    "PRODUCTION_IMAGE_CONTROL",
  );
  const productionApi = await request(origin, "/api/auth/csrf");
  await productionApi.body?.cancel();
  check(productionApi.status === 200, "PRODUCTION_API_CONTROL");
  await staticWriteControl(origin, "production");
  await unsupportedTraceControl(origin, "production");
  await stop();
  console.log(`PASS PREVIEW_HTTP_CHECKS:${checks}`);
  results.push({
    label: "limitations",
    text: "일반 next start만 검증. Vercel adapter/minimalMode·실제 tuple/scope·prebuilt/promotion은 별도 게이트. framework 본문 수신/clone 0은 주장하지 않음.",
  });
} catch (error) {
  console.error(
    error instanceof Error && /^PREVIEW_[A-Z0-9_]+$/.test(error.message)
      ? error.message
      : "PREVIEW_GATE_FAILED",
  );
  console.error(`PREVIEW_STAGE:${stage}`);
  process.exitCode = 1;
} finally {
  await stop();
  cluster?.close();
  writeFileSync(
    join(artifact, "http-results.json"),
    JSON.stringify({ checks, passed: !process.exitCode, results }, null, 2) + "\n",
  );
}
