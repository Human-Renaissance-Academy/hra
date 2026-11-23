-- #636 수업일지 문서 및 확정 수정본의 저장 제약입니다.
-- 기존 일지 컬럼·행은 유지하며, 이름이 충돌하거나 일부만 설치된 상태는 전체 롤백합니다.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = pg_catalog, public;

-- 기존 일지의 기수와 날짜를 문서 식별자에도 고정합니다.
ALTER TABLE public.class_logs
  ADD CONSTRAINT class_logs_document_identity_key UNIQUE (id, cohort_id, class_date);

CREATE TABLE public.class_log_document_records (
  class_log_id uuid PRIMARY KEY,
  cohort_id uuid NOT NULL,
  class_day date NOT NULL CHECK (isfinite(class_day)),
  week_number integer NOT NULL CHECK (week_number > 0),
  legacy_class_date timestamp GENERATED ALWAYS AS
    (class_day::timestamp - interval '9 hours') STORED,
  first_version integer GENERATED ALWAYS AS (1) STORED,
  CONSTRAINT class_log_document_records_week_key UNIQUE (cohort_id, class_day, week_number),
  CONSTRAINT class_log_document_records_parent_fk
    FOREIGN KEY (class_log_id, cohort_id, legacy_class_date)
    REFERENCES public.class_logs (id, cohort_id, class_date)
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE TABLE public.class_log_document_files (
  id uuid PRIMARY KEY,
  class_log_id uuid NOT NULL REFERENCES public.class_log_document_records (class_log_id) ON DELETE RESTRICT,
  format text NOT NULL CHECK (format IN ('PDF', 'HWP', 'HWPX')),
  slot text GENERATED ALWAYS AS (CASE WHEN format = 'PDF' THEN 'PDF' ELSE 'HANGUL' END) STORED,
  byte_size integer NOT NULL CHECK (byte_size > 0),
  file_name varchar(500) NOT NULL CHECK (btrim(file_name) <> ''),
  storage_key text NOT NULL UNIQUE CHECK (storage_key = 'class-log-documents/' || id::text || '/original'),
  uploaded_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT class_log_document_files_slot_key UNIQUE (class_log_id, id, slot)
);

-- 버전은 같은 일지의 파일 두 슬롯을 명시적으로 참조합니다.
-- 변경하지 않은 슬롯은 직전 버전과 같은 파일을 참조할 수 있습니다.
CREATE TABLE public.class_log_document_revisions (
  class_log_id uuid NOT NULL REFERENCES public.class_log_document_records (class_log_id) ON DELETE RESTRICT,
  version integer NOT NULL CHECK (version > 0),
  previous_version integer GENERATED ALWAYS AS (NULLIF(version - 1, 0)) STORED,
  pdf_file_id uuid,
  hangul_file_id uuid,
  pdf_slot text GENERATED ALWAYS AS ('PDF'::text) STORED,
  hangul_slot text GENERATED ALWAYS AS ('HANGUL'::text) STORED,
  change_note varchar(500),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (class_log_id, version),
  CONSTRAINT class_log_document_revisions_has_file CHECK (pdf_file_id IS NOT NULL OR hangul_file_id IS NOT NULL),
  CONSTRAINT class_log_document_revisions_previous_fk
    FOREIGN KEY (class_log_id, previous_version) REFERENCES public.class_log_document_revisions (class_log_id, version),
  CONSTRAINT class_log_document_revisions_pdf_fk
    FOREIGN KEY (class_log_id, pdf_file_id, pdf_slot) REFERENCES public.class_log_document_files (class_log_id, id, slot)
    ON DELETE RESTRICT,
  CONSTRAINT class_log_document_revisions_hangul_fk
    FOREIGN KEY (class_log_id, hangul_file_id, hangul_slot) REFERENCES public.class_log_document_files (class_log_id, id, slot)
    ON DELETE RESTRICT
);

-- 신규 일지와 v1을 한 트랜잭션에 기록할 수 있으며, 빈 기록은 확정하지 못합니다.
ALTER TABLE public.class_log_document_records
  ADD CONSTRAINT class_log_document_records_first_version_fk
  FOREIGN KEY (class_log_id, first_version)
  REFERENCES public.class_log_document_revisions (class_log_id, version)
  DEFERRABLE INITIALLY DEFERRED;

-- 확정 식별자와 버전, 검증된 파일 메타데이터는 일반 쓰기 경로에서 바꾸지 않습니다.
CREATE FUNCTION public.reject_class_log_document_mutation()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog
AS $guard$
BEGIN
  RAISE EXCEPTION '수업일지 문서의 확정 정보는 변경할 수 없습니다.' USING ERRCODE = '23514';
END;
$guard$;
REVOKE ALL ON FUNCTION public.reject_class_log_document_mutation() FROM PUBLIC;

CREATE TRIGGER class_log_document_records_immutable
  BEFORE UPDATE ON public.class_log_document_records
  FOR EACH ROW EXECUTE FUNCTION public.reject_class_log_document_mutation();
CREATE TRIGGER class_log_document_files_immutable
  BEFORE UPDATE ON public.class_log_document_files
  FOR EACH ROW EXECUTE FUNCTION public.reject_class_log_document_mutation();
CREATE TRIGGER class_log_document_revisions_immutable
  BEFORE UPDATE OR DELETE ON public.class_log_document_revisions
  FOR EACH ROW EXECUTE FUNCTION public.reject_class_log_document_mutation();

COMMIT;
