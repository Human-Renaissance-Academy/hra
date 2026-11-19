// @vitest-environment node
/**
 * 로그인 3축 제한(조합 5·IP 50·이메일 30)의 실제 PostgreSQL 격리 검증 (#508).
 * 분산 IP의 이메일 축 소진, 올바른 비밀번호 시도의 차단, 조합·IP 축, 창 경계를 확인합니다.
 * 테스트 전용 임시 클러스터와 유닉스 소켓만 사용하고 종료 시 모두 정리합니다.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  LOGIN_EMAIL_RATE_LIMIT,
  LOGIN_IP_RATE_LIMIT,
  LOGIN_RATE_LIMIT,
} from "@/lib/rate-limit-core";

const bin = process.env.HRA_TEST_PG_BIN;

// rate-limit.ts 의 hashLimitKey 와 같은 구성(scope + NUL + key)입니다.
const hash = (scope: string, key: string) =>
  createHash("sha256").update(scope).update("\0").update(key).digest("hex");

describe.skipIf(!bin)("로그인 이메일 축 PostgreSQL 격리 검증 (#508)", () => {
  let root: string;
  let started = false;
  let psqlArgs: string[];
  const program = (name: string) => join(bin!, name);
  const run = (statement: string) =>
    execFileSync(program("psql"), psqlArgs, {
      input: statement,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();

  /** rate-limit.ts 의 reserveLoginAttempt 와 같은 세 축·한도로 예약 함수를 호출합니다. */
  const attempt = (ip: string, email: string): boolean => {
    const axes = [
      ["login-ip", ip, LOGIN_IP_RATE_LIMIT],
      ["login-pair", `${ip}\0${email}`, LOGIN_RATE_LIMIT],
      ["login-email", email, LOGIN_EMAIL_RATE_LIMIT],
    ] as const;
    const scopes = axes.map(([scope]) => `'${scope}'`).join(",");
    const hashes = axes.map(([scope, key]) => `'${hash(scope, key)}'`).join(",");
    const limits = axes.map(([, , policy]) => policy.maxAttempts).join(",");
    const windows = axes.map(([, , policy]) => policy.windowMs / 1000).join(",");
    return (
      run(
        `SELECT allowed FROM reserve_rate_limit(ARRAY[${scopes}]::text[], ARRAY[${hashes}]::text[], ARRAY[${limits}]::integer[], ARRAY[${windows}]::integer[]);`,
      ) === "t"
    );
  };

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "hra-login-axis-"));
    execFileSync(
      program("initdb"),
      ["-D", join(root, "data"), "-A", "trust", "-U", "hra_test", "--no-locale", "-E", "UTF8"],
      { stdio: "pipe" },
    );
    execFileSync(
      program("pg_ctl"),
      [
        "-D",
        join(root, "data"),
        "-l",
        join(root, "server.log"),
        "-o",
        `-h '' -k ${root} -p 55471`,
        "-w",
        "start",
      ],
      { stdio: "pipe" },
    );
    started = true;
    psqlArgs = [
      "-X",
      "-h",
      root,
      "-p",
      "55471",
      "-U",
      "hra_test",
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-Atq",
    ];
    run("CREATE TABLE application_submissions (id uuid PRIMARY KEY);");
    run(readFileSync("scripts/sql/rate-limit-reservations.sql", "utf8"));
  }, 30000);

  afterAll(() => {
    try {
      if (started)
        execFileSync(
          program("pg_ctl"),
          ["-D", join(root, "data"), "-m", "immediate", "-w", "stop"],
          { stdio: "pipe" },
        );
    } finally {
      if (root) rmSync(root, { recursive: true, force: true });
    }
  });

  it("분산 IP 30회는 허용하고 31번째는 새 IP·올바른 비밀번호 시도여도 차단한다", () => {
    const email = "victim@example.invalid";
    // 서로 다른 IP 30개: 조합·IP 축은 각 1회라 이메일 축만 소진된다.
    for (let i = 1; i <= 30; i++) expect(attempt(`198.51.100.${i}`, email)).toBe(true);
    // 31번째는 비밀번호 검증에 도달하기 전 예약 단계에서 막히므로 authorize 는 null 이다.
    expect(attempt("203.0.113.200", email)).toBe(false);
    // 다른 이메일은 영향받지 않는다.
    expect(attempt("203.0.113.200", "other@example.invalid")).toBe(true);
  }, 60000);

  it("한 IP 와 한 이메일 조합은 5회에서 차단한다", () => {
    const ip = "192.0.2.10";
    const email = "pair@example.invalid";
    for (let i = 0; i < 5; i++) expect(attempt(ip, email)).toBe(true);
    expect(attempt(ip, email)).toBe(false);
  });

  it("한 IP 가 서로 다른 이메일을 50회 시도하면 51번째를 차단한다", () => {
    const ip = "192.0.2.20";
    for (let i = 0; i < 50; i++) expect(attempt(ip, `spray${i}@example.invalid`)).toBe(true);
    expect(attempt(ip, "spray-extra@example.invalid")).toBe(false);
  }, 60000);

  it("창 경계: 15분보다 오래된 이메일 축 이벤트는 세지 않는다", () => {
    const email = "window@example.invalid";
    for (let i = 1; i <= 30; i++) expect(attempt(`198.18.0.${i}`, email)).toBe(true);
    expect(attempt("198.18.1.1", email)).toBe(false);
    // 가장 오래된 한 건을 창 밖(15분 + 1초 전)으로 보내면 한 건이 비어 다시 허용된다.
    run(`UPDATE rate_limit_events SET attempted_at = now() - interval '901 seconds'
      WHERE id = (SELECT id FROM rate_limit_events
        WHERE scope = 'login-email' AND key_hash = '${hash("login-email", email)}' LIMIT 1);`);
    expect(attempt("198.18.1.2", email)).toBe(true);
    expect(attempt("198.18.1.3", email)).toBe(false);
  }, 60000);

  it("운영 해제: 이메일 축 키만 지우면 같은 이메일이 다시 허용된다", () => {
    const email = "unlock@example.invalid";
    for (let i = 1; i <= 30; i++) expect(attempt(`198.19.0.${i}`, email)).toBe(true);
    expect(attempt("198.19.1.1", email)).toBe(false);
    const keyHash = hash("login-email", email);
    expect(
      run(
        `SELECT count(*) FROM rate_limit_events WHERE scope = 'login-email' AND key_hash = '${keyHash}';`,
      ),
    ).toBe("30");
    run(`DELETE FROM rate_limit_events WHERE scope = 'login-email' AND key_hash = '${keyHash}';`);
    expect(attempt("198.19.1.1", email)).toBe(true);
  }, 60000);
});
