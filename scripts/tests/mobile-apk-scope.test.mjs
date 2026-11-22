/**
 * 모바일 debug APK 컴파일 생략 판정(#492 선택지 A)의 회귀 테스트입니다.
 * release-please 제품 버전 필드만 바뀐 경우에만 생략하고, 나머지 모든 경우는 컴파일을 실행하는지 확인합니다.
 * 실제 CLI는 임시 Git 저장소에서 실행하며 현재 저장소나 네트워크를 사용하지 않습니다.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { classifyMobileApkChanges } from "../detect-mobile-apk-scope.mjs";

// release-please가 만드는 형태의 모바일 manifest/lock 원문입니다.
const manifest = (version, extra = "") =>
  `{\n  "name": "hra-mobile",\n  "version": "${version}",\n  "private": true${extra}\n}\n`;
const lock = (version, rootVersion = version, dependency = "1.0.0") =>
  JSON.stringify(
    {
      name: "hra-mobile",
      version,
      lockfileVersion: 3,
      requires: true,
      packages: {
        "": { name: "hra-mobile", version: rootVersion },
        "node_modules/a": { version: dependency },
      },
    },
    null,
    2,
  ) + "\n";
const change = (path, base, head) => ({
  path,
  base: base === null ? null : Buffer.from(base),
  head: head === null ? null : Buffer.from(head),
});
// release PR이 실제로 바꾸는 6개 파일 조합입니다(루트 파일은 내용 비교 대상이 아닙니다).
const releaseChanges = () => [
  change("CHANGELOG.md", null, null),
  change("package.json", null, null),
  change("package-lock.json", null, null),
  change(".release-please-manifest.json", null, null),
  change("apps/mobile/package.json", manifest("0.2.2"), manifest("0.2.3")),
  change("apps/mobile/package-lock.json", lock("0.2.2"), lock("0.2.3")),
];

describe("버전 전용 판정", () => {
  test("release-please 제품 버전 필드만 바뀌면 컴파일을 생략한다", () => {
    assert.deepEqual(classifyMobileApkChanges(releaseChanges()), {
      apk: false,
      reason: "release-version-only",
    });
    // 모바일 manifest 하나만 바뀐 경우도 같은 규칙입니다.
    assert.equal(
      classifyMobileApkChanges([
        change("apps/mobile/package.json", manifest("1.2.3"), manifest("1.3.0")),
      ]).apk,
      false,
    );
  });

  for (const [reason, mutate] of [
    ["빈 변경 목록", () => []],
    ["배열이 아닌 입력", () => null],
    ["모바일 소스 추가 변경", (c) => [...c, change("apps/mobile/src/app.tsx", null, null)]],
    ["OpenAPI 계약 변경", (c) => [...c, change("packages/contracts/openapi.json", null, null)]],
    ["workflow 변경", (c) => [...c, change(".github/workflows/mobile.yml", null, null)]],
    ["Node 버전 파일 변경", (c) => [...c, change(".nvmrc", null, null)]],
    ["루트 릴리스 파일만 변경", (c) => c.slice(0, 4)],
    [
      "manifest의 다른 byte 변경",
      () => [
        change(
          "apps/mobile/package.json",
          manifest("0.2.2"),
          manifest("0.2.3", ',\n  "main": "x"'),
        ),
      ],
    ],
    [
      "lock의 의존성 버전 변경",
      () => [
        change("apps/mobile/package-lock.json", lock("0.2.2"), lock("0.2.3", "0.2.3", "1.0.1")),
      ],
    ],
    [
      "lock 공백 변경",
      () => [change("apps/mobile/package-lock.json", lock("0.2.2"), lock("0.2.3") + "\n")],
    ],
    [
      "lock 루트 패키지 버전만 누락",
      () => [
        change(
          "apps/mobile/package-lock.json",
          lock("0.2.2"),
          lock("0.2.3").replace(
            /("": \{\n\s+"name": "hra-mobile"),\n\s+"version": "0\.2\.3"/,
            "$1",
          ),
        ),
      ],
    ],
    [
      "prerelease 버전",
      () => [change("apps/mobile/package.json", manifest("0.2.2"), manifest("0.3.0-rc.1"))],
    ],
    [
      "비정상 JSON",
      () => [change("apps/mobile/package.json", manifest("0.2.2"), manifest("0.2.3") + "}")],
    ],
    ["base 없음(파일 추가)", () => [change("apps/mobile/package.json", null, manifest("0.2.3"))]],
    ["head 없음(파일 삭제)", () => [change("apps/mobile/package.json", manifest("0.2.2"), null)]],
    [
      "내용이 같은 변경(mode 변경 등)",
      () => [change("apps/mobile/package.json", manifest("0.2.2"), manifest("0.2.2"))],
    ],
  ])
    test(`${reason}은 컴파일을 실행한다`, () => {
      assert.equal(classifyMobileApkChanges(mutate(releaseChanges())).apk, true);
    });
});

/** 실제 CLI를 임시 저장소에서 실행해 출력 파일과 표준 출력을 돌려줍니다. */
function runCli(directory, args) {
  const output = join(directory, "output.txt");
  writeFileSync(output, "");
  const result = spawnSync(
    process.execPath,
    [join(directory, "scripts/detect-mobile-apk-scope.mjs"), ...args, output],
    { cwd: directory, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  return { output: readFileSync(output, "utf8"), stdout: result.stdout };
}

describe("실제 Git 범위 판정 CLI", () => {
  const directory = mkdtempSync(join(tmpdir(), "hra-mobile-apk-scope-"));
  after(() => rmSync(directory, { recursive: true, force: true }));
  const git = (...args) => {
    const result = spawnSync("git", args, {
      cwd: directory,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        GIT_CONFIG_NOSYSTEM: "1",
        HOME: directory,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@example.invalid",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@example.invalid",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  const commit = (files) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(dirname(join(directory, path)), { recursive: true });
      writeFileSync(join(directory, path), text);
    }
    git("add", "-A");
    git("commit", "-q", "-m", "c");
    return git("rev-parse", "HEAD");
  };

  // 판정 스크립트와 재사용하는 마스킹 모듈만 복사합니다.
  mkdirSync(join(directory, "scripts/_lib"), { recursive: true });
  for (const file of ["detect-mobile-apk-scope.mjs", "_lib/dependency-policy.mjs"])
    copyFileSync(
      fileURLToPath(new URL("../" + file, import.meta.url)),
      join(directory, "scripts", file),
    );
  git("init", "-q", "-b", "main");
  const base = commit({
    "apps/mobile/package.json": manifest("0.2.2"),
    "apps/mobile/package-lock.json": lock("0.2.2"),
    "apps/mobile/src/app.tsx": "export {};\n",
    "CHANGELOG.md": "# 0.2.2\n",
  });
  const release = commit({
    "apps/mobile/package.json": manifest("0.2.3"),
    "apps/mobile/package-lock.json": lock("0.2.3"),
    "CHANGELOG.md": "# 0.2.3\n",
  });
  const source = commit({ "apps/mobile/src/app.tsx": "export const a = 1;\n" });
  git("checkout", "-q", "-b", "side", base);
  const sideRelease = commit({ "apps/mobile/package.json": manifest("0.2.3") });
  git("checkout", "-q", "main");

  test("push before..after가 버전 전용이면 apk=false를 기록한다", () => {
    const { output, stdout } = runCli(directory, ["push", base, release]);
    assert.equal(output, "apk=false\n");
    assert.match(stdout, /MOBILE_APK=skip REASON=release-version-only/);
  });

  test("PR은 base와 head의 merge-base부터 비교한다", () => {
    // main이 소스 변경으로 앞서 있어도 PR 자체 변경(버전)만 판정합니다.
    assert.equal(runCli(directory, ["pull_request", source, sideRelease]).output, "apk=false\n");
  });

  for (const [reason, args] of [
    ["소스 변경이 섞인 push", () => ["push", base, source]],
    ["새 branch push(before 0)", () => ["push", "0".repeat(40), release]],
    ["도달할 수 없는 before", () => ["push", "1".repeat(40), release]],
    ["before 누락", () => ["push", "", release]],
    ["SHA 형식 아님", () => ["push", "main", release]],
    ["수동 실행", () => ["workflow_dispatch", base, release]],
    ["알 수 없는 이벤트", () => ["schedule", base, release]],
  ])
    test(`${reason}은 apk=true를 기록한다`, () => {
      assert.equal(runCli(directory, args()).output, "apk=true\n");
    });

  test("실행 권한만 바뀐 버전 파일은 컴파일한다", () => {
    git("checkout", "-q", "-b", "mode", release);
    chmodSync(join(directory, "apps/mobile/package.json"), 0o755);
    git("add", "-A");
    git("commit", "-q", "-m", "mode");
    const mode = git("rev-parse", "HEAD");
    git("checkout", "-q", "main");
    assert.equal(runCli(directory, ["push", release, mode]).output, "apk=true\n");
  });
});
