/**
 * 실제 기수 폼→Server Action→소유권 원장→SDK PUT→격리 DB 저장의 4MiB 양성 회귀입니다.
 * 기존 production build를 사용하고 source/config·운영 DB/Blob는 변경하지 않습니다.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { hashSync } from "bcryptjs";
import { chromium } from "@playwright/test";
import { createQaPostgres, qaPassword } from "../tests/support/resource-qa-postgres.mjs";
import { exportQaSchemaSql } from "../tests/support/qa-schema-export.mjs";
import { projectBlobHost } from "../src/lib/blob-host.ts";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const match = /^--output=(.+)$/.exec(process.argv[2] ?? "");
assert(match && process.argv.length === 3, "COHORT_QA_ARGUMENTS");
const output = resolve(match[1]);
const config = JSON.parse(
  readFileSync(join(repository, ".next/required-server-files.json")),
).config;
const cap = config.experimental.serverActions.bodySizeLimit;
const wirePath = join(repository, ".next/cohort-wire.jsonl");
rmSync(wirePath, { force: true });
assert(["32mb", "5mb"].includes(cap), "COHORT_QA_BUILD_CAP");
assert.equal(process.version, "v24.15.0", "COHORT_QA_NODE");
assert(!existsSync(join(repository, ".env")), "COHORT_QA_ENV_FILE");
const actor = "10000000-0000-4000-8000-000000000001";
const title = "합성 511기";
const token = `vercel_blob_rw_${projectBlobHost.split(".")[0]}_${"a".repeat(32)}`;
const bytes = Buffer.alloc(4 * 1024 * 1024);
Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=",
  "base64",
).copy(bytes);
const fileHash = createHash("sha256").update(bytes).digest("hex");
let cluster,
  server,
  serverDone,
  browser,
  store,
  logs = "";
const puts = [],
  actions = [],
  failures = [];
try {
  mkdirSync(dirname(output), { recursive: true });
  cluster = createQaPostgres(process.env.HRA_TEST_PG_BIN);
  cluster.sql(exportQaSchemaSql(repository));
  cluster.sql(readFileSync(join(repository, "scripts/sql/rate-limit-reservations.sql"), "utf8"));
  cluster.sql(
    `INSERT INTO users(id,name,email,password_hash,role) VALUES('${actor}','합성 관리자','admin@cap-qa.invalid','${hashSync(qaPassword, 12)}','ADMIN');`,
  );
  store = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      assert.equal(request.method, "PUT");
      assert(["/api/blob", "/api/blob/"].includes(url.pathname));
      assert.equal(request.headers.authorization, `Bearer ${token}`);
      assert.equal(request.headers["x-content-type"], "image/png");
      const key = url.searchParams.get("pathname");
      assert(/^cohorts\/[a-f0-9-]{36}\.png$/.test(key), "COHORT_QA_BLOB_PATH");
      const blobUrl = `https://${projectBlobHost}/${key}`;
      assert.equal(
        cluster.sql(
          `SELECT count(*) FROM markdown_image_assets WHERE url='${blobUrl}' AND uploaded_by_id='${actor}'`,
        ),
        "1",
        "COHORT_QA_RESERVATION_FIRST",
      );
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        assert(size <= bytes.length);
        chunks.push(chunk);
      }
      assert.equal(size, bytes.length, "COHORT_QA_PROVIDER_BYTES");
      assert.equal(createHash("sha256").update(Buffer.concat(chunks)).digest("hex"), fileHash);
      puts.push({ size, sha256: fileHash, reservedBeforePut: true });
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({
          url: blobUrl,
          downloadUrl: blobUrl,
          pathname: key,
          contentType: "image/png",
          contentDisposition: "inline",
          etag: '"cap-qa"',
        }),
      );
    } catch {
      failures.push("COHORT_QA_STORE");
      request.resume();
      response.writeHead(400, { "Content-Type": "application/json" });
      response.end(
        JSON.stringify({ error: { code: "bad_request", message: "합성 저장소 요청 거부" } }),
      );
    }
  });
  await new Promise((resolve) => store.listen(0, "127.0.0.1", resolve));
  const portProbe = createServer();
  await new Promise((resolve) => portProbe.listen(0, "127.0.0.1", resolve));
  const port = portProbe.address().port;
  await new Promise((resolve) => portProbe.close(resolve));
  const origin = `http://127.0.0.1:${port}`;
  const environment = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    TMPDIR: process.env.TMPDIR,
    TMP: process.env.TMP,
    TEMP: process.env.TEMP,
    SYSTEMROOT: process.env.SYSTEMROOT,
    ...cluster.environment,
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    AUTH_URL: origin,
    NEXTAUTH_URL: origin,
    AUTH_SECRET: "synthetic-cap-only-auth-secret",
    AUTH_TRUST_HOST: "true",
    BLOB_READ_WRITE_TOKEN: token,
    HRA_G1_STORE_ORIGIN: `http://127.0.0.1:${store.address().port}`,
    NODE_OPTIONS: `--import=${pathToFileURL(join(repository, "tests/support/server-action-cohort-preload.mjs")).href}`,
  };
  server = spawn(
    process.execPath,
    [
      join(repository, "node_modules/next/dist/bin/next"),
      "start",
      "--hostname",
      "127.0.0.1",
      "--port",
      String(port),
    ],
    { cwd: repository, env: environment, stdio: ["ignore", "pipe", "pipe"] },
  );
  server.stdout.on("data", (chunk) => {
    logs += chunk;
  });
  server.stderr.on("data", (chunk) => {
    logs += chunk;
  });
  serverDone = new Promise((resolve) => server.once("exit", resolve));
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(server.exitCode, null, "COHORT_QA_SERVER_EXIT");
    try {
      const response = await fetch(`${origin}/api/auth/csrf`, {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        await response.body.cancel();
        ready = true;
        break;
      }
    } catch {
      /* 기동 중인 소유 서버 연결만 제한 횟수 안에서 재시도합니다. */
    }
    await delay(100);
  }
  assert(ready, "COHORT_QA_READY");
  browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
  const context = await browser.newContext({ serviceWorkers: "block" });
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      failures.push("COHORT_QA_BROWSER_EXTERNAL");
      return route.abort();
    }
    if (url.pathname === "/_next/image")
      return route.fulfill({ contentType: "image/png", body: bytes.subarray(0, 68) });
    return route.continue();
  });
  const csrf = await (await context.request.get(`${origin}/api/auth/csrf`)).json();
  await context.request.post(`${origin}/api/auth/callback/credentials`, {
    headers: { Origin: origin, "X-Auth-Return-Redirect": "1" },
    form: {
      csrfToken: csrf.csrfToken,
      email: "admin@cap-qa.invalid",
      password: qaPassword,
      callbackUrl: origin,
    },
  });
  const session = await (await context.request.get(`${origin}/api/auth/session`)).json();
  assert.equal(session.user?.id, actor, "COHORT_QA_REAL_LOGIN");
  const page = await context.newPage();
  page.on("pageerror", () => failures.push("COHORT_QA_PAGE_ERROR"));
  page.on("request", (request) => {
    if (request.method() === "POST" && request.headers()["next-action"]) {
      const body = request.postDataBuffer();
      actions.push({
        cdpBytes: body?.length ?? null,
        contentType: request.headers()["content-type"],
        cdpContainsFileBytes: body ? body.indexOf(bytes.subarray(0, 12)) >= 0 : false,
      });
    }
  });
  await page.goto(`${origin}/admin/recruitment/new`, { waitUntil: "networkidle" });
  await page.getByLabel("기수명", { exact: true }).fill(title);
  await page.getByLabel("설명", { exact: true }).fill("가".repeat(5000));
  await page
    .locator('input[name="image"]')
    .setInputFiles({ name: "합성.png", mimeType: "image/png", buffer: bytes });
  await Promise.all([
    page.waitForURL(`${origin}/admin/recruitment`),
    page.getByRole("button", { name: "기수 추가", exact: true }).click(),
  ]);
  assert.equal(
    cluster.sql(
      `SELECT count(*) FROM cohorts WHERE name='${title}' AND image_url LIKE 'https://${projectBlobHost}/cohorts/%' AND length(description)=5000`,
    ),
    "1",
    "COHORT_QA_REAL_INSERT",
  );
  assert.equal(puts.length, 1, "COHORT_QA_ONE_PUT");
  assert.equal(actions.length, 1, "COHORT_QA_ONE_ACTION");
  const wire = readFileSync(wirePath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(wire.length, 1, "COHORT_QA_ONE_SERVER_BODY");
  assert(
    wire[0].bytes > bytes.length && wire[0].bytes < 5 * 1024 * 1024,
    "COHORT_QA_4MIB_WITHIN_5MIB",
  );
  assert.deepEqual(failures, []);
  assert(!/COHORT_QA_NETWORK_BLOCKED|QA_TRANSPORT_FAILURE/.test(logs), "COHORT_QA_NETWORK_AND_SQL");
  writeFileSync(
    output,
    JSON.stringify(
      {
        node: process.version,
        cap,
        fileBytes: bytes.length,
        fileSha256: fileHash,
        actions,
        wire,
        puts,
        realForm: true,
        realAction: true,
        realAuth: true,
        isolatedPg: true,
        saved: true,
        externalNetwork: 0,
      },
      null,
      2,
    ) + "\n",
  );
  console.log("PASS COHORT_HTTP actual 4MiB form/action/auth/PG/SDK reservation and save");
  await context.close();
} catch (error) {
  const code =
    error instanceof assert.AssertionError
      ? error.message.split("\n")[0]
      : "COHORT_QA_EXECUTION_FAILED";
  writeFileSync(
    output,
    JSON.stringify({ completed: false, cap, actions, puts, failures, code }, null, 2) + "\n",
  );
  console.error(code);
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    server.kill("SIGTERM");
    await Promise.race([serverDone, delay(5000)]);
    if (server.exitCode === null) {
      server.kill("SIGKILL");
      await serverDone;
    }
  }
  if (store) {
    store.closeAllConnections();
    await new Promise((resolve) => store.close(resolve));
  }
  cluster?.close();
  rmSync(wirePath, { force: true });
  writeFileSync(`${output}.server.log`, logs);
}
