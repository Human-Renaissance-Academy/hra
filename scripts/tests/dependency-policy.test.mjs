/** audit 네트워크/형식 실패와 새 advisory·설치 경로·만료·P1의 차단을 검증한다. */
import { test } from "node:test";
import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import {
  readFileSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  readdirSync,
  existsSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dependencyDiagnosticLines,
  dependencySnapshot,
  lockRegistryViolations,
  verifyDependencyPolicy as verifyV3DependencyPolicy,
} from "../_lib/dependency-policy.mjs";
const policy = JSON.parse(
  readFileSync(new URL("../../security/dependency-triage.json", import.meta.url)),
);
const lock = JSON.parse(readFileSync(new URL("../../package-lock.json", import.meta.url)));

// 기존 변이 matrix는 synthetic 입력을 명시 재승인해 binding 뒤의 gate를 검사합니다.
// binding 자체의 실패는 아래 v3 direct-API case가 재승인 없이 따로 검사합니다.
function verifyReviewedFixture(report, fixtureLock, fixturePolicy, today) {
  const mobileManifest = readFileSync(new URL("../../apps/mobile/package.json", import.meta.url));
  const isMobile =
    (fixtureLock.packages[""]?.name ?? fixtureLock.name) === JSON.parse(mobileManifest).name;
  const manifestBytes = isMobile
    ? mobileManifest
    : readFileSync(new URL("../../package.json", import.meta.url));
  const lockBytes = Buffer.from(JSON.stringify(fixtureLock));
  const reviewed = structuredClone(fixturePolicy);
  if (reviewed && typeof reviewed === "object") {
    const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
    reviewed.manifestBinding = {
      algorithm: "sha256",
      input: "package-json.raw-bytes-v1",
      digest: digest(manifestBytes),
    };
    reviewed.lockBinding = {
      algorithm: "sha256",
      input: "package-lock.raw-bytes-v1",
      digest: digest(lockBytes),
    };
  }
  return verifyV3DependencyPolicy(report, { manifestBytes, lockBytes }, reviewed, today);
}

// 실제 원장의 독립 nodes/via 집합으로 npm 응답을 복원한다. 공격 조건 설명은 응답 metadata와 분리한다.
const audit = {
  auditReportVersion: 2,
  vulnerabilities: Object.fromEntries(
    policy.packages.map((pkg) => [
      pkg.name,
      {
        name: pkg.name,
        severity: pkg.severity,
        range: pkg.range,
        nodes: pkg.nodes.map((node) => node.path),
        via: pkg.via.map((v) =>
          v.source ? { ...v, url: "https://github.com/advisories/" + v.id } : v.dependency,
        ),
      },
    ]),
  ),
};
test("현재 정확한 집합은 package 수와 advisory 수를 구분한다", () => {
  assert.deepEqual(verifyReviewedFixture(audit, lock, policy, "2026-11-19"), {
    affectedPackages: 15,
    advisoryEntries: 2,
    p1: 0,
  });
});
for (const [name, change] of [
  ["새 advisory", (a) => a.vulnerabilities.esbuild.via[0].source++],
  ["영향 범위 변경", (a) => (a.vulnerabilities.esbuild.via[0].range += " || 99.0.0")],
  ["심각도 변경", (a) => (a.vulnerabilities.esbuild.severity = "critical")],
  ["설치 경로 누락", (a) => a.vulnerabilities.esbuild.nodes.pop()],
  ["패키지 누락", (a) => delete a.vulnerabilities.esbuild],
  ["통신 오류 응답", (a) => (a.error = { code: "ENETWORK", summary: "sensitive sentinel" })],
  ["잘못된 via", (a) => (a.vulnerabilities.esbuild.via = [null])],
])
  test(name + " 차단", () => {
    const input = structuredClone(audit);
    change(input);
    assert.throws(() => verifyReviewedFixture(input, lock, policy, "2026-11-19"), /DEPENDENCY_/);
  });
for (const [name, change] of [
  ["미분류", (p) => p.assessments.pop()],
  ["P1", (p) => (p.assessments[0].priority = "P1")],
  ["owner 누락", (p) => (p.assessments[0].owner = "")],
  ["설명 누락", (p) => (p.assessments[0].assessment = "")],
  ["중복 검토", (p) => (p.assessments[0] = p.assessments[1])],
])
  test(name + " 원장 차단", () => {
    const input = structuredClone(policy);
    change(input);
    assert.throws(() => verifyReviewedFixture(audit, lock, input, "2026-11-19"), /DEPENDENCY_/);
  });
// 가장 이른 재검토 기한(2026-12-03) 다음 날부터는 실제 원장 전체가 만료로 차단된다.
test("검토 기한 만료 차단", () =>
  assert.throws(
    () => verifyReviewedFixture(audit, lock, policy, "2026-12-04"),
    /DEPENDENCY_TRIAGE_INVALID/,
  ));
test("lock 설치 버전 변경 차단", () => {
  const input = structuredClone(lock);
  input.packages["node_modules/@esbuild-kit/core-utils/node_modules/esbuild"].version = "99.0.0";
  assert.throws(
    () => verifyReviewedFixture(audit, input, policy, "2026-11-19"),
    /DEPENDENCY_TRIAGE_CHANGED/,
  );
});
test("깨진 audit는 정상 0건이 아니다", () => {
  for (const input of [null, {}, { auditReportVersion: 2, vulnerabilities: [] }])
    assert.throws(() => dependencySnapshot(input, lock), /DEPENDENCY_REPORT_INVALID/);
});

// 감사 응답의 제목·영향 범위는 원문에 민감한 문자열이 섞일 수 있으므로 진단에는 식별자만 남긴다.
function capturePolicyError(inputAudit, inputLock = lock) {
  try {
    verifyReviewedFixture(inputAudit, inputLock, policy, "2026-11-19");
  } catch (error) {
    return error;
  }
  assert.fail("변경된 감사 결과가 차단되지 않았다");
}

test("신규 권고는 패키지·권고 ID·source로만 진단하며 차단한다", () => {
  const input = structuredClone(audit);
  input.vulnerabilities.esbuild.via.push({
    source: 999999,
    url: "https://github.com/advisories/GHSA-test-1234",
    severity: "high",
    range: "<99",
    title: "SENSITIVE_SENTINEL",
  });
  const error = capturePolicyError(input);
  assert.equal(error.message, "DEPENDENCY_TRIAGE_CHANGED");
  assert.deepEqual(error.diagnostics, [
    { kind: "ADVISORY_ONLY_IN_AUDIT", package: "esbuild", id: "GHSA-test-1234", source: 999999 },
  ]);
  assert.doesNotMatch(JSON.stringify(error.diagnostics), /SENSITIVE_SENTINEL|<99/);
  const lines = dependencyDiagnosticLines(error);
  assert.equal(lines[0], "DEPENDENCY_TRIAGE_CHANGED");
  const { literalDiff, ...identifier } = JSON.parse(lines[1].slice("DEPENDENCY_CHANGE ".length));
  assert.deepEqual(identifier, error.diagnostics[0]);
  assert.equal(literalDiff.category, "ARRAY_COUNT");
  assert.match(literalDiff.fieldPath, /^\$\[\d+\]\.via$/);
  assert.equal(literalDiff.actualCount, literalDiff.expectedCount + 1);
});

// 현재 원장의 패키지는 권고가 하나뿐이므로, 원장에만 권고를 하나 더 둬 audit에서 사라진 권고를 재현한다.
test("권고 제거는 철회로 단정하지 않고 원장에만 남은 ID를 진단한다", () => {
  const input = structuredClone(policy);
  const removed = {
    source: 999997,
    id: "GHSA-test-5678",
    severity: "moderate",
    range: "<99",
    title: "SENSITIVE_SENTINEL",
  };
  input.packages.find((item) => item.name === "esbuild").via.push(removed);
  let error;
  try {
    verifyReviewedFixture(audit, lock, input, "2026-11-19");
  } catch (caught) {
    error = caught;
  }
  assert.equal(error?.message, "DEPENDENCY_TRIAGE_CHANGED");
  assert.deepEqual(error.diagnostics, [
    { kind: "ADVISORY_ONLY_IN_POLICY", package: "esbuild", id: removed.id, source: removed.source },
  ]);
});

test("권고 메타데이터와 설치 버전 변경은 원문 없이 위치만 진단한다", () => {
  const input = structuredClone(audit);
  input.vulnerabilities.esbuild.via[0].title = "SENSITIVE_SENTINEL";
  const changedAdvisory = capturePolicyError(input);
  assert.deepEqual(changedAdvisory.diagnostics, [
    {
      kind: "ADVISORY_METADATA_CHANGED",
      package: "esbuild",
      id: input.vulnerabilities.esbuild.via[0].id,
      source: input.vulnerabilities.esbuild.via[0].source,
    },
  ]);
  assert.doesNotMatch(JSON.stringify(changedAdvisory.diagnostics), /SENSITIVE_SENTINEL/);
  const changedLock = structuredClone(lock);
  changedLock.packages["node_modules/@esbuild-kit/core-utils/node_modules/esbuild"].version =
    "99.0.0";
  const changedNode = capturePolicyError(audit, changedLock);
  assert.deepEqual(changedNode.diagnostics, [
    {
      kind: "NODE_METADATA_CHANGED",
      package: "esbuild",
      path: "node_modules/@esbuild-kit/core-utils/node_modules/esbuild",
    },
  ]);
  assert.doesNotMatch(JSON.stringify(changedNode.diagnostics), /99\.0\.0/);
});

test("새 설치 경로는 경로만 진단하고 실제 lock 일치 검사를 유지한다", () => {
  const input = structuredClone(audit);
  const inputLock = structuredClone(lock);
  input.vulnerabilities.esbuild.nodes.push("node_modules/fixture-esbuild");
  inputLock.packages["node_modules/fixture-esbuild"] = { version: "99.0.0", dev: true };
  const error = capturePolicyError(input, inputLock);
  assert.deepEqual(error.diagnostics, [
    { kind: "NODE_ONLY_IN_AUDIT", package: "esbuild", path: "node_modules/fixture-esbuild" },
  ]);
  assert.doesNotMatch(JSON.stringify(error.diagnostics), /99\.0\.0/);
  assert.throws(
    () => verifyReviewedFixture(input, lock, policy, "2026-11-19"),
    /DEPENDENCY_LOCK_MISMATCH/,
  );
});

test("변경이 20건을 넘으면 생략 건수를 남기면서 차단한다", () => {
  const input = structuredClone(audit);
  for (let index = 0; index < 21; index++)
    input.vulnerabilities.esbuild.via.push({
      source: 900000 + index,
      url: `https://github.com/advisories/GHSA-extra-${index}`,
      severity: "high",
      range: "<99",
      title: "SENSITIVE_SENTINEL",
    });
  const error = capturePolicyError(input);
  assert.equal(error.diagnostics.length, 21);
  assert.deepEqual(error.diagnostics.at(-1), { kind: "MORE_CHANGES", count: 1 });
  assert.doesNotMatch(dependencyDiagnosticLines(error).join("\n"), /SENSITIVE_SENTINEL|<99/);
});

test("오류 감사 보고서는 원문이나 진단을 내보내지 않고 차단한다", () => {
  const input = structuredClone(audit);
  input.error = { summary: "SENSITIVE_SENTINEL" };
  const error = capturePolicyError(input);
  assert.equal(error.message, "DEPENDENCY_REPORT_INVALID");
  assert.equal(error.diagnostics, undefined);
  assert.doesNotMatch(String(error), /SENSITIVE_SENTINEL/);
  assert.deepEqual(dependencyDiagnosticLines(error), ["DEPENDENCY_REPORT_INVALID"]);
  assert.deepEqual(dependencyDiagnosticLines(new Error("SENSITIVE_SENTINEL")), [
    "DEPENDENCY_CHECK_FAILED",
  ]);
});

test("손상된 원장은 원문 없이 실패 차단한다", () => {
  const input = structuredClone(policy);
  input.packages[0].via = [null];
  let error;
  try {
    verifyReviewedFixture(audit, lock, input, "2026-11-19");
  } catch (caught) {
    error = caught;
  }
  assert.equal(error?.message, "DEPENDENCY_TRIAGE_CHANGED");
  assert.deepEqual(dependencyDiagnosticLines(error), ["DEPENDENCY_TRIAGE_CHANGED"]);
});

test("v3 검토 정본은 20개 명시 판단과 3개 공유 사용 맥락을 유지한다", () => {
  assert.equal(policy.schemaVersion, 3);
  assert.equal(policy.assessments.length, 20);
  assert.equal(policy.contexts.length, 3);
  assert.equal(new Set(policy.assessments.map((item) => item.contextId)).size, 3);
  assert.deepEqual(
    policy.contexts
      .map((context) => policy.assessments.filter((item) => item.contextId === context.id).length)
      .sort((a, b) => a - b),
    [3, 4, 13],
  );
  assert.deepEqual(verifyReviewedFixture(audit, lock, policy, "2026-11-19"), {
    affectedPackages: 15,
    advisoryEntries: 2,
    p1: 0,
  });
});

for (const [name, change] of [
  ["공유 맥락 누락", (p) => p.contexts.pop()],
  ["공유 맥락 ID 중복", (p) => (p.contexts[1].id = p.contexts[0].id)],
  [
    "공유 판단문 중복",
    (p) => {
      for (const field of ["usedApi", "callLocations", "assessment", "residualAssumptions"])
        p.contexts[1][field] = p.contexts[0][field];
    },
  ],
  ["미사용 공유 맥락", (p) => p.contexts.push({ ...p.contexts[0], id: "unused-context" })],
  ["잘못된 공유 맥락 ID", (p) => (p.contexts[0].id = "private@example.invalid")],
  ["공유 판단문 누락", (p) => (p.contexts[0].assessment = "")],
  ["없는 공유 맥락 참조", (p) => (p.assessments[0].contextId = "missing-context")],
  ["권고별 항목 손상", (p) => (p.assessments[0] = null)],
  ["권고별 공격 조건 누락", (p) => (p.assessments[0].attackCondition = "")],
  ["예전 중복 필드 재도입", (p) => (p.assessments[0].usedApi = "SENSITIVE_SENTINEL")],
])
  test(name + " 차단", () => {
    const input = structuredClone(policy);
    change(input);
    assert.throws(() => verifyReviewedFixture(audit, lock, input, "2026-11-19"), /DEPENDENCY_/);
  });

test("구 schema v1은 새 검토 원장으로 자동 승인하지 않는다", () => {
  const input = structuredClone(policy);
  input.schemaVersion = 1;
  assert.throws(
    () => verifyReviewedFixture(audit, lock, input, "2026-11-19"),
    /DEPENDENCY_TRIAGE_CHANGED/,
  );
});

test("동일 GHSA의 다른 source ID는 각각 진단하고 차단한다", () => {
  const input = structuredClone(audit);
  const duplicate = { ...input.vulnerabilities.esbuild.via[0], source: 999998 };
  input.vulnerabilities.esbuild.via.push(duplicate);
  const error = capturePolicyError(input);
  assert.equal(error.message, "DEPENDENCY_TRIAGE_CHANGED");
  assert.deepEqual(error.diagnostics, [
    {
      kind: "ADVISORY_ONLY_IN_AUDIT",
      package: "esbuild",
      id: duplicate.id,
      source: 999998,
    },
  ]);
  assert.doesNotMatch(dependencyDiagnosticLines(error).join("\n"), /title|range|version/);
});

// 수정 버전으로 대체한 YAML의 임시 예외는 다시 나타나지 않습니다.
// 철회된 deepmerge 권고의 CLI 평가·전용 맥락도 남기지 않으며 설치 의존성은 그대로 둡니다.
test("패치된 YAML 설치본은 임시 평가·공유 맥락 없이 확인한다", () => {
  assert.equal(
    policy.packages.some((item) => item.name === "js-yaml"),
    false,
  );
  assert.deepEqual(
    policy.assessments.filter((item) => item.key.startsWith("js-yaml:")),
    [],
  );
  assert.deepEqual(
    policy.contexts.filter((item) => ["yaml-parser-cli", "yaml-omap"].includes(item.id)),
    [],
  );
  const cliAssessments = policy.assessments.filter(
    (item) => item.contextId === "shadcn-registry-cli",
  );
  assert.deepEqual(cliAssessments, []);
  assert.deepEqual(
    policy.contexts.filter((item) => item.id === "shadcn-registry-cli"),
    [],
  );
  assert.deepEqual(verifyReviewedFixture(audit, lock, policy, "2026-11-19"), {
    affectedPackages: 15,
    advisoryEntries: 2,
    p1: 0,
  });
});

// 2026-11-04(KST) 재검토: lock 범위 안 수정본으로 해소한 권고는 원장에서 제거하고, 남은 평가는 일괄 연장 없이
// 사용면 위험에 따라 기한을 다르게 둡니다. reviewedOn은 게이트 기준 시계인 UTC 날짜(2026-11-03)입니다.
test("수정본으로 해소한 권고는 제거하고 남은 평가는 위험별 기한을 둔다", () => {
  for (const name of ["brace-expansion", "source-map-js"])
    assert.equal(
      policy.packages.some((item) => item.name === name),
      false,
    );
  assert.deepEqual(
    policy.assessments.filter(
      (item) =>
        /^(brace-expansion|source-map-js):/.test(item.key) || item.key === "esbuild:1120680",
    ),
    [],
  );
  assert.deepEqual(
    policy.contexts.filter((item) => ["tooling-brace-expansion", "vitest-vite"].includes(item.id)),
    [],
  );
  // 철회된 deepmerge 평가는 제외하고, 2026-11-05(UTC) 권고 범위 정정 후 다시 검토한
  // tooling-minimatch-glob 평가와 2026-11-19(UTC) 기한 전 registry로 재확인한 shadcn-ts-morph-glob 평가만
  // 검토일이 바뀌며 나머지는 2026-11-03 검토일을 유지한다.
  const reviewedOn = {
    "tooling-minimatch-glob": "2026-11-05",
    "shadcn-ts-morph-glob": "2026-11-19",
  };
  // drizzle-kit 설치 노드만 추가 재검토했으며 제거된 eslint-config-next 항목은 복원하지 않는다.
  // 2026-11-18 철회된 picomatch 권고(GHSA-fc5q-39xc-vjpf)의 평가·맥락은 남기지 않는다.
  assert.ok(
    policy.assessments.every(
      (item) =>
        item.reviewedOn ===
        (item.key === "drizzle-kit:@esbuild-kit/esm-loader"
          ? "2026-11-06"
          : (reviewedOn[item.contextId] ?? "2026-11-03")),
    ),
  );
  // dev=false이거나 수정본이 있는데 적용되지 못한 사용면은 2주, dev=false CLI DoS는 3주, 개발 도구 전용은 4주다.
  // shadcn-ts-morph-glob은 2026-11-19 재검토일부터 dev=true 개발 도구 전용 4주(2026-12-17)다.
  const deadlines = {
    "shadcn-ts-morph-glob": "2026-12-17",
    "build-esbuild": "2026-12-03",
    "tooling-minimatch-glob": "2026-12-03",
  };
  assert.deepEqual(Object.keys(deadlines).sort(), policy.contexts.map((item) => item.id).sort());
  assert.ok(policy.assessments.every((item) => item.reviewBy === deadlines[item.contextId]));
  // 최단 기한(2026-12-03) 당일까지 통과하고, 그 다음 날부터는 다시 차단한다.
  assert.deepEqual(verifyReviewedFixture(audit, lock, policy, "2026-11-19"), {
    affectedPackages: 15,
    advisoryEntries: 2,
    p1: 0,
  });
  assert.deepEqual(verifyReviewedFixture(audit, lock, policy, "2026-12-03"), {
    affectedPackages: 15,
    advisoryEntries: 2,
    p1: 0,
  });
  assert.throws(
    () => verifyReviewedFixture(audit, lock, policy, "2026-12-04"),
    /DEPENDENCY_TRIAGE_INVALID/,
  );
});

// 2026-11-04(UTC) 재검토: @tailwindcss/typography 0.5.20이 6.0.10으로 정확히 고정한 postcss-selector-parser를
// 범위 지정 overrides로 수정본 6.1.5에 올려 GHSA-rj75-hqrm-r3gf 평가 2건과 build-css-source-map 맥락을 제거한다.
test("typography의 postcss-selector-parser는 수정본으로 고정하고 해소된 평가를 남기지 않는다", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url)));
  assert.deepEqual(manifest.overrides, {
    "@tailwindcss/typography": { "postcss-selector-parser": "^6.1.5" },
    "@vercel/cli-config": { zod: "^4.6.6" },
  });
  assert.equal(
    lock.packages["node_modules/@tailwindcss/typography"].dependencies["postcss-selector-parser"],
    "6.0.10",
  );
  assert.equal(lock.packages["node_modules/postcss-selector-parser"].version, "6.1.5");
  for (const name of ["postcss-selector-parser", "@tailwindcss/typography"])
    assert.equal(
      policy.packages.some((item) => item.name === name),
      false,
    );
  assert.deepEqual(
    policy.assessments.filter((item) =>
      /^(postcss-selector-parser|@tailwindcss\/typography):/.test(item.key),
    ),
    [],
  );
  assert.deepEqual(
    policy.contexts.filter((item) => item.id === "build-css-source-map"),
    [],
  );
});

// deepmerge 권고는 철회됐어도 shadcn·registry·deepmerge의 설치와 dev=true 분류는 유지합니다.
// shadcn을 dependencies로 되돌리면 이 테스트와 남은 shadcn audit 스냅샷이 함께 실패합니다.
test("shadcn CLI 경로는 개발 의존성으로만 설치되어 개발 도구 기한을 따른다", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url)));
  assert.equal(manifest.dependencies.shadcn, undefined);
  assert.equal(manifest.devDependencies.shadcn, "^4.22.1");
  for (const path of [
    "node_modules/shadcn",
    "node_modules/@shadcn/registry",
    "node_modules/deepmerge",
  ])
    assert.equal(lock.packages[path].dev, true);
  assert.deepEqual(
    policy.packages.find((item) => item.name === "shadcn").nodes.map((node) => node.development),
    [true],
  );
  // 2026-11-18 picomatch 권고(GHSA-fc5q-39xc-vjpf)도 철회되어 registry의 전이 링크가 다시 사라졌습니다.
  assert.deepEqual(
    policy.packages.filter((item) => ["deepmerge", "@shadcn/registry"].includes(item.name)),
    [],
  );
  assert.deepEqual(policy.packages.find((item) => item.name === "shadcn").via, [
    { dependency: "ts-morph" },
  ]);
});

// minimatch 권고는 CLI dev=false 경로와 개발 도구 경로를 계속 분리해 서로 다른 기한으로 재검토합니다.
// 2026-11-04(UTC) 권고 범위가 >=7.0.0 <11.0.1로 정정되어 루트 minimatch 3.1.5의 ESLint 경로는 audit에서 빠졌습니다.
test("minimatch 권고는 사용면을 분리해 위험별 기한으로 재검토한다", () => {
  assert.equal(
    policy.assessments.filter((item) => item.contextId === "tooling-minimatch-glob").length,
    13,
  );
  for (const name of [
    "eslint",
    "@eslint/config-array",
    "@eslint/eslintrc",
    "@eslint-community/eslint-utils",
    "eslint-plugin-import",
    "eslint-plugin-jsx-a11y",
    "eslint-plugin-react",
  ])
    assert.equal(
      policy.packages.some((item) => item.name === name),
      false,
    );
  assert.deepEqual(
    policy.assessments.filter((item) => item.key === "minimatch:1244012"),
    [],
  );
  assert.deepEqual(
    policy.assessments
      .filter((item) => item.contextId === "shadcn-ts-morph-glob")
      .map((item) => item.key),
    ["@ts-morph/common:minimatch", "shadcn:ts-morph", "ts-morph:@ts-morph/common"],
  );
  const minimatchPkg = policy.packages.find((item) => item.name === "minimatch");
  assert.equal(minimatchPkg?.range, "7.0.0 - 11.0.0");
  assert.deepEqual(
    minimatchPkg?.via.map((item) => `${item.id}:${item.source}:${item.range}`),
    ["GHSA-g3hv-75wg-m249:1244623:>=7.0.0 <11.0.1"],
  );
  assert.ok(minimatchPkg?.nodes.every((node) => node.version === "10.2.5" && node.development));
});

// 실제 원장의 기한을 늘리지 않고 합성 평가만 만료시켜 일반 실패 차단이 남아 있음을 확인합니다.
test("YAML 예외를 제거해도 다른 평가의 만료는 계속 차단한다", () => {
  const input = structuredClone(policy);
  input.assessments[0].reviewBy = "2026-11-19";
  assert.deepEqual(verifyReviewedFixture(audit, lock, input, "2026-11-19"), {
    affectedPackages: 15,
    advisoryEntries: 2,
    p1: 0,
  });
  assert.throws(
    () => verifyReviewedFixture(audit, lock, input, "2026-11-20"),
    /DEPENDENCY_TRIAGE_INVALID/,
  );
});

test("drizzle-kit 0.31.11은 설치 버전·개발용 전이 경로·재검토 기한을 명시적으로 유지한다", () => {
  const tool = policy.packages.find((item) => item.name === "drizzle-kit");
  assert.deepEqual(tool?.nodes, [
    { path: "node_modules/drizzle-kit", version: "0.31.11", development: true },
  ]);
  assert.deepEqual(tool?.via, [{ dependency: "@esbuild-kit/esm-loader" }]);
  const review = policy.assessments.find(
    (item) => item.key === "drizzle-kit:@esbuild-kit/esm-loader",
  );
  assert.equal(review?.reviewedOn, "2026-11-06");
  assert.equal(review?.reviewBy, "2026-12-03");
});

test("Blob SDK는 cli-config의 Zod 취약 버전을 수정본으로만 해석한다", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url)));
  assert.equal(manifest.overrides["@vercel/cli-config"]?.zod, "^4.6.6");
  assert.equal(lock.packages["node_modules/@vercel/cli-config/node_modules/zod"], undefined);
  assert.equal(lock.packages["node_modules/zod"]?.version, "4.6.7");
});

// picomatch 권고 철회로 Next ESLint 경로는 다시 원장에서 빠지며, 재등장은 그대로 차단합니다.
test("더는 취약하지 않은 Next ESLint 경로는 원장에서 빠지고 재등장은 차단한다", () => {
  assert.equal(lock.packages["node_modules/eslint-config-next"].version, "16.4.5");
  assert.equal(
    policy.packages.some((item) =>
      ["eslint-config-next", "@next/eslint-plugin-next"].includes(item.name),
    ),
    false,
  );
  assert.equal(
    policy.assessments.some((item) => item.key === "eslint-config-next:typescript-eslint"),
    false,
  );
  const plugin = policy.packages.find((item) => item.name === "@typescript-eslint/eslint-plugin");
  assert.deepEqual(
    plugin.via.map((item) => item.dependency),
    ["@typescript-eslint/type-utils", "@typescript-eslint/utils"],
  );
  const input = structuredClone(audit);
  input.vulnerabilities["eslint-config-next"] = {
    name: "eslint-config-next",
    severity: "moderate",
    range: "*",
    nodes: ["node_modules/eslint-config-next"],
    via: ["typescript-eslint"],
  };
  assert.throws(
    () => verifyReviewedFixture(input, lock, policy, "2026-11-19"),
    /DEPENDENCY_TRIAGE_CHANGED/,
  );
});

test("현재 lock의 모든 resolved는 공식 npm registry를 가리킨다", () => {
  assert.deepEqual(lockRegistryViolations(lock), []);
});
test("외부 피드 resolved는 주소 없이 설치 경로만 진단하고 차단한다", () => {
  const input = structuredClone(lock);
  input.packages["node_modules/dotenv"].resolved =
    "https://ms-feed-25.pkgs.visualstudio.com/x/-/dotenv-17.4.2.tgz";
  input.packages["node_modules/turndown"].resolved =
    "https://registry.npmjs.org.evil.example/turndown/-/turndown-7.2.4.tgz";
  assert.deepEqual(
    lockRegistryViolations(input).map((item) => item.path),
    ["node_modules/dotenv", "node_modules/turndown"],
  );
  let thrown;
  try {
    verifyReviewedFixture(audit, input, policy, "2026-11-19");
  } catch (error) {
    thrown = error;
  }
  assert.equal(thrown?.message, "DEPENDENCY_LOCK_REGISTRY_INVALID");
  const output = dependencyDiagnosticLines(thrown).join("\n");
  assert.match(output, /node_modules\/dotenv/);
  assert.doesNotMatch(output, /visualstudio|evil/);
});

// #446: 모바일 앱 lockfile도 같은 정확 일치·기한·공식 registry 정책을 별도 원장으로 적용한다.
const mobilePolicy = JSON.parse(
  readFileSync(new URL("../../security/mobile-dependency-triage.json", import.meta.url)),
);
const mobileLock = JSON.parse(
  readFileSync(new URL("../../apps/mobile/package-lock.json", import.meta.url)),
);
// 주의: mobileAudit는 원장에서 복원한 응답이라 아래 원장↔snapshot 일치 단언은 순환적이다. 여기서는 원장 nodes가
// 실제 lock 경로·버전과 맞는지와 정책 규칙만 확인한다. 실제 registry audit와 원장의 일치는 `npm run verify:dependencies`
// 실행(CI의 repository-security 워크플로)에서만 검사된다.
const mobileAudit = {
  auditReportVersion: 2,
  vulnerabilities: Object.fromEntries(
    mobilePolicy.packages.map((pkg) => [
      pkg.name,
      {
        name: pkg.name,
        severity: pkg.severity,
        range: pkg.range,
        nodes: pkg.nodes.map((node) => node.path),
        via: pkg.via.map((v) =>
          v.source ? { ...v, url: "https://github.com/advisories/" + v.id } : v.dependency,
        ),
      },
    ]),
  ),
};
const mobileResult = { affectedPackages: 27, advisoryEntries: 2, p1: 0 };

// npm의 상위 패키지 meta range는 새 upstream 릴리스만으로 바뀔 수 있다.
// 실제 위험 평가에 쓰는 severity, via의 advisory range/ID/source와 lock nodes의 정확 일치는 유지한다.
test("상위 패키지 파생 range만 바뀌면 통과하지만 실제 권고·등급·경로 변경은 차단한다", () => {
  const changedDerived = structuredClone(mobileAudit);
  changedDerived.vulnerabilities.expo.range += " || 999.0.0";
  changedDerived.vulnerabilities["@expo/fingerprint"].range += " || 999.0.0";
  assert.deepEqual(
    verifyReviewedFixture(changedDerived, mobileLock, mobilePolicy, "2026-11-19"),
    mobileResult,
  );

  const severityChanged = structuredClone(changedDerived);
  severityChanged.vulnerabilities["@expo/fingerprint"].severity = "critical";
  assert.throws(
    () => verifyReviewedFixture(severityChanged, mobileLock, mobilePolicy, "2026-11-19"),
    /DEPENDENCY_TRIAGE_CHANGED/,
  );

  const advisoryChanged = structuredClone(changedDerived);
  advisoryChanged.vulnerabilities.minimatch.via[0].range += " || 999.0.0";
  assert.throws(
    () => verifyReviewedFixture(advisoryChanged, mobileLock, mobilePolicy, "2026-11-19"),
    /DEPENDENCY_TRIAGE_CHANGED/,
  );

  const linkChanged = structuredClone(changedDerived);
  linkChanged.vulnerabilities["@expo/fingerprint"].via.push("previously-unreviewed-dependency");
  assert.throws(
    () => verifyReviewedFixture(linkChanged, mobileLock, mobilePolicy, "2026-11-19"),
    /DEPENDENCY_TRIAGE_CHANGED/,
  );

  const versionChanged = structuredClone(mobileLock);
  versionChanged.packages["node_modules/@expo/fingerprint"].version = "99.0.0";
  assert.throws(
    () => verifyReviewedFixture(changedDerived, versionChanged, mobilePolicy, "2026-11-19"),
    /DEPENDENCY_TRIAGE_CHANGED/,
  );

  const invalidRange = structuredClone(mobilePolicy);
  invalidRange.packages.find((item) => item.name === "@expo/fingerprint").range = "";
  assert.throws(
    () => verifyReviewedFixture(mobileAudit, mobileLock, invalidRange, "2026-11-19"),
    /DEPENDENCY_TRIAGE_CHANGED/,
  );
});

test("모바일 원장은 lock 스냅샷과 정확히 일치하고 모든 resolved가 공식 registry다", () => {
  assert.deepEqual(dependencySnapshot(mobileAudit, mobileLock), mobilePolicy.packages);
  assert.deepEqual(lockRegistryViolations(mobileLock), []);
  assert.deepEqual(
    verifyReviewedFixture(mobileAudit, mobileLock, mobilePolicy, "2026-11-19"),
    mobileResult,
  );
});

test("Expo 58 패치의 호환 버전과 Zod high audit 제거를 정확히 검증한다", () => {
  const app = JSON.parse(readFileSync(new URL("../../apps/mobile/package.json", import.meta.url)));
  for (const [name, version] of Object.entries({
    expo: "58.0.26",
    react: "19.3.0",
    "react-dom": "19.3.0",
    "react-native-safe-area-context": "5.11.1",
  })) {
    assert.equal(app.dependencies[name], version);
    assert.equal(mobileLock.packages[""].dependencies[name], version);
    assert.equal(mobileLock.packages["node_modules/" + name].version, version);
  }
  // Expo 58.0.26은 @expo/cli를 expo 아래에 중첩 설치하며, 58.1.20+는 glob 경로를 더 이상 쓰지 않습니다.
  assert.equal(mobileLock.packages["node_modules/@expo/cli"], undefined);
  assert.equal(mobileLock.packages["node_modules/expo/node_modules/@expo/cli"].version, "58.1.21");
  assert.equal(mobileLock.packages["node_modules/@expo/fingerprint"].version, "0.21.10");
  assert.equal(
    mobilePolicy.packages.some((item) => item.name === "@expo/cli"),
    false,
  );
  assert.deepEqual(
    mobilePolicy.packages.filter((item) => ["zod", "picomatch"].includes(item.name)),
    [],
  );
  assert.equal(
    mobilePolicy.packages.some((item) => item.severity === "critical"),
    false,
  );
  assert.equal(
    mobilePolicy.assessments.some((item) => item.contextId === "expo-cli-devtools-zod"),
    false,
  );
});

test("모바일 node-forge는 보안 패치 1.4.3을 사용하며 새 권고가 나오면 차단한다", () => {
  const forge = mobileLock.packages["node_modules/node-forge"];
  assert.equal(forge.version, "1.4.3");
  assert.equal(forge.resolved, "https://registry.npmjs.org/node-forge/-/node-forge-1.4.3.tgz");
  assert.equal(
    forge.integrity,
    "sha512-P6wzfh6t70avmV8FrVEAd/36sOPJQ+hkaJVX1Laap9J/77m7M0eyozDvc8SwnDf4P7MP94gwbAAo0rg3YVXT+g==",
  );
  for (const path of [
    "node_modules/@expo/code-signing-certificates",
    "node_modules/expo/node_modules/@expo/cli",
  ]) {
    assert.equal(mobileLock.packages[path].dependencies["node-forge"], "^1.4.0");
  }
  assert.equal(
    mobilePolicy.packages.some((item) => item.name === "node-forge"),
    false,
  );
  const changed = structuredClone(mobileAudit);
  changed.vulnerabilities["node-forge"] = {
    name: "node-forge",
    severity: "high",
    range: "<1.4.3",
    nodes: ["node_modules/node-forge"],
    via: [
      {
        source: 999995,
        url: "https://github.com/advisories/GHSA-test-new-forge",
        severity: "high",
        range: "<1.4.3",
        title: "synthetic regression advisory",
      },
    ],
  };
  assert.throws(
    () => verifyReviewedFixture(changed, mobileLock, mobilePolicy, "2026-11-19"),
    /DEPENDENCY_TRIAGE_CHANGED/,
  );
});

test("모바일 감사에서 사라진 린트 경로와 CLI 링크는 원장에서 제거한다", () => {
  for (const name of ["eslint-config-expo", "eslint-plugin-expo"]) {
    assert.equal(
      mobilePolicy.packages.some((item) => item.name === name),
      false,
    );
    assert.equal(
      mobilePolicy.assessments.some((item) => item.key.startsWith(name + ":")),
      false,
    );
  }
  assert.deepEqual(
    mobilePolicy.packages.find((item) => item.name === "expo").via.map((item) => item.dependency),
    ["@expo/fingerprint"],
  );
  // @expo/fingerprint 0.21.10은 glob 링크가 사라지고 minimatch 링크만 남습니다.
  assert.deepEqual(
    mobilePolicy.packages
      .find((item) => item.name === "@expo/fingerprint")
      .via.map((item) => item.dependency),
    ["minimatch"],
  );
  assert.deepEqual(
    mobilePolicy.assessments
      .filter((item) => item.contextId === "expo-cli-config-glob")
      .map((item) => item.key),
    [
      "@expo/fingerprint:minimatch",
      "expo:@expo/fingerprint",
      "glob:minimatch",
      "glob:1244013",
      "minimatch:1244623",
    ],
  );
  assert.deepEqual(
    mobilePolicy.packages
      .find((item) => item.name === "@typescript-eslint/eslint-plugin")
      .via.map((item) => item.dependency),
    ["@typescript-eslint/type-utils", "@typescript-eslint/utils"],
  );
});

test("모바일 sharp는 수정본으로 해소해 원장에 남지 않는다", () => {
  assert.equal(mobileLock.packages["node_modules/sharp"].version, "0.35.5");
  assert.equal(
    mobilePolicy.packages.some((item) => item.name === "sharp"),
    false,
  );
  assert.deepEqual(
    mobilePolicy.assessments.filter((item) => item.key.startsWith("sharp:")),
    [],
  );
});

// Expo SDK 58.0.23은 zod high 경로를 npm audit에서 더 이상 보고하지 않는다. 개발 도구 전용(eslint-lint-tooling)은 4주 기한을 유지한다.
// 2026-11-05 minimatch 권고 범위 정정(>=7.0.0 <11.0.1, source 1244012 → 1244623)으로 다시 확인한 평가는 검토일만 옮겼다.
// 2026-11-19(UTC) 기한 전 registry 재확인으로 expo-cli-config-glob·jest-test-runner 전체 평가의 검토일을 옮겼다.
// expo-cli-config-glob은 범위 안 부분 수정본(@expo/cli 58.1.20+, @expo/fingerprint 0.21.10)이 미적용이라 2주,
// 이후 Expo 58.0.26 패치 적용으로 @expo/cli:glob·@expo/fingerprint:glob 평가는 제거했고 남은 평가의 기한은 바꾸지 않았다.
// jest-test-runner는 범위 안 수정본이 없는 dev=false 테스트 도구 DoS라 3주다.
test("모바일 평가는 사용면 위험별 기한을 두고 가장 이른 기한 다음 날 차단한다", () => {
  const deadlines = {
    "expo-cli-config-glob": "2026-12-03",
    "jest-test-runner": "2026-12-10",
    "eslint-lint-tooling": "2026-12-02",
  };
  const rechecked = (item) => item.contextId === "eslint-lint-tooling";
  const rereviewed = new Set(["expo-cli-config-glob", "jest-test-runner"]);
  assert.deepEqual(
    mobilePolicy.contexts.map((item) => item.id).sort(),
    Object.keys(deadlines).sort(),
  );
  // 철회된 picomatch 권고(GHSA-fc5q-39xc-vjpf)의 171개 전이 평가와 전용 맥락은 남기지 않는다.
  assert.equal(mobilePolicy.assessments.length, 50);
  assert.ok(
    mobilePolicy.assessments.every(
      (item) =>
        item.reviewedOn ===
          (rereviewed.has(item.contextId)
            ? "2026-11-19"
            : rechecked(item)
              ? "2026-11-05"
              : "2026-11-04") && item.reviewBy === deadlines[item.contextId],
    ),
  );
  assert.deepEqual(
    mobilePolicy.assessments.filter(
      (item) => item.key.includes("zod") || item.contextId === "expo-cli-devtools-zod",
    ),
    [],
  );
  assert.deepEqual(
    verifyReviewedFixture(mobileAudit, mobileLock, mobilePolicy, "2026-12-02"),
    mobileResult,
  );
  assert.throws(
    () => verifyReviewedFixture(mobileAudit, mobileLock, mobilePolicy, "2026-12-03"),
    /DEPENDENCY_TRIAGE_INVALID/,
  );
});

// 같은 권고 정정으로 영향 범위 밖이 된 minimatch 3.x·5.x 경로(eslint 본체·Redocly)와 그 평가·context는 남지 않는다.
test("모바일 원장은 정정 전 minimatch source와 빠진 경로를 남기지 않는다", () => {
  assert.deepEqual(
    mobilePolicy.assessments.filter((item) => item.key === "minimatch:1244012"),
    [],
  );
  assert.equal(
    mobilePolicy.assessments.filter((item) => item.key === "minimatch:1244623").length,
    1,
  );
  assert.deepEqual(
    mobilePolicy.packages.filter((item) =>
      ["eslint", "@redocly/openapi-core", "openapi-typescript"].includes(item.name),
    ),
    [],
  );
  assert.equal(
    mobilePolicy.packages
      .find((item) => item.name === "minimatch")
      .nodes.some((node) => node.path === "node_modules/minimatch"),
    false,
  );
});

// test-exclude처럼 같은 이름의 전이 패키지를 여러 버전으로 두면 npm이 같은 링크를 중복 보고한다. 최초 등록 때는
// test-exclude의 glob 7·10이 그랬지만 2026-11-05 권고 정정으로 glob 7 경로가 빠져 현재 lock에는 중복이 없으므로 합성 입력으로 확인한다.
test("검증된 meta copy는 정본 평가 하나를 쓰되 중복 평가는 계속 차단한다", () => {
  assert.equal(
    mobilePolicy.assessments.filter((item) => item.key === "test-exclude:glob").length,
    1,
  );
  const audited = structuredClone(mobileAudit);
  audited.vulnerabilities["test-exclude"].via.push("glob");
  const recorded = structuredClone(mobilePolicy);
  recorded.packages
    .find((item) => item.name === "test-exclude")
    .via.unshift({ dependency: "glob" });
  assert.deepEqual(
    verifyReviewedFixture(audited, mobileLock, recorded, "2026-11-19"),
    mobileResult,
  );
  assert.deepEqual(
    verifyReviewedFixture(mobileAudit, mobileLock, recorded, "2026-11-19"),
    mobileResult,
  );
  const extra = structuredClone(recorded);
  extra.assessments.push({ ...extra.assessments.find((item) => item.key === "test-exclude:glob") });
  assert.throws(
    () => verifyReviewedFixture(audited, mobileLock, extra, "2026-11-19"),
    /DEPENDENCY_TRIAGE_MISSING/,
  );
});

test("모바일 lock의 새 권고·외부 피드 resolved는 차단한다", () => {
  const input = structuredClone(mobileAudit);
  input.vulnerabilities.minimatch.via.push({
    source: 999999,
    url: "https://github.com/advisories/GHSA-test-1234",
    severity: "critical",
    range: "<99",
    title: "SENSITIVE_SENTINEL",
  });
  assert.throws(
    () => verifyReviewedFixture(input, mobileLock, mobilePolicy, "2026-11-19"),
    /DEPENDENCY_TRIAGE_CHANGED/,
  );
  const lockInput = structuredClone(mobileLock);
  lockInput.packages["node_modules/expo"].resolved =
    "https://registry.npmjs.org.evil.example/expo/-/expo-58.0.23.tgz";
  assert.throws(
    () => verifyReviewedFixture(mobileAudit, lockInput, mobilePolicy, "2026-11-19"),
    /DEPENDENCY_LOCK_REGISTRY_INVALID/,
  );
});

// picomatch GHSA-fc5q-39xc-vjpf는 2026-11-18T15:38:56Z 공식 철회됐습니다. 설치 버전은 그대로이며
// 철회를 버전 수정이나 위험 해소로 설명하지 않습니다. 같은 권고가 다시 보고되면 정확 집합 검사로 차단합니다.
test("철회된 picomatch 권고의 평가·맥락은 남기지 않고 재등장은 차단한다", () => {
  for (const [current, response, currentLock, contextId] of [
    [policy, audit, lock, "tooling-picomatch-extglob"],
    [mobilePolicy, mobileAudit, mobileLock, "mobile-picomatch-host-tools"],
  ]) {
    assert.deepEqual(
      current.packages.filter((item) => item.name === "picomatch"),
      [],
    );
    assert.deepEqual(
      current.assessments.filter(
        (item) => item.contextId === contextId || item.key.endsWith(":picomatch"),
      ),
      [],
    );
    assert.deepEqual(
      current.contexts.filter((item) => item.id === contextId),
      [],
    );
    const reappeared = structuredClone(response);
    reappeared.vulnerabilities.picomatch = {
      name: "picomatch",
      severity: "high",
      range: "<=4.0.7",
      nodes: ["node_modules/picomatch"],
      via: [
        {
          source: 1247710,
          url: "https://github.com/advisories/GHSA-fc5q-39xc-vjpf",
          severity: "high",
          range: "<=4.0.7",
          title: "synthetic reappearance",
        },
      ],
    };
    assert.throws(
      () => verifyReviewedFixture(reappeared, currentLock, current, "2026-11-19"),
      /DEPENDENCY_TRIAGE_CHANGED/,
    );
  }
});

// 이미 도달 가능한 전이 패키지로의 중복 링크는 입력 binding·identity·qualified closure 뒤에만 정본 평가를 사용합니다.
// (예전 metro 계열 표현은 picomatch 권고 철회로 원장에서 빠져 남은 jest 경로로 같은 성질을 확인합니다.)
test("정본에서 복원한 합성 mobile 표현은 qualified closure 뒤 정본 평가를 공유한다", () => {
  const included = structuredClone(mobileAudit);
  included.vulnerabilities["jest-runner"].via.push("jest-snapshot");
  included.vulnerabilities.jest.via.push("jest-config");
  assert.deepEqual(
    verifyReviewedFixture(included, mobileLock, mobilePolicy, "2026-11-19"),
    mobileResult,
  );
});

// 진단만 늘리고 기존 exact 판정과20건 제한·민감값 비출력을 유지합니다.
for (const [label, mutate, category] of [
  [
    "via 중복",
    (a) => a.vulnerabilities.esbuild.via.push(a.vulnerabilities.esbuild.via[0]),
    "ARRAY_COUNT",
  ],
  ["package 순서", (a, p) => p.packages.reverse(), "CANONICAL_PASS"],
  [
    "node 키 순서",
    (a, p) => {
      const n = p.packages[0].nodes[0];
      p.packages[0].nodes[0] = Object.fromEntries(Object.entries(n).reverse());
    },
    "CANONICAL_PASS",
  ],
  ["원문 임의 키", (a, p) => (p.packages[0]["SENSITIVE_SENTINEL/secret"] = true), "OBJECT_KEYS"],
  [
    "원문 제목",
    (a) => (a.vulnerabilities.esbuild.via[0].title = "SENSITIVE_SENTINEL"),
    "VALUE_OR_TYPE",
  ],
])
  test(label + (category === "CANONICAL_PASS" ? " known canonical class" : " literal 차단"), () => {
    const input = structuredClone(audit);
    const recorded = structuredClone(policy);
    mutate(input, recorded);
    if (category === "CANONICAL_PASS") {
      assert.equal(verifyReviewedFixture(input, lock, recorded, "2026-11-19").p1, 0);
      return;
    }
    let error;
    try {
      verifyReviewedFixture(input, lock, recorded, "2026-11-19");
    } catch (caught) {
      error = caught;
    }
    assert.equal(error?.message, "DEPENDENCY_TRIAGE_CHANGED");
    const lines = dependencyDiagnosticLines(error);
    const row = JSON.parse(lines[1].slice("DEPENDENCY_CHANGE ".length));
    assert.equal(row.literalDiff.category, category);
    assert.match(row.literalDiff.expectedHash, /^[a-f0-9]{64}$/);
    assert.match(row.literalDiff.actualHash, /^[a-f0-9]{64}$/);
    assert.doesNotMatch(lines.join("\n"), /SENSITIVE_SENTINEL|secret/);
  });
test("기존 Map 진단이 있어도 중복 literal 차이를 출력하고 외부 진단필드는 무시한다", () => {
  const input = structuredClone(audit);
  const first = Object.keys(input.vulnerabilities)[0];
  input.vulnerabilities[first].via.push(input.vulnerabilities[first].via[0]);
  input.vulnerabilities.esbuild.severity = "critical";
  const error = capturePolicyError(input);
  assert.ok(error.diagnostics.some((row) => row.kind === "PACKAGE_METADATA_CHANGED"));
  assert.equal(
    JSON.parse(dependencyDiagnosticLines(error)[1].slice("DEPENDENCY_CHANGE ".length)).literalDiff
      .category,
    "ARRAY_COUNT",
  );
  const forged = Object.assign(new Error("DEPENDENCY_TRIAGE_CHANGED"), {
    diagnostics: [{ kind: "SNAPSHOT_CHANGED" }],
    literalDifference: "SENSITIVE_SENTINEL",
  });
  assert.doesNotMatch(dependencyDiagnosticLines(forged).join("\n"), /SENSITIVE_SENTINEL/);
});

// lock.version의 기존 truthy 허용은 바꾸지 않고 객체 내부의 원문 키·값을 진단에서 숨깁니다.
for (const [label, key] of [
  ["비공개 키", "SENSITIVE_PRIVATE_KEY"],
  ["구조와 같은 키", "nodes"],
])
  test(label + " version 객체는 opaque 진단이다", () => {
    const inputLock = structuredClone(lock);
    const recorded = structuredClone(policy);
    const node = recorded.packages[0].nodes[0];
    inputLock.packages[node.path].version = { [key]: { title: "SENSITIVE_ACTUAL_VALUE" } };
    node.version = { [key]: { title: "SENSITIVE_EXPECTED_VALUE" } };
    let error;
    try {
      verifyReviewedFixture(audit, inputLock, recorded, "2026-11-19");
    } catch (caught) {
      error = caught;
    }
    assert.equal(error?.message, "DEPENDENCY_TRIAGE_CHANGED");
    const lines = dependencyDiagnosticLines(error);
    const detail = JSON.parse(lines[1].slice("DEPENDENCY_CHANGE ".length)).literalDiff;
    assert.equal(detail.category, "VALUE_OR_TYPE");
    assert.match(detail.fieldPath, /\.version$/);
    assert.doesNotMatch(
      lines.join("\n"),
      /SENSITIVE_PRIVATE_KEY|SENSITIVE_ACTUAL_VALUE|SENSITIVE_EXPECTED_VALUE/,
    );
  });

/** 승인된 v3 계약을 실제 정책과 분리한 가상 패키지로 검증합니다. */
const fixtureHash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const fixtureAdvisory = {
  source: 900001,
  id: "GHSA-fixture-one",
  severity: "high",
  range: "<2",
  title: "검증용 가상 권고",
};
function fixtureAudit(packages) {
  return {
    auditReportVersion: 2,
    vulnerabilities: Object.fromEntries(
      packages.map((pkg) => [
        pkg.name,
        {
          name: pkg.name,
          severity: pkg.severity,
          range: pkg.range,
          nodes: pkg.nodes.map((node) => node.path),
          via: pkg.via.map((via) =>
            "dependency" in via
              ? via.dependency
              : { ...via, url: "https://github.com/advisories/" + via.id },
          ),
        },
      ]),
    ),
  };
}
// 이 함수는 synthetic fixture 승인값만 만듭니다. 실제 원장을 갱신하는 도구가 아닙니다.
function bindFixture(fixture) {
  fixture.inputs = {
    manifestBytes: Buffer.from(JSON.stringify(fixture.manifest)),
    lockBytes: Buffer.from(JSON.stringify(fixture.lock)),
  };
  fixture.policy.manifestBinding = {
    algorithm: "sha256",
    input: "package-json.raw-bytes-v1",
    digest: fixtureHash(fixture.inputs.manifestBytes),
  };
  fixture.policy.lockBinding = {
    algorithm: "sha256",
    input: "package-lock.raw-bytes-v1",
    digest: fixtureHash(fixture.inputs.lockBytes),
  };
}
function identityFixture(
  graph = { a: ["b"], b: [fixtureAdvisory], c: ["b"] },
  project = "fixture-root",
) {
  const packages = Object.entries(graph).map(([name, via]) => ({
    name,
    severity: "high",
    range: "*",
    nodes: [{ path: "node_modules/" + name, version: "1.0.0", development: true }],
    via: via.map((value) => (typeof value === "string" ? { dependency: value } : { ...value })),
  }));
  const fixture = {
    manifest: { name: project, version: "1.0.0" },
    lock: {
      lockfileVersion: 3,
      packages: Object.fromEntries([
        ["", { name: project }],
        ...packages.map((pkg) => [pkg.nodes[0].path, { version: "1.0.0", dev: true }]),
      ]),
    },
    policy: {
      schemaVersion: 3,
      note: "격리된 가상 정책 검증 입력",
      identityMode: "reviewed-input-origin-leaf-v1",
      packages,
      contexts: [
        {
          id: "fixture-context",
          usedApi: "실제 운영과 무관한 가상 API 검증입니다.",
          callLocations: "임시 테스트 프로젝트 안에서만 사용합니다.",
          assessment: "정책 검증을 위한 합성 판단문이며 운영 승인이 아닙니다.",
          residualAssumptions: "실제 위험이나 날짜를 자동 변경하지 않습니다.",
        },
      ],
      assessments: [
        ...new Set(
          packages.flatMap((pkg) =>
            pkg.via.map((via) => `${pkg.name}:${via.source ?? via.dependency}`),
          ),
        ),
      ].map((key) => ({
        key,
        contextId: "fixture-context",
        priority: "P2",
        owner: "repo-maintainers",
        reviewedOn: "2000-01-01",
        reviewBy: "9999-12-31",
        attackCondition: "격리 fixture의 명시적 가상 조건이며 운영 위험 수용이 아닙니다.",
      })),
    },
  };
  bindFixture(fixture);
  fixture.audit = fixtureAudit(packages);
  return fixture;
}
const verifyFixture = (f) => verifyV3DependencyPolicy(f.audit, f.inputs, f.policy, "2026-11-19");
test("v3는 reviewed Buffer pair와 전체 origin closure를 확인한다", () => {
  assert.deepEqual(verifyFixture(identityFixture()), {
    affectedPackages: 3,
    advisoryEntries: 1,
    p1: 0,
  });
});
for (const [name, mutate] of [
  [
    "manifest 임의 필드",
    (f) =>
      (f.inputs.manifestBytes = Buffer.from(JSON.stringify({ ...f.manifest, metadata: true }))),
  ],
  [
    "manifest LF",
    (f) => (f.inputs.manifestBytes = Buffer.concat([f.inputs.manifestBytes, Buffer.from("\n")])),
  ],
  [
    "manifest CRLF",
    (f) => (f.inputs.manifestBytes = Buffer.concat([f.inputs.manifestBytes, Buffer.from("\r\n")])),
  ],
  [
    "manifest dependency 종류",
    (f) =>
      (f.inputs.manifestBytes = Buffer.from(
        JSON.stringify({ ...f.manifest, peerDependencies: { b: "^1" } }),
      )),
  ],
  [
    "manifest overrides",
    (f) =>
      (f.inputs.manifestBytes = Buffer.from(
        JSON.stringify({ ...f.manifest, overrides: { b: "1" } }),
      )),
  ],
  [
    "manifest workspaces",
    (f) =>
      (f.inputs.manifestBytes = Buffer.from(JSON.stringify({ ...f.manifest, workspaces: ["x"] }))),
  ],
  [
    "lock 같은 node의 새 relation",
    (f) => {
      const lock = structuredClone(f.lock);
      lock.packages["node_modules/a"].dependencies = { c: "^1" };
      f.inputs.lockBytes = Buffer.from(JSON.stringify(lock));
    },
  ],
  [
    "lock whitespace",
    (f) => (f.inputs.lockBytes = Buffer.concat([f.inputs.lockBytes, Buffer.from(" ")])),
  ],
  ["manifest digest 누락", (f) => delete f.policy.manifestBinding],
  ["lock digest 누락", (f) => delete f.policy.lockBinding],
  ["알고리즘 변경", (f) => (f.policy.manifestBinding.algorithm = "unknown")],
  ["입력 tag 변경", (f) => (f.policy.lockBinding.input = "unknown")],
  ["parsed lock fallback", (f) => (f.inputs.lockBytes = f.lock)],
  ["schema downgrade", (f) => (f.policy.schemaVersion = 2)],
])
  test("v3 " + name + " 차단", () => {
    const f = identityFixture();
    mutate(f);
    assert.throws(() => verifyFixture(f), /DEPENDENCY_/);
  });
for (const [name, mutate] of [
  ["같은 origin redundant path", (f) => f.audit.vulnerabilities.a.via.push("c")],
  ["같은 meta string copy", (f) => f.audit.vulnerabilities.a.via.push("b")],
  [
    "raw key 순서",
    (f) => {
      f.audit.vulnerabilities = Object.fromEntries(
        Object.entries(f.audit.vulnerabilities).reverse(),
      );
    },
  ],
  [
    "reference container/list 순서",
    (f) => {
      f.policy.packages.reverse();
      f.policy.packages = f.policy.packages.map((pkg) =>
        Object.fromEntries(Object.entries(pkg).reverse()),
      );
    },
  ],
  [
    "raw 기존 ignored metadata",
    (f) => {
      f.audit.vulnerabilities.b.isDirect = false;
      f.audit.vulnerabilities.b.via[0].cwe = ["fixture"];
    },
  ],
])
  test("v3 " + name + " 승인 class", () => {
    const f = identityFixture();
    mutate(f);
    assert.equal(verifyFixture(f).p1, 0);
  });
for (const [name, mutate] of [
  [
    "node exact copy 추가",
    (f) => f.audit.vulnerabilities.b.nodes.push(f.audit.vulnerabilities.b.nodes[0]),
  ],
  [
    "direct exact copy 추가",
    (f) => f.audit.vulnerabilities.b.via.push(structuredClone(f.audit.vulnerabilities.b.via[0])),
  ],
  ["unknown reference package", (f) => (f.policy.packages[0]["SENSITIVE_PRIVATE_KEY"] = true)],
  [
    "unknown reference node",
    (f) => (f.policy.packages[0].nodes[0]["SENSITIVE_PRIVATE_KEY"] = true),
  ],
  ["unknown reference via", (f) => (f.policy.packages[0].via[0]["SENSITIVE_PRIVATE_KEY"] = true)],
  ["unknown graph target", (f) => (f.audit.vulnerabilities.a.via = ["missing"])],
])
  test("v3 " + name + " 실패와 비출력", () => {
    const f = identityFixture();
    mutate(f);
    let error;
    try {
      verifyFixture(f);
    } catch (caught) {
      error = caught;
    }
    assert.match(error?.message ?? "", /^DEPENDENCY_/);
    assert.doesNotMatch(dependencyDiagnosticLines(error).join("\n"), /SENSITIVE_PRIVATE_KEY/);
  });
test("v3 B/C 동일5의 origin-swap은 평가 재사용 전에 실패한다", () => {
  const f = identityFixture({ a: ["b"], b: [fixtureAdvisory], c: [fixtureAdvisory] });
  f.audit.vulnerabilities.a.via = ["c"];
  assert.throws(() => verifyFixture(f), /DEPENDENCY_TRIAGE_CHANGED/);
});
test("v3 global union이 같아도 vertex별 qualified closure 변화는 실패한다", () => {
  const other = { ...fixtureAdvisory, source: 900002, id: "GHSA-fixture-two" };
  const f = identityFixture({ a: ["b"], b: [fixtureAdvisory], c: [other] });
  f.audit.vulnerabilities.a.via = ["c"];
  assert.throws(() => verifyFixture(f), /DEPENDENCY_TRIAGE_CHANGED/);
});
for (const graph of [{ a: ["b"], b: ["a"] }, { a: ["a"] }, { a: ["missing"] }])
  test("v3 leaf 없는 cycle/dangling reference는 평가가 있어도 실패한다", () => {
    assert.throws(() => verifyFixture(identityFixture(graph)), /DEPENDENCY_TRIAGE_CHANGED/);
  });
test("v3 leaf 있는 cycle은 종료하고 qualified origin을 보존한다", () => {
  const f = identityFixture({ a: ["b"], b: [fixtureAdvisory, "a"] });
  assert.equal(verifyFixture(f).affectedPackages, 2);
});
test("v3 정상 empty graph와 error report는 구별한다", () => {
  const f = identityFixture({});
  f.policy.contexts = [];
  assert.equal(verifyFixture(f).affectedPackages, 0);
  f.audit.error = { summary: "SENSITIVE_SENTINEL" };
  assert.throws(() => verifyFixture(f), /DEPENDENCY_REPORT_INVALID/);
});
test("v3 opaque version 내부 키 순서는 canonicalize하지 않는다", () => {
  const f = identityFixture();
  const node = f.policy.packages.find((p) => p.name === "b").nodes[0];
  f.lock.packages[node.path].version = { first: 1, second: 2 };
  node.version = { first: 1, second: 2 };
  bindFixture(f);
  assert.equal(verifyFixture(f).p1, 0);
  node.version = { second: 2, first: 1 };
  assert.throws(() => verifyFixture(f), /DEPENDENCY_TRIAGE_CHANGED/);
});

test("v3 새 reference key는 closure가 같아도 평가를 자동 만들지 않는다", () => {
  const f = identityFixture();
  f.policy.packages.find((p) => p.name === "a").via.push({ dependency: "c" });
  assert.throws(() => verifyFixture(f), /DEPENDENCY_TRIAGE_MISSING/);
});

/** 실제 CLI를 격리 mirror에서 구동하며 실제 저장소 파일이나 registry를 변경하지 않습니다. */
function runIdentityCli(mode = "normal", args = []) {
  const directory = mkdtempSync(join(tmpdir(), "hra-identity-fixture-"));
  try {
    mkdirSync(join(directory, "scripts/_lib"), { recursive: true });
    mkdirSync(join(directory, "security"));
    mkdirSync(join(directory, "apps/mobile"), { recursive: true });
    mkdirSync(join(directory, "bin"));
    for (const file of ["verify-dependencies.mjs", "_lib/dependency-policy.mjs"])
      writeFileSync(
        join(directory, "scripts", file),
        readFileSync(new URL("../" + file, import.meta.url)),
      );
    const projects = {};
    for (const target of ["root", "mobile"]) {
      const f = identityFixture(undefined, "fixture-" + target);
      const prefix = target === "root" ? directory : join(directory, "apps/mobile");
      projects[target] = {
        manifest: join(prefix, "package.json"),
        lock: join(prefix, "package-lock.json"),
        policy: join(
          directory,
          "security",
          target === "root" ? "dependency-triage.json" : "mobile-dependency-triage.json",
        ),
        audit: f.audit,
      };
      writeFileSync(projects[target].manifest, f.inputs.manifestBytes);
      writeFileSync(projects[target].lock, f.inputs.lockBytes);
      writeFileSync(projects[target].policy, JSON.stringify(f.policy));
    }
    if (mode === "initial-capture-failure") rmSync(projects.root.manifest);
    const counter = join(directory, "calls.txt");
    const script = `#!${process.execPath}
const fs=require('node:fs');const path=require('node:path');
const projects=${JSON.stringify(projects)};const mode=${JSON.stringify(mode)};const counter=${JSON.stringify(counter)};
const pkg=JSON.parse(fs.readFileSync('package.json','utf8'));const target=pkg.name.endsWith('mobile')?'mobile':'root';fs.appendFileSync(counter,target+'\\n');
if(target==='root'){
 const field=mode.startsWith('source-')?mode.slice(7):null;
 if(['manifest','lock','policy'].includes(field))fs.appendFileSync(projects.root[field],'\\n');
 if(mode==='temp-manifest')fs.appendFileSync(path.resolve('package.json'),'\\n');
 if(mode==='temp-lock')fs.appendFileSync(path.resolve('package-lock.json'),'\\n');
 if(mode==='same-new-bytes'){fs.appendFileSync(projects.root.manifest,'\\n');fs.appendFileSync(path.resolve('package.json'),'\\n');}
 if(mode==='source-read-error')fs.unlinkSync(projects.root.policy);
 if(mode==='temp-read-error')fs.unlinkSync(path.resolve('package-lock.json'));
 if(mode==='signal')process.kill(process.ppid,'SIGTERM');
}
if(target==='mobile'&&mode==='late-root-policy')fs.appendFileSync(projects.root.policy,'\\n');
if(mode==='network'){process.stdout.write(JSON.stringify({error:{summary:'SENSITIVE_SENTINEL'}}));process.exit(1);}
if(mode==='malformed'){process.stdout.write('{SENSITIVE_SENTINEL');process.exit(1);}
if(mode==='status2'){process.stdout.write('SENSITIVE_SENTINEL');process.exit(2);}
process.stdout.write(JSON.stringify(projects[target].audit));process.exit(1);
`;
    writeFileSync(join(directory, "bin/npm"), script, { mode: 0o700 });
    const result = spawnSync(
      process.execPath,
      [join(directory, "scripts/verify-dependencies.mjs"), ...args],
      {
        cwd: directory,
        env: {
          PATH: join(directory, "bin") + ":" + process.env.PATH,
          HOME: directory,
          TMPDIR: directory,
        },
        encoding: "utf8",
        timeout: 15000,
      },
    );
    const calls = existsSync(counter)
      ? readFileSync(counter, "utf8").split("\n").filter(Boolean)
      : [];
    const leftovers = readdirSync(directory).filter((name) =>
      name.startsWith("hra-dependency-audit-"),
    );
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      calls,
      leftovers,
    };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
test("v3 CLI는 captured pair와 두 target final barrier 뒤에만 성공한다", () => {
  const result = runIdentityCli();
  assert.equal(result.status, 0);
  assert.deepEqual(result.calls, ["root", "mobile"]);
  assert.equal(result.stdout.trim().split("\n").length, 2);
  assert.deepEqual(result.leftovers, []);
});
for (const mode of [
  "source-manifest",
  "source-lock",
  "source-policy",
  "temp-manifest",
  "temp-lock",
  "same-new-bytes",
  "source-read-error",
  "temp-read-error",
  "late-root-policy",
])
  test("v3 CLI " + mode + "는 INPUT_CHANGED로 고정한다", () => {
    const result = runIdentityCli(mode);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /DEPENDENCY_INPUT_CHANGED/);
    assert.deepEqual(result.calls, ["root", "mobile"]);
    assert.doesNotMatch(result.stdout, /"target":"root"/);
    assert.deepEqual(result.leftovers, []);
  });
test("v3 CLI 첫 target capture 실패도 mobile을 계속 검사한다", () => {
  const result = runIdentityCli("initial-capture-failure");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /DEPENDENCY_INPUT_CAPTURE_FAILED/);
  assert.deepEqual(result.calls, ["mobile"]);
  assert.match(result.stdout, /"target":"mobile"/);
});
test("v3 CLI argv guard는 capture 실패보다 먼저이며 npm을 실행하지 않는다", () => {
  const result = runIdentityCli("initial-capture-failure", ["--unknown"]);
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "DEPENDENCY_ARGUMENTS_INVALID\n");
  assert.deepEqual(result.calls, []);
});
for (const [mode, code] of [
  ["network", "DEPENDENCY_AUDIT_FAILED"],
  ["malformed", "DEPENDENCY_CHECK_FAILED"],
  ["status2", "DEPENDENCY_AUDIT_FAILED"],
])
  test("v3 CLI 기존 " + mode + " 실패 출력 계약을 유지한다", () => {
    const result = runIdentityCli(mode);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, new RegExp(code));
    assert.doesNotMatch(result.stderr, /SENSITIVE_SENTINEL/);
    assert.deepEqual(result.calls, ["root", "mobile"]);
    assert.deepEqual(result.leftovers, []);
  });
test("v3 CLI signal은 실패로 끝나고 소유 temp를 정리한다", () => {
  const result = runIdentityCli("signal");
  assert.equal(result.status, 1);
  assert.deepEqual(result.calls, ["root"]);
  assert.equal(result.stdout, "");
  assert.deepEqual(result.leftovers, []);
});

/** production label builder와 독립인 수기 tuple oracle입니다. */
function fixtureOriginOracle(graph) {
  const result = {};
  for (const name of Object.keys(graph)) {
    const pending = [name];
    const seen = new Set();
    const labels = new Set();
    while (pending.length) {
      const origin = pending.pop();
      if (!(origin in graph)) return null;
      if (seen.has(origin)) continue;
      seen.add(origin);
      for (const edge of graph[origin]) {
        if (typeof edge === "string") pending.push(edge);
        else
          labels.add(
            JSON.stringify([origin, edge.source, edge.id, edge.severity, edge.range, edge.title]),
          );
      }
    }
    if (!labels.size) return null;
    result[name] = [...labels].sort();
  }
  return result;
}
test("v3 qualified oracle는 같은5의 B/C origin을 수기로 구별한다", () => {
  const before = { a: ["b"], b: [fixtureAdvisory], c: [fixtureAdvisory] };
  const after = { ...before, a: ["c"] };
  assert.deepEqual(fixtureOriginOracle(before).a, [
    JSON.stringify(["b", 900001, "GHSA-fixture-one", "high", "<2", "검증용 가상 권고"]),
  ]);
  assert.deepEqual(fixtureOriginOracle(after).a, [
    JSON.stringify(["c", 900001, "GHSA-fixture-one", "high", "<2", "검증용 가상 권고"]),
  ]);
  const f = identityFixture(before);
  f.audit = fixtureAudit(identityFixture(after).policy.packages);
  assert.throws(() => verifyFixture(f), /DEPENDENCY_TRIAGE_CHANGED/);
});
test("v3 generic graph 변이는 독립 qualified oracle와 같은 gate 결과다", () => {
  const graph = { a: ["b"], b: ["d"], c: [fixtureAdvisory], d: [fixtureAdvisory] };
  const expected = fixtureOriginOracle(graph);
  const names = Object.keys(graph);
  let seed = 17;
  for (let index = 0; index < 32; index++) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const from = names[seed % 4];
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const to = names[seed % 4];
    const changed = structuredClone(graph);
    if (index % 3 === 0) changed[from] = changed[from].filter((edge) => typeof edge !== "string");
    else changed[from].push(to);
    const f = identityFixture(graph);
    f.audit = fixtureAudit(identityFixture(changed).policy.packages);
    const actual = fixtureOriginOracle(changed);
    const shouldPass =
      actual !== null &&
      Object.values(changed).every((edges) => edges.length > 0) &&
      JSON.stringify(actual) === JSON.stringify(expected);
    let passed;
    try {
      verifyFixture(f);
      passed = true;
    } catch (error) {
      assert.match(error.message, /^DEPENDENCY_/);
      passed = false;
    }
    assert.equal(passed, shouldPass, "seeded case " + index);
  }
});
for (const [field, value] of [
  ["source", 900003],
  ["url", "https://github.com/advisories/GHSA-fixture-other"],
  ["severity", "moderate"],
  ["range", ">=2"],
  ["title", "SENSITIVE_CHANGED_TITLE"],
])
  test("v3 current direct5 " + field + " 변화는 정확 차단한다", () => {
    const f = identityFixture();
    f.audit.vulnerabilities.b.via[0][field] = value;
    let error;
    try {
      verifyFixture(f);
    } catch (caught) {
      error = caught;
    }
    assert.equal(error?.message, "DEPENDENCY_TRIAGE_CHANGED");
    assert.doesNotMatch(dependencyDiagnosticLines(error).join("\n"), /SENSITIVE_CHANGED_TITLE/);
  });
for (const [name, mutate] of [
  ["severity", (f) => (f.audit.vulnerabilities.b.severity = "critical")],
  [
    "version",
    (f) => {
      f.lock.packages["node_modules/b"].version = "2.0.0";
      bindFixture(f);
    },
  ],
  [
    "development",
    (f) => {
      f.lock.packages["node_modules/b"].dev = false;
      bindFixture(f);
    },
  ],
  ["node path", (f) => (f.audit.vulnerabilities.b.nodes = ["node_modules/c"])],
  ["node missing", (f) => (f.audit.vulnerabilities.b.nodes = ["node_modules/missing"])],
])
  test("v3 영향 " + name + "은 같은 leaf여도 실패한다", () => {
    const f = identityFixture();
    mutate(f);
    assert.throws(() => verifyFixture(f), /DEPENDENCY_/);
  });
for (const [name, mutate] of [
  ["P1", (f) => (f.policy.assessments[0].priority = "P1")],
  ["expired", (f) => (f.policy.assessments[0].reviewBy = "2000-01-01")],
  ["missing", (f) => f.policy.assessments.pop()],
  ["unknown root field", (f) => (f.policy.extra = true)],
  [
    "via branch union",
    (f) => (f.policy.packages.find((p) => p.name === "b").via[0].dependency = "a"),
  ],
  ["package empty range", (f) => (f.policy.packages[0].range = "")],
])
  test("v3 reference " + name + "을 동등성으로 우회하지 않는다", () => {
    const f = identityFixture();
    mutate(f);
    assert.throws(() => verifyFixture(f), /DEPENDENCY_/);
  });
