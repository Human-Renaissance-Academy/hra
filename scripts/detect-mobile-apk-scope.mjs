/**
 * 모바일 workflow의 debug APK 컴파일 필요 여부 판별 (#492 선택지 A).
 * release-please가 제품 버전 필드만 바꾼 변경에서만 988초짜리 Gradle 컴파일을 생략합니다.
 * - 버전 판정은 의존성 원장 binding(#618)과 같은 마스킹 규칙(reviewedInputDigest)을 재사용합니다.
 * - 수동 실행, 기준 커밋 누락·도달 불가, 예상 밖 파일, 비정상 JSON·버전, Git 오류는 모두 컴파일 실행입니다.
 * - 계약·타입·린트·테스트·번들 job은 이 판정과 무관하게 항상 실행합니다.
 * 사용 위치: .github/workflows/mobile.yml의 apk-scope job
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { reviewedInputDigest } from "./_lib/dependency-policy.mjs";

const SHA = /^[a-f0-9]{40}$/;
// 제품 버전 필드가 있는 모바일 파일과 마스킹 종류입니다(release-policy.mjs의 RELEASE_EXTRA_FILES).
const MOBILE_VERSION_FILES = {
  "apps/mobile/package.json": "manifest",
  "apps/mobile/package-lock.json": "lock",
};
// release PR이 함께 바꾸는 루트 파일입니다. 독립 npm 프로젝트인 apps/mobile의 APK 입력이 아니므로 내용을 보지 않습니다.
// .nvmrc처럼 APK 빌드 도구에 영향을 주는 다른 루트 파일은 여기에 넣지 않으며, 목록 밖 파일은 모두 컴파일합니다.
const ROOT_RELEASE_FILES = new Set([
  "CHANGELOG.md",
  "package.json",
  "package-lock.json",
  ".release-please-manifest.json",
]);

/**
 * 변경 목록이 제품 버전 필드만 바꿨는지 판정합니다.
 * changes: [{ path, base: Buffer|null, head: Buffer|null }] (모바일 버전 파일만 내용이 필요합니다)
 * 반환값의 apk가 false일 때만 컴파일을 생략합니다.
 */
export function classifyMobileApkChanges(changes) {
  if (!Array.isArray(changes) || changes.length === 0 || changes.length > 100)
    return { apk: true, reason: "unknown-or-empty" };
  let versionFiles = 0;
  for (const change of changes) {
    const path = change?.path;
    if (typeof path === "string" && ROOT_RELEASE_FILES.has(path)) continue;
    const kind =
      typeof path === "string" && Object.hasOwn(MOBILE_VERSION_FILES, path)
        ? MOBILE_VERSION_FILES[path]
        : null;
    if (!kind) return { apk: true, reason: "build-input-changed" };
    const { base, head } = change;
    // 추가·삭제(한쪽 없음)나 내용이 같은 mode 변경은 버전 갱신이 아닙니다.
    if (!Buffer.isBuffer(base) || !Buffer.isBuffer(head) || base.equals(head))
      return { apk: true, reason: "not-a-content-change" };
    const before = reviewedInputDigest(kind, base);
    const after = reviewedInputDigest(kind, head);
    // 마스킹 실패(null: 비정상 JSON, 안정형 X.Y.Z가 아닌 버전, 경로 중복 등)나 다른 bytes 변경은 컴파일합니다.
    if (!before || !after || before !== after) return { apk: true, reason: "non-version-change" };
    versionFiles++;
  }
  // 루트 파일만 바뀐 경우는 이 workflow 경로 조건과 맞지 않으므로 애매한 것으로 보고 컴파일합니다.
  if (versionFiles === 0) return { apk: true, reason: "no-mobile-version-change" };
  return { apk: false, reason: "release-version-only" };
}

function git(args, encoding = "utf8") {
  return execFileSync("git", args, {
    encoding,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/** 비교 기준 커밋을 정합니다. PR은 base와 head의 merge-base, push는 before입니다. 확인하지 못하면 null입니다. */
function resolveBase(event, base, head) {
  if (!SHA.test(base) || !SHA.test(head) || /^0+$/.test(base)) return null;
  // 두 커밋 모두 실제 commit 객체여야 합니다(강제 갱신 등으로 도달할 수 없으면 실패합니다).
  for (const sha of [base, head]) if (git(["cat-file", "-t", sha]).trim() !== "commit") return null;
  if (event === "push") return base;
  if (event !== "pull_request") return null;
  const mergeBase = git(["merge-base", base, head]).trim();
  return SHA.test(mergeBase) ? mergeBase : null;
}

/** 기준과 head 사이의 변경 파일과 모바일 버전 파일의 양쪽 원문 bytes를 읽습니다. */
function readChanges(base, head) {
  const out = git(["diff", "--name-only", "--no-renames", "-z", base, head, "--"]);
  if (!out.endsWith("\0")) return null;
  const blob = (sha, path) => {
    // ls-tree로 일반 파일(blob)인지 먼저 확인해 symlink·submodule을 내용 비교 대상으로 삼지 않습니다.
    const entry = git(["ls-tree", "-z", sha, "--", path]);
    if (!/^100644 blob [a-f0-9]{40}\t/.test(entry)) return null;
    return git(["cat-file", "blob", `${sha}:${path}`], "buffer");
  };
  return out
    .slice(0, -1)
    .split("\0")
    .map((path) =>
      Object.hasOwn(MOBILE_VERSION_FILES, path)
        ? { path, base: blob(base, path), head: blob(head, path) }
        : { path, base: null, head: null },
    );
}

/** 인자: <event> <base sha> <head sha> <GITHUB_OUTPUT 경로>. 판정 결과를 apk=true|false로 기록합니다. */
function run() {
  const [event, base, head, outputPath] = process.argv.slice(2);
  if (!outputPath) throw new Error("MOBILE_APK_SCOPE_OUTPUT_MISSING");
  let result = { apk: true, reason: "unable-to-read-changes" };
  try {
    if (event === "workflow_dispatch") result = { apk: true, reason: "manual-run" };
    else {
      const from = resolveBase(event, base, head);
      const changes = from ? readChanges(from, head) : null;
      if (changes) result = classifyMobileApkChanges(changes);
    }
  } catch {
    // Git 오류는 컴파일 실행으로 처리하며 신뢰할 수 없는 경로·내용을 출력하지 않습니다.
  }
  appendFileSync(outputPath, "apk=" + (result.apk ? "true" : "false") + "\n");
  console.log("MOBILE_APK=" + (result.apk ? "build" : "skip") + " REASON=" + result.reason);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
