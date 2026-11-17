/**
 * 인증 이메일·로그인 제한·관리자 seed가 공유하는 순수 입력 정규화입니다.
 * 기존 JS trim/lowercase만 유지하며 별칭·Unicode 정규형·제공자별 규칙을 추가하지 않습니다.
 * PostgreSQL lower(btrim())의 Unicode·공백 처리와 항상 같다는 뜻은 아닙니다.
 */

/** @param {unknown} email 입력 원문이며 비문자열은 기존 제한 helper처럼 빈 값으로 처리합니다. */
export function normalizeEmailIdentity(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}
