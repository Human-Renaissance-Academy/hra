// @vitest-environment node
/**
 * 실제 Web credentials authorize의 두 단계 자원 경계를 검증합니다 (#508).
 * NextAuth 초기화만 포착하고 설치된 provider의 앱 callback과 실제 사용자 조회·예약 해제 helper를 실행합니다.
 * DB 전송·원자 예약 결과·bcrypt만 합성하며 네트워크·실제 DB·세션 발급은 수행하지 않습니다.
 */
import type { NextAuthConfig } from "next-auth";
import { PgDialect } from "drizzle-orm/pg-core";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";

const capture = vi.hoisted(() => ({ config: undefined as NextAuthConfig | undefined }));
const mocks = vi.hoisted(() => ({
  reserve: vi.fn(),
  findMany: vi.fn(),
  compare: vi.fn(),
  deleteWhere: vi.fn(),
  logServerError: vi.fn(),
}));

vi.mock("next-auth", () => ({
  default: (config: NextAuthConfig) => {
    capture.config = config;
    return { handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() };
  },
}));
vi.mock("@/lib/db", () => ({
  db: {
    query: { users: { findMany: mocks.findMany } },
    delete: () => ({ where: mocks.deleteWhere }),
  },
}));
vi.mock("bcryptjs", () => ({ compare: mocks.compare }));
vi.mock("@/lib/errors", () => ({ logServerError: mocks.logServerError }));
vi.mock("@/lib/rate-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/rate-limit")>()),
  reserveLoginAttempt: mocks.reserve,
}));

import * as rateLimit from "@/lib/rate-limit";
import "@/lib/auth";

const reservationId = "50800000-0000-4000-8000-000000000001";
const user = {
  id: "50800000-0000-4000-8000-000000000002",
  name: "합성 관리자",
  email: "admin@example.invalid",
  passwordHash: "synthetic-password-hash",
  image: null,
  role: "ADMIN",
};
const credentials = { email: " Admin@Example.INVALID ", password: "합성 비밀번호" };
const request = new Request("https://auth.example.invalid/api/auth/callback/credentials", {
  headers: { "x-vercel-forwarded-for": "203.0.113.8" },
});
let release: MockInstance<typeof rateLimit.releaseSuccessfulLogin>;

/** 설치된 Credentials provider의 options에서 실제 앱 callback을 얻으며 판단 로직은 복제하지 않습니다. */
function authorize(input: Record<string, unknown> = credentials) {
  const provider = capture.config?.providers.find(
    (candidate) => typeof candidate !== "function" && candidate.type === "credentials",
  );
  if (!provider || typeof provider === "function" || provider.type !== "credentials") {
    throw new Error("실제 credentials provider가 필요합니다.");
  }
  const callback = provider.options?.authorize;
  if (typeof callback !== "function") throw new Error("실제 credentials authorize가 필요합니다.");
  return callback(input, request);
}

/** 계정 존재 확인·비밀번호 비교·성공 해제가 모두 admission 뒤에만 수행되는지 확인합니다. */
function expectNoCredentialWork() {
  expect(mocks.findMany).not.toHaveBeenCalled();
  expect(mocks.compare).not.toHaveBeenCalled();
  expect(release).not.toHaveBeenCalled();
  expect(mocks.deleteWhere).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.reserve.mockReset().mockResolvedValue({
    blocked: false,
    retryAfterSec: 0,
    reservationId,
  });
  mocks.findMany.mockReset().mockResolvedValue([user]);
  mocks.compare.mockReset().mockResolvedValue(true);
  mocks.deleteWhere.mockReset().mockResolvedValue(undefined);
  release = vi.spyOn(rateLimit, "releaseSuccessfulLogin");
});
afterEach(() => vi.restoreAllMocks());

describe("Web credentials의 예약 후 자원 보호", () => {
  for (const [label, reservation] of [
    ["정책 차단", { blocked: true }],
    ["차단된 저장소 장애", { blocked: true, unavailable: true }],
    ["unavailable만 표시된 결과", { blocked: false, unavailable: true }],
  ] as const) {
    it.each([true, false])(
      `${label}은 계정 존재=%s에도 조회·compare 전에 일반 실패다`,
      async (exists) => {
        mocks.reserve.mockResolvedValue({
          ...reservation,
          retryAfterSec: 900,
          reservationId: null,
        });
        mocks.findMany.mockResolvedValue(exists ? [user] : []);
        // 정답 비교 결과를 합성해도 admission 거부가 먼저이므로 callback이 검사해서는 안 됩니다.
        expect(await authorize()).toBeNull();
        expect(mocks.reserve).toHaveBeenCalledExactlyOnceWith("203.0.113.8", credentials.email);
        expectNoCredentialWork();
      },
    );
  }

  it.each([
    {},
    { email: "", password: "합성 비밀번호" },
    { email: "admin@example.invalid", password: "" },
    { email: 123, password: "합성 비밀번호" },
    { email: "admin@example.invalid", password: 123 },
  ])("빈 값·비문자열 입력은 기존처럼 예약 전 종료한다: %j", async (input) => {
    expect(await authorize(input)).toBeNull();
    expect(mocks.reserve).not.toHaveBeenCalled();
    expectNoCredentialWork();
  });

  it("허용된 정상 로그인은 예약→조회→실 hash 비교→자신의 예약 해제 순서다", async () => {
    expect(await authorize()).toEqual({
      id: user.id,
      name: user.name,
      email: user.email,
      image: user.image,
      role: user.role,
    });
    expect(mocks.reserve).toHaveBeenCalledOnce();
    expect(mocks.findMany).toHaveBeenCalledOnce();
    expect(mocks.compare).toHaveBeenCalledExactlyOnceWith(credentials.password, user.passwordHash);
    expect(release).toHaveBeenCalledExactlyOnceWith(reservationId);
    expect(mocks.reserve.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.findMany.mock.invocationCallOrder[0],
    );
    expect(mocks.findMany.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.compare.mock.invocationCallOrder[0],
    );
    expect(mocks.compare.mock.invocationCallOrder[0]).toBeLessThan(
      release.mock.invocationCallOrder[0],
    );
    const deleted = new PgDialect().sqlToQuery(mocks.deleteWhere.mock.calls[0][0]);
    expect(deleted.sql).toContain('"rate_limit_events"."reservation_id" =');
    expect(deleted.params).toEqual([reservationId]);
  });

  it("허용된 틀린 비밀번호는 비교 1회 후 예약을 남기고 일반 실패다", async () => {
    mocks.compare.mockResolvedValue(false);
    expect(await authorize()).toBeNull();
    expect(mocks.findMany).toHaveBeenCalledOnce();
    expect(mocks.compare).toHaveBeenCalledExactlyOnceWith(credentials.password, user.passwordHash);
    expect(release).not.toHaveBeenCalled();
    expect(mocks.deleteWhere).not.toHaveBeenCalled();
  });

  for (const [label, rows] of [
    ["없는 계정", []],
    ["모호한 계정", [user, { ...user, id: "50800000-0000-4000-8000-000000000003" }]],
    ["비밀번호 없는 소셜 계정", [{ ...user, passwordHash: null }]],
  ] as const) {
    it(`허용된 ${label}은 dummy 비교 1회가 일치해도 로그인하지 않는다`, async () => {
      mocks.findMany.mockResolvedValue(rows);
      expect(await authorize()).toBeNull();
      expect(mocks.findMany).toHaveBeenCalledOnce();
      expect(mocks.compare).toHaveBeenCalledExactlyOnceWith(
        credentials.password,
        expect.stringMatching(/^\$2b\$12\$/),
      );
      expect(release).not.toHaveBeenCalled();
      expect(mocks.deleteWhere).not.toHaveBeenCalled();
    });
  }

  it("빈 hash의 기존 nullish 선택과 최종 거부도 변경하지 않는다", async () => {
    mocks.findMany.mockResolvedValue([{ ...user, passwordHash: "" }]);
    expect(await authorize()).toBeNull();
    expect(mocks.compare).toHaveBeenCalledExactlyOnceWith(credentials.password, "");
    expect(release).not.toHaveBeenCalled();
  });

  it("예약 호출 자체의 예외를 재시도하거나 비밀번호 검사로 우회하지 않는다", async () => {
    const failure = new Error("합성 예약 예외");
    mocks.reserve.mockRejectedValue(failure);
    await expect(authorize()).rejects.toBe(failure);
    expect(mocks.reserve).toHaveBeenCalledOnce();
    expectNoCredentialWork();
  });

  it("허용 후 조회 예외는 compare·해제·사용자 반환으로 이어지지 않는다", async () => {
    const failure = new Error("합성 조회 예외");
    mocks.findMany.mockRejectedValue(failure);
    await expect(authorize()).rejects.toBe(failure);
    expect(mocks.compare).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it("허용 후 compare 예외는 재비교·예약 해제·사용자 반환으로 이어지지 않는다", async () => {
    const failure = new Error("합성 비교 예외");
    mocks.compare.mockRejectedValue(failure);
    await expect(authorize()).rejects.toBe(failure);
    expect(mocks.compare).toHaveBeenCalledOnce();
    expect(release).not.toHaveBeenCalled();
  });

  it("기존 Web helper가 내부 처리한 release DB 오류는 정상 사용자 반환을 유지한다", async () => {
    const failure = new Error("합성 삭제 예외");
    mocks.deleteWhere.mockRejectedValue(failure);
    expect(await authorize()).toMatchObject({ id: user.id, role: user.role });
    expect(release).toHaveBeenCalledExactlyOnceWith(reservationId);
    expect(mocks.logServerError).toHaveBeenCalledExactlyOnceWith(
      "rate-limit/release-login",
      failure,
    );
  });

  it("호출자에게 전파된 release 예외는 내부 catch된 DB 오류와 구별한다", async () => {
    const failure = new Error("합성 외부 해제 예외");
    release.mockRejectedValueOnce(failure);
    await expect(authorize()).rejects.toBe(failure);
    expect(release).toHaveBeenCalledExactlyOnceWith(reservationId);
    expect(mocks.deleteWhere).not.toHaveBeenCalled();
  });
});
