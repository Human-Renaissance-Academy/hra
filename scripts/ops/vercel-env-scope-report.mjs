/**
 * Vercel 프로젝트 환경변수의 적용 대상(scope)만 분석하는 읽기 전용 보고서 (#279).
 *
 * 역할:
 *   - 운영자가 자신의 Vercel 토큰으로 받은 프로젝트 환경변수 목록 JSON을 stdin 으로 넘기면,
 *     이름·적용 대상·저장 유형만 남겨 "Production 비밀값이 Preview/Development 와 공유되는지"를 판정한다.
 *   - 이 스크립트는 네트워크에 접속하지 않고 환경변수도 읽지 않는다. 입력의 value 계열 필드는 즉시 버린다.
 *
 * 판정 기준(정본: scripts/_lib/environment-inventory.mjs 의 secret 메타데이터, docs/developer/environment-strategy.md):
 *   - SHARED_SECRET_ACROSS_TARGETS (실패): 비밀값 하나가 production 과 preview/development 를 함께 대상으로 한다.
 *     같은 값이 비운영에 노출된다는 뜻이다.
 *   - NONPROD_SECRET_PRESENT (검토): 비운영 전용 항목이 따로 있다. 격리 테스트 자원인지 운영자가 확인한다.
 *   - SECRET_NOT_ENCRYPTED (검토): 비밀값이 plain 유형으로 저장됐다.
 *   - UNKNOWN_KEY (검토): 저장소 환경 계약에 없는 이름이다.
 *
 * 출력: stdout 에 JSON 한 개(이름·대상·개수·고정 코드). 종료 코드 0=실패 항목 없음, 1=실패 항목 있음, 2=입력 오류.
 */
import { pathToFileURL } from "node:url";
import { environmentInventory } from "../_lib/environment-inventory.mjs";

const TARGETS = ["production", "preview", "development"];
const TYPES = ["encrypted", "sensitive", "secret", "plain", "system"];
const KEY = /^[A-Z][A-Z0-9_]{0,99}$/;

/** 비운영 공유가 금지된 비밀값 이름. 플랫폼·QA·도구 범주는 Vercel 설정 대상이 아니므로 제외한다. */
export const secretNames = new Set(
  environmentInventory.variables
    .filter(
      (entry) =>
        entry.secret && ["application", "sdk", "legacy", "operator"].includes(entry.category),
    )
    .map((entry) => entry.name),
);
export const knownNames = new Set(environmentInventory.variables.map((entry) => entry.name));

/** Vercel 응답(`{ envs: [...] }`) 또는 배열을 받아 이름·대상·유형만 남긴다. value 는 읽지 않는다. */
export function analyzeEnvironmentScopes(input) {
  const envs = Array.isArray(input) ? input : Array.isArray(input?.envs) ? input.envs : null;
  if (!envs) return { ok: false, code: "INPUT_SHAPE" };
  const keys = new Map();
  let invalidKeys = 0;
  for (const entry of envs) {
    const key = typeof entry?.key === "string" ? entry.key : "";
    if (!KEY.test(key)) {
      invalidKeys += 1;
      continue;
    }
    const targets = (Array.isArray(entry.target) ? entry.target : [entry.target]).filter((target) =>
      TARGETS.includes(target),
    );
    const type = TYPES.includes(entry.type) ? entry.type : "other";
    const item = keys.get(key) ?? {
      production: false,
      preview: false,
      development: false,
      entries: 0,
      branchScoped: 0,
      types: new Set(),
      shared: false,
    };
    item.entries += 1;
    if (typeof entry.gitBranch === "string" && entry.gitBranch) item.branchScoped += 1;
    for (const target of targets) item[target] = true;
    if (targets.includes("production") && targets.some((target) => target !== "production"))
      item.shared = true;
    item.nonProductionOnly =
      (item.nonProductionOnly ?? false) || (targets.length > 0 && !targets.includes("production"));
    item.types.add(type);
    keys.set(key, item);
  }
  const findings = [];
  const variables = {};
  for (const [key, item] of [...keys.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const secret = secretNames.has(key);
    if (secret && item.shared)
      findings.push({ key, code: "SHARED_SECRET_ACROSS_TARGETS", severity: "FAIL" });
    if (secret && item.nonProductionOnly)
      findings.push({ key, code: "NONPROD_SECRET_PRESENT", severity: "REVIEW" });
    if (secret && item.types.has("plain"))
      findings.push({ key, code: "SECRET_NOT_ENCRYPTED", severity: "REVIEW" });
    if (!knownNames.has(key)) findings.push({ key, code: "UNKNOWN_KEY", severity: "REVIEW" });
    variables[key] = {
      secret,
      known: knownNames.has(key),
      production: item.production,
      preview: item.preview,
      development: item.development,
      entries: item.entries,
      branchScoped: item.branchScoped,
      types: [...item.types].sort(),
    };
  }
  return {
    ok: !findings.some((finding) => finding.severity === "FAIL"),
    code: findings.some((finding) => finding.severity === "FAIL") ? "SCOPE_FAIL" : "SCOPE_OK",
    counts: {
      entries: envs.length,
      keys: keys.size,
      invalidKeys,
      fail: findings.filter((f) => f.severity === "FAIL").length,
      review: findings.filter((f) => f.severity === "REVIEW").length,
    },
    findings,
    variables,
  };
}

async function main() {
  const emit = (value) =>
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, tool: "vercel-env-scope-report", ...value }, null, 2)}\n`,
    );
  if (process.argv.length !== 2) {
    emit({ ok: false, code: "USAGE" });
    process.exitCode = 2;
    return;
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  let input;
  try {
    input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    // 입력 원문에는 암호화된 값이 섞일 수 있으므로 파싱 오류 내용을 출력하지 않는다.
    emit({ ok: false, code: "INPUT_NOT_JSON" });
    process.exitCode = 2;
    return;
  }
  const result = analyzeEnvironmentScopes(input);
  emit(result);
  process.exitCode = result.code === "INPUT_SHAPE" ? 2 : result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
