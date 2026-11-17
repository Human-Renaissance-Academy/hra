// @vitest-environment node
/**
 * 실제 조회수 서비스·Drizzle·예약 SQL을 폐기 PostgreSQL에 연결합니다.
 * 비동기 psql별 독립 연결로 경합을 만들며 외부 Neon 요청은 전부 차단합니다.
 */
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { neon, neonConfig } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { createQaPostgres } from "../support/resource-qa-postgres.mjs";
import { bindParameters, qaDatabaseUrl, qaNeonEndpoint } from "../support/neon-psql-transport.mjs";

const mocks = vi.hoisted(() => ({
  database: undefined as NeonHttpDatabase<typeof schema> | undefined,
  log: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  get db() {
    if (!mocks.database) throw new Error("격리 DB 준비 전 호출");
    return mocks.database;
  },
}));
vi.mock("@/lib/errors", () => ({ logServerError: mocks.log }));

import { recordPressView } from "@/features/press/view-service";
import { reserveLoginAttempt, reserveResourceRead, reserveUploadAttempt } from "@/lib/rate-limit";
import { GET as cleanup } from "@/app/api/cron/cleanup-rate-limits/route";

const bin = process.env.HRA_TEST_PG_BIN;
const execAsync = promisify(execFile);
const article = (index: number) => `81000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
const ip = "203.0.113.1";

describe.skipIf(!bin)("언론보도 반복 집계의 실제 PostgreSQL 경계", () => {
  let cluster: ReturnType<typeof createQaPostgres>;
  let failReservation = false;
  let activeConnections = 0;
  let peakConnections = 0;
  const statements: string[] = [];
  const previousFetch = neonConfig.fetchFunction;
  const previousEndpoint = neonConfig.fetchEndpoint;
  const count = () => cluster.sql("SELECT coalesce(sum(view_count),0) FROM press_articles");
  const events = () => cluster.sql("SELECT count(*) FROM rate_limit_events");

  beforeAll(() => {
    cluster = createQaPostgres(bin);
    cluster.sql(
      "CREATE TABLE application_submissions (id uuid PRIMARY KEY); CREATE TABLE press_articles(id uuid PRIMARY KEY, view_count integer NOT NULL DEFAULT 0, updated_at timestamp NOT NULL DEFAULT now());",
    );
    cluster.sql(readFileSync("scripts/sql/rate-limit-reservations.sql", "utf8"));
    neonConfig.fetchEndpoint = qaNeonEndpoint;
    neonConfig.fetchFunction = async (address: unknown, options: RequestInit) => {
      if (
        String(address) !== qaNeonEndpoint ||
        options.method !== "POST" ||
        new Headers(options.headers).get("Neon-Connection-String") !== qaDatabaseUrl
      ) {
        throw new Error("격리 SQL 범위 이외 요청 차단");
      }
      const payload = JSON.parse(String(options.body));
      const statement = bindParameters(payload.query, payload.params);
      statements.push(payload.query);
      if (failReservation && statement.includes("reserve_rate_limit")) {
        return Response.json(
          { message: "합성 예약 장애", code: "QA_TRANSPORT_ERROR" },
          { status: 503 },
        );
      }
      // SELECT는 실제 함수 결과를 JSON으로 감싸고, 쓰기는 실제 변경 행수만 반환합니다.
      // psql은 매번 별도 프로세스/연결로 실행하므로 Promise.all이 실제 DB 경합을 만듭니다.
      const select = /^\s*select\b/i.test(statement);
      const query = select
        ? `SELECT row_to_json(qa_row) FROM (${statement}) AS qa_row`
        : `WITH qa_write AS (${statement} RETURNING 1) SELECT count(*) FROM qa_write`;
      activeConnections++;
      peakConnections = Math.max(peakConnections, activeConnections);
      try {
        const { stdout } = await execAsync(
          join(bin!, "psql"),
          ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=sqlstate", "-c", query],
          {
            env: { ...cluster.environment, NODE_ENV: "test" },
            encoding: "utf8",
            timeout: 30_000,
            maxBuffer: 1024 * 1024,
          },
        );
        if (!select)
          return Response.json({
            fields: [],
            rows: [],
            rowCount: Number(stdout.trim()),
            command: statement.trim().split(/\s/)[0].toUpperCase(),
          });
        const records: Record<string, string | number | boolean | null>[] = stdout
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        const names = Object.keys(records[0] ?? {});
        const fields = names.map((name) => ({
          name,
          dataTypeID:
            typeof records[0][name] === "boolean"
              ? 16
              : typeof records[0][name] === "number"
                ? 23
                : 25,
        }));
        const rows = records.map((record) =>
          names.map((name) =>
            record[name] === null
              ? null
              : typeof record[name] === "boolean"
                ? record[name]
                  ? "t"
                  : "f"
                : String(record[name]),
          ),
        );
        return Response.json({ fields, rows, rowCount: rows.length, command: "SELECT" });
      } catch (error) {
        // 합성 SQL·접속 정보가 담긴 psql 원문 대신 고정된 오류만 앱으로 보냅니다.
        const state =
          error &&
          typeof error === "object" &&
          "stderr" in error &&
          typeof error.stderr === "string"
            ? error.stderr.match(/(?:ERROR:\s*)([0-9A-Z]{5})/)?.[1]
            : undefined;
        if (state) console.error(`PRESS_QA_SQLSTATE:${state}`);
        return Response.json(
          { message: "격리 SQL 실행 실패", code: "QA_TRANSPORT_ERROR" },
          { status: 400 },
        );
      } finally {
        activeConnections--;
      }
    };
    mocks.database = drizzle(neon(qaDatabaseUrl), { schema });
  }, 30_000);

  beforeEach(() => {
    statements.length = 0;
    peakConnections = 0;
    failReservation = false;
    mocks.log.mockClear();
    cluster.sql(`ALTER TABLE press_articles DROP CONSTRAINT IF EXISTS press_view_reject; TRUNCATE press_articles,rate_limit_events;
      INSERT INTO press_articles(id) SELECT ('81000000-0000-4000-8000-' || lpad(i::text,12,'0'))::uuid FROM generate_series(1,61) AS i;`);
  });
  afterEach(() => vi.unstubAllEnvs());
  afterAll(() => {
    neonConfig.fetchFunction = previousFetch;
    neonConfig.fetchEndpoint = previousEndpoint;
    mocks.database = undefined;
    cluster?.close();
  });

  it("같은 IP·기사 동시 12회는 한 번만 증가하고 이벤트 두 행만 남긴다", async () => {
    await Promise.all(Array.from({ length: 12 }, () => recordPressView(article(1), ip)));
    expect(peakConnections).toBeGreaterThan(1);
    expect(count()).toBe("1");
    expect(events()).toBe("2");
    expect(statements.filter((sql) => /^update /i.test(sql))).toHaveLength(1);
  }, 30_000);

  it("같은 IP의 서로 다른 기사 61개 경합은 정확히 60개만 허용한다", async () => {
    await Promise.all(
      Array.from({ length: 61 }, (_, index) => recordPressView(article(index + 1), ip)),
    );
    expect(peakConnections).toBeGreaterThan(1);
    expect(count()).toBe("60");
    expect(
      cluster.sql("SELECT scope,count(*) FROM rate_limit_events GROUP BY scope ORDER BY scope"),
    ).toBe("press-view-ip|60\npress-view-pair|60");
    expect(cluster.sql("SELECT max(view_count) FROM press_articles")).toBe("1");
  }, 60_000);

  it("다른 IP의 동일 기사와 같은 IP의 다른 기사는 독립 조합이다", async () => {
    await recordPressView(article(1), ip);
    await recordPressView(article(1), "203.0.113.2");
    await recordPressView(article(2), ip);
    expect(count()).toBe("3");
    expect(events()).toBe("6");
  });

  it("조합 차단은 다른 축의 이벤트·최초 시각도 바꾸지 않는다", async () => {
    await recordPressView(article(1), ip);
    const before = cluster.sql(
      "SELECT scope,key_hash,attempted_at FROM rate_limit_events ORDER BY scope",
    );
    await recordPressView(article(1), ip);
    expect(
      cluster.sql("SELECT scope,key_hash,attempted_at FROM rate_limit_events ORDER BY scope"),
    ).toBe(before);
    expect(count()).toBe("1");
  });

  it("고정 SQL 경계와 실제 함수의 창 전후 재허용을 구분한다", async () => {
    expect(
      cluster.sql(
        "SELECT value > '2026-11-17 00:00:00+00'::timestamptz - interval '60 seconds' FROM (VALUES ('2026-11-16 23:59:00+00'::timestamptz),('2026-11-16 23:59:00.001+00'::timestamptz)) AS t(value)",
      ),
    ).toBe("f\nt");
    expect(readFileSync("scripts/sql/rate-limit-reservations.sql", "utf8")).toContain(
      "e.attempted_at > v_now - make_interval",
    );
    await recordPressView(article(1), ip);
    cluster.sql(
      "UPDATE rate_limit_events SET attempted_at=clock_timestamp()-interval '30 seconds'",
    );
    await recordPressView(article(1), ip);
    expect(count()).toBe("1");
    cluster.sql(
      "UPDATE rate_limit_events SET attempted_at=clock_timestamp()-interval '61 seconds'",
    );
    await recordPressView(article(1), ip);
    expect(count()).toBe("2");
    expect(events()).toBe("4");
  });

  it("저장 오류 뒤 예약은 남고 같은 창의 재시도를 억제한다", async () => {
    cluster.sql("ALTER TABLE press_articles ADD CONSTRAINT press_view_reject CHECK(view_count=0)");
    await expect(recordPressView(article(1), ip)).rejects.toThrow();
    expect(count()).toBe("0");
    expect(events()).toBe("2");
    cluster.sql("ALTER TABLE press_articles DROP CONSTRAINT press_view_reject");
    await expect(recordPressView(article(1), ip)).resolves.toBeUndefined();
    expect(count()).toBe("0");
    expect(events()).toBe("2");
  });

  it("없는 UUID도 예약은 소비하며 존재 조회는 추가하지 않는다", async () => {
    await recordPressView(article(99), ip);
    expect(count()).toBe("0");
    expect(events()).toBe("2");
    expect(statements).toHaveLength(2);
    expect(statements[0]).toContain("reserve_rate_limit");
    expect(statements[1]).toMatch(/^update /i);
  });

  it("예약 DB 장애는 증가 0이며 정상 거부는 로그를 남기지 않는다", async () => {
    failReservation = true;
    await expect(recordPressView(article(1), ip)).resolves.toBeUndefined();
    expect(count()).toBe("0");
    expect(events()).toBe("0");
    expect(mocks.log).toHaveBeenCalledOnce();
    failReservation = false;
    mocks.log.mockClear();
    await recordPressView(article(1), ip);
    await recordPressView(article(1), ip);
    expect(mocks.log).not.toHaveBeenCalled();
  });

  it("press 예약은 로그인·업로드·자료실 예산과 키를 공유하지 않는다", async () => {
    await recordPressView(article(1), ip);
    expect((await reserveLoginAttempt(ip, "synthetic@press.invalid")).blocked).toBe(false);
    expect((await reserveUploadAttempt(ip)).blocked).toBe(false);
    expect((await reserveResourceRead(article(1))).blocked).toBe(false);
    expect(
      cluster.sql("SELECT count(*) FROM rate_limit_events WHERE key_hash !~ '^[a-f0-9]{64}$'"),
    ).toBe("0");
    expect(cluster.sql("SELECT count(DISTINCT key_hash) FROM rate_limit_events")).toBe("8");
  });

  it("기존 48시간 정리는 press의 오래된 두 축도 지우고 최신 예약은 보존한다", async () => {
    await recordPressView(article(1), ip);
    cluster.sql("UPDATE rate_limit_events SET attempted_at=clock_timestamp()-interval '49 hours'");
    await recordPressView(article(2), ip);
    vi.stubEnv("CRON_SECRET", "press-cleanup-synthetic");
    const response = await cleanup(
      new NextRequest("http://localhost/api/cron/cleanup-rate-limits", {
        headers: { authorization: "Bearer press-cleanup-synthetic" },
      }),
    );
    expect(response.status).toBe(200);
    expect(events()).toBe("2");
    expect(
      cluster.sql(
        "SELECT count(*) FROM rate_limit_events WHERE attempted_at < now()-interval '48 hours'",
      ),
    ).toBe("0");
  });
});
