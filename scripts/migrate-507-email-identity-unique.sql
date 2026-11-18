-- #507 이메일 식별키 UNIQUE의 검토 후보입니다. 운영 자동 적용기나 적용 완료 이력이 아닙니다.
-- 대상·충돌 계수·실제 collation/catalog·백업/복구·승인과 #280 gate를 별도로 확인해야 합니다.
-- 기존 exact users_email_unique와 OAuth tuple 제약을 삭제하거나 데이터를 정규화/병합하지 않습니다.
-- 충돌 또는 동명 객체가 있으면 전체 transaction이 실패합니다. IF NOT EXISTS로 정의를 신뢰하지 않습니다.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE UNIQUE INDEX users_email_identity_unique
  ON public.users (lower(btrim(email)));

COMMIT;
