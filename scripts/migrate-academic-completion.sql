-- #163 G3 수료 기준 버전 관리와 학사 운영 관리자의 수동 수료 확정·취소·정정 이력의 추가형 SQL입니다(기능 비활성 검토 후보).
-- 정책: docs/ACADEMIC-OPERATIONS-POLICY.md P13·P14 권장안. 선행: G1 학적(scripts/migrate-academic-students.sql),
-- G1 과제·제출(scripts/migrate-academic-assignments.sql·scripts/migrate-academic-submissions.sql),
-- #165 운영 인력 배정(scripts/migrate-academic-staff-assignments.sql), #159 출결(scripts/migrate-academic-attendance.sql).
-- 시스템은 출결·제출 건수를 보조 계산만 하며 수료를 자동 판정하지 않습니다. 확정·취소·정정은 학사 운영 관리자가 사유와 함께 기록합니다.
-- 기존 표에는 컬럼·트리거를 추가하지 않고 새 표의 외래키(ON DELETE RESTRICT)로만 참조합니다. 출결 표는 참조하지 않아
-- 출결 보존기간(1년)이 끝나 파기되어도 수료 기록(5년, 확정 당시 지표 요약 포함)은 남습니다.
-- 운영 적용은 docs/developer/database-change-procedure.md 절차와 별도 승인이 선행합니다.
-- 이 파일은 같은 DB에 두 번 적용해도 같은 결과가 되며, 이름만 같은 다른 구조는 수용하지 않고 전체를 롤백합니다.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('hra:academic-completion:v1', 0));

-- 선행 SQL이 없으면 외래키·관리자 판정·보조 지표 계산을 만들 수 없으므로 즉시 중단합니다.
DO $prerequisites$
BEGIN
  IF to_regclass('public.cohort_enrollments') IS NULL OR to_regclass('public.academic_students') IS NULL
    OR to_regclass('public.schedule_events') IS NULL
    OR to_regclass('public.assignments') IS NULL OR to_regclass('public.assignment_targets') IS NULL
    OR to_regclass('public.assignment_submissions') IS NULL
    OR to_regclass('public.academic_operations_managers') IS NULL
    OR to_regprocedure('public.require_academic_operations_manager(uuid)') IS NULL
    OR to_regclass('public.academic_attendance_records') IS NULL
    OR to_regprocedure('public.academic_attendance_class_date(timestamp)') IS NULL
    OR to_regprocedure('public.academic_attendance_window(date)') IS NULL THEN
    RAISE EXCEPTION 'completion_migration_prerequisite_missing';
  END IF;
END;
$prerequisites$;

-- 수료 기준 내용(jsonb)의 형식 검사(P13). 표 CHECK에서 쓰므로 표보다 먼저 만듭니다.
-- 허용 키: minAttendancePercent(0~100 정수), countLateAsAttended·countExcusedAsAttended(불리언),
-- requiredSubmissionCount(0~1000 정수), notes(선택, 1~2000자 문자열). 그 밖의 키·형식은 거부합니다.
CREATE OR REPLACE FUNCTION public.academic_completion_criteria_valid(p_criteria jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog, public AS $valid$
DECLARE
  minimum numeric;
  required numeric;
BEGIN
  IF p_criteria IS NULL OR jsonb_typeof(p_criteria) <> 'object' THEN RETURN false; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_object_keys(p_criteria) k WHERE k NOT IN ('minAttendancePercent',
      'countLateAsAttended', 'countExcusedAsAttended', 'requiredSubmissionCount', 'notes'))
    OR NOT (p_criteria ?& ARRAY['minAttendancePercent', 'countLateAsAttended', 'countExcusedAsAttended',
      'requiredSubmissionCount']) THEN
    RETURN false;
  END IF;
  IF jsonb_typeof(p_criteria->'minAttendancePercent') <> 'number'
    OR jsonb_typeof(p_criteria->'requiredSubmissionCount') <> 'number'
    OR jsonb_typeof(p_criteria->'countLateAsAttended') <> 'boolean'
    OR jsonb_typeof(p_criteria->'countExcusedAsAttended') <> 'boolean' THEN
    RETURN false;
  END IF;
  minimum := (p_criteria->>'minAttendancePercent')::numeric;
  required := (p_criteria->>'requiredSubmissionCount')::numeric;
  IF minimum <> trunc(minimum) OR minimum NOT BETWEEN 0 AND 100
    OR required <> trunc(required) OR required NOT BETWEEN 0 AND 1000 THEN
    RETURN false;
  END IF;
  IF p_criteria ? 'notes' AND (jsonb_typeof(p_criteria->'notes') <> 'string'
    OR length(btrim(p_criteria->>'notes')) NOT BETWEEN 1 AND 2000) THEN
    RETURN false;
  END IF;
  RETURN true;
END;
$valid$;

-- 기수별 수료 기준 버전(P13). 초안(DRAFT)만 고칠 수 있고 공개(PUBLISHED) 후에는 내용·작성 정보가 불변입니다.
-- 변경은 새 버전 + 사유이며, 기수당 동시에 하나의 초안만 둡니다(부분 유일 인덱스).
CREATE TABLE IF NOT EXISTS public.completion_criteria_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id uuid NOT NULL CONSTRAINT completion_criteria_versions_cohort_fk REFERENCES public.cohorts(id) ON DELETE RESTRICT,
  version integer NOT NULL,
  criteria jsonb NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT',
  change_reason text NOT NULL,
  created_by_user_id uuid NOT NULL CONSTRAINT completion_criteria_versions_created_by_fk REFERENCES public.users(id) ON DELETE RESTRICT,
  created_by_manager_designation_id uuid NOT NULL CONSTRAINT completion_criteria_versions_created_manager_fk REFERENCES public.academic_operations_managers(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  published_by_user_id uuid CONSTRAINT completion_criteria_versions_published_by_fk REFERENCES public.users(id) ON DELETE RESTRICT,
  published_by_manager_designation_id uuid CONSTRAINT completion_criteria_versions_published_manager_fk REFERENCES public.academic_operations_managers(id) ON DELETE RESTRICT,
  published_at timestamptz,
  CONSTRAINT completion_criteria_versions_cohort_version_unique UNIQUE (cohort_id, version),
  CONSTRAINT completion_criteria_versions_identity_unique UNIQUE (id, cohort_id),
  CONSTRAINT completion_criteria_versions_version_check CHECK (version >= 1),
  CONSTRAINT completion_criteria_versions_status_check CHECK (status IN ('DRAFT', 'PUBLISHED')),
  CONSTRAINT completion_criteria_versions_criteria_check CHECK (public.academic_completion_criteria_valid(criteria)),
  CONSTRAINT completion_criteria_versions_reason_check CHECK (length(btrim(change_reason)) BETWEEN 1 AND 500),
  CONSTRAINT completion_criteria_versions_publication_check CHECK (
    (status = 'DRAFT' AND published_by_user_id IS NULL AND published_by_manager_designation_id IS NULL AND published_at IS NULL)
    OR (status = 'PUBLISHED' AND published_by_user_id IS NOT NULL AND published_by_manager_designation_id IS NOT NULL
      AND published_at IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS completion_criteria_versions_draft_idx
  ON public.completion_criteria_versions (cohort_id) WHERE status = 'DRAFT';

-- 학적별 수료 확정·미수료·취소 이력(P14). 행은 추가만 하며, 같은 학적의 결정은 decision_sequence 1, 2, …로 이어지고
-- 새 결정은 직전 결정(supersedes_decision_id)을 한 번만 대체합니다. 현재 상태 = 가장 큰 순번의 행입니다.
-- 판정에 쓴 공개 기준 버전과 확정 당시의 보조 지표 요약(snapshot)을 함께 고정해 이후 기준 변경·출결 파기의 소급 영향을 막습니다.
CREATE TABLE IF NOT EXISTS public.completion_decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  enrollment_id uuid NOT NULL CONSTRAINT completion_decisions_enrollment_fk REFERENCES public.cohort_enrollments(id) ON DELETE RESTRICT,
  cohort_id uuid NOT NULL CONSTRAINT completion_decisions_cohort_fk REFERENCES public.cohorts(id) ON DELETE RESTRICT,
  criteria_version_id uuid NOT NULL,
  decision_sequence integer NOT NULL,
  supersedes_decision_id uuid CONSTRAINT completion_decisions_supersedes_fk REFERENCES public.completion_decisions(id) ON DELETE RESTRICT,
  decision text NOT NULL,
  reason text NOT NULL,
  snapshot jsonb NOT NULL,
  decided_by_user_id uuid NOT NULL CONSTRAINT completion_decisions_decided_by_fk REFERENCES public.users(id) ON DELETE RESTRICT,
  decided_by_manager_designation_id uuid NOT NULL CONSTRAINT completion_decisions_decided_manager_fk REFERENCES public.academic_operations_managers(id) ON DELETE RESTRICT,
  decided_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT completion_decisions_criteria_fk FOREIGN KEY (criteria_version_id, cohort_id)
    REFERENCES public.completion_criteria_versions(id, cohort_id) ON DELETE RESTRICT,
  CONSTRAINT completion_decisions_enrollment_sequence_unique UNIQUE (enrollment_id, decision_sequence),
  CONSTRAINT completion_decisions_supersedes_unique UNIQUE (supersedes_decision_id),
  CONSTRAINT completion_decisions_decision_check CHECK (decision IN ('COMPLETED', 'NOT_COMPLETED', 'REVOKED')),
  CONSTRAINT completion_decisions_sequence_check CHECK (
    decision_sequence >= 1 AND ((decision_sequence = 1) = (supersedes_decision_id IS NULL))),
  CONSTRAINT completion_decisions_revoke_check CHECK (decision <> 'REVOKED' OR decision_sequence > 1),
  CONSTRAINT completion_decisions_reason_check CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  CONSTRAINT completion_decisions_snapshot_check CHECK (jsonb_typeof(snapshot) = 'object')
);
CREATE INDEX IF NOT EXISTS completion_decisions_cohort_idx
  ON public.completion_decisions (cohort_id, decided_at);

-- 기준 작성·수정·공개와 수료 결정의 추가 전용 감사 기록. 요청 ID로 재시도를 멱등 처리하고 입력 원문 대신 SHA-256 요약만 둡니다.
CREATE TABLE IF NOT EXISTS public.completion_events (
  request_id uuid PRIMARY KEY,
  action text NOT NULL,
  actor_user_id uuid NOT NULL CONSTRAINT completion_events_actor_fk REFERENCES public.users(id) ON DELETE RESTRICT,
  actor_manager_designation_id uuid NOT NULL CONSTRAINT completion_events_manager_fk REFERENCES public.academic_operations_managers(id) ON DELETE RESTRICT,
  criteria_version_id uuid NOT NULL CONSTRAINT completion_events_criteria_fk REFERENCES public.completion_criteria_versions(id) ON DELETE RESTRICT,
  decision_id uuid CONSTRAINT completion_events_decision_fk REFERENCES public.completion_decisions(id) ON DELETE RESTRICT,
  correlation_id uuid NOT NULL,
  payload_digest varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT completion_events_action_check CHECK (action IN ('CRITERIA_CREATE', 'CRITERIA_UPDATE', 'CRITERIA_PUBLISH', 'DECISION_RECORD')),
  CONSTRAINT completion_events_target_check CHECK ((action = 'DECISION_RECORD') = (decision_id IS NOT NULL)),
  CONSTRAINT completion_events_payload_digest_check CHECK (payload_digest ~ '^[0-9a-f]{64}$')
);

-- 이미 있던 표가 이 파일의 정의와 다르면 자동 보정하지 않고 중단합니다. 컬럼·제약·인덱스·RLS를 실제 catalog로 대조합니다.
DO $shape$
DECLARE
  expected record;
BEGIN
  FOR expected IN SELECT * FROM (VALUES
    ('public.completion_criteria_versions'::regclass, '[["id","uuid",true,"gen_random_uuid()"],
      ["cohort_id","uuid",true,""],["version","integer",true,""],["criteria","jsonb",true,""],
      ["status","text",true,"''DRAFT''::text"],["change_reason","text",true,""],["created_by_user_id","uuid",true,""],
      ["created_by_manager_designation_id","uuid",true,""],["created_at","timestamp with time zone",true,"now()"],
      ["updated_at","timestamp with time zone",true,"now()"],["published_by_user_id","uuid",false,""],
      ["published_by_manager_designation_id","uuid",false,""],["published_at","timestamp with time zone",false,""]]'::jsonb, 13, 4),
    ('public.completion_decisions'::regclass, '[["id","uuid",true,"gen_random_uuid()"],
      ["enrollment_id","uuid",true,""],["cohort_id","uuid",true,""],["criteria_version_id","uuid",true,""],
      ["decision_sequence","integer",true,""],["supersedes_decision_id","uuid",false,""],["decision","text",true,""],
      ["reason","text",true,""],["snapshot","jsonb",true,""],["decided_by_user_id","uuid",true,""],
      ["decided_by_manager_designation_id","uuid",true,""],["decided_at","timestamp with time zone",true,"now()"]]'::jsonb, 14, 4),
    ('public.completion_events'::regclass, '[["request_id","uuid",true,""],["action","text",true,""],
      ["actor_user_id","uuid",true,""],["actor_manager_designation_id","uuid",true,""],["criteria_version_id","uuid",true,""],
      ["decision_id","uuid",false,""],["correlation_id","uuid",true,""],["payload_digest","character varying(64)",true,""],
      ["created_at","timestamp with time zone",true,"now()"]]'::jsonb, 8, 1)
  ) AS tables(relation, columns, constraint_count, index_count) LOOP
    IF (SELECT jsonb_agg(jsonb_build_array(a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull,
        COALESCE(pg_get_expr(d.adbin, d.adrelid), '')) ORDER BY a.attnum)
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = expected.relation AND a.attnum > 0 AND NOT a.attisdropped) IS DISTINCT FROM expected.columns THEN
      RAISE EXCEPTION 'completion_migration_column_mismatch';
    END IF;
    -- 이름이 다른 추가 제약·인덱스·RLS나 지연 제약이 있으면 같은 의미라고 보지 않습니다.
    IF (SELECT count(*) FROM pg_constraint WHERE conrelid = expected.relation AND contype <> 'n') <> expected.constraint_count
      OR EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = expected.relation AND contype <> 'n'
        AND (condeferrable OR NOT convalidated))
      OR (SELECT count(*) FROM pg_index WHERE indrelid = expected.relation AND indisvalid AND indisready AND indislive) <> expected.index_count
      OR (SELECT count(*) FROM pg_index WHERE indrelid = expected.relation) <> expected.index_count
      OR EXISTS (SELECT 1 FROM pg_class WHERE oid = expected.relation AND (relkind <> 'r' OR relrowsecurity OR relforcerowsecurity)) THEN
      RAISE EXCEPTION 'completion_migration_structure_mismatch';
    END IF;
  END LOOP;
  -- 키·외래키 정의는 이름과 PostgreSQL이 해석한 정의를 함께 비교합니다.
  FOR expected IN SELECT * FROM (VALUES
    ('completion_criteria_versions', 'completion_criteria_versions_pkey', 'PRIMARY KEY (id)'),
    ('completion_criteria_versions', 'completion_criteria_versions_cohort_fk', 'FOREIGN KEY (cohort_id) REFERENCES cohorts(id) ON DELETE RESTRICT'),
    ('completion_criteria_versions', 'completion_criteria_versions_created_by_fk', 'FOREIGN KEY (created_by_user_id) REFERENCES users(id) ON DELETE RESTRICT'),
    ('completion_criteria_versions', 'completion_criteria_versions_created_manager_fk', 'FOREIGN KEY (created_by_manager_designation_id) REFERENCES academic_operations_managers(id) ON DELETE RESTRICT'),
    ('completion_criteria_versions', 'completion_criteria_versions_published_by_fk', 'FOREIGN KEY (published_by_user_id) REFERENCES users(id) ON DELETE RESTRICT'),
    ('completion_criteria_versions', 'completion_criteria_versions_published_manager_fk', 'FOREIGN KEY (published_by_manager_designation_id) REFERENCES academic_operations_managers(id) ON DELETE RESTRICT'),
    ('completion_criteria_versions', 'completion_criteria_versions_cohort_version_unique', 'UNIQUE (cohort_id, version)'),
    ('completion_criteria_versions', 'completion_criteria_versions_identity_unique', 'UNIQUE (id, cohort_id)'),
    ('completion_decisions', 'completion_decisions_pkey', 'PRIMARY KEY (id)'),
    ('completion_decisions', 'completion_decisions_enrollment_fk', 'FOREIGN KEY (enrollment_id) REFERENCES cohort_enrollments(id) ON DELETE RESTRICT'),
    ('completion_decisions', 'completion_decisions_cohort_fk', 'FOREIGN KEY (cohort_id) REFERENCES cohorts(id) ON DELETE RESTRICT'),
    ('completion_decisions', 'completion_decisions_supersedes_fk', 'FOREIGN KEY (supersedes_decision_id) REFERENCES completion_decisions(id) ON DELETE RESTRICT'),
    ('completion_decisions', 'completion_decisions_decided_by_fk', 'FOREIGN KEY (decided_by_user_id) REFERENCES users(id) ON DELETE RESTRICT'),
    ('completion_decisions', 'completion_decisions_decided_manager_fk', 'FOREIGN KEY (decided_by_manager_designation_id) REFERENCES academic_operations_managers(id) ON DELETE RESTRICT'),
    ('completion_decisions', 'completion_decisions_criteria_fk', 'FOREIGN KEY (criteria_version_id, cohort_id) REFERENCES completion_criteria_versions(id, cohort_id) ON DELETE RESTRICT'),
    ('completion_decisions', 'completion_decisions_enrollment_sequence_unique', 'UNIQUE (enrollment_id, decision_sequence)'),
    ('completion_decisions', 'completion_decisions_supersedes_unique', 'UNIQUE (supersedes_decision_id)'),
    ('completion_events', 'completion_events_pkey', 'PRIMARY KEY (request_id)'),
    ('completion_events', 'completion_events_actor_fk', 'FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT'),
    ('completion_events', 'completion_events_manager_fk', 'FOREIGN KEY (actor_manager_designation_id) REFERENCES academic_operations_managers(id) ON DELETE RESTRICT'),
    ('completion_events', 'completion_events_criteria_fk', 'FOREIGN KEY (criteria_version_id) REFERENCES completion_criteria_versions(id) ON DELETE RESTRICT'),
    ('completion_events', 'completion_events_decision_fk', 'FOREIGN KEY (decision_id) REFERENCES completion_decisions(id) ON DELETE RESTRICT')
  ) AS definitions(relation, name, definition) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = ('public.' || expected.relation)::regclass
      AND c.conname = expected.name AND pg_get_constraintdef(c.oid) = expected.definition) THEN
      RAISE EXCEPTION 'completion_migration_constraint_mismatch';
    END IF;
  END LOOP;
  -- 보조 인덱스의 열 구성과 부분 유일 조건도 확인합니다.
  FOR expected IN SELECT * FROM (VALUES
    ('completion_criteria_versions_draft_idx',
      'CREATE UNIQUE INDEX completion_criteria_versions_draft_idx ON public.completion_criteria_versions USING btree (cohort_id) WHERE (status = ''DRAFT''::text)'),
    ('completion_decisions_cohort_idx',
      'CREATE INDEX completion_decisions_cohort_idx ON public.completion_decisions USING btree (cohort_id, decided_at)')
  ) AS indexes(name, definition) LOOP
    IF (SELECT pg_get_indexdef(c.oid) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = expected.name) IS DISTINCT FROM expected.definition THEN
      RAISE EXCEPTION 'completion_migration_index_mismatch';
    END IF;
  END LOOP;
END;
$shape$;

-- CHECK 식은 버전마다 출력 형식이 달라질 수 있어 같은 정의로 만든 임시 표의 파서 결과와 비교합니다.
CREATE TEMP TABLE completion_expected_criteria_checks (
  version integer, status text, criteria jsonb, change_reason text, published_by_user_id uuid,
  published_by_manager_designation_id uuid, published_at timestamptz,
  CONSTRAINT completion_criteria_versions_version_check CHECK (version >= 1),
  CONSTRAINT completion_criteria_versions_status_check CHECK (status IN ('DRAFT', 'PUBLISHED')),
  CONSTRAINT completion_criteria_versions_criteria_check CHECK (public.academic_completion_criteria_valid(criteria)),
  CONSTRAINT completion_criteria_versions_reason_check CHECK (length(btrim(change_reason)) BETWEEN 1 AND 500),
  CONSTRAINT completion_criteria_versions_publication_check CHECK (
    (status = 'DRAFT' AND published_by_user_id IS NULL AND published_by_manager_designation_id IS NULL AND published_at IS NULL)
    OR (status = 'PUBLISHED' AND published_by_user_id IS NOT NULL AND published_by_manager_designation_id IS NOT NULL
      AND published_at IS NOT NULL))
) ON COMMIT DROP;
CREATE TEMP TABLE completion_expected_decision_checks (
  decision text, decision_sequence integer, supersedes_decision_id uuid, reason text, snapshot jsonb,
  CONSTRAINT completion_decisions_decision_check CHECK (decision IN ('COMPLETED', 'NOT_COMPLETED', 'REVOKED')),
  CONSTRAINT completion_decisions_sequence_check CHECK (
    decision_sequence >= 1 AND ((decision_sequence = 1) = (supersedes_decision_id IS NULL))),
  CONSTRAINT completion_decisions_revoke_check CHECK (decision <> 'REVOKED' OR decision_sequence > 1),
  CONSTRAINT completion_decisions_reason_check CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  CONSTRAINT completion_decisions_snapshot_check CHECK (jsonb_typeof(snapshot) = 'object')
) ON COMMIT DROP;
CREATE TEMP TABLE completion_expected_event_checks (
  action text, decision_id uuid, payload_digest varchar(64),
  CONSTRAINT completion_events_action_check CHECK (action IN ('CRITERIA_CREATE', 'CRITERIA_UPDATE', 'CRITERIA_PUBLISH', 'DECISION_RECORD')),
  CONSTRAINT completion_events_target_check CHECK ((action = 'DECISION_RECORD') = (decision_id IS NOT NULL)),
  CONSTRAINT completion_events_payload_digest_check CHECK (payload_digest ~ '^[0-9a-f]{64}$')
) ON COMMIT DROP;
DO $checks$
DECLARE
  pair record;
BEGIN
  FOR pair IN SELECT * FROM (VALUES
    ('public.completion_criteria_versions'::regclass, 'pg_temp.completion_expected_criteria_checks'::regclass),
    ('public.completion_decisions'::regclass, 'pg_temp.completion_expected_decision_checks'::regclass),
    ('public.completion_events'::regclass, 'pg_temp.completion_expected_event_checks'::regclass)
  ) AS pairs(actual, expected) LOOP
    IF (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname)
        FROM pg_constraint WHERE conrelid = pair.actual AND contype = 'c')
      IS DISTINCT FROM (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname)
        FROM pg_constraint WHERE conrelid = pair.expected AND contype = 'c') THEN
      RAISE EXCEPTION 'completion_migration_check_mismatch';
    END IF;
  END LOOP;
END;
$checks$;

COMMENT ON TABLE public.completion_criteria_versions IS
  '#163 기수별 수료 기준 버전. 초안만 수정, 공개 후 불변. 보존: 그 버전을 적용한 수료 기록과 같음(5년, 정책 초안).';
COMMENT ON TABLE public.completion_decisions IS
  '#163 학사 운영 관리자의 수동 수료 확정·미수료·취소 이력(추가 전용, 순번 대체). 자동 수료 없음. 보존: 수료 판정 확정일 후 5년(정책 초안).';
COMMENT ON TABLE public.completion_events IS
  '#163 수료 기준·결정 변경의 추가 전용 감사와 요청 멱등성. 사유 원문 대신 요약값만 저장.';

-- 기준·결정 표는 이 파일의 함수가 트랜잭션 범위 표지를 켠 동안에만 쓸 수 있습니다.
-- 공개된 기준과 기록된 결정은 표지가 켜져 있어도 바꿀 수 없고, 삭제·비우기는 승인된 파기 절차 전까지 막습니다.
CREATE OR REPLACE FUNCTION public.guard_completion_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $guard$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') OR COALESCE(current_setting('hra.academic_completion_write', true), '') <> 'on' THEN
    RAISE SQLSTATE 'HRA04' USING MESSAGE = '수료 기록은 수료 함수로만 변경할 수 있습니다.';
  END IF;
  IF TG_TABLE_NAME = 'completion_decisions' THEN
    IF TG_OP <> 'INSERT' THEN
      RAISE SQLSTATE 'HRA04' USING MESSAGE = '기록된 수료 결정은 바꿀 수 없습니다. 새 결정으로 정정해 주세요.';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'DRAFT' THEN
      RAISE SQLSTATE 'HRA04' USING MESSAGE = '수료 기준은 초안으로만 만듭니다.';
    END IF;
    RETURN NEW;
  END IF;
  -- 공개된 기준은 어떤 값도 바꿀 수 없습니다(P13 소급 변경 방지).
  IF OLD.status <> 'DRAFT' THEN
    RAISE SQLSTATE 'HRA04' USING MESSAGE = '공개된 수료 기준은 바꿀 수 없습니다. 새 버전을 만들어 주세요.';
  END IF;
  -- 초안 수정은 내용·사유·수정 시각만, 공개는 상태·공개 정보만 바꿀 수 있습니다.
  IF (NEW.status = 'DRAFT' AND to_jsonb(NEW) - ARRAY['criteria', 'change_reason', 'updated_at']
        IS DISTINCT FROM to_jsonb(OLD) - ARRAY['criteria', 'change_reason', 'updated_at'])
    OR (NEW.status <> 'DRAFT' AND to_jsonb(NEW) - ARRAY['status', 'published_by_user_id',
        'published_by_manager_designation_id', 'published_at']
        IS DISTINCT FROM to_jsonb(OLD) - ARRAY['status', 'published_by_user_id',
        'published_by_manager_designation_id', 'published_at']) THEN
    RAISE SQLSTATE 'HRA04' USING MESSAGE = '수료 기준의 식별·작성 정보는 바꿀 수 없습니다.';
  END IF;
  RETURN NEW;
END;
$guard$;

-- 감사 기록은 수료 함수가 추가만 합니다.
CREATE OR REPLACE FUNCTION public.guard_completion_events() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $events$
BEGIN
  IF TG_OP = 'INSERT' AND COALESCE(current_setting('hra.academic_completion_write', true), '') = 'on' THEN
    RETURN NEW;
  END IF;
  RAISE SQLSTATE 'HRA04' USING MESSAGE = '수료 감사 기록은 수정·삭제할 수 없습니다.';
END;
$events$;

DROP TRIGGER IF EXISTS completion_criteria_versions_guard ON public.completion_criteria_versions;
CREATE TRIGGER completion_criteria_versions_guard BEFORE INSERT OR UPDATE OR DELETE ON public.completion_criteria_versions
  FOR EACH ROW EXECUTE FUNCTION public.guard_completion_write();
DROP TRIGGER IF EXISTS completion_criteria_versions_truncate_guard ON public.completion_criteria_versions;
CREATE TRIGGER completion_criteria_versions_truncate_guard BEFORE TRUNCATE ON public.completion_criteria_versions
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_completion_write();
DROP TRIGGER IF EXISTS completion_decisions_guard ON public.completion_decisions;
CREATE TRIGGER completion_decisions_guard BEFORE INSERT OR UPDATE OR DELETE ON public.completion_decisions
  FOR EACH ROW EXECUTE FUNCTION public.guard_completion_write();
DROP TRIGGER IF EXISTS completion_decisions_truncate_guard ON public.completion_decisions;
CREATE TRIGGER completion_decisions_truncate_guard BEFORE TRUNCATE ON public.completion_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_completion_write();
DROP TRIGGER IF EXISTS completion_events_guard ON public.completion_events;
CREATE TRIGGER completion_events_guard BEFORE INSERT OR UPDATE OR DELETE ON public.completion_events
  FOR EACH ROW EXECUTE FUNCTION public.guard_completion_events();
DROP TRIGGER IF EXISTS completion_events_truncate_guard ON public.completion_events;
CREATE TRIGGER completion_events_truncate_guard BEFORE TRUNCATE ON public.completion_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_completion_events();

-- 이 파일이 만든 트리거 외의 사용자 트리거가 있거나 보호 트리거가 꺼져 있으면 중단합니다.
DO $triggers$
BEGIN
  IF (SELECT array_agg(c.relname::text || ':' || t.tgname::text || ':' || p.proname::text || ':' || t.tgenabled::text
        ORDER BY c.relname, t.tgname)
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE NOT t.tgisinternal AND c.oid IN ('public.completion_criteria_versions'::regclass,
        'public.completion_decisions'::regclass, 'public.completion_events'::regclass))
    IS DISTINCT FROM ARRAY[
      'completion_criteria_versions:completion_criteria_versions_guard:guard_completion_write:O',
      'completion_criteria_versions:completion_criteria_versions_truncate_guard:guard_completion_write:O',
      'completion_decisions:completion_decisions_guard:guard_completion_write:O',
      'completion_decisions:completion_decisions_truncate_guard:guard_completion_write:O',
      'completion_events:completion_events_guard:guard_completion_events:O',
      'completion_events:completion_events_truncate_guard:guard_completion_events:O'] THEN
    RAISE EXCEPTION 'completion_migration_trigger_mismatch';
  END IF;
END;
$triggers$;

-- 요청 멱등성: 같은 요청 ID는 같은 주체·행위·입력일 때만 이전 결과를 돌려주고, 다르면 HRA02로 거부합니다.
CREATE OR REPLACE FUNCTION public.academic_completion_replay(
  p_request_id uuid, p_actor_id uuid, p_action text, p_digest text
) RETURNS public.completion_events
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $replay$
DECLARE
  prior public.completion_events;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('hra:academic-completion-request:' || p_request_id::text, 0));
  SELECT * INTO prior FROM public.completion_events WHERE request_id = p_request_id;
  IF FOUND AND (prior.actor_user_id <> p_actor_id OR prior.action <> p_action OR prior.payload_digest <> p_digest) THEN
    RAISE SQLSTATE 'HRA02' USING MESSAGE = '같은 요청 ID를 다른 변경에 사용할 수 없습니다.';
  END IF;
  RETURN prior;
END;
$replay$;

-- 수료 심사 보조 지표(P14: 보조 계산만). 결정에 쓰지 않으며 자동 수료를 만들지 않습니다.
-- 출결: 이 학적이 수업일(KST 하루) 중 유효했고 이미 시작된 같은 기수 CLASS 수업일을 분모로 하고, 미입력은 결석으로 세지 않습니다.
--       미입력이 있으면 출석률 충족 여부(met)는 판단 보류(null)입니다. 지각·인정결석 포함 여부는 기준 버전을 따릅니다.
-- 과제: 이 학적이 대상인 공개(DRAFT 아님) 과제 수와 최종 제출이 있는 과제 수입니다.
-- 호출자 인가는 하지 않으므로 이 함수는 인가를 마친 이 파일의 함수 안에서만 호출합니다(PUBLIC 실행 권한 없음).
CREATE OR REPLACE FUNCTION public.compute_completion_snapshot(p_enrollment_id uuid, p_criteria_version_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = pg_catalog, public AS $snapshot$
DECLARE
  enrollment_row record;
  criteria_row public.completion_criteria_versions;
  counts record;
  submissions record;
  attended integer;
  minimum integer;
  required integer;
BEGIN
  SELECT ce.id, ce.cohort_id, ce.enrolled_at, ce.ended_at INTO enrollment_row
    FROM public.cohort_enrollments ce WHERE ce.id = p_enrollment_id;
  IF NOT FOUND THEN RAISE SQLSTATE 'HRA03' USING MESSAGE = '학적을 찾을 수 없습니다.'; END IF;
  SELECT * INTO criteria_row FROM public.completion_criteria_versions WHERE id = p_criteria_version_id;
  IF NOT FOUND OR criteria_row.cohort_id <> enrollment_row.cohort_id THEN
    RAISE SQLSTATE 'HRA03' USING MESSAGE = '이 학적의 기수에 속한 수료 기준을 찾을 수 없습니다.';
  END IF;
  SELECT count(*)::integer AS classes,
      count(*) FILTER (WHERE r.status = 'PRESENT')::integer AS present,
      count(*) FILTER (WHERE r.status = 'LATE')::integer AS late,
      count(*) FILTER (WHERE r.status = 'ABSENT')::integer AS absent,
      count(*) FILTER (WHERE r.status = 'EXCUSED')::integer AS excused,
      count(*) FILTER (WHERE r.id IS NULL)::integer AS unmarked
    INTO counts
    FROM (SELECT e.id, lower(public.academic_attendance_window(public.academic_attendance_class_date(e.event_date))) AS day_starts
          FROM public.schedule_events e
          WHERE e.cohort_id = enrollment_row.cohort_id AND e.event_type::text = 'CLASS' AND e.event_date IS NOT NULL) classes
    LEFT JOIN public.academic_attendance_records r
      ON r.schedule_event_id = classes.id AND r.enrollment_id = p_enrollment_id
    WHERE classes.day_starts <= now()
      AND enrollment_row.enrolled_at < classes.day_starts + interval '1 day'
      AND (enrollment_row.ended_at IS NULL OR enrollment_row.ended_at > classes.day_starts);
  SELECT count(*)::integer AS assigned, count(s.id)::integer AS submitted INTO submissions
    FROM public.assignment_targets t
    JOIN public.assignments a ON a.id = t.assignment_id AND a.status::text <> 'DRAFT'
    LEFT JOIN public.assignment_submissions s ON s.assignment_target_id = t.id
    WHERE t.enrollment_id = p_enrollment_id;
  attended := counts.present
    + CASE WHEN (criteria_row.criteria->>'countLateAsAttended')::boolean THEN counts.late ELSE 0 END
    + CASE WHEN (criteria_row.criteria->>'countExcusedAsAttended')::boolean THEN counts.excused ELSE 0 END;
  minimum := (criteria_row.criteria->>'minAttendancePercent')::integer;
  required := (criteria_row.criteria->>'requiredSubmissionCount')::integer;
  RETURN jsonb_build_object(
    'enrollmentId', p_enrollment_id, 'criteriaVersionId', criteria_row.id, 'criteriaVersion', criteria_row.version,
    'computedAt', now(),
    'attendance', jsonb_build_object(
      'classCount', counts.classes, 'presentCount', counts.present, 'lateCount', counts.late,
      'absentCount', counts.absent, 'excusedCount', counts.excused, 'unmarkedCount', counts.unmarked,
      'attendedCount', attended,
      'attendancePercent', CASE WHEN counts.classes = 0 THEN NULL ELSE round(attended * 100.0 / counts.classes, 1) END,
      'minAttendancePercent', minimum,
      'met', CASE WHEN counts.unmarked > 0 THEN NULL ELSE attended * 100 >= minimum * counts.classes END),
    'submissions', jsonb_build_object(
      'assignedCount', submissions.assigned, 'submittedCount', submissions.submitted,
      'requiredCount', required, 'met', submissions.submitted >= required));
END;
$snapshot$;

-- 수료 기준 초안 작성(P13). 기수당 하나의 초안만 두며 버전 번호는 기수 안에서 1부터 이어집니다.
CREATE OR REPLACE FUNCTION public.create_academic_completion_criteria(
  p_request_id uuid, p_actor_id uuid, p_correlation_id uuid, p_cohort_id uuid, p_criteria jsonb, p_reason text
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $create$
DECLARE
  digest text;
  prior public.completion_events;
  designation_id uuid;
  saved public.completion_criteria_versions;
BEGIN
  IF p_request_id IS NULL OR p_actor_id IS NULL OR p_correlation_id IS NULL OR p_cohort_id IS NULL
    OR NOT public.academic_completion_criteria_valid(p_criteria)
    OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN
    RAISE SQLSTATE 'HRA07' USING MESSAGE = '수료 기준 입력이 올바르지 않습니다.';
  END IF;
  digest := encode(sha256(convert_to(jsonb_build_array('CRITERIA_CREATE', p_cohort_id, p_criteria, p_reason)::text, 'UTF8')), 'hex');
  prior := public.academic_completion_replay(p_request_id, p_actor_id, 'CRITERIA_CREATE', digest);
  IF prior.request_id IS NOT NULL THEN
    SELECT * INTO saved FROM public.completion_criteria_versions WHERE id = prior.criteria_version_id;
    RETURN jsonb_build_object('criteria', to_jsonb(saved), 'replayed', true);
  END IF;
  designation_id := public.require_academic_operations_manager(p_actor_id);
  PERFORM 1 FROM public.cohorts c WHERE c.id = p_cohort_id FOR KEY SHARE;
  IF NOT FOUND THEN RAISE SQLSTATE 'HRA03' USING MESSAGE = '기수를 찾을 수 없습니다.'; END IF;
  -- 같은 기수의 버전 번호 부여와 초안 존재 확인을 기수 단위로 직렬화합니다.
  PERFORM pg_advisory_xact_lock(hashtextextended('hra:academic-completion-cohort:' || p_cohort_id::text, 0));
  IF EXISTS (SELECT 1 FROM public.completion_criteria_versions v WHERE v.cohort_id = p_cohort_id AND v.status = 'DRAFT') THEN
    RAISE SQLSTATE 'HRA04' USING MESSAGE = '이 기수에는 이미 수료 기준 초안이 있습니다.';
  END IF;
  PERFORM set_config('hra.academic_completion_write', 'on', true);
  INSERT INTO public.completion_criteria_versions (cohort_id, version, criteria, change_reason,
    created_by_user_id, created_by_manager_designation_id)
    VALUES (p_cohort_id, COALESCE((SELECT max(v.version) FROM public.completion_criteria_versions v
      WHERE v.cohort_id = p_cohort_id), 0) + 1, p_criteria, btrim(p_reason), p_actor_id, designation_id)
    RETURNING * INTO saved;
  INSERT INTO public.completion_events (request_id, action, actor_user_id, actor_manager_designation_id,
    criteria_version_id, correlation_id, payload_digest)
    VALUES (p_request_id, 'CRITERIA_CREATE', p_actor_id, designation_id, saved.id, p_correlation_id, digest);
  PERFORM set_config('hra.academic_completion_write', 'off', true);
  RETURN jsonb_build_object('criteria', to_jsonb(saved), 'replayed', false);
END;
$create$;

-- 수료 기준 초안 수정. 공개된 버전은 HRA04로 거부합니다.
CREATE OR REPLACE FUNCTION public.update_academic_completion_criteria(
  p_request_id uuid, p_actor_id uuid, p_correlation_id uuid, p_criteria_version_id uuid, p_criteria jsonb, p_reason text
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $update$
DECLARE
  digest text;
  prior public.completion_events;
  designation_id uuid;
  saved public.completion_criteria_versions;
BEGIN
  IF p_request_id IS NULL OR p_actor_id IS NULL OR p_correlation_id IS NULL OR p_criteria_version_id IS NULL
    OR NOT public.academic_completion_criteria_valid(p_criteria)
    OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN
    RAISE SQLSTATE 'HRA07' USING MESSAGE = '수료 기준 입력이 올바르지 않습니다.';
  END IF;
  digest := encode(sha256(convert_to(jsonb_build_array('CRITERIA_UPDATE', p_criteria_version_id, p_criteria, p_reason)::text, 'UTF8')), 'hex');
  prior := public.academic_completion_replay(p_request_id, p_actor_id, 'CRITERIA_UPDATE', digest);
  IF prior.request_id IS NOT NULL THEN
    SELECT * INTO saved FROM public.completion_criteria_versions WHERE id = prior.criteria_version_id;
    RETURN jsonb_build_object('criteria', to_jsonb(saved), 'replayed', true);
  END IF;
  designation_id := public.require_academic_operations_manager(p_actor_id);
  SELECT * INTO saved FROM public.completion_criteria_versions WHERE id = p_criteria_version_id FOR UPDATE;
  IF NOT FOUND THEN RAISE SQLSTATE 'HRA03' USING MESSAGE = '수료 기준을 찾을 수 없습니다.'; END IF;
  IF saved.status <> 'DRAFT' THEN
    RAISE SQLSTATE 'HRA04' USING MESSAGE = '공개된 수료 기준은 바꿀 수 없습니다. 새 버전을 만들어 주세요.';
  END IF;
  PERFORM set_config('hra.academic_completion_write', 'on', true);
  UPDATE public.completion_criteria_versions SET criteria = p_criteria, change_reason = btrim(p_reason), updated_at = now()
    WHERE id = saved.id RETURNING * INTO saved;
  INSERT INTO public.completion_events (request_id, action, actor_user_id, actor_manager_designation_id,
    criteria_version_id, correlation_id, payload_digest)
    VALUES (p_request_id, 'CRITERIA_UPDATE', p_actor_id, designation_id, saved.id, p_correlation_id, digest);
  PERFORM set_config('hra.academic_completion_write', 'off', true);
  RETURN jsonb_build_object('criteria', to_jsonb(saved), 'replayed', false);
END;
$update$;

-- 수료 기준 공개(P13). 공개 뒤에는 내용이 불변이며 수료 결정은 공개된 버전만 참조할 수 있습니다.
CREATE OR REPLACE FUNCTION public.publish_academic_completion_criteria(
  p_request_id uuid, p_actor_id uuid, p_correlation_id uuid, p_criteria_version_id uuid
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $publish$
DECLARE
  digest text;
  prior public.completion_events;
  designation_id uuid;
  saved public.completion_criteria_versions;
BEGIN
  IF p_request_id IS NULL OR p_actor_id IS NULL OR p_correlation_id IS NULL OR p_criteria_version_id IS NULL THEN
    RAISE SQLSTATE 'HRA07' USING MESSAGE = '수료 기준 공개 입력이 올바르지 않습니다.';
  END IF;
  digest := encode(sha256(convert_to(jsonb_build_array('CRITERIA_PUBLISH', p_criteria_version_id)::text, 'UTF8')), 'hex');
  prior := public.academic_completion_replay(p_request_id, p_actor_id, 'CRITERIA_PUBLISH', digest);
  IF prior.request_id IS NOT NULL THEN
    SELECT * INTO saved FROM public.completion_criteria_versions WHERE id = prior.criteria_version_id;
    RETURN jsonb_build_object('criteria', to_jsonb(saved), 'replayed', true);
  END IF;
  designation_id := public.require_academic_operations_manager(p_actor_id);
  SELECT * INTO saved FROM public.completion_criteria_versions WHERE id = p_criteria_version_id FOR UPDATE;
  IF NOT FOUND THEN RAISE SQLSTATE 'HRA03' USING MESSAGE = '수료 기준을 찾을 수 없습니다.'; END IF;
  IF saved.status <> 'DRAFT' THEN
    RAISE SQLSTATE 'HRA04' USING MESSAGE = '이미 공개된 수료 기준입니다.';
  END IF;
  PERFORM set_config('hra.academic_completion_write', 'on', true);
  UPDATE public.completion_criteria_versions SET status = 'PUBLISHED', published_by_user_id = p_actor_id,
    published_by_manager_designation_id = designation_id, published_at = now()
    WHERE id = saved.id RETURNING * INTO saved;
  INSERT INTO public.completion_events (request_id, action, actor_user_id, actor_manager_designation_id,
    criteria_version_id, correlation_id, payload_digest)
    VALUES (p_request_id, 'CRITERIA_PUBLISH', p_actor_id, designation_id, saved.id, p_correlation_id, digest);
  PERFORM set_config('hra.academic_completion_write', 'off', true);
  RETURN jsonb_build_object('criteria', to_jsonb(saved), 'replayed', false);
END;
$publish$;

-- 수료 확정·미수료·취소 기록(P14). 학사 운영 관리자가 공개된 같은 기수 기준 버전과 사유를 지정해 수동으로 기록합니다.
-- 본인 학적은 결정할 수 없습니다(자기 승인 금지). 호출자는 본 현재 순번(결정이 없으면 0)을 넘기고, 다르면 HRA06으로 거부해
-- 동시에 상충하는 확정 중 하나만 반영합니다. 취소(REVOKED)는 현재 결정이 수료(COMPLETED)일 때만 가능합니다.
-- 확정 당시의 보조 지표 요약을 함께 저장하지만 결정 값 자체는 지표와 무관하게 관리자가 정합니다.
CREATE OR REPLACE FUNCTION public.record_academic_completion_decision(
  p_request_id uuid, p_actor_id uuid, p_correlation_id uuid, p_enrollment_id uuid, p_criteria_version_id uuid,
  p_decision text, p_reason text, p_expected_sequence integer
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $decide$
DECLARE
  digest text;
  prior public.completion_events;
  designation_id uuid;
  enrollment_row record;
  criteria_row public.completion_criteria_versions;
  latest public.completion_decisions;
  saved public.completion_decisions;
BEGIN
  IF p_request_id IS NULL OR p_actor_id IS NULL OR p_correlation_id IS NULL OR p_enrollment_id IS NULL
    OR p_criteria_version_id IS NULL OR p_decision IS NULL OR p_decision NOT IN ('COMPLETED', 'NOT_COMPLETED', 'REVOKED')
    OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500
    OR p_expected_sequence IS NULL OR p_expected_sequence < 0 THEN
    RAISE SQLSTATE 'HRA07' USING MESSAGE = '수료 결정 입력이 올바르지 않습니다.';
  END IF;
  -- 잠금 후 재조회가 최신 커밋을 보도록 READ COMMITTED만 허용합니다.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE SQLSTATE 'HRA07' USING MESSAGE = '수료 결정은 READ COMMITTED 트랜잭션에서만 기록합니다.';
  END IF;
  digest := encode(sha256(convert_to(jsonb_build_array('DECISION_RECORD', p_enrollment_id, p_criteria_version_id,
    p_decision, p_reason, p_expected_sequence)::text, 'UTF8')), 'hex');
  prior := public.academic_completion_replay(p_request_id, p_actor_id, 'DECISION_RECORD', digest);
  IF prior.request_id IS NOT NULL THEN
    SELECT * INTO saved FROM public.completion_decisions WHERE id = prior.decision_id;
    RETURN jsonb_build_object('decision', to_jsonb(saved), 'replayed', true);
  END IF;
  -- 인가를 학적 확인보다 먼저 해 권한 없는 주체가 학적 존재 여부를 알 수 없게 합니다.
  designation_id := public.require_academic_operations_manager(p_actor_id);
  SELECT ce.id, ce.cohort_id, st.user_id INTO enrollment_row
    FROM public.cohort_enrollments ce JOIN public.academic_students st ON st.id = ce.student_id
    WHERE ce.id = p_enrollment_id FOR KEY SHARE OF ce;
  IF NOT FOUND THEN RAISE SQLSTATE 'HRA03' USING MESSAGE = '학적을 찾을 수 없습니다.'; END IF;
  IF enrollment_row.user_id IS NOT DISTINCT FROM p_actor_id THEN
    RAISE SQLSTATE 'HRA01' USING MESSAGE = '본인의 수료 기록은 결정할 수 없습니다.';
  END IF;
  SELECT * INTO criteria_row FROM public.completion_criteria_versions WHERE id = p_criteria_version_id FOR KEY SHARE;
  IF NOT FOUND OR criteria_row.cohort_id <> enrollment_row.cohort_id THEN
    RAISE SQLSTATE 'HRA03' USING MESSAGE = '이 학적의 기수에 속한 수료 기준을 찾을 수 없습니다.';
  END IF;
  IF criteria_row.status <> 'PUBLISHED' THEN
    RAISE SQLSTATE 'HRA04' USING MESSAGE = '공개된 수료 기준으로만 결정할 수 있습니다.';
  END IF;
  -- 같은 학적의 결정을 직렬화한 뒤 최신 커밋 기준으로 현재 결정을 다시 읽습니다.
  PERFORM pg_advisory_xact_lock(hashtextextended('hra:academic-completion-enrollment:' || p_enrollment_id::text, 0));
  SELECT * INTO latest FROM public.completion_decisions d WHERE d.enrollment_id = p_enrollment_id
    ORDER BY d.decision_sequence DESC LIMIT 1;
  IF COALESCE(latest.decision_sequence, 0) <> p_expected_sequence THEN
    RAISE SQLSTATE 'HRA06' USING MESSAGE = '다른 결정이 먼저 기록되었습니다. 다시 조회해 주세요.';
  END IF;
  IF p_decision = 'REVOKED' AND latest.decision IS DISTINCT FROM 'COMPLETED' THEN
    RAISE SQLSTATE 'HRA04' USING MESSAGE = '수료로 확정된 기록만 취소할 수 있습니다.';
  END IF;
  PERFORM set_config('hra.academic_completion_write', 'on', true);
  INSERT INTO public.completion_decisions (enrollment_id, cohort_id, criteria_version_id, decision_sequence,
    supersedes_decision_id, decision, reason, snapshot, decided_by_user_id, decided_by_manager_designation_id)
    VALUES (p_enrollment_id, enrollment_row.cohort_id, criteria_row.id, p_expected_sequence + 1, latest.id,
      p_decision, btrim(p_reason), public.compute_completion_snapshot(p_enrollment_id, criteria_row.id),
      p_actor_id, designation_id)
    RETURNING * INTO saved;
  INSERT INTO public.completion_events (request_id, action, actor_user_id, actor_manager_designation_id,
    criteria_version_id, decision_id, correlation_id, payload_digest)
    VALUES (p_request_id, 'DECISION_RECORD', p_actor_id, designation_id, criteria_row.id, saved.id, p_correlation_id, digest);
  PERFORM set_config('hra.academic_completion_write', 'off', true);
  RETURN jsonb_build_object('decision', to_jsonb(saved), 'replayed', false);
END;
$decide$;

-- 학사 운영 관리자용 기수 목록. 관리자 지정이 없으면 HRA01입니다.
CREATE OR REPLACE FUNCTION public.list_academic_completion_cohorts(p_actor_id uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $cohorts$
BEGIN
  PERFORM public.require_academic_operations_manager(p_actor_id);
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) ORDER BY c.name, c.id)
    FROM public.cohorts c), '[]'::jsonb);
END;
$cohorts$;

-- 학사 운영 관리자용 수료 심사 명부. 기수의 기준 버전 목록과, 선택한 기준(생략 시 가장 최근 공개 버전)으로 계산한
-- 학적별 보조 지표·현재 결정·결정 이력(순번·결정·사유·결정자·시각)을 돌려줍니다. 관리자 지정이 없으면 HRA01입니다.
CREATE OR REPLACE FUNCTION public.list_academic_completion_roster(
  p_actor_id uuid, p_cohort_id uuid, p_criteria_version_id uuid
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $roster$
DECLARE
  cohort_row record;
  selected uuid;
BEGIN
  IF p_actor_id IS NULL OR p_cohort_id IS NULL THEN
    RAISE SQLSTATE 'HRA07' USING MESSAGE = '조회 입력이 올바르지 않습니다.';
  END IF;
  PERFORM public.require_academic_operations_manager(p_actor_id);
  SELECT c.id, c.name INTO cohort_row FROM public.cohorts c WHERE c.id = p_cohort_id;
  IF NOT FOUND THEN RAISE SQLSTATE 'HRA03' USING MESSAGE = '기수를 찾을 수 없습니다.'; END IF;
  IF p_criteria_version_id IS NULL THEN
    SELECT v.id INTO selected FROM public.completion_criteria_versions v
      WHERE v.cohort_id = p_cohort_id AND v.status = 'PUBLISHED' ORDER BY v.version DESC LIMIT 1;
  ELSE
    SELECT v.id INTO selected FROM public.completion_criteria_versions v
      WHERE v.id = p_criteria_version_id AND v.cohort_id = p_cohort_id;
    IF selected IS NULL THEN RAISE SQLSTATE 'HRA03' USING MESSAGE = '수료 기준을 찾을 수 없습니다.'; END IF;
  END IF;
  RETURN jsonb_build_object(
    'cohortId', cohort_row.id, 'cohortName', cohort_row.name, 'selectedCriteriaVersionId', selected,
    'criteriaVersions', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'id', v.id, 'version', v.version, 'status', v.status, 'criteria', v.criteria,
        'changeReason', v.change_reason, 'createdAt', v.created_at, 'updatedAt', v.updated_at,
        'publishedAt', v.published_at) ORDER BY v.version DESC)
      FROM public.completion_criteria_versions v WHERE v.cohort_id = p_cohort_id), '[]'::jsonb),
    'entries', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'enrollmentId', ce.id, 'displayName', st.display_name,
        'snapshot', CASE WHEN selected IS NULL THEN NULL ELSE public.compute_completion_snapshot(ce.id, selected) END,
        'history', COALESCE((SELECT jsonb_agg(jsonb_build_object(
            'id', d.id, 'sequence', d.decision_sequence, 'decision', d.decision, 'reason', d.reason,
            'criteriaVersionId', d.criteria_version_id, 'criteriaVersion', v.version,
            'decidedByUserId', d.decided_by_user_id, 'decidedAt', d.decided_at) ORDER BY d.decision_sequence)
          FROM public.completion_decisions d JOIN public.completion_criteria_versions v ON v.id = d.criteria_version_id
          WHERE d.enrollment_id = ce.id), '[]'::jsonb))
        ORDER BY st.display_name, ce.id)
      FROM public.cohort_enrollments ce JOIN public.academic_students st ON st.id = ce.student_id
      WHERE ce.cohort_id = p_cohort_id), '[]'::jsonb));
END;
$roster$;

-- 학생 본인 수료 상태. 로그인 계정에 연결된 본인 학적의 현재 결정(없으면 null=심사 전)과 확정 시각·기준 버전 번호만 돌려줍니다.
-- 사유·결정자·보조 지표와 다른 학생의 기록은 포함하지 않습니다.
CREATE OR REPLACE FUNCTION public.list_own_academic_completion(p_actor_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $list_own$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'enrollmentId', ce.id, 'cohortId', ce.cohort_id, 'cohortName', c.name,
      'decision', latest.decision, 'decidedAt', latest.decided_at, 'criteriaVersion', latest.version)
    ORDER BY c.name, ce.id), '[]'::jsonb)
  FROM public.academic_students st
  JOIN public.users u ON u.id = st.user_id AND u.role::text IN ('ADMIN', 'FACULTY', 'MEMBER')
  JOIN public.cohort_enrollments ce ON ce.student_id = st.id
  JOIN public.cohorts c ON c.id = ce.cohort_id
  LEFT JOIN LATERAL (SELECT d.decision, d.decided_at, v.version FROM public.completion_decisions d
      JOIN public.completion_criteria_versions v ON v.id = d.criteria_version_id
      WHERE d.enrollment_id = ce.id ORDER BY d.decision_sequence DESC LIMIT 1) latest ON true
  WHERE p_actor_id IS NOT NULL AND st.user_id = p_actor_id;
$list_own$;

-- 앱 DB 소유 역할만 실행합니다. 임의의 PUBLIC 실행 권한을 제거합니다.
REVOKE ALL ON FUNCTION public.academic_completion_criteria_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_completion_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_completion_events() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.academic_completion_replay(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.compute_completion_snapshot(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_academic_completion_criteria(uuid, uuid, uuid, uuid, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.update_academic_completion_criteria(uuid, uuid, uuid, uuid, jsonb, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.publish_academic_completion_criteria(uuid, uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_academic_completion_decision(uuid, uuid, uuid, uuid, uuid, text, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_academic_completion_cohorts(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_academic_completion_roster(uuid, uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_own_academic_completion(uuid) FROM PUBLIC;

-- 함수를 교체해도 이전 GRANT가 남을 수 있으므로 소유자 외 EXECUTE 권한이 남아 있으면 중단합니다(#165·#159와 같은 검사).
DO $acl$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname IN ('academic_completion_criteria_valid', 'guard_completion_write',
      'guard_completion_events', 'academic_completion_replay', 'compute_completion_snapshot',
      'create_academic_completion_criteria', 'update_academic_completion_criteria', 'publish_academic_completion_criteria',
      'record_academic_completion_decision', 'list_academic_completion_cohorts', 'list_academic_completion_roster',
      'list_own_academic_completion')
      AND (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a
        WHERE a.grantee <> p.proowner AND a.privilege_type = 'EXECUTE'))
  ) THEN
    RAISE EXCEPTION 'completion_migration_function_acl_mismatch';
  END IF;
END;
$acl$;
COMMIT;
