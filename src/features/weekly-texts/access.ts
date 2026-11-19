/**
 * 주차별 텍스트 열람 범위 필터 (#441).
 *
 * - 주차별 텍스트는 기수 제한 자료입니다. MEMBER는 DB에 배정된 본인 기수의 텍스트만 열람합니다.
 * - FACULTY·ADMIN은 전체 기수(기수 미지정 포함)를 열람합니다.
 * - 기수 판정은 클라이언트·세션 값이 아니라 조회 시점의 `users.cohort_id` 를 같은 SQL 안에서 읽습니다.
 *   기수가 없거나 기수 미지정 텍스트이면 비교가 참이 되지 않아 MEMBER에게는 없는 자료와 같습니다.
 * - Web 통합 목록·상세·인쇄·다운로드(첨부·사진)와 API v1 목록·상세·파일이 모두 이 조건을 SQL WHERE로 사용합니다.
 *   다른 기수 자료는 403이 아니라 404로 끝나 존재 여부를 드러내지 않습니다.
 * - 알 수 없는 역할·식별자 없는 주체는 허용하지 않습니다. 승인 역할 확인 자체는 호출 측이 먼저 수행합니다.
 */
import { sql } from "drizzle-orm";
import { users, weeklyTexts } from "@/lib/db/schema";

// 인증된 사용자 식별자와 역할을 함께 확인합니다. 역할 문자열만으로는 허용하지 않습니다.
export function weeklyTextReadFilter(user?: { id?: string; role?: string } | null) {
  if (!user?.id) return sql`false`;

  if (user.role === "ADMIN" || user.role === "FACULTY") return sql`true`;
  if (user.role === "MEMBER") {
    // 현재 계정 행의 기수와 텍스트 기수가 같을 때만 참입니다. NULL 비교는 참이 아니므로 미배정·미지정은 제외됩니다.
    return sql`exists (select 1 from ${users} where ${users.id} = ${user.id} and ${users.cohortId} = ${weeklyTexts.cohortId})`;
  }
  return sql`false`;
}
