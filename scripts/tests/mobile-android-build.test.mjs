/** 실제 Android 실행 래퍼를 격리된 Gradle 대역으로 실행해 진단 인자와 종료 코드 전달을 검증합니다. */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// 공통 Gradle 진단 인자입니다. 변형별 작업 인자 뒤에 붙습니다.
const COMMON_ARGS = ["--no-daemon", "--max-workers=2", "--stacktrace", "--console=plain"];

/** 실제 래퍼를 임시 디렉터리로 복사하고 Gradle 대역으로 실행한 결과와 기록된 인자를 돌려줍니다. */
function runWrapper(wrapperArgs, exitCode) {
  const temporary = mkdtempSync(join(tmpdir(), "hra-mobile-gradle-contract-"));
  try {
    const scripts = join(temporary, "scripts");
    const android = join(temporary, "android");
    const trace = join(temporary, "trace.json");
    mkdirSync(scripts);
    mkdirSync(android);
    copyFileSync(
      fileURLToPath(new URL("../../apps/mobile/scripts/build-android.mjs", import.meta.url)),
      join(scripts, "build-android.mjs"),
    );
    writeFileSync(
      join(android, "gradlew"),
      [
        "#!/usr/bin/env node",
        `require('node:fs').writeFileSync(${JSON.stringify(trace)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));`,
        `process.exitCode = ${exitCode};`,
      ].join("\n"),
      { mode: 0o700 },
    );
    const result = spawnSync(
      process.execPath,
      [join(scripts, "build-android.mjs"), ...wrapperArgs],
      { env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` }, encoding: "utf8" },
    );
    let invocation = null;
    try {
      invocation = JSON.parse(readFileSync(trace, "utf8"));
    } catch (error) {
      // Gradle 대역이 호출되지 않은 경우(거부 경로)에만 기록 파일이 없습니다.
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    return { result, invocation, android: realpathSync(android) };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

describe("Android 빌드 실행 계약", () => {
  test("release 변형은 arm64 release APK 작업만 실행한다 (#573)", () => {
    const { result, invocation, android } = runWrapper(["release"], 0);
    assert.equal(result.status, 0);
    assert.deepEqual(invocation, {
      args: ["assembleRelease", "-PreactNativeArchitectures=arm64-v8a", ...COMMON_ARGS],
      cwd: android,
    });
  });

  for (const wrapperArgs of [["releas"], ["debug", "release"], ["--release"]])
    test(`알 수 없는 변형 ${JSON.stringify(wrapperArgs)}은 Gradle을 호출하지 않고 거부한다`, () => {
      const { result, invocation } = runWrapper(wrapperArgs, 0);
      assert.equal(result.status, 2);
      assert.equal(invocation, null);
      assert.match(result.stderr, /알 수 없는 Android 빌드 변형/);
    });

  test("release 테스트 APK 작업은 main 수동 실행에서만 운영 HTTPS 주소로 만든다", () => {
    const workflow = readFileSync(
      new URL("../../.github/workflows/mobile.yml", import.meta.url),
      "utf8",
    );
    const job = workflow.slice(workflow.indexOf("  android-release-test:"));
    assert.ok(job.length > 0 && workflow.includes("  android-release-test:"));
    assert.match(
      job,
      /if: \$\{\{ github\.event_name == 'workflow_dispatch' && inputs\.release_test_apk && github\.ref == 'refs\/heads\/main' \}\}/,
    );
    assert.match(job, /EXPO_PUBLIC_API_BASE_URL: https:\/\/hra-website-theta\.vercel\.app\n/);
    assert.match(job, /run: npm run build:android:release-test/);
    assert.match(job, /retention-days: 7/);
    // 운영 비밀값·EAS 토큰·스토어 제출을 사용하지 않습니다.
    assert.doesNotMatch(job, /secrets\.|EXPO_TOKEN|eas (?:build|submit)/);
  });

  for (const exitCode of [0, 17])
    test(`Gradle의 종료 코드 ${exitCode}와 진단 출력을 전달한다`, () => {
      const temporary = mkdtempSync(join(tmpdir(), "hra-mobile-gradle-contract-"));
      try {
        const scripts = join(temporary, "scripts");
        const android = join(temporary, "android");
        const trace = join(temporary, "trace.json");
        mkdirSync(scripts);
        mkdirSync(android);
        copyFileSync(
          fileURLToPath(new URL("../../apps/mobile/scripts/build-android.mjs", import.meta.url)),
          join(scripts, "build-android.mjs"),
        );
        // SDK·네트워크를 사용하지 않고 자식 프로세스가 받은 인자·작업 디렉터리만 기록합니다.
        writeFileSync(
          join(android, "gradlew"),
          [
            "#!/usr/bin/env node",
            `require('node:fs').writeFileSync(${JSON.stringify(trace)}, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }));`,
            "console.log('GRADLE_CONTRACT_STDOUT');",
            "console.error('GRADLE_CONTRACT_STDERR');",
            `process.exitCode = ${exitCode};`,
          ].join("\n"),
          { mode: 0o700 },
        );

        const result = spawnSync(process.execPath, [join(scripts, "build-android.mjs")], {
          // 실제 래퍼가 호출한 Node 대역에도 현재 검증 중인 Node 실행 파일을 사용합니다.
          env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin` },
          encoding: "utf8",
        });
        assert.equal(result.error, undefined);
        assert.equal(result.status, exitCode);
        assert.deepEqual(JSON.parse(readFileSync(trace, "utf8")), {
          args: [
            "assembleDebug",
            "--no-daemon",
            "--max-workers=2",
            "--stacktrace",
            "--console=plain",
          ],
          cwd: realpathSync(android),
        });
        assert.match(result.stdout, /GRADLE_CONTRACT_STDOUT/);
        assert.match(result.stderr, /GRADLE_CONTRACT_STDERR/);
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
    });
});
