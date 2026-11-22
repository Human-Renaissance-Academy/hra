/**
 * main push 웹 CI의 축소 실행 판별 (#492 B2).
 *
 * 역할:
 * - main에 push된 squash 커밋의 트리가 이미 같은 트리로 `Lint · Typecheck · Test · Build`를
 *   통과한 PR head 트리와 같을 때만 `main_ci=reduced`를 출력합니다.
 * - 축소 실행에서도 의존성 설치·Next.js 빌드·브라우저 스모크는 계속 실행합니다(ci.yml 단계 조건).
 * - PR·수동·예약 실행, API/Git 오류, 응답 형식 불일치, 여러 PR, 다른 앱·다른 workflow의 검사 결과는
 *   모두 `main_ci=full`로 처리합니다(fail-safe = 전체 실행).
 *
 * 사용 위치: `.github/workflows/ci.yml`의 `scope` job 마지막 단계(push·main에서만 실행).
 * 입력은 runner 기본 환경변수를 인수로만 받으며 셸 문자열에 API 값을 끼워 넣지 않습니다.
 * GitHub API는 `gh api`가 단계 env의 GH_TOKEN(읽기 전용 job 권한)으로 호출합니다.
 */
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// 필수 검사 이름과 이를 만드는 검토된 workflow 경로입니다. 이름만 같은 다른 검사는 인정하지 않습니다.
export const REQUIRED_CHECK_NAME = "Lint · Typecheck · Test · Build";
export const CI_WORKFLOW_PATH = ".github/workflows/ci.yml";
const SHA = /^[a-f0-9]{40}$/;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const full = (reason) => ({ mode: "full", reason });

/**
 * 순수 판정 함수입니다. `api(path)`는 파싱된 JSON을, `git(args)`는 stdout 문자열을 반환하고
 * 실패 시 예외를 던집니다. 어떤 예외도 축소 실행으로 이어지지 않습니다.
 */
export function decideMainCiMode({ event, ref, sha, repository, api, git }) {
  // 1) push·main 이외의 이벤트(PR, workflow_dispatch, schedule 등)는 항상 전체 실행합니다.
  if (event !== "push" || ref !== "refs/heads/main") return full("not-main-push");
  if (typeof sha !== "string" || !SHA.test(sha)) return full("invalid-sha");
  if (typeof repository !== "string" || !REPOSITORY.test(repository))
    return full("invalid-repository");
  try {
    return verify({ sha, repository, api, git });
  } catch {
    // API·Git 실패 원문에는 URL·토큰 관련 문구가 섞일 수 있어 출력하지 않고 전체 실행합니다.
    return full("api-or-git-error");
  }
}

function verify({ sha, repository, api, git }) {
  // 2) 이 커밋과 연결된 PR이 정확히 하나이고, 그 PR의 병합 커밋이 이 커밋이어야 합니다.
  const associated = api(`repos/${repository}/commits/${sha}/pulls?per_page=100`);
  if (!Array.isArray(associated) || associated.length !== 1) return full("not-exactly-one-pr");
  const number = associated[0]?.number;
  if (!Number.isSafeInteger(number) || number <= 0) return full("invalid-pr-number");
  // 연결 목록 대신 PR 단건 응답을 정본으로 다시 확인합니다.
  const pr = api(`repos/${repository}/pulls/${number}`);
  if (
    !isObject(pr) ||
    pr.number !== number ||
    pr.merged !== true ||
    pr.merge_commit_sha !== sha ||
    pr.base?.ref !== "main" ||
    pr.base?.repo?.full_name !== repository
  )
    return full("pr-not-merged-into-this-commit");
  const headSha = pr.head?.sha;
  if (typeof headSha !== "string" || !SHA.test(headSha)) return full("invalid-head-sha");

  // 3) checkout한 커밋이 push된 커밋인지, squash 단일 부모인지 확인합니다.
  if (git(["rev-parse", "--verify", "HEAD^{commit}"]).trim() !== sha)
    return full("checkout-mismatch");
  const parents = git(["rev-list", "--parents", "-n", "1", sha]).trim().split(/\s+/);
  if (parents.length !== 2 || parents[0] !== sha || !SHA.test(parents[1]))
    return full("not-single-parent-commit");

  // PR 최종 head를 익명 fetch(공개 저장소)로 가져와 API의 head.sha와 일치하는지 대조합니다.
  // 이름 있는 ref를 만들지 않고 FETCH_HEAD만 사용합니다.
  git(["fetch", "--no-tags", "--quiet", "origin", `refs/pull/${number}/head`]);
  if (git(["rev-parse", "--verify", "FETCH_HEAD^{commit}"]).trim() !== headSha)
    return full("pr-head-ref-mismatch");
  const pushedTree = git(["rev-parse", "--verify", `${sha}^{tree}`]).trim();
  const headTree = git(["rev-parse", "--verify", `${headSha}^{tree}`]).trim();
  if (!SHA.test(pushedTree) || pushedTree !== headTree) return full("tree-mismatch");
  // 병합 직전 main이 PR head의 조상이어야 PR CI가 검사한 merge ref 트리도 head 트리와 같습니다.
  // 조상이 아니면 git이 종료 코드 1로 예외를 던지고 전체 실행합니다.
  git(["merge-base", "--is-ancestor", parents[1], headSha]);

  // 4) PR head의 같은 이름 검사가 모두 성공이고, 그중 GitHub Actions의 ci.yml PR 실행이 있어야 합니다.
  const checks = api(
    `repos/${repository}/commits/${headSha}/check-runs?check_name=${encodeURIComponent(
      REQUIRED_CHECK_NAME,
    )}&filter=latest&per_page=100`,
  );
  if (!isObject(checks) || !Array.isArray(checks.check_runs)) return full("invalid-check-runs");
  const named = checks.check_runs.filter((run) => run?.name === REQUIRED_CHECK_NAME);
  if (
    named.length === 0 ||
    named.length !== checks.total_count ||
    named.some((run) => run.status !== "completed" || run.conclusion !== "success")
  )
    return full("check-not-successful");
  for (const run of named) {
    if (run.app?.slug !== "github-actions" || run.head_sha !== headSha) continue;
    const suite = run.check_suite?.id;
    if (!Number.isSafeInteger(suite) || suite <= 0) continue;
    const runs = api(`repos/${repository}/actions/runs?check_suite_id=${suite}&per_page=100`);
    if (!isObject(runs) || !Array.isArray(runs.workflow_runs) || runs.workflow_runs.length !== 1)
      continue;
    const workflow = runs.workflow_runs[0];
    if (
      workflow?.path === CI_WORKFLOW_PATH &&
      workflow.event === "pull_request" &&
      workflow.head_sha === headSha &&
      workflow.status === "completed" &&
      workflow.conclusion === "success" &&
      workflow.repository?.full_name === repository &&
      workflow.check_suite_id === suite
    )
      return { mode: "reduced", reason: "verified-pr-head-tree", pr: number };
  }
  return full("no-verified-ci-workflow-run");
}

function gitCli(args) {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
}

function apiCli(path) {
  return JSON.parse(
    execFileSync("gh", ["api", path], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
}

function run() {
  const [event, ref, sha, repository, outputPath] = process.argv.slice(2);
  if (!outputPath) throw new Error("MAIN_CI_OUTPUT_MISSING");
  const result = decideMainCiMode({ event, ref, sha, repository, api: apiCli, git: gitCli });
  appendFileSync(outputPath, "main_ci=" + (result.mode === "reduced" ? "reduced" : "full") + "\n");
  console.log(
    "MAIN_CI_MODE=" +
      result.mode +
      " REASON=" +
      result.reason +
      (result.pr ? " PR=#" + String(result.pr) : ""),
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
