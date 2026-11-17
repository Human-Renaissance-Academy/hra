/**
 * 같은 설치 Next의 fetch·native MPA·chunked 본문 경계를 실제 HTTP로 검사합니다.
 * fixture는 소유 임시 프로젝트에만 생성하며 운영 앱 source/config를 변경하지 않습니다.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { request as httpRequest } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const options = Object.fromEntries(
  process.argv.slice(2).map((value) => {
    const match = /^--(fixture-cap|probe-limit|output)=(.+)$/.exec(value);
    assert(match, "CAP_ARGUMENTS");
    return [match[1], match[2]];
  }),
);
assert(options.output, "CAP_OUTPUT_REQUIRED");
const require = createRequire(join(repository, "package.json"));
const cap =
  options["fixture-cap"] ??
  JSON.parse(readFileSync(join(repository, ".next/required-server-files.json"))).config.experimental
    .serverActions.bodySizeLimit;
assert(["5mb", "32mb"].includes(cap), "CAP_VALUE");
const limit = require("next/dist/compiled/bytes").parse(options["probe-limit"] ?? cap);
assert(!options["probe-limit"] || options["fixture-cap"], "CAP_PROBE_ONLY_IN_FIXTURE");
const { encodeReply } = require("next/dist/compiled/react-server-dom-webpack/client.node.js");
const root = mkdtempSync(join(tmpdir(), "hra511-parser-"));
const entriesPath = join(root, "entries.jsonl");
const invocationsPath = join(root, "invocations.jsonl");
const listener = createServer();
await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const origin = `http://127.0.0.1:${port}`;
const environment = {
  PATH: process.env.PATH,
  HOME: process.env.HOME,
  SYSTEMROOT: process.env.SYSTEMROOT,
  NODE_ENV: "production",
  NEXT_TELEMETRY_DISABLED: "1",
  AUTH_URL: origin,
  TMPDIR: root,
  TMP: root,
  TEMP: root,
  NODE_OPTIONS: `--import=${pathToFileURL(join(repository, "tests/support/server-action-cap-network.mjs")).href}`,
};
let server,
  browser,
  serverDone,
  serverOutput = "";
const cases = [];
const entries = () =>
  existsSync(entriesPath)
    ? readFileSync(entriesPath, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
const invocations = () =>
  existsSync(invocationsPath)
    ? readFileSync(invocationsPath, "utf8").split("\n").filter(Boolean).length
    : 0;

/** HTTP 송신 대상은 소유 포트 하나이며 chunked일 때 Content-Length를 보내지 않습니다. */
function send(body, headers, chunked) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      origin,
      {
        method: "POST",
        path: "/",
        headers: {
          Origin: origin,
          ...headers,
          ...(chunked
            ? { "Transfer-Encoding": "chunked" }
            : { "Content-Length": String(body.length) }),
        },
        timeout: 20000,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () =>
          resolve({
            status: response.statusCode,
            contentType: response.headers["content-type"],
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    request.on("error", reject);
    request.on("timeout", () => request.destroy(new Error("CAP_HTTP_TIMEOUT")));
    if (chunked)
      for (let position = 0; position < body.length; position += 16384)
        request.write(body.subarray(position, position + 16384));
    else request.write(body);
    request.end();
  });
}

/** React가 만든 FormData의 문자열 항목을 고정 boundary로 직렬화하여 wire byte를 정확히 맞춥니다. */
function multipart(form) {
  const boundary = "hra511boundary";
  const parts = [...form].map(([key, value]) => {
    assert.equal(typeof value, "string", "CAP_FIXTURE_STRING_PART");
    return `--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`;
  });
  return {
    body: Buffer.from(parts.join("") + `--${boundary}--\r\n`),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/** 전체 본문 길이에서 실제 envelope를 빼고 유효한 ASCII padding만 가변화합니다. */
async function payload(mode, total, actionId) {
  const encode = async (padding) => {
    if (mode === "fetch-text")
      return {
        body: Buffer.from(await encodeReply([padding])),
        contentType: "text/plain;charset=UTF-8",
      };
    const form = new FormData();
    form.set("padding", padding);
    if (mode === "native") {
      form.set(`$ACTION_ID_${actionId}`, "");
      return multipart(form);
    }
    return multipart(await encodeReply([form]));
  };
  const empty = await encode("");
  const padding = "a".repeat(total - empty.body.length);
  const encoded = await encode(padding);
  assert.equal(encoded.body.length, total, "CAP_WIRE_BYTES");
  return {
    ...encoded,
    paddingBytes: padding.length,
    sha256: createHash("sha256").update(padding).digest("hex"),
  };
}

/** 자식 출력을 파일에만 보관하고 실패 때도 원본 stack/body를 공개하지 않습니다. */
async function build() {
  cpSync(join(repository, "tests/fixtures/server-action-cap/app"), join(root, "app"), {
    recursive: true,
  });
  symlinkSync(join(repository, "node_modules"), join(root, "node_modules"));
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        next: require("next/package.json").version,
        react: require("react/package.json").version,
        "react-dom": require("react-dom/package.json").version,
      },
    }),
  );
  writeFileSync(
    join(root, "next.config.mjs"),
    `export default { experimental: { serverActions: { bodySizeLimit: ${JSON.stringify(cap)} } } };\n`,
  );
  const child = spawn(
    process.execPath,
    [join(repository, "node_modules/next/dist/bin/next"), "build", "--webpack"],
    { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (value) => {
    output += value;
  });
  child.stderr.on("data", (value) => {
    output += value;
  });
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  writeFileSync(`${resolve(options.output)}.build.log`, output);
  assert.equal(code, 0, "CAP_FIXTURE_BUILD");
  assert(!output.includes("CAP_NETWORK_BLOCKED"), "CAP_BUILD_NETWORK_ATTEMPT");
  assert.equal(
    JSON.parse(readFileSync(join(root, ".next/required-server-files.json"))).config.experimental
      .serverActions.bodySizeLimit,
    cap,
  );
}

try {
  assert.equal(process.version, "v24.15.0", "CAP_NODE_VERSION");
  mkdirSync(dirname(resolve(options.output)), { recursive: true });
  await build();
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
    { cwd: root, env: environment, stdio: ["ignore", "pipe", "pipe"] },
  );
  server.stdout.on("data", (chunk) => {
    serverOutput += chunk;
  });
  server.stderr.on("data", (chunk) => {
    serverOutput += chunk;
  });
  serverDone = new Promise((resolve) => {
    server.once("exit", resolve);
  });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    assert.equal(server.exitCode, null, "CAP_SERVER_EXIT");
    try {
      const response = await fetch(origin, { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        await response.body.cancel();
        ready = true;
        break;
      }
    } catch {
      /* 기동 중인 소유 서버의 연결 거부만 제한 횟수 안에서 재시도합니다. */
    }
    await delay(100);
  }
  assert(ready, "CAP_SERVER_READY");
  browser = await chromium.launch({ executablePath: "/usr/bin/google-chrome", headless: true });
  const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block" });
  await context.route("**/*", (route) =>
    new URL(route.request().url()).origin === origin ? route.continue() : route.abort(),
  );
  const page = await context.newPage();
  await page.goto(origin);
  const name = await page.locator('input[name^="$ACTION_ID_"]').getAttribute("name");
  assert(name, "CAP_NATIVE_ACTION_REFERENCE");
  const actionId = name.slice("$ACTION_ID_".length);
  await Promise.all([
    page.waitForNavigation(),
    page.getByRole("button", { name: "전송", exact: true }).click(),
  ]);
  assert.equal(invocations(), 1, "CAP_REAL_NOJS_POSITIVE");
  await context.close();
  for (const mode of ["fetch-multipart", "fetch-text", "native"]) {
    for (const chunked of [false, true]) {
      for (const delta of [-1, 0, 1]) {
        const value = await payload(mode, limit + delta, actionId);
        const before = invocations();
        const logPosition = serverOutput.length;
        const response = await send(
          value.body,
          {
            "Content-Type": value.contentType,
            ...(mode === "native" ? {} : { "Next-Action": actionId }),
          },
          chunked,
        );
        const invoked = invocations() - before;
        cases.push({
          mode,
          transport: chunked ? "chunked" : "content-length",
          wireBytes: value.body.length,
          delta,
          status: response.status,
          contentType: response.contentType,
          invoked,
        });
        if (delta <= 0) {
          assert.equal(invoked, 1, "CAP_ACCEPTED_ENTRY");
          assert.deepEqual(
            entries().at(-1),
            { bytes: value.paddingBytes, sha256: value.sha256 },
            "CAP_ACCEPTED_BYTES",
          );
          assert.equal(response.status, 200, "CAP_ACCEPTED_STATUS");
        } else {
          assert.equal(invoked, 0, "CAP_REJECTED_ENTRY");
          assert(response.status >= 400, "CAP_REJECTED_STATUS");
          for (
            let attempt = 0;
            attempt < 100 &&
            !serverOutput.slice(logPosition).includes(`Body exceeded ${cap} limit`);
            attempt++
          )
            await delay(10);
          assert(
            serverOutput.slice(logPosition).includes(`Body exceeded ${cap} limit`),
            "CAP_REJECTED_LIMIT_CAUSE",
          );
        }
      }
    }
  }
  const small = await payload("fetch-text", 64, actionId);
  const before = invocations();
  assert.equal(
    (await send(small.body, { "Content-Type": small.contentType, "Next-Action": actionId }, false))
      .status,
    200,
  );
  assert.equal(invocations(), before + 1, "CAP_RECOVERY");
  assert(!serverOutput.includes("CAP_NETWORK_BLOCKED"), "CAP_NETWORK_ATTEMPT");
  writeFileSync(
    resolve(options.output),
    JSON.stringify(
      {
        node: process.version,
        next: require("next/package.json").version,
        cap,
        limit,
        fixtureOnly: Boolean(options["fixture-cap"]),
        nativeBrowserPositive: true,
        cases,
        recovery: true,
      },
      null,
      2,
    ) + "\n",
  );
  console.log(`PASS CAP_HTTP ${cases.length} cases; actual native browser positive; recovery`);
} catch (error) {
  const failure =
    error instanceof assert.AssertionError ? error.message.split("\n")[0] : "CAP_EXECUTION_FAILED";
  writeFileSync(
    resolve(options.output),
    JSON.stringify({ completed: false, cap, limit, cases, failure }, null, 2) + "\n",
  );
  console.error(failure);
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
  writeFileSync(`${resolve(options.output)}.server.log`, serverOutput);
  rmSync(root, { recursive: true, force: true });
}
