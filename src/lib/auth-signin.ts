/**
 * OAuth signIn 콜백 본체 (#67, #81)
 *
 * 이 모듈은 `src/lib/auth.ts::signIn` 콜백의 본문을 추출한 것이다.
 *
 * 왜 추출했는가:
 *   auth.ts 는 최상단에서 NextAuth() 를 호출하므로 vitest 에서 import 하면
 *   next-auth 내부의 next/server 참조가 module resolution 을 깨뜨린다. 콜백을
 *   auth.ts 안에서 익명 async function 으로 두면 CI 안에서 IO 조합 (dual SELECT,
 *   INSERT/UPDATE 결정, redirect string) 을 회귀 테스트할 방법이 없다.
 *
 *   이 모듈은 DB IO 를 `SignInIO` 포트로 주입받는 순수 함수 (`handleOAuthSignIn`)
 *   와 실제 drizzle 어댑터 (`createDrizzleSignInIO`) 로 분리한다. 테스트는
 *   포트를 vi.fn() 으로 mock 해서 signIn 콜백의 IO 조합 자체를 검증한다.
 *
 * 회귀 방지 계층 (#67):
 *   1) tests/unit/auth-jwt-session.test.ts (162 tests) — decideOAuthSignIn 결정 트리
 *   2) tests/unit/auth-decision-mirror-parity.test.ts (20 tests) — verify script mirror parity
 *   3) tests/unit/auth-signin-io.test.ts (신규, #81) — signIn 콜백의 IO 조합 자체
 *   4) DB UNIQUE (oauth_provider, oauth_provider_account_id) + CHECK 제약 — fail-closed 안전망
 *   5) scripts/verify-oauth-binding-security.mjs (36 assertions) — 격리 DB 스모크
 *   6) tests/unit/auth-email-identity-postgres.test.ts — 실제 어댑터·seed·식별 인덱스 경합 (#507)
 */

import { and, eq, sql } from "drizzle-orm";
import type { NeonHttpDatabase } from "drizzle-orm/neon-http";
import {
  getDisplayEmail,
  getVerifiedKakaoEmail,
  isOAuthPlaceholderEmail,
  normalizeEmailIdentity,
} from "@/lib/auth-email";
import { decideOAuthSignIn } from "@/lib/auth-session";
import * as schema from "@/lib/db/schema";
import { users } from "@/lib/db/schema";
import { isConstraintViolation } from "@/lib/db/constraint-errors";
import { logServerError } from "@/lib/errors";

type UserRow = typeof users.$inferSelect;
type UserInsert = typeof users.$inferInsert;

/** 같은 이메일 식별키의 알려진 제약만 충돌로 처리하고 다른 DB 오류는 보존합니다. */
function isEmailIdentityConflict(error: unknown): boolean {
  return ["users_email_unique", "users_email_identity_unique"].some((constraint) =>
    isConstraintViolation(error, "23505", constraint),
  );
}

/**
 * SignIn 콜백이 필요로 하는 최소 DB IO 포트 (#81).
 *
 * signIn 콜백은 다음 IO 를 수행한다:
 *   1) (provider, providerAccountId) 튜플로 boundUser SELECT
 *   2) email 로 emailUser SELECT
 *   3) 신규 계정 INSERT (allow-new 결정)
 *   4) 기존 계정 프로필 UPDATE (allow-existing 결정)
 *   5) 검증된 카카오 이메일로 내부 주소를 조건부 UPDATE
 *
 * 이 포트를 통해 handleOAuthSignIn 은 drizzle 객체를 직접 알지 못한다. 테스트는
 * vi.fn() 으로 각 메서드를 mock 하고 어떤 순서 / 어떤 인자로 호출되었는지 assert 한다.
 */
export interface SignInIO {
  findByBinding(provider: string, providerAccountId: string): Promise<UserRow | undefined>;
  // 복수 행은 없음과 구분해 신규 생성·승격을 fail-closed로 막습니다.
  findByEmail(email: string): Promise<UserRow | "ambiguous" | undefined>;
  insertNew(data: UserInsert): Promise<void>;
  updateProfile(id: string, updates: { name?: string; image?: string }): Promise<void>;
  promotePlaceholderEmail(
    id: string,
    placeholderEmail: string,
    verifiedEmail: string,
  ): Promise<boolean>;
}

/**
 * 실제 Neon+Drizzle db 인스턴스를 SignInIO 로 감싸는 어댑터 (#81).
 *
 * 바인딩 제약은 `scripts/verify-oauth-binding-security.mjs` 가 DB에서 검증한다.
 * 이메일 승격은 기존 내부 주소 조건과 email UNIQUE 제약을 함께 사용한다.
 * 단위 테스트는 이 어댑터의 호출 조건 및 결과에 따른 세션 값을 검증한다.
 */
export function createDrizzleSignInIO(db: NeonHttpDatabase<typeof schema>): SignInIO {
  return {
    async findByBinding(provider, providerAccountId) {
      return db.query.users.findFirst({
        where: and(
          eq(users.oauthProvider, provider),
          eq(users.oauthProviderAccountId, providerAccountId),
        ),
      });
    },
    async findByEmail(email) {
      const normalizedEmail = normalizeEmailIdentity(email);
      const matches = await db.query.users.findMany({
        where: sql`lower(btrim(${users.email})) = lower(btrim(${normalizedEmail}))`,
        limit: 2,
      });
      return matches.length > 1 ? "ambiguous" : matches[0];
    },
    async insertNew(data) {
      const email = normalizeEmailIdentity(data.email);
      if (!email) throw new Error("이메일 정보를 확인할 수 없습니다.");
      await db.insert(users).values({ ...data, email });
    },
    async updateProfile(id, updates) {
      await db.update(users).set(updates).where(eq(users.id, id));
    },
    async promotePlaceholderEmail(id, placeholderEmail, verifiedEmail) {
      const email = normalizeEmailIdentity(verifiedEmail);
      // 내부 주소를 가진 동일 사용자만 갱신한다. 중복 주소 경합은 로그인 실패로 번지지 않는다.
      if (!isOAuthPlaceholderEmail(placeholderEmail) || !email || getDisplayEmail(email) === null) {
        return false;
      }

      try {
        const updated = await db
          .update(users)
          .set({ email })
          .where(and(eq(users.id, id), eq(users.email, placeholderEmail)))
          .returning({ id: users.id });
        return updated.length === 1;
      } catch (error) {
        // 이메일 UNIQUE 위반만 건너뛰고, 연결 장애 등 다른 DB 오류는 그대로 전달한다.
        if (isEmailIdentityConflict(error)) {
          return false;
        }
        throw error;
      }
    },
  };
}

/**
 * signIn 콜백이 받는 최소 입력 shape (#81).
 *
 * NextAuth v5 의 signIn callback param 은 { user, account, profile, credentials, ...} 이지만
 * 이 함수는 user/account와 카카오 이메일 검증 상태가 담긴 profile만 사용한다.
 * user 는 provider 가 반환한 raw 사용자 정보 (email/name/image 는 null 이거나 없을 수 있음).
 */
export interface OAuthSignInInput {
  user: {
    name?: string | null;
    email?: string | null;
    image?: string | null;
  };
  account: {
    provider: string;
    providerAccountId: string;
  };
  profile?: unknown;
}

/**
 * OAuth signIn 콜백 본체 (#67, #81).
 *
 * 반환값 규약 (@auth/core signIn action 처리 규약):
 *   - true → 인증 통과, 세션 생성.
 *   - false → 인증 거부, 세션 미생성 (기본 에러 페이지).
 *   - string → 해당 경로로 redirect (세션 미생성).
 *
 * 결정 트리는 `decideOAuthSignIn` (pure) 에 위임하고, 이 함수는 IO 조합만 담당한다.
 *
 * 부수효과:
 *   `input.user.email` 을 "세션이 가리켜야 할 DB row 의 email" 로 덮어쓴다.
 *     - allow-new: 방금 INSERT 한 email (kakao placeholder 포함).
 *     - allow-existing: boundUser 의 DB email. 검증된 카카오 이메일로 내부 주소의
 *       조건부 UPDATE가 성공한 경우에만 새 DB email을 사용한다.
 *   provider email 은 사용자가 provider 쪽에서 바꿀 수 있으므로, 그 값을 token.email 로
 *   흘려보내면 세션에 다른 사람의 email 이 표시되거나 (과거 구현처럼) 다른 row 로 조회될
 *   수 있다. 세션 조회 자체는 jwt 콜백이 binding 튜플로 수행한다 (pickJwtLookupCriteria).
 */
export async function handleOAuthSignIn(
  input: OAuthSignInInput,
  io: SignInIO,
): Promise<boolean | string> {
  try {
    const { user, account, profile } = input;

    // Kakao는 원문 claim의 정확한 일치·검증 여부를 먼저 확인합니다.
    // 정규화 결과가 같다는 이유로 원문 불일치를 소유권 검증 성공으로 바꾸지 않습니다.
    const rawVerifiedKakaoEmail =
      account.provider === "kakao" ? getVerifiedKakaoEmail(profile, user.email) : null;
    const email = normalizeEmailIdentity(
      user.email || `${account.provider}_${account.providerAccountId}@oauth.placeholder`,
    );
    const [boundUser, emailUser] = await Promise.all([
      io.findByBinding(account.provider, account.providerAccountId),
      email ? io.findByEmail(email) : undefined,
    ]);

    // provider 이메일이 비어도 이미 확인한 tuple은 우선합니다. 신규 계정만 거부합니다.
    if (!boundUser && (!email || emailUser === "ambiguous"))
      return "/login?error=OAuthAccountNotLinked";
    const decision = decideOAuthSignIn({
      boundUser,
      emailUser: emailUser === "ambiguous" ? undefined : emailUser,
    });

    if (decision.kind === "block") {
      return "/login?error=OAuthAccountNotLinked";
    }

    if (decision.kind === "allow-new") {
      try {
        await io.insertNew({
          name:
            user.name?.trim() || (account.provider === "kakao" ? "카카오 사용자" : "구글 사용자"),
          email,
          image: user.image,
          role: "PENDING",
          oauthProvider: account.provider,
          oauthProviderAccountId: account.providerAccountId,
        });
      } catch (error) {
        // 가입 경합으로 이긴 다른 row를 이메일만으로 재인증하거나 자동 바인딩하지 않습니다.
        if (
          isEmailIdentityConflict(error) ||
          isConstraintViolation(error, "23505", "users_oauth_binding_unique")
        ) {
          return "/login?error=OAuthAccountNotLinked";
        }
        throw error;
      }
    } else {
      // allow-existing: boundUser 를 기준으로 프로필만 최신화한다.
      // binding 튜플은 이미 채워져 있으므로 절대 갱신하지 않는다 (race 회피,
      // cross-provider takeover 방지의 핵심).
      const updates: { name?: string; image?: string } = {};

      if (user.name && boundUser && boundUser.name !== user.name) {
        updates.name = user.name;
      }
      if (user.image && boundUser && boundUser.image !== user.image) {
        updates.image = user.image;
      }

      if (Object.keys(updates).length > 0) {
        await io.updateProfile(decision.userId, updates);
      }

      // 이메일 일치만으로 계정을 연결하지 않는다. 이미 인증된 바인딩 계정의 내부 주소만
      // 승격하며, 주소 충돌·미검증·동시 갱신 실패는 기존 주소를 유지한다.
      const verifiedEmail = rawVerifiedKakaoEmail
        ? normalizeEmailIdentity(rawVerifiedKakaoEmail)
        : null;
      if (boundUser && isOAuthPlaceholderEmail(boundUser.email) && verifiedEmail && !emailUser) {
        const promoted = await io.promotePlaceholderEmail(
          decision.userId,
          boundUser.email,
          verifiedEmail,
        );
        if (promoted) {
          boundUser.email = verifiedEmail;
        }
      }
    }

    // allow-existing 이면 인가된 row (boundUser) 의 email 을, allow-new 면 방금 저장한 email 을 심는다.
    user.email = decision.kind === "allow-existing" && boundUser ? boundUser.email : email;
    return true;
  } catch (error) {
    // Auth.js는 callback 예외의 cause/stack을 기록하므로 원문을 새 오류에 복사하지 않습니다.
    const failure = new Error("로그인 정보를 처리하지 못했습니다.");
    try {
      logServerError("auth/oauth-signin", error);
    } catch {
      // 기존 helper가 실패하더라도 logger 오류나 원문이 Auth.js에 도달하지 않게 합니다.
      throw failure;
    }
    throw failure;
  }
}
