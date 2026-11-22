/**
 * main push 웹 CI 축소 판별(#492 B2)의 회귀 테스트입니다.
 * GitHub API와 Git을 합성 응답으로 대체해 모든 조건이 확인될 때만 reduced,
 * 어느 하나라도 어긋나거나 오류가 나면 full이 되는지 검증합니다. 네트워크를 사용하지 않습니다.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  CI_WORKFLOW_PATH,
  REQUIRED_CHECK_NAME,
  decideMainCiMode,
} from "../detect-main-ci-reuse.mjs";

const REPO = "Human-Renaissance-Academy/hra";
const SHA = "a".repeat(40); // main에 push된 squash 커밋
const HEAD = "b".repeat(40); // PR 최종 head
const PARENT = "c".repeat(40); // 병합 직전 main
const TREE = "d".repeat(40);
const SUITE = 1234;

/** 모든 조건을 만족하는 합성 GitHub 응답입니다. 각 테스트가 일부만 바꿉니다. */
function fixtures() {
  return {
    associated: [{ number: 42 }],
    pr: {
      number: 42,
      merged: true,
      merge_commit_sha: SHA,
      base: { ref: "main", repo: { full_name: REPO } },
      head: { sha: HEAD },
    },
    checks: {
      total_count: 1,
      check_runs: [
        {
          name: REQUIRED_CHECK_NAME,
          status: "completed",
          conclusion: "success",
          head_sha: HEAD,
          app: { slug: "github-actions" },
          check_suite: { id: SUITE },
        },
      ],
    },
    runs: {
      total_count: 1,
      workflow_runs: [
        {
          path: CI_WORKFLOW_PATH,
          event: "pull_request",
          head_sha: HEAD,
          status: "completed",
          conclusion: "success",
          check_suite_id: SUITE,
          repository: { full_name: REPO },
        },
      ],
    },
    git: {
      head: SHA,
      parents: SHA + " " + PARENT,
      fetchHead: HEAD,
      pushedTree: TREE,
      headTree: TREE,
      ancestor: true,
    },
  };
}

/** 합성 응답으로 판정하고, 호출된 API 경로와 Git 인수를 함께 돌려줍니다. */
function decide(mutate = () => {}, input = {}) {
  const data = fixtures();
  mutate(data);
  const calls = { api: [], git: [] };
  const api = (path) => {
    calls.api.push(path);
    if (data.apiError) throw new Error("HTTP 502");
    if (path === `repos/${REPO}/commits/${SHA}/pulls?per_page=100`) return data.associated;
    if (path === `repos/${REPO}/pulls/42`) return data.pr;
    if (path.startsWith(`repos/${REPO}/commits/${HEAD}/check-runs?`)) return data.checks;
    if (path === `repos/${REPO}/actions/runs?check_suite_id=${SUITE}&per_page=100`)
      return data.runs;
    throw new Error("unexpected path " + path);
  };
  const git = (args) => {
    calls.git.push(args);
    const key = args.join(" ");
    if (key === "rev-parse --verify HEAD^{commit}") return data.git.head + "\n";
    if (key === `rev-list --parents -n 1 ${SHA}`) return data.git.parents + "\n";
    if (key === "fetch --no-tags --quiet origin refs/pull/42/head") {
      if (data.git.fetchError) throw new Error("fetch failed");
      return "";
    }
    if (key === "rev-parse --verify FETCH_HEAD^{commit}") return data.git.fetchHead + "\n";
    if (key === `rev-parse --verify ${SHA}^{tree}`) return data.git.pushedTree + "\n";
    if (key === `rev-parse --verify ${HEAD}^{tree}`) return data.git.headTree + "\n";
    if (key === `merge-base --is-ancestor ${PARENT} ${HEAD}`) {
      if (!data.git.ancestor) throw new Error("exit 1");
      return "";
    }
    throw new Error("unexpected git " + key);
  };
  const result = decideMainCiMode({
    event: "push",
    ref: "refs/heads/main",
    sha: SHA,
    repository: REPO,
    api,
    git,
    ...input,
  });
  return { result, calls };
}

test("모든 조건을 확인하면 reduced이며 정확한 API·Git 대상만 조회한다", () => {
  const { result, calls } = decide();
  assert.deepEqual(result, { mode: "reduced", reason: "verified-pr-head-tree", pr: 42 });
  // 검사 이름은 URL 인코딩되어 정확한 이름·최신 결과만 요청합니다.
  assert.ok(
    calls.api.some((path) =>
      path.includes(
        "check_name=" + encodeURIComponent(REQUIRED_CHECK_NAME) + "&filter=latest&per_page=100",
      ),
    ),
  );
  // 이름 있는 ref를 만들지 않고 PR head를 FETCH_HEAD로만 가져옵니다.
  assert.ok(calls.git.some((args) => args[0] === "fetch" && args.at(-1) === "refs/pull/42/head"));
  assert.ok(calls.git.every((args) => !args.some((arg) => arg.includes(":"))));
});

test("push·main이 아닌 실행은 API를 호출하지 않고 full이다", () => {
  for (const input of [
    { event: "pull_request" },
    { event: "workflow_dispatch" },
    { event: "schedule" },
    { event: undefined },
    { ref: "refs/heads/feature" },
    { ref: "refs/tags/v1.0.0" },
  ]) {
    const { result, calls } = decide(() => {}, input);
    assert.equal(result.mode, "full", JSON.stringify(input));
    assert.equal(result.reason, "not-main-push");
    assert.deepEqual(calls, { api: [], git: [] });
  }
});

test("잘못된 SHA·저장소 입력은 full이다", () => {
  for (const input of [
    { sha: "abc" },
    { sha: SHA.toUpperCase() },
    { sha: undefined },
    { repository: "owner/repo/extra" },
    { repository: "../x" },
    { repository: "" },
  ]) {
    assert.equal(decide(() => {}, input).result.mode, "full", JSON.stringify(input));
  }
});

test("API 실패와 Git 실패는 full이다", () => {
  assert.deepEqual(
    decide((d) => {
      d.apiError = true;
    }).result,
    { mode: "full", reason: "api-or-git-error" },
  );
  assert.deepEqual(
    decide((d) => {
      d.git.fetchError = true;
    }).result,
    { mode: "full", reason: "api-or-git-error" },
  );
});

// 조건 (1): 연결된 PR이 정확히 하나여야 합니다.
test("연결 PR이 없거나 여러 개이거나 형식이 다르면 full이다", () => {
  for (const associated of [[], [{ number: 42 }, { number: 43 }], {}, null, [{ number: "42" }]]) {
    assert.equal(
      decide((d) => {
        d.associated = associated;
      }).result.mode,
      "full",
      JSON.stringify(associated),
    );
  }
});

// 조건 (2): PR이 병합되었고 병합 커밋이 push된 커밋이어야 합니다.
test("미병합·다른 병합 커밋·다른 base·다른 저장소 PR은 full이다", () => {
  for (const mutate of [
    (d) => (d.pr.merged = false),
    (d) => (d.pr.merge_commit_sha = "e".repeat(40)),
    (d) => (d.pr.merge_commit_sha = null),
    (d) => (d.pr.base.ref = "release"),
    (d) => (d.pr.base.repo.full_name = "other/hra"),
    (d) => (d.pr.number = 43),
    (d) => (d.pr.head.sha = "bad"),
  ]) {
    assert.equal(decide(mutate).result.mode, "full", mutate.toString());
  }
});

// 조건 (3): checkout·단일 부모·fetch한 head·트리·조상 관계가 모두 맞아야 합니다.
test("checkout 불일치·병합 커밋·head ref 불일치·트리 불일치·조상 아님은 full이다", () => {
  const cases = [
    [(d) => (d.git.head = "e".repeat(40)), "checkout-mismatch"],
    [(d) => (d.git.parents = SHA + " " + PARENT + " " + HEAD), "not-single-parent-commit"],
    [(d) => (d.git.parents = SHA), "not-single-parent-commit"],
    [(d) => (d.git.fetchHead = "e".repeat(40)), "pr-head-ref-mismatch"],
    [(d) => (d.git.headTree = "e".repeat(40)), "tree-mismatch"],
    [(d) => (d.git.pushedTree = ""), "tree-mismatch"],
    [(d) => (d.git.ancestor = false), "api-or-git-error"],
  ];
  for (const [mutate, reason] of cases) {
    assert.deepEqual(decide(mutate).result, { mode: "full", reason }, mutate.toString());
  }
});

// 조건 (4): 같은 이름의 최신 검사가 모두 성공이고 GitHub Actions ci.yml PR 실행이어야 합니다.
test("검사 미완료·실패·누락·이름 불일치·응답 형식 오류는 full이다", () => {
  for (const mutate of [
    (d) => (d.checks.check_runs[0].status = "in_progress"),
    (d) => (d.checks.check_runs[0].conclusion = "failure"),
    (d) => (d.checks.check_runs[0].conclusion = "skipped"),
    (d) => (d.checks.check_runs[0].conclusion = "neutral"),
    (d) => (d.checks.check_runs[0].name = "Lint · Typecheck · Test"),
    (d) => (d.checks = { total_count: 0, check_runs: [] }),
    (d) => (d.checks = { total_count: 1 }),
    // 페이지에 담기지 않은 같은 이름 검사가 있으면 전부 확인하지 못했으므로 full입니다.
    (d) => (d.checks.total_count = 2),
    (d) =>
      d.checks.check_runs.push({ ...d.checks.check_runs[0], conclusion: "failure" }) &&
      (d.checks.total_count = 2),
  ]) {
    assert.equal(decide(mutate).result.mode, "full", mutate.toString());
  }
});

test("다른 앱·다른 workflow·다른 이벤트·다른 head의 검사 결과는 인정하지 않는다", () => {
  const cases = [
    (d) => (d.checks.check_runs[0].app.slug = "vercel"),
    (d) => (d.checks.check_runs[0].app = null),
    (d) => (d.checks.check_runs[0].head_sha = "e".repeat(40)),
    (d) => (d.checks.check_runs[0].check_suite = null),
    (d) => (d.runs.workflow_runs[0].path = ".github/workflows/other.yml"),
    (d) => (d.runs.workflow_runs[0].path = ".github/workflows/ci.yml@main"),
    (d) => (d.runs.workflow_runs[0].event = "push"),
    (d) => (d.runs.workflow_runs[0].event = "pull_request_target"),
    (d) => (d.runs.workflow_runs[0].head_sha = "e".repeat(40)),
    (d) => (d.runs.workflow_runs[0].conclusion = "failure"),
    (d) => (d.runs.workflow_runs[0].status = "in_progress"),
    (d) => (d.runs.workflow_runs[0].repository.full_name = "fork/hra"),
    (d) => (d.runs.workflow_runs[0].check_suite_id = SUITE + 1),
    (d) => (d.runs.workflow_runs = []),
    (d) => d.runs.workflow_runs.push({ ...d.runs.workflow_runs[0] }),
    (d) => (d.runs = {}),
  ];
  for (const mutate of cases) {
    assert.deepEqual(
      decide(mutate).result,
      { mode: "full", reason: "no-verified-ci-workflow-run" },
      mutate.toString(),
    );
  }
});

test("CLI는 push가 아니면 네트워크 없이 main_ci=full을 기록하고 출력에 경로를 남기지 않는다", () => {
  const temp = mkdtempSync(join(tmpdir(), "hra-main-ci-"));
  try {
    const output = join(temp, "github-output");
    const cli = new URL("../detect-main-ci-reuse.mjs", import.meta.url);
    const result = spawnSync(
      process.execPath,
      [cli.pathname, "pull_request", "refs/pull/1/merge", SHA, REPO, output],
      { cwd: temp, encoding: "utf8" },
    );
    assert.equal(result.status, 0);
    assert.equal(readFileSync(output, "utf8"), "main_ci=full\n");
    assert.match(result.stdout, /MAIN_CI_MODE=full REASON=not-main-push/);
    assert.equal(result.stdout.includes(temp), false);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});

test("CLI는 Git 저장소가 아닌 곳의 main push도 full로 기록한다", () => {
  const temp = mkdtempSync(join(tmpdir(), "hra-main-ci-"));
  try {
    const output = join(temp, "github-output");
    const cli = new URL("../detect-main-ci-reuse.mjs", import.meta.url);
    // gh를 찾지 못하도록 PATH를 비워 API 호출 자체가 실패하는 경로를 재현합니다.
    const result = spawnSync(
      process.execPath,
      [cli.pathname, "push", "refs/heads/main", SHA, REPO, output],
      { cwd: temp, encoding: "utf8", env: { PATH: temp } },
    );
    assert.equal(result.status, 0);
    assert.equal(readFileSync(output, "utf8"), "main_ci=full\n");
    assert.match(result.stdout, /MAIN_CI_MODE=full REASON=api-or-git-error/);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
});
