/**
 * 요청 제한 어댑터가 원자적 DB 함수에 독립 제한 축을 전달하는지 검증합니다 (#121).
 * DB 함수 자체의 실제 경합 검증은 rate-limit-postgres.test.ts가 담당합니다.
 */
import { PgDialect } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  deleteWhere: vi.fn(),
  logServerError: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    execute: mocks.execute,
    delete: () => ({ where: mocks.deleteWhere }),
  },
}));
vi.mock("@/lib/errors", () => ({ logServerError: mocks.logServerError }));

import {
  releaseSuccessfulLogin,
  reserveApplicationSubmission,
  reserveLoginAttempt,
  reservePressView,
  reserveResourceRead,
  reserveUploadAttempt,
} from "@/lib/rate-limit";

const dialect = new PgDialect();
const reservationId = "11111111-1111-4111-8111-111111111111";

describe("요청 제한 DB 어댑터", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.execute.mockResolvedValue({
      rows: [
        {
          allowed: true,
          retry_after_sec: 0,
          reservation_id: reservationId,
        },
      ],
    });
    mocks.deleteWhere.mockResolvedValue(undefined);
  });

  it("로그인은 조합·IP·이메일을 한 DB 예약에 전달하고 이메일을 정규화한다", async () => {
    const first = await reserveLoginAttempt("203.0.113.1", " User@Example.COM ");
    const firstQuery = dialect.sqlToQuery(mocks.execute.mock.calls[0][0]);
    const second = await reserveLoginAttempt("203.0.113.1", "user@example.com");
    const secondQuery = dialect.sqlToQuery(mocks.execute.mock.calls[1][0]);

    expect(first).toEqual({ blocked: false, retryAfterSec: 0, reservationId });
    expect(second).toEqual(first);
    expect(firstQuery.sql).toContain("reserve_rate_limit(");
    expect(firstQuery.params).toEqual(secondQuery.params);
    expect(
      firstQuery.params.filter((param) => typeof param === "string" && param.startsWith("login-")),
    ).toEqual(["login-ip", "login-pair", "login-email"]);
    expect(firstQuery.params).not.toContain("user@example.com");
    expect(firstQuery.params).not.toContain("203.0.113.1");
  });

  it("로그인 차단은 원본 이메일·IP 없이 해시 앞 8자리만 로그에 남긴다 (#508)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.execute.mockResolvedValueOnce({
      rows: [{ allowed: false, retry_after_sec: 60, reservation_id: null }],
    });
    const result = await reserveLoginAttempt("203.0.113.9", "Victim@Example.invalid");
    expect(result.blocked).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    const [tag, event] = warn.mock.calls[0];
    expect(tag).toBe("[rate-limit/login-blocked]");
    expect(Object.keys(event).sort()).toEqual(["axes", "event", "keyPrefixes", "timestamp"]);
    expect(event.axes).toEqual(["login-ip", "login-pair", "login-email"]);
    for (const prefix of Object.values(event.keyPrefixes)) expect(prefix).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(warn.mock.calls)).not.toMatch(/victim|example|203\.0\.113/i);
    warn.mockRestore();
  });

  it("허용된 로그인과 저장소 장애는 차단 관측 로그를 남기지 않는다 (#508)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await reserveLoginAttempt("203.0.113.9", "a@example.invalid");
    mocks.execute.mockRejectedValueOnce(new Error("DB unavailable"));
    await reserveLoginAttempt("203.0.113.9", "a@example.invalid");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("업로드는 IP 축, 지원서는 IP 2개·이메일 축을 각각 예약한다", async () => {
    await reserveUploadAttempt("203.0.113.2");
    await reserveApplicationSubmission("203.0.113.2", "user@example.com");
    const upload = dialect.sqlToQuery(mocks.execute.mock.calls[0][0]);
    const submission = dialect.sqlToQuery(mocks.execute.mock.calls[1][0]);

    expect(upload.params).toContain("upload-ip");
    expect(submission.params).toContain("submission-ip-hour");
    expect(submission.params).toContain("submission-ip-day");
    expect(submission.params).toContain("submission-email-day");
    expect(submission.params).not.toContain("user@example.com");
  });

  it("DB가 차단하면 재시도 시간을 전달하고 오류가 나면 차단한다", async () => {
    mocks.execute.mockResolvedValueOnce({
      rows: [
        {
          allowed: false,
          retry_after_sec: 37,
          reservation_id: null,
        },
      ],
    });
    expect(await reserveUploadAttempt("203.0.113.3")).toEqual({
      blocked: true,
      retryAfterSec: 37,
      reservationId: null,
    });

    mocks.execute.mockRejectedValueOnce(new Error("DB unavailable"));
    expect(await reserveUploadAttempt("203.0.113.3")).toEqual({
      blocked: true,
      retryAfterSec: 60,
      reservationId: null,
    });
    expect(mocks.logServerError).toHaveBeenCalledTimes(1);
  });

  it("자료 조회는 사용자 id의 분·시간 두 축을 해시로만 예약한다 (#444)", async () => {
    const userId = "61000000-0000-4000-8000-000000000001";
    expect(await reserveResourceRead(userId)).toEqual({
      blocked: false,
      retryAfterSec: 0,
      reservationId,
    });
    const query = dialect.sqlToQuery(mocks.execute.mock.calls[0][0]);
    expect(query.params).toEqual(
      expect.arrayContaining([
        "resource-read-user-minute",
        "resource-read-user-hour",
        300,
        2000,
        60,
        3600,
      ]),
    );
    expect(query.params).not.toContain(userId);
  });

  it("자료 조회 제한 저장소 장애는 차단하면서 503 구분용 unavailable을 표시한다 (#444)", async () => {
    mocks.execute.mockRejectedValueOnce(new Error("DB unavailable"));
    expect(await reserveResourceRead("61000000-0000-4000-8000-000000000001")).toEqual({
      unavailable: true,
      blocked: true,
      retryAfterSec: 3600,
      reservationId: null,
    });
    expect(mocks.logServerError).toHaveBeenCalledWith(
      "rate-limit/reserve-resource-read",
      expect.any(Error),
    );
  });

  it("성공한 로그인의 예약만 해제한다", async () => {
    await releaseSuccessfulLogin(reservationId);
    await releaseSuccessfulLogin(null);
    expect(mocks.deleteWhere).toHaveBeenCalledTimes(1);
  });

  it("기사 클릭의 조합·전체 IP 두 예산을 한 SQL에 해시로만 전달한다", async () => {
    const articleId = "81000000-0000-4000-8000-000000000001";
    await reservePressView("203.0.113.4", articleId);
    expect(mocks.execute).toHaveBeenCalledOnce();
    const query = dialect.sqlToQuery(mocks.execute.mock.calls[0][0]);
    expect(query.sql).toContain("reserve_rate_limit(");
    expect(query.params.slice(0, 2)).toEqual(["press-view-pair", "press-view-ip"]);
    expect(query.params.slice(4)).toEqual([1, 60, 60, 60]);
    expect(query.params.slice(2, 4)).toEqual([
      expect.stringMatching(/^[a-f0-9]{64}$/),
      expect.stringMatching(/^[a-f0-9]{64}$/),
    ]);
    expect(query.params).not.toContain("203.0.113.4");
    expect(query.params).not.toContain(articleId);
    expect(mocks.deleteWhere).not.toHaveBeenCalled();
  });

  it.each([undefined, {}, { rows: [] }, { rows: [{ allowed: "yes" }] }])(
    "잘못된 기사 예약 결과 %j는 증가를 허용하지 않는다",
    async (result) => {
      mocks.execute.mockResolvedValueOnce(result);
      expect(await reservePressView("unknown", reservationId)).toMatchObject({
        blocked: true,
        reservationId: null,
        retryAfterSec: 60,
      });
      expect(mocks.logServerError).toHaveBeenCalledWith(
        "rate-limit/reserve-press-view",
        expect.anything(),
      );
    },
  );

  it("기사 예약 DB 장애는 기존 정제 로그 후 차단한다", async () => {
    const error = new Error("합성 예약 장애");
    mocks.execute.mockRejectedValueOnce(error);
    expect(await reservePressView("unknown", reservationId)).toEqual({
      blocked: true,
      retryAfterSec: 60,
      reservationId: null,
    });
    expect(mocks.logServerError).toHaveBeenCalledExactlyOnceWith(
      "rate-limit/reserve-press-view",
      error,
    );
  });

  it("같은 IP의 기사별 키는 분리하고 IP 축만 공유하며 업로드 키와도 분리한다", async () => {
    await reservePressView("203.0.113.4", "81000000-0000-4000-8000-000000000001");
    await reservePressView("203.0.113.4", "81000000-0000-4000-8000-000000000002");
    await reserveUploadAttempt("203.0.113.4");
    const [first, second, upload] = mocks.execute.mock.calls.map(
      ([sql]) => dialect.sqlToQuery(sql).params,
    );
    expect(first[2]).not.toBe(second[2]);
    expect(first[3]).toBe(second[3]);
    expect(first[3]).not.toBe(upload[1]);
  });
});
