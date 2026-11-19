-- #159 G2 학생별 출결 기록과 정정 승인의 추가형 SQL입니다(기능 비활성 검토 후보).
-- 정책: docs/ACADEMIC-OPERATIONS-POLICY.md P5~P10 권장안. 선행: G1 학적(scripts/migrate-academic-students.sql)과
-- #165 운영 인력 배정(scripts/migrate-academic-staff-assignments.sql). 기존 schedule_events·cohort_enrollments 표에는
-- 컬럼·트리거를 추가하지 않고 이 파일의 새 표에서 외래키(ON DELETE RESTRICT)로만 참조합니다.
-- 운영 적용은 docs/developer/database-change-procedure.md 절차와 별도 승인이 선행합니다.
-- 이 파일은 같은 DB에 두 번 적용해도 같은 결과가 되며, 이름만 같은 다른 구조는 수용하지 않고 전체를 롤백합니다.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('hra:academic-attendance:v1', 0));

-- 선행 SQL이 없으면 외래키·권한 판정을 만들 수 없으므로 즉시 중단합니다.
DO $prerequisites$
BEGIN
  IF to_regclass('public.cohort_enrollments') IS NULL OR to_regclass('public.academic_students') IS NULL
    OR to_regclass('public.schedule_events') IS NULL
    OR to_regclass('public.academic_cohort_staff_assignments') IS NULL
    OR to_regclass('public.academic_operations_managers') IS NULL
    OR to_regprocedure('public.can_record_academic_attendance(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'attendance_migration_prerequisite_missing';
  END IF;
END;
$prerequisites$;

-- 정정 요청·승인 기록(P7·P8). 승인 전에는 출결 현재 값을 바꾸지 않으며, 요청자와 결정자는 달라야 합니다.
-- 셀(수업일·학적) 단위로 묶고, 요청 당시의 현재 버전(base_version, 미입력은 0)을 기록해 승인 시 경합을 감지합니다.
CREATE TABLE IF NOT EXISTS public.academic_attendance_corrections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_event_id uuid NOT NULL CONSTRAINT academic_attendance_corrections_event_fk REFERENCES public.schedule_events(id) ON DELETE RESTRICT,
  enrollment_id uuid NOT NULL CONSTRAINT academic_attendance_corrections_enrollment_fk REFERENCES public.cohort_enrollments(id) ON DELETE RESTRICT,
  cohort_id uuid NOT NULL CONSTRAINT academic_attendance_corrections_cohort_fk REFERENCES public.cohorts(id) ON DELETE RESTRICT,
  class_date date NOT NULL,
  base_version integer NOT NULL,
  previous_status text,
  requested_status text NOT NULL,
  reason text NOT NULL,
  excuse_verification_method text,
  requested_by_user_id uuid NOT NULL CONSTRAINT academic_attendance_corrections_requested_by_fk REFERENCES public.users(id) ON DELETE RESTRICT,
  requested_by_assignment_id uuid NOT NULL CONSTRAINT academic_attendance_corrections_requested_assignment_fk REFERENCES public.academic_cohort_staff_assignments(id) ON DELETE RESTRICT,
  requested_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'PENDING',
  decided_by_user_id uuid CONSTRAINT academic_attendance_corrections_decided_by_fk REFERENCES public.users(id) ON DELETE RESTRICT,
  decided_by_assignment_id uuid CONSTRAINT academic_attendance_corrections_decided_assignment_fk REFERENCES public.academic_cohort_staff_assignments(id) ON DELETE RESTRICT,
  decided_by_manager_designation_id uuid CONSTRAINT academic_attendance_corrections_decided_manager_fk REFERENCES public.academic_operations_managers(id) ON DELETE RESTRICT,
  decided_at timestamptz,
  CONSTRAINT academic_attendance_corrections_status_check CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  CONSTRAINT academic_attendance_corrections_requested_status_check CHECK (requested_status IN ('PRESENT', 'LATE', 'ABSENT', 'EXCUSED')),
  CONSTRAINT academic_attendance_corrections_previous_status_check CHECK (previous_status IS NULL OR previous_status IN ('PRESENT', 'LATE', 'ABSENT', 'EXCUSED')),
  CONSTRAINT academic_attendance_corrections_change_check CHECK (previous_status IS DISTINCT FROM requested_status),
  CONSTRAINT academic_attendance_corrections_version_check CHECK (base_version >= 0 AND ((base_version = 0) = (previous_status IS NULL))),
  CONSTRAINT academic_attendance_corrections_reason_check CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  CONSTRAINT academic_attendance_corrections_excuse_check CHECK (
    (requested_status = 'EXCUSED' AND excuse_verification_method IN ('DOCUMENT_SIGHTED', 'VERIFIED_CONTACT'))
    OR (requested_status <> 'EXCUSED' AND excuse_verification_method IS NULL)),
  CONSTRAINT academic_attendance_corrections_decision_check CHECK (
    (status = 'PENDING' AND decided_by_user_id IS NULL AND decided_by_assignment_id IS NULL
      AND decided_by_manager_designation_id IS NULL AND decided_at IS NULL)
    OR (status IN ('APPROVED', 'REJECTED') AND decided_by_user_id IS NOT NULL AND decided_at IS NOT NULL
      AND num_nonnulls(decided_by_assignment_id, decided_by_manager_designation_id) = 1)),
  CONSTRAINT academic_attendance_corrections_self_approval_check CHECK (decided_by_user_id IS NULL OR decided_by_user_id <> requested_by_user_id),
  CONSTRAINT academic_attendance_corrections_excused_authority_check CHECK (
    status = 'PENDING' OR decided_by_manager_designation_id IS NOT NULL
    OR (requested_status <> 'EXCUSED' AND previous_status IS DISTINCT FROM 'EXCUSED'))
);
-- 같은 셀에는 대기 중 정정 요청이 하나만 있을 수 있습니다.
CREATE UNIQUE INDEX IF NOT EXISTS academic_attendance_corrections_pending_idx
  ON public.academic_attendance_corrections (schedule_event_id, enrollment_id) WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS academic_attendance_corrections_cohort_idx
  ON public.academic_attendance_corrections (cohort_id, status, requested_at);

-- 셀별 현재 출결 상태(P5). 행이 없으면 미입력이며 결석이 아닙니다. 기록 당시 기수·수업일(KST)을 함께 고정합니다.
-- 쓰기는 이 파일의 함수만 수행하며, 모든 변경은 version을 1씩 올리고 academic_attendance_events에 이력을 남깁니다.
CREATE TABLE IF NOT EXISTS public.academic_attendance_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_event_id uuid NOT NULL CONSTRAINT academic_attendance_records_event_fk REFERENCES public.schedule_events(id) ON DELETE RESTRICT,
  enrollment_id uuid NOT NULL CONSTRAINT academic_attendance_records_enrollment_fk REFERENCES public.cohort_enrollments(id) ON DELETE RESTRICT,
  cohort_id uuid NOT NULL CONSTRAINT academic_attendance_records_cohort_fk REFERENCES public.cohorts(id) ON DELETE RESTRICT,
  class_date date NOT NULL,
  status text NOT NULL,
  version integer NOT NULL,
  recorded_by_user_id uuid NOT NULL CONSTRAINT academic_attendance_records_recorded_by_fk REFERENCES public.users(id) ON DELETE RESTRICT,
  recorded_by_assignment_id uuid NOT NULL CONSTRAINT academic_attendance_records_recorded_assignment_fk REFERENCES public.academic_cohort_staff_assignments(id) ON DELETE RESTRICT,
  last_correction_id uuid CONSTRAINT academic_attendance_records_correction_fk REFERENCES public.academic_attendance_corrections(id) ON DELETE RESTRICT,
  recorded_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT academic_attendance_records_cell_unique UNIQUE (schedule_event_id, enrollment_id),
  CONSTRAINT academic_attendance_records_status_check CHECK (status IN ('PRESENT', 'LATE', 'ABSENT', 'EXCUSED')),
  CONSTRAINT academic_attendance_records_version_check CHECK (version >= 1),
  CONSTRAINT academic_attendance_records_excused_check CHECK (status <> 'EXCUSED' OR last_correction_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS academic_attendance_records_enrollment_idx
  ON public.academic_attendance_records (enrollment_id, class_date);

-- 최초 입력·직접 수정·정정 요청·승인·반려의 추가 전용 이력. 요청 ID로 재시도를 멱등 처리합니다.
-- 행위자의 당시 권한 근거(배정 또는 관리자 지정)와 전후 상태·버전을 남기고, 사유 원문은 정정 표에만 둡니다.
CREATE TABLE IF NOT EXISTS public.academic_attendance_events (
  request_id uuid PRIMARY KEY,
  action text NOT NULL,
  actor_user_id uuid NOT NULL CONSTRAINT academic_attendance_events_actor_fk REFERENCES public.users(id) ON DELETE RESTRICT,
  actor_assignment_id uuid CONSTRAINT academic_attendance_events_assignment_fk REFERENCES public.academic_cohort_staff_assignments(id) ON DELETE RESTRICT,
  actor_manager_designation_id uuid CONSTRAINT academic_attendance_events_manager_fk REFERENCES public.academic_operations_managers(id) ON DELETE RESTRICT,
  schedule_event_id uuid NOT NULL CONSTRAINT academic_attendance_events_event_fk REFERENCES public.schedule_events(id) ON DELETE RESTRICT,
  enrollment_id uuid NOT NULL CONSTRAINT academic_attendance_events_enrollment_fk REFERENCES public.cohort_enrollments(id) ON DELETE RESTRICT,
  record_id uuid CONSTRAINT academic_attendance_events_record_fk REFERENCES public.academic_attendance_records(id) ON DELETE RESTRICT,
  correction_id uuid CONSTRAINT academic_attendance_events_correction_fk REFERENCES public.academic_attendance_corrections(id) ON DELETE RESTRICT,
  previous_status text,
  next_status text,
  previous_version integer NOT NULL,
  next_version integer NOT NULL,
  correlation_id uuid NOT NULL,
  payload_digest varchar(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT academic_attendance_events_action_check CHECK (action IN ('RECORD', 'CORRECTION_REQUEST', 'CORRECTION_APPROVE', 'CORRECTION_REJECT')),
  CONSTRAINT academic_attendance_events_status_check CHECK (
    (previous_status IS NULL OR previous_status IN ('PRESENT', 'LATE', 'ABSENT', 'EXCUSED'))
    AND (next_status IS NULL OR next_status IN ('PRESENT', 'LATE', 'ABSENT', 'EXCUSED'))),
  CONSTRAINT academic_attendance_events_target_check CHECK (
    (action = 'RECORD' AND record_id IS NOT NULL AND correction_id IS NULL AND actor_assignment_id IS NOT NULL
      AND actor_manager_designation_id IS NULL AND next_status IS NOT NULL AND next_version = previous_version + 1)
    OR (action = 'CORRECTION_REQUEST' AND correction_id IS NOT NULL AND actor_assignment_id IS NOT NULL
      AND actor_manager_designation_id IS NULL AND next_status IS NOT NULL AND next_version = previous_version)
    OR (action = 'CORRECTION_APPROVE' AND correction_id IS NOT NULL AND record_id IS NOT NULL AND next_status IS NOT NULL
      AND next_version = previous_version + 1 AND num_nonnulls(actor_assignment_id, actor_manager_designation_id) = 1)
    OR (action = 'CORRECTION_REJECT' AND correction_id IS NOT NULL AND next_version = previous_version
      AND num_nonnulls(actor_assignment_id, actor_manager_designation_id) = 1)),
  CONSTRAINT academic_attendance_events_payload_digest_check CHECK (payload_digest ~ '^[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS academic_attendance_events_cell_idx
  ON public.academic_attendance_events (schedule_event_id, enrollment_id, created_at);

-- 이미 있던 표가 이 파일의 정의와 다르면 자동 보정하지 않고 중단합니다. 컬럼·제약·인덱스·RLS를 실제 catalog로 대조합니다.
DO $shape$
DECLARE
  expected record;
BEGIN
  FOR expected IN SELECT * FROM (VALUES
    ('public.academic_attendance_corrections'::regclass, '[["id","uuid",true,"gen_random_uuid()"],
      ["schedule_event_id","uuid",true,""],["enrollment_id","uuid",true,""],["cohort_id","uuid",true,""],
      ["class_date","date",true,""],["base_version","integer",true,""],["previous_status","text",false,""],
      ["requested_status","text",true,""],["reason","text",true,""],["excuse_verification_method","text",false,""],
      ["requested_by_user_id","uuid",true,""],["requested_by_assignment_id","uuid",true,""],
      ["requested_at","timestamp with time zone",true,"now()"],["status","text",true,"''PENDING''::text"],
      ["decided_by_user_id","uuid",false,""],["decided_by_assignment_id","uuid",false,""],
      ["decided_by_manager_designation_id","uuid",false,""],["decided_at","timestamp with time zone",false,""]]'::jsonb, 19, 3),
    ('public.academic_attendance_records'::regclass, '[["id","uuid",true,"gen_random_uuid()"],
      ["schedule_event_id","uuid",true,""],["enrollment_id","uuid",true,""],["cohort_id","uuid",true,""],
      ["class_date","date",true,""],["status","text",true,""],["version","integer",true,""],
      ["recorded_by_user_id","uuid",true,""],["recorded_by_assignment_id","uuid",true,""],
      ["last_correction_id","uuid",false,""],["recorded_at","timestamp with time zone",true,""],
      ["created_at","timestamp with time zone",true,"now()"]]'::jsonb, 11, 3),
    ('public.academic_attendance_events'::regclass, '[["request_id","uuid",true,""],["action","text",true,""],
      ["actor_user_id","uuid",true,""],["actor_assignment_id","uuid",false,""],["actor_manager_designation_id","uuid",false,""],
      ["schedule_event_id","uuid",true,""],["enrollment_id","uuid",true,""],["record_id","uuid",false,""],
      ["correction_id","uuid",false,""],["previous_status","text",false,""],["next_status","text",false,""],
      ["previous_version","integer",true,""],["next_version","integer",true,""],["correlation_id","uuid",true,""],
      ["payload_digest","character varying(64)",true,""],["created_at","timestamp with time zone",true,"now()"]]'::jsonb, 12, 2)
  ) AS tables(relation, columns, constraint_count, index_count) LOOP
    IF (SELECT jsonb_agg(jsonb_build_array(a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull,
        COALESCE(pg_get_expr(d.adbin, d.adrelid), '')) ORDER BY a.attnum)
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = expected.relation AND a.attnum > 0 AND NOT a.attisdropped) IS DISTINCT FROM expected.columns THEN
      RAISE EXCEPTION 'attendance_migration_column_mismatch';
    END IF;
    -- 이름이 다른 추가 제약·인덱스·RLS나 지연 제약이 있으면 같은 의미라고 보지 않습니다.
    IF (SELECT count(*) FROM pg_constraint WHERE conrelid = expected.relation AND contype <> 'n') <> expected.constraint_count
      OR EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = expected.relation AND contype <> 'n'
        AND (condeferrable OR NOT convalidated))
      OR (SELECT count(*) FROM pg_index WHERE indrelid = expected.relation AND indisvalid AND indisready AND indislive) <> expected.index_count
      OR (SELECT count(*) FROM pg_index WHERE indrelid = expected.relation) <> expected.index_count
      OR EXISTS (SELECT 1 FROM pg_class WHERE oid = expected.relation AND (relkind <> 'r' OR relrowsecurity OR relforcerowsecurity)) THEN
      RAISE EXCEPTION 'attendance_migration_structure_mismatch';
    END IF;
  END LOOP;
  -- 키·외래키 정의는 이름과 PostgreSQL이 해석한 정의를 함께 비교합니다.
  FOR expected IN SELECT * FROM (VALUES
    ('academic_attendance_corrections', 'academic_attendance_corrections_pkey', 'PRIMARY KEY (id)'),
    ('academic_attendance_corrections', 'academic_attendance_corrections_event_fk', 'FOREIGN KEY (schedule_event_id) REFERENCES schedule_events(id) ON DELETE RESTRICT'),
    ('academic_attendance_corrections', 'academic_attendance_corrections_enrollment_fk', 'FOREIGN KEY (enrollment_id) REFERENCES cohort_enrollments(id) ON DELETE RESTRICT'),
    ('academic_attendance_corrections', 'academic_attendance_corrections_cohort_fk', 'FOREIGN KEY (cohort_id) REFERENCES cohorts(id) ON DELETE RESTRICT'),
    ('academic_attendance_corrections', 'academic_attendance_corrections_requested_by_fk', 'FOREIGN KEY (requested_by_user_id) REFERENCES users(id) ON DELETE RESTRICT'),
    ('academic_attendance_corrections', 'academic_attendance_corrections_requested_assignment_fk', 'FOREIGN KEY (requested_by_assignment_id) REFERENCES academic_cohort_staff_assignments(id) ON DELETE RESTRICT'),
    ('academic_attendance_corrections', 'academic_attendance_corrections_decided_by_fk', 'FOREIGN KEY (decided_by_user_id) REFERENCES users(id) ON DELETE RESTRICT'),
    ('academic_attendance_corrections', 'academic_attendance_corrections_decided_assignment_fk', 'FOREIGN KEY (decided_by_assignment_id) REFERENCES academic_cohort_staff_assignments(id) ON DELETE RESTRICT'),
    ('academic_attendance_corrections', 'academic_attendance_corrections_decided_manager_fk', 'FOREIGN KEY (decided_by_manager_designation_id) REFERENCES academic_operations_managers(id) ON DELETE RESTRICT'),
    ('academic_attendance_records', 'academic_attendance_records_pkey', 'PRIMARY KEY (id)'),
    ('academic_attendance_records', 'academic_attendance_records_cell_unique', 'UNIQUE (schedule_event_id, enrollment_id)'),
    ('academic_attendance_records', 'academic_attendance_records_event_fk', 'FOREIGN KEY (schedule_event_id) REFERENCES schedule_events(id) ON DELETE RESTRICT'),
    ('academic_attendance_records', 'academic_attendance_records_enrollment_fk', 'FOREIGN KEY (enrollment_id) REFERENCES cohort_enrollments(id) ON DELETE RESTRICT'),
    ('academic_attendance_records', 'academic_attendance_records_cohort_fk', 'FOREIGN KEY (cohort_id) REFERENCES cohorts(id) ON DELETE RESTRICT'),
    ('academic_attendance_records', 'academic_attendance_records_recorded_by_fk', 'FOREIGN KEY (recorded_by_user_id) REFERENCES users(id) ON DELETE RESTRICT'),
    ('academic_attendance_records', 'academic_attendance_records_recorded_assignment_fk', 'FOREIGN KEY (recorded_by_assignment_id) REFERENCES academic_cohort_staff_assignments(id) ON DELETE RESTRICT'),
    ('academic_attendance_records', 'academic_attendance_records_correction_fk', 'FOREIGN KEY (last_correction_id) REFERENCES academic_attendance_corrections(id) ON DELETE RESTRICT'),
    ('academic_attendance_events', 'academic_attendance_events_pkey', 'PRIMARY KEY (request_id)'),
    ('academic_attendance_events', 'academic_attendance_events_actor_fk', 'FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT'),
    ('academic_attendance_events', 'academic_attendance_events_assignment_fk', 'FOREIGN KEY (actor_assignment_id) REFERENCES academic_cohort_staff_assignments(id) ON DELETE RESTRICT'),
    ('academic_attendance_events', 'academic_attendance_events_manager_fk', 'FOREIGN KEY (actor_manager_designation_id) REFERENCES academic_operations_managers(id) ON DELETE RESTRICT'),
    ('academic_attendance_events', 'academic_attendance_events_event_fk', 'FOREIGN KEY (schedule_event_id) REFERENCES schedule_events(id) ON DELETE RESTRICT'),
    ('academic_attendance_events', 'academic_attendance_events_enrollment_fk', 'FOREIGN KEY (enrollment_id) REFERENCES cohort_enrollments(id) ON DELETE RESTRICT'),
    ('academic_attendance_events', 'academic_attendance_events_record_fk', 'FOREIGN KEY (record_id) REFERENCES academic_attendance_records(id) ON DELETE RESTRICT'),
    ('academic_attendance_events', 'academic_attendance_events_correction_fk', 'FOREIGN KEY (correction_id) REFERENCES academic_attendance_corrections(id) ON DELETE RESTRICT')
  ) AS definitions(relation, name, definition) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = ('public.' || expected.relation)::regclass
      AND c.conname = expected.name AND pg_get_constraintdef(c.oid) = expected.definition) THEN
      RAISE EXCEPTION 'attendance_migration_constraint_mismatch';
    END IF;
  END LOOP;
  -- 조회·잠금 경로가 기대하는 보조 인덱스의 열 구성과 부분 유일 조건도 확인합니다.
  FOR expected IN SELECT * FROM (VALUES
    ('academic_attendance_corrections_pending_idx',
      'CREATE UNIQUE INDEX academic_attendance_corrections_pending_idx ON public.academic_attendance_corrections USING btree (schedule_event_id, enrollment_id) WHERE (status = ''PENDING''::text)'),
    ('academic_attendance_corrections_cohort_idx',
      'CREATE INDEX academic_attendance_corrections_cohort_idx ON public.academic_attendance_corrections USING btree (cohort_id, status, requested_at)'),
    ('academic_attendance_records_enrollment_idx',
      'CREATE INDEX academic_attendance_records_enrollment_idx ON public.academic_attendance_records USING btree (enrollment_id, class_date)'),
    ('academic_attendance_events_cell_idx',
      'CREATE INDEX academic_attendance_events_cell_idx ON public.academic_attendance_events USING btree (schedule_event_id, enrollment_id, created_at)')
  ) AS indexes(name, definition) LOOP
    IF (SELECT pg_get_indexdef(c.oid) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = expected.name) IS DISTINCT FROM expected.definition THEN
      RAISE EXCEPTION 'attendance_migration_index_mismatch';
    END IF;
  END LOOP;
END;
$shape$;

-- CHECK 식은 버전마다 출력 형식이 달라질 수 있어 같은 정의로 만든 임시 표의 파서 결과와 비교합니다.
CREATE TEMP TABLE academic_attendance_expected_correction_checks (
  status text, requested_status text, previous_status text, base_version integer, reason text,
  excuse_verification_method text, decided_by_user_id uuid, decided_by_assignment_id uuid,
  decided_by_manager_designation_id uuid, decided_at timestamptz, requested_by_user_id uuid,
  CONSTRAINT academic_attendance_corrections_status_check CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  CONSTRAINT academic_attendance_corrections_requested_status_check CHECK (requested_status IN ('PRESENT', 'LATE', 'ABSENT', 'EXCUSED')),
  CONSTRAINT academic_attendance_corrections_previous_status_check CHECK (previous_status IS NULL OR previous_status IN ('PRESENT', 'LATE', 'ABSENT', 'EXCUSED')),
  CONSTRAINT academic_attendance_corrections_change_check CHECK (previous_status IS DISTINCT FROM requested_status),
  CONSTRAINT academic_attendance_corrections_version_check CHECK (base_version >= 0 AND ((base_version = 0) = (previous_status IS NULL))),
  CONSTRAINT academic_attendance_corrections_reason_check CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  CONSTRAINT academic_attendance_corrections_excuse_check CHECK (
    (requested_status = 'EXCUSED' AND excuse_verification_method IN ('DOCUMENT_SIGHTED', 'VERIFIED_CONTACT'))
    OR (requested_status <> 'EXCUSED' AND excuse_verification_method IS NULL)),
  CONSTRAINT academic_attendance_corrections_decision_check CHECK (
    (status = 'PENDING' AND decided_by_user_id IS NULL AND decided_by_assignment_id IS NULL
      AND decided_by_manager_designation_id IS NULL AND decided_at IS NULL)
    OR (status IN ('APPROVED', 'REJECTED') AND decided_by_user_id IS NOT NULL AND decided_at IS NOT NULL
      AND num_nonnulls(decided_by_assignment_id, decided_by_manager_designation_id) = 1)),
  CONSTRAINT academic_attendance_corrections_self_approval_check CHECK (decided_by_user_id IS NULL OR decided_by_user_id <> requested_by_user_id),
  CONSTRAINT academic_attendance_corrections_excused_authority_check CHECK (
    status = 'PENDING' OR decided_by_manager_designation_id IS NOT NULL
    OR (requested_status <> 'EXCUSED' AND previous_status IS DISTINCT FROM 'EXCUSED'))
) ON COMMIT DROP;
CREATE TEMP TABLE academic_attendance_expected_record_checks (
  status text, version integer, last_correction_id uuid,
  CONSTRAINT academic_attendance_records_status_check CHECK (status IN ('PRESENT', 'LATE', 'ABSENT', 'EXCUSED')),
  CONSTRAINT academic_attendance_records_version_check CHECK (version >= 1),
  CONSTRAINT academic_attendance_records_excused_check CHECK (status <> 'EXCUSED' OR last_correction_id IS NOT NULL)
) ON COMMIT DROP;
CREATE TEMP TABLE academic_attendance_expected_event_checks (
  action text, record_id uuid, correction_id uuid, actor_assignment_id uuid, actor_manager_designation_id uuid,
  previous_status text, next_status text, previous_version integer, next_version integer, payload_digest varchar(64),
  CONSTRAINT academic_attendance_events_action_check CHECK (action IN ('RECORD', 'CORRECTION_REQUEST', 'CORRECTION_APPROVE', 'CORRECTION_REJECT')),
  CONSTRAINT academic_attendance_events_status_check CHECK (
    (previous_status IS NULL OR previous_status IN ('PRESENT', 'LATE', 'ABSENT', 'EXCUSED'))
    AND (next_status IS NULL OR next_status IN ('PRESENT', 'LATE', 'ABSENT', 'EXCUSED'))),
  CONSTRAINT academic_attendance_events_target_check CHECK (
    (action = 'RECORD' AND record_id IS NOT NULL AND correction_id IS NULL AND actor_assignment_id IS NOT NULL
      AND actor_manager_designation_id IS NULL AND next_status IS NOT NULL AND next_version = previous_version + 1)
    OR (action = 'CORRECTION_REQUEST' AND correction_id IS NOT NULL AND actor_assignment_id IS NOT NULL
      AND actor_manager_designation_id IS NULL AND next_status IS NOT NULL AND next_version = previous_version)
    OR (action = 'CORRECTION_APPROVE' AND correction_id IS NOT NULL AND record_id IS NOT NULL AND next_status IS NOT NULL
      AND next_version = previous_version + 1 AND num_nonnulls(actor_assignment_id, actor_manager_designation_id) = 1)
    OR (action = 'CORRECTION_REJECT' AND correction_id IS NOT NULL AND next_version = previous_version
      AND num_nonnulls(actor_assignment_id, actor_manager_designation_id) = 1)),
  CONSTRAINT academic_attendance_events_payload_digest_check CHECK (payload_digest ~ '^[0-9a-f]{64}$')
) ON COMMIT DROP;
DO $checks$
DECLARE
  pair record;
BEGIN
  FOR pair IN SELECT * FROM (VALUES
    ('public.academic_attendance_corrections'::regclass, 'pg_temp.academic_attendance_expected_correction_checks'::regclass),
    ('public.academic_attendance_records'::regclass, 'pg_temp.academic_attendance_expected_record_checks'::regclass),
    ('public.academic_attendance_events'::regclass, 'pg_temp.academic_attendance_expected_event_checks'::regclass)
  ) AS pairs(actual, expected) LOOP
    IF (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname)
        FROM pg_constraint WHERE conrelid = pair.actual AND contype = 'c')
      IS DISTINCT FROM (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname)
        FROM pg_constraint WHERE conrelid = pair.expected AND contype = 'c') THEN
      RAISE EXCEPTION 'attendance_migration_check_mismatch';
    END IF;
  END LOOP;
END;
$checks$;

COMMENT ON TABLE public.academic_attendance_records IS
  '#159 셀(수업일·학적)별 현재 출결. 행 없음=미입력. 함수로만 쓰며 변경마다 version+1·이력 추가. 보존: 수료 판정 확정일 후 1년(정책 초안).';
COMMENT ON TABLE public.academic_attendance_corrections IS
  '#159 입력 창 이후 정정·인정결석 요청과 결정. 요청자≠결정자, EXCUSED는 학사 운영 관리자만 승인. 보존: 해당 출결과 같음(1년).';
COMMENT ON TABLE public.academic_attendance_events IS
  '#159 출결 입력·정정 요청·결정의 추가 전용 이력과 요청 멱등성. 사유 원문 대신 요약값만 저장.';

-- 출결 현재 값과 정정 기록은 이 파일의 함수가 트랜잭션 범위 표지를 켠 동안에만 쓸 수 있습니다.
-- 삭제·비우기는 승인된 파기 절차가 생기기 전까지 막고, 허용된 변경의 모양도 함께 검사합니다.
CREATE OR REPLACE FUNCTION public.guard_academic_attendance_write() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $guard$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') OR COALESCE(current_setting('hra.academic_attendance_write', true), '') <> 'on' THEN
    RAISE SQLSTATE 'HRA04' USING MESSAGE = '출결 기록은 출결 함수로만 변경할 수 있습니다.';
  END IF;
  IF TG_TABLE_NAME = 'academic_attendance_records' THEN
    IF TG_OP = 'INSERT' AND NEW.version <> 1 THEN
      RAISE SQLSTATE 'HRA04' USING MESSAGE = '새 출결 기록의 버전이 올바르지 않습니다.';
    END IF;
    -- 셀 식별·기록 당시 기수·수업일은 바꿀 수 없고, 변경마다 버전이 정확히 1 증가합니다.
    IF TG_OP = 'UPDATE' AND (NEW.id <> OLD.id OR NEW.schedule_event_id <> OLD.schedule_event_id
      OR NEW.enrollment_id <> OLD.enrollment_id OR NEW.cohort_id <> OLD.cohort_id OR NEW.class_date <> OLD.class_date
      OR NEW.created_at <> OLD.created_at OR NEW.version <> OLD.version + 1) THEN
      RAISE SQLSTATE 'HRA04' USING MESSAGE = '출결 기록의 셀 정보는 바꿀 수 없습니다.';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'INSERT' AND NEW.status <> 'PENDING' THEN
    RAISE SQLSTATE 'HRA04' USING MESSAGE = '정정 요청은 대기 상태로만 만듭니다.';
  END IF;
  -- 정정 기록은 대기 → 승인·반려 결정 한 번만 기록하고 요청 내용은 바꾸지 않습니다.
  IF TG_OP = 'UPDATE' AND (OLD.status <> 'PENDING' OR NEW.status NOT IN ('APPROVED', 'REJECTED')
    OR to_jsonb(NEW) - ARRAY['status', 'decided_by_user_id', 'decided_by_assignment_id',
      'decided_by_manager_designation_id', 'decided_at']
      IS DISTINCT FROM to_jsonb(OLD) - ARRAY['status', 'decided_by_user_id', 'decided_by_assignment_id',
      'decided_by_manager_designation_id', 'decided_at']) THEN
    RAISE SQLSTATE 'HRA04' USING MESSAGE = '정정 기록은 결정 기록 외에 바꿀 수 없습니다.';
  END IF;
  RETURN NEW;
END;
$guard$;

-- 이력은 출결 함수가 추가만 합니다.
CREATE OR REPLACE FUNCTION public.guard_academic_attendance_events() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $events$
BEGIN
  IF TG_OP = 'INSERT' AND COALESCE(current_setting('hra.academic_attendance_write', true), '') = 'on' THEN
    RETURN NEW;
  END IF;
  RAISE SQLSTATE 'HRA04' USING MESSAGE = '출결 이력은 수정·삭제할 수 없습니다.';
END;
$events$;

DROP TRIGGER IF EXISTS academic_attendance_records_guard ON public.academic_attendance_records;
CREATE TRIGGER academic_attendance_records_guard BEFORE INSERT OR UPDATE OR DELETE ON public.academic_attendance_records
  FOR EACH ROW EXECUTE FUNCTION public.guard_academic_attendance_write();
DROP TRIGGER IF EXISTS academic_attendance_records_truncate_guard ON public.academic_attendance_records;
CREATE TRIGGER academic_attendance_records_truncate_guard BEFORE TRUNCATE ON public.academic_attendance_records
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_academic_attendance_write();
DROP TRIGGER IF EXISTS academic_attendance_corrections_guard ON public.academic_attendance_corrections;
CREATE TRIGGER academic_attendance_corrections_guard BEFORE INSERT OR UPDATE OR DELETE ON public.academic_attendance_corrections
  FOR EACH ROW EXECUTE FUNCTION public.guard_academic_attendance_write();
DROP TRIGGER IF EXISTS academic_attendance_corrections_truncate_guard ON public.academic_attendance_corrections;
CREATE TRIGGER academic_attendance_corrections_truncate_guard BEFORE TRUNCATE ON public.academic_attendance_corrections
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_academic_attendance_write();
DROP TRIGGER IF EXISTS academic_attendance_events_guard ON public.academic_attendance_events;
CREATE TRIGGER academic_attendance_events_guard BEFORE INSERT OR UPDATE OR DELETE ON public.academic_attendance_events
  FOR EACH ROW EXECUTE FUNCTION public.guard_academic_attendance_events();
DROP TRIGGER IF EXISTS academic_attendance_events_truncate_guard ON public.academic_attendance_events;
CREATE TRIGGER academic_attendance_events_truncate_guard BEFORE TRUNCATE ON public.academic_attendance_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_academic_attendance_events();

-- 이 파일이 만든 트리거 외의 사용자 트리거가 쓰기 의미를 바꾸면 중단합니다.
DO $triggers$
BEGIN
  IF (SELECT array_agg(c.relname::text || ':' || t.tgname::text || ':' || p.proname::text ORDER BY c.relname, t.tgname)
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE NOT t.tgisinternal AND c.oid IN ('public.academic_attendance_records'::regclass,
        'public.academic_attendance_corrections'::regclass, 'public.academic_attendance_events'::regclass))
    IS DISTINCT FROM ARRAY[
      'academic_attendance_corrections:academic_attendance_corrections_guard:guard_academic_attendance_write',
      'academic_attendance_corrections:academic_attendance_corrections_truncate_guard:guard_academic_attendance_write',
      'academic_attendance_events:academic_attendance_events_guard:guard_academic_attendance_events',
      'academic_attendance_events:academic_attendance_events_truncate_guard:guard_academic_attendance_events',
      'academic_attendance_records:academic_attendance_records_guard:guard_academic_attendance_write',
      'academic_attendance_records:academic_attendance_records_truncate_guard:guard_academic_attendance_write']
    OR EXISTS (SELECT 1 FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgenabled <> 'O'
      AND t.tgrelid IN ('public.academic_attendance_records'::regclass,
        'public.academic_attendance_corrections'::regclass, 'public.academic_attendance_events'::regclass)) THEN
    RAISE EXCEPTION 'attendance_migration_trigger_mismatch';
  END IF;
END;
$triggers$;

-- 수업일(KST 날짜). schedule_events.event_date는 시간대 없는 UTC 값으로 저장됩니다(src/lib/db/schema.ts).
CREATE OR REPLACE FUNCTION public.academic_attendance_class_date(p_event_date timestamp)
RETURNS date LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $class_date$
  SELECT ((p_event_date AT TIME ZONE 'UTC') AT TIME ZONE 'Asia/Seoul')::date;
$class_date$;

-- 7일 입력 창(P6): 수업일 KST 00:00부터 수업일+7일 KST 24:00 미만, 즉 [수업일 00:00, 수업일+8일 00:00) KST.
CREATE OR REPLACE FUNCTION public.academic_attendance_window(p_class_date date)
RETURNS tstzrange LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $window$
  SELECT tstzrange(p_class_date::timestamp AT TIME ZONE 'Asia/Seoul',
    (p_class_date + 8)::timestamp AT TIME ZONE 'Asia/Seoul', '[)');
$window$;

-- 요청 멱등성: 같은 요청 ID는 같은 주체·행위·입력일 때만 이전 결과를 돌려주고, 다르면 HRA02로 거부합니다.
CREATE OR REPLACE FUNCTION public.academic_attendance_replay(
  p_request_id uuid, p_actor_id uuid, p_action text, p_digest text
) RETURNS public.academic_attendance_events
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $replay$
DECLARE
  prior public.academic_attendance_events;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('hra:academic-attendance-request:' || p_request_id::text, 0));
  SELECT * INTO prior FROM public.academic_attendance_events WHERE request_id = p_request_id;
  IF FOUND AND (prior.actor_user_id <> p_actor_id OR prior.action <> p_action OR prior.payload_digest <> p_digest) THEN
    RAISE SQLSTATE 'HRA02' USING MESSAGE = '같은 요청 ID를 다른 변경에 사용할 수 없습니다.';
  END IF;
  RETURN prior;
END;
$replay$;

-- 셀(수업일·학적)을 확인하고 잠급니다. CLASS 수업, 수업과 같은 기수의 학적, 수업일에 유효했던 학적만 허용합니다.
-- 수업·학적 행을 FOR KEY SHARE로 잡아 판정 중 삭제·키 변경을 막고, 셀 단위 advisory lock으로 같은 셀 쓰기를 직렬화합니다.
CREATE OR REPLACE FUNCTION public.lock_academic_attendance_cell(
  p_schedule_event_id uuid, p_enrollment_id uuid, OUT cohort_id uuid, OUT class_date date
) LANGUAGE plpgsql SET search_path = pg_catalog, public AS $cell$
DECLARE
  event_row record;
  enrollment_row record;
  day_starts timestamptz;
BEGIN
  -- 잠금 후 재조회가 최신 커밋을 보도록 READ COMMITTED만 허용합니다.
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE SQLSTATE 'HRA07' USING MESSAGE = '출결은 READ COMMITTED 트랜잭션에서만 기록합니다.';
  END IF;
  SELECT e.cohort_id, e.event_type::text AS event_type, e.event_date INTO event_row
    FROM public.schedule_events e WHERE e.id = p_schedule_event_id FOR KEY SHARE;
  IF NOT FOUND OR event_row.event_type <> 'CLASS' OR event_row.cohort_id IS NULL OR event_row.event_date IS NULL THEN
    RAISE SQLSTATE 'HRA03' USING MESSAGE = '출결 대상 수업을 찾을 수 없습니다.';
  END IF;
  class_date := public.academic_attendance_class_date(event_row.event_date);
  day_starts := lower(public.academic_attendance_window(class_date));
  SELECT ce.cohort_id, ce.status::text AS status, ce.enrolled_at, ce.ended_at INTO enrollment_row
    FROM public.cohort_enrollments ce WHERE ce.id = p_enrollment_id FOR KEY SHARE;
  -- 학적은 수업일(KST 하루) 중 일부라도 유효했어야 합니다. 이후 학적 종료·이동은 과거 셀 판정을 바꾸지 않습니다.
  IF NOT FOUND OR enrollment_row.cohort_id <> event_row.cohort_id OR enrollment_row.status <> 'ENROLLED'
    OR enrollment_row.enrolled_at >= day_starts + interval '1 day'
    OR (enrollment_row.ended_at IS NOT NULL AND enrollment_row.ended_at <= day_starts) THEN
    RAISE SQLSTATE 'HRA03' USING MESSAGE = '이 수업의 출결 대상 학적을 찾을 수 없습니다.';
  END IF;
  cohort_id := event_row.cohort_id;
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'hra:academic-attendance-cell:' || p_schedule_event_id::text || ':' || p_enrollment_id::text, 0));
END;
$cell$;

-- 요청 시각(DB now()) 기준 해당 기수의 유효 배정을 잠그고 반환합니다. 판정은 #165 can_record_academic_attendance를
-- 같은 트랜잭션에서 다시 호출하고, 배정 행을 FOR SHARE로 잡아 판정과 기록 사이의 배정 종료 경합을 막습니다.
CREATE OR REPLACE FUNCTION public.require_academic_attendance_staff(p_actor_id uuid, p_cohort_id uuid)
RETURNS uuid LANGUAGE plpgsql SET search_path = pg_catalog, public AS $staff$
DECLARE
  assignment_id uuid;
BEGIN
  SELECT s.id INTO assignment_id FROM public.academic_cohort_staff_assignments s
    JOIN public.users u ON u.id = s.user_id
    WHERE s.user_id = p_actor_id AND s.cohort_id = p_cohort_id AND s.staff_role IN ('ADVISOR', 'ASSISTANT')
      AND s.valid_from <= now() AND (s.valid_to IS NULL OR now() < s.valid_to)
      AND u.role::text IN ('ADMIN', 'FACULTY', 'MEMBER')
    ORDER BY s.valid_from DESC LIMIT 1 FOR SHARE OF s, u;
  IF assignment_id IS NULL OR NOT public.can_record_academic_attendance(p_actor_id, p_cohort_id) THEN
    RAISE SQLSTATE 'HRA01' USING MESSAGE = '해당 기수의 유효한 운영 인력만 출결을 다룰 수 있습니다.';
  END IF;
  RETURN assignment_id;
END;
$staff$;

-- 현재 유효한 학사 운영 관리자 지정이 있으면 그 ID를, 없으면 NULL을 반환합니다(오류 없음).
CREATE OR REPLACE FUNCTION public.find_academic_attendance_manager(p_actor_id uuid)
RETURNS uuid LANGUAGE plpgsql SET search_path = pg_catalog, public AS $manager$
DECLARE
  designation_id uuid;
BEGIN
  SELECT m.id INTO designation_id FROM public.academic_operations_managers m
    JOIN public.users u ON u.id = m.user_id
    WHERE m.user_id = p_actor_id AND m.valid_from <= now() AND (m.valid_to IS NULL OR now() < m.valid_to)
      AND u.role::text IN ('ADMIN', 'FACULTY', 'MEMBER')
    ORDER BY m.valid_from DESC LIMIT 1 FOR SHARE OF m, u;
  RETURN designation_id;
END;
$manager$;

-- 출결 직접 입력(P5·P6). 7일 입력 창 안에서 유효 배정자만 PRESENT·LATE·ABSENT를 입력·수정합니다.
-- p_expected_version은 호출자가 본 현재 버전(미입력은 0)이며 다르면 HRA06으로 거부해 동시 입력 중 하나만 반영합니다.
-- EXCUSED 지정·해제, 창 이후 변경, 대기 중 정정이 있는 셀은 직접 바꾸지 않고 정정 절차(HRA08·HRA04)로 보냅니다.
CREATE OR REPLACE FUNCTION public.record_academic_attendance(
  p_request_id uuid, p_actor_id uuid, p_correlation_id uuid, p_schedule_event_id uuid,
  p_enrollment_id uuid, p_status text, p_expected_version integer
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $record$
DECLARE
  digest text;
  prior public.academic_attendance_events;
  cell record;
  assignment_id uuid;
  entry_window tstzrange;
  current_row public.academic_attendance_records;
  saved public.academic_attendance_records;
BEGIN
  IF p_request_id IS NULL OR p_actor_id IS NULL OR p_correlation_id IS NULL OR p_schedule_event_id IS NULL
    OR p_enrollment_id IS NULL OR p_status IS NULL OR p_status NOT IN ('PRESENT', 'LATE', 'ABSENT', 'EXCUSED')
    OR p_expected_version IS NULL OR p_expected_version < 0 THEN
    RAISE SQLSTATE 'HRA07' USING MESSAGE = '출결 입력값이 올바르지 않습니다.';
  END IF;
  digest := encode(sha256(convert_to(jsonb_build_array('RECORD', p_schedule_event_id, p_enrollment_id, p_status,
    p_expected_version)::text, 'UTF8')), 'hex');
  prior := public.academic_attendance_replay(p_request_id, p_actor_id, 'RECORD', digest);
  IF prior.request_id IS NOT NULL THEN
    SELECT * INTO saved FROM public.academic_attendance_records WHERE id = prior.record_id;
    RETURN jsonb_build_object('record', to_jsonb(saved), 'changed', true, 'replayed', true);
  END IF;
  IF p_status = 'EXCUSED' THEN
    RAISE SQLSTATE 'HRA08' USING MESSAGE = '인정결석은 학사 운영 관리자 승인 절차로만 지정합니다.';
  END IF;
  SELECT * INTO cell FROM public.lock_academic_attendance_cell(p_schedule_event_id, p_enrollment_id);
  assignment_id := public.require_academic_attendance_staff(p_actor_id, cell.cohort_id);
  entry_window := public.academic_attendance_window(cell.class_date);
  IF now() < lower(entry_window) THEN
    RAISE SQLSTATE 'HRA05' USING MESSAGE = '아직 출결 입력 기간이 아닙니다.';
  END IF;
  IF NOT now() <@ entry_window THEN
    RAISE SQLSTATE 'HRA08' USING MESSAGE = '입력 기간이 지나 정정 요청과 승인이 필요합니다.';
  END IF;
  SELECT * INTO current_row FROM public.academic_attendance_records
    WHERE schedule_event_id = p_schedule_event_id AND enrollment_id = p_enrollment_id FOR UPDATE;
  IF COALESCE(current_row.version, 0) <> p_expected_version THEN
    RAISE SQLSTATE 'HRA06' USING MESSAGE = '다른 사람이 먼저 출결을 바꿨습니다. 다시 조회해 주세요.';
  END IF;
  -- 수업 일자·기수가 기록 뒤에 바뀌었으면 기존 셀을 자동으로 옮기지 않습니다.
  IF current_row.id IS NOT NULL AND (current_row.cohort_id <> cell.cohort_id OR current_row.class_date <> cell.class_date) THEN
    RAISE SQLSTATE 'HRA04' USING MESSAGE = '기록 이후 수업 일자나 기수가 바뀌어 직접 수정할 수 없습니다.';
  END IF;
  IF current_row.status = 'EXCUSED' THEN
    RAISE SQLSTATE 'HRA08' USING MESSAGE = '인정결석 해제는 학사 운영 관리자 승인 절차로만 합니다.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.academic_attendance_corrections c WHERE c.schedule_event_id = p_schedule_event_id
    AND c.enrollment_id = p_enrollment_id AND c.status = 'PENDING') THEN
    RAISE SQLSTATE 'HRA04' USING MESSAGE = '결정 대기 중인 정정 요청이 있습니다.';
  END IF;
  IF current_row.status = p_status THEN
    RETURN jsonb_build_object('record', to_jsonb(current_row), 'changed', false, 'replayed', false);
  END IF;
  PERFORM set_config('hra.academic_attendance_write', 'on', true);
  IF current_row.id IS NULL THEN
    INSERT INTO public.academic_attendance_records (schedule_event_id, enrollment_id, cohort_id, class_date, status,
      version, recorded_by_user_id, recorded_by_assignment_id, recorded_at)
      VALUES (p_schedule_event_id, p_enrollment_id, cell.cohort_id, cell.class_date, p_status, 1, p_actor_id,
        assignment_id, now())
      RETURNING * INTO saved;
  ELSE
    UPDATE public.academic_attendance_records SET status = p_status, version = version + 1,
      recorded_by_user_id = p_actor_id, recorded_by_assignment_id = assignment_id, last_correction_id = NULL,
      recorded_at = now()
      WHERE id = current_row.id RETURNING * INTO saved;
  END IF;
  INSERT INTO public.academic_attendance_events (request_id, action, actor_user_id, actor_assignment_id,
    schedule_event_id, enrollment_id, record_id, previous_status, next_status, previous_version, next_version,
    correlation_id, payload_digest)
    VALUES (p_request_id, 'RECORD', p_actor_id, assignment_id, p_schedule_event_id, p_enrollment_id, saved.id,
      current_row.status, saved.status, COALESCE(current_row.version, 0), saved.version, p_correlation_id, digest);
  PERFORM set_config('hra.academic_attendance_write', 'off', true);
  RETURN jsonb_build_object('record', to_jsonb(saved), 'changed', true, 'replayed', false);
END;
$record$;

-- 정정 요청(P7·P8). 유효 배정자가 사유와 함께 요청하며, 현재 값은 승인 전까지 그대로입니다.
-- 입력 창이 지난 셀의 변경과, 창 안팎을 가리지 않는 EXCUSED 지정·해제만 받습니다(창 안의 일반 변경은 직접 입력).
CREATE OR REPLACE FUNCTION public.request_academic_attendance_correction(
  p_request_id uuid, p_actor_id uuid, p_correlation_id uuid, p_schedule_event_id uuid, p_enrollment_id uuid,
  p_requested_status text, p_expected_version integer, p_reason text, p_excuse_verification_method text
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $request$
DECLARE
  digest text;
  prior public.academic_attendance_events;
  cell record;
  assignment_id uuid;
  entry_window tstzrange;
  current_row public.academic_attendance_records;
  correction public.academic_attendance_corrections;
BEGIN
  IF p_request_id IS NULL OR p_actor_id IS NULL OR p_correlation_id IS NULL OR p_schedule_event_id IS NULL
    OR p_enrollment_id IS NULL OR p_requested_status IS NULL
    OR p_requested_status NOT IN ('PRESENT', 'LATE', 'ABSENT', 'EXCUSED')
    OR p_expected_version IS NULL OR p_expected_version < 0
    OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500
    OR (p_requested_status = 'EXCUSED') <> (p_excuse_verification_method IS NOT NULL)
    OR (p_excuse_verification_method IS NOT NULL AND p_excuse_verification_method NOT IN ('DOCUMENT_SIGHTED', 'VERIFIED_CONTACT')) THEN
    RAISE SQLSTATE 'HRA07' USING MESSAGE = '정정 요청 입력이 올바르지 않습니다.';
  END IF;
  digest := encode(sha256(convert_to(jsonb_build_array('CORRECTION_REQUEST', p_schedule_event_id, p_enrollment_id,
    p_requested_status, p_expected_version, p_reason, p_excuse_verification_method)::text, 'UTF8')), 'hex');
  prior := public.academic_attendance_replay(p_request_id, p_actor_id, 'CORRECTION_REQUEST', digest);
  IF prior.request_id IS NOT NULL THEN
    SELECT * INTO correction FROM public.academic_attendance_corrections WHERE id = prior.correction_id;
    RETURN jsonb_build_object('correction', to_jsonb(correction), 'replayed', true);
  END IF;
  SELECT * INTO cell FROM public.lock_academic_attendance_cell(p_schedule_event_id, p_enrollment_id);
  assignment_id := public.require_academic_attendance_staff(p_actor_id, cell.cohort_id);
  entry_window := public.academic_attendance_window(cell.class_date);
  IF now() < lower(entry_window) THEN
    RAISE SQLSTATE 'HRA05' USING MESSAGE = '아직 출결 입력 기간이 아닙니다.';
  END IF;
  SELECT * INTO current_row FROM public.academic_attendance_records
    WHERE schedule_event_id = p_schedule_event_id AND enrollment_id = p_enrollment_id FOR UPDATE;
  IF COALESCE(current_row.version, 0) <> p_expected_version THEN
    RAISE SQLSTATE 'HRA06' USING MESSAGE = '다른 사람이 먼저 출결을 바꿨습니다. 다시 조회해 주세요.';
  END IF;
  IF current_row.id IS NOT NULL AND (current_row.cohort_id <> cell.cohort_id OR current_row.class_date <> cell.class_date) THEN
    RAISE SQLSTATE 'HRA04' USING MESSAGE = '기록 이후 수업 일자나 기수가 바뀌었습니다.';
  END IF;
  IF current_row.status IS NOT DISTINCT FROM p_requested_status
    OR (now() <@ entry_window AND p_requested_status <> 'EXCUSED' AND current_row.status IS DISTINCT FROM 'EXCUSED') THEN
    RAISE SQLSTATE 'HRA07' USING MESSAGE = '입력 기간 안의 일반 변경은 직접 입력합니다.';
  END IF;
  IF EXISTS (SELECT 1 FROM public.academic_attendance_corrections c WHERE c.schedule_event_id = p_schedule_event_id
    AND c.enrollment_id = p_enrollment_id AND c.status = 'PENDING') THEN
    RAISE SQLSTATE 'HRA04' USING MESSAGE = '결정 대기 중인 정정 요청이 이미 있습니다.';
  END IF;
  PERFORM set_config('hra.academic_attendance_write', 'on', true);
  INSERT INTO public.academic_attendance_corrections (schedule_event_id, enrollment_id, cohort_id, class_date,
    base_version, previous_status, requested_status, reason, excuse_verification_method, requested_by_user_id,
    requested_by_assignment_id)
    VALUES (p_schedule_event_id, p_enrollment_id, cell.cohort_id, cell.class_date, COALESCE(current_row.version, 0),
      current_row.status, p_requested_status, btrim(p_reason), p_excuse_verification_method, p_actor_id, assignment_id)
    RETURNING * INTO correction;
  INSERT INTO public.academic_attendance_events (request_id, action, actor_user_id, actor_assignment_id,
    schedule_event_id, enrollment_id, record_id, correction_id, previous_status, next_status, previous_version,
    next_version, correlation_id, payload_digest)
    VALUES (p_request_id, 'CORRECTION_REQUEST', p_actor_id, assignment_id, p_schedule_event_id, p_enrollment_id,
      current_row.id, correction.id, current_row.status, p_requested_status, correction.base_version,
      correction.base_version, p_correlation_id, digest);
  PERFORM set_config('hra.academic_attendance_write', 'off', true);
  RETURN jsonb_build_object('correction', to_jsonb(correction), 'replayed', false);
END;
$request$;

-- 정정 결정(P7·P8). 요청자 본인은 결정할 수 없습니다. EXCUSED 지정·해제는 유효한 학사 운영 관리자만,
-- 그 밖의 정정은 학사 운영 관리자 또는 결정 시각에 같은 기수에 유효하게 배정된 다른 운영 인력이 결정합니다.
-- 승인은 요청 당시 버전이 그대로일 때만 현재 값에 반영하며(HRA06), 반려는 현재 값을 바꾸지 않습니다.
CREATE OR REPLACE FUNCTION public.decide_academic_attendance_correction(
  p_request_id uuid, p_actor_id uuid, p_correlation_id uuid, p_correction_id uuid, p_decision text
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $decide$
DECLARE
  digest text;
  prior public.academic_attendance_events;
  correction public.academic_attendance_corrections;
  cell record;
  manager_id uuid;
  assignment_id uuid;
  current_row public.academic_attendance_records;
  saved public.academic_attendance_records;
BEGIN
  IF p_request_id IS NULL OR p_actor_id IS NULL OR p_correlation_id IS NULL OR p_correction_id IS NULL
    OR p_decision IS NULL OR p_decision NOT IN ('APPROVE', 'REJECT') THEN
    RAISE SQLSTATE 'HRA07' USING MESSAGE = '정정 결정 입력이 올바르지 않습니다.';
  END IF;
  digest := encode(sha256(convert_to(jsonb_build_array('CORRECTION_' || p_decision, p_correction_id)::text, 'UTF8')), 'hex');
  prior := public.academic_attendance_replay(p_request_id, p_actor_id, 'CORRECTION_' || p_decision, digest);
  IF prior.request_id IS NOT NULL THEN
    SELECT * INTO correction FROM public.academic_attendance_corrections WHERE id = prior.correction_id;
    SELECT * INTO saved FROM public.academic_attendance_records WHERE id = prior.record_id;
    RETURN jsonb_build_object('correction', to_jsonb(correction),
      'record', CASE WHEN saved.id IS NULL THEN NULL ELSE to_jsonb(saved) END, 'replayed', true);
  END IF;
  IF current_setting('transaction_isolation') <> 'read committed' THEN
    RAISE SQLSTATE 'HRA07' USING MESSAGE = '정정 결정은 READ COMMITTED 트랜잭션에서만 기록합니다.';
  END IF;
  SELECT * INTO correction FROM public.academic_attendance_corrections WHERE id = p_correction_id;
  IF NOT FOUND THEN RAISE SQLSTATE 'HRA03' USING MESSAGE = '정정 요청을 찾을 수 없습니다.'; END IF;
  -- 셀 잠금 → 정정 행 잠금 순서로 출결 입력·다른 결정과 직렬화합니다.
  IF p_decision = 'APPROVE' THEN
    SELECT * INTO cell FROM public.lock_academic_attendance_cell(correction.schedule_event_id, correction.enrollment_id);
  ELSE
    PERFORM pg_advisory_xact_lock(hashtextextended('hra:academic-attendance-cell:'
      || correction.schedule_event_id::text || ':' || correction.enrollment_id::text, 0));
  END IF;
  SELECT * INTO correction FROM public.academic_attendance_corrections WHERE id = p_correction_id FOR UPDATE;
  IF correction.status <> 'PENDING' THEN
    RAISE SQLSTATE 'HRA04' USING MESSAGE = '이미 결정된 정정 요청입니다.';
  END IF;
  IF correction.requested_by_user_id = p_actor_id THEN
    RAISE SQLSTATE 'HRA01' USING MESSAGE = '본인이 요청한 정정은 결정할 수 없습니다.';
  END IF;
  manager_id := public.find_academic_attendance_manager(p_actor_id);
  IF manager_id IS NULL THEN
    IF correction.requested_status = 'EXCUSED' OR correction.previous_status IS NOT DISTINCT FROM 'EXCUSED' THEN
      RAISE SQLSTATE 'HRA01' USING MESSAGE = '인정결석은 학사 운영 관리자만 승인할 수 있습니다.';
    END IF;
    assignment_id := public.require_academic_attendance_staff(p_actor_id, correction.cohort_id);
  END IF;
  PERFORM set_config('hra.academic_attendance_write', 'on', true);
  IF p_decision = 'APPROVE' THEN
    IF cell.cohort_id <> correction.cohort_id OR cell.class_date <> correction.class_date THEN
      RAISE SQLSTATE 'HRA04' USING MESSAGE = '요청 이후 수업 일자나 기수가 바뀌었습니다.';
    END IF;
    SELECT * INTO current_row FROM public.academic_attendance_records
      WHERE schedule_event_id = correction.schedule_event_id AND enrollment_id = correction.enrollment_id FOR UPDATE;
    IF COALESCE(current_row.version, 0) <> correction.base_version THEN
      RAISE SQLSTATE 'HRA06' USING MESSAGE = '요청 이후 출결이 바뀌어 승인할 수 없습니다. 반려 후 다시 요청해 주세요.';
    END IF;
    -- 반영된 값의 입력자는 요청자(당시 배정)로 남기고, 결정자는 정정 기록에 남깁니다.
    IF current_row.id IS NULL THEN
      INSERT INTO public.academic_attendance_records (schedule_event_id, enrollment_id, cohort_id, class_date, status,
        version, recorded_by_user_id, recorded_by_assignment_id, last_correction_id, recorded_at)
        VALUES (correction.schedule_event_id, correction.enrollment_id, correction.cohort_id, correction.class_date,
          correction.requested_status, 1, correction.requested_by_user_id, correction.requested_by_assignment_id,
          correction.id, now())
        RETURNING * INTO saved;
    ELSE
      UPDATE public.academic_attendance_records SET status = correction.requested_status, version = version + 1,
        recorded_by_user_id = correction.requested_by_user_id,
        recorded_by_assignment_id = correction.requested_by_assignment_id, last_correction_id = correction.id,
        recorded_at = now()
        WHERE id = current_row.id RETURNING * INTO saved;
    END IF;
  ELSE
    SELECT * INTO saved FROM public.academic_attendance_records
      WHERE schedule_event_id = correction.schedule_event_id AND enrollment_id = correction.enrollment_id;
  END IF;
  UPDATE public.academic_attendance_corrections SET status = CASE p_decision WHEN 'APPROVE' THEN 'APPROVED' ELSE 'REJECTED' END,
    decided_by_user_id = p_actor_id, decided_by_assignment_id = assignment_id,
    decided_by_manager_designation_id = manager_id, decided_at = now()
    WHERE id = correction.id RETURNING * INTO correction;
  INSERT INTO public.academic_attendance_events (request_id, action, actor_user_id, actor_assignment_id,
    actor_manager_designation_id, schedule_event_id, enrollment_id, record_id, correction_id, previous_status,
    next_status, previous_version, next_version, correlation_id, payload_digest)
    VALUES (p_request_id, 'CORRECTION_' || p_decision, p_actor_id, assignment_id, manager_id,
      correction.schedule_event_id, correction.enrollment_id, saved.id, correction.id,
      -- 반려는 현재 값을 바꾸지 않으므로 전후 상태·버전이 같습니다.
      CASE p_decision WHEN 'APPROVE' THEN current_row.status ELSE saved.status END, saved.status,
      CASE p_decision WHEN 'APPROVE' THEN COALESCE(current_row.version, 0) ELSE COALESCE(saved.version, 0) END,
      COALESCE(saved.version, 0), p_correlation_id, digest);
  PERFORM set_config('hra.academic_attendance_write', 'off', true);
  RETURN jsonb_build_object('correction', to_jsonb(correction),
    'record', CASE WHEN saved.id IS NULL THEN NULL ELSE to_jsonb(saved) END, 'replayed', false);
END;
$decide$;

-- 운영 인력용 수업일 출결표(P10). 요청 시각에 해당 기수에 유효하게 배정된 운영 인력만 조회합니다.
-- 출결 대상 최소 명단(학적 UUID·표시 이름)과 셀 상태·버전·대기 중 정정만 돌려주며, 행이 없으면 미입력(null)입니다.
CREATE OR REPLACE FUNCTION public.list_academic_attendance_for_event(p_actor_id uuid, p_schedule_event_id uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $list_event$
DECLARE
  event_row record;
  class_day date;
  entry_window tstzrange;
BEGIN
  IF p_actor_id IS NULL OR p_schedule_event_id IS NULL THEN
    RAISE SQLSTATE 'HRA07' USING MESSAGE = '조회 입력이 올바르지 않습니다.';
  END IF;
  SELECT e.cohort_id, e.event_type::text AS event_type, e.event_date INTO event_row
    FROM public.schedule_events e WHERE e.id = p_schedule_event_id;
  IF NOT FOUND OR event_row.event_type <> 'CLASS' OR event_row.cohort_id IS NULL OR event_row.event_date IS NULL THEN
    RAISE SQLSTATE 'HRA03' USING MESSAGE = '출결 대상 수업을 찾을 수 없습니다.';
  END IF;
  PERFORM public.require_academic_attendance_staff(p_actor_id, event_row.cohort_id);
  class_day := public.academic_attendance_class_date(event_row.event_date);
  entry_window := public.academic_attendance_window(class_day);
  RETURN jsonb_build_object(
    'scheduleEventId', p_schedule_event_id, 'cohortId', event_row.cohort_id, 'classDate', class_day,
    'windowOpensAt', lower(entry_window), 'windowClosesAt', upper(entry_window),
    'entries', COALESCE((SELECT jsonb_agg(jsonb_build_object(
        'enrollmentId', ce.id, 'displayName', st.display_name, 'status', r.status,
        'version', COALESCE(r.version, 0), 'recordedAt', r.recorded_at,
        'pendingCorrection', (SELECT jsonb_build_object('id', c.id, 'requestedStatus', c.requested_status,
          'previousStatus', c.previous_status, 'reason', c.reason, 'requestedByUserId', c.requested_by_user_id,
          'requestedAt', c.requested_at)
          FROM public.academic_attendance_corrections c
          WHERE c.schedule_event_id = p_schedule_event_id AND c.enrollment_id = ce.id AND c.status = 'PENDING'))
        ORDER BY st.display_name, ce.id)
      FROM public.cohort_enrollments ce
      JOIN public.academic_students st ON st.id = ce.student_id
      LEFT JOIN public.academic_attendance_records r ON r.schedule_event_id = p_schedule_event_id AND r.enrollment_id = ce.id
      WHERE ce.cohort_id = event_row.cohort_id AND ce.status::text = 'ENROLLED'
        AND ce.enrolled_at < lower(entry_window) + interval '1 day'
        AND (ce.ended_at IS NULL OR ce.ended_at > lower(entry_window))), '[]'::jsonb));
END;
$list_event$;

-- 학생 본인 출결(P9). 로그인 계정에 연결된 본인 학적의 이미 시작된 CLASS 수업일만 돌려줍니다.
-- 다른 학생·운영 인력 식별자, 정정 사유는 포함하지 않으며, 기록이 없으면 미입력(null)입니다.
CREATE OR REPLACE FUNCTION public.list_own_academic_attendance(p_actor_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $list_own$
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
      'enrollmentId', ce.id, 'cohortId', ce.cohort_id, 'scheduleEventId', e.id,
      'classDate', public.academic_attendance_class_date(e.event_date), 'status', r.status)
    ORDER BY e.event_date, e.id, ce.id), '[]'::jsonb)
  FROM public.academic_students st
  JOIN public.users u ON u.id = st.user_id AND u.role::text IN ('ADMIN', 'FACULTY', 'MEMBER')
  JOIN public.cohort_enrollments ce ON ce.student_id = st.id AND ce.status::text = 'ENROLLED'
  JOIN public.schedule_events e ON e.cohort_id = ce.cohort_id AND e.event_type::text = 'CLASS' AND e.event_date IS NOT NULL
  LEFT JOIN public.academic_attendance_records r ON r.schedule_event_id = e.id AND r.enrollment_id = ce.id
  WHERE p_actor_id IS NOT NULL AND st.user_id = p_actor_id
    AND lower(public.academic_attendance_window(public.academic_attendance_class_date(e.event_date))) <= now()
    AND ce.enrolled_at < lower(public.academic_attendance_window(public.academic_attendance_class_date(e.event_date))) + interval '1 day'
    AND (ce.ended_at IS NULL
      OR ce.ended_at > lower(public.academic_attendance_window(public.academic_attendance_class_date(e.event_date))));
$list_own$;

-- 앱 DB 소유 역할만 실행합니다. 임의의 PUBLIC 실행 권한을 제거합니다.
REVOKE ALL ON FUNCTION public.guard_academic_attendance_write() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_academic_attendance_events() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.academic_attendance_class_date(timestamp) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.academic_attendance_window(date) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.academic_attendance_replay(uuid, uuid, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.lock_academic_attendance_cell(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.require_academic_attendance_staff(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.find_academic_attendance_manager(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_academic_attendance(uuid, uuid, uuid, uuid, uuid, text, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_academic_attendance_correction(uuid, uuid, uuid, uuid, uuid, text, integer, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.decide_academic_attendance_correction(uuid, uuid, uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_academic_attendance_for_event(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_own_academic_attendance(uuid) FROM PUBLIC;
COMMIT;
