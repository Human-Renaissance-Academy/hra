/** npm advisory의 정확한 집합과 lock 경로를 검토 원장과 대조한다. npm severity를 HRA P1로 자동 변환하지 않는다. */
import { createHash } from "node:crypto";
// 외부 오류 객체의 임의 필드는 출력하지 않고 이 모듈이 만든 진단만 전달합니다.
const literalDifference = Symbol("snapshot-literal-difference");
// 위치별 구조를 고정합니다. 값 자리는 객체여도 내부 키를 탐색하지 않습니다.
const snapshotStructure = {
  package: { name: "opaque", severity: "opaque", nodes: "nodes", via: "via" },
  node: { path: "opaque", version: "opaque", development: "opaque" },
  viaEntry: {
    dependency: "opaque",
    source: "opaque",
    id: "opaque",
    severity: "opaque",
    range: "opaque",
    title: "opaque",
  },
};
/** literal 순서·중복은 보존하고 닫힌 구조만 따라 최초 차이를 정제합니다. */
function snapshotDifference(expected, actual, fieldPath = "$", structure = "packages") {
  if (canonical(expected) === canonical(actual)) return null;
  const hash = (value) =>
    createHash("sha256")
      .update(canonical(value) ?? "undefined")
      .digest("hex");
  const detail = (category, before = expected, after = actual) => ({
    category,
    fieldPath,
    expectedHash: hash(before),
    actualHash: hash(after),
    ...(Array.isArray(before) && Array.isArray(after)
      ? { expectedCount: before.length, actualCount: after.length }
      : {}),
  });
  if (structure === "opaque") return detail("VALUE_OR_TYPE");
  const entry = { packages: "package", nodes: "node", via: "viaEntry" }[structure];
  if (entry) {
    if (!Array.isArray(expected) || !Array.isArray(actual)) return detail("VALUE_OR_TYPE");
    // bag 진단용 복사본만 정렬하며 원래 비교 배열·중복은 그대로 보존합니다.
    const before = expected.map(canonical).sort();
    const after = actual.map(canonical).sort();
    const duplicates = (items) =>
      items.reduce(
        (count, item, index) => count + Number(index > 0 && item === items[index - 1]),
        0,
      );
    if (expected.length !== actual.length)
      return {
        ...detail("ARRAY_COUNT"),
        expectedDuplicates: duplicates(before),
        actualDuplicates: duplicates(after),
      };
    if (canonical(before) === canonical(after)) return detail("ARRAY_ORDER");
    for (let index = 0; index < expected.length; index++) {
      const difference = snapshotDifference(
        expected[index],
        actual[index],
        `${fieldPath}[${index}]`,
        entry,
      );
      if (difference) return difference;
    }
  } else if (
    expected &&
    actual &&
    typeof expected === "object" &&
    typeof actual === "object" &&
    !Array.isArray(expected) &&
    !Array.isArray(actual)
  ) {
    const fields = snapshotStructure[structure];
    const before = Object.keys(expected);
    const after = Object.keys(actual);
    if (!fields || [...before, ...after].some((key) => !Object.hasOwn(fields, key)))
      return detail("OBJECT_KEYS", before, after);
    if (canonical(before) !== canonical(after))
      return detail(
        before.length === after.length && before.every((key) => after.includes(key))
          ? "OBJECT_KEY_ORDER"
          : "OBJECT_KEYS",
        before,
        after,
      );
    // 승인된 컨테이너 키만 구조 경로로 쓰고 모든 스칼라 위치는 opaque로 넘깁니다.
    for (const key of before) {
      const difference = snapshotDifference(
        expected[key],
        actual[key],
        `${fieldPath}.${key}`,
        fields[key],
      );
      if (difference) return difference;
    }
  }
  return detail("VALUE_OR_TYPE");
}
const severities = new Set(["low", "moderate", "high", "critical"]);
const canonical = (value) => JSON.stringify(value);
const safeLabel = (value) =>
  typeof value === "string" && /^[A-Za-z0-9@/._-]{1,240}$/.test(value) ? value : "[redacted]";
// 달력에 존재하지 않는 날짜를 기한으로 사용해 만료 검사를 우회하지 못하게 한다.
const validDate = (value) =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(value)) &&
  new Date(value).toISOString().slice(0, 10) === value;
/** nodes와 advisory는 독립 집합이다. 둘을 곱해 확인되지 않은 설치 경로를 만들지 않는다. */
export function dependencySnapshot(audit, lock) {
  if (
    !audit ||
    audit.auditReportVersion !== 2 ||
    audit.error ||
    !audit.vulnerabilities ||
    typeof audit.vulnerabilities !== "object" ||
    Array.isArray(audit.vulnerabilities) ||
    !lock?.packages
  )
    throw new Error("DEPENDENCY_REPORT_INVALID");
  return Object.entries(audit.vulnerabilities)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, item]) => {
      if (
        item.name !== name ||
        !severities.has(item.severity) ||
        typeof item.range !== "string" ||
        !Array.isArray(item.nodes) ||
        !item.nodes.length ||
        !Array.isArray(item.via) ||
        !item.via.length
      )
        throw new Error("DEPENDENCY_REPORT_INVALID");
      const nodes = item.nodes
        .map((path) => {
          if (
            typeof path !== "string" ||
            !path.startsWith("node_modules/") ||
            !lock.packages[path]?.version
          )
            throw new Error("DEPENDENCY_LOCK_MISMATCH");
          return {
            path,
            version: lock.packages[path].version,
            development: lock.packages[path].dev === true,
          };
        })
        .sort((a, b) => a.path.localeCompare(b.path));
      const via = item.via
        .map((advisory) => {
          if (typeof advisory === "string" && advisory) return { dependency: advisory };
          if (
            !advisory ||
            !Number.isSafeInteger(advisory.source) ||
            !/^https:\/\/github\.com\/advisories\/GHSA-[a-z0-9-]+$/.test(advisory.url) ||
            !severities.has(advisory.severity) ||
            typeof advisory.range !== "string" ||
            typeof advisory.title !== "string"
          )
            throw new Error("DEPENDENCY_REPORT_INVALID");
          return {
            source: advisory.source,
            id: advisory.url.split("/").at(-1),
            severity: advisory.severity,
            range: advisory.range,
            title: advisory.title,
          };
        })
        .sort((a, b) => canonical(a).localeCompare(canonical(b)));
      return { name, severity: item.severity, range: item.range, nodes, via };
    });
}
// 원장 변화 유형 요약은 오류 객체의 외부 필드가 아니라 이 모듈이 만든 값만 출력합니다.
const driftSummary = Symbol("dependency-drift-summary");
// 변화 유형은 진단 전용이며 어떤 유형도 게이트를 통과시키지 않습니다.
const driftKinds = new Set(["removal-only", "metadata-only", "additions-present", "unclassified"]);
const severityRank = { low: 1, moderate: 2, high: 3, critical: 4 };
// 알 수 없는 등급은 상승으로 간주해 검토 필요 쪽으로 분류합니다.
const severityRaised = (before, after) =>
  !severityRank[before] || !severityRank[after] || severityRank[after] > severityRank[before];
/**
 * 실제 audit 스냅샷과 원장 packages의 모든 차이를 수집하고 변화 유형을 분류합니다.
 * - additions-present: 새 패키지·설치 경로·권고·전이 링크, 등급 상승, 설치본 metadata 변화 또는 설명할 수 없는 차이
 * - removal-only: 원장에만 남은 항목이 있고 나머지는 등급 하락·권고 range/title 변화뿐인 경우(상위 철회·정정의 전형)
 * - metadata-only: 추가·제거 없이 등급 하락·권고 range/title 변화만 있는 경우
 * - unclassified: 원장 구조가 손상돼 비교할 수 없는 경우
 * 분류는 사람이 검토할 진단일 뿐이며 차단 여부를 바꾸지 않습니다.
 */
export function classifyDependencyDrift(snapshot, recorded) {
  if (
    !Array.isArray(snapshot) ||
    !Array.isArray(recorded) ||
    !recorded.every(
      (pkg) =>
        pkg &&
        typeof pkg.name === "string" &&
        Array.isArray(pkg.nodes) &&
        pkg.nodes.every((node) => node && typeof node.path === "string") &&
        Array.isArray(pkg.via) &&
        pkg.via.every(
          (via) => via && (typeof via.id === "string" || typeof via.dependency === "string"),
        ),
    )
  )
    return { kind: "unclassified", changes: [], removedAdvisories: [] };
  const changes = [];
  let escalated = false;
  const add = (kind, packageName, fields = {}) =>
    changes.push({ kind, package: safeLabel(packageName), ...fields });
  const actualPackages = new Map(snapshot.map((pkg) => [pkg.name, pkg]));
  const recordedPackages = new Map(recorded.map((pkg) => [pkg.name, pkg]));
  for (const name of new Set([...actualPackages.keys(), ...recordedPackages.keys()])) {
    const actual = actualPackages.get(name);
    const expected = recordedPackages.get(name);
    if (!actual || !expected) {
      add(actual ? "PACKAGE_ONLY_IN_AUDIT" : "PACKAGE_ONLY_IN_POLICY", name);
      continue;
    }
    if (actual.severity !== expected.severity) {
      add("PACKAGE_METADATA_CHANGED", name);
      if (severityRaised(expected.severity, actual.severity)) escalated = true;
    }
    const actualNodes = new Map(actual.nodes.map((node) => [node.path, node]));
    const recordedNodes = new Map(expected.nodes.map((node) => [node.path, node]));
    for (const path of new Set([...actualNodes.keys(), ...recordedNodes.keys()])) {
      const current = actualNodes.get(path);
      const previous = recordedNodes.get(path);
      if (!current || !previous)
        add(current ? "NODE_ONLY_IN_AUDIT" : "NODE_ONLY_IN_POLICY", name, {
          path: safeLabel(path),
        });
      else if (canonical(current) !== canonical(previous))
        add("NODE_METADATA_CHANGED", name, { path: safeLabel(path) });
    }
    const key = (via) =>
      via.id ? `advisory:${via.source}:${via.id}` : `dependency:${via.dependency}`;
    const actualVia = new Map(actual.via.map((via) => [key(via), via]));
    const recordedVia = new Map(expected.via.map((via) => [key(via), via]));
    for (const viaKey of new Set([...actualVia.keys(), ...recordedVia.keys()])) {
      const current = actualVia.get(viaKey);
      const previous = recordedVia.get(viaKey);
      const item = current ?? previous;
      const fields = item.id
        ? {
            id: safeLabel(item.id),
            ...(Number.isSafeInteger(item.source) && item.source >= 0
              ? { source: item.source }
              : {}),
          }
        : { dependency: safeLabel(item.dependency) };
      const prefix = item.id ? "ADVISORY" : "DEPENDENCY";
      if (!current || !previous)
        add(`${prefix}_ONLY_IN_${current ? "AUDIT" : "POLICY"}`, name, fields);
      else if (canonical(current) !== canonical(previous)) {
        add(`${prefix}_METADATA_CHANGED`, name, fields);
        if (!item.id || severityRaised(previous.severity, current.severity)) escalated = true;
      }
    }
  }
  // 배열 순서·중복처럼 위의 키 비교로 포착되지 않은 차이도 조용히 지나가지 않는다.
  if (!changes.length) changes.push({ kind: "SNAPSHOT_CHANGED" });
  changes.sort((a, b) => canonical(a).localeCompare(canonical(b)));
  // 설치본 metadata(NODE_METADATA_CHANGED)와 설명 불가 차이는 새 위험일 수 있으므로 추가로 분류합니다.
  const additions =
    escalated ||
    changes.some(
      (change) =>
        change.kind.endsWith("_ONLY_IN_AUDIT") ||
        ["NODE_METADATA_CHANGED", "SNAPSHOT_CHANGED"].includes(change.kind),
    );
  const removals = changes.some((change) => change.kind.endsWith("_ONLY_IN_POLICY"));
  // 원장에는 있으나 audit 전체 어디에도 없는 GHSA는 철회·정정 후보로만 표시합니다(단정하지 않음).
  const auditIds = new Set(snapshot.flatMap((pkg) => pkg.via.map((via) => via.id)));
  const removedAdvisories = [
    ...new Set(
      recorded.flatMap((pkg) =>
        pkg.via
          .map((via) => via.id)
          .filter((id) => typeof id === "string" && /^GHSA-[a-z0-9-]+$/.test(id)),
      ),
    ),
  ]
    .filter((id) => !auditIds.has(id))
    .sort(codeUnitOrder);
  return {
    kind: additions ? "additions-present" : removals ? "removal-only" : "metadata-only",
    changes,
    removedAdvisories,
  };
}
/** 불일치 진단에는 패키지·권고 ID·설치 경로만 넣고 감사 원문/영향 범위/버전은 출력하지 않는다. */
function dependencyChanges(drift) {
  const changes = drift.changes;
  return changes.length > 20
    ? [...changes.slice(0, 20), { kind: "MORE_CHANGES", count: changes.length - 20 }]
    : changes;
}

/** CLI는 정제한 코드와 진단만 기록한다. 네트워크 오류·감사 원문은 로그에 남기지 않는다. */
export function dependencyDiagnosticLines(error) {
  if (!(error instanceof Error) || !/^DEPENDENCY_[A-Z_]+$/.test(error.message))
    return ["DEPENDENCY_CHECK_FAILED"];
  const lines = [error.message];
  if (
    ["DEPENDENCY_TRIAGE_CHANGED", "DEPENDENCY_LOCK_REGISTRY_INVALID"].includes(error.message) &&
    Array.isArray(error.diagnostics)
  ) {
    for (const [index, item] of error.diagnostics.entries()) {
      const detail = index === 0 ? error[literalDifference] : undefined;
      lines.push(
        `DEPENDENCY_CHANGE ${canonical(detail ? { ...item, literalDiff: detail } : item)}`,
      );
    }
  }
  // 변화 유형 요약은 진단 전용입니다. removal-only여도 종료 코드는 실패로 유지됩니다.
  const drift = error.message === "DEPENDENCY_TRIAGE_CHANGED" ? error[driftSummary] : undefined;
  if (drift && driftKinds.has(drift.kind)) {
    lines.push(`DEPENDENCY_DRIFT_KIND ${drift.kind}`);
    const ids = drift.removedAdvisories.filter((id) => /^GHSA-[a-z0-9-]+$/.test(id));
    if (ids.length) lines.push(`DEPENDENCY_DRIFT_REMOVED_ADVISORIES ${ids.join(",")}`);
  }
  return lines;
}
// 공유 사용 맥락과 권고별 판단은 닫힌 필드 집합으로 검증해 예전 중복 필드나 미검토 설명을 허용하지 않는다.
const contextFields = ["usedApi", "callLocations", "assessment", "residualAssumptions"];
const contextKeys = ["assessment", "callLocations", "id", "residualAssumptions", "usedApi"].join(
  ",",
);
const assessmentKeys = [
  "attackCondition",
  "contextId",
  "key",
  "owner",
  "priority",
  "reviewBy",
  "reviewedOn",
].join(",");
/** 모든 lock `resolved`가 공식 npm registry를 가리키는지 확인한다(워크스페이스 link 제외). 외부 피드 주소는 출력하지 않고 설치 경로만 진단한다(#432). */
export function lockRegistryViolations(lock) {
  if (!lock?.packages || typeof lock.packages !== "object")
    throw new Error("DEPENDENCY_REPORT_INVALID");
  return Object.entries(lock.packages)
    .filter(
      ([, pkg]) =>
        pkg &&
        pkg.link !== true &&
        pkg.resolved !== undefined &&
        !(
          typeof pkg.resolved === "string" && pkg.resolved.startsWith("https://registry.npmjs.org/")
        ),
    )
    .map(([path]) => ({ kind: "RESOLVED_NOT_OFFICIAL_REGISTRY", path: safeLabel(path) }))
    .sort((a, b) => a.path.localeCompare(b.path));
}
// v3의 고정 container만 검사하며 opaque 값의 내부 키를 투영하지 않습니다.
const hasFields = (value, fields) =>
  value &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.keys(value).length === fields.length &&
  fields.every((field) => Object.hasOwn(value, field));
const codeUnitOrder = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
/** 검토된 전체 manifest/lock bytes만 authoritative 입력으로 해석합니다. */
function reviewedLock(input, policy) {
  if (
    !hasFields(policy, [
      "schemaVersion",
      "note",
      "identityMode",
      "manifestBinding",
      "lockBinding",
      "packages",
      "contexts",
      "assessments",
    ]) ||
    policy.schemaVersion !== 3 ||
    policy.identityMode !== "reviewed-input-origin-leaf-v1" ||
    typeof policy.note !== "string" ||
    ![policy.packages, policy.contexts, policy.assessments].every(Array.isArray)
  )
    throw new Error("DEPENDENCY_TRIAGE_CHANGED");
  if (!hasFields(input, ["manifestBytes", "lockBytes"]))
    throw new Error("DEPENDENCY_INPUT_BINDING_INVALID");
  for (const [field, tag, binding] of [
    ["manifestBytes", "package-json.raw-bytes-v1", policy.manifestBinding],
    ["lockBytes", "package-lock.raw-bytes-v1", policy.lockBinding],
  ]) {
    if (
      !Buffer.isBuffer(input[field]) ||
      !hasFields(binding, ["algorithm", "input", "digest"]) ||
      binding.algorithm !== "sha256" ||
      binding.input !== tag ||
      !/^[a-f0-9]{64}$/.test(binding.digest) ||
      sha256(input[field]) !== binding.digest
    )
      throw new Error("DEPENDENCY_INPUT_BINDING_INVALID");
  }
  let manifest;
  let lock;
  try {
    manifest = JSON.parse(input.manifestBytes.toString("utf8"));
    lock = JSON.parse(input.lockBytes.toString("utf8"));
  } catch {
    throw new Error("DEPENDENCY_REPORT_INVALID");
  }
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    !lock ||
    typeof lock !== "object" ||
    Array.isArray(lock) ||
    !lock.packages ||
    typeof lock.packages !== "object" ||
    Array.isArray(lock.packages)
  )
    throw new Error("DEPENDENCY_REPORT_INVALID");
  return lock;
}
/** unknown reference field는 constructor 전에 실패시키고 node/direct copy 수는 보존합니다. */
function securityView(packages) {
  if (!Array.isArray(packages)) return null;
  const graph = new Map();
  const identities = [];
  for (const pkg of packages) {
    if (
      !hasFields(pkg, ["name", "severity", "range", "nodes", "via"]) ||
      typeof pkg.name !== "string" ||
      !pkg.name ||
      graph.has(pkg.name) ||
      !severities.has(pkg.severity) ||
      typeof pkg.range !== "string" ||
      !pkg.range.trim() ||
      !Array.isArray(pkg.nodes) ||
      !pkg.nodes.length ||
      !Array.isArray(pkg.via) ||
      !pkg.via.length
    )
      return null;
    const nodes = [];
    const nodeValues = new Map();
    const direct = [];
    const advisoryValues = new Map();
    const targets = new Set();
    for (const node of pkg.nodes) {
      if (
        !hasFields(node, ["path", "version", "development"]) ||
        typeof node.path !== "string" ||
        !node.path.startsWith("node_modules/") ||
        !node.version ||
        typeof node.development !== "boolean"
      )
        return null;
      const value = { path: node.path, version: node.version, development: node.development };
      const bytes = canonical(value);
      if (nodeValues.has(node.path) && nodeValues.get(node.path) !== bytes) return null;
      nodeValues.set(node.path, bytes);
      nodes.push(value);
    }
    for (const via of pkg.via) {
      if (hasFields(via, ["dependency"]) && typeof via.dependency === "string" && via.dependency) {
        targets.add(via.dependency);
        continue;
      }
      if (
        !hasFields(via, ["source", "id", "severity", "range", "title"]) ||
        !Number.isSafeInteger(via.source) ||
        typeof via.id !== "string" ||
        !/^GHSA-[a-z0-9-]+$/.test(via.id) ||
        !severities.has(via.severity) ||
        typeof via.range !== "string" ||
        typeof via.title !== "string"
      )
        return null;
      const value = {
        source: via.source,
        id: via.id,
        severity: via.severity,
        range: via.range,
        title: via.title,
      };
      const key = canonical([via.source, via.id]);
      const bytes = canonical(value);
      if (advisoryValues.has(key) && advisoryValues.get(key) !== bytes) return null;
      advisoryValues.set(key, bytes);
      direct.push(value);
    }
    nodes.sort((a, b) => codeUnitOrder(a.path, b.path));
    direct.sort((a, b) => codeUnitOrder(canonical(a), canonical(b)));
    identities.push({ name: pkg.name, severity: pkg.severity, nodes, direct });
    // origin은 raw advisory.name이 아니라 direct 객체를 소유한 보고 package입니다.
    graph.set(pkg.name, {
      targets,
      labels: direct.map((value) => canonical({ originPackage: pkg.name, ...value })),
    });
  }
  for (const value of graph.values())
    for (const target of value.targets) if (!graph.has(target)) return null;
  identities.sort((a, b) => codeUnitOrder(a.name, b.name));
  return { identities, graph };
}
/** identity exact 검사 뒤에만 origin-qualified 최소 도달 집합을 계산합니다. */
function qualifiedClosures(view) {
  const closures = [];
  for (const { name } of view.identities) {
    const pending = [name];
    const visited = new Set();
    const labels = new Set();
    while (pending.length) {
      const current = pending.pop();
      if (visited.has(current)) continue;
      visited.add(current);
      const vertex = view.graph.get(current);
      for (const label of vertex.labels) labels.add(label);
      for (const target of vertex.targets) pending.push(target);
    }
    if (!labels.size) return null;
    closures.push({ name, labels: [...labels].sort(codeUnitOrder) });
  }
  return closures;
}
/** 변경/누락/만료/미분류/P1은 차단한다. 공유 맥락은 검토 책임과 위험 수용 권한을 대체하지 않는다. */
export function verifyDependencyPolicy(
  audit,
  input,
  policy,
  today = new Date().toISOString().slice(0, 10),
) {
  const lock = reviewedLock(input, policy);
  const registryViolations = lockRegistryViolations(lock);
  if (registryViolations.length) {
    const error = new Error("DEPENDENCY_LOCK_REGISTRY_INVALID");
    error.diagnostics = registryViolations.slice(0, 20);
    throw error;
  }
  const snapshot = dependencySnapshot(audit, lock);
  // npm의 metavulnerability 분석이 만든 상위 패키지 range는 registry의 새 배포만으로 바뀔 수 있다.
  // v3는 고정된 검토 입력과 영향 node/severity/direct5를 정확 비교하고 meta 경로는 qualified 도달성을 확인한다.
  // direct advisory range는 그대로 보호하며 package range의 누락·손상도 허용하지 않는다.
  const stableSnapshot = (packages) =>
    packages.map((pkg) => {
      if (!pkg || typeof pkg.range !== "string" || !pkg.range.trim())
        throw new Error("DEPENDENCY_TRIAGE_CHANGED");
      const securityIdentity = { ...pkg };
      delete securityIdentity.range;
      return securityIdentity;
    });
  const actual = securityView(snapshot);
  const reference = securityView(policy.packages);
  const identitiesEqual =
    actual && reference && canonical(actual.identities) === canonical(reference.identities);
  const actualClosure = identitiesEqual ? qualifiedClosures(actual) : null;
  const referenceClosure = identitiesEqual ? qualifiedClosures(reference) : null;
  if (
    !identitiesEqual ||
    !actualClosure ||
    !referenceClosure ||
    canonical(actualClosure) !== canonical(referenceClosure)
  ) {
    const error = new Error("DEPENDENCY_TRIAGE_CHANGED");
    const drift = classifyDependencyDrift(snapshot, policy.packages);
    error.diagnostics = drift.kind === "unclassified" ? [] : dependencyChanges(drift);
    error[driftSummary] = drift;
    error[literalDifference] = snapshotDifference(
      stableSnapshot(policy.packages),
      stableSnapshot(snapshot),
    );
    throw error;
  }
  const contexts = new Map();
  const contextTexts = new Set();
  for (const item of policy.contexts) {
    if (
      !item ||
      Object.keys(item).sort().join(",") !== contextKeys ||
      typeof item.id !== "string" ||
      !/^[a-z][a-z0-9-]{1,50}$/.test(item.id) ||
      contexts.has(item.id) ||
      contextFields.some(
        (field) => typeof item[field] !== "string" || item[field].trim().length < 15,
      )
    )
      throw new Error("DEPENDENCY_TRIAGE_INVALID");
    const text = canonical(contextFields.map((field) => item[field]));
    if (contextTexts.has(text)) throw new Error("DEPENDENCY_TRIAGE_INVALID");
    contextTexts.add(text);
    contexts.set(item.id, item);
  }
  // 한 패키지가 버전이 다른 같은 이름의 전이 패키지를 여러 경로에 두면 npm은 같은 `dependency` 링크를 중복해 보고한다.
  // reviewed 입력·identity·qualified closure를 검증한 뒤 reference graph의 평가 키만 요구한다.
  // advisory 키는 source 번호를 포함하므로 서로 다른 권고가 합쳐지지 않는다.
  const required = [
    ...new Set(
      policy.packages.flatMap((pkg) =>
        pkg.via.map((via) => `${pkg.name}:${via.source ?? via.dependency}`),
      ),
    ),
  ];
  if (policy.assessments.some((item) => !item || typeof item.key !== "string"))
    throw new Error("DEPENDENCY_TRIAGE_MISSING");
  if (
    policy.assessments.length !== required.length ||
    new Set(policy.assessments.map((item) => item.key)).size !== required.length
  )
    throw new Error("DEPENDENCY_TRIAGE_MISSING");
  const usedContexts = new Set();
  for (const key of required) {
    const item = policy.assessments.find((entry) => entry.key === key);
    if (
      !item ||
      Object.keys(item).sort().join(",") !== assessmentKeys ||
      item.priority !== "P2" ||
      item.owner !== "repo-maintainers" ||
      !validDate(item.reviewedOn) ||
      !validDate(item.reviewBy) ||
      !validDate(today) ||
      item.reviewedOn > today ||
      item.reviewBy < today ||
      item.reviewedOn > item.reviewBy ||
      typeof item.attackCondition !== "string" ||
      item.attackCondition.trim().length < 15 ||
      !contexts.has(item.contextId)
    )
      throw new Error("DEPENDENCY_TRIAGE_INVALID");
    usedContexts.add(item.contextId);
  }
  if (usedContexts.size !== contexts.size) throw new Error("DEPENDENCY_TRIAGE_INVALID");
  return {
    affectedPackages: snapshot.length,
    advisoryEntries: snapshot.reduce(
      (sum, item) => sum + item.via.filter((via) => via.source).length,
      0,
    ),
    p1: 0,
  };
}
/**
 * 상위 권고 철회·정정 뒤의 수동 원장 재생성 절차(#540·#545 선례)를 재현합니다.
 * - 검토된 manifest/lock binding이 현재 bytes와 다르면 거부합니다. lock 변경은 일반 의존성 검토 대상입니다.
 * - packages는 fresh audit의 dependencySnapshot으로 다시 만들고, 사라진 key의 평가와 참조가 끊긴 맥락만 제거합니다.
 * - 새 패키지·경로·권고·링크, 등급 상승처럼 새 평가가 필요한 변화는 평가를 만들지 않고 거부합니다(P1 자동 수용 없음).
 * - 유지되는 평가·맥락 객체와 binding·note는 그대로 복사하므로 reviewedOn/reviewBy/판단 문구가 바뀌지 않습니다.
 * - 결과는 verifyDependencyPolicy를 같은 audit·입력·날짜로 통과해야 하며 만료 평가는 연장하지 않고 실패합니다.
 */
export function regenerateDependencyPolicy(
  audit,
  input,
  policy,
  today = new Date().toISOString().slice(0, 10),
) {
  const refuse = (code, items = []) => {
    const error = new Error(code);
    error.items = items;
    throw error;
  };
  // 평가 key(`package:source|dependency`)는 구분자 앞뒤를 각각 정제해 출력합니다.
  const safeKey = (key) =>
    typeof key === "string" && key.includes(":")
      ? `${safeLabel(key.slice(0, key.lastIndexOf(":")))}:${safeLabel(key.slice(key.lastIndexOf(":") + 1))}`
      : safeLabel(key);
  if (
    !policy ||
    typeof policy !== "object" ||
    ![policy.packages, policy.assessments, policy.contexts].every(Array.isArray) ||
    !policy.packages.every((pkg) => pkg && typeof pkg === "object" && !Array.isArray(pkg)) ||
    !hasFields(input, ["manifestBytes", "lockBytes"]) ||
    !Buffer.isBuffer(input.manifestBytes) ||
    !Buffer.isBuffer(input.lockBytes)
  )
    refuse("DEPENDENCY_REGENERATE_INPUT_INVALID");
  // binding 자동 갱신은 하지 않습니다. 선례도 binding을 바꾸지 않았고 lock 변경은 일반 의존성 검토 대상입니다.
  if (
    policy.manifestBinding?.digest !== sha256(input.manifestBytes) ||
    policy.lockBinding?.digest !== sha256(input.lockBytes)
  )
    refuse("DEPENDENCY_REGENERATE_BINDING_CHANGED");
  let lock;
  try {
    lock = JSON.parse(input.lockBytes.toString("utf8"));
  } catch {
    refuse("DEPENDENCY_REPORT_INVALID");
  }
  const snapshot = dependencySnapshot(audit, lock);
  // 게이트가 허용하는 상위 패키지 파생 range 차이는 변화 분류에서 제외합니다.
  const withoutRange = (packages) =>
    packages.map((pkg) => {
      const copy = { ...pkg };
      delete copy.range;
      return copy;
    });
  const identical = canonical(snapshot) === canonical(policy.packages);
  const rangeOnly =
    !identical && canonical(withoutRange(snapshot)) === canonical(withoutRange(policy.packages));
  const drift =
    identical || rangeOnly
      ? { kind: identical ? "none" : "package-range-only", changes: [], removedAdvisories: [] }
      : classifyDependencyDrift(snapshot, policy.packages);
  // 추가·상승이 하나라도 있으면 제거 항목까지 포함해 아무것도 반영하지 않습니다.
  if (drift.kind === "additions-present" || drift.kind === "unclassified") {
    const reviewable = (change) =>
      change.kind.endsWith("_ONLY_IN_POLICY") ||
      ["PACKAGE_METADATA_CHANGED", "ADVISORY_METADATA_CHANGED"].includes(change.kind);
    const blocking = drift.changes.filter((change) => !reviewable(change));
    refuse("DEPENDENCY_REGENERATE_REVIEW_REQUIRED", blocking.length ? blocking : drift.changes);
  }
  // 평가 key 규칙은 verifyDependencyPolicy의 required 계산과 같습니다.
  const required = new Set(
    snapshot.flatMap((pkg) => pkg.via.map((via) => `${pkg.name}:${via.source ?? via.dependency}`)),
  );
  const existingKeys = new Set(policy.assessments.map((item) => item?.key));
  const missing = [...required].filter((key) => !existingKeys.has(key)).sort(codeUnitOrder);
  if (missing.length)
    refuse(
      "DEPENDENCY_REGENERATE_REVIEW_REQUIRED",
      missing.map((key) => ({ kind: "ASSESSMENT_REQUIRED", key: safeKey(key) })),
    );
  // 원장 최상위 필드 순서와 유지 항목의 필드·값을 그대로 두고 세 배열만 교체합니다.
  const next = structuredClone(policy);
  next.packages = snapshot;
  next.assessments = structuredClone(policy.assessments.filter((item) => required.has(item?.key)));
  const usedContexts = new Set(next.assessments.map((item) => item.contextId));
  next.contexts = structuredClone(policy.contexts.filter((item) => usedContexts.has(item?.id)));
  // 재생성 결과도 게이트와 같은 검증을 통과해야 합니다. 만료·P1·미분류는 여기서 그대로 실패합니다.
  const result = verifyDependencyPolicy(audit, input, next, today);
  const nextKeys = new Set(next.assessments.map((item) => item.key));
  const nextContexts = new Set(next.contexts.map((item) => item.id));
  return {
    policy: next,
    changed: canonical(next) !== canonical(policy),
    summary: {
      driftKind: drift.kind,
      packages: [policy.packages.length, next.packages.length],
      assessments: [policy.assessments.length, next.assessments.length],
      contexts: [policy.contexts.length, next.contexts.length],
      affectedPackages: result.affectedPackages,
      advisoryEntries: result.advisoryEntries,
      removedAdvisories: drift.removedAdvisories,
      removedAssessments: policy.assessments
        .map((item) => item.key)
        .filter((key) => !nextKeys.has(key))
        .map(safeKey),
      removedContexts: policy.contexts
        .map((item) => item.id)
        .filter((id) => !nextContexts.has(id))
        .map(safeLabel),
      changes: drift.changes,
    },
  };
}
