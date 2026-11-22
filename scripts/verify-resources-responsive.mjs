/**
 * 회원 자료실(/resources) 반응형 회귀(#601)를 실제 Next production 빌드·credentials 세션·격리 PostgreSQL로 검증합니다.
 *
 * 역할:
 * - 환경 파일 없는 체크아웃에서 이미 만든 `.next` 빌드를 `next start`로 띄웁니다(CI는 앞 단계 `npm run build` 재사용).
 * - 실제 Drizzle 스키마를 새 임시 PostgreSQL에 설치하고 합성 MEMBER·FACULTY 계정과 자료만 넣습니다.
 * - Playwright spec(tests/e2e/resources-responsive.spec.ts)을 320·375·390·768·1280px에서 실행하고
 *   스크린샷을 test-results/resources-responsive/에 남깁니다(.gitignore 대상).
 * - 운영 DB·Blob·OAuth에 접속하지 않습니다. 자식 프로세스에는 허용한 시스템 값과 합성 값만 전달합니다.
 *
 * 사용법: npm run build && HRA_TEST_PG_BIN=<PostgreSQL bin> node scripts/verify-resources-responsive.mjs
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createQaPostgres } from "../tests/support/resource-qa-postgres.mjs";
import { exportQaSchemaSql } from "../tests/support/qa-schema-export.mjs";
import { installResourcesResponsiveFixture } from "../tests/support/resources-responsive-fixture.mjs";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
// 외부 자격 증명·NODE_OPTIONS를 상속하지 않고 실행에 필요한 시스템 값만 자식 환경으로 복사합니다.
const allowedEnvironment = Object.fromEntries(
  ["PATH", "HOME", "TMPDIR", "TMP", "TEMP", "SYSTEMROOT"]
    .filter((key) => process.env[key])
    .map((key) => [key, process.env[key]]),
);
const check = (condition, code) => {
  if (!condition) throw new Error(`RESOURCES_RESPONSIVE_${code}`);
};
let cluster, server, serverDone;

/** 임의 포트 번호만 확인하고 실제 수신은 Next 자식 프로세스가 맡습니다. */
async function availablePort() {
  const listener = createServer();
  await new Promise((resolve, reject) => {
    listener.once("error", reject);
    listener.listen(0, "127.0.0.1", resolve);
  });
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}

try {
  check(process.argv.length === 2, "ARGUMENTS");
  // Next가 환경 파일을 자동으로 읽어 운영 비밀값이 섞이지 않도록 파일이 없는 체크아웃에서만 실행합니다.
  check(
    ![
      ".env",
      ".env.local",
      ".env.development",
      ".env.development.local",
      ".env.production",
      ".env.production.local",
    ].some((name) => existsSync(join(repository, name))),
    "ENV_FILE",
  );
  check(existsSync(join(repository, ".next", "BUILD_ID")), "BUILD_REQUIRED");

  // 1) 실제 스키마 + 로그인 요청 제한 함수 + 합성 자료를 새 임시 클러스터에 설치합니다.
  const schemaSql = exportQaSchemaSql(repository);
  cluster = createQaPostgres(process.env.HRA_TEST_PG_BIN);
  cluster.sql(schemaSql);
  cluster.sql(readFileSync(join(repository, "scripts/sql/rate-limit-reservations.sql"), "utf8"));
  installResourcesResponsiveFixture(cluster);

  // 2) production 빌드를 합성 인증 비밀값과 격리 DB 전송 어댑터로 시작합니다.
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const environment = {
    ...allowedEnvironment,
    ...cluster.environment,
    LC_ALL: "C",
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
    AUTH_SECRET: randomBytes(48).toString("hex"),
    AUTH_TRUST_HOST: "true",
    AUTH_URL: baseUrl,
    NEXTAUTH_URL: baseUrl,
    NEXT_PUBLIC_APP_URL: baseUrl,
    AUTH_GOOGLE_ID: "",
    AUTH_GOOGLE_SECRET: "",
    AUTH_KAKAO_ID: "",
    AUTH_KAKAO_SECRET: "",
    BLOB_READ_WRITE_TOKEN: "",
    RESOURCE_PRIVATE_READ_WRITE_TOKEN: "",
    RESOURCE_PRIVATE_BLOB_HOST: "",
    NODE_OPTIONS: `--import=${JSON.stringify(join(repository, "tests/support/resource-qa-preload.mjs"))}`,
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
    { cwd: repository, env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  // 서버 로그에는 SQL·쿠키가 섞일 수 있어 저장하거나 출력하지 않습니다.
  server.stdout.resume();
  server.stderr.resume();
  let exited = false;
  serverDone = new Promise((resolve) => {
    server.once("error", () => {
      exited = true;
      resolve();
    });
    server.once("exit", () => {
      exited = true;
      resolve();
    });
  });
  let ready = false;
  for (let attempt = 0; attempt < 240 && !exited && !ready; attempt++) {
    try {
      const response = await fetch(`${baseUrl}/api/auth/csrf`, {
        signal: AbortSignal.timeout(5_000),
      });
      ready = response.ok;
      await response.body?.cancel();
    } catch {
      // 서버 준비 전 연결 실패는 제한된 횟수 안에서 다시 확인합니다.
      ready = false;
    }
    if (!ready) await delay(250);
  }
  check(ready, "APP_READY");

  // 3) 저장소 Playwright 설정(PLAYWRIGHT_BASE_URL이 있으면 webServer 미사용)으로 반응형 spec만 실행합니다.
  const browser = spawn(
    process.execPath,
    [
      join(repository, "node_modules/@playwright/test/cli.js"),
      "test",
      "tests/e2e/resources-responsive.spec.ts",
      "--workers=1",
    ],
    {
      cwd: repository,
      stdio: "inherit",
      env: {
        ...allowedEnvironment,
        CI: "true",
        PLAYWRIGHT_BASE_URL: baseUrl,
        HRA_RESOURCES_RESPONSIVE_QA: "true",
      },
    },
  );
  const code = await new Promise((resolve) => {
    browser.once("error", () => resolve(1));
    browser.once("exit", resolve);
  });
  check(code === 0, "BROWSER_FAILED");
  console.log(
    "PASS 자료실 반응형 320·375·390·768·1280px (격리 DB·실제 credentials·MEMBER/FACULTY)",
  );
} catch (error) {
  // 원문 오류에는 SQL·연결 정보가 포함될 수 있어 고정 진단 코드만 출력합니다.
  console.error(
    error instanceof Error && /^RESOURCES_RESPONSIVE_[A-Z_]+$/.test(error.message)
      ? error.message
      : "RESOURCES_RESPONSIVE_FAILED",
  );
  process.exitCode = 1;
} finally {
  if (server?.pid) {
    for (const signal of ["SIGTERM", "SIGKILL"]) {
      try {
        process.kill(-server.pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") process.exitCode = 1;
      }
      if (signal === "SIGTERM") await Promise.race([serverDone, delay(5_000)]);
      if (server.exitCode !== null || server.signalCode !== null) break;
    }
  }
  cluster?.close();
}
