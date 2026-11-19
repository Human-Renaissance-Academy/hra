/**
 * PostgreSQL 원자적 예약 함수를 사용하는 요청 제한 어댑터 (#121).
 * 여러 제한 축을 한 DB 문장에서 잠그고 검사한 뒤 함께 기록합니다.
 * 저장 키에는 원본 IP·이메일 대신 SHA-256 해시만 사용합니다.
 */

import { createHash } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { db } from "@/lib/db";
import { rateLimitEvents } from "@/lib/db/schema";
import { logServerError } from "@/lib/errors";
import {
  APPLICATION_SUBMISSION_DAILY_RATE_LIMIT,
  APPLICATION_SUBMISSION_EMAIL_DAILY_RATE_LIMIT,
  APPLICATION_SUBMISSION_HOURLY_RATE_LIMIT,
  LOGIN_EMAIL_RATE_LIMIT,
  LOGIN_IP_RATE_LIMIT,
  LOGIN_RATE_LIMIT,
  PRESS_VIEW_PAIR_RATE_LIMIT,
  PRESS_VIEW_IP_RATE_LIMIT,
  RESOURCE_READ_BURST_RATE_LIMIT,
  RESOURCE_READ_HOURLY_RATE_LIMIT,
  UPLOAD_RATE_LIMIT,
  normalizeEmailForRateLimit,
} from "@/lib/rate-limit-core";

type LimitAxis = {
  scope: string;
  key: string;
  maxAttempts: number;
  windowMs: number;
};

export type RateLimitReservation = {
  // 모바일 HTTP는 저장소 장애(503)와 정책 차단(429)을 구분합니다. 기존 Web 판단은 그대로입니다.
  unavailable?: boolean;
  blocked: boolean;
  retryAfterSec: number;
  reservationId: string | null;
};

const reservationRowSchema = z.object({
  allowed: z.boolean(),
  retry_after_sec: z.coerce.number().int().nonnegative(),
  reservation_id: z.uuid().nullable(),
});

// 저장소 장애를 정책 차단(429)과 구분해 503으로 응답하는 호출자의 오류 범위입니다.
// 이 범위도 장애 시 blocked=true(fail-closed)는 그대로이며 unavailable만 추가로 표시합니다.
const storageAwareScopes = new Set([
  "rate-limit/reserve-login",
  "rate-limit/reserve-resource-read",
]);

// 축마다 해시 도메인을 분리해 같은 원본 키도 서로 연결되지 않게 합니다.
function hashLimitKey(scope: string, key: string): string {
  return createHash("sha256").update(scope).update("\0").update(key).digest("hex");
}

/** 여러 제한 축을 원자적으로 예약합니다. DB 오류는 제한 우회가 없도록 차단합니다. */
async function reserve(axes: LimitAxis[], errorScope: string): Promise<RateLimitReservation> {
  try {
    const scopes = sql`ARRAY[${sql.join(
      axes.map((axis) => sql`${axis.scope}`),
      sql`, `,
    )}]::text[]`;
    const hashes = sql`ARRAY[${sql.join(
      axes.map((axis) => sql`${hashLimitKey(axis.scope, axis.key)}`),
      sql`, `,
    )}]::text[]`;
    const limits = sql`ARRAY[${sql.join(
      axes.map((axis) => sql`${axis.maxAttempts}`),
      sql`, `,
    )}]::integer[]`;
    const windows = sql`ARRAY[${sql.join(
      axes.map((axis) => sql`${axis.windowMs / 1000}`),
      sql`, `,
    )}]::integer[]`;
    const result = await db.execute(sql`
      SELECT allowed, retry_after_sec, reservation_id
      FROM reserve_rate_limit(${scopes}, ${hashes}, ${limits}, ${windows})
    `);
    const parsed = reservationRowSchema.safeParse(result.rows[0]);
    if (!parsed.success) throw new Error("요청 제한 예약 결과가 올바르지 않습니다.");
    return {
      blocked: !parsed.data.allowed,
      retryAfterSec: parsed.data.retry_after_sec,
      reservationId: parsed.data.reservation_id,
    };
  } catch (error) {
    logServerError(errorScope, error);
    return {
      blocked: true,
      ...(storageAwareScopes.has(errorScope) ? { unavailable: true } : {}),
      retryAfterSec: Math.max(...axes.map((axis) => axis.windowMs / 1000)),
      reservationId: null,
    };
  }
}

/** 로그인 실패의 조합·IP·이메일 독립 상한을 bcrypt 실행 전에 예약합니다. */
export function reserveLoginAttempt(ip: string, rawEmail: unknown): Promise<RateLimitReservation> {
  const email = normalizeEmailForRateLimit(rawEmail);
  const axes: LimitAxis[] = [{ scope: "login-ip", key: ip, ...LOGIN_IP_RATE_LIMIT }];
  if (email) {
    axes.push(
      { scope: "login-pair", key: `${ip}\0${email}`, ...LOGIN_RATE_LIMIT },
      { scope: "login-email", key: email, ...LOGIN_EMAIL_RATE_LIMIT },
    );
  }
  return reserve(axes, "rate-limit/reserve-login").then((reservation) => {
    // 저장소 장애(unavailable)는 reserve()가 이미 오류 로그로 남기므로 정책 차단만 관측합니다.
    if (reservation.blocked && !reservation.unavailable) logLoginBlocked(axes);
    return reservation;
  });
}

/**
 * 로그인 예약이 정책으로 차단됐음을 운영자가 볼 수 있게 서버 로그에 남깁니다 (#508).
 * 기록 필드는 이벤트명·시각·설정된 축 이름·축별 SHA-256 키의 앞 8자리뿐이며 원본 IP·이메일은 남기지 않습니다.
 * DB 예약 함수는 어느 축이 차단했는지 돌려주지 않으므로 차단 축은 기록할 수 없습니다.
 * 앞 8자리는 운영 절차(docs/operations/rate-limits.md)에서 전체 해시와 대조하는 용도입니다.
 */
function logLoginBlocked(axes: LimitAxis[]): void {
  try {
    console.warn("[rate-limit/login-blocked]", {
      event: "LOGIN_RESERVATION_BLOCKED",
      timestamp: new Date().toISOString(),
      axes: axes.map((axis) => axis.scope),
      keyPrefixes: Object.fromEntries(
        axes.map((axis) => [axis.scope, hashLimitKey(axis.scope, axis.key).slice(0, 8)]),
      ),
    });
  } catch {
    // 로그 전송 실패가 로그인 거부 경로를 바꾸지 않게 합니다.
    return;
  }
}

/** 로그인에 성공한 요청의 임시 예약을 삭제해 실패 시도만 상한에 남깁니다. */
export async function releaseSuccessfulLogin(
  reservationId: string | null,
  requireStorage = false,
): Promise<void> {
  if (!reservationId) return;
  try {
    await db.delete(rateLimitEvents).where(eq(rateLimitEvents.reservationId, reservationId));
  } catch (error) {
    // 삭제 실패는 성공한 요청을 실패 카운트에 남길 뿐 제한을 우회시키지 않습니다.
    logServerError("rate-limit/release-login", error);
    // 기존 Web 호출은 최선 노력 정책을 유지하고 모바일은 저장소 장애를 503으로 처리합니다.
    if (requireStorage) throw new Error("LOGIN_RESERVATION_RELEASE_UNAVAILABLE");
  }
}

/** 인증된 이미지 업로드 요청을 파일을 읽기 전에 예약합니다. */
export function reserveUploadAttempt(ip: string): Promise<RateLimitReservation> {
  return reserve(
    [{ scope: "upload-ip", key: ip, ...UPLOAD_RATE_LIMIT }],
    "rate-limit/reserve-upload",
  );
}

/**
 * 공개 기사 클릭의 IP·기사 조합과 전체 IP 예산을 한 SQL에서 함께 예약합니다.
 * 허용된 예약은 증가 저장 실패에도 남겨 반복을 억제하며 로그인처럼 해제하지 않습니다.
 */
export function reservePressView(ip: string, articleId: string): Promise<RateLimitReservation> {
  return reserve(
    [
      { scope: "press-view-pair", key: `${ip}\0${articleId}`, ...PRESS_VIEW_PAIR_RATE_LIMIT },
      { scope: "press-view-ip", key: ip, ...PRESS_VIEW_IP_RATE_LIMIT },
    ],
    "rate-limit/reserve-press-view",
  );
}

/**
 * 인증·역할 확인을 마친 사용자의 자료실 파일·메타데이터 조회 한 건을 예약합니다 (#444).
 * Web 쿠키와 모바일 Bearer, Web 다운로드와 API v1 경로가 같은 사용자 id 키를 공유합니다.
 * 키는 다른 축과 마찬가지로 범위별 SHA-256 해시로만 저장합니다.
 */
export function reserveResourceRead(userId: string): Promise<RateLimitReservation> {
  return reserve(
    [
      { scope: "resource-read-user-minute", key: userId, ...RESOURCE_READ_BURST_RATE_LIMIT },
      { scope: "resource-read-user-hour", key: userId, ...RESOURCE_READ_HOURLY_RATE_LIMIT },
    ],
    "rate-limit/reserve-resource-read",
  );
}

/** 공유 IP 상한을 완화하고 지원자 이메일별 일일 상한을 함께 예약합니다. */
export function reserveApplicationSubmission(
  ip: string,
  rawEmail: unknown,
): Promise<RateLimitReservation> {
  const email = normalizeEmailForRateLimit(rawEmail);
  const axes: LimitAxis[] = [
    { scope: "submission-ip-hour", key: ip, ...APPLICATION_SUBMISSION_HOURLY_RATE_LIMIT },
    { scope: "submission-ip-day", key: ip, ...APPLICATION_SUBMISSION_DAILY_RATE_LIMIT },
  ];
  if (email) {
    axes.push({
      scope: "submission-email-day",
      key: email,
      ...APPLICATION_SUBMISSION_EMAIL_DAILY_RATE_LIMIT,
    });
  }
  return reserve(axes, "rate-limit/reserve-submission");
}
