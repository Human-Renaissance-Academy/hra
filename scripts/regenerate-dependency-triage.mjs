#!/usr/bin/env node
/**
 * 의존성 검토 원장 재생성 도구(#368) — 유지보수자 전용 명령입니다.
 *
 * 사용: npm run deps:triage:regenerate -- --target root|mobile [--write]
 *
 * 상위 권고 철회·정정으로 `verify:dependencies`가 DEPENDENCY_TRIAGE_CHANGED(removal-only/metadata-only)로
 * 실패할 때 #540·#545의 수동 재생성 절차를 그대로 재현합니다.
 * - verify-dependencies.mjs와 같은 격리 방식(소유 임시 디렉터리, 빈 npm 설정, 공식 registry 고정)으로 fresh audit를 실행합니다.
 * - 기본은 dry-run이며 원장을 쓰지 않습니다. `--write`일 때만 대상 원장 JSON을 덮어씁니다.
 * - 새 권고·경로·링크·등급 상승, binding 불일치, 만료는 거부(exit 1)하고 원장을 바꾸지 않습니다.
 * - 이 명령은 게이트를 통과시키는 권한이 아닙니다. 결과 PR은 보안 게이트 변경으로 독립 리뷰를 받습니다.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { regenerateDependencyPolicy } from "./_lib/dependency-policy.mjs";

// 대상 정의는 verify-dependencies.mjs와 같습니다.
const targets = {
  root: { directory: "../", policy: "../security/dependency-triage.json" },
  mobile: { directory: "../apps/mobile/", policy: "../security/mobile-dependency-triage.json" },
};

/** 인자는 `--target <root|mobile>`과 선택 `--write`만 허용합니다. */
function parseArguments(argv) {
  let target;
  let write = false;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--write" && !write) write = true;
    else if (argv[index] === "--target" && !target && Object.hasOwn(targets, argv[index + 1]))
      target = argv[++index];
    else return null;
  }
  return target ? { target, write } : null;
}

/** verify-dependencies.mjs와 같은 명령·환경·한도로 감사만 실행하고 원문 오류는 출력하지 않습니다. */
function freshAudit(manifestBytes, lockBytes) {
  const temporary = mkdtempSync(join(tmpdir(), "hra-dependency-regenerate-"));
  try {
    writeFileSync(join(temporary, "package.json"), manifestBytes, { mode: 0o600 });
    writeFileSync(join(temporary, "package-lock.json"), lockBytes, { mode: 0o600 });
    writeFileSync(join(temporary, "user.npmrc"), "");
    writeFileSync(join(temporary, "global.npmrc"), "");
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
        env: {
          PATH: process.env.PATH,
          HOME: process.env.HOME,
          TMPDIR: process.env.TMPDIR,
          SystemRoot: process.env.SYSTEMROOT,
          LANG: "C",
          npm_config_userconfig: join(temporary, "user.npmrc"),
          npm_config_globalconfig: join(temporary, "global.npmrc"),
          npm_config_cache: join(temporary, "cache"),
        },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    if (run.error || ![0, 1].includes(run.status)) throw new Error("DEPENDENCY_AUDIT_FAILED");
    let audit;
    try {
      audit = JSON.parse(run.stdout.toString("utf8"));
    } catch {
      throw new Error("DEPENDENCY_AUDIT_FAILED");
    }
    if (audit.error) throw new Error("DEPENDENCY_AUDIT_FAILED");
    return audit;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

/** PR 본문에 붙일 수 있는 정제된 요약입니다. 감사 원문·range·title·version은 넣지 않습니다. */
function summaryLines(target, write, outcome) {
  const { summary } = outcome;
  const list = (items) => (items.length ? items.join(", ") : "없음");
  return [
    `### 의존성 검토 원장 재생성 요약 (${target})`,
    "",
    `- 모드: ${write ? "write" : "dry-run"} / 원장 변경: ${outcome.changed ? "있음" : "없음"}`,
    `- 변화 유형: ${summary.driftKind}`,
    `- 패키지: ${summary.packages[0]} → ${summary.packages[1]} / 평가: ${summary.assessments[0]} → ${summary.assessments[1]} / 맥락: ${summary.contexts[0]} → ${summary.contexts[1]}`,
    `- audit 대조: affected package ${summary.affectedPackages}, object-advisory ${summary.advisoryEntries}, P1 0`,
    `- 원장에서 사라진 권고(철회·정정 후보, 공식 권고에서 확인 필요): ${list(summary.removedAdvisories)}`,
    `- 제거한 평가 key: ${list(summary.removedAssessments)}`,
    `- 제거한 맥락: ${list(summary.removedContexts)}`,
    ...summary.changes.map((change) => `- 변화: ${JSON.stringify(change)}`),
    "- 유지한 평가의 reviewedOn/reviewBy/attackCondition/owner/priority/contextId와 맥락 문구, binding: 변경 없음",
    "- 새 평가 생성·기한 연장 없음. 보안 게이트 변경으로 독립 리뷰가 필요합니다.",
  ];
}

const options = parseArguments(process.argv.slice(2));
if (!options) {
  console.error("DEPENDENCY_ARGUMENTS_INVALID");
  console.error("사용: npm run deps:triage:regenerate -- --target root|mobile [--write]");
  process.exitCode = 1;
} else {
  const target = targets[options.target];
  const paths = {
    manifest: new URL(target.directory + "package.json", import.meta.url),
    lock: new URL(target.directory + "package-lock.json", import.meta.url),
    policy: new URL(target.policy, import.meta.url),
  };
  try {
    // 감사 전에 세 입력을 capture하고, 쓰기 직전 같은 bytes인지 다시 확인합니다.
    const bytes = Object.fromEntries(
      Object.entries(paths).map(([key, path]) => [key, readFileSync(path)]),
    );
    const policy = JSON.parse(bytes.policy.toString("utf8"));
    const audit = freshAudit(bytes.manifest, bytes.lock);
    const outcome = regenerateDependencyPolicy(
      audit,
      { manifestBytes: bytes.manifest, lockBytes: bytes.lock },
      policy,
    );
    if (options.write && outcome.changed) {
      for (const [key, path] of Object.entries(paths))
        if (!readFileSync(path).equals(bytes[key])) throw new Error("DEPENDENCY_INPUT_CHANGED");
      writeFileSync(paths.policy, JSON.stringify(outcome.policy, null, 2) + "\n");
    }
    for (const line of summaryLines(options.target, options.write, outcome)) console.log(line);
  } catch (error) {
    // 정의된 코드와 정제된 항목만 출력하고 그 밖의 오류 원문은 숨깁니다.
    const code =
      error instanceof Error && /^DEPENDENCY_[A-Z_]+$/.test(error.message)
        ? error.message
        : "DEPENDENCY_CHECK_FAILED";
    console.error(`DEPENDENCY_TARGET ${options.target}`);
    console.error(code);
    if (Array.isArray(error?.items))
      for (const item of error.items)
        console.error(`DEPENDENCY_REGENERATE_ITEM ${JSON.stringify(item)}`);
    process.exitCode = 1;
  }
}
