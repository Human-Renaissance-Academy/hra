/** audit 네트워크/형식 실패와 새 advisory·설치 경로·만료·P1의 차단을 검증한다. */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  dependencyDiagnosticLines,
  dependencySnapshot,
  lockRegistryViolations,
  verifyDependencyPolicy,
} from "../_lib/dependency-policy.mjs";
const policy = JSON.parse(
  readFileSync(new URL("../../security/dependency-triage.json", import.meta.url)),
);
const lock = JSON.parse(readFileSync(new URL("../../package-lock.json", import.meta.url)));
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
  assert.deepEqual(verifyDependencyPolicy(audit, lock, policy, "2026-11-17"), {
    affectedPackages: 28,
    advisoryEntries: 3,
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
    assert.throws(() => verifyDependencyPolicy(input, lock, policy, "2026-11-17"), /DEPENDENCY_/);
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
    assert.throws(() => verifyDependencyPolicy(audit, lock, input, "2026-11-17"), /DEPENDENCY_/);
  });
// 가장 이른 재검토 기한(2026-11-25) 다음 날부터는 실제 원장 전체가 만료로 차단된다.
test("검토 기한 만료 차단", () =>
  assert.throws(
    () => verifyDependencyPolicy(audit, lock, policy, "2026-11-26"),
    /DEPENDENCY_TRIAGE_INVALID/,
  ));
test("lock 설치 버전 변경 차단", () => {
  const input = structuredClone(lock);
  input.packages["node_modules/@esbuild-kit/core-utils/node_modules/esbuild"].version = "99.0.0";
  assert.throws(
    () => verifyDependencyPolicy(audit, input, policy, "2026-11-17"),
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
    verifyDependencyPolicy(inputAudit, inputLock, policy, "2026-11-17");
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
    verifyDependencyPolicy(audit, lock, input, "2026-11-17");
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
    () => verifyDependencyPolicy(input, lock, policy, "2026-11-17"),
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
    verifyDependencyPolicy(audit, lock, input, "2026-11-17");
  } catch (caught) {
    error = caught;
  }
  assert.equal(error?.message, "DEPENDENCY_TRIAGE_CHANGED");
  assert.deepEqual(dependencyDiagnosticLines(error), ["DEPENDENCY_TRIAGE_CHANGED"]);
});

test("v2 원장은 44개 명시 판단과 4개 공유 사용 맥락을 유지한다", () => {
  assert.equal(policy.schemaVersion, 2);
  assert.equal(policy.assessments.length, 44);
  assert.equal(policy.contexts.length, 4);
  assert.equal(new Set(policy.assessments.map((item) => item.contextId)).size, 4);
  assert.deepEqual(
    policy.contexts
      .map((context) => policy.assessments.filter((item) => item.contextId === context.id).length)
      .sort((a, b) => a - b),
    [3, 4, 13, 24],
  );
  assert.deepEqual(verifyDependencyPolicy(audit, lock, policy, "2026-11-17"), {
    affectedPackages: 28,
    advisoryEntries: 3,
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
    assert.throws(() => verifyDependencyPolicy(audit, lock, input, "2026-11-17"), /DEPENDENCY_/);
  });

test("구 schema v1은 새 검토 원장으로 자동 승인하지 않는다", () => {
  const input = structuredClone(policy);
  input.schemaVersion = 1;
  assert.throws(
    () => verifyDependencyPolicy(audit, lock, input, "2026-11-17"),
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
  assert.deepEqual(verifyDependencyPolicy(audit, lock, policy, "2026-11-17"), {
    affectedPackages: 28,
    advisoryEntries: 3,
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
  // tooling-minimatch-glob 평가만 검토일이 바뀌며 나머지는 2026-11-03 검토일을 유지한다.
  const reviewedOn = {
    "tooling-minimatch-glob": "2026-11-05",
  };
  // drizzle-kit 설치 노드만 추가 재검토했으며 제거된 eslint-config-next 항목은 복원하지 않는다.
  assert.ok(
    policy.assessments
      .filter((item) => item.contextId !== "tooling-picomatch-extglob")
      .every(
        (item) =>
          item.reviewedOn ===
          (item.key === "drizzle-kit:@esbuild-kit/esm-loader"
            ? "2026-11-06"
            : (reviewedOn[item.contextId] ?? "2026-11-03")),
      ),
  );
  // dev=false이거나 수정본이 있는데 적용되지 못한 사용면은 2주, dev=false CLI DoS는 3주, 개발 도구 전용은 4주다.
  const deadlines = {
    "shadcn-ts-morph-glob": "2026-11-26",
    "build-esbuild": "2026-12-03",
    "tooling-minimatch-glob": "2026-12-03",
    "tooling-picomatch-extglob": "2026-11-25",
  };
  assert.deepEqual(Object.keys(deadlines).sort(), policy.contexts.map((item) => item.id).sort());
  assert.ok(policy.assessments.every((item) => item.reviewBy === deadlines[item.contextId]));
  // 새 권고를 검토한 UTC 날짜에도 통과하고, 새 최단 기한 다음 날부터는 다시 차단한다.
  assert.deepEqual(verifyDependencyPolicy(audit, lock, policy, "2026-11-17"), {
    affectedPackages: 28,
    advisoryEntries: 3,
    p1: 0,
  });
  assert.deepEqual(verifyDependencyPolicy(audit, lock, policy, "2026-11-25"), {
    affectedPackages: 28,
    advisoryEntries: 3,
    p1: 0,
  });
  assert.throws(
    () => verifyDependencyPolicy(audit, lock, policy, "2026-11-26"),
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
  assert.deepEqual(
    policy.packages.filter((item) => item.name === "deepmerge"),
    [],
  );
  // registry는 철회된 deepmerge 대신 새 picomatch 전이 링크로 다시 보고됩니다.
  assert.deepEqual(policy.packages.find((item) => item.name === "@shadcn/registry").via, [
    { dependency: "@dotenvx/dotenvx" },
    { dependency: "fast-glob" },
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
  input.assessments[0].reviewBy = "2026-11-17";
  assert.deepEqual(verifyDependencyPolicy(audit, lock, input, "2026-11-17"), {
    affectedPackages: 28,
    advisoryEntries: 3,
    p1: 0,
  });
  assert.throws(
    () => verifyDependencyPolicy(audit, lock, input, "2026-11-18"),
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

test("Next ESLint의 새 picomatch 링크와 제거된 예전 링크를 구분한다", () => {
  assert.equal(lock.packages["node_modules/eslint-config-next"].version, "16.4.5");
  assert.deepEqual(policy.packages.find((item) => item.name === "eslint-config-next").via, [
    { dependency: "@next/eslint-plugin-next" },
  ]);
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
    () => verifyDependencyPolicy(input, lock, policy, "2026-11-17"),
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
    verifyDependencyPolicy(audit, input, policy, "2026-11-17");
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
const mobileResult = { affectedPackages: 82, advisoryEntries: 3, p1: 0 };

// npm의 상위 패키지 meta range는 새 upstream 릴리스만으로 바뀔 수 있다.
// 실제 위험 평가에 쓰는 severity, via의 advisory range/ID/source와 lock nodes의 정확 일치는 유지한다.
test("상위 패키지 파생 range만 바뀌면 통과하지만 실제 권고·등급·경로 변경은 차단한다", () => {
  const changedDerived = structuredClone(mobileAudit);
  changedDerived.vulnerabilities["@expo/cli"].range += " || 999.0.0";
  changedDerived.vulnerabilities["@expo/fingerprint"].range += " || 999.0.0";
  assert.deepEqual(
    verifyDependencyPolicy(changedDerived, mobileLock, mobilePolicy, "2026-11-17"),
    mobileResult,
  );

  const severityChanged = structuredClone(changedDerived);
  severityChanged.vulnerabilities["@expo/cli"].severity = "critical";
  assert.throws(
    () => verifyDependencyPolicy(severityChanged, mobileLock, mobilePolicy, "2026-11-17"),
    /DEPENDENCY_TRIAGE_CHANGED/,
  );

  const advisoryChanged = structuredClone(changedDerived);
  advisoryChanged.vulnerabilities.minimatch.via[0].range += " || 999.0.0";
  assert.throws(
    () => verifyDependencyPolicy(advisoryChanged, mobileLock, mobilePolicy, "2026-11-17"),
    /DEPENDENCY_TRIAGE_CHANGED/,
  );

  const linkChanged = structuredClone(changedDerived);
  linkChanged.vulnerabilities["@expo/cli"].via.push("previously-unreviewed-dependency");
  assert.throws(
    () => verifyDependencyPolicy(linkChanged, mobileLock, mobilePolicy, "2026-11-17"),
    /DEPENDENCY_TRIAGE_CHANGED/,
  );

  const versionChanged = structuredClone(mobileLock);
  versionChanged.packages["node_modules/@expo/cli"].version = "99.0.0";
  assert.throws(
    () => verifyDependencyPolicy(changedDerived, versionChanged, mobilePolicy, "2026-11-17"),
    /DEPENDENCY_TRIAGE_CHANGED/,
  );

  const invalidRange = structuredClone(mobilePolicy);
  invalidRange.packages.find((item) => item.name === "@expo/cli").range = "";
  assert.throws(
    () => verifyDependencyPolicy(mobileAudit, mobileLock, invalidRange, "2026-11-17"),
    /DEPENDENCY_TRIAGE_CHANGED/,
  );
});

test("모바일 원장은 lock 스냅샷과 정확히 일치하고 모든 resolved가 공식 registry다", () => {
  assert.deepEqual(dependencySnapshot(mobileAudit, mobileLock), mobilePolicy.packages);
  assert.deepEqual(lockRegistryViolations(mobileLock), []);
  assert.deepEqual(
    verifyDependencyPolicy(mobileAudit, mobileLock, mobilePolicy, "2026-11-17"),
    mobileResult,
  );
});

test("Expo 58 패치의 호환 버전과 Zod high audit 제거를 정확히 검증한다", () => {
  const app = JSON.parse(readFileSync(new URL("../../apps/mobile/package.json", import.meta.url)));
  for (const [name, version] of Object.entries({
    expo: "58.0.23",
    react: "19.3.0",
    "react-dom": "19.3.0",
    "react-native-safe-area-context": "5.11.1",
  })) {
    assert.equal(app.dependencies[name], version);
    assert.equal(mobileLock.packages[""].dependencies[name], version);
    assert.equal(mobileLock.packages["node_modules/" + name].version, version);
  }
  assert.equal(mobileLock.packages["node_modules/@expo/cli"].version, "58.1.19");
  assert.equal(mobilePolicy.packages.find((item) => item.name === "@expo/cli").severity, "high");
  assert.deepEqual(
    mobilePolicy.packages.filter((item) => item.name === "zod"),
    [],
  );
  // 새 high leaf의 존재는 이전 Zod 패치의 되돌림이 아니며 미검토 high는 별도 정확 집합 검사로 차단합니다.
  assert.equal(mobilePolicy.packages.find((item) => item.name === "picomatch").severity, "high");
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
  for (const path of ["node_modules/@expo/code-signing-certificates", "node_modules/@expo/cli"]) {
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
    () => verifyDependencyPolicy(changed, mobileLock, mobilePolicy, "2026-11-17"),
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
    [
      "@expo/cli",
      "@expo/config-plugins",
      "@expo/config",
      "@expo/fingerprint",
      "@expo/local-build-cache-provider",
      "@expo/metro-config",
      "@expo/metro",
      "babel-preset-expo",
      "expo-modules-core",
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

// Expo SDK 58.0.23은 zod high 경로를 npm audit에서 더 이상 보고하지 않는다. 남은 CLI·테스트 DoS는 3주, 개발 도구 전용은 4주 기한을 유지한다.
// 2026-11-05 minimatch 권고 범위 정정(>=7.0.0 <11.0.1, source 1244012 → 1244623)으로 다시 확인한 평가만 검토일을 옮기고 기한은 늘리지 않는다.
test("모바일 평가는 사용면 위험별 기한을 두고 가장 이른 기한 다음 날 차단한다", () => {
  const deadlines = {
    "expo-cli-config-glob": "2026-11-25",
    "jest-test-runner": "2026-11-25",
    "eslint-lint-tooling": "2026-12-02",
    "mobile-picomatch-host-tools": "2026-11-25",
  };
  const rechecked = (item) =>
    item.contextId === "eslint-lint-tooling" || item.key === "minimatch:1244623";
  const updatedSdk = new Set([
    "@expo/cli:glob",
    "@expo/fingerprint:glob",
    "@expo/fingerprint:minimatch",
    "expo:@expo/cli",
    "expo:@expo/fingerprint",
    "jest-expo:jest-watch-typeahead",
  ]);
  assert.deepEqual(
    mobilePolicy.contexts.map((item) => item.id).sort(),
    Object.keys(deadlines).sort(),
  );
  assert.equal(mobilePolicy.assessments.length, 223);
  assert.equal(
    mobilePolicy.assessments.filter((item) => item.contextId !== "mobile-picomatch-host-tools")
      .length,
    52,
  );
  assert.ok(
    mobilePolicy.assessments
      .filter((item) => item.contextId !== "mobile-picomatch-host-tools")
      .every(
        (item) =>
          item.reviewedOn ===
            (updatedSdk.has(item.key)
              ? "2026-11-08"
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
    verifyDependencyPolicy(mobileAudit, mobileLock, mobilePolicy, "2026-11-25"),
    mobileResult,
  );
  assert.throws(
    () => verifyDependencyPolicy(mobileAudit, mobileLock, mobilePolicy, "2026-11-26"),
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
test("중복 전이 링크는 평가 하나로 받되 링크 수 변경과 중복 평가는 계속 차단한다", () => {
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
    verifyDependencyPolicy(audited, mobileLock, recorded, "2026-11-17"),
    mobileResult,
  );
  assert.throws(
    () => verifyDependencyPolicy(mobileAudit, mobileLock, recorded, "2026-11-17"),
    /DEPENDENCY_TRIAGE_CHANGED/,
  );
  const extra = structuredClone(recorded);
  extra.assessments.push({ ...extra.assessments.find((item) => item.key === "test-exclude:glob") });
  assert.throws(
    () => verifyDependencyPolicy(audited, mobileLock, extra, "2026-11-17"),
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
    () => verifyDependencyPolicy(input, mobileLock, mobilePolicy, "2026-11-17"),
    /DEPENDENCY_TRIAGE_CHANGED/,
  );
  const lockInput = structuredClone(mobileLock);
  lockInput.packages["node_modules/expo"].resolved =
    "https://registry.npmjs.org.evil.example/expo/-/expo-58.0.23.tgz";
  assert.throws(
    () => verifyDependencyPolicy(mobileAudit, lockInput, mobilePolicy, "2026-11-17"),
    /DEPENDENCY_LOCK_REGISTRY_INVALID/,
  );
});

// 새 high 권고의 명시 검토는 기존 평가의 날짜·기한을 연장하지 않으며 P1 차단도 유지합니다.
test("picomatch 새 leaf와 호스트 도구 전이 평가를 정확히 검토한다", () => {
  for (const [current, response, currentLock, contextId, count, nodeCount] of [
    [policy, audit, lock, "tooling-picomatch-extglob", 24, 5],
    [mobilePolicy, mobileAudit, mobileLock, "mobile-picomatch-host-tools", 171, 26],
  ]) {
    const leaf = current.packages.find((item) => item.name === "picomatch");
    assert.deepEqual(leaf.via, [
      {
        source: 1247710,
        id: "GHSA-fc5q-39xc-vjpf",
        severity: "high",
        range: "<=4.0.7",
        title: "picomatch vulnerable to ReDoS through single-branch repeated extglobs",
      },
    ]);
    assert.equal(leaf.nodes.length, nodeCount);
    const added = current.assessments.filter((item) => item.contextId === contextId);
    assert.equal(added.length, count);
    assert.ok(
      added.every(
        (item) =>
          item.reviewedOn === "2026-11-17" &&
          item.reviewBy === "2026-11-25" &&
          item.priority === "P2" &&
          item.owner === "repo-maintainers",
      ),
    );
    const p1 = structuredClone(current);
    p1.assessments.find((item) => item.key === "picomatch:1247710").priority = "P1";
    assert.throws(
      () => verifyDependencyPolicy(response, currentLock, p1, "2026-11-17"),
      /DEPENDENCY_TRIAGE_INVALID/,
    );
  }
});

// 정확 집합에서 제외한 전이 링크가 다시 보고되면 자동 허용하지 않고 다시 차단합니다.
test("제외한 두 mobile meta 링크의 재등장은 정확 비교로 차단한다", () => {
  const included = structuredClone(mobileAudit);
  included.vulnerabilities["@react-native/community-cli-plugin"].via.push("metro");
  included.vulnerabilities["@react-native/metro-config"].via.push("metro-config");
  assert.throws(
    () => verifyDependencyPolicy(included, mobileLock, mobilePolicy, "2026-11-17"),
    /DEPENDENCY_TRIAGE_CHANGED/,
  );
});

// 진단만 늘리고 기존 exact 판정과20건 제한·민감값 비출력을 유지합니다.
for (const [label, mutate, category] of [
  [
    "via 중복",
    (a) => a.vulnerabilities.esbuild.via.push(a.vulnerabilities.esbuild.via[0]),
    "ARRAY_COUNT",
  ],
  ["package 순서", (a, p) => p.packages.reverse(), "ARRAY_ORDER"],
  [
    "node 키 순서",
    (a, p) => {
      const n = p.packages[0].nodes[0];
      p.packages[0].nodes[0] = Object.fromEntries(Object.entries(n).reverse());
    },
    "OBJECT_KEY_ORDER",
  ],
  ["원문 임의 키", (a, p) => (p.packages[0]["SENSITIVE_SENTINEL/secret"] = true), "OBJECT_KEYS"],
  [
    "원문 제목",
    (a) => (a.vulnerabilities.esbuild.via[0].title = "SENSITIVE_SENTINEL"),
    "VALUE_OR_TYPE",
  ],
])
  test(label + " literal 진단도 같은 실패를 유지한다", () => {
    const input = structuredClone(audit);
    const recorded = structuredClone(policy);
    mutate(input, recorded);
    let error;
    try {
      verifyDependencyPolicy(input, lock, recorded, "2026-11-17");
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
      verifyDependencyPolicy(audit, inputLock, recorded, "2026-11-17");
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
