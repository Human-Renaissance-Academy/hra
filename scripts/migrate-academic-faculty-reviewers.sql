-- #161 G2 교수 프로필·로그인 계정 연결과 수업별 과제 검토자 지정, 과제 검토 권한 판정의 추가형 SQL입니다.
-- 정책: docs/ACADEMIC-OPERATIONS-POLICY.md P11 권장안(운영 승인 전 기능 비활성). 교수는 출결 담당자가 아니며
-- 이 파일의 어떤 표·함수도 출결 조회·입력·정정 권한의 근거가 아닙니다(#165 can_record_academic_attendance와 무관).
-- 선행: G1 과제 SQL(#147, public.assignments)과 #165 운영 인력 SQL(학사 운영 관리자 지정 함수).
-- 운영 적용은 docs/developer/database-change-procedure.md 절차와 별도 승인이 선행합니다.
-- 이 파일은 같은 DB에 두 번 적용해도 같은 결과가 되며, 이름만 같은 다른 구조는 수용하지 않고 전체를 롤백합니다.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('hra:academic-faculty-reviewers:v1', 0));

-- 선행 표·함수가 없으면 부분 설치하지 않고 중단합니다.
DO $dependencies$
BEGIN
  IF to_regclass('public.users') IS NULL OR to_regclass('public.faculty') IS NULL
    OR to_regclass('public.schedule_events') IS NULL OR to_regclass('public.schedule_sessions') IS NULL
    OR to_regclass('public.assignments') IS NULL
    OR to_regprocedure('public.require_academic_operations_manager(uuid)') IS NULL
    OR to_regprocedure('public.require_academic_staff_account(uuid)') IS NULL THEN
    RAISE EXCEPTION 'faculty_review_migration_dependency_missing';
  END IF;
END;
$dependencies$;

-- 교수 프로필(faculty) ↔ 로그인 계정(users) 연결. 이메일·이름 일치로 자동 연결하지 않고
-- 학사 운영 관리자가 확인 방식과 확인 근거 참조 UUID를 남겨 기간 단위로 연결합니다. 자기 연결은 금지합니다.
CREATE TABLE IF NOT EXISTS public.academic_faculty_account_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  faculty_id uuid NOT NULL CONSTRAINT academic_faculty_account_links_faculty_fk REFERENCES public.faculty(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL CONSTRAINT academic_faculty_account_links_user_fk REFERENCES public.users(id) ON DELETE RESTRICT,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  verification_method text NOT NULL,
  evidence_reference uuid NOT NULL,
  verified_by_user_id uuid NOT NULL CONSTRAINT academic_faculty_account_links_verified_by_fk REFERENCES public.users(id) ON DELETE RESTRICT,
  ended_by_user_id uuid CONSTRAINT academic_faculty_account_links_ended_by_fk REFERENCES public.users(id) ON DELETE RESTRICT,
  ended_at timestamptz,
  end_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT academic_faculty_account_links_verification_check CHECK (verification_method IN ('IN_PERSON', 'VERIFIED_CONTACT')),
  CONSTRAINT academic_faculty_account_links_period_check CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT academic_faculty_account_links_end_check CHECK (
    (ended_by_user_id IS NULL AND ended_at IS NULL AND end_reason IS NULL)
    OR (ended_by_user_id IS NOT NULL AND ended_at IS NOT NULL AND end_reason IS NOT NULL AND valid_to IS NOT NULL)),
  CONSTRAINT academic_faculty_account_links_reason_check CHECK (end_reason IS NULL OR length(btrim(end_reason)) BETWEEN 1 AND 500),
  CONSTRAINT academic_faculty_account_links_self_check CHECK (verified_by_user_id <> user_id)
);
CREATE INDEX IF NOT EXISTS academic_faculty_account_links_faculty_idx
  ON public.academic_faculty_account_links (faculty_id, valid_from);
CREATE INDEX IF NOT EXISTS academic_faculty_account_links_user_idx
  ON public.academic_faculty_account_links (user_id, valid_from);

-- 수업별 과제 검토자 지정(P11). 수업 일정(schedule_event) 전체 또는 그 안의 세션(schedule_session) 하나를 대상으로 합니다.
-- schedule_sessions.faculty_id(수업 내용 담당 교수)는 지정의 근거가 아니며 자동으로 지정을 만들지 않습니다.
CREATE TABLE IF NOT EXISTS public.academic_class_reviewer_designations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  faculty_id uuid NOT NULL CONSTRAINT academic_class_reviewer_designations_faculty_fk REFERENCES public.faculty(id) ON DELETE RESTRICT,
  schedule_event_id uuid NOT NULL CONSTRAINT academic_class_reviewer_designations_event_fk REFERENCES public.schedule_events(id) ON DELETE RESTRICT,
  schedule_session_id uuid CONSTRAINT academic_class_reviewer_designations_session_fk REFERENCES public.schedule_sessions(id) ON DELETE RESTRICT,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  designated_by_user_id uuid NOT NULL CONSTRAINT academic_class_reviewer_designations_designated_by_fk REFERENCES public.users(id) ON DELETE RESTRICT,
  ended_by_user_id uuid CONSTRAINT academic_class_reviewer_designations_ended_by_fk REFERENCES public.users(id) ON DELETE RESTRICT,
  ended_at timestamptz,
  end_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT academic_class_reviewer_designations_period_check CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT academic_class_reviewer_designations_end_check CHECK (
    (ended_by_user_id IS NULL AND ended_at IS NULL AND end_reason IS NULL)
    OR (ended_by_user_id IS NOT NULL AND ended_at IS NOT NULL AND end_reason IS NOT NULL AND valid_to IS NOT NULL)),
  CONSTRAINT academic_class_reviewer_designations_reason_check CHECK (end_reason IS NULL OR length(btrim(end_reason)) BETWEEN 1 AND 500)
);
CREATE INDEX IF NOT EXISTS academic_class_reviewer_designations_class_idx
  ON public.academic_class_reviewer_designations (schedule_event_id, schedule_session_id, valid_from);
CREATE INDEX IF NOT EXISTS academic_class_reviewer_designations_faculty_idx
  ON public.academic_class_reviewer_designations (faculty_id, valid_from);

-- 연결·해제·지정·지정 종료의 추가 전용 감사. 요청 ID로 재시도를 멱등 처리하고 입력 원문 대신 SHA-256 요약만 둡니다.
CREATE TABLE IF NOT EXISTS public.academic_faculty_review_events (
  request_id uuid PRIMARY KEY,
  action text NOT NULL,
  actor_user_id uuid NOT NULL CONSTRAINT academic_faculty_review_events_actor_fk REFERENCES public.users(id) ON DELETE RESTRICT,
  link_id uuid CONSTRAINT academic_faculty_review_events_link_fk REFERENCES public.academic_faculty_account_links(id) ON DELETE RESTRICT,
  designation_id uuid CONSTRAINT academic_faculty_review_events_designation_fk REFERENCES public.academic_class_reviewer_designations(id) ON DELETE RESTRICT,
  correlation_id uuid NOT NULL,
  payload_digest varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT academic_faculty_review_events_action_check CHECK (action IN ('LINK', 'UNLINK', 'DESIGNATE', 'END_DESIGNATION')),
  CONSTRAINT academic_faculty_review_events_target_check CHECK (
    (action IN ('LINK', 'UNLINK') AND link_id IS NOT NULL AND designation_id IS NULL)
    OR (action IN ('DESIGNATE', 'END_DESIGNATION') AND link_id IS NULL AND designation_id IS NOT NULL)),
  CONSTRAINT academic_faculty_review_events_payload_digest_check CHECK (payload_digest ~ '^[0-9a-f]{64}$')
);

-- 이미 있던 표가 이 파일의 정의와 다르면 자동 보정하지 않고 중단합니다. 컬럼·제약·인덱스·RLS를 실제 catalog로 대조합니다.
DO $shape$
DECLARE
  expected record;
BEGIN
  FOR expected IN SELECT * FROM (VALUES
    ('public.academic_faculty_account_links'::regclass, '[["id","uuid",true,"gen_random_uuid()"],["faculty_id","uuid",true,""],
      ["user_id","uuid",true,""],["valid_from","timestamp with time zone",true,""],["valid_to","timestamp with time zone",false,""],
      ["verification_method","text",true,""],["evidence_reference","uuid",true,""],["verified_by_user_id","uuid",true,""],
      ["ended_by_user_id","uuid",false,""],["ended_at","timestamp with time zone",false,""],["end_reason","text",false,""],
      ["created_at","timestamp with time zone",true,"now()"]]'::jsonb, 10, 3),
    ('public.academic_class_reviewer_designations'::regclass, '[["id","uuid",true,"gen_random_uuid()"],["faculty_id","uuid",true,""],
      ["schedule_event_id","uuid",true,""],["schedule_session_id","uuid",false,""],
      ["valid_from","timestamp with time zone",true,""],["valid_to","timestamp with time zone",false,""],
      ["designated_by_user_id","uuid",true,""],["ended_by_user_id","uuid",false,""],["ended_at","timestamp with time zone",false,""],
      ["end_reason","text",false,""],["created_at","timestamp with time zone",true,"now()"]]'::jsonb, 9, 3),
    ('public.academic_faculty_review_events'::regclass, '[["request_id","uuid",true,""],["action","text",true,""],
      ["actor_user_id","uuid",true,""],["link_id","uuid",false,""],["designation_id","uuid",false,""],
      ["correlation_id","uuid",true,""],["payload_digest","character varying(64)",true,""],
      ["created_at","timestamp with time zone",true,"now()"]]'::jsonb, 7, 1)
  ) AS tables(relation, columns, constraint_count, index_count) LOOP
    IF (SELECT jsonb_agg(jsonb_build_array(a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull,
        COALESCE(pg_get_expr(d.adbin, d.adrelid), '')) ORDER BY a.attnum)
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = expected.relation AND a.attnum > 0 AND NOT a.attisdropped) IS DISTINCT FROM expected.columns THEN
      RAISE EXCEPTION 'faculty_review_migration_column_mismatch';
    END IF;
    -- 이름이 다른 추가 제약·인덱스·RLS나 지연 제약이 있으면 같은 의미라고 보지 않습니다.
    IF (SELECT count(*) FROM pg_constraint WHERE conrelid = expected.relation AND contype <> 'n') <> expected.constraint_count
      OR EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = expected.relation AND contype <> 'n'
        AND (condeferrable OR NOT convalidated))
      OR (SELECT count(*) FROM pg_index WHERE indrelid = expected.relation AND indisvalid AND indisready AND indislive) <> expected.index_count
      OR (SELECT count(*) FROM pg_index WHERE indrelid = expected.relation) <> expected.index_count
      OR EXISTS (SELECT 1 FROM pg_class WHERE oid = expected.relation AND (relkind <> 'r' OR relrowsecurity OR relforcerowsecurity)) THEN
      RAISE EXCEPTION 'faculty_review_migration_structure_mismatch';
    END IF;
  END LOOP;
  -- 키 제약은 이름과 PostgreSQL이 해석한 정의를 함께 비교합니다.
  FOR expected IN SELECT * FROM (VALUES
    ('academic_faculty_account_links', 'academic_faculty_account_links_pkey', 'PRIMARY KEY (id)'),
    ('academic_faculty_account_links', 'academic_faculty_account_links_faculty_fk', 'FOREIGN KEY (faculty_id) REFERENCES faculty(id) ON DELETE RESTRICT'),
    ('academic_faculty_account_links', 'academic_faculty_account_links_user_fk', 'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT'),
    ('academic_faculty_account_links', 'academic_faculty_account_links_verified_by_fk', 'FOREIGN KEY (verified_by_user_id) REFERENCES users(id) ON DELETE RESTRICT'),
    ('academic_faculty_account_links', 'academic_faculty_account_links_ended_by_fk', 'FOREIGN KEY (ended_by_user_id) REFERENCES users(id) ON DELETE RESTRICT'),
    ('academic_class_reviewer_designations', 'academic_class_reviewer_designations_pkey', 'PRIMARY KEY (id)'),
    ('academic_class_reviewer_designations', 'academic_class_reviewer_designations_faculty_fk', 'FOREIGN KEY (faculty_id) REFERENCES faculty(id) ON DELETE RESTRICT'),
    ('academic_class_reviewer_designations', 'academic_class_reviewer_designations_event_fk', 'FOREIGN KEY (schedule_event_id) REFERENCES schedule_events(id) ON DELETE RESTRICT'),
    ('academic_class_reviewer_designations', 'academic_class_reviewer_designations_session_fk', 'FOREIGN KEY (schedule_session_id) REFERENCES schedule_sessions(id) ON DELETE RESTRICT'),
    ('academic_class_reviewer_designations', 'academic_class_reviewer_designations_designated_by_fk', 'FOREIGN KEY (designated_by_user_id) REFERENCES users(id) ON DELETE RESTRICT'),
    ('academic_class_reviewer_designations', 'academic_class_reviewer_designations_ended_by_fk', 'FOREIGN KEY (ended_by_user_id) REFERENCES users(id) ON DELETE RESTRICT'),
    ('academic_faculty_review_events', 'academic_faculty_review_events_pkey', 'PRIMARY KEY (request_id)'),
    ('academic_faculty_review_events', 'academic_faculty_review_events_actor_fk', 'FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT'),
    ('academic_faculty_review_events', 'academic_faculty_review_events_link_fk', 'FOREIGN KEY (link_id) REFERENCES academic_faculty_account_links(id) ON DELETE RESTRICT'),
    ('academic_faculty_review_events', 'academic_faculty_review_events_designation_fk', 'FOREIGN KEY (designation_id) REFERENCES academic_class_reviewer_designations(id) ON DELETE RESTRICT')
  ) AS definitions(relation, name, definition) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = ('public.' || expected.relation)::regclass
      AND c.conname = expected.name AND pg_get_constraintdef(c.oid) = expected.definition) THEN
      RAISE EXCEPTION 'faculty_review_migration_constraint_mismatch';
    END IF;
  END LOOP;
  -- 조회·잠금 경로가 기대하는 보조 인덱스의 열 구성도 확인합니다.
  FOR expected IN SELECT * FROM (VALUES
    ('academic_faculty_account_links_faculty_idx', 'academic_faculty_account_links', '(faculty_id, valid_from)'),
    ('academic_faculty_account_links_user_idx', 'academic_faculty_account_links', '(user_id, valid_from)'),
    ('academic_class_reviewer_designations_class_idx', 'academic_class_reviewer_designations', '(schedule_event_id, schedule_session_id, valid_from)'),
    ('academic_class_reviewer_designations_faculty_idx', 'academic_class_reviewer_designations', '(faculty_id, valid_from)')
  ) AS indexes(name, relation, columns) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indrelid = ('public.' || expected.relation)::regclass AND c.relname = expected.name
        AND NOT i.indisunique AND i.indpred IS NULL AND i.indexprs IS NULL
        AND pg_get_indexdef(i.indexrelid) LIKE '% USING btree ' || expected.columns) THEN
      RAISE EXCEPTION 'faculty_review_migration_index_mismatch';
    END IF;
  END LOOP;
END;
$shape$;

-- CHECK 식은 버전마다 출력 형식이 달라질 수 있어 같은 정의로 만든 임시 표의 파서 결과와 비교합니다.
CREATE TEMP TABLE academic_faculty_review_expected_link_checks (
  verification_method text, valid_from timestamptz, valid_to timestamptz, ended_by_user_id uuid, ended_at timestamptz,
  end_reason text, verified_by_user_id uuid, user_id uuid,
  CONSTRAINT academic_faculty_account_links_verification_check CHECK (verification_method IN ('IN_PERSON', 'VERIFIED_CONTACT')),
  CONSTRAINT academic_faculty_account_links_period_check CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT academic_faculty_account_links_end_check CHECK (
    (ended_by_user_id IS NULL AND ended_at IS NULL AND end_reason IS NULL)
    OR (ended_by_user_id IS NOT NULL AND ended_at IS NOT NULL AND end_reason IS NOT NULL AND valid_to IS NOT NULL)),
  CONSTRAINT academic_faculty_account_links_reason_check CHECK (end_reason IS NULL OR length(btrim(end_reason)) BETWEEN 1 AND 500),
  CONSTRAINT academic_faculty_account_links_self_check CHECK (verified_by_user_id <> user_id)
) ON COMMIT DROP;
CREATE TEMP TABLE academic_faculty_review_expected_designation_checks (
  valid_from timestamptz, valid_to timestamptz, ended_by_user_id uuid, ended_at timestamptz, end_reason text,
  CONSTRAINT academic_class_reviewer_designations_period_check CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT academic_class_reviewer_designations_end_check CHECK (
    (ended_by_user_id IS NULL AND ended_at IS NULL AND end_reason IS NULL)
    OR (ended_by_user_id IS NOT NULL AND ended_at IS NOT NULL AND end_reason IS NOT NULL AND valid_to IS NOT NULL)),
  CONSTRAINT academic_class_reviewer_designations_reason_check CHECK (end_reason IS NULL OR length(btrim(end_reason)) BETWEEN 1 AND 500)
) ON COMMIT DROP;
CREATE TEMP TABLE academic_faculty_review_expected_event_checks (
  action text, link_id uuid, designation_id uuid, payload_digest varchar(64),
  CONSTRAINT academic_faculty_review_events_action_check CHECK (action IN ('LINK', 'UNLINK', 'DESIGNATE', 'END_DESIGNATION')),
  CONSTRAINT academic_faculty_review_events_target_check CHECK (
    (action IN ('LINK', 'UNLINK') AND link_id IS NOT NULL AND designation_id IS NULL)
    OR (action IN ('DESIGNATE', 'END_DESIGNATION') AND link_id IS NULL AND designation_id IS NOT NULL)),
  CONSTRAINT academic_faculty_review_events_payload_digest_check CHECK (payload_digest ~ '^[0-9a-f]{64}$')
) ON COMMIT DROP;
DO $checks$
DECLARE
  pair record;
BEGIN
  FOR pair IN SELECT * FROM (VALUES
    ('public.academic_faculty_account_links'::regclass, 'pg_temp.academic_faculty_review_expected_link_checks'::regclass),
    ('public.academic_class_reviewer_designations'::regclass, 'pg_temp.academic_faculty_review_expected_designation_checks'::regclass),
    ('public.academic_faculty_review_events'::regclass, 'pg_temp.academic_faculty_review_expected_event_checks'::regclass)
  ) AS pairs(actual, expected) LOOP
    IF (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname)
        FROM pg_constraint WHERE conrelid = pair.actual AND contype = 'c')
      IS DISTINCT FROM (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname)
        FROM pg_constraint WHERE conrelid = pair.expected AND contype = 'c') THEN
      RAISE EXCEPTION 'faculty_review_migration_check_mismatch';
    END IF;
  END LOOP;
END;
$checks$;

COMMENT ON TABLE public.academic_faculty_account_links IS
  '#161 교수 프로필↔로그인 계정의 검증된 기간 연결. 교수·계정마다 동시 유효 1건. 출결 권한 근거 아님. 종료 시각 기록 외 수정·삭제 금지.';
COMMENT ON TABLE public.academic_class_reviewer_designations IS
  '#161 수업(일정·세션)별 과제 검토 교수 지정. schedule_sessions.faculty_id와 별개이며 출결 권한 근거 아님. 종료 시각 기록 외 수정·삭제 금지.';
COMMENT ON TABLE public.academic_faculty_review_events IS
  '#161 교수 계정 연결·검토자 지정의 추가 전용 감사와 요청 멱등성. 사유 원문 대신 요약값만 저장.';

-- 연결·지정 행의 불변성과 동시 유효 중복 금지를 모든 쓰기 경로에서 검사합니다.
-- 종료(valid_to를 앞당기고 종료자·시각·사유를 한 번 기록)만 허용하며, 삭제는 승인된 파기 절차가 생기기 전까지 막습니다.
CREATE OR REPLACE FUNCTION public.guard_academic_faculty_review_period() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $guard$
DECLARE
  candidate tstzrange;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE SQLSTATE 'HRA04' USING MESSAGE = '교수 검토 권한 기록은 삭제할 수 없습니다.';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- 종료 관련 네 필드 외의 값이 바뀌거나 이미 종료된 행을 다시 바꾸면 거부합니다.
    IF to_jsonb(NEW) - ARRAY['valid_to', 'ended_by_user_id', 'ended_at', 'end_reason']
        IS DISTINCT FROM to_jsonb(OLD) - ARRAY['valid_to', 'ended_by_user_id', 'ended_at', 'end_reason']
      OR OLD.ended_by_user_id IS NOT NULL OR NEW.ended_by_user_id IS NULL OR NEW.valid_to IS NULL
      OR (OLD.valid_to IS NOT NULL AND NEW.valid_to > OLD.valid_to) THEN
      RAISE SQLSTATE 'HRA04' USING MESSAGE = '교수 검토 권한 기록은 종료 시각 기록 외에 변경할 수 없습니다.';
    END IF;
    -- 소급 종료는 과거 검토의 권한 근거를 사후에 바꾸므로 함수 밖 직접 UPDATE도 현재 시각 이전 종료를 거부합니다.
    IF NEW.valid_to < now() THEN
      RAISE SQLSTATE 'HRA07' USING MESSAGE = '종료 시각은 현재 이후여야 합니다.';
    END IF;
    RETURN NEW;
  END IF;
  -- 신규 행: 앞선 커밋까지 보는 READ COMMITTED에서만 잠금 후 재조회가 중복 금지를 보장합니다.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE SQLSTATE 'HRA07' USING MESSAGE = '교수 검토 권한은 READ COMMITTED 트랜잭션에서만 기록합니다.';
  END IF;
  IF NEW.ended_by_user_id IS NOT NULL OR NEW.ended_at IS NOT NULL OR NEW.end_reason IS NOT NULL
    OR (NEW.valid_to IS NOT NULL AND NEW.valid_to <= NEW.valid_from) THEN
    RAISE SQLSTATE 'HRA07' USING MESSAGE = '새 교수 검토 권한 기록의 기간이 올바르지 않습니다.';
  END IF;
  candidate := tstzrange(NEW.valid_from, NEW.valid_to, '[)');
  -- 교수 단위 잠금을 먼저, 계정 단위 잠금을 나중에 잡는 고정 순서로 교착 없이 직렬화합니다.
  PERFORM pg_advisory_xact_lock(hashtextextended('hra:academic-faculty-review:faculty:' || NEW.faculty_id::text, 0));
  IF TG_TABLE_NAME = 'academic_faculty_account_links' THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('hra:academic-faculty-review:user:' || NEW.user_id::text, 0));
    -- 한 교수 프로필에는 동시에 하나의 계정, 한 계정에는 동시에 하나의 교수 프로필만 연결합니다.
    IF EXISTS (SELECT 1 FROM public.academic_faculty_account_links l WHERE l.faculty_id = NEW.faculty_id
      AND tstzrange(l.valid_from, l.valid_to, '[)') && candidate) THEN
      RAISE SQLSTATE '23P01' USING MESSAGE = '같은 교수 프로필의 계정 연결 기간이 겹칩니다.';
    END IF;
    IF EXISTS (SELECT 1 FROM public.academic_faculty_account_links l WHERE l.user_id = NEW.user_id
      AND tstzrange(l.valid_from, l.valid_to, '[)') && candidate) THEN
      RAISE SQLSTATE '23P01' USING MESSAGE = '같은 계정의 교수 프로필 연결 기간이 겹칩니다.';
    END IF;
    RETURN NEW;
  END IF;
  -- 같은 교수·같은 수업 대상의 지정 기간 중복을 막습니다. 한 수업에 여러 교수를 지정하는 것은 허용합니다.
  IF EXISTS (SELECT 1 FROM public.academic_class_reviewer_designations d WHERE d.faculty_id = NEW.faculty_id
    AND d.schedule_event_id = NEW.schedule_event_id AND d.schedule_session_id IS NOT DISTINCT FROM NEW.schedule_session_id
    AND tstzrange(d.valid_from, d.valid_to, '[)') && candidate) THEN
    RAISE SQLSTATE '23P01' USING MESSAGE = '같은 교수의 같은 수업 검토자 지정 기간이 겹칩니다.';
  END IF;
  RETURN NEW;
END;
$guard$;

-- 감사 기록은 추가만 허용합니다.
CREATE OR REPLACE FUNCTION public.guard_academic_faculty_review_events() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $events$
BEGIN
  RAISE SQLSTATE 'HRA04' USING MESSAGE = '교수 검토 권한 감사 기록은 수정·삭제할 수 없습니다.';
END;
$events$;

DROP TRIGGER IF EXISTS academic_faculty_account_links_guard ON public.academic_faculty_account_links;
CREATE TRIGGER academic_faculty_account_links_guard BEFORE INSERT OR UPDATE OR DELETE ON public.academic_faculty_account_links
  FOR EACH ROW EXECUTE FUNCTION public.guard_academic_faculty_review_period();
DROP TRIGGER IF EXISTS academic_faculty_account_links_truncate_guard ON public.academic_faculty_account_links;
CREATE TRIGGER academic_faculty_account_links_truncate_guard BEFORE TRUNCATE ON public.academic_faculty_account_links
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_academic_faculty_review_events();
DROP TRIGGER IF EXISTS academic_class_reviewer_designations_guard ON public.academic_class_reviewer_designations;
CREATE TRIGGER academic_class_reviewer_designations_guard BEFORE INSERT OR UPDATE OR DELETE ON public.academic_class_reviewer_designations
  FOR EACH ROW EXECUTE FUNCTION public.guard_academic_faculty_review_period();
DROP TRIGGER IF EXISTS academic_class_reviewer_designations_truncate_guard ON public.academic_class_reviewer_designations;
CREATE TRIGGER academic_class_reviewer_designations_truncate_guard BEFORE TRUNCATE ON public.academic_class_reviewer_designations
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_academic_faculty_review_events();
DROP TRIGGER IF EXISTS academic_faculty_review_events_guard ON public.academic_faculty_review_events;
CREATE TRIGGER academic_faculty_review_events_guard BEFORE UPDATE OR DELETE ON public.academic_faculty_review_events
  FOR EACH ROW EXECUTE FUNCTION public.guard_academic_faculty_review_events();
DROP TRIGGER IF EXISTS academic_faculty_review_events_truncate_guard ON public.academic_faculty_review_events;
CREATE TRIGGER academic_faculty_review_events_truncate_guard BEFORE TRUNCATE ON public.academic_faculty_review_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_academic_faculty_review_events();

-- 이 파일이 만든 트리거 외의 사용자 트리거(비활성·replica·always 포함)가 있거나 보호 트리거가 꺼져 있으면 중단합니다.
DO $triggers$
BEGIN
  IF (SELECT array_agg(c.relname::text || ':' || t.tgname::text || ':' || p.proname::text || ':' || t.tgenabled::text
        ORDER BY c.relname, t.tgname)
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE NOT t.tgisinternal AND c.oid IN ('public.academic_faculty_account_links'::regclass,
        'public.academic_class_reviewer_designations'::regclass, 'public.academic_faculty_review_events'::regclass))
    IS DISTINCT FROM ARRAY[
      'academic_class_reviewer_designations:academic_class_reviewer_designations_guard:guard_academic_faculty_review_period:O',
      'academic_class_reviewer_designations:academic_class_reviewer_designations_truncate_guard:guard_academic_faculty_review_events:O',
      'academic_faculty_account_links:academic_faculty_account_links_guard:guard_academic_faculty_review_period:O',
      'academic_faculty_account_links:academic_faculty_account_links_truncate_guard:guard_academic_faculty_review_events:O',
      'academic_faculty_review_events:academic_faculty_review_events_guard:guard_academic_faculty_review_events:O',
      'academic_faculty_review_events:academic_faculty_review_events_truncate_guard:guard_academic_faculty_review_events:O'] THEN
    RAISE EXCEPTION 'faculty_review_migration_trigger_mismatch';
  END IF;
END;
$triggers$;

-- 요청 멱등성: 같은 요청 ID는 같은 주체·행위·입력일 때만 이전 결과를 돌려주고, 다르면 HRA02로 거부합니다.
CREATE OR REPLACE FUNCTION public.academic_faculty_review_replay(
  p_request_id uuid, p_actor_id uuid, p_action text, p_digest text
) RETURNS public.academic_faculty_review_events
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $replay$
DECLARE
  prior public.academic_faculty_review_events;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('hra:academic-faculty-review-request:' || p_request_id::text, 0));
  SELECT * INTO prior FROM public.academic_faculty_review_events WHERE request_id = p_request_id;
  IF FOUND AND (prior.actor_user_id <> p_actor_id OR prior.action <> p_action OR prior.payload_digest <> p_digest) THEN
    RAISE SQLSTATE 'HRA02' USING MESSAGE = '같은 요청 ID를 다른 변경에 사용할 수 없습니다.';
  END IF;
  RETURN prior;
END;
$replay$;

-- 학사 운영 관리자가 교수 프로필과 검증된 로그인 계정을 연결합니다. 자기 연결·소급 시작·PENDING 계정은 거부합니다.
CREATE OR REPLACE FUNCTION public.link_academic_faculty_account(
  p_request_id uuid, p_actor_id uuid, p_correlation_id uuid, p_faculty_id uuid, p_user_id uuid,
  p_valid_from timestamptz, p_valid_to timestamptz, p_verification_method text, p_evidence_reference uuid
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $link$
DECLARE
  digest text;
  prior public.academic_faculty_review_events;
  link public.academic_faculty_account_links;
  starts timestamptz := COALESCE(p_valid_from, now());
BEGIN
  IF p_request_id IS NULL OR p_actor_id IS NULL OR p_correlation_id IS NULL OR p_faculty_id IS NULL
    OR p_user_id IS NULL OR p_evidence_reference IS NULL OR p_verification_method IS NULL
    OR p_verification_method NOT IN ('IN_PERSON', 'VERIFIED_CONTACT')
    OR starts < now() OR (p_valid_to IS NOT NULL AND p_valid_to <= starts) THEN
    RAISE SQLSTATE 'HRA07' USING MESSAGE = '교수 계정 연결 입력이 올바르지 않습니다.';
  END IF;
  IF p_actor_id = p_user_id THEN
    RAISE SQLSTATE 'HRA01' USING MESSAGE = '자기 계정을 교수 프로필에 연결할 수 없습니다.';
  END IF;
  digest := encode(sha256(convert_to(jsonb_build_array('LINK', p_faculty_id, p_user_id, p_valid_from, p_valid_to,
    p_verification_method, p_evidence_reference)::text, 'UTF8')), 'hex');
  prior := public.academic_faculty_review_replay(p_request_id, p_actor_id, 'LINK', digest);
  IF prior.request_id IS NOT NULL THEN
    SELECT * INTO link FROM public.academic_faculty_account_links WHERE id = prior.link_id;
    RETURN jsonb_build_object('link', to_jsonb(link), 'replayed', true);
  END IF;
  PERFORM public.require_academic_operations_manager(p_actor_id);
  PERFORM public.require_academic_staff_account(p_user_id);
  PERFORM 1 FROM public.faculty f WHERE f.id = p_faculty_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE SQLSTATE 'HRA03' USING MESSAGE = '교수 프로필을 찾을 수 없습니다.'; END IF;
  INSERT INTO public.academic_faculty_account_links (faculty_id, user_id, valid_from, valid_to, verification_method,
    evidence_reference, verified_by_user_id)
    VALUES (p_faculty_id, p_user_id, starts, p_valid_to, p_verification_method, p_evidence_reference, p_actor_id)
    RETURNING * INTO link;
  INSERT INTO public.academic_faculty_review_events (request_id, action, actor_user_id, link_id, correlation_id, payload_digest)
    VALUES (p_request_id, 'LINK', p_actor_id, link.id, p_correlation_id, digest);
  RETURN jsonb_build_object('link', to_jsonb(link), 'replayed', false);
END;
$link$;

-- 교수 계정 연결 종료(해제). 종료 시각 이후 그 계정의 과제 검토 판정은 즉시 거부됩니다.
CREATE OR REPLACE FUNCTION public.end_academic_faculty_account_link(
  p_request_id uuid, p_actor_id uuid, p_correlation_id uuid, p_link_id uuid, p_effective_at timestamptz, p_reason text
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $unlink$
DECLARE
  digest text;
  prior public.academic_faculty_review_events;
  link public.academic_faculty_account_links;
  ends timestamptz := COALESCE(p_effective_at, now());
BEGIN
  IF p_request_id IS NULL OR p_actor_id IS NULL OR p_correlation_id IS NULL OR p_link_id IS NULL
    OR ends < now() OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN
    RAISE SQLSTATE 'HRA07' USING MESSAGE = '교수 계정 연결 해제 입력이 올바르지 않습니다.';
  END IF;
  digest := encode(sha256(convert_to(jsonb_build_array('UNLINK', p_link_id, p_effective_at, p_reason)::text, 'UTF8')), 'hex');
  prior := public.academic_faculty_review_replay(p_request_id, p_actor_id, 'UNLINK', digest);
  IF prior.request_id IS NOT NULL THEN
    SELECT * INTO link FROM public.academic_faculty_account_links WHERE id = prior.link_id;
    RETURN jsonb_build_object('link', to_jsonb(link), 'replayed', true);
  END IF;
  PERFORM public.require_academic_operations_manager(p_actor_id);
  SELECT * INTO link FROM public.academic_faculty_account_links WHERE id = p_link_id FOR UPDATE;
  IF NOT FOUND THEN RAISE SQLSTATE 'HRA03' USING MESSAGE = '교수 계정 연결을 찾을 수 없습니다.'; END IF;
  IF link.ended_by_user_id IS NOT NULL OR (link.valid_to IS NOT NULL AND link.valid_to <= ends) THEN
    RAISE SQLSTATE 'HRA04' USING MESSAGE = '이미 종료되었거나 그 전에 끝나는 연결입니다.';
  END IF;
  UPDATE public.academic_faculty_account_links SET valid_to = GREATEST(ends, link.valid_from),
    ended_by_user_id = p_actor_id, ended_at = now(), end_reason = btrim(p_reason)
    WHERE id = link.id RETURNING * INTO link;
  INSERT INTO public.academic_faculty_review_events (request_id, action, actor_user_id, link_id, correlation_id, payload_digest)
    VALUES (p_request_id, 'UNLINK', p_actor_id, link.id, p_correlation_id, digest);
  RETURN jsonb_build_object('link', to_jsonb(link), 'replayed', false);
END;
$unlink$;

-- 학사 운영 관리자가 교수 프로필을 특정 수업(일정 전체 또는 그 세션 하나)의 과제 검토자로 지정합니다(P11).
-- 지정 기간 중 관리자 자신과 연결된 교수 프로필은 지정할 수 없습니다(자기 지정 금지).
CREATE OR REPLACE FUNCTION public.designate_academic_class_reviewer(
  p_request_id uuid, p_actor_id uuid, p_correlation_id uuid, p_faculty_id uuid, p_schedule_event_id uuid,
  p_schedule_session_id uuid, p_valid_from timestamptz, p_valid_to timestamptz
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $designate$
DECLARE
  digest text;
  prior public.academic_faculty_review_events;
  designation public.academic_class_reviewer_designations;
  starts timestamptz := COALESCE(p_valid_from, now());
BEGIN
  IF p_request_id IS NULL OR p_actor_id IS NULL OR p_correlation_id IS NULL OR p_faculty_id IS NULL
    OR p_schedule_event_id IS NULL OR starts < now() OR (p_valid_to IS NOT NULL AND p_valid_to <= starts) THEN
    RAISE SQLSTATE 'HRA07' USING MESSAGE = '과제 검토자 지정 입력이 올바르지 않습니다.';
  END IF;
  digest := encode(sha256(convert_to(jsonb_build_array('DESIGNATE', p_faculty_id, p_schedule_event_id,
    p_schedule_session_id, p_valid_from, p_valid_to)::text, 'UTF8')), 'hex');
  prior := public.academic_faculty_review_replay(p_request_id, p_actor_id, 'DESIGNATE', digest);
  IF prior.request_id IS NOT NULL THEN
    SELECT * INTO designation FROM public.academic_class_reviewer_designations WHERE id = prior.designation_id;
    RETURN jsonb_build_object('designation', to_jsonb(designation), 'replayed', true);
  END IF;
  PERFORM public.require_academic_operations_manager(p_actor_id);
  PERFORM 1 FROM public.faculty f WHERE f.id = p_faculty_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE SQLSTATE 'HRA03' USING MESSAGE = '교수 프로필을 찾을 수 없습니다.'; END IF;
  PERFORM 1 FROM public.schedule_events e WHERE e.id = p_schedule_event_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE SQLSTATE 'HRA03' USING MESSAGE = '수업 일정을 찾을 수 없습니다.'; END IF;
  IF p_schedule_session_id IS NOT NULL THEN
    PERFORM 1 FROM public.schedule_sessions s WHERE s.id = p_schedule_session_id
      AND s.schedule_event_id = p_schedule_event_id FOR KEY SHARE;
    IF NOT FOUND THEN RAISE SQLSTATE 'HRA03' USING MESSAGE = '해당 수업의 세션을 찾을 수 없습니다.'; END IF;
  END IF;
  -- 같은 교수의 계정 연결과 직렬화한 뒤 관리자 본인 연결 여부를 확인합니다. 판정 함수도 지정자=연결 계정을 제외합니다.
  PERFORM pg_advisory_xact_lock(hashtextextended('hra:academic-faculty-review:faculty:' || p_faculty_id::text, 0));
  IF EXISTS (SELECT 1 FROM public.academic_faculty_account_links l WHERE l.faculty_id = p_faculty_id
    AND l.user_id = p_actor_id AND tstzrange(l.valid_from, l.valid_to, '[)') && tstzrange(starts, p_valid_to, '[)')) THEN
    RAISE SQLSTATE 'HRA01' USING MESSAGE = '자기 계정과 연결된 교수 프로필을 검토자로 지정할 수 없습니다.';
  END IF;
  INSERT INTO public.academic_class_reviewer_designations (faculty_id, schedule_event_id, schedule_session_id,
    valid_from, valid_to, designated_by_user_id)
    VALUES (p_faculty_id, p_schedule_event_id, p_schedule_session_id, starts, p_valid_to, p_actor_id)
    RETURNING * INTO designation;
  INSERT INTO public.academic_faculty_review_events (request_id, action, actor_user_id, designation_id, correlation_id, payload_digest)
    VALUES (p_request_id, 'DESIGNATE', p_actor_id, designation.id, p_correlation_id, digest);
  RETURN jsonb_build_object('designation', to_jsonb(designation), 'replayed', false);
END;
$designate$;

-- 과제 검토자 지정 종료. 종료 시각 이후 해당 수업 과제의 검토 판정은 즉시 거부됩니다.
CREATE OR REPLACE FUNCTION public.end_academic_class_reviewer(
  p_request_id uuid, p_actor_id uuid, p_correlation_id uuid, p_designation_id uuid,
  p_effective_at timestamptz, p_reason text
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $end_designation$
DECLARE
  digest text;
  prior public.academic_faculty_review_events;
  designation public.academic_class_reviewer_designations;
  ends timestamptz := COALESCE(p_effective_at, now());
BEGIN
  IF p_request_id IS NULL OR p_actor_id IS NULL OR p_correlation_id IS NULL OR p_designation_id IS NULL
    OR ends < now() OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN
    RAISE SQLSTATE 'HRA07' USING MESSAGE = '과제 검토자 지정 종료 입력이 올바르지 않습니다.';
  END IF;
  digest := encode(sha256(convert_to(jsonb_build_array('END_DESIGNATION', p_designation_id, p_effective_at, p_reason)::text,
    'UTF8')), 'hex');
  prior := public.academic_faculty_review_replay(p_request_id, p_actor_id, 'END_DESIGNATION', digest);
  IF prior.request_id IS NOT NULL THEN
    SELECT * INTO designation FROM public.academic_class_reviewer_designations WHERE id = prior.designation_id;
    RETURN jsonb_build_object('designation', to_jsonb(designation), 'replayed', true);
  END IF;
  PERFORM public.require_academic_operations_manager(p_actor_id);
  SELECT * INTO designation FROM public.academic_class_reviewer_designations WHERE id = p_designation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE SQLSTATE 'HRA03' USING MESSAGE = '과제 검토자 지정을 찾을 수 없습니다.'; END IF;
  IF designation.ended_by_user_id IS NOT NULL OR (designation.valid_to IS NOT NULL AND designation.valid_to <= ends) THEN
    RAISE SQLSTATE 'HRA04' USING MESSAGE = '이미 종료되었거나 그 전에 끝나는 지정입니다.';
  END IF;
  UPDATE public.academic_class_reviewer_designations SET valid_to = GREATEST(ends, designation.valid_from),
    ended_by_user_id = p_actor_id, ended_at = now(), end_reason = btrim(p_reason)
    WHERE id = designation.id RETURNING * INTO designation;
  INSERT INTO public.academic_faculty_review_events (request_id, action, actor_user_id, designation_id, correlation_id, payload_digest)
    VALUES (p_request_id, 'END_DESIGNATION', p_actor_id, designation.id, p_correlation_id, digest);
  RETURN jsonb_build_object('designation', to_jsonb(designation), 'replayed', false);
END;
$end_designation$;

-- 과제 검토 권한 판정(P11). **DB 현재 시각(now())** 기준으로 다음이 모두 참일 때만 true입니다.
--   1) 계정이 PENDING이 아니고, 2) 그 계정과 유효하게 연결된 교수 프로필이 있으며,
--   3) 그 교수가 과제가 연결된 수업(일정 전체 또는 해당 세션)의 유효한 검토자로 지정되어 있고,
--   4) 지정자가 그 계정 자신이 아니며, 5) 과제가 공개(DRAFT 아님)되었습니다.
-- 수업에 연결되지 않은 과제는 어떤 교수도 검토할 수 없습니다. 홈페이지 ADMIN·FACULTY 역할,
-- schedule_sessions.faculty_id(수업 내용 담당), 학사 운영 관리자 지정, 운영 인력 배정은 판정 근거가 아닙니다.
-- 호출자가 판정 시각을 넘길 수 없게 해 연결 해제·지정 종료 즉시 권한이 끝나도록 합니다.
CREATE OR REPLACE FUNCTION public.can_review_assignment(p_user_id uuid, p_assignment_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $can_review$
  SELECT p_user_id IS NOT NULL AND p_assignment_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.assignments a
    JOIN public.academic_class_reviewer_designations d ON d.schedule_event_id = a.schedule_event_id
      AND (d.schedule_session_id IS NULL OR d.schedule_session_id = a.schedule_session_id)
    JOIN public.academic_faculty_account_links l ON l.faculty_id = d.faculty_id
    JOIN public.users u ON u.id = l.user_id
    WHERE a.id = p_assignment_id AND l.user_id = p_user_id
      AND a.schedule_event_id IS NOT NULL AND a.status::text <> 'DRAFT'
      AND d.valid_from <= now() AND (d.valid_to IS NULL OR now() < d.valid_to)
      AND l.valid_from <= now() AND (l.valid_to IS NULL OR now() < l.valid_to)
      AND d.designated_by_user_id <> l.user_id
      AND u.role::text IN ('ADMIN', 'FACULTY', 'MEMBER'));
$can_review$;

-- 검토 가능한 과제의 메타데이터 목록. 판정은 can_review_assignment 하나로만 수행합니다.
-- 과제 본문 지시사항·제출물·학생 정보는 반환하지 않습니다(제출물 열람은 #162에서 별도 인가).
CREATE OR REPLACE FUNCTION public.list_reviewable_academic_assignments(p_user_id uuid)
RETURNS TABLE (assignment_id uuid, cohort_id uuid, schedule_event_id uuid, schedule_session_id uuid,
  title text, status text, due_at timestamptz)
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $list$
  SELECT a.id, a.cohort_id, a.schedule_event_id, a.schedule_session_id, a.title::text, a.status::text, a.due_at
  FROM public.assignments a
  WHERE p_user_id IS NOT NULL AND a.schedule_event_id IS NOT NULL AND public.can_review_assignment(p_user_id, a.id)
  ORDER BY a.due_at NULLS LAST, a.id;
$list$;

-- 앱 DB 소유 역할만 실행합니다. 임의의 PUBLIC 실행 권한을 제거합니다.
REVOKE ALL ON FUNCTION public.guard_academic_faculty_review_period() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_academic_faculty_review_events() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.academic_faculty_review_replay(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.link_academic_faculty_account(uuid, uuid, uuid, uuid, uuid, timestamptz, timestamptz, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.end_academic_faculty_account_link(uuid, uuid, uuid, uuid, timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.designate_academic_class_reviewer(uuid, uuid, uuid, uuid, uuid, uuid, timestamptz, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.end_academic_class_reviewer(uuid, uuid, uuid, uuid, timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_review_assignment(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_reviewable_academic_assignments(uuid) FROM PUBLIC;

-- 함수를 교체해도 이전 GRANT가 남을 수 있으므로 소유자 외 EXECUTE 권한이 남아 있거나 판정 함수 다중 정의가 있으면 중단합니다.
DO $acl$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('guard_academic_faculty_review_period', 'guard_academic_faculty_review_events',
      'academic_faculty_review_replay', 'link_academic_faculty_account', 'end_academic_faculty_account_link',
      'designate_academic_class_reviewer', 'end_academic_class_reviewer', 'can_review_assignment',
      'list_reviewable_academic_assignments')
      AND (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a
        WHERE a.grantee <> p.proowner AND a.privilege_type = 'EXECUTE'))
  ) OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('can_review_assignment', 'list_reviewable_academic_assignments')) <> 2 THEN
    RAISE EXCEPTION 'faculty_review_migration_function_acl_mismatch';
  END IF;
END;
$acl$;
COMMIT;
