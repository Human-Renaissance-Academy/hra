/**
 * Web·모바일 비밀번호 로그인 대상 조회입니다.
 * 입력 대소문자와 양쪽 공백을 무시하되, 같은 주소의 대소문자 변형 계정이
 * 둘 이상 있으면 임의 계정으로 로그인하지 않도록 조회를 거부합니다.
 */
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { users } from "@/lib/db/schema";
import { normalizeEmailIdentity } from "@/lib/email-identity.mjs";

export async function findCredentialUser(rawEmail: string) {
  const normalizedEmail = normalizeEmailIdentity(rawEmail);
  const matches = await db.query.users.findMany({
    // 입력도 같은 PG 식으로 비교해 신규 정규 저장 행과 ASCII legacy 행을 조회합니다.
    where: sql`lower(btrim(${users.email})) = lower(btrim(${normalizedEmail}))`,
    limit: 2,
  });

  return matches.length === 1 ? matches[0] : null;
}
