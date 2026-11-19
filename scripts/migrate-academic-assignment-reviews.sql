-- #162 G3 과제 검토·피드백 이력과 담당 검토자 제출 파일 열람 감사의 추가형 SQL입니다.
-- 정책: docs/ACADEMIC-OPERATIONS-POLICY.md P11(지정된 교수 검토자만 열람·피드백)·P12(학생 공개는 학사 운영 관리자가 별도 처리),
-- docs/ACADEMIC-PRIVACY-RETENTION-POLICY.md(평가·교수 피드백 수료 판정 확정일부터 1년 보존 후 삭제, 파기 함수는 별도 승인).
-- 정성 피드백이 기본이며 숫자 점수·학점·GPA·순위 계산은 두지 않습니다. 선택 평가 표기(grade_label)는 계산에 쓰지 않는 짧은 문구입니다.
-- 이 파일의 어떤 표·함수도 출결 조회·입력·정정 권한의 근거가 아닙니다.
-- 선행: G1 과제·제출(#147·#148), #165 학사 운영 관리자 함수, #161 과제 검토 권한 판정(can_review_assignment).
-- 운영 적용은 docs/developer/database-change-procedure.md 절차와 별도 승인이 선행합니다.
-- 이 파일은 같은 DB에 두 번 적용해도 같은 결과가 되며, 이름만 같은 다른 구조는 수용하지 않고 전체를 롤백합니다.
BEGIN;
SET LOCAL search_path = pg_catalog, public;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SELECT pg_advisory_xact_lock(hashtextextended('hra:academic-assignment-reviews:v1', 0));

-- 선행 표·함수가 없으면 부분 설치하지 않고 중단합니다.
DO $dependencies$
BEGIN
  IF to_regclass('public.users') IS NULL OR to_regclass('public.assignments') IS NULL
    OR to_regclass('public.assignment_targets') IS NULL OR to_regclass('public.assignment_submissions') IS NULL
    OR to_regclass('public.assignment_submission_files') IS NULL OR to_regclass('public.cohort_enrollments') IS NULL
    OR to_regclass('public.academic_students') IS NULL
    OR to_regclass('public.academic_faculty_account_links') IS NULL
    OR to_regclass('public.academic_class_reviewer_designations') IS NULL
    OR to_regprocedure('public.require_academic_operations_manager(uuid)') IS NULL
    OR to_regprocedure('public.can_review_assignment(uuid,uuid)') IS NULL THEN
    RAISE EXCEPTION 'assignment_review_migration_dependency_missing';
  END IF;
END;
$dependencies$;

-- 제출물(최종 제출 1건)마다 검토자 한 명당 하나의 현재 검토 행입니다. G1 제출 행·파일은 바꾸지 않습니다.
-- 상태: DRAFT(작성 중) → SUBMITTED(검토자 제출). 공개 여부는 학사 운영 관리자만 바꾸며 검토자 본인은 공개할 수 없습니다.
-- version은 변경마다 1씩 늘어나는 낙관적 동시성 번호이며 모든 버전의 내용은 이력 표에 남습니다.
CREATE TABLE IF NOT EXISTS public.academic_assignment_reviews (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  submission_id uuid NOT NULL CONSTRAINT academic_assignment_reviews_submission_fk REFERENCES public.assignment_submissions(id) ON DELETE RESTRICT,
  assignment_id uuid NOT NULL CONSTRAINT academic_assignment_reviews_assignment_fk REFERENCES public.assignments(id) ON DELETE RESTRICT,
  reviewer_user_id uuid NOT NULL CONSTRAINT academic_assignment_reviews_reviewer_fk REFERENCES public.users(id) ON DELETE RESTRICT,
  version integer NOT NULL,
  status text NOT NULL,
  visibility text NOT NULL,
  body text NOT NULL,
  grade_label text,
  submitted_at timestamptz,
  published_by_user_id uuid CONSTRAINT academic_assignment_reviews_published_by_fk REFERENCES public.users(id) ON DELETE RESTRICT,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT academic_assignment_reviews_submission_reviewer_unique UNIQUE (submission_id, reviewer_user_id),
  CONSTRAINT academic_assignment_reviews_version_check CHECK (version >= 1),
  CONSTRAINT academic_assignment_reviews_status_check CHECK (status IN ('DRAFT', 'SUBMITTED')),
  CONSTRAINT academic_assignment_reviews_visibility_check CHECK (visibility IN ('PRIVATE', 'PUBLISHED_TO_STUDENT')),
  CONSTRAINT academic_assignment_reviews_body_check CHECK (length(btrim(body)) BETWEEN 1 AND 5000),
  CONSTRAINT academic_assignment_reviews_grade_check CHECK (grade_label IS NULL OR length(btrim(grade_label)) BETWEEN 1 AND 20),
  CONSTRAINT academic_assignment_reviews_submitted_check CHECK ((status = 'DRAFT') = (submitted_at IS NULL)),
  CONSTRAINT academic_assignment_reviews_publication_check CHECK (
    (visibility = 'PRIVATE' AND published_by_user_id IS NULL AND published_at IS NULL)
    OR (visibility = 'PUBLISHED_TO_STUDENT' AND status = 'SUBMITTED' AND published_by_user_id IS NOT NULL
      AND published_at IS NOT NULL AND published_by_user_id <> reviewer_user_id))
);
CREATE INDEX IF NOT EXISTS academic_assignment_reviews_assignment_idx
  ON public.academic_assignment_reviews (assignment_id, status);

-- 검토 행의 모든 버전(본문·평가 표기·상태·공개 여부)과 행위자·사유를 남기는 추가 전용 이력입니다.
-- 수정·공개 취소 후에도 이전 평가 사실과 사유가 보존됩니다.
CREATE TABLE IF NOT EXISTS public.academic_assignment_review_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id uuid NOT NULL CONSTRAINT academic_assignment_review_events_review_fk REFERENCES public.academic_assignment_reviews(id) ON DELETE RESTRICT,
  version integer NOT NULL,
  action text NOT NULL,
  actor_user_id uuid NOT NULL CONSTRAINT academic_assignment_review_events_actor_fk REFERENCES public.users(id) ON DELETE RESTRICT,
  status text NOT NULL,
  visibility text NOT NULL,
  body text NOT NULL,
  grade_label text,
  reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT academic_assignment_review_events_review_version_unique UNIQUE (review_id, version),
  CONSTRAINT academic_assignment_review_events_action_check CHECK (action IN ('SAVE', 'SUBMIT', 'PUBLISH', 'RETRACT')),
  CONSTRAINT academic_assignment_review_events_reason_check CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 500)
);

-- 지정 검토자의 제출 파일 전달 허가 감사입니다. G1 본인·관리 열람 감사(academic_submission_file_reads)는 바꾸지 않고 별도로 둡니다.
CREATE TABLE IF NOT EXISTS public.academic_assignment_review_file_reads (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL CONSTRAINT academic_assignment_review_file_reads_actor_fk REFERENCES public.users(id) ON DELETE RESTRICT,
  submission_id uuid NOT NULL CONSTRAINT academic_assignment_review_file_reads_submission_fk REFERENCES public.assignment_submissions(id) ON DELETE RESTRICT,
  file_id uuid NOT NULL CONSTRAINT academic_assignment_review_file_reads_file_fk REFERENCES public.assignment_submission_files(id) ON DELETE RESTRICT,
  authorized_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS academic_assignment_review_file_reads_actor_idx
  ON public.academic_assignment_review_file_reads (actor_user_id, authorized_at);
CREATE INDEX IF NOT EXISTS academic_assignment_review_file_reads_file_idx
  ON public.academic_assignment_review_file_reads (file_id, authorized_at);

-- 이미 있던 표가 이 파일의 정의와 다르면 자동 보정하지 않고 중단합니다. 컬럼·제약·인덱스·RLS를 실제 catalog로 대조합니다.
-- 이력 확인용 제약 트리거(contype 't')는 아래 트리거 검사에서 따로 대조합니다.
DO $shape$
DECLARE
  expected record;
BEGIN
  FOR expected IN SELECT * FROM (VALUES
    ('public.academic_assignment_reviews'::regclass, '[["id","uuid",true,"gen_random_uuid()"],["submission_id","uuid",true,""],
      ["assignment_id","uuid",true,""],["reviewer_user_id","uuid",true,""],["version","integer",true,""],
      ["status","text",true,""],["visibility","text",true,""],["body","text",true,""],["grade_label","text",false,""],
      ["submitted_at","timestamp with time zone",false,""],["published_by_user_id","uuid",false,""],
      ["published_at","timestamp with time zone",false,""],["created_at","timestamp with time zone",true,"now()"],
      ["updated_at","timestamp with time zone",true,"now()"]]'::jsonb, 13, 3),
    ('public.academic_assignment_review_events'::regclass, '[["id","uuid",true,"gen_random_uuid()"],["review_id","uuid",true,""],
      ["version","integer",true,""],["action","text",true,""],["actor_user_id","uuid",true,""],["status","text",true,""],
      ["visibility","text",true,""],["body","text",true,""],["grade_label","text",false,""],["reason","text",false,""],
      ["created_at","timestamp with time zone",true,"clock_timestamp()"]]'::jsonb, 6, 2),
    ('public.academic_assignment_review_file_reads'::regclass, '[["id","uuid",true,"gen_random_uuid()"],
      ["actor_user_id","uuid",true,""],["submission_id","uuid",true,""],["file_id","uuid",true,""],
      ["authorized_at","timestamp with time zone",true,"clock_timestamp()"]]'::jsonb, 4, 3)
  ) AS tables(relation, columns, constraint_count, index_count) LOOP
    IF (SELECT jsonb_agg(jsonb_build_array(a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull,
        COALESCE(pg_get_expr(d.adbin, d.adrelid), '')) ORDER BY a.attnum)
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = expected.relation AND a.attnum > 0 AND NOT a.attisdropped) IS DISTINCT FROM expected.columns THEN
      RAISE EXCEPTION 'assignment_review_migration_column_mismatch';
    END IF;
    IF (SELECT count(*) FROM pg_constraint WHERE conrelid = expected.relation AND contype NOT IN ('n', 't')) <> expected.constraint_count
      OR EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = expected.relation AND contype NOT IN ('n', 't')
        AND (condeferrable OR NOT convalidated))
      OR (SELECT count(*) FROM pg_index WHERE indrelid = expected.relation AND indisvalid AND indisready AND indislive) <> expected.index_count
      OR (SELECT count(*) FROM pg_index WHERE indrelid = expected.relation) <> expected.index_count
      OR EXISTS (SELECT 1 FROM pg_class WHERE oid = expected.relation AND (relkind <> 'r' OR relrowsecurity OR relforcerowsecurity)) THEN
      RAISE EXCEPTION 'assignment_review_migration_structure_mismatch';
    END IF;
  END LOOP;
  -- 키 제약은 이름과 PostgreSQL이 해석한 정의를 함께 비교합니다.
  FOR expected IN SELECT * FROM (VALUES
    ('academic_assignment_reviews', 'academic_assignment_reviews_pkey', 'PRIMARY KEY (id)'),
    ('academic_assignment_reviews', 'academic_assignment_reviews_submission_fk', 'FOREIGN KEY (submission_id) REFERENCES assignment_submissions(id) ON DELETE RESTRICT'),
    ('academic_assignment_reviews', 'academic_assignment_reviews_assignment_fk', 'FOREIGN KEY (assignment_id) REFERENCES assignments(id) ON DELETE RESTRICT'),
    ('academic_assignment_reviews', 'academic_assignment_reviews_reviewer_fk', 'FOREIGN KEY (reviewer_user_id) REFERENCES users(id) ON DELETE RESTRICT'),
    ('academic_assignment_reviews', 'academic_assignment_reviews_published_by_fk', 'FOREIGN KEY (published_by_user_id) REFERENCES users(id) ON DELETE RESTRICT'),
    ('academic_assignment_reviews', 'academic_assignment_reviews_submission_reviewer_unique', 'UNIQUE (submission_id, reviewer_user_id)'),
    ('academic_assignment_review_events', 'academic_assignment_review_events_pkey', 'PRIMARY KEY (id)'),
    ('academic_assignment_review_events', 'academic_assignment_review_events_review_fk', 'FOREIGN KEY (review_id) REFERENCES academic_assignment_reviews(id) ON DELETE RESTRICT'),
    ('academic_assignment_review_events', 'academic_assignment_review_events_actor_fk', 'FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT'),
    ('academic_assignment_review_events', 'academic_assignment_review_events_review_version_unique', 'UNIQUE (review_id, version)'),
    ('academic_assignment_review_file_reads', 'academic_assignment_review_file_reads_pkey', 'PRIMARY KEY (id)'),
    ('academic_assignment_review_file_reads', 'academic_assignment_review_file_reads_actor_fk', 'FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT'),
    ('academic_assignment_review_file_reads', 'academic_assignment_review_file_reads_submission_fk', 'FOREIGN KEY (submission_id) REFERENCES assignment_submissions(id) ON DELETE RESTRICT'),
    ('academic_assignment_review_file_reads', 'academic_assignment_review_file_reads_file_fk', 'FOREIGN KEY (file_id) REFERENCES assignment_submission_files(id) ON DELETE RESTRICT')
  ) AS definitions(relation, name, definition) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = ('public.' || expected.relation)::regclass
      AND c.conname = expected.name AND pg_get_constraintdef(c.oid) = expected.definition) THEN
      RAISE EXCEPTION 'assignment_review_migration_constraint_mismatch';
    END IF;
  END LOOP;
  -- 조회 경로가 기대하는 보조 인덱스의 열 구성도 확인합니다.
  FOR expected IN SELECT * FROM (VALUES
    ('academic_assignment_reviews_assignment_idx', 'academic_assignment_reviews', '(assignment_id, status)'),
    ('academic_assignment_review_file_reads_actor_idx', 'academic_assignment_review_file_reads', '(actor_user_id, authorized_at)'),
    ('academic_assignment_review_file_reads_file_idx', 'academic_assignment_review_file_reads', '(file_id, authorized_at)')
  ) AS indexes(name, relation, columns) LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
      WHERE i.indrelid = ('public.' || expected.relation)::regclass AND c.relname = expected.name
        AND NOT i.indisunique AND i.indpred IS NULL AND i.indexprs IS NULL
        AND pg_get_indexdef(i.indexrelid) LIKE '% USING btree ' || expected.columns) THEN
      RAISE EXCEPTION 'assignment_review_migration_index_mismatch';
    END IF;
  END LOOP;
END;
$shape$;

-- CHECK 식은 버전마다 출력 형식이 달라질 수 있어 같은 정의로 만든 임시 표의 파서 결과와 비교합니다.
CREATE TEMP TABLE academic_assignment_review_expected_review_checks (
  version integer, status text, visibility text, body text, grade_label text, submitted_at timestamptz,
  published_by_user_id uuid, published_at timestamptz, reviewer_user_id uuid,
  CONSTRAINT academic_assignment_reviews_version_check CHECK (version >= 1),
  CONSTRAINT academic_assignment_reviews_status_check CHECK (status IN ('DRAFT', 'SUBMITTED')),
  CONSTRAINT academic_assignment_reviews_visibility_check CHECK (visibility IN ('PRIVATE', 'PUBLISHED_TO_STUDENT')),
  CONSTRAINT academic_assignment_reviews_body_check CHECK (length(btrim(body)) BETWEEN 1 AND 5000),
  CONSTRAINT academic_assignment_reviews_grade_check CHECK (grade_label IS NULL OR length(btrim(grade_label)) BETWEEN 1 AND 20),
  CONSTRAINT academic_assignment_reviews_submitted_check CHECK ((status = 'DRAFT') = (submitted_at IS NULL)),
  CONSTRAINT academic_assignment_reviews_publication_check CHECK (
    (visibility = 'PRIVATE' AND published_by_user_id IS NULL AND published_at IS NULL)
    OR (visibility = 'PUBLISHED_TO_STUDENT' AND status = 'SUBMITTED' AND published_by_user_id IS NOT NULL
      AND published_at IS NOT NULL AND published_by_user_id <> reviewer_user_id))
) ON COMMIT DROP;
CREATE TEMP TABLE academic_assignment_review_expected_event_checks (
  action text, reason text,
  CONSTRAINT academic_assignment_review_events_action_check CHECK (action IN ('SAVE', 'SUBMIT', 'PUBLISH', 'RETRACT')),
  CONSTRAINT academic_assignment_review_events_reason_check CHECK (reason IS NULL OR length(btrim(reason)) BETWEEN 1 AND 500)
) ON COMMIT DROP;
DO $checks$
DECLARE
  pair record;
BEGIN
  FOR pair IN SELECT * FROM (VALUES
    ('public.academic_assignment_reviews'::regclass, 'pg_temp.academic_assignment_review_expected_review_checks'::regclass),
    ('public.academic_assignment_review_events'::regclass, 'pg_temp.academic_assignment_review_expected_event_checks'::regclass)
  ) AS pairs(actual, expected) LOOP
    IF (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname)
        FROM pg_constraint WHERE conrelid = pair.actual AND contype = 'c')
      IS DISTINCT FROM (SELECT array_agg(conname::text || '=' || pg_get_constraintdef(oid) ORDER BY conname)
        FROM pg_constraint WHERE conrelid = pair.expected AND contype = 'c') THEN
      RAISE EXCEPTION 'assignment_review_migration_check_mismatch';
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.academic_assignment_review_file_reads'::regclass AND contype = 'c') THEN
    RAISE EXCEPTION 'assignment_review_migration_check_mismatch';
  END IF;
END;
$checks$;

COMMENT ON TABLE public.academic_assignment_reviews IS
  '#162 제출물별 지정 검토자의 현재 피드백. 학생 공개는 학사 운영 관리자만(검토자 본인 불가). 숫자 성적·순위 없음. 삭제 금지, 보존 1년(파기 함수 별도 승인).';
COMMENT ON TABLE public.academic_assignment_review_events IS
  '#162 피드백 버전별 내용·행위자·사유의 추가 전용 이력. 수정·공개 취소 후에도 이전 평가 사실 보존.';
COMMENT ON TABLE public.academic_assignment_review_file_reads IS
  '#162 지정 검토자의 제출 파일 전달 허가 감사(추가 전용). 저장 키·파일명 원문 없음.';

-- 검토 행은 버전을 1씩 올리는 변경만 허용합니다. 대상·검토자·생성 시각은 바꿀 수 없고 삭제는 막습니다.
CREATE OR REPLACE FUNCTION public.guard_academic_assignment_review() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $guard$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE SQLSTATE 'HRA04' USING MESSAGE = '과제 검토 기록은 삭제할 수 없습니다.';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id <> OLD.id OR NEW.submission_id <> OLD.submission_id OR NEW.assignment_id <> OLD.assignment_id
      OR NEW.reviewer_user_id <> OLD.reviewer_user_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
      OR NEW.version <> OLD.version + 1 THEN
      RAISE SQLSTATE 'HRA04' USING MESSAGE = '과제 검토 기록의 대상·버전은 순서대로만 변경할 수 있습니다.';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.version <> 1 OR NEW.status <> 'DRAFT' OR NEW.visibility <> 'PRIVATE' THEN
    RAISE SQLSTATE 'HRA07' USING MESSAGE = '새 과제 검토는 비공개 초안 1판으로만 만들 수 있습니다.';
  END IF;
  -- 과제 식별자는 제출물이 속한 과제와 같아야 합니다(목록·권한 판정이 이 값을 사용).
  IF NOT EXISTS (SELECT 1 FROM public.assignment_submissions s
    JOIN public.assignment_targets t ON t.id = s.assignment_target_id
    WHERE s.id = NEW.submission_id AND t.assignment_id = NEW.assignment_id) THEN
    RAISE SQLSTATE 'HRA07' USING MESSAGE = '제출물과 과제가 일치하지 않습니다.';
  END IF;
  RETURN NEW;
END;
$guard$;

-- 커밋 시점에 검토 행의 현재 버전과 같은 내용의 이력 행이 있는지 확인합니다. 함수 밖 직접 쓰기도 이력 없이 끝나지 않습니다.
CREATE OR REPLACE FUNCTION public.assert_academic_assignment_review_history() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $history$
DECLARE
  current_row public.academic_assignment_reviews;
BEGIN
  SELECT * INTO current_row FROM public.academic_assignment_reviews WHERE id = NEW.id;
  IF NOT EXISTS (SELECT 1 FROM public.academic_assignment_review_events e
    WHERE e.review_id = current_row.id AND e.version = current_row.version AND e.status = current_row.status
      AND e.visibility = current_row.visibility AND e.body = current_row.body
      AND e.grade_label IS NOT DISTINCT FROM current_row.grade_label) THEN
    RAISE SQLSTATE 'HRA04' USING MESSAGE = '과제 검토 변경에는 같은 버전의 이력이 필요합니다.';
  END IF;
  RETURN NULL;
END;
$history$;

-- 이력·파일 열람 감사는 추가만 허용합니다.
CREATE OR REPLACE FUNCTION public.guard_academic_assignment_review_events() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, public AS $events$
BEGIN
  RAISE SQLSTATE 'HRA04' USING MESSAGE = '과제 검토 이력·감사 기록은 수정·삭제할 수 없습니다.';
END;
$events$;

DROP TRIGGER IF EXISTS academic_assignment_reviews_guard ON public.academic_assignment_reviews;
CREATE TRIGGER academic_assignment_reviews_guard BEFORE INSERT OR UPDATE OR DELETE ON public.academic_assignment_reviews
  FOR EACH ROW EXECUTE FUNCTION public.guard_academic_assignment_review();
DROP TRIGGER IF EXISTS academic_assignment_reviews_history ON public.academic_assignment_reviews;
CREATE CONSTRAINT TRIGGER academic_assignment_reviews_history AFTER INSERT OR UPDATE ON public.academic_assignment_reviews
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.assert_academic_assignment_review_history();
DROP TRIGGER IF EXISTS academic_assignment_reviews_truncate_guard ON public.academic_assignment_reviews;
CREATE TRIGGER academic_assignment_reviews_truncate_guard BEFORE TRUNCATE ON public.academic_assignment_reviews
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_academic_assignment_review_events();
DROP TRIGGER IF EXISTS academic_assignment_review_events_guard ON public.academic_assignment_review_events;
CREATE TRIGGER academic_assignment_review_events_guard BEFORE UPDATE OR DELETE ON public.academic_assignment_review_events
  FOR EACH ROW EXECUTE FUNCTION public.guard_academic_assignment_review_events();
DROP TRIGGER IF EXISTS academic_assignment_review_events_truncate_guard ON public.academic_assignment_review_events;
CREATE TRIGGER academic_assignment_review_events_truncate_guard BEFORE TRUNCATE ON public.academic_assignment_review_events
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_academic_assignment_review_events();
DROP TRIGGER IF EXISTS academic_assignment_review_file_reads_guard ON public.academic_assignment_review_file_reads;
CREATE TRIGGER academic_assignment_review_file_reads_guard BEFORE UPDATE OR DELETE ON public.academic_assignment_review_file_reads
  FOR EACH ROW EXECUTE FUNCTION public.guard_academic_assignment_review_events();
DROP TRIGGER IF EXISTS academic_assignment_review_file_reads_truncate_guard ON public.academic_assignment_review_file_reads;
CREATE TRIGGER academic_assignment_review_file_reads_truncate_guard BEFORE TRUNCATE ON public.academic_assignment_review_file_reads
  FOR EACH STATEMENT EXECUTE FUNCTION public.guard_academic_assignment_review_events();

-- 이 파일이 만든 트리거 외의 사용자 트리거(비활성·replica·always 포함)가 있거나 보호 트리거가 꺼져 있으면 중단합니다.
DO $triggers$
BEGIN
  IF (SELECT array_agg(c.relname::text || ':' || t.tgname::text || ':' || p.proname::text || ':' || t.tgenabled::text
        ORDER BY c.relname::text COLLATE "C", t.tgname::text COLLATE "C")
      FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid JOIN pg_proc p ON p.oid = t.tgfoid
      WHERE NOT t.tgisinternal AND c.oid IN ('public.academic_assignment_reviews'::regclass,
        'public.academic_assignment_review_events'::regclass, 'public.academic_assignment_review_file_reads'::regclass))
    IS DISTINCT FROM ARRAY[
      'academic_assignment_review_events:academic_assignment_review_events_guard:guard_academic_assignment_review_events:O',
      'academic_assignment_review_events:academic_assignment_review_events_truncate_guard:guard_academic_assignment_review_events:O',
      'academic_assignment_review_file_reads:academic_assignment_review_file_reads_guard:guard_academic_assignment_review_events:O',
      'academic_assignment_review_file_reads:academic_assignment_review_file_reads_truncate_guard:guard_academic_assignment_review_events:O',
      'academic_assignment_reviews:academic_assignment_reviews_guard:guard_academic_assignment_review:O',
      'academic_assignment_reviews:academic_assignment_reviews_history:assert_academic_assignment_review_history:O',
      'academic_assignment_reviews:academic_assignment_reviews_truncate_guard:guard_academic_assignment_review_events:O'] THEN
    RAISE EXCEPTION 'assignment_review_migration_trigger_mismatch';
  END IF;
END;
$triggers$;

-- 지정 검토자의 제출물 접근을 같은 트랜잭션에서 확정합니다(검토 저장·제출·파일 열람 공통).
--   1) 제출물·대상·과제·학적·학생 행과 요청 계정·현재 연결·현재 지정 행을 잠가 연결 해제·지정 종료·역할 변경과 직렬화하고,
--   2) 잠금 뒤 #161 can_review_assignment(DB now())를 다시 호출하며,
--   3) 제출 학생의 로그인 계정 또는 제출 계정이 요청 계정과 같으면 거부합니다(자기 검토 금지).
-- 담당하지 않은 과제·없는 제출물은 정보 노출을 줄이기 위해 같은 HRA03(404)로 거부합니다.
CREATE OR REPLACE FUNCTION public.require_academic_submission_reviewer(p_user_id uuid, p_submission_id uuid)
RETURNS uuid LANGUAGE plpgsql SET search_path = pg_catalog, public AS $reviewer$
DECLARE
  target record;
BEGIN
  IF p_user_id IS NULL OR p_submission_id IS NULL THEN
    RAISE SQLSTATE 'HRA03' USING MESSAGE = '검토할 수 있는 제출물을 찾을 수 없습니다.';
  END IF;
  SELECT a.id AS assignment_id, a.schedule_event_id, st.user_id AS student_user_id, s.submitted_by_user_id
    INTO target
    FROM public.assignment_submissions s
    JOIN public.assignment_targets t ON t.id = s.assignment_target_id
    JOIN public.assignments a ON a.id = t.assignment_id
    JOIN public.cohort_enrollments e ON e.id = t.enrollment_id
    JOIN public.academic_students st ON st.id = e.student_id
    WHERE s.id = p_submission_id
    FOR SHARE OF s, t, a, e, st;
  IF NOT FOUND THEN
    RAISE SQLSTATE 'HRA03' USING MESSAGE = '검토할 수 있는 제출물을 찾을 수 없습니다.';
  END IF;
  PERFORM 1 FROM public.users u WHERE u.id = p_user_id FOR SHARE;
  PERFORM 1 FROM public.academic_faculty_account_links l WHERE l.user_id = p_user_id
    AND l.valid_from <= now() AND (l.valid_to IS NULL OR now() < l.valid_to) FOR SHARE;
  PERFORM 1 FROM public.academic_class_reviewer_designations d WHERE d.schedule_event_id = target.schedule_event_id
    AND d.valid_from <= now() AND (d.valid_to IS NULL OR now() < d.valid_to) FOR SHARE;
  IF target.schedule_event_id IS NULL OR NOT public.can_review_assignment(p_user_id, target.assignment_id) THEN
    RAISE SQLSTATE 'HRA03' USING MESSAGE = '검토할 수 있는 제출물을 찾을 수 없습니다.';
  END IF;
  IF target.student_user_id IS NOT DISTINCT FROM p_user_id OR target.submitted_by_user_id = p_user_id THEN
    RAISE SQLSTATE 'HRA01' USING MESSAGE = '본인 제출물은 검토할 수 없습니다.';
  END IF;
  RETURN target.assignment_id;
END;
$reviewer$;

-- 검토 행과 같은 버전의 이력 행을 추가합니다(내부 공통).
CREATE OR REPLACE FUNCTION public.append_academic_assignment_review_event(
  p_review public.academic_assignment_reviews, p_action text, p_actor_id uuid, p_reason text
) RETURNS void LANGUAGE sql SET search_path = pg_catalog, public AS $append$
  INSERT INTO public.academic_assignment_review_events (review_id, version, action, actor_user_id, status, visibility,
    body, grade_label, reason)
  VALUES (p_review.id, p_review.version, p_action, p_actor_id, p_review.status, p_review.visibility,
    p_review.body, p_review.grade_label, NULLIF(btrim(p_reason), ''));
$append$;

-- 검토자의 피드백 초안 저장(신규 작성 또는 수정). p_expected_version은 화면이 읽은 버전이며 신규는 0입니다.
-- 다른 요청이 먼저 바꿨으면 HRA04로 거부합니다. 학생에게 공개된 피드백은 공개 취소 전에는 수정할 수 없고,
-- 이미 제출한 피드백을 고치면 사유가 필요하며 다시 초안이 됩니다(이전 버전은 이력에 남음).
CREATE OR REPLACE FUNCTION public.save_academic_assignment_review(
  p_actor_id uuid, p_submission_id uuid, p_expected_version integer, p_body text, p_grade_label text, p_reason text
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $save$
DECLARE
  assignment uuid;
  review public.academic_assignment_reviews;
  grade text := NULLIF(btrim(p_grade_label), '');
BEGIN
  IF p_actor_id IS NULL OR p_submission_id IS NULL OR p_expected_version IS NULL OR p_expected_version < 0
    OR p_body IS NULL OR length(btrim(p_body)) NOT BETWEEN 1 AND 5000
    OR (grade IS NOT NULL AND length(grade) > 20)
    OR (p_reason IS NOT NULL AND length(btrim(p_reason)) > 500) THEN
    RAISE SQLSTATE 'HRA07' USING MESSAGE = '피드백 입력이 올바르지 않습니다.';
  END IF;
  assignment := public.require_academic_submission_reviewer(p_actor_id, p_submission_id);
  -- 같은 제출물·검토자의 첫 작성 경합도 직렬화합니다.
  PERFORM pg_advisory_xact_lock(hashtextextended('hra:academic-assignment-review:' || p_submission_id::text
    || ':' || p_actor_id::text, 0));
  SELECT * INTO review FROM public.academic_assignment_reviews
    WHERE submission_id = p_submission_id AND reviewer_user_id = p_actor_id FOR UPDATE;
  IF NOT FOUND THEN
    IF p_expected_version <> 0 THEN
      RAISE SQLSTATE 'HRA04' USING MESSAGE = '피드백이 이미 바뀌었습니다. 다시 조회해 주세요.';
    END IF;
    INSERT INTO public.academic_assignment_reviews (submission_id, assignment_id, reviewer_user_id, version, status,
      visibility, body, grade_label)
      VALUES (p_submission_id, assignment, p_actor_id, 1, 'DRAFT', 'PRIVATE', btrim(p_body), grade)
      RETURNING * INTO review;
    PERFORM public.append_academic_assignment_review_event(review, 'SAVE', p_actor_id, p_reason);
    RETURN to_jsonb(review);
  END IF;
  IF review.version <> p_expected_version THEN
    RAISE SQLSTATE 'HRA04' USING MESSAGE = '피드백이 이미 바뀌었습니다. 다시 조회해 주세요.';
  END IF;
  IF review.visibility = 'PUBLISHED_TO_STUDENT' THEN
    RAISE SQLSTATE 'HRA04' USING MESSAGE = '학생에게 공개된 피드백은 공개 취소 후에만 수정할 수 있습니다.';
  END IF;
  IF review.status = 'SUBMITTED' AND (p_reason IS NULL OR length(btrim(p_reason)) = 0) THEN
    RAISE SQLSTATE 'HRA07' USING MESSAGE = '제출한 피드백을 수정하려면 사유가 필요합니다.';
  END IF;
  UPDATE public.academic_assignment_reviews SET version = version + 1, status = 'DRAFT', submitted_at = NULL,
    body = btrim(p_body), grade_label = grade, updated_at = now()
    WHERE id = review.id RETURNING * INTO review;
  PERFORM public.append_academic_assignment_review_event(review, 'SAVE', p_actor_id, p_reason);
  RETURN to_jsonb(review);
END;
$save$;

-- 검토자가 초안을 제출합니다. 제출해도 학생에게 바로 공개되지 않습니다(P12).
CREATE OR REPLACE FUNCTION public.submit_academic_assignment_review(
  p_actor_id uuid, p_review_id uuid, p_expected_version integer
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $submit$
DECLARE
  target_submission uuid;
  review public.academic_assignment_reviews;
BEGIN
  IF p_actor_id IS NULL OR p_review_id IS NULL OR p_expected_version IS NULL THEN
    RAISE SQLSTATE 'HRA07' USING MESSAGE = '피드백 제출 입력이 올바르지 않습니다.';
  END IF;
  SELECT submission_id INTO target_submission FROM public.academic_assignment_reviews
    WHERE id = p_review_id AND reviewer_user_id = p_actor_id;
  IF NOT FOUND THEN RAISE SQLSTATE 'HRA03' USING MESSAGE = '피드백을 찾을 수 없습니다.'; END IF;
  -- 저장과 같은 순서(권한 근거 → 검토 행)로 잠급니다.
  PERFORM public.require_academic_submission_reviewer(p_actor_id, target_submission);
  SELECT * INTO review FROM public.academic_assignment_reviews WHERE id = p_review_id FOR UPDATE;
  IF review.version <> p_expected_version OR review.status <> 'DRAFT' THEN
    RAISE SQLSTATE 'HRA04' USING MESSAGE = '피드백이 이미 바뀌었습니다. 다시 조회해 주세요.';
  END IF;
  UPDATE public.academic_assignment_reviews SET version = version + 1, status = 'SUBMITTED', submitted_at = now(),
    updated_at = now() WHERE id = review.id RETURNING * INTO review;
  PERFORM public.append_academic_assignment_review_event(review, 'SUBMIT', p_actor_id, NULL);
  RETURN to_jsonb(review);
END;
$submit$;

-- 학사 운영 관리자가 제출된 피드백을 학생에게 공개합니다(P12). 작성 검토자 본인과 제출 학생 본인은 공개할 수 없습니다.
CREATE OR REPLACE FUNCTION public.publish_academic_assignment_feedback(
  p_actor_id uuid, p_review_id uuid, p_expected_version integer
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $publish$
DECLARE
  review public.academic_assignment_reviews;
BEGIN
  IF p_actor_id IS NULL OR p_review_id IS NULL OR p_expected_version IS NULL THEN
    RAISE SQLSTATE 'HRA07' USING MESSAGE = '피드백 공개 입력이 올바르지 않습니다.';
  END IF;
  PERFORM public.require_academic_operations_manager(p_actor_id);
  SELECT * INTO review FROM public.academic_assignment_reviews WHERE id = p_review_id FOR UPDATE;
  IF NOT FOUND THEN RAISE SQLSTATE 'HRA03' USING MESSAGE = '피드백을 찾을 수 없습니다.'; END IF;
  IF review.reviewer_user_id = p_actor_id OR EXISTS (SELECT 1 FROM public.assignment_submissions s
    JOIN public.assignment_targets t ON t.id = s.assignment_target_id
    JOIN public.cohort_enrollments e ON e.id = t.enrollment_id
    JOIN public.academic_students st ON st.id = e.student_id
    WHERE s.id = review.submission_id AND (st.user_id = p_actor_id OR s.submitted_by_user_id = p_actor_id)) THEN
    RAISE SQLSTATE 'HRA01' USING MESSAGE = '본인이 작성했거나 본인 제출물의 피드백은 공개할 수 없습니다.';
  END IF;
  IF review.version <> p_expected_version OR review.status <> 'SUBMITTED' OR review.visibility <> 'PRIVATE' THEN
    RAISE SQLSTATE 'HRA04' USING MESSAGE = '피드백이 이미 바뀌었습니다. 다시 조회해 주세요.';
  END IF;
  UPDATE public.academic_assignment_reviews SET version = version + 1, visibility = 'PUBLISHED_TO_STUDENT',
    published_by_user_id = p_actor_id, published_at = now(), updated_at = now()
    WHERE id = review.id RETURNING * INTO review;
  PERFORM public.append_academic_assignment_review_event(review, 'PUBLISH', p_actor_id, NULL);
  RETURN to_jsonb(review);
END;
$publish$;

-- 학사 운영 관리자가 공개한 피드백을 사유와 함께 비공개로 되돌립니다. 공개했던 사실·내용은 이력에 남습니다.
CREATE OR REPLACE FUNCTION public.retract_academic_assignment_feedback(
  p_actor_id uuid, p_review_id uuid, p_expected_version integer, p_reason text
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $retract$
DECLARE
  review public.academic_assignment_reviews;
BEGIN
  IF p_actor_id IS NULL OR p_review_id IS NULL OR p_expected_version IS NULL
    OR p_reason IS NULL OR length(btrim(p_reason)) NOT BETWEEN 1 AND 500 THEN
    RAISE SQLSTATE 'HRA07' USING MESSAGE = '피드백 공개 취소 입력이 올바르지 않습니다.';
  END IF;
  PERFORM public.require_academic_operations_manager(p_actor_id);
  SELECT * INTO review FROM public.academic_assignment_reviews WHERE id = p_review_id FOR UPDATE;
  IF NOT FOUND THEN RAISE SQLSTATE 'HRA03' USING MESSAGE = '피드백을 찾을 수 없습니다.'; END IF;
  IF review.version <> p_expected_version OR review.visibility <> 'PUBLISHED_TO_STUDENT' THEN
    RAISE SQLSTATE 'HRA04' USING MESSAGE = '피드백이 이미 바뀌었습니다. 다시 조회해 주세요.';
  END IF;
  UPDATE public.academic_assignment_reviews SET version = version + 1, visibility = 'PRIVATE',
    published_by_user_id = NULL, published_at = NULL, updated_at = now()
    WHERE id = review.id RETURNING * INTO review;
  PERFORM public.append_academic_assignment_review_event(review, 'RETRACT', p_actor_id, p_reason);
  RETURN to_jsonb(review);
END;
$retract$;

-- 검토자가 지금 검토할 수 있는 과제의 제출물 목록과 본인 피드백입니다. 판정은 can_review_assignment 하나로 하며
-- 본인 제출물은 제외합니다. 다른 검토자의 피드백·학생 계정 식별자는 반환하지 않습니다.
CREATE OR REPLACE FUNCTION public.list_academic_review_submissions(p_user_id uuid, p_assignment_id uuid)
RETURNS TABLE (submission_id uuid, file_id uuid, student_display_name text, submitted_at timestamptz,
  review_id uuid, review_version integer, review_status text, review_visibility text, review_body text,
  review_grade_label text, review_updated_at timestamptz)
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $list_submissions$
  SELECT s.id, f.id, st.display_name::text, s.submitted_at, r.id, r.version, r.status, r.visibility, r.body,
    r.grade_label, r.updated_at
  FROM public.assignment_submissions s
  JOIN public.assignment_targets t ON t.id = s.assignment_target_id
  JOIN public.cohort_enrollments e ON e.id = t.enrollment_id
  JOIN public.academic_students st ON st.id = e.student_id
  LEFT JOIN public.assignment_submission_files f ON f.submission_id = s.id
  LEFT JOIN public.academic_assignment_reviews r ON r.submission_id = s.id AND r.reviewer_user_id = p_user_id
  WHERE p_user_id IS NOT NULL AND t.assignment_id = p_assignment_id
    AND public.can_review_assignment(p_user_id, p_assignment_id)
    AND st.user_id IS DISTINCT FROM p_user_id AND s.submitted_by_user_id <> p_user_id
  ORDER BY s.submitted_at, s.id;
$list_submissions$;

-- 학사 운영 관리자의 공개 검토 대기·공개 중 피드백 목록입니다(관리자 지정을 호출마다 다시 확인).
-- 관리자 본인이 작성했거나 본인 제출물인 피드백도 표시하되 공개 함수가 거부합니다.
CREATE OR REPLACE FUNCTION public.list_academic_feedback_for_publication(p_actor_id uuid)
RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $list_publication$
BEGIN
  PERFORM public.require_academic_operations_manager(p_actor_id);
  RETURN COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'review_id', r.id, 'version', r.version, 'visibility', r.visibility, 'assignment_id', a.id,
      'assignment_title', a.title::text, 'student_display_name', st.display_name::text,
      'reviewer_user_id', r.reviewer_user_id, 'body', r.body, 'grade_label', r.grade_label,
      'submitted_at', r.submitted_at, 'published_at', r.published_at,
      'self_related', (r.reviewer_user_id = p_actor_id OR st.user_id IS NOT DISTINCT FROM p_actor_id
        OR s.submitted_by_user_id = p_actor_id))
      ORDER BY r.visibility, r.submitted_at, r.id)
    FROM public.academic_assignment_reviews r
    JOIN public.assignments a ON a.id = r.assignment_id
    JOIN public.assignment_submissions s ON s.id = r.submission_id
    JOIN public.assignment_targets t ON t.id = s.assignment_target_id
    JOIN public.cohort_enrollments e ON e.id = t.enrollment_id
    JOIN public.academic_students st ON st.id = e.student_id
    WHERE r.status = 'SUBMITTED'), '[]'::jsonb);
END;
$list_publication$;

-- 학생 본인에게 공개된 본인 제출물의 피드백만 반환합니다. 초안·비공개·검토자 식별자·이력은 반환하지 않습니다.
CREATE OR REPLACE FUNCTION public.list_published_academic_feedback(p_user_id uuid, p_assignment_id uuid)
RETURNS TABLE (review_id uuid, body text, grade_label text, published_at timestamptz)
LANGUAGE sql STABLE SET search_path = pg_catalog, public AS $list_published$
  SELECT r.id, r.body, r.grade_label, r.published_at
  FROM public.academic_assignment_reviews r
  JOIN public.assignment_submissions s ON s.id = r.submission_id
  JOIN public.assignment_targets t ON t.id = s.assignment_target_id
  JOIN public.cohort_enrollments e ON e.id = t.enrollment_id
  JOIN public.academic_students st ON st.id = e.student_id
  JOIN public.users u ON u.id = p_user_id
  WHERE p_user_id IS NOT NULL AND t.assignment_id = p_assignment_id AND r.assignment_id = p_assignment_id
    AND st.user_id = p_user_id AND s.submitted_by_user_id = p_user_id AND u.role::text = 'MEMBER'
    AND r.status = 'SUBMITTED' AND r.visibility = 'PUBLISHED_TO_STUDENT'
  ORDER BY r.published_at, r.id;
$list_published$;

-- 지정 검토자의 제출 파일 전달 허가와 감사를 한 트랜잭션으로 확정합니다. 허가 실패 시 감사 행도 남지 않습니다.
CREATE OR REPLACE FUNCTION public.authorize_academic_review_file_read(
  p_user_id uuid, p_submission_id uuid, p_file_id uuid
) RETURNS jsonb LANGUAGE plpgsql SET search_path = pg_catalog, public AS $file_read$
DECLARE
  file public.assignment_submission_files;
  access_id uuid;
BEGIN
  PERFORM public.require_academic_submission_reviewer(p_user_id, p_submission_id);
  SELECT * INTO file FROM public.assignment_submission_files f
    WHERE f.id = p_file_id AND f.submission_id = p_submission_id FOR SHARE;
  IF NOT FOUND THEN RAISE SQLSTATE 'HRA03' USING MESSAGE = '파일을 찾을 수 없습니다.'; END IF;
  INSERT INTO public.academic_assignment_review_file_reads (actor_user_id, submission_id, file_id)
    VALUES (p_user_id, p_submission_id, p_file_id) RETURNING id INTO access_id;
  RETURN jsonb_build_object('storage_key', file.storage_key, 'original_name', file.original_name,
    'mime_type', file.mime_type, 'size_bytes', file.size_bytes, 'checksum', file.checksum, 'access_id', access_id);
END;
$file_read$;

-- 앱 DB 소유 역할만 실행합니다. 임의의 PUBLIC 실행 권한을 제거합니다.
REVOKE ALL ON FUNCTION public.guard_academic_assignment_review() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assert_academic_assignment_review_history() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_academic_assignment_review_events() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.require_academic_submission_reviewer(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.append_academic_assignment_review_event(public.academic_assignment_reviews, text, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.save_academic_assignment_review(uuid, uuid, integer, text, text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.submit_academic_assignment_review(uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.publish_academic_assignment_feedback(uuid, uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.retract_academic_assignment_feedback(uuid, uuid, integer, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_academic_review_submissions(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_academic_feedback_for_publication(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.list_published_academic_feedback(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.authorize_academic_review_file_read(uuid, uuid, uuid) FROM PUBLIC;

-- 함수를 교체해도 이전 GRANT가 남을 수 있으므로 소유자 외 EXECUTE 권한이 남아 있거나 다중 정의가 있으면 중단합니다.
DO $acl$
DECLARE
  names text[] := ARRAY['guard_academic_assignment_review', 'assert_academic_assignment_review_history',
    'guard_academic_assignment_review_events', 'require_academic_submission_reviewer',
    'append_academic_assignment_review_event', 'save_academic_assignment_review', 'submit_academic_assignment_review',
    'publish_academic_assignment_feedback', 'retract_academic_assignment_feedback', 'list_academic_review_submissions',
    'list_academic_feedback_for_publication', 'list_published_academic_feedback', 'authorize_academic_review_file_read'];
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = ANY (names)
      AND (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) a
        WHERE a.grantee <> p.proowner AND a.privilege_type = 'EXECUTE'))
  ) OR (SELECT count(*) FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public' AND p.proname = ANY (names)) <> cardinality(names) THEN
    RAISE EXCEPTION 'assignment_review_migration_function_acl_mismatch';
  END IF;
END;
$acl$;
COMMIT;
