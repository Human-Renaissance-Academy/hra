-- #516 PR-C: 텍스트·발표자료 분리 제출(ARTIFACTS_V2)의 추가형 구조. G1 범위 SQL 9개를 모두 적용한 뒤 실행한다.
-- 기존 행을 UPDATE·재분류하지 않으며 기능은 비활성이다. 운영 적용은 #280 gate와 #142 보존 정책 승인 뒤 별도로 한다.
BEGIN;
SET LOCAL search_path = public, pg_catalog;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('hra:academic-submission-artifacts:v1', 0));

-- 1) 적용 전 구조 판정. 새 타입·컬럼이 하나도 없으면 G1 v1 구조로 보고, 교체할 v1 제약이 원문과 같을 때만 변경한다.
-- 새 객체가 일부라도 있으면 DDL을 건너뛰고 아래 2)의 v2 전체 구조 대조에 맡긴다. 부분·변형 구조는 그 대조에서 거부된다.
CREATE SCHEMA hra_artifacts_v1_expected;
CREATE TABLE hra_artifacts_v1_expected.intents (
  state public.assignment_upload_state, created_at timestamptz, expires_at timestamptz, verified_at timestamptz,
  original_name varchar(255), mime_type varchar(100), size_bytes integer, checksum varchar(64),
  CONSTRAINT assignment_upload_intents_verification_shape CHECK (
    (state IN ('INTENDED','EXPIRED') AND verified_at IS NULL AND original_name IS NULL AND mime_type IS NULL AND size_bytes IS NULL AND checksum IS NULL) OR
    (state IN ('VERIFIED','CONSUMED') AND verified_at IS NOT NULL AND isfinite(verified_at) AND verified_at>=created_at AND verified_at<expires_at
      AND original_name IS NOT NULL AND length(btrim(original_name))>0 AND original_name !~ '[/\\[:cntrl:]]'
      AND mime_type IS NOT NULL AND mime_type='application/pdf' AND size_bytes IS NOT NULL AND size_bytes BETWEEN 1 AND 52428800
      AND checksum IS NOT NULL AND checksum ~ '^[0-9a-f]{64}$'))
);
CREATE TABLE hra_artifacts_v1_expected.files (
  storage_key varchar(1024), original_name varchar(255), mime_type varchar(100), size_bytes integer, checksum varchar(64),
  CONSTRAINT assignment_submission_files_metadata_shape CHECK (
    length(btrim(storage_key))>0 AND storage_key !~ '(^/|://|(^|/)\.\.(/|$)|[[:cntrl:]])'
    AND length(btrim(original_name))>0 AND original_name !~ '[/\\[:cntrl:]]'
    AND mime_type='application/pdf' AND size_bytes BETWEEN 1 AND 52428800 AND checksum ~ '^[0-9a-f]{64}$')
);
CREATE TABLE hra_artifacts_v1_expected.authorizations (
  original_name varchar(255),
  CONSTRAINT academic_upload_authorizations_name_check CHECK (length(btrim(original_name))>0 AND original_name !~ '[/\\[:cntrl:]]' AND lower(original_name) LIKE '%.pdf')
);
DO $apply$
DECLARE has_v2_objects boolean; expected record;
BEGIN
  has_v2_objects := to_regtype('public.assignment_submission_format') IS NOT NULL
    OR to_regtype('public.assignment_artifact_requirement') IS NOT NULL
    OR to_regtype('public.assignment_artifact_type') IS NOT NULL
    OR to_regtype('public.assignment_file_format') IS NOT NULL
    OR EXISTS (SELECT 1 FROM pg_attribute WHERE attnum>0 AND NOT attisdropped
      AND attrelid IN ('public.assignments'::regclass,'public.assignment_upload_intents'::regclass,'public.assignment_submissions'::regclass,
        'public.assignment_submission_files'::regclass,'public.academic_upload_authorizations'::regclass)
      AND attname IN ('submission_format','text_requirement','slides_requirement','artifact_type','file_format'));
  IF has_v2_objects THEN RETURN; END IF;

  -- 삭제·교체할 v1 제약과 인덱스는 원문 정의와 정확히 같을 때만 다룬다. 다르면 자동 보정하지 않고 전체를 롤백한다.
  FOR expected IN SELECT * FROM (VALUES
    ('public.assignment_upload_intents','assignment_upload_intents_verification_shape','hra_artifacts_v1_expected.intents'),
    ('public.assignment_submission_files','assignment_submission_files_metadata_shape','hra_artifacts_v1_expected.files'),
    ('public.academic_upload_authorizations','academic_upload_authorizations_name_check','hra_artifacts_v1_expected.authorizations')
  ) v(actual_table,constraint_name,expected_table) LOOP
    IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid=expected.actual_table::regclass
        AND conname=expected.constraint_name AND contype='c' AND convalidated)
      IS DISTINCT FROM (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid=expected.expected_table::regclass
        AND conname=expected.constraint_name) THEN
      RAISE EXCEPTION '제출 산출물 이전 구조 불일치: %',expected.constraint_name;
    END IF;
  END LOOP;
  IF (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid='public.assignment_submission_files'::regclass
      AND conname='assignment_submission_files_submission_unique' AND contype='u' AND convalidated)
      IS DISTINCT FROM 'UNIQUE (submission_id)'
    OR (SELECT pg_get_indexdef(i.indexrelid) FROM pg_index i WHERE i.indrelid='public.academic_upload_authorizations'::regclass
      AND i.indexrelid=to_regclass('public.academic_upload_authorizations_active_target_idx') AND i.indisvalid AND i.indisready)
      IS DISTINCT FROM 'CREATE UNIQUE INDEX academic_upload_authorizations_active_target_idx ON public.academic_upload_authorizations USING btree (target_id) WHERE (retired_at IS NULL)'
    OR NOT (SELECT attnotnull FROM pg_attribute WHERE attrelid='public.assignment_submissions'::regclass AND attname='upload_intent_id' AND NOT attisdropped)
    OR to_regclass('public.academic_upload_authorizations_active_artifact_idx') IS NOT NULL THEN
    RAISE EXCEPTION '제출 산출물 이전 구조 불일치: 단일 파일 제약·활성 인덱스·업로드 의도 참조';
  END IF;

  CREATE TYPE public.assignment_submission_format AS ENUM ('LEGACY_SINGLE_PDF','ARTIFACTS_V2');
  CREATE TYPE public.assignment_artifact_requirement AS ENUM ('REQUIRED','OPTIONAL','DISABLED');
  CREATE TYPE public.assignment_artifact_type AS ENUM ('LEGACY_PDF','TEXT','SLIDES');
  CREATE TYPE public.assignment_file_format AS ENUM ('PDF','HWP','HWPX','PPT','PPTX');

  -- 상수 기본값의 ADD COLUMN은 기존 행을 다시 쓰지 않고 카탈로그 기본값으로 LEGACY 값을 보인다(UPDATE 없음).
  -- 기본값은 기존 v1 작성 경로(과제 생성 함수·v1 업로드 함수)가 계속 LEGACY로 기록하도록 유지한다.
  ALTER TABLE public.assignments
    ADD COLUMN submission_format public.assignment_submission_format NOT NULL DEFAULT 'LEGACY_SINGLE_PDF',
    ADD COLUMN text_requirement public.assignment_artifact_requirement,
    ADD COLUMN slides_requirement public.assignment_artifact_requirement,
    ADD CONSTRAINT assignments_submission_artifacts_shape CHECK (
      (submission_format='LEGACY_SINGLE_PDF' AND text_requirement IS NULL AND slides_requirement IS NULL) OR
      (submission_format='ARTIFACTS_V2' AND text_requirement IS NOT NULL AND slides_requirement IS NOT NULL
        AND (text_requirement<>'DISABLED' OR slides_requirement<>'DISABLED')));

  ALTER TABLE public.assignment_upload_intents
    ADD COLUMN artifact_type public.assignment_artifact_type NOT NULL DEFAULT 'LEGACY_PDF',
    ADD COLUMN file_format public.assignment_file_format NOT NULL DEFAULT 'PDF',
    DROP CONSTRAINT assignment_upload_intents_verification_shape,
    ADD CONSTRAINT assignment_upload_intents_verification_shape CHECK (
      (state IN ('INTENDED','EXPIRED') AND verified_at IS NULL AND original_name IS NULL AND mime_type IS NULL AND size_bytes IS NULL AND checksum IS NULL) OR
      (state IN ('VERIFIED','CONSUMED') AND verified_at IS NOT NULL AND isfinite(verified_at) AND verified_at>=created_at AND verified_at<expires_at
        AND original_name IS NOT NULL AND length(btrim(original_name))>0 AND original_name !~ '[/\\[:cntrl:]]'
        AND mime_type IS NOT NULL AND size_bytes IS NOT NULL AND size_bytes BETWEEN 1 AND 52428800
        AND checksum IS NOT NULL AND checksum ~ '^[0-9a-f]{64}$')),
    ADD CONSTRAINT assignment_upload_intents_artifact_format CHECK (
      (artifact_type='LEGACY_PDF' AND file_format='PDF') OR (artifact_type='TEXT' AND file_format IN ('PDF','HWP','HWPX'))
      OR (artifact_type='SLIDES' AND file_format IN ('PDF','PPT','PPTX'))),
    ADD CONSTRAINT assignment_upload_intents_format_mime CHECK (mime_type IS NULL OR mime_type=(CASE file_format
      WHEN 'PDF' THEN 'application/pdf' WHEN 'HWP' THEN 'application/x-hwp' WHEN 'HWPX' THEN 'application/hwp+zip'
      WHEN 'PPT' THEN 'application/vnd.ms-powerpoint'
      WHEN 'PPTX' THEN 'application/vnd.openxmlformats-officedocument.presentationml.presentation' END)),
    ADD CONSTRAINT assignment_upload_intents_v2_key_shape CHECK (
      artifact_type='LEGACY_PDF' OR storage_key=('academic-uploads/v2/'||id::text||'/original')),
    ADD CONSTRAINT assignment_upload_intents_artifact_identity_unique UNIQUE (id,artifact_type,file_format);

  -- V2 제출은 의도 여러 개를 파일 저장 키로 연결하므로 단일 의도 참조를 비운다. LEGACY는 기존처럼 필수다.
  ALTER TABLE public.assignment_submissions
    ADD COLUMN submission_format public.assignment_submission_format NOT NULL DEFAULT 'LEGACY_SINGLE_PDF',
    ALTER COLUMN upload_intent_id DROP NOT NULL,
    ADD CONSTRAINT assignment_submissions_format_intent_shape CHECK (
      (submission_format='LEGACY_SINGLE_PDF' AND upload_intent_id IS NOT NULL) OR
      (submission_format='ARTIFACTS_V2' AND upload_intent_id IS NULL));

  -- 제출당 단일 파일 UNIQUE를 (제출, 산출물 유형) UNIQUE로 넓힌다. LEGACY 제출은 LEGACY_PDF 한 유형만 가지므로 의미가 같다.
  ALTER TABLE public.assignment_submission_files
    ADD COLUMN artifact_type public.assignment_artifact_type NOT NULL DEFAULT 'LEGACY_PDF',
    ADD COLUMN file_format public.assignment_file_format NOT NULL DEFAULT 'PDF',
    DROP CONSTRAINT assignment_submission_files_submission_unique,
    ADD CONSTRAINT assignment_submission_files_submission_artifact_unique UNIQUE (submission_id,artifact_type),
    DROP CONSTRAINT assignment_submission_files_metadata_shape,
    ADD CONSTRAINT assignment_submission_files_metadata_shape CHECK (
      length(btrim(storage_key))>0 AND storage_key !~ '(^/|://|(^|/)\.\.(/|$)|[[:cntrl:]])'
      AND length(btrim(original_name))>0 AND original_name !~ '[/\\[:cntrl:]]'
      AND size_bytes BETWEEN 1 AND 52428800 AND checksum ~ '^[0-9a-f]{64}$'),
    ADD CONSTRAINT assignment_submission_files_artifact_format CHECK (
      (artifact_type='LEGACY_PDF' AND file_format='PDF') OR (artifact_type='TEXT' AND file_format IN ('PDF','HWP','HWPX'))
      OR (artifact_type='SLIDES' AND file_format IN ('PDF','PPT','PPTX'))),
    ADD CONSTRAINT assignment_submission_files_format_mime CHECK (mime_type=(CASE file_format
      WHEN 'PDF' THEN 'application/pdf' WHEN 'HWP' THEN 'application/x-hwp' WHEN 'HWPX' THEN 'application/hwp+zip'
      WHEN 'PPT' THEN 'application/vnd.ms-powerpoint'
      WHEN 'PPTX' THEN 'application/vnd.openxmlformats-officedocument.presentationml.presentation' END));

  -- 발급 원장의 유형·형식은 복합 FK로 업로드 의도와 같아야 한다. 활성 의도 UNIQUE는 (대상, 산출물 유형)으로 넓힌다.
  ALTER TABLE public.academic_upload_authorizations
    ADD COLUMN artifact_type public.assignment_artifact_type NOT NULL DEFAULT 'LEGACY_PDF',
    ADD COLUMN file_format public.assignment_file_format NOT NULL DEFAULT 'PDF',
    DROP CONSTRAINT academic_upload_authorizations_name_check,
    ADD CONSTRAINT academic_upload_authorizations_name_check CHECK (
      length(btrim(original_name))>0 AND original_name !~ '[/\\[:cntrl:]]' AND lower(original_name) LIKE (CASE file_format
        WHEN 'PDF' THEN '%.pdf' WHEN 'HWP' THEN '%.hwp' WHEN 'HWPX' THEN '%.hwpx' WHEN 'PPT' THEN '%.ppt' WHEN 'PPTX' THEN '%.pptx' END)),
    ADD CONSTRAINT academic_upload_authorizations_artifact_format CHECK (
      (artifact_type='LEGACY_PDF' AND file_format='PDF') OR (artifact_type='TEXT' AND file_format IN ('PDF','HWP','HWPX'))
      OR (artifact_type='SLIDES' AND file_format IN ('PDF','PPT','PPTX'))),
    ADD CONSTRAINT academic_upload_authorizations_intent_artifact_fk FOREIGN KEY (intent_id,artifact_type,file_format)
      REFERENCES public.assignment_upload_intents(id,artifact_type,file_format) ON DELETE RESTRICT;
  DROP INDEX public.academic_upload_authorizations_active_target_idx;
  CREATE UNIQUE INDEX academic_upload_authorizations_active_artifact_idx
    ON public.academic_upload_authorizations(target_id,artifact_type) WHERE retired_at IS NULL;
END;
$apply$;
DROP SCHEMA hra_artifacts_v1_expected CASCADE;

-- 2) 적용 후(또는 이미 적용된) 구조 전체 대조. enum은 비교 테이블이 참조하므로 먼저 이름·값·순서를 확인한다.
DO $enum$
DECLARE expected record;
BEGIN
  FOR expected IN SELECT * FROM (VALUES
    ('public.assignment_submission_format',ARRAY['LEGACY_SINGLE_PDF','ARTIFACTS_V2']),
    ('public.assignment_artifact_requirement',ARRAY['REQUIRED','OPTIONAL','DISABLED']),
    ('public.assignment_artifact_type',ARRAY['LEGACY_PDF','TEXT','SLIDES']),
    ('public.assignment_file_format',ARRAY['PDF','HWP','HWPX','PPT','PPTX'])
  ) v(type_name,labels) LOOP
    IF to_regtype(expected.type_name) IS NULL OR (SELECT array_agg(enumlabel::text ORDER BY enumsortorder) FROM pg_enum
      WHERE enumtypid=to_regtype(expected.type_name)) IS DISTINCT FROM expected.labels THEN
      RAISE EXCEPTION '제출 산출물 enum 불일치: %',expected.type_name;
    END IF;
  END LOOP;
END;
$enum$;
-- 같은 정의의 비교 스키마를 만들어 컬럼·기본값·제약·인덱스를 비교한다.
-- 동명 비교 스키마가 이미 있으면 실패하며 비교 뒤 명시적으로 삭제한다. 운영 자료를 복사하지 않는다.
CREATE SCHEMA hra_artifacts_expected;
CREATE TABLE hra_artifacts_expected.assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cohort_id uuid NOT NULL CONSTRAINT assignments_cohort_id_cohorts_id_fk REFERENCES public.cohorts(id) ON DELETE RESTRICT,
  schedule_event_id uuid CONSTRAINT assignments_schedule_event_id_schedule_events_id_fk REFERENCES public.schedule_events(id) ON DELETE RESTRICT,
  schedule_session_id uuid CONSTRAINT assignments_schedule_session_id_schedule_sessions_id_fk REFERENCES public.schedule_sessions(id) ON DELETE RESTRICT,
  title varchar(200) NOT NULL,
  instructions text NOT NULL DEFAULT '',
  due_at timestamptz,
  status public.assignment_status NOT NULL DEFAULT 'DRAFT',
  created_by_user_id uuid NOT NULL CONSTRAINT assignments_created_by_user_id_users_id_fk REFERENCES public.users(id) ON DELETE RESTRICT,
  published_by_user_id uuid CONSTRAINT assignments_published_by_user_id_users_id_fk REFERENCES public.users(id) ON DELETE RESTRICT,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  submission_format public.assignment_submission_format NOT NULL DEFAULT 'LEGACY_SINGLE_PDF',
  text_requirement public.assignment_artifact_requirement,
  slides_requirement public.assignment_artifact_requirement,
  CONSTRAINT assignments_title_not_blank CHECK (length(btrim(title)) > 0),
  CONSTRAINT assignments_instructions_length CHECK (length(instructions) <= 50000),
  CONSTRAINT assignments_session_requires_event CHECK (schedule_session_id IS NULL OR schedule_event_id IS NOT NULL),
  CONSTRAINT assignments_publication_shape CHECK (
    (status = 'DRAFT' AND published_at IS NULL AND published_by_user_id IS NULL) OR
    (status <> 'DRAFT' AND published_at IS NOT NULL AND published_by_user_id IS NOT NULL AND due_at IS NOT NULL AND due_at > published_at)),
  CONSTRAINT assignments_submission_artifacts_shape CHECK (
    (submission_format='LEGACY_SINGLE_PDF' AND text_requirement IS NULL AND slides_requirement IS NULL) OR
    (submission_format='ARTIFACTS_V2' AND text_requirement IS NOT NULL AND slides_requirement IS NOT NULL
      AND (text_requirement<>'DISABLED' OR slides_requirement<>'DISABLED')))
);
CREATE INDEX expected_assignments_cohort_status_due_idx ON hra_artifacts_expected.assignments (cohort_id,status,due_at);
CREATE TABLE hra_artifacts_expected.assignment_upload_intents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_target_id uuid NOT NULL CONSTRAINT assignment_upload_intents_target_fk REFERENCES public.assignment_targets(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL CONSTRAINT assignment_upload_intents_user_id_users_id_fk REFERENCES public.users(id) ON DELETE RESTRICT,
  storage_key varchar(1024) NOT NULL,
  state public.assignment_upload_state NOT NULL DEFAULT 'INTENDED',
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  verified_at timestamptz,
  original_name varchar(255),
  mime_type varchar(100),
  size_bytes integer,
  checksum varchar(64),
  artifact_type public.assignment_artifact_type NOT NULL DEFAULT 'LEGACY_PDF',
  file_format public.assignment_file_format NOT NULL DEFAULT 'PDF',
  CONSTRAINT assignment_upload_intents_storage_key_unique UNIQUE (storage_key),
  CONSTRAINT assignment_upload_intents_identity_unique UNIQUE (id,assignment_target_id,user_id),
  CONSTRAINT assignment_upload_intents_key_shape CHECK (length(btrim(storage_key))>0 AND storage_key !~ '(^/|://|(^|/)\.\.(/|$)|[[:cntrl:]])'),
  CONSTRAINT assignment_upload_intents_expiry_shape CHECK (isfinite(created_at) AND isfinite(expires_at) AND expires_at>created_at),
  CONSTRAINT assignment_upload_intents_verification_shape CHECK (
    (state IN ('INTENDED','EXPIRED') AND verified_at IS NULL AND original_name IS NULL AND mime_type IS NULL AND size_bytes IS NULL AND checksum IS NULL) OR
    (state IN ('VERIFIED','CONSUMED') AND verified_at IS NOT NULL AND isfinite(verified_at) AND verified_at>=created_at AND verified_at<expires_at
      AND original_name IS NOT NULL AND length(btrim(original_name))>0 AND original_name !~ '[/\\[:cntrl:]]'
      AND mime_type IS NOT NULL AND size_bytes IS NOT NULL AND size_bytes BETWEEN 1 AND 52428800
      AND checksum IS NOT NULL AND checksum ~ '^[0-9a-f]{64}$')),
  CONSTRAINT assignment_upload_intents_artifact_format CHECK (
    (artifact_type='LEGACY_PDF' AND file_format='PDF') OR (artifact_type='TEXT' AND file_format IN ('PDF','HWP','HWPX'))
    OR (artifact_type='SLIDES' AND file_format IN ('PDF','PPT','PPTX'))),
  CONSTRAINT assignment_upload_intents_format_mime CHECK (mime_type IS NULL OR mime_type=(CASE file_format
    WHEN 'PDF' THEN 'application/pdf' WHEN 'HWP' THEN 'application/x-hwp' WHEN 'HWPX' THEN 'application/hwp+zip'
    WHEN 'PPT' THEN 'application/vnd.ms-powerpoint'
    WHEN 'PPTX' THEN 'application/vnd.openxmlformats-officedocument.presentationml.presentation' END)),
  CONSTRAINT assignment_upload_intents_v2_key_shape CHECK (
    artifact_type='LEGACY_PDF' OR storage_key=('academic-uploads/v2/'||id::text||'/original')),
  CONSTRAINT assignment_upload_intents_artifact_identity_unique UNIQUE (id,artifact_type,file_format)
);
CREATE INDEX expected_intents_target_user_idx ON hra_artifacts_expected.assignment_upload_intents(assignment_target_id,user_id);
CREATE INDEX expected_intents_state_expiry_idx ON hra_artifacts_expected.assignment_upload_intents(state,expires_at);
CREATE TABLE hra_artifacts_expected.assignment_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_target_id uuid NOT NULL CONSTRAINT assignment_submissions_target_fk REFERENCES public.assignment_targets(id) ON DELETE RESTRICT,
  submitted_by_user_id uuid NOT NULL CONSTRAINT assignment_submissions_submitted_by_user_id_users_id_fk REFERENCES public.users(id) ON DELETE RESTRICT,
  upload_intent_id uuid,
  submission_key uuid NOT NULL,
  submitted_at timestamptz NOT NULL DEFAULT now(),
  submission_format public.assignment_submission_format NOT NULL DEFAULT 'LEGACY_SINGLE_PDF',
  CONSTRAINT assignment_submissions_target_unique UNIQUE (assignment_target_id),
  CONSTRAINT assignment_submissions_key_unique UNIQUE (submission_key),
  CONSTRAINT assignment_submissions_intent_unique UNIQUE (upload_intent_id),
  CONSTRAINT assignment_submissions_intent_identity_fk FOREIGN KEY (upload_intent_id,assignment_target_id,submitted_by_user_id)
    REFERENCES public.assignment_upload_intents(id,assignment_target_id,user_id) ON DELETE RESTRICT,
  CONSTRAINT assignment_submissions_time_finite CHECK (isfinite(submitted_at)),
  CONSTRAINT assignment_submissions_format_intent_shape CHECK (
    (submission_format='LEGACY_SINGLE_PDF' AND upload_intent_id IS NOT NULL) OR
    (submission_format='ARTIFACTS_V2' AND upload_intent_id IS NULL))
);
CREATE INDEX expected_submissions_user_time_idx ON hra_artifacts_expected.assignment_submissions(submitted_by_user_id,submitted_at);
CREATE TABLE hra_artifacts_expected.assignment_submission_files (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL CONSTRAINT assignment_submission_files_submission_fk REFERENCES public.assignment_submissions(id) ON DELETE RESTRICT,
  storage_key varchar(1024) NOT NULL,
  original_name varchar(255) NOT NULL,
  mime_type varchar(100) NOT NULL,
  size_bytes integer NOT NULL,
  checksum varchar(64) NOT NULL,
  artifact_type public.assignment_artifact_type NOT NULL DEFAULT 'LEGACY_PDF',
  file_format public.assignment_file_format NOT NULL DEFAULT 'PDF',
  CONSTRAINT assignment_submission_files_storage_key_unique UNIQUE (storage_key),
  CONSTRAINT assignment_submission_files_submission_artifact_unique UNIQUE (submission_id,artifact_type),
  CONSTRAINT assignment_submission_files_metadata_shape CHECK (
    length(btrim(storage_key))>0 AND storage_key !~ '(^/|://|(^|/)\.\.(/|$)|[[:cntrl:]])'
    AND length(btrim(original_name))>0 AND original_name !~ '[/\\[:cntrl:]]'
    AND size_bytes BETWEEN 1 AND 52428800 AND checksum ~ '^[0-9a-f]{64}$'),
  CONSTRAINT assignment_submission_files_artifact_format CHECK (
    (artifact_type='LEGACY_PDF' AND file_format='PDF') OR (artifact_type='TEXT' AND file_format IN ('PDF','HWP','HWPX'))
    OR (artifact_type='SLIDES' AND file_format IN ('PDF','PPT','PPTX'))),
  CONSTRAINT assignment_submission_files_format_mime CHECK (mime_type=(CASE file_format
    WHEN 'PDF' THEN 'application/pdf' WHEN 'HWP' THEN 'application/x-hwp' WHEN 'HWPX' THEN 'application/hwp+zip'
    WHEN 'PPT' THEN 'application/vnd.ms-powerpoint'
    WHEN 'PPTX' THEN 'application/vnd.openxmlformats-officedocument.presentationml.presentation' END))
);
CREATE TABLE hra_artifacts_expected.academic_upload_authorizations (
  intent_id uuid PRIMARY KEY CONSTRAINT academic_upload_authorizations_intent_fk REFERENCES public.assignment_upload_intents(id) ON DELETE RESTRICT,
  request_id uuid NOT NULL CONSTRAINT academic_upload_authorizations_request_id_unique UNIQUE,
  target_id uuid NOT NULL CONSTRAINT academic_upload_authorizations_target_fk REFERENCES public.assignment_targets(id) ON DELETE RESTRICT,
  user_id uuid NOT NULL CONSTRAINT academic_upload_authorizations_user_fk REFERENCES public.users(id) ON DELETE RESTRICT,
  original_name varchar(255) NOT NULL,
  expected_size integer NOT NULL,
  received_at timestamptz,
  verified_etag varchar(255),
  retired_at timestamptz,
  cleanup_claimed_at timestamptz,
  deleted_at timestamptz,
  artifact_type public.assignment_artifact_type NOT NULL DEFAULT 'LEGACY_PDF',
  file_format public.assignment_file_format NOT NULL DEFAULT 'PDF',
  CONSTRAINT academic_upload_authorizations_size_check CHECK (expected_size BETWEEN 1 AND 52428800),
  CONSTRAINT academic_upload_authorizations_name_check CHECK (
    length(btrim(original_name))>0 AND original_name !~ '[/\\[:cntrl:]]' AND lower(original_name) LIKE (CASE file_format
      WHEN 'PDF' THEN '%.pdf' WHEN 'HWP' THEN '%.hwp' WHEN 'HWPX' THEN '%.hwpx' WHEN 'PPT' THEN '%.ppt' WHEN 'PPTX' THEN '%.pptx' END)),
  CONSTRAINT academic_upload_authorizations_artifact_format CHECK (
    (artifact_type='LEGACY_PDF' AND file_format='PDF') OR (artifact_type='TEXT' AND file_format IN ('PDF','HWP','HWPX'))
    OR (artifact_type='SLIDES' AND file_format IN ('PDF','PPT','PPTX'))),
  CONSTRAINT academic_upload_authorizations_intent_artifact_fk FOREIGN KEY (intent_id,artifact_type,file_format)
    REFERENCES public.assignment_upload_intents(id,artifact_type,file_format) ON DELETE RESTRICT
);
CREATE UNIQUE INDEX expected_authorizations_active_artifact_idx
  ON hra_artifacts_expected.academic_upload_authorizations(target_id,artifact_type) WHERE retired_at IS NULL;
CREATE INDEX expected_authorizations_cleanup_idx ON hra_artifacts_expected.academic_upload_authorizations(cleanup_claimed_at);

DO $shape$
DECLARE table_name text; actual_oid oid; expected_oid oid; actual_shape jsonb; expected_shape jsonb; expected record;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['assignments','assignment_upload_intents','assignment_submissions',
    'assignment_submission_files','academic_upload_authorizations'] LOOP
    actual_oid=to_regclass('public.'||table_name);
    expected_oid=to_regclass('hra_artifacts_expected.'||table_name);
    IF EXISTS (SELECT 1 FROM pg_class WHERE oid=actual_oid AND (relkind<>'r' OR relrowsecurity OR relforcerowsecurity)) THEN
      RAISE EXCEPTION '제출 산출물 테이블 종류 또는 RLS 불일치: %',table_name;
    END IF;
    -- 컬럼 이름·타입·NULL 허용·기본값은 이름 순서로, 제약은 정의 순서로, 인덱스는 키·연산자·조건으로 비교한다.
    SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,
      pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attname) INTO actual_shape
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=actual_oid AND a.attnum>0 AND NOT a.attisdropped;
    SELECT jsonb_agg(jsonb_build_array(a.attname,format_type(a.atttypid,a.atttypmod),a.attnotnull,
      pg_get_expr(d.adbin,d.adrelid)) ORDER BY a.attname) INTO expected_shape
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
      WHERE a.attrelid=expected_oid AND a.attnum>0 AND NOT a.attisdropped;
    IF actual_shape IS DISTINCT FROM expected_shape THEN RAISE EXCEPTION '제출 산출물 컬럼·기본값 불일치: %',table_name; END IF;
    SELECT jsonb_agg(jsonb_build_array(contype,convalidated,condeferrable,condeferred,pg_get_constraintdef(oid)) ORDER BY pg_get_constraintdef(oid)) INTO actual_shape
      FROM pg_constraint WHERE conrelid=actual_oid AND contype NOT IN ('n','t');
    SELECT jsonb_agg(jsonb_build_array(contype,convalidated,condeferrable,condeferred,pg_get_constraintdef(oid)) ORDER BY pg_get_constraintdef(oid)) INTO expected_shape
      FROM pg_constraint WHERE conrelid=expected_oid AND contype NOT IN ('n','t');
    IF actual_shape IS DISTINCT FROM expected_shape THEN RAISE EXCEPTION '제출 산출물 제약 불일치: %',table_name; END IF;
    SELECT jsonb_agg(jsonb_build_array(i.indisunique,i.indisprimary,i.indisvalid,i.indisready,i.indkey::text,
      i.indclass::text,i.indcollation::text,i.indoption::text,pg_get_expr(i.indexprs,i.indrelid),pg_get_expr(i.indpred,i.indrelid)) ORDER BY i.indkey::text,i.indisunique,i.indisprimary) INTO actual_shape
      FROM pg_index i WHERE i.indrelid=actual_oid;
    SELECT jsonb_agg(jsonb_build_array(i.indisunique,i.indisprimary,i.indisvalid,i.indisready,i.indkey::text,
      i.indclass::text,i.indcollation::text,i.indoption::text,pg_get_expr(i.indexprs,i.indrelid),pg_get_expr(i.indpred,i.indrelid)) ORDER BY i.indkey::text,i.indisunique,i.indisprimary) INTO expected_shape
      FROM pg_index i WHERE i.indrelid=expected_oid;
    IF actual_shape IS DISTINCT FROM expected_shape THEN RAISE EXCEPTION '제출 산출물 인덱스 불일치: %',table_name; END IF;
  END LOOP;
  -- 정의 비교와 별도로 새 제약·인덱스의 이름을 고정해 이후 오류 분류와 문서가 같은 이름을 쓰게 한다.
  FOR expected IN SELECT * FROM (VALUES
    ('public.assignments','assignments_submission_artifacts_shape'),
    ('public.assignment_upload_intents','assignment_upload_intents_artifact_format'),
    ('public.assignment_upload_intents','assignment_upload_intents_format_mime'),
    ('public.assignment_upload_intents','assignment_upload_intents_v2_key_shape'),
    ('public.assignment_upload_intents','assignment_upload_intents_artifact_identity_unique'),
    ('public.assignment_submissions','assignment_submissions_format_intent_shape'),
    ('public.assignment_submission_files','assignment_submission_files_submission_artifact_unique'),
    ('public.assignment_submission_files','assignment_submission_files_artifact_format'),
    ('public.assignment_submission_files','assignment_submission_files_format_mime'),
    ('public.academic_upload_authorizations','academic_upload_authorizations_artifact_format'),
    ('public.academic_upload_authorizations','academic_upload_authorizations_intent_artifact_fk')
  ) v(table_name,constraint_name) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=expected.table_name::regclass AND conname=expected.constraint_name) THEN
      RAISE EXCEPTION '제출 산출물 제약 이름 불일치: %',expected.constraint_name;
    END IF;
  END LOOP;
  IF to_regclass('public.academic_upload_authorizations_active_artifact_idx') IS NULL
    OR to_regclass('public.academic_upload_authorizations_active_target_idx') IS NOT NULL THEN
    RAISE EXCEPTION '제출 산출물 활성 업로드 인덱스 이름 불일치';
  END IF;
END;
$shape$;
DROP SCHEMA hra_artifacts_expected CASCADE;

-- 3) 트리거 함수의 V2 분기. 잠금 순서는 G1과 같이 대상 → 계정 → 학생/학적 → 과제 → 업로드 의도 → 발급 원장이다.
-- 의도 생성 시 과제 형식과 산출물 유형을 대조한다. LEGACY 과제에는 LEGACY_PDF만, V2 과제에는 미사용이 아닌 TEXT/SLIDES만 허용한다.
CREATE OR REPLACE FUNCTION public.guard_academic_upload_intent() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $intent$
DECLARE definition public.assignments;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.state='CONSUMED' THEN RAISE EXCEPTION '최종 제출에 사용한 업로드 의도는 삭제할 수 없습니다.'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'INTENDED' THEN RAISE EXCEPTION '업로드 의도는 미검증 상태로 생성해야 합니다.'; END IF;
    NEW.created_at=clock_timestamp();
    PERFORM 1 FROM public.assignment_targets WHERE id=NEW.assignment_target_id FOR UPDATE;
    PERFORM public.assert_academic_submission_owner(NEW.assignment_target_id,NEW.user_id,true);
    SELECT a.* INTO definition FROM public.assignments a JOIN public.assignment_targets t ON t.assignment_id=a.id
      WHERE t.id=NEW.assignment_target_id;
    IF NEW.artifact_type='LEGACY_PDF' THEN
      IF definition.submission_format IS DISTINCT FROM 'LEGACY_SINGLE_PDF' THEN
        RAISE EXCEPTION '기존 PDF 단일 제출 과제에만 PDF 업로드 의도를 만들 수 있습니다.';
      END IF;
    ELSIF definition.submission_format IS DISTINCT FROM 'ARTIFACTS_V2'
      OR (NEW.artifact_type='TEXT' AND definition.text_requirement='DISABLED')
      OR (NEW.artifact_type='SLIDES' AND definition.slides_requirement='DISABLED') THEN
      RAISE EXCEPTION '과제에서 받지 않는 제출 항목입니다.';
    END IF;
  ELSE
    IF ROW(NEW.id,NEW.assignment_target_id,NEW.user_id,NEW.storage_key,NEW.expires_at,NEW.created_at,NEW.artifact_type,NEW.file_format)
      IS DISTINCT FROM ROW(OLD.id,OLD.assignment_target_id,OLD.user_id,OLD.storage_key,OLD.expires_at,OLD.created_at,OLD.artifact_type,OLD.file_format) THEN
      RAISE EXCEPTION '업로드 의도의 식별자·소유자·저장경로·유효기간·제출 항목은 불변입니다.';
    END IF;
    IF OLD.state='INTENDED' AND NEW.state='VERIFIED' THEN
      PERFORM public.assert_academic_submission_owner(NEW.assignment_target_id,NEW.user_id,true);
      NEW.verified_at=clock_timestamp();
      IF NEW.verified_at>=NEW.expires_at THEN RAISE EXCEPTION '만료된 업로드 의도입니다.'; END IF;
    ELSIF OLD.state='VERIFIED' AND NEW.state='CONSUMED' THEN
      IF (to_jsonb(NEW)-'state') IS DISTINCT FROM (to_jsonb(OLD)-'state') THEN
        RAISE EXCEPTION '소비 시 업로드 검증 메타를 변경할 수 없습니다.';
      END IF;
    ELSIF OLD.state='INTENDED' AND NEW.state='EXPIRED' AND clock_timestamp()>=OLD.expires_at THEN
      NULL;
    ELSE RAISE EXCEPTION '허용되지 않는 업로드 상태 전이입니다.';
    END IF;
  END IF;
  RETURN NEW;
END;
$intent$;

-- 최종 제출 형식은 과제 형식과 같아야 한다. LEGACY는 기존처럼 검증된 단일 의도를, V2는 의도 참조 없이 파일 단위 검사를 요구한다.
CREATE OR REPLACE FUNCTION public.guard_academic_final_submission() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $final$
DECLARE intent public.assignment_upload_intents; target_format public.assignment_submission_format;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION '최종 제출과 파일은 변경·삭제할 수 없습니다.'; END IF;
  IF TG_TABLE_NAME='assignment_submissions' THEN
    PERFORM 1 FROM public.assignment_targets WHERE id=NEW.assignment_target_id FOR UPDATE;
    PERFORM public.assert_academic_submission_owner(NEW.assignment_target_id,NEW.submitted_by_user_id,true);
    SELECT a.submission_format INTO target_format FROM public.assignments a JOIN public.assignment_targets t ON t.assignment_id=a.id
      WHERE t.id=NEW.assignment_target_id;
    IF NEW.submission_format IS DISTINCT FROM target_format THEN
      RAISE EXCEPTION '과제의 제출 형식과 최종 제출 형식이 다릅니다.';
    END IF;
    IF NEW.submission_format='LEGACY_SINGLE_PDF' THEN
      SELECT * INTO intent FROM public.assignment_upload_intents WHERE id=NEW.upload_intent_id FOR UPDATE;
      IF NOT FOUND OR intent.state<>'VERIFIED' OR intent.expires_at<=clock_timestamp() OR intent.artifact_type<>'LEGACY_PDF'
        OR intent.assignment_target_id IS DISTINCT FROM NEW.assignment_target_id OR intent.user_id IS DISTINCT FROM NEW.submitted_by_user_id THEN
        RAISE EXCEPTION '본인 대상의 유효한 서버 검증 업로드가 필요합니다.';
      END IF;
    ELSIF NEW.upload_intent_id IS NOT NULL THEN
      RAISE EXCEPTION '텍스트·발표자료 제출은 단일 업로드 의도를 참조하지 않습니다.';
    END IF;
    NEW.submitted_at=clock_timestamp();
    -- 제출 시각을 확정한 뒤 마감과 다시 비교하여 경계 통과를 차단한다.
    IF NEW.submitted_at>=(SELECT a.due_at FROM public.assignments a JOIN public.assignment_targets t ON t.assignment_id=a.id WHERE t.id=NEW.assignment_target_id) THEN
      RAISE EXCEPTION '과제 마감 시각이 지났습니다.';
    END IF;
  END IF;
  RETURN NEW;
END;
$final$;

-- 지연 검사(COMMIT/SET CONSTRAINTS)에서 제출·파일·소비 의도의 완결성을 형식별로 확인한다.
-- V2는 파일 1~2개, 유형별 1개, 과제의 필수·미사용 규칙, 제출 합계 100MiB(104,857,600바이트), 검증된 발급 원장을 요구한다.
CREATE OR REPLACE FUNCTION public.assert_academic_submission_complete() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $complete$
DECLARE final_id uuid; final_row public.assignment_submissions; definition public.assignments;
  file_count bigint; total_bytes bigint; has_text boolean; has_slides boolean; mismatched bigint;
BEGIN
  IF TG_TABLE_NAME='assignment_upload_intents' THEN
    IF NEW.state<>'CONSUMED' THEN RETURN NEW; END IF;
    IF NEW.artifact_type='LEGACY_PDF' THEN
      SELECT id INTO final_id FROM public.assignment_submissions WHERE upload_intent_id=NEW.id;
    ELSE
      SELECT submission_id INTO final_id FROM public.assignment_submission_files WHERE storage_key=NEW.storage_key;
    END IF;
    IF final_id IS NULL THEN RAISE EXCEPTION '소비된 업로드 의도에는 최종 제출이 필요합니다.'; END IF;
  ELSIF TG_TABLE_NAME='assignment_submission_files' THEN final_id=NEW.submission_id;
  ELSE final_id=NEW.id;
  END IF;
  SELECT * INTO final_row FROM public.assignment_submissions WHERE id=final_id;
  IF NOT FOUND THEN RAISE EXCEPTION '최종 제출·검증된 단일 파일·소비된 업로드 의도를 함께 저장해야 합니다.'; END IF;
  IF final_row.submission_format='LEGACY_SINGLE_PDF' THEN
    IF NOT EXISTS (SELECT 1 FROM public.assignment_submissions s
      JOIN public.assignment_submission_files f ON f.submission_id=s.id
      JOIN public.assignment_upload_intents i ON i.id=s.upload_intent_id
      WHERE s.id=final_id AND i.state='CONSUMED' AND i.artifact_type='LEGACY_PDF'
        AND ROW(f.storage_key,f.original_name,f.mime_type,f.size_bytes,f.checksum,f.artifact_type,f.file_format)
          IS NOT DISTINCT FROM ROW(i.storage_key,i.original_name,i.mime_type,i.size_bytes,i.checksum,i.artifact_type,i.file_format))
      OR EXISTS (SELECT 1 FROM public.assignment_submission_files WHERE submission_id=final_id AND artifact_type<>'LEGACY_PDF') THEN
      RAISE EXCEPTION '최종 제출·검증된 단일 파일·소비된 업로드 의도를 함께 저장해야 합니다.';
    END IF;
    RETURN NEW;
  END IF;
  SELECT a.* INTO definition FROM public.assignments a JOIN public.assignment_targets t ON t.assignment_id=a.id
    WHERE t.id=final_row.assignment_target_id;
  SELECT count(*),coalesce(sum(f.size_bytes::bigint),0),coalesce(bool_or(f.artifact_type='TEXT'),false),
    coalesce(bool_or(f.artifact_type='SLIDES'),false),
    count(*) FILTER (WHERE f.artifact_type NOT IN ('TEXT','SLIDES') OR NOT EXISTS (
      SELECT 1 FROM public.assignment_upload_intents i JOIN public.academic_upload_authorizations au ON au.intent_id=i.id
      WHERE i.storage_key=f.storage_key AND i.state='CONSUMED'
        AND i.assignment_target_id=final_row.assignment_target_id AND i.user_id=final_row.submitted_by_user_id
        AND ROW(i.original_name,i.mime_type,i.size_bytes,i.checksum,i.artifact_type,i.file_format)
          IS NOT DISTINCT FROM ROW(f.original_name,f.mime_type,f.size_bytes,f.checksum,f.artifact_type,f.file_format)
        AND au.target_id=final_row.assignment_target_id AND au.user_id=final_row.submitted_by_user_id
        AND au.verified_etag IS NOT NULL AND au.retired_at IS NULL AND au.cleanup_claimed_at IS NULL))
    INTO file_count,total_bytes,has_text,has_slides,mismatched
    FROM public.assignment_submission_files f WHERE f.submission_id=final_id;
  IF definition.submission_format IS DISTINCT FROM 'ARTIFACTS_V2' OR file_count NOT BETWEEN 1 AND 2 OR mismatched<>0
    OR total_bytes>104857600
    OR (definition.text_requirement='REQUIRED' AND NOT has_text) OR (definition.slides_requirement='REQUIRED' AND NOT has_slides)
    OR (definition.text_requirement='DISABLED' AND has_text) OR (definition.slides_requirement='DISABLED' AND has_slides) THEN
    RAISE EXCEPTION '텍스트·발표자료 최종 제출의 파일·소비 의도·필수 항목·합계 용량이 일치하지 않습니다.';
  END IF;
  RETURN NEW;
END;
$complete$;

-- 4) v1 진입점은 LEGACY 과제에서 기존 동작을 유지하고 V2 과제에서는 실패로 닫는다.
-- 서버는 비공개 Blob 검증 뒤 호출한다. 이름·크기 검사는 기존 PDF 계약 그대로이며 V2 과제면 upload_conflict다.
CREATE OR REPLACE FUNCTION public.issue_academic_assignment_upload(p_request uuid,p_target uuid,p_actor uuid,p_name text,p_size integer)
RETURNS uuid LANGUAGE plpgsql SET search_path=pg_catalog,public AS $issue$
DECLARE previous public.academic_upload_authorizations; intent_id uuid; expiry timestamptz;
BEGIN
  IF p_request IS NULL OR p_target IS NULL OR p_actor IS NULL OR p_name IS NULL OR p_size IS NULL
    OR p_size NOT BETWEEN 1 AND 52428800 OR length(p_name)>255 OR length(btrim(p_name))=0
    OR p_name<>btrim(p_name) OR p_name ~ '[/\\[:cntrl:]]' OR lower(p_name) NOT LIKE '%.pdf' THEN RAISE EXCEPTION 'upload_invalid_file'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request::text,151));
  PERFORM 1 FROM public.assignment_targets WHERE id=p_target FOR UPDATE;
  PERFORM public.assert_academic_submission_owner(p_target,p_actor,true);
  IF NOT EXISTS (SELECT 1 FROM public.assignments a JOIN public.assignment_targets t ON t.assignment_id=a.id
    WHERE t.id=p_target AND a.submission_format='LEGACY_SINGLE_PDF') THEN RAISE EXCEPTION 'upload_conflict'; END IF;
  SELECT * INTO previous FROM public.academic_upload_authorizations WHERE request_id=p_request;
  IF FOUND THEN
    IF ROW(previous.target_id,previous.user_id,previous.original_name,previous.expected_size,previous.artifact_type)
      IS DISTINCT FROM ROW(p_target,p_actor,p_name,p_size,'LEGACY_PDF'::public.assignment_artifact_type) THEN RAISE EXCEPTION 'upload_conflict'; END IF;
    PERFORM public.authorize_academic_assignment_upload(previous.intent_id,p_actor);
    RETURN previous.intent_id;
  END IF;
  IF EXISTS (SELECT 1 FROM public.assignment_submissions WHERE assignment_target_id=p_target) THEN RAISE EXCEPTION 'upload_conflict'; END IF;
  IF EXISTS (SELECT 1 FROM public.academic_upload_authorizations a JOIN public.assignment_upload_intents i ON i.id=a.intent_id
    WHERE a.target_id=p_target AND a.retired_at IS NULL AND i.expires_at>clock_timestamp()) THEN RAISE EXCEPTION 'upload_conflict'; END IF;
  UPDATE public.academic_upload_authorizations SET retired_at=clock_timestamp() WHERE target_id=p_target AND retired_at IS NULL;
  SELECT least(clock_timestamp()+interval '15 minutes',a.due_at) INTO expiry
    FROM public.assignments a JOIN public.assignment_targets t ON t.assignment_id=a.id WHERE t.id=p_target;
  intent_id=gen_random_uuid();
  INSERT INTO public.assignment_upload_intents(id,assignment_target_id,user_id,storage_key,expires_at,artifact_type,file_format)
    VALUES(intent_id,p_target,p_actor,'academic-uploads/v1/'||intent_id::text||'/document.pdf',expiry,'LEGACY_PDF','PDF');
  INSERT INTO public.academic_upload_authorizations(intent_id,request_id,target_id,user_id,original_name,expected_size,artifact_type,file_format)
    VALUES(intent_id,p_request,p_target,p_actor,p_name,p_size,'LEGACY_PDF','PDF');
  RETURN intent_id;
END;
$issue$;

CREATE OR REPLACE FUNCTION public.verify_authorized_academic_upload(p_intent uuid,p_actor uuid,p_checksum text,p_etag text)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public AS $verify$
DECLARE v_auth public.academic_upload_authorizations; intent public.assignment_upload_intents;
BEGIN
  v_auth=public.authorize_academic_assignment_upload(p_intent,p_actor);
  SELECT * INTO intent FROM public.assignment_upload_intents WHERE id=p_intent;
  -- V2 의도는 형식별 MIME을 쓰는 _v2 검증만 사용한다.
  IF intent.artifact_type<>'LEGACY_PDF' OR v_auth.artifact_type<>'LEGACY_PDF' THEN RAISE EXCEPTION 'upload_conflict'; END IF;
  IF p_etag IS NULL OR length(p_etag) NOT BETWEEN 1 AND 255 OR p_checksum IS NULL OR p_checksum !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'upload_invalid_file'; END IF;
  IF intent.state='INTENDED' THEN
    PERFORM public.verify_academic_assignment_upload(p_intent,p_actor,v_auth.original_name,'application/pdf',v_auth.expected_size,p_checksum);
  ELSIF ROW(intent.original_name,intent.mime_type,intent.size_bytes,intent.checksum)
    IS DISTINCT FROM ROW(v_auth.original_name,'application/pdf'::varchar,v_auth.expected_size,p_checksum::varchar)
    OR (v_auth.verified_etag IS NOT NULL AND v_auth.verified_etag<>p_etag) THEN RAISE EXCEPTION 'upload_conflict'; END IF;
  UPDATE public.academic_upload_authorizations SET verified_etag=p_etag WHERE intent_id=p_intent;
END;
$verify$;

-- #148 원시 최종화도 V2 과제에서는 실패로 닫는다. 동일 키 재시도는 기존처럼 LEGACY 결과만 반환한다.
CREATE OR REPLACE FUNCTION public.finalize_academic_assignment_submission(target_id uuid,actor_id uuid,intent_id uuid,request_key uuid)
RETURNS uuid LANGUAGE plpgsql SET search_path=pg_catalog,public AS $submit$
DECLARE existing public.assignment_submissions; intent public.assignment_upload_intents; final_id uuid;
BEGIN
  IF target_id IS NULL OR actor_id IS NULL OR intent_id IS NULL OR request_key IS NULL THEN
    RAISE EXCEPTION '제출 대상·계정·업로드 의도·멱등 키가 필요합니다.';
  END IF;
  PERFORM 1 FROM public.assignment_targets WHERE id=target_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION '과제 대상이 없습니다.'; END IF;
  PERFORM public.assert_academic_submission_owner(target_id,actor_id,false);
  IF NOT EXISTS (SELECT 1 FROM public.assignments a JOIN public.assignment_targets t ON t.assignment_id=a.id
    WHERE t.id=finalize_academic_assignment_submission.target_id AND a.submission_format='LEGACY_SINGLE_PDF') THEN
    RAISE EXCEPTION 'upload_conflict';
  END IF;
  SELECT * INTO existing FROM public.assignment_submissions WHERE submission_key=request_key;
  IF FOUND THEN
    IF existing.assignment_target_id IS DISTINCT FROM target_id OR existing.submitted_by_user_id IS DISTINCT FROM actor_id
      OR existing.upload_intent_id IS DISTINCT FROM intent_id THEN RAISE EXCEPTION '다른 제출에 사용된 멱등 키입니다.'; END IF;
    RETURN existing.id;
  END IF;
  IF EXISTS (SELECT 1 FROM public.assignment_submissions s WHERE s.assignment_target_id=finalize_academic_assignment_submission.target_id) THEN
    RAISE EXCEPTION '이미 최종 제출한 과제입니다.';
  END IF;
  SELECT * INTO intent FROM public.assignment_upload_intents i WHERE i.id=finalize_academic_assignment_submission.intent_id FOR UPDATE;
  INSERT INTO public.assignment_submissions(assignment_target_id,submitted_by_user_id,upload_intent_id,submission_key,submission_format)
    VALUES(target_id,actor_id,intent_id,request_key,'LEGACY_SINGLE_PDF') RETURNING id INTO final_id;
  INSERT INTO public.assignment_submission_files(submission_id,storage_key,original_name,mime_type,size_bytes,checksum,artifact_type,file_format)
    VALUES(final_id,intent.storage_key,intent.original_name,intent.mime_type,intent.size_bytes,intent.checksum,intent.artifact_type,intent.file_format);
  UPDATE public.assignment_upload_intents i SET state='CONSUMED' WHERE i.id=finalize_academic_assignment_submission.intent_id;
  RETURN final_id;
END;
$submit$;

-- #152 최종화 wrapper. V2 과제는 SUB01(충돌)로 거부하며 그 외 동작·반환 DTO는 기존과 같다.
CREATE OR REPLACE FUNCTION public.complete_academic_assignment_submission(
  p_target_id uuid, p_actor_id uuid, p_intent_id uuid, p_submission_key uuid, p_finalize boolean
) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public AS $complete$
DECLARE
  existing public.assignment_submissions;
  intent public.assignment_upload_intents;
  final_id uuid;
  result jsonb;
  is_replay boolean := false;
BEGIN
  IF p_target_id IS NULL OR p_actor_id IS NULL OR p_intent_id IS NULL OR p_submission_key IS NULL OR p_finalize IS NULL THEN
    RAISE SQLSTATE 'SUB02' USING MESSAGE='제출 요청을 확인할 수 없습니다.';
  END IF;
  PERFORM 1 FROM public.assignment_targets WHERE id=p_target_id FOR UPDATE;
  IF NOT FOUND THEN RAISE SQLSTATE 'SUB02' USING MESSAGE='본인 제출 대상을 찾을 수 없습니다.'; END IF;
  BEGIN
    PERFORM public.assert_academic_submission_owner(p_target_id,p_actor_id,false);
  EXCEPTION WHEN raise_exception THEN
    RAISE SQLSTATE 'SUB02' USING MESSAGE='현재 본인 제출 권한을 확인할 수 없습니다.';
  END;
  IF NOT EXISTS (SELECT 1 FROM public.assignment_targets t
    JOIN public.cohort_enrollments e ON e.id=t.enrollment_id
    JOIN public.academic_students s ON s.id=e.student_id
    JOIN public.users u ON u.id=s.user_id
    JOIN public.assignments a ON a.id=t.assignment_id
    WHERE t.id=p_target_id AND u.id=p_actor_id AND u.role='MEMBER'
      AND e.status='ENROLLED' AND e.ended_at IS NULL
      AND e.enrolled_at<=clock_timestamp() AND e.created_at<=clock_timestamp()
      AND e.cohort_id=a.cohort_id AND a.status IN ('PUBLISHED','CLOSED')
      AND a.published_at IS NOT NULL AND a.published_at<=clock_timestamp()) THEN
    RAISE SQLSTATE 'SUB02' USING MESSAGE='현재 본인 제출 권한을 확인할 수 없습니다.';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.assignments a JOIN public.assignment_targets t ON t.assignment_id=a.id
    WHERE t.id=p_target_id AND a.submission_format='LEGACY_SINGLE_PDF') THEN
    RAISE SQLSTATE 'SUB01' USING MESSAGE='텍스트·발표자료 제출 과제는 새 최종 제출 경로를 사용해야 합니다.';
  END IF;

  SELECT * INTO existing FROM public.assignment_submissions WHERE submission_key=p_submission_key;
  IF FOUND THEN
    IF existing.assignment_target_id<>p_target_id OR existing.submitted_by_user_id<>p_actor_id
      OR existing.upload_intent_id IS DISTINCT FROM p_intent_id THEN
      RAISE SQLSTATE 'SUB01' USING MESSAGE='다른 제출에 사용한 요청입니다.';
    END IF;
    final_id := existing.id;
    is_replay := true;
  ELSE
    IF EXISTS (SELECT 1 FROM public.assignment_submissions WHERE assignment_target_id=p_target_id) THEN
      RAISE SQLSTATE 'SUB01' USING MESSAGE='이미 최종 제출한 과제입니다.';
    END IF;
    IF NOT p_finalize THEN RETURN NULL; END IF;
    SELECT * INTO intent FROM public.assignment_upload_intents WHERE id=p_intent_id FOR UPDATE;
    IF NOT FOUND OR intent.assignment_target_id<>p_target_id OR intent.user_id<>p_actor_id THEN
      RAISE SQLSTATE 'SUB02' USING MESSAGE='본인 업로드 의도를 찾을 수 없습니다.';
    END IF;
    IF intent.expires_at<=clock_timestamp() THEN
      RAISE SQLSTATE 'SUB03' USING MESSAGE='업로드 유효기간이 지났습니다.';
    END IF;
    IF intent.state<>'VERIFIED' THEN
      RAISE SQLSTATE 'SUB04' USING MESSAGE='서버 파일 검증이 필요합니다.';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.assignments a JOIN public.assignment_targets t ON t.assignment_id=a.id
      WHERE t.id=p_target_id AND a.status='PUBLISHED' AND a.due_at>clock_timestamp()) THEN
      RAISE SQLSTATE 'SUB05' USING MESSAGE='과제 제출 기한이 지났습니다.';
    END IF;
    SELECT public.finalize_academic_assignment_submission(p_target_id,p_actor_id,p_intent_id,p_submission_key) INTO final_id;
  END IF;

  -- 저장 키·URL·사용자/학적 ID·체크섬은 브라우저로 반환하지 않습니다.
  SELECT jsonb_build_object('assignmentId',t.assignment_id,'submissionId',s.id,
    'submittedAt',s.submitted_at,'replayed',is_replay,
    'file',jsonb_build_object('fileId',f.id,'originalName',f.original_name,'mimeType',f.mime_type,'sizeBytes',f.size_bytes))
    INTO result FROM public.assignment_submissions s
    JOIN public.assignment_targets t ON t.id=s.assignment_target_id
    JOIN public.assignment_submission_files f ON f.submission_id=s.id
    JOIN public.assignment_upload_intents i ON i.id=s.upload_intent_id
    WHERE s.id=final_id AND s.assignment_target_id=p_target_id AND s.submitted_by_user_id=p_actor_id AND i.state='CONSUMED';
  IF result IS NULL THEN RAISE EXCEPTION '제출 완료 기록의 일관성을 확인할 수 없습니다.'; END IF;
  RETURN result;
END;
$complete$;

-- 5) V2 전용 진입점. 기능 비활성 동안 앱은 호출하지 않는다(#516 PR-D에서 연결).
-- 발급: 산출물 유형·형식·확장자·크기를 검사하고 (대상, 유형)당 활성 의도 1개만 둔다. 같은 요청 ID 재시도는 같은 의도를 반환한다.
CREATE OR REPLACE FUNCTION public.issue_academic_assignment_upload_v2(
  p_request uuid,p_target uuid,p_actor uuid,p_artifact public.assignment_artifact_type,p_format public.assignment_file_format,p_name text,p_size integer
) RETURNS uuid LANGUAGE plpgsql SET search_path=pg_catalog,public AS $issue$
DECLARE previous public.academic_upload_authorizations; definition public.assignments; new_intent uuid; expiry timestamptz;
BEGIN
  IF p_request IS NULL OR p_target IS NULL OR p_actor IS NULL OR p_artifact IS NULL OR p_format IS NULL OR p_name IS NULL OR p_size IS NULL
    OR NOT ((p_artifact='TEXT' AND p_format IN ('PDF','HWP','HWPX')) OR (p_artifact='SLIDES' AND p_format IN ('PDF','PPT','PPTX')))
    OR p_size NOT BETWEEN 1 AND 52428800 OR length(p_name)>255 OR length(btrim(p_name))=0
    OR p_name<>btrim(p_name) OR p_name ~ '[/\\[:cntrl:]]'
    OR lower(p_name) NOT LIKE (CASE p_format WHEN 'PDF' THEN '%.pdf' WHEN 'HWP' THEN '%.hwp' WHEN 'HWPX' THEN '%.hwpx'
      WHEN 'PPT' THEN '%.ppt' WHEN 'PPTX' THEN '%.pptx' END) THEN RAISE EXCEPTION 'upload_invalid_file'; END IF;
  -- v1과 같은 키 공간으로 요청 ID를 직렬화해 v1/v2 경로가 같은 요청 ID를 동시에 쓰지 못하게 한다.
  PERFORM pg_advisory_xact_lock(hashtextextended(p_request::text,151));
  PERFORM 1 FROM public.assignment_targets WHERE id=p_target FOR UPDATE;
  PERFORM public.assert_academic_submission_owner(p_target,p_actor,true);
  SELECT a.* INTO definition FROM public.assignments a JOIN public.assignment_targets t ON t.assignment_id=a.id WHERE t.id=p_target;
  IF definition.submission_format IS DISTINCT FROM 'ARTIFACTS_V2' THEN RAISE EXCEPTION 'upload_conflict'; END IF;
  IF (p_artifact='TEXT' AND definition.text_requirement='DISABLED')
    OR (p_artifact='SLIDES' AND definition.slides_requirement='DISABLED') THEN RAISE EXCEPTION 'upload_invalid_file'; END IF;
  SELECT * INTO previous FROM public.academic_upload_authorizations WHERE request_id=p_request;
  IF FOUND THEN
    IF ROW(previous.target_id,previous.user_id,previous.original_name,previous.expected_size,previous.artifact_type,previous.file_format)
      IS DISTINCT FROM ROW(p_target,p_actor,p_name,p_size,p_artifact,p_format) THEN RAISE EXCEPTION 'upload_conflict'; END IF;
    PERFORM public.authorize_academic_assignment_upload(previous.intent_id,p_actor);
    RETURN previous.intent_id;
  END IF;
  IF EXISTS (SELECT 1 FROM public.assignment_submissions WHERE assignment_target_id=p_target) THEN RAISE EXCEPTION 'upload_conflict'; END IF;
  IF EXISTS (SELECT 1 FROM public.academic_upload_authorizations a JOIN public.assignment_upload_intents i ON i.id=a.intent_id
    WHERE a.target_id=p_target AND a.artifact_type=p_artifact AND a.retired_at IS NULL AND i.expires_at>clock_timestamp()) THEN
    RAISE EXCEPTION 'upload_conflict';
  END IF;
  UPDATE public.academic_upload_authorizations SET retired_at=clock_timestamp()
    WHERE target_id=p_target AND artifact_type=p_artifact AND retired_at IS NULL;
  SELECT least(clock_timestamp()+interval '15 minutes',definition.due_at) INTO expiry;
  new_intent=gen_random_uuid();
  INSERT INTO public.assignment_upload_intents(id,assignment_target_id,user_id,storage_key,expires_at,artifact_type,file_format)
    VALUES(new_intent,p_target,p_actor,'academic-uploads/v2/'||new_intent::text||'/original',expiry,p_artifact,p_format);
  INSERT INTO public.academic_upload_authorizations(intent_id,request_id,target_id,user_id,original_name,expected_size,artifact_type,file_format)
    VALUES(new_intent,p_request,p_target,p_actor,p_name,p_size,p_artifact,p_format);
  RETURN new_intent;
END;
$issue$;

-- 검증: 서버가 비공개 Blob의 실제 형식·크기·SHA-256을 확인한 뒤 호출한다. MIME은 형식별 정규값만 기록한다.
CREATE OR REPLACE FUNCTION public.verify_authorized_academic_upload_v2(p_intent uuid,p_actor uuid,p_checksum text,p_etag text)
RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog,public AS $verify$
DECLARE v_auth public.academic_upload_authorizations; intent public.assignment_upload_intents; canonical_mime varchar(100);
BEGIN
  v_auth=public.authorize_academic_assignment_upload(p_intent,p_actor);
  SELECT * INTO intent FROM public.assignment_upload_intents WHERE id=p_intent;
  IF intent.artifact_type NOT IN ('TEXT','SLIDES') THEN RAISE EXCEPTION 'upload_conflict'; END IF;
  IF p_etag IS NULL OR length(p_etag) NOT BETWEEN 1 AND 255 OR p_checksum IS NULL OR p_checksum !~ '^[0-9a-f]{64}$' THEN RAISE EXCEPTION 'upload_invalid_file'; END IF;
  canonical_mime := CASE intent.file_format WHEN 'PDF' THEN 'application/pdf' WHEN 'HWP' THEN 'application/x-hwp'
    WHEN 'HWPX' THEN 'application/hwp+zip' WHEN 'PPT' THEN 'application/vnd.ms-powerpoint'
    WHEN 'PPTX' THEN 'application/vnd.openxmlformats-officedocument.presentationml.presentation' END;
  IF intent.state='INTENDED' THEN
    PERFORM public.verify_academic_assignment_upload(p_intent,p_actor,v_auth.original_name,canonical_mime,v_auth.expected_size,p_checksum);
  ELSIF ROW(intent.original_name,intent.mime_type,intent.size_bytes,intent.checksum)
    IS DISTINCT FROM ROW(v_auth.original_name,canonical_mime,v_auth.expected_size,p_checksum::varchar)
    OR (v_auth.verified_etag IS NOT NULL AND v_auth.verified_etag<>p_etag) THEN RAISE EXCEPTION 'upload_conflict'; END IF;
  UPDATE public.academic_upload_authorizations SET verified_etag=p_etag WHERE intent_id=p_intent;
END;
$verify$;

-- 최종화: 의도 묶음(1~2개)을 한 트랜잭션에서 원자적으로 확정한다. 같은 멱등 키·같은 의도 묶음은 마감 뒤에도 기존 결과를 반환하고,
-- 같은 키의 다른 묶음은 SUB01이다. SUB06은 필수·미사용·중복·0개 위반, SUB07은 제출 합계 100MiB 초과다.
CREATE OR REPLACE FUNCTION public.complete_academic_assignment_submission_v2(
  p_target_id uuid, p_actor_id uuid, p_intent_ids uuid[], p_submission_key uuid, p_finalize boolean
) RETURNS jsonb LANGUAGE plpgsql SET search_path=pg_catalog,public AS $complete$
DECLARE
  existing public.assignment_submissions;
  definition public.assignments;
  intent public.assignment_upload_intents;
  v_auth public.academic_upload_authorizations;
  final_id uuid;
  result jsonb;
  is_replay boolean := false;
  requested uuid[];
  found_count integer := 0;
  auth_count integer := 0;
  total_bytes bigint := 0;
  has_text boolean := false;
  has_slides boolean := false;
BEGIN
  IF p_target_id IS NULL OR p_actor_id IS NULL OR p_intent_ids IS NULL OR p_submission_key IS NULL OR p_finalize IS NULL
    OR coalesce(array_ndims(p_intent_ids),1)<>1 OR cardinality(p_intent_ids)>2 OR array_position(p_intent_ids,NULL) IS NOT NULL THEN
    RAISE SQLSTATE 'SUB02' USING MESSAGE='제출 요청을 확인할 수 없습니다.';
  END IF;
  SELECT coalesce(array_agg(DISTINCT x ORDER BY x),'{}') INTO requested FROM unnest(p_intent_ids) x;
  IF cardinality(requested)<>cardinality(p_intent_ids) THEN
    RAISE SQLSTATE 'SUB06' USING MESSAGE='같은 업로드를 두 번 제출할 수 없습니다.';
  END IF;
  PERFORM 1 FROM public.assignment_targets WHERE id=p_target_id FOR UPDATE;
  IF NOT FOUND THEN RAISE SQLSTATE 'SUB02' USING MESSAGE='본인 제출 대상을 찾을 수 없습니다.'; END IF;
  BEGIN
    PERFORM public.assert_academic_submission_owner(p_target_id,p_actor_id,false);
  EXCEPTION WHEN raise_exception THEN
    RAISE SQLSTATE 'SUB02' USING MESSAGE='현재 본인 제출 권한을 확인할 수 없습니다.';
  END;
  IF NOT EXISTS (SELECT 1 FROM public.assignment_targets t
    JOIN public.cohort_enrollments e ON e.id=t.enrollment_id
    JOIN public.academic_students s ON s.id=e.student_id
    JOIN public.users u ON u.id=s.user_id
    JOIN public.assignments a ON a.id=t.assignment_id
    WHERE t.id=p_target_id AND u.id=p_actor_id AND u.role='MEMBER'
      AND e.status='ENROLLED' AND e.ended_at IS NULL
      AND e.enrolled_at<=clock_timestamp() AND e.created_at<=clock_timestamp()
      AND e.cohort_id=a.cohort_id AND a.status IN ('PUBLISHED','CLOSED')
      AND a.published_at IS NOT NULL AND a.published_at<=clock_timestamp()) THEN
    RAISE SQLSTATE 'SUB02' USING MESSAGE='현재 본인 제출 권한을 확인할 수 없습니다.';
  END IF;
  SELECT a.* INTO definition FROM public.assignments a JOIN public.assignment_targets t ON t.assignment_id=a.id WHERE t.id=p_target_id;
  IF definition.submission_format IS DISTINCT FROM 'ARTIFACTS_V2' THEN
    RAISE SQLSTATE 'SUB01' USING MESSAGE='기존 PDF 단일 제출 과제는 기존 최종 제출 경로를 사용해야 합니다.';
  END IF;

  -- 성공 복구는 마감·의도 만료·CONSUMED 검사보다 먼저 수행한다. 의도 묶음은 파일 저장 키로 역추적한다.
  SELECT * INTO existing FROM public.assignment_submissions WHERE submission_key=p_submission_key;
  IF FOUND THEN
    IF existing.assignment_target_id<>p_target_id OR existing.submitted_by_user_id<>p_actor_id
      OR existing.submission_format<>'ARTIFACTS_V2'
      OR (SELECT coalesce(array_agg(i.id ORDER BY i.id),'{}') FROM public.assignment_submission_files f
        JOIN public.assignment_upload_intents i ON i.storage_key=f.storage_key WHERE f.submission_id=existing.id)
        IS DISTINCT FROM requested THEN
      RAISE SQLSTATE 'SUB01' USING MESSAGE='다른 제출에 사용한 요청입니다.';
    END IF;
    final_id := existing.id;
    is_replay := true;
  ELSE
    IF EXISTS (SELECT 1 FROM public.assignment_submissions WHERE assignment_target_id=p_target_id) THEN
      RAISE SQLSTATE 'SUB01' USING MESSAGE='이미 최종 제출한 과제입니다.';
    END IF;
    IF NOT p_finalize THEN RETURN NULL; END IF;
    IF cardinality(requested)=0 THEN
      RAISE SQLSTATE 'SUB06' USING MESSAGE='제출할 파일이 최소 1개 필요합니다.';
    END IF;
    -- 본인·같은 대상의 의도만 id 순서로 잠근다. 다른 대상·계정의 의도는 잠그지 않고 개수 불일치로 거부한다.
    FOR intent IN SELECT * FROM public.assignment_upload_intents
      WHERE id=ANY(requested) AND assignment_target_id=p_target_id AND user_id=p_actor_id ORDER BY id FOR UPDATE LOOP
      found_count := found_count+1;
      IF intent.artifact_type NOT IN ('TEXT','SLIDES') THEN
        RAISE SQLSTATE 'SUB02' USING MESSAGE='본인 업로드 의도를 찾을 수 없습니다.';
      END IF;
      IF intent.expires_at<=clock_timestamp() THEN
        RAISE SQLSTATE 'SUB03' USING MESSAGE='업로드 유효기간이 지났습니다.';
      END IF;
      IF intent.state<>'VERIFIED' THEN
        RAISE SQLSTATE 'SUB04' USING MESSAGE='서버 파일 검증이 필요합니다.';
      END IF;
      IF (intent.artifact_type='TEXT' AND has_text) OR (intent.artifact_type='SLIDES' AND has_slides) THEN
        RAISE SQLSTATE 'SUB06' USING MESSAGE='한 제출 항목에는 파일 1개만 제출할 수 있습니다.';
      END IF;
      has_text := has_text OR intent.artifact_type='TEXT';
      has_slides := has_slides OR intent.artifact_type='SLIDES';
      total_bytes := total_bytes+intent.size_bytes;
    END LOOP;
    IF found_count<>cardinality(requested) THEN
      RAISE SQLSTATE 'SUB02' USING MESSAGE='본인 업로드 의도를 찾을 수 없습니다.';
    END IF;
    -- 발급 원장은 의도 뒤에 잠근다. 취소·정리 선점은 충돌, 미검증 ETag는 검증 필요로 분류한다.
    FOR v_auth IN SELECT * FROM public.academic_upload_authorizations WHERE intent_id=ANY(requested) ORDER BY intent_id FOR UPDATE LOOP
      auth_count := auth_count+1;
      IF v_auth.retired_at IS NOT NULL OR v_auth.cleanup_claimed_at IS NOT NULL
        OR v_auth.target_id<>p_target_id OR v_auth.user_id<>p_actor_id THEN
        RAISE SQLSTATE 'SUB01' USING MESSAGE='취소되었거나 정리된 업로드입니다.';
      END IF;
      IF v_auth.verified_etag IS NULL THEN
        RAISE SQLSTATE 'SUB04' USING MESSAGE='서버 파일 검증이 필요합니다.';
      END IF;
    END LOOP;
    IF auth_count<>cardinality(requested) THEN
      RAISE SQLSTATE 'SUB04' USING MESSAGE='서버 파일 검증이 필요합니다.';
    END IF;
    IF (definition.text_requirement='REQUIRED' AND NOT has_text) OR (definition.slides_requirement='REQUIRED' AND NOT has_slides)
      OR (definition.text_requirement='DISABLED' AND has_text) OR (definition.slides_requirement='DISABLED' AND has_slides) THEN
      RAISE SQLSTATE 'SUB06' USING MESSAGE='과제가 요구하는 제출 항목과 일치하지 않습니다.';
    END IF;
    IF total_bytes>104857600 THEN
      RAISE SQLSTATE 'SUB07' USING MESSAGE='제출 파일 합계 용량을 초과했습니다.';
    END IF;
    IF definition.status<>'PUBLISHED' OR definition.due_at IS NULL OR definition.due_at<=clock_timestamp() THEN
      RAISE SQLSTATE 'SUB05' USING MESSAGE='과제 제출 기한이 지났습니다.';
    END IF;
    INSERT INTO public.assignment_submissions(assignment_target_id,submitted_by_user_id,upload_intent_id,submission_key,submission_format)
      VALUES(p_target_id,p_actor_id,NULL,p_submission_key,'ARTIFACTS_V2') RETURNING id INTO final_id;
    INSERT INTO public.assignment_submission_files(submission_id,storage_key,original_name,mime_type,size_bytes,checksum,artifact_type,file_format)
      SELECT final_id,i.storage_key,i.original_name,i.mime_type,i.size_bytes,i.checksum,i.artifact_type,i.file_format
      FROM public.assignment_upload_intents i WHERE i.id=ANY(requested) ORDER BY i.artifact_type;
    UPDATE public.assignment_upload_intents SET state='CONSUMED' WHERE id=ANY(requested);
  END IF;

  -- 저장 키·URL·사용자/학적 ID·체크섬은 반환하지 않는다. 파일은 산출물 유형 순서로 고정한다.
  SELECT jsonb_build_object('assignmentId',t.assignment_id,'submissionId',s.id,'submittedAt',s.submitted_at,'replayed',is_replay,
    'files',(SELECT jsonb_agg(jsonb_build_object('fileId',f.id,'artifactType',f.artifact_type,'fileFormat',f.file_format,
      'originalName',f.original_name,'mimeType',f.mime_type,'sizeBytes',f.size_bytes) ORDER BY f.artifact_type)
      FROM public.assignment_submission_files f WHERE f.submission_id=s.id))
    INTO result FROM public.assignment_submissions s JOIN public.assignment_targets t ON t.id=s.assignment_target_id
    WHERE s.id=final_id AND s.assignment_target_id=p_target_id AND s.submitted_by_user_id=p_actor_id AND s.submission_format='ARTIFACTS_V2';
  IF result IS NULL OR jsonb_typeof(result->'files')<>'array' THEN
    RAISE EXCEPTION '제출 완료 기록의 일관성을 확인할 수 없습니다.';
  END IF;
  RETURN result;
END;
$complete$;

-- 익명/일반 DB 역할에 새 진입점을 자동 공개하지 않는다. 앱 역할의 명시적 GRANT는 운영 절차에서 수행한다.
REVOKE ALL ON FUNCTION public.issue_academic_assignment_upload_v2(uuid,uuid,uuid,public.assignment_artifact_type,public.assignment_file_format,text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.verify_authorized_academic_upload_v2(uuid,uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_academic_assignment_submission_v2(uuid,uuid,uuid[],uuid,boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.issue_academic_assignment_upload(uuid,uuid,uuid,text,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.verify_authorized_academic_upload(uuid,uuid,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.finalize_academic_assignment_submission(uuid,uuid,uuid,uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.complete_academic_assignment_submission(uuid,uuid,uuid,uuid,boolean) FROM PUBLIC;

-- 6) 기존 행은 재분류 없이 LEGACY 값으로만 보여야 한다. 형식이 섞인 기록이 있으면 별도 복구 전까지 거부한다.
DO $data$
BEGIN
  IF EXISTS (SELECT 1 FROM public.assignment_submissions s JOIN public.assignment_targets t ON t.id=s.assignment_target_id
      JOIN public.assignments a ON a.id=t.assignment_id WHERE s.submission_format<>a.submission_format)
    OR EXISTS (SELECT 1 FROM public.assignment_upload_intents i JOIN public.assignment_targets t ON t.id=i.assignment_target_id
      JOIN public.assignments a ON a.id=t.assignment_id
      WHERE (i.artifact_type='LEGACY_PDF') IS DISTINCT FROM (a.submission_format='LEGACY_SINGLE_PDF'))
    OR EXISTS (SELECT 1 FROM public.assignment_submission_files f JOIN public.assignment_submissions s ON s.id=f.submission_id
      WHERE (f.artifact_type='LEGACY_PDF') IS DISTINCT FROM (s.submission_format='LEGACY_SINGLE_PDF'))
    OR EXISTS (SELECT 1 FROM public.assignment_submissions s WHERE s.submission_format='LEGACY_SINGLE_PDF'
      AND (SELECT count(*) FROM public.assignment_submission_files f WHERE f.submission_id=s.id)<>1) THEN
    RAISE EXCEPTION '기존 제출·파일·업로드 의도의 제출 형식 부정합: 별도 복구가 필요합니다.';
  END IF;
END;
$data$;
COMMIT;
