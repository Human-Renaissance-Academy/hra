// @vitest-environment node
/**
 * OAuth IO 예외가 Auth.js의 실제 오류 wrapper·기본 logger에 도달해도 원문을 노출하지 않는지 검사합니다.
 * 네트워크·DB는 호출하지 않으며 조회/가입/승격 오류와 로그 전송 실패를 합성합니다.
 */
import { AccessDenied } from "@auth/core/errors";
import { afterEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { handleOAuthSignIn, type SignInIO } from "@/lib/auth-signin";
import * as logging from "@/lib/errors";
import { users } from "@/lib/db/schema";

type UserRow = typeof users.$inferSelect;
const fixedMessage = "로그인 정보를 처리하지 못했습니다.";
const sentinels = [
  "oauth-private@example.invalid",
  "PASSWORD_SENTINEL",
  "CAUSE_SENTINEL",
  "SQL_SENTINEL",
  "LOG_SINK_SENTINEL",
];
const bound: UserRow = {
  id: "50700000-0000-4000-8000-000000000001",
  name: "기존 이름",
  email: "kakao_123@oauth.placeholder",
  passwordHash: null,
  role: "MEMBER",
  cohortId: null,
  image: null,
  oauthProvider: "kakao",
  oauthProviderAccountId: "123",
  sessionVersion: 7,
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};
const input = () => ({
  user: { name: "새 이름", email: "verified@example.invalid", image: null },
  account: { provider: "kakao", providerAccountId: "123" },
  profile: {
    kakao_account: {
      email: "verified@example.invalid",
      is_email_valid: true,
      is_email_verified: true,
    },
  },
});

/** 원문·cause·query/params를 함께 가진 실패를 만들어 경계 밖 유출을 확인합니다. */
function privateFailure(code: string) {
  return Object.assign(new Error("SQL_SENTINEL oauth-private@example.invalid PASSWORD_SENTINEL"), {
    code,
    constraint: "unexpected_unique",
    cause: Object.assign(new Error("CAUSE_SENTINEL oauth-private@example.invalid"), {
      query: "SQL_SENTINEL",
      params: ["PASSWORD_SENTINEL"],
    }),
  });
}

/** 바인딩 주체·신규 주체의 정상 IO를 만든 뒤 실패 지점 하나만 바꿉니다. */
function makeIO(boundUser: UserRow | undefined = undefined): SignInIO {
  return {
    findByBinding: vi.fn().mockResolvedValue(boundUser),
    findByEmail: vi.fn().mockResolvedValue(undefined),
    insertNew: vi.fn().mockResolvedValue(undefined),
    updateProfile: vi.fn().mockResolvedValue(undefined),
    promotePlaceholderEmail: vi.fn().mockResolvedValue(false),
  };
}

/** 설치된 Auth.js callback의 AccessDenied(e)와 같은 실제 wrapper 및 기본 logger를 통과시킵니다. */
async function assertAuthBoundary(escaped: unknown, output: MockInstance<typeof console.error>) {
  expect(escaped instanceof Error).toBe(true);
  if (!(escaped instanceof Error)) throw new Error("고정 오류가 필요합니다.");
  expect(escaped.message === fixedMessage).toBe(true);
  expect(escaped.cause === undefined).toBe(true);
  // 설치 JS는 Error를 받지만 상속된 선언은 string만 허용하므로 실제 생성자를 동적으로 호출합니다.
  const wrapped: unknown = Reflect.construct(AccessDenied, [escaped]);
  expect(wrapped instanceof AccessDenied).toBe(true);
  if (!(wrapped instanceof AccessDenied))
    throw new Error("설치 Auth.js 오류 wrapper가 필요합니다.");
  expect(wrapped.cause?.err === escaped).toBe(true);
  const installed: { setLogger(config: { debug: boolean }): { error(error: Error): void } } =
    await import(
      new URL("../../node_modules/@auth/core/lib/utils/logger.js", import.meta.url).href
    );
  installed.setLogger({ debug: false }).error(wrapped);
  const text = JSON.stringify(output.mock.calls) + escaped.message + escaped.stack;
  for (const sentinel of sentinels) expect(text.includes(sentinel)).toBe(false);
}

afterEach(() => vi.restoreAllMocks());

describe("OAuth 예상외 IO 오류의 Auth.js 로그 경계 (#507)", () => {
  for (const [label, step, code] of [
    ["바인딩 조회", "findByBinding", "08006"],
    ["이메일 조회", "findByEmail", "23505"],
    ["가입", "insertNew", "23505"],
    ["프로필", "updateProfile", "08006"],
    ["이메일 승격", "promotePlaceholderEmail", "23505"],
  ] as const) {
    it(`${label}의 원문 대신 cause 없는 고정 오류와 정제 로그만 넘긴다`, async () => {
      const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
      const io = makeIO(
        step === "updateProfile" || step === "promotePlaceholderEmail" ? bound : undefined,
      );
      io[step] = vi.fn().mockRejectedValue(privateFailure(code));
      let escaped: unknown;
      try {
        await handleOAuthSignIn(input(), io);
      } catch (error) {
        escaped = error;
      }
      expect(output.mock.calls.some((call) => call[0] === "[auth/oauth-signin]")).toBe(true);
      await assertAuthBoundary(escaped, output);
    });
  }

  it("기존 safe logger가 console 전송 실패를 처리해도 고정 OAuth 오류를 유지한다", async () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => {
      throw new Error("LOG_SINK_SENTINEL");
    });
    const io = makeIO();
    io.findByEmail = vi.fn().mockRejectedValue(privateFailure("08006"));
    let escaped: unknown;
    try {
      await handleOAuthSignIn(input(), io);
    } catch (error) {
      escaped = error;
    }
    output.mockImplementation(() => undefined);
    await assertAuthBoundary(escaped, output);
  });

  it("safe logger 자체가 실패하더라도 원문 오류나 logger cause를 다시 던지지 않는다", async () => {
    const output = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const sink = vi.spyOn(logging, "logServerError").mockImplementation(() => {
      throw privateFailure("23505");
    });
    const io = makeIO();
    io.insertNew = vi.fn().mockRejectedValue(privateFailure("08006"));
    let escaped: unknown;
    try {
      await handleOAuthSignIn(input(), io);
    } catch (error) {
      escaped = error;
    }
    expect(sink).toHaveBeenCalledOnce();
    await assertAuthBoundary(escaped, output);
  });
});
