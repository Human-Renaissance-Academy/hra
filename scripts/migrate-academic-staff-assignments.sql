-- #165 G2 기수별 운영 인력(어드바이저·조교) 배정과 학사 운영 관리자 지정, 출결 권한 판정의 추가형 SQL입니다.
-- 정책: docs/ACADEMIC-OPERATIONS-POLICY.md P1~P4·P10 권장안(운영 승인 전 기능 비활성). G1 SQL(#144~)과 독립적으로
-- users·cohorts만 참조합니다. 운영 적용은 docs/developer/database-change-procedure.md 절차와 별도 승인이 선행합니다.
-- 이 파일은 같은 DB에 두 번 적용해도 같은 결과가 되며, 이름만 같은 다른 구조는 수용하지 않고 전체를 롤백합니다.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('hra:academic-staff-assignments:v1', 0));

-- 학사 운영 관리자 지정. 전역 users.role이 아니라 검증된 계정 ID와 유효 기간으로 부여하는 업무 권한입니다(P1).
-- 지정 주체는 G1 지정 승인자(ACADEMIC_APPROVER_USER_ID)이며 자기 지정은 금지합니다.
CREATE TABLE IF NOT EXISTS public.academic_operations_managers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL CONSTRAINT academic_operations_managers_user_fk REFERENCES public.users(id) ON DELETE RESTRICT,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  verification_method text NOT NULL,
  evidence_reference uuid NOT NULL,
  designated_by_user_id uuid NOT NULL CONSTRAINT academic_operations_managers_designated_by_fk REFERENCES public.users(id) ON DELETE RESTRICT,
  ended_by_user_id uuid CONSTRAINT academic_operations_managers_ended_by_fk REFERENCES public.users(id) ON DELETE RESTRICT,
  ended_at timestamptz,
  end_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT academic_operations_managers_verification_check CHECK (verification_method IN ('IN_PERSON', 'VERIFIED_CONTACT')),
  CONSTRAINT academic_operations_managers_period_check CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT academic_operations_managers_end_check CHECK (
    (ended_by_user_id IS NULL AND ended_at IS NULL AND end_reason IS NULL)
    OR (ended_by_user_id IS NOT NULL AND ended_at IS NOT NULL AND end_reason IS NOT NULL AND valid_to IS NOT NULL)),
  CONSTRAINT academic_operations_managers_reason_check CHECK (end_reason IS NULL OR length(btrim(end_reason)) BETWEEN 1 AND 500),
  CONSTRAINT academic_operations_managers_self_check CHECK (designated_by_user_id <> user_id)
);
CREATE INDEX IF NOT EXISTS academic_operations_managers_user_idx
  ON public.academic_operations_managers (user_id, valid_from);

-- 기수별 운영 인력 기간 배정(P2). 교체는 기존 행 종료 + 새 행 추가이며 과거 행은 종료 시각 기록 외에 바꾸지 않습니다(P3).
CREATE TABLE IF NOT EXISTS public.academic_cohort_staff_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id uuid NOT NULL CONSTRAINT academic_cohort_staff_assignments_cohort_fk REFERENCES public.cohorts(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL CONSTRAINT academic_cohort_staff_assignments_user_fk REFERENCES public.users(id) ON DELETE RESTRICT,
  staff_role text NOT NULL,
  valid_from timestamptz NOT NULL,
  valid_to timestamptz,
  verification_method text NOT NULL,
  evidence_reference uuid NOT NULL,
  assigned_by_user_id uuid NOT NULL CONSTRAINT academic_cohort_staff_assignments_assigned_by_fk REFERENCES public.users(id) ON DELETE RESTRICT,
  replaces_assignment_id uuid CONSTRAINT academic_cohort_staff_assignments_replaces_fk REFERENCES public.academic_cohort_staff_assignments(id) ON DELETE RESTRICT,
  ended_by_user_id uuid CONSTRAINT academic_cohort_staff_assignments_ended_by_fk REFERENCES public.users(id) ON DELETE RESTRICT,
  ended_at timestamptz,
  end_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT academic_cohort_staff_assignments_role_check CHECK (staff_role IN ('ADVISOR', 'ASSISTANT')),
  CONSTRAINT academic_cohort_staff_assignments_verification_check CHECK (verification_method IN ('IN_PERSON', 'VERIFIED_CONTACT')),
  CONSTRAINT academic_cohort_staff_assignments_period_check CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT academic_cohort_staff_assignments_end_check CHECK (
    (ended_by_user_id IS NULL AND ended_at IS NULL AND end_reason IS NULL)
    OR (ended_by_user_id IS NOT NULL AND ended_at IS NOT NULL AND end_reason IS NOT NULL AND valid_to IS NOT NULL)),
  CONSTRAINT academic_cohort_staff_assignments_reason_check CHECK (end_reason IS NULL OR length(btrim(end_reason)) BETWEEN 1 AND 500),
  CONSTRAINT academic_cohort_staff_assignments_self_check CHECK (assigned_by_user_id <> user_id)
);
CREATE INDEX IF NOT EXISTS academic_cohort_staff_assignments_cohort_idx
  ON public.academic_cohort_staff_assignments (cohort_id, staff_role, valid_from);
CREATE INDEX IF NOT EXISTS academic_cohort_staff_assignments_user_idx
  ON public.academic_cohort_staff_assignments (user_id, cohort_id, valid_from);

-- 지정·배정·종료·교체의 추가 전용 감사 기록. 요청 ID로 재시도를 멱등 처리하고 입력 원문 대신 SHA-256 요약만 둡니다.
CREATE TABLE IF NOT EXISTS public.academic_staff_events (
  request_id uuid PRIMARY KEY,
  action text NOT NULL,
  actor_user_id uuid NOT NULL CONSTRAINT academic_staff_events_actor_fk REFERENCES public.users(id) ON DELETE RESTRICT,
  manager_designation_id uuid CONSTRAINT academic_staff_events_manager_fk REFERENCES public.academic_operations_managers(id) ON DELETE RESTRICT,
  assignment_id uuid CONSTRAINT academic_staff_events_assignment_fk REFERENCES public.academic_cohort_staff_assignments(id) ON DELETE RESTRICT,
  replacement_assignment_id uuid CONSTRAINT academic_staff_events_replacement_fk REFERENCES public.academic_cohort_staff_assignments(id) ON DELETE RESTRICT,
  correlation_id uuid NOT NULL,
  payload_digest varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT academic_staff_events_action_check CHECK (action IN ('MANAGER_DESIGNATE', 'MANAGER_END', 'STAFF_ASSIGN', 'STAFF_END', 'STAFF_REPLACE')),
  CONSTRAINT academic_staff_events_target_check CHECK (
    (action IN ('MANAGER_DESIGNATE', 'MANAGER_END') AND manager_designation_id IS NOT NULL AND assignment_id IS NULL AND replacement_assignment_id IS NULL)
    OR (action IN ('STAFF_ASSIGN', 'STAFF_END') AND manager_designation_id IS NULL AND assignment_id IS NOT NULL AND replacement_assignment_id IS NULL)
    OR (action = 'STAFF_REPLACE' AND manager_designation_id IS NULL AND assignment_id IS NOT NULL AND replacement_assignment_id IS NOT NULL)),
  CONSTRAINT academic_staff_events_payload_digest_check CHECK (payload_digest ~ '^[0-9a-f]{64}$')
);

-- 이미 있던 표가 이 파일의 정의와 다르면 자동 보정하지 않고 중단합니다. 컬럼·제약·인덱스·RLS를 실제 catalog로 대조합니다.
DO $shape$
DECLARE
  expected record;
BEGIN
  FOR expected IN SELECT * FROM (VALUES
    ('public.academic_operations_managers'::regclass, '[["id","uuid",true,"gen_random_uuid()"],["user_id","uuid",true,""],
      ["valid_from","timestamp with time zone",true,""],["valid_to","timestamp with time zone",false,""],
      ["verification_method","text",true,""],["evidence_reference","uuid",true,""],["designated_by_user_id","uuid",true,""],
      ["ended_by_user_id","uuid",false,""],["ended_at","timestamp with time zone",false,""],["end_reason","text",false,""],
      ["created_at","timestamp with time zone",true,"now()"]]'::jsonb, 9, 2),
    ('public.academic_cohort_staff_assignments'::regclass, '[["id","uuid",true,"gen_random_uuid()"],["cohort_id","uuid",true,""],
      ["user_id","uuid",true,""],["staff_role","text",true,""],["valid_from","timestamp with time zone",true,""],
      ["valid_to","timestamp with time zone",false,""],["verification_method","text",true,""],["evidence_reference","uuid",true,""],
      ["assigned_by_user_id","uuid",true,""],["replaces_assignment_id","uuid",false,""],["ended_by_user_id","uuid",false,""],
      ["ended_at","timestamp with time zone",false,""],["end_reason","text",false,""],
      ["created_at","timestamp with time zone",true,"now()"]]'::jsonb, 12, 3),
    ('public.academic_staff_events'::regclass, '[["request_id","uuid",true,""],["action","text",true,""],
      ["actor_user_id","uuid",true,""],["manager_designation_id","uuid",false,""],["assignment_id","uuid",false,""],
      ["replacement_assignment_id","uuid",false,""],["correlation_id","uuid",true,""],
      ["payload_digest","character varying(64)",true,""],["created_at","timestamp with time zone",true,"now()"]]'::jsonb, 8, 1)
  ) AS tables(relation, columns, constraint_count, index_count) LOOP
    IF (SELECT jsonb_agg(jsonb_build_array(a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull,
        COALESCE(pg_get_expr(d.adbin, d.adrelid), '')) ORDER BY a.attnum)
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = expected.relation AND a.attnum > 0 AND NOT a.attisdropped) IS DISTINCT FROM expected.columns THEN
      RAISE EXCEPTION 'staff_migration_column_mismatch';
    END IF;
    -- 이름이 다른 추가 제약·인덱스·RLS나 지연 제약이 있으면 같은 의미라고 보지 않습니다.
    IF (SELECT count(*) FROM pg_constraint WHERE conrelid = expected.relation AND contype <> 'n') <> expected.constraint_count
      OR EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = expected.relation AND contype <> 'n'
        AND (condeferrable OR NOT convalidated))
      OR (SELECT count(*) FROM pg_index WHERE indrelid = expected.relation AND indisvalid AND indisready AND indislive) <> expected.index_count
      OR (SELECT count(*) FROM pg_index WHERE indrelid = expected.relation) <> expected.index_count
      OR EXISTS (SELECT 1 FROM pg_class WHERE oid = expected.relation AND (relkind <> 'r' OR relrowsecurity OR relforcerowsecurity)) THEN
      RAISE EXCEPTION 'staff_migration_structure_mismatch';
    END IF;
  END LOOP;
  -- 제약 정의는 이름과 PostgreSQL이 해석한 정의를 함께 비교합니다.
  FOR expected IN SELECT * FROM (VALUES
    ('academic_operations_managers', 'academic_operations_managers_pkey', 'PRIMARY KEY (id)'),
    ('academic_operations_managers', 'academic_operations_managers_user_fk', 'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT'),
    ('academic_operations_managers', 'academic_operations_managers_designated_by_fk', 'FOREIGN KEY (designated_by_user_id) REFERENCES users(id) ON DELETE RESTRICT'),
    ('academic_operations_managers', 'academic_operations_managers_ended_by_fk', 'FOREIGN KEY (ended_by_user_id) REFERENCES users(id) ON DELETE RESTRICT'),
    ('academic_cohort_staff_assignments', 'academic_cohort_staff_assignments_pkey', 'PRIMARY KEY (id)'),
    ('academic_cohort_staff_assignments', 'academic_cohort_staff_assignments_cohort_fk', 'FOREIGN KEY (cohort_id) REFERENCES cohorts(id) ON DELETE RESTRICT'),
    ('academic_cohort_staff_assignments', 'academic_cohort_staff_assignments_user_fk', 'FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT'),
    ('academic_cohort_staff_assignments', 'academic_cohort_staff_assignments_assigned_by_fk', 'FOREIGN KEY (assigned_by_user_id) REFERENCES users(id) ON DELETE RESTRICT'),
    ('academic_cohort_staff_assignments', 'academic_cohort_staff_assignments_replaces_fk', 'FOREIGN KEY (replaces_assignment_id) REFERENCES academic_cohort_staff_assignments(id) ON DELETE RESTRICT'),
    ('academic_cohort_staff_assignments', 'academic_cohort_staff_assignments_ended_by_fk', 'FOREIGN KEY (ended_by_user_id) REFERENCES users(id) ON DELETE RESTRICT'),
    ('academic_staff_events', 'academic_staff_events_pkey', 'PRIMARY KEY (request_id)'),
    ('academic_staff_events', 'academic_staff_events_actor_fk', 'FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT'),
    ('academic_staff_events', 'academic_staff_events_manager_fk', 'FOREIGN KEY (manager_designation_id) REFERENCES academic_operations_managers(id) ON DELETE RESTRICT'),
    ('academic_staff_events', 'academic_staff_events_assignment_fk', 'FOREIGN KEY (assignment_id) REFERENCES academic_cohort_staff_assignments(id) ON DELETE RESTRICT'),
    ('academic_staff_events', 'academic_staff_events_replacement_fk', 'FOREIGN KEY (replacement_assignment_id) REFERENCES academic_cohort_staff_assignments(id) ON DELETE RESTRICT')
  ) AS definitions(relation, name, definition) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = ('public.' || expected.relation)::regclass
      AND c.conname = expected.name AND pg_get_constraintdef(c.oid) = expected.definition) THEN
      RAISE EXCEPTION 'staff_migration_constraint_mismatch';
    END IF;
  END LOOP;
  -- 조회·잠금 경로가 기대하는 보조 인덱스의 열 구성도 확인합니다.
  FOR expected IN SELECT * FROM (VALUES
    ('academic_operations_managers_user_idx', 'academic_operations_managers', '(user_id, valid_from)'),
    ('academic_cohort_staff_assignments_cohort_idx', 'academic_cohort_staff_assignments', '(cohort_id, staff_role, valid_from)'),
    ('academic_cohort_staff_assignments_user_idx', 'academic_cohort_staff_assignments', '(user_id, cohort_id, valid_from)')
  ) AS indexes(name, relation, columns) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indrelid = ('public.' || expected.relation)::regclass AND c.relname = expected.name
        AND NOT i.indisunique AND i.indpred IS NULL AND i.indexprs IS NULL
        AND pg_get_indexdef(i.indexrelid) LIKE '% USING btree ' || expected.columns) THEN
      RAISE EXCEPTION 'staff_migration_index_mismatch';
    END IF;
  END LOOP;
END;
$shape$;

-- CHECK 식은 버전마다 출력 형식이 달라질 수 있어 같은 정의로 만든 임시 표의 파서 결과와 비교합니다.
CREATE TEMP TABLE academic_staff_expected_manager_checks (
  verification_method text, valid_from timestamptz, valid_to timestamptz, ended_by_user_id uuid, ended_at timestamptz,
  end_reason text, designated_by_user_id uuid, user_id uuid,
  CONSTRAINT academic_operations_managers_verification_check CHECK (verification_method IN ('IN_PERSON', 'VERIFIED_CONTACT')),
  CONSTRAINT academic_operations_managers_period_check CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT academic_operations_managers_end_check CHECK (
    (ended_by_user_id IS NULL AND ended_at IS NULL AND end_reason IS NULL)
    OR (ended_by_user_id IS NOT NULL AND ended_at IS NOT NULL AND end_reason IS NOT NULL AND valid_to IS NOT NULL)),
  CONSTRAINT academic_operations_managers_reason_check CHECK (end_reason IS NULL OR length(btrim(end_reason)) BETWEEN 1 AND 500),
  CONSTRAINT academic_operations_managers_self_check CHECK (designated_by_user_id <> user_id)
) ON COMMIT DROP;
CREATE TEMP TABLE academic_staff_expected_assignment_checks (
  staff_role text, verification_method text, valid_from timestamptz, valid_to timestamptz, ended_by_user_id uuid,
  ended_at timestamptz, end_reason text, assigned_by_user_id uuid, user_id uuid,
  CONSTRAINT academic_cohort_staff_assignments_role_check CHECK (staff_role IN ('ADVISOR', 'ASSISTANT')),
  CONSTRAINT academic_cohort_staff_assignments_verification_check CHECK (verification_method IN ('IN_PERSON', 'VERIFIED_CONTACT')),
  CONSTRAINT academic_cohort_staff_assignments_period_check CHECK (valid_to IS NULL OR valid_to >= valid_from),
  CONSTRAINT academic_cohort_staff_assignments_end_check CHECK (
    (ended_by_user_id IS NULL AND ended_at IS NULL AND end_reason IS NULL)
    OR (ended_by_user_id IS NOT NULL AND ended_at IS NOT NULL AND end_reason IS NOT NULL AND valid_to IS NOT NULL)),
  CONSTRAINT academic_cohort_staff_assignments_reason_check CHECK (end_reason IS NULL OR length(btrim(end_reason)) BETWEEN 1 AND 500),
  CONSTRAINT academic_cohort_staff_assignments_self_check CHECK (assigned_by_user_id <> user_id)
) ON COMMIT DROP;
CREATE TEMP TABLE academic_staff_expected_event_checks (
  action text, manager_designation_id uuid, assignment_id uuid, replacement_assignment_id uuid, payload_digest varchar(64),
  CONSTRAINT academic_staff_events_action_check CHECK (action IN ('MANAGER_DESIGNATE', 'MANAGER_END', 'STAFF_ASSIGN', 'STAFF_END', 'STAFF_REPLACE')),
  CONSTRAINT academic_staff_events_target_check CHECK (
    (action IN ('MANAGER_DESIGNATE', 'MANAGER_END') AND manager_designation_id IS NOT NULL AND assignment_id IS NULL AND replacement_assignment_id IS NULL)
    OR (action IN ('STAFF_ASSIGN', 'STAFF_END') AND manager_designation_id IS NULL AND assignment_id IS NOT NULL AND replacement_assignment_id IS NULL)
    OR (action = 'STAFF_REPLACE' AND manager_designation_id IS NULL AND assignment_id IS NOT NULL AND replacement_assignment_id IS NOT NULL)),
  CONSTRAINT academic_staff_events_payload_digest_check CHECK (payload_digest ~ '^[0-9a-f]{64}$')
) ON COMMIT DROP;
DO $checks$
DECLARE
  pair record;
BEGIN
  FOR pair IN SELECT * FROM (VALUES
    ('public.academic_operations_managers'::regclass, 'pg_temp.academic_staff_expected_manager_checks'::regclass),
    ('public.academic_cohort_staff_assignments'::regclass, 'pg_temp.academic_staff_expected_assignment_checks'::regclass),
    ('public.academic_staff_events'::regclass, 'pg_temp.academic_staff_expected_event_checks'::regclass)
  ) AS pairs(actual, expected) LOOP
    IF (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname)
        FROM pg_constraint WHERE conrelid = pair.actual AND contype = 'c')
      IS DISTINCT FROM (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname)
        FROM pg_constraint WHERE conrelid = pair.expected AND contype = 'c') THEN
      RAISE EXCEPTION 'staff_migration_check_mismatch';
    END IF;
  END LOOP;
END;
$checks$;

COMMENT ON TABLE public.academic_operations_managers IS
  '#165 학사 운영 관리자 지정(검증된 계정 ID·유효 기간). 홈페이지 ADMIN 역할과 무관하며 종료 시각 기록 외 수정·삭제 금지.';
COMMENT ON TABLE public.academic_cohort_staff_assignments IS
  '#165 기수별 어드바이저·조교 기간 배정. 교체는 종료+새 행. 동시 유효 ADVISOR 1명·ASSISTANT 2명 상한은 트리거와 기수 잠금으로 보장.';
COMMENT ON TABLE public.academic_staff_events IS
  '#165 운영 인력 지정·배정·종료·교체의 추가 전용 감사와 요청 멱등성. 사유 원문 대신 요약값만 저장.';

-- 지정·배정 행의 불변성과 동시 유효 상한을 모든 쓰기 경로에서 검사합니다.
-- 종료(valid_to를 앞당기고 종료자·시각·사유를 한 번 기록)만 허용하며, 삭제는 승인된 파기 절차가 생기기 전까지 막습니다.
CREATE OR REPLACE FUNCTION public.guard_academic_staff_period() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $guard$
DECLARE
  candidate tstzrange;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE SQLSTATE 'HRA04' USING MESSAGE = '운영 인력 기록은 삭제할 수 없습니다.';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    -- 종료 관련 네 필드 외의 값이 바뀌거나 이미 종료된 행을 다시 바꾸면 거부합니다.
    IF to_jsonb(NEW) - ARRAY['valid_to', 'ended_by_user_id', 'ended_at', 'end_reason']
        IS DISTINCT FROM to_jsonb(OLD) - ARRAY['valid_to', 'ended_by_user_id', 'ended_at', 'end_reason']
      OR OLD.ended_by_user_id IS NOT NULL OR NEW.ended_by_user_id IS NULL OR NEW.valid_to IS NULL
      OR (OLD.valid_to IS NOT NULL AND NEW.valid_to > OLD.valid_to) THEN
      RAISE SQLSTATE 'HRA04' USING MESSAGE = '운영 인력 기록은 종료 시각 기록 외에 변경할 수 없습니다.';
    END IF;
    -- 소급 종료는 과거 출결의 권한 근거를 사후에 바꾸므로 함수 밖 직접 UPDATE도 현재 시각 이전 종료를 거부합니다.
    IF NEW.valid_to < now() THEN
      RAISE SQLSTATE 'HRA07' USING MESSAGE = '종료 시각은 현재 이후여야 합니다.';
    END IF;
    RETURN NEW;
  END IF;
  -- 신규 행: 앞선 커밋까지 보는 READ COMMITTED에서만 잠금 후 재조회가 상한을 보장합니다.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE SQLSTATE 'HRA07' USING MESSAGE = '운영 인력 배정은 READ COMMITTED 트랜잭션에서만 기록합니다.';
  END IF;
  IF NEW.ended_by_user_id IS NOT NULL OR NEW.ended_at IS NOT NULL OR NEW.end_reason IS NOT NULL
    OR (NEW.valid_to IS NOT NULL AND NEW.valid_to <= NEW.valid_from) THEN
    RAISE SQLSTATE 'HRA07' USING MESSAGE = '새 운영 인력 기록의 기간이 올바르지 않습니다.';
  END IF;
  candidate := tstzrange(NEW.valid_from, NEW.valid_to, '[)');
  IF TG_TABLE_NAME = 'academic_operations_managers' THEN
    -- 같은 계정의 지정 기간 중복을 계정 단위 잠금으로 직렬화해 막습니다.
    PERFORM pg_advisory_xact_lock(hashtextextended('hra:academic-operations-manager:' || NEW.user_id::text, 0));
    IF EXISTS (SELECT 1 FROM public.academic_operations_managers m WHERE m.user_id = NEW.user_id
      AND tstzrange(m.valid_from, m.valid_to, '[)') && candidate) THEN
      RAISE SQLSTATE '23P01' USING MESSAGE = '같은 계정의 학사 운영 관리자 지정 기간이 겹칩니다.';
    END IF;
    RETURN NEW;
  END IF;
  -- 같은 기수의 모든 배정을 기수 단위 잠금으로 직렬화한 뒤 최신 커밋 기준으로 상한을 확인합니다.
  PERFORM pg_advisory_xact_lock(hashtextextended('hra:academic-cohort-staff:' || NEW.cohort_id::text, 0));
  IF EXISTS (SELECT 1 FROM public.academic_cohort_staff_assignments s WHERE s.cohort_id = NEW.cohort_id
    AND s.user_id = NEW.user_id AND tstzrange(s.valid_from, s.valid_to, '[)') && candidate) THEN
    RAISE SQLSTATE '23P01' USING MESSAGE = '같은 계정의 같은 기수 배정 기간이 겹칩니다.';
  END IF;
  IF NEW.staff_role = 'ADVISOR' AND EXISTS (SELECT 1 FROM public.academic_cohort_staff_assignments s
    WHERE s.cohort_id = NEW.cohort_id AND s.staff_role = 'ADVISOR'
      AND tstzrange(s.valid_from, s.valid_to, '[)') && candidate) THEN
    RAISE SQLSTATE '23P01' USING MESSAGE = '같은 기간에 유효한 어드바이저가 이미 있습니다.';
  END IF;
  -- 조교 2명 상한: 새 기간 안에서 기존 조교 두 명이 동시에 유효한 순간이 하나라도 있으면 세 번째가 됩니다.
  IF NEW.staff_role = 'ASSISTANT' AND EXISTS (
    SELECT 1 FROM public.academic_cohort_staff_assignments a
    JOIN public.academic_cohort_staff_assignments b ON b.cohort_id = a.cohort_id AND b.id > a.id
      AND b.staff_role = 'ASSISTANT'
    WHERE a.cohort_id = NEW.cohort_id AND a.staff_role = 'ASSISTANT'
      AND NOT isempty(tstzrange(a.valid_from, a.valid_to, '[)') * tstzrange(b.valid_from, b.valid_to, '[)') * candidate)) THEN
    RAISE SQLSTATE '23P01' USING MESSAGE = '같은 기간에 유효한 조교가 이미 2명입니다.';
  END IF;
  RETURN NEW;
END;
$guard$;

-- 감사 기록은 추가만 허용합니다.
CREATE OR REPLACE FUNCTION public.guard_academic_staff_events() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $events$
BEGIN
  RAISE SQLSTATE 'HRA04' USING MESSAGE = '운영 인력 감사 기록은 수정·삭제할 수 없습니다.';
END;
$events$;

DROP TRIGGER IF EXISTS academic_operations_managers_guard ON public.academic_operations_managers;
CREATE TRIGGER academic_operations_managers_guard BEFORE INSERT OR UPDATE OR DELETE ON public.academic_operations_managers
  FOR EACH ROW EXECUTE FUNCTION public.guard_academic_staff_period();
DROP TRIGGER IF EXISTS academic_operations_managers_truncate_guard ON public.academic_operations_managers;
CREATE TRIGGER academic_operations_managers_truncate_guard BEFORE TRUNCATE ON public.academic_operations_managers
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_academic_staff_events();
DROP TRIGGER IF EXISTS academic_cohort_staff_assignments_guard ON public.academic_cohort_staff_assignments;
CREATE TRIGGER academic_cohort_staff_assignments_guard BEFORE INSERT OR UPDATE OR DELETE ON public.academic_cohort_staff_assignments
  FOR EACH ROW EXECUTE FUNCTION public.guard_academic_staff_period();
DROP TRIGGER IF EXISTS academic_cohort_staff_assignments_truncate_guard ON public.academic_cohort_staff_assignments;
CREATE TRIGGER academic_cohort_staff_assignments_truncate_guard BEFORE TRUNCATE ON public.academic_cohort_staff_assignments
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_academic_staff_events();
DROP TRIGGER IF EXISTS academic_staff_events_guard ON public.academic_staff_events;
CREATE TRIGGER academic_staff_events_guard BEFORE UPDATE OR DELETE ON public.academic_staff_events
  FOR EACH ROW EXECUTE FUNCTION public.guard_academic_staff_events();
DROP TRIGGER IF EXISTS academic_staff_events_truncate_guard ON public.academic_staff_events;
CREATE TRIGGER academic_staff_events_truncate_guard BEFORE TRUNCATE ON public.academic_staff_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_academic_staff_events();

-- 이 파일이 만든 트리거 외의 사용자 트리거(비활성·replica·always 포함)가 있거나 보호 트리거가 꺼져 있으면 중단합니다.
DO $triggers$
BEGIN
  IF (SELECT array_agg(c.relname::text || ':' || t.tgname::text || ':' || p.proname::text || ':' || t.tgenabled::text
        ORDER BY c.relname, t.tgname)
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE NOT t.tgisinternal AND c.oid IN ('public.academic_operations_managers'::regclass,
        'public.academic_cohort_staff_assignments'::regclass, 'public.academic_staff_events'::regclass))
    IS DISTINCT FROM ARRAY[
      'academic_cohort_staff_assignments:academic_cohort_staff_assignments_guard:guard_academic_staff_period:O',
      'academic_cohort_staff_assignments:academic_cohort_staff_assignments_truncate_guard:guard_academic_staff_events:O',
      'academic_operations_managers:academic_operations_managers_guard:guard_academic_staff_period:O',
      'academic_operations_managers:academic_operations_managers_truncate_guard:guard_academic_staff_events:O',
      'academic_staff_events:academic_staff_events_guard:guard_academic_staff_events:O',
      'academic_staff_events:academic_staff_events_truncate_guard:guard_academic_staff_events:O'] THEN
    RAISE EXCEPTION 'staff_migration_trigger_mismatch';
  END IF;
END;
$triggers$;

-- 요청 멱등성: 같은 요청 ID는 같은 주체·행위·입력일 때만 이전 결과를 돌려주고, 다르면 HRA02로 거부합니다.
CREATE OR REPLACE FUNCTION public.academic_staff_replay(
  p_request_id uuid, p_actor_id uuid, p_action text, p_digest text
) RETURNS public.academic_staff_events
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $replay$
DECLARE
  prior public.academic_staff_events;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('hra:academic-staff-request:' || p_request_id::text, 0));
  SELECT * INTO prior FROM public.academic_staff_events WHERE request_id = p_request_id;
  IF FOUND AND (prior.actor_user_id <> p_actor_id OR prior.action <> p_action OR prior.payload_digest <> p_digest) THEN
    RAISE SQLSTATE 'HRA02' USING MESSAGE = '같은 요청 ID를 다른 변경에 사용할 수 없습니다.';
  END IF;
  RETURN prior;
END;
$replay$;

-- 현재 유효한 학사 운영 관리자 지정 행을 잠그고 반환합니다. 지정 종료와 배정 변경을 직렬화합니다.
-- 로그인 계정이 PENDING으로 바뀌었거나 사라졌으면 관리자 권한도 없습니다. 홈페이지 역할로 대신하지 않습니다.
CREATE OR REPLACE FUNCTION public.require_academic_operations_manager(p_actor_id uuid)
RETURNS uuid LANGUAGE plpgsql SET search_path = pg_catalog, public AS $manager$
DECLARE
  designation_id uuid;
BEGIN
  PERFORM 1 FROM public.users u WHERE u.id = p_actor_id AND u.role::text IN ('ADMIN', 'FACULTY', 'MEMBER') FOR SHARE;
  IF NOT FOUND THEN RAISE SQLSTATE 'HRA01' USING MESSAGE = '학사 운영 관리자만 운영 인력을 관리할 수 있습니다.'; END IF;
  SELECT m.id INTO designation_id FROM public.academic_operations_managers m
    WHERE m.user_id = p_actor_id AND m.valid_from <= now() AND (m.valid_to IS NULL OR now() < m.valid_to)
    ORDER BY m.valid_from DESC LIMIT 1 FOR SHARE;
  IF designation_id IS NULL THEN
    RAISE SQLSTATE 'HRA01' USING MESSAGE = '학사 운영 관리자만 운영 인력을 관리할 수 있습니다.';
  END IF;
  RETURN designation_id;
END;
$manager$;

-- 배정·지정 대상은 기존 로그인 계정이며 승인 대기(PENDING)가 아니어야 합니다. 이메일·이름으로 추정하지 않습니다.
CREATE OR REPLACE FUNCTION public.require_academic_staff_account(p_user_id uuid)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog, public AS $account$
BEGIN
  PERFORM 1 FROM public.users u WHERE u.id = p_user_id AND u.role::text IN ('ADMIN', 'FACULTY', 'MEMBER') FOR SHARE;
  IF NOT FOUND THEN RAISE SQLSTATE 'HRA03' USING MESSAGE = '배정할 수 있는 검증된 계정을 찾을 수 없습니다.'; END IF;
END;
$account$;

-- G1 지정 승인자만 학사 운영 관리자를 지정합니다. 자기 지정은 금지합니다.
CREATE OR REPLACE FUNCTION public.designate_academic_operations_manager(
  p_request_id uuid, p_actor_id uuid, p_configured_approver_id uuid, p_correlation_id uuid,
  p_user_id uuid, p_valid_from timestamptz, p_valid_to timestamptz,
  p_verification_method text, p_evidence_reference uuid
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $designate$
DECLARE
  digest text;
  prior public.academic_staff_events;
  designation public.academic_operations_managers;
  starts timestamptz := COALESCE(p_valid_from, now());
BEGIN
  IF p_request_id IS NULL OR p_actor_id IS NULL OR p_configured_approver_id IS NULL OR p_correlation_id IS NULL
    OR p_user_id IS NULL OR p_evidence_reference IS NULL OR p_verification_method IS NULL
    OR p_verification_method NOT IN ('IN_PERSON', 'VERIFIED_CONTACT')
    OR starts < now() OR (p_valid_to IS NOT NULL AND p_valid_to <= starts) THEN
    RAISE SQLSTATE 'HRA07' USING MESSAGE = '학사 운영 관리자 지정 입력이 올바르지 않습니다.';
  END IF;
  IF p_actor_id <> p_configured_approver_id OR p_actor_id = p_user_id THEN
    RAISE SQLSTATE 'HRA01' USING MESSAGE = '지정 승인자만 다른 계정을 학사 운영 관리자로 지정할 수 있습니다.';
  END IF;
  digest := encode(sha256(convert_to(jsonb_build_array('MANAGER_DESIGNATE', p_user_id, p_valid_from, p_valid_to,
    p_verification_method, p_evidence_reference)::text, 'UTF8')), 'hex');
  prior := public.academic_staff_replay(p_request_id, p_actor_id, 'MANAGER_DESIGNATE', digest);
  IF prior.request_id IS NOT NULL THEN
    SELECT * INTO designation FROM public.academic_operations_managers WHERE id = prior.manager_designation_id;
    RETURN jsonb_build_object('designation', to_jsonb(designation), 'replayed', true);
  END IF;
  PERFORM 1 FROM public.users u WHERE u.id = p_actor_id AND u.role::text IN ('ADMIN', 'FACULTY', 'MEMBER') FOR SHARE;
  IF NOT FOUND THEN RAISE SQLSTATE 'HRA01' USING MESSAGE = '지정 승인자 계정을 사용할 수 없습니다.'; END IF;
  PERFORM public.require_academic_staff_account(p_user_id);
  INSERT INTO public.academic_operations_managers (user_id, valid_from, valid_to, verification_method,
    evidence_reference, designated_by_user_id)
    VALUES (p_user_id, starts, p_valid_to, p_verification_method, p_evidence_reference, p_actor_id)
    RETURNING * INTO designation;
  INSERT INTO public.academic_staff_events (request_id, action, actor_user_id, manager_designation_id, correlation_id, payload_digest)
    VALUES (p_request_id, 'MANAGER_DESIGNATE', p_actor_id, designation.id, p_correlation_id, digest);
  RETURN jsonb_build_object('designation', to_jsonb(designation), 'replayed', false);
END;
$designate$;

-- 학사 운영 관리자 지정 종료. 소급 종료는 과거 결정의 권한 근거를 바꾸므로 현재 이후 시각만 받습니다.
CREATE OR REPLACE FUNCTION public.end_academic_operations_manager(
  p_request_id uuid, p_actor_id uuid, p_configured_approver_id uuid, p_correlation_id uuid,
  p_designation_id uuid, p_effective_at timestamptz, p_reason text
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $end_manager$
DECLARE
  digest text;
  prior public.academic_staff_events;
  designation public.academic_operations_managers;
  ends timestamptz := COALESCE(p_effective_at, now());
BEGIN
  IF p_request_id IS NULL OR p_actor_id IS NULL OR p_configured_approver_id IS NULL OR p_correlation_id IS NULL
    OR p_designation_id IS NULL OR ends < now() OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN
    RAISE SQLSTATE 'HRA07' USING MESSAGE = '학사 운영 관리자 지정 종료 입력이 올바르지 않습니다.';
  END IF;
  IF p_actor_id <> p_configured_approver_id THEN
    RAISE SQLSTATE 'HRA01' USING MESSAGE = '지정 승인자만 학사 운영 관리자 지정을 종료할 수 있습니다.';
  END IF;
  digest := encode(sha256(convert_to(jsonb_build_array('MANAGER_END', p_designation_id, p_effective_at, p_reason)::text, 'UTF8')), 'hex');
  prior := public.academic_staff_replay(p_request_id, p_actor_id, 'MANAGER_END', digest);
  IF prior.request_id IS NOT NULL THEN
    SELECT * INTO designation FROM public.academic_operations_managers WHERE id = prior.manager_designation_id;
    RETURN jsonb_build_object('designation', to_jsonb(designation), 'replayed', true);
  END IF;
  PERFORM 1 FROM public.users u WHERE u.id = p_actor_id AND u.role::text IN ('ADMIN', 'FACULTY', 'MEMBER') FOR SHARE;
  IF NOT FOUND THEN RAISE SQLSTATE 'HRA01' USING MESSAGE = '지정 승인자 계정을 사용할 수 없습니다.'; END IF;
  SELECT * INTO designation FROM public.academic_operations_managers WHERE id = p_designation_id FOR UPDATE;
  IF NOT FOUND THEN RAISE SQLSTATE 'HRA03' USING MESSAGE = '학사 운영 관리자 지정을 찾을 수 없습니다.'; END IF;
  IF designation.ended_by_user_id IS NOT NULL OR (designation.valid_to IS NOT NULL AND designation.valid_to <= ends) THEN
    RAISE SQLSTATE 'HRA04' USING MESSAGE = '이미 종료되었거나 그 전에 끝나는 지정입니다.';
  END IF;
  UPDATE public.academic_operations_managers SET valid_to = GREATEST(ends, designation.valid_from),
    ended_by_user_id = p_actor_id, ended_at = now(), end_reason = btrim(p_reason)
    WHERE id = designation.id RETURNING * INTO designation;
  INSERT INTO public.academic_staff_events (request_id, action, actor_user_id, manager_designation_id, correlation_id, payload_digest)
    VALUES (p_request_id, 'MANAGER_END', p_actor_id, designation.id, p_correlation_id, digest);
  RETURN jsonb_build_object('designation', to_jsonb(designation), 'replayed', false);
END;
$end_manager$;

-- 학사 운영 관리자가 기수별 어드바이저·조교를 배정합니다. 자기 배정과 소급 시작은 거부합니다.
CREATE OR REPLACE FUNCTION public.assign_academic_cohort_staff(
  p_request_id uuid, p_actor_id uuid, p_correlation_id uuid, p_cohort_id uuid, p_user_id uuid,
  p_staff_role text, p_valid_from timestamptz, p_valid_to timestamptz,
  p_verification_method text, p_evidence_reference uuid
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $assign$
DECLARE
  digest text;
  prior public.academic_staff_events;
  assignment public.academic_cohort_staff_assignments;
  starts timestamptz := COALESCE(p_valid_from, now());
BEGIN
  IF p_request_id IS NULL OR p_actor_id IS NULL OR p_correlation_id IS NULL OR p_cohort_id IS NULL
    OR p_user_id IS NULL OR p_staff_role IS NULL OR p_staff_role NOT IN ('ADVISOR', 'ASSISTANT')
    OR p_evidence_reference IS NULL OR p_verification_method IS NULL
    OR p_verification_method NOT IN ('IN_PERSON', 'VERIFIED_CONTACT')
    OR starts < now() OR (p_valid_to IS NOT NULL AND p_valid_to <= starts) THEN
    RAISE SQLSTATE 'HRA07' USING MESSAGE = '운영 인력 배정 입력이 올바르지 않습니다.';
  END IF;
  IF p_actor_id = p_user_id THEN
    RAISE SQLSTATE 'HRA01' USING MESSAGE = '자기 자신을 운영 인력으로 배정할 수 없습니다.';
  END IF;
  digest := encode(sha256(convert_to(jsonb_build_array('STAFF_ASSIGN', p_cohort_id, p_user_id, p_staff_role,
    p_valid_from, p_valid_to, p_verification_method, p_evidence_reference)::text, 'UTF8')), 'hex');
  prior := public.academic_staff_replay(p_request_id, p_actor_id, 'STAFF_ASSIGN', digest);
  IF prior.request_id IS NOT NULL THEN
    SELECT * INTO assignment FROM public.academic_cohort_staff_assignments WHERE id = prior.assignment_id;
    RETURN jsonb_build_object('assignment', to_jsonb(assignment), 'replayed', true);
  END IF;
  PERFORM public.require_academic_operations_manager(p_actor_id);
  PERFORM public.require_academic_staff_account(p_user_id);
  PERFORM 1 FROM public.cohorts c WHERE c.id = p_cohort_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE SQLSTATE 'HRA03' USING MESSAGE = '기수를 찾을 수 없습니다.'; END IF;
  INSERT INTO public.academic_cohort_staff_assignments (cohort_id, user_id, staff_role, valid_from, valid_to,
    verification_method, evidence_reference, assigned_by_user_id)
    VALUES (p_cohort_id, p_user_id, p_staff_role, starts, p_valid_to, p_verification_method, p_evidence_reference, p_actor_id)
    RETURNING * INTO assignment;
  INSERT INTO public.academic_staff_events (request_id, action, actor_user_id, assignment_id, correlation_id, payload_digest)
    VALUES (p_request_id, 'STAFF_ASSIGN', p_actor_id, assignment.id, p_correlation_id, digest);
  RETURN jsonb_build_object('assignment', to_jsonb(assignment), 'replayed', false);
END;
$assign$;

-- 배정 종료와 교체의 공통 단계. 종료 시각은 현재 이후만 받고 아직 시작 전인 배정은 시작 시각에서 끝냅니다.
CREATE OR REPLACE FUNCTION public.close_academic_cohort_staff(
  p_actor_id uuid, p_assignment_id uuid, p_ends timestamptz, p_reason text
) RETURNS public.academic_cohort_staff_assignments
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $close$
DECLARE
  assignment public.academic_cohort_staff_assignments;
BEGIN
  SELECT * INTO assignment FROM public.academic_cohort_staff_assignments WHERE id = p_assignment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE SQLSTATE 'HRA03' USING MESSAGE = '운영 인력 배정을 찾을 수 없습니다.'; END IF;
  IF assignment.ended_by_user_id IS NOT NULL OR (assignment.valid_to IS NOT NULL AND assignment.valid_to <= p_ends) THEN
    RAISE SQLSTATE 'HRA04' USING MESSAGE = '이미 종료되었거나 그 전에 끝나는 배정입니다.';
  END IF;
  UPDATE public.academic_cohort_staff_assignments SET valid_to = GREATEST(p_ends, assignment.valid_from),
    ended_by_user_id = p_actor_id, ended_at = now(), end_reason = btrim(p_reason)
    WHERE id = assignment.id RETURNING * INTO assignment;
  RETURN assignment;
END;
$close$;

-- 운영 인력 배정 종료(해제). 종료 시각 이후 해당 계정의 출결 권한 판정은 즉시 거부됩니다.
CREATE OR REPLACE FUNCTION public.end_academic_cohort_staff(
  p_request_id uuid, p_actor_id uuid, p_correlation_id uuid, p_assignment_id uuid,
  p_effective_at timestamptz, p_reason text
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $end_staff$
DECLARE
  digest text;
  prior public.academic_staff_events;
  assignment public.academic_cohort_staff_assignments;
  ends timestamptz := COALESCE(p_effective_at, now());
BEGIN
  IF p_request_id IS NULL OR p_actor_id IS NULL OR p_correlation_id IS NULL OR p_assignment_id IS NULL
    OR ends < now() OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN
    RAISE SQLSTATE 'HRA07' USING MESSAGE = '운영 인력 배정 종료 입력이 올바르지 않습니다.';
  END IF;
  digest := encode(sha256(convert_to(jsonb_build_array('STAFF_END', p_assignment_id, p_effective_at, p_reason)::text, 'UTF8')), 'hex');
  prior := public.academic_staff_replay(p_request_id, p_actor_id, 'STAFF_END', digest);
  IF prior.request_id IS NOT NULL THEN
    SELECT * INTO assignment FROM public.academic_cohort_staff_assignments WHERE id = prior.assignment_id;
    RETURN jsonb_build_object('assignment', to_jsonb(assignment), 'replayed', true);
  END IF;
  PERFORM public.require_academic_operations_manager(p_actor_id);
  assignment := public.close_academic_cohort_staff(p_actor_id, p_assignment_id, ends, p_reason);
  INSERT INTO public.academic_staff_events (request_id, action, actor_user_id, assignment_id, correlation_id, payload_digest)
    VALUES (p_request_id, 'STAFF_END', p_actor_id, assignment.id, p_correlation_id, digest);
  RETURN jsonb_build_object('assignment', to_jsonb(assignment), 'replayed', false);
END;
$end_staff$;

-- 교체: 기존 배정을 종료하고 같은 기수·역할의 새 배정을 같은 시각부터 추가합니다(P3). 기존 계획 종료 시각을 이어받습니다.
CREATE OR REPLACE FUNCTION public.replace_academic_cohort_staff(
  p_request_id uuid, p_actor_id uuid, p_correlation_id uuid, p_assignment_id uuid, p_user_id uuid,
  p_effective_at timestamptz, p_reason text, p_verification_method text, p_evidence_reference uuid
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $replace$
DECLARE
  digest text;
  prior public.academic_staff_events;
  previous public.academic_cohort_staff_assignments;
  planned_end timestamptz;
  replacement public.academic_cohort_staff_assignments;
  ends timestamptz := COALESCE(p_effective_at, now());
BEGIN
  IF p_request_id IS NULL OR p_actor_id IS NULL OR p_correlation_id IS NULL OR p_assignment_id IS NULL
    OR p_user_id IS NULL OR ends < now() OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500
    OR p_evidence_reference IS NULL OR p_verification_method IS NULL
    OR p_verification_method NOT IN ('IN_PERSON', 'VERIFIED_CONTACT') THEN
    RAISE SQLSTATE 'HRA07' USING MESSAGE = '운영 인력 교체 입력이 올바르지 않습니다.';
  END IF;
  IF p_actor_id = p_user_id THEN
    RAISE SQLSTATE 'HRA01' USING MESSAGE = '자기 자신을 운영 인력으로 배정할 수 없습니다.';
  END IF;
  digest := encode(sha256(convert_to(jsonb_build_array('STAFF_REPLACE', p_assignment_id, p_user_id, p_effective_at,
    p_reason, p_verification_method, p_evidence_reference)::text, 'UTF8')), 'hex');
  prior := public.academic_staff_replay(p_request_id, p_actor_id, 'STAFF_REPLACE', digest);
  IF prior.request_id IS NOT NULL THEN
    SELECT * INTO previous FROM public.academic_cohort_staff_assignments WHERE id = prior.assignment_id;
    SELECT * INTO replacement FROM public.academic_cohort_staff_assignments WHERE id = prior.replacement_assignment_id;
    RETURN jsonb_build_object('previous', to_jsonb(previous), 'assignment', to_jsonb(replacement), 'replayed', true);
  END IF;
  PERFORM public.require_academic_operations_manager(p_actor_id);
  PERFORM public.require_academic_staff_account(p_user_id);
  SELECT valid_to INTO planned_end FROM public.academic_cohort_staff_assignments WHERE id = p_assignment_id;
  previous := public.close_academic_cohort_staff(p_actor_id, p_assignment_id, ends, p_reason);
  INSERT INTO public.academic_cohort_staff_assignments (cohort_id, user_id, staff_role, valid_from, valid_to,
    verification_method, evidence_reference, assigned_by_user_id, replaces_assignment_id)
    VALUES (previous.cohort_id, p_user_id, previous.staff_role, previous.valid_to, planned_end,
      p_verification_method, p_evidence_reference, p_actor_id, previous.id)
    RETURNING * INTO replacement;
  INSERT INTO public.academic_staff_events (request_id, action, actor_user_id, assignment_id, replacement_assignment_id,
    correlation_id, payload_digest)
    VALUES (p_request_id, 'STAFF_REPLACE', p_actor_id, previous.id, replacement.id, p_correlation_id, digest);
  RETURN jsonb_build_object('previous', to_jsonb(previous), 'assignment', to_jsonb(replacement), 'replayed', false);
END;
$replace$;

-- 출결 권한 판정(P2·P10). 해당 기수에 **DB 현재 시각(now(), 트랜잭션 시작 시각)** 기준 유효한 ADVISOR·ASSISTANT 배정과
-- PENDING이 아닌 계정만 참입니다. 호출자가 시각을 넘길 수 없게 해 배정 종료 즉시 권한이 끝나도록 합니다.
-- 홈페이지 ADMIN·FACULTY 역할, 학사 운영 관리자 지정, 일정의 담당 교수 정보는 판정 근거가 아닙니다.
-- #159 출결 쓰기 SQL은 같은 트랜잭션에서 이 함수를 다시 호출해 판정과 기록 사이의 배정 종료 경합을 막아야 합니다.
-- 이전 초안의 시각 인자 버전이 남아 있으면 권한 판정 우회 경로가 되므로 먼저 제거합니다.
DROP FUNCTION IF EXISTS public.can_record_academic_attendance(uuid, uuid, timestamptz);
CREATE OR REPLACE FUNCTION public.can_record_academic_attendance(p_user_id uuid, p_cohort_id uuid)
RETURNS boolean LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $can_record$
  SELECT p_user_id IS NOT NULL AND p_cohort_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.academic_cohort_staff_assignments s
    JOIN public.users u ON u.id = s.user_id
    WHERE s.user_id = p_user_id AND s.cohort_id = p_cohort_id
      AND s.staff_role IN ('ADVISOR', 'ASSISTANT')
      AND s.valid_from <= now() AND (s.valid_to IS NULL OR now() < s.valid_to)
      AND u.role::text IN ('ADMIN', 'FACULTY', 'MEMBER'));
$can_record$;

-- 앱 DB 소유 역할만 실행합니다. 임의의 PUBLIC 실행 권한을 제거합니다.
REVOKE ALL ON FUNCTION public.guard_academic_staff_period() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_academic_staff_events() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.academic_staff_replay(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.require_academic_operations_manager(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.require_academic_staff_account(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.designate_academic_operations_manager(uuid, uuid, uuid, uuid, uuid, timestamptz, timestamptz, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.end_academic_operations_manager(uuid, uuid, uuid, uuid, uuid, timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assign_academic_cohort_staff(uuid, uuid, uuid, uuid, uuid, text, timestamptz, timestamptz, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.close_academic_cohort_staff(uuid, uuid, timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.end_academic_cohort_staff(uuid, uuid, uuid, uuid, timestamptz, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.replace_academic_cohort_staff(uuid, uuid, uuid, uuid, uuid, timestamptz, text, text, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.can_record_academic_attendance(uuid, uuid) FROM PUBLIC;

-- 함수를 교체해도 이전 GRANT가 남을 수 있으므로 소유자 외 EXECUTE 권한이 남아 있으면 중단합니다.
DO $acl$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('guard_academic_staff_period', 'guard_academic_staff_events',
      'academic_staff_replay', 'require_academic_operations_manager', 'require_academic_staff_account',
      'designate_academic_operations_manager', 'end_academic_operations_manager', 'assign_academic_cohort_staff',
      'close_academic_cohort_staff', 'end_academic_cohort_staff', 'replace_academic_cohort_staff',
      'can_record_academic_attendance')
      AND (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a
        WHERE a.grantee <> p.proowner AND a.privilege_type = 'EXECUTE'))
  ) OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = 'can_record_academic_attendance') <> 1 THEN
    RAISE EXCEPTION 'staff_migration_function_acl_mismatch';
  END IF;
END;
$acl$;
COMMIT;
