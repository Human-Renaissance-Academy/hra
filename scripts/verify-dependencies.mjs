#!/usr/bin/env node
/** 검토된 입력 bytes로 fresh audit를 실행하고 전체 target equality 뒤에만 결과를 확정합니다. */
import { spawnSync } from "node:child_process";
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dependencyDiagnosticLines, verifyDependencyPolicy } from "./_lib/dependency-policy.mjs";
// 대상·명령·환경·한도는 유지하며 한 target 실패가 다른 target 검사를 생략하지 않습니다.
const targets = [
  { name: "root", directory: "../", policy: "../security/dependency-triage.json" },
  {
    name: "mobile",
    directory: "../apps/mobile/",
    policy: "../security/mobile-dependency-triage.json",
  },
];
const temporaries = new Set();
for (const signal of ["SIGINT", "SIGTERM"])
  process.once(signal, () => {
    for (const path of temporaries) rmSync(path, { recursive: true, force: true });
    process.exit(1);
  });
/** 모든 source를 첫 audit 전에 capture하고 이후 읽기는 equality에만 사용합니다. */
function captureTarget(target) {
  const paths = {
    manifest: new URL(target.directory + "package.json", import.meta.url),
    lock: new URL(target.directory + "package-lock.json", import.meta.url),
    policy: new URL(target.policy, import.meta.url),
  };
  const bytes = {
    manifest: readFileSync(paths.manifest),
    lock: readFileSync(paths.lock),
    policy: readFileSync(paths.policy),
  };
  return { paths, bytes, policy: JSON.parse(bytes.policy.toString("utf8")) };
}
/** 어느 한 파일의 변경/재읽기 실패도 false이며 다른 파일 확인을 생략하지 않습니다. */
function inputsUnchanged(paths, bytes) {
  return Object.keys(paths)
    .map((key) => {
      try {
        return readFileSync(paths[key]).equals(bytes[key]);
      } catch {
        return false;
      }
    })
    .every(Boolean);
}
/** captured pair만 복사하고 성공/실패 모두 post equality 후 소유 temp를 정리합니다. */
function verifyTarget(captured) {
  const temporary = mkdtempSync(join(tmpdir(), "hra-dependency-audit-"));
  temporaries.add(temporary);
  const paths = {
    manifest: join(temporary, "package.json"),
    lock: join(temporary, "package-lock.json"),
  };
  const bytes = { manifest: captured.bytes.manifest, lock: captured.bytes.lock };
  try {
    let audit;
    let failure;
    try {
      for (const key of Object.keys(paths)) writeFileSync(paths[key], bytes[key], { mode: 0o600 });
      writeFileSync(join(temporary, "user.npmrc"), "");
      writeFileSync(join(temporary, "global.npmrc"), "");
      const environment = {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: process.env.TMPDIR,
        SystemRoot: process.env.SYSTEMROOT,
        LANG: "C",
        npm_config_userconfig: join(temporary, "user.npmrc"),
        npm_config_globalconfig: join(temporary, "global.npmrc"),
        npm_config_cache: join(temporary, "cache"),
      };
      const run = spawnSync(
        "npm",
        [
          "audit",
          "--json",
          "--package-lock-only",
          "--ignore-scripts",
          "--registry=https://registry.npmjs.org",
          "--fetch-retries=0",
          "--fetch-timeout=30000",
        ],
        {
          cwd: temporary,
          env: environment,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 60000,
          maxBuffer: 16 * 1024 * 1024,
        },
      );
      if (run.error || ![0, 1].includes(run.status)) throw new Error("DEPENDENCY_AUDIT_FAILED");
      audit = JSON.parse(run.stdout.toString("utf8"));
      if (audit.error) throw new Error("DEPENDENCY_AUDIT_FAILED");
    } catch (error) {
      failure = error;
    }
    const sourceSame = inputsUnchanged(captured.paths, captured.bytes);
    const copySame = inputsUnchanged(paths, bytes);
    if (!sourceSame || !copySame) throw new Error("DEPENDENCY_INPUT_CHANGED");
    if (failure) throw failure;
    return verifyDependencyPolicy(
      audit,
      { manifestBytes: bytes.manifest, lockBytes: bytes.lock },
      captured.policy,
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
    temporaries.delete(temporary);
  }
}
if (process.argv.length !== 2) {
  for (const line of dependencyDiagnosticLines(new Error("DEPENDENCY_ARGUMENTS_INVALID")))
    console.error(line);
  process.exitCode = 1;
} else {
  // capture 실패는 sticky failure이며 다른 target capture/audit는 계속합니다.
  const results = targets.map((target) => {
    try {
      return { target, captured: captureTarget(target) };
    } catch {
      return { target, error: new Error("DEPENDENCY_INPUT_CAPTURE_FAILED") };
    }
  });
  for (const entry of results) {
    if (entry.error) continue;
    try {
      entry.result = verifyTarget(entry.captured);
    } catch (error) {
      entry.error = error;
    }
    // 동기 child 실행 중 도착한 취소 신호를 다음 검사/PASS보다 먼저 처리합니다.
    await new Promise((resolve) => setImmediate(resolve));
  }
  // mobile 검사 중 이미 검사한 root가 바뀌어도 provisional PASS를 출력하지 않습니다.
  for (const entry of results) {
    if (entry.captured && !inputsUnchanged(entry.captured.paths, entry.captured.bytes))
      entry.error = new Error("DEPENDENCY_INPUT_CHANGED");
  }
  for (const entry of results) {
    if (entry.error) {
      console.error(`DEPENDENCY_TARGET ${entry.target.name}`);
      for (const line of dependencyDiagnosticLines(entry.error)) console.error(line);
      process.exitCode = 1;
    } else console.log(JSON.stringify({ target: entry.target.name, ...entry.result }));
  }
}
