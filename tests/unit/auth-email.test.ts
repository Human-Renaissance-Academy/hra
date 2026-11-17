/**
 * 마이페이지에서 실제 이메일과 소셜 로그인 내부 주소를 구분하는 회귀 테스트다.
 */
import { describe, expect, it } from "vitest";
import {
  getDisplayEmail,
  getVerifiedKakaoEmail,
  isOAuthPlaceholderEmail,
  normalizeEmailIdentity,
} from "@/lib/auth-email";
import { normalizeEmailForRateLimit } from "@/lib/rate-limit-core";

describe("공유 이메일 입력 정규화 (#507)", () => {
  it("인증과 기존 요청 제한이 같은 순수 함수 구현을 사용한다", () => {
    expect(normalizeEmailIdentity).toBe(normalizeEmailForRateLimit);
  });

  it.each([
    ["  User+Tag@Example.COM  ", "user+tag@example.com"],
    ["\tİ@Example.COM\u00a0", "i\u0307@example.com"],
    ["u.ser@Gmail.COM", "u.ser@gmail.com"],
    ["Ａ@Example.COM", "ａ@example.com"],
    ["  ", ""],
    [null, ""],
  ])("기존 JS trim/lowercase만 유지한다: %s", (raw, expected) => {
    expect(normalizeEmailIdentity(raw)).toBe(expected);
  });
});

describe("getDisplayEmail", () => {
  it("카카오와 구글 로그인 내부 주소를 표시하지 않는다", () => {
    expect(getDisplayEmail("kakao_123@oauth.placeholder")).toBeNull();
    expect(getDisplayEmail("google_abc@OAUTH.PLACEHOLDER")).toBeNull();
    expect(isOAuthPlaceholderEmail("kakao_123@oauth.placeholder")).toBe(true);
  });

  it("제공받은 실제 이메일 주소는 그대로 표시한다", () => {
    expect(getDisplayEmail("member@example.com")).toBe("member@example.com");
    expect(getDisplayEmail("member@oauth.placeholder.com")).toBe("member@oauth.placeholder.com");
  });

  it("이메일 값이 없으면 미등록 상태로 처리한다", () => {
    expect(getDisplayEmail(null)).toBeNull();
    expect(getDisplayEmail(undefined)).toBeNull();
  });
});

describe("getVerifiedKakaoEmail", () => {
  const profile = {
    kakao_account: {
      email: "member@example.com",
      is_email_valid: true,
      is_email_verified: true,
    },
  };

  it("유효하고 검증된 카카오 주소만 반환한다", () => {
    expect(getVerifiedKakaoEmail(profile, "member@example.com")).toBe("member@example.com");
  });

  it("미검증·무효·불일치·내부 주소는 거부한다", () => {
    expect(getVerifiedKakaoEmail(undefined, "member@example.com")).toBeNull();
    expect(getVerifiedKakaoEmail(profile, "other@example.com")).toBeNull();
    expect(
      getVerifiedKakaoEmail(
        { kakao_account: { ...profile.kakao_account, is_email_verified: false } },
        "member@example.com",
      ),
    ).toBeNull();
    expect(
      getVerifiedKakaoEmail(
        { kakao_account: { ...profile.kakao_account, is_email_valid: false } },
        "member@example.com",
      ),
    ).toBeNull();
    expect(
      getVerifiedKakaoEmail(
        {
          kakao_account: {
            email: "kakao_123@oauth.placeholder",
            is_email_valid: true,
            is_email_verified: true,
          },
        },
        "kakao_123@oauth.placeholder",
      ),
    ).toBeNull();
  });
});
