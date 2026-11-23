-- #636 문서 예약과 최종 확정을 분리하되, 확정 저장은 한 트랜잭션에서 처리합니다.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
SET LOCAL search_path = pg_catalog, public;

CREATE TABLE public.class_log_document_requests (
  -- 계정 삭제 뒤에도 만료된 파일을 정확히 식별할 수 있도록 예약 경로는 보존합니다.
  actor_id uuid NOT NULL,
  request_id uuid NOT NULL,
  payload_hash bytea NOT NULL CHECK (octet_length(payload_hash) = 32),
  payload jsonb CHECK (pg_column_size(payload) <= 65536),
  cohort_id uuid NOT NULL,
  log_id uuid,
  pdf_id uuid UNIQUE,
  hangul_id uuid UNIQUE,
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '15 minutes'),
  result_log_id uuid REFERENCES public.class_log_document_records (class_log_id) ON DELETE RESTRICT,
  result_version integer CHECK (result_version > 0),
  PRIMARY KEY (actor_id, request_id),
  CHECK (pdf_id IS NOT NULL OR hangul_id IS NOT NULL),
  CHECK ((result_log_id IS NULL AND result_version IS NULL AND payload IS NOT NULL)
     OR (result_log_id IS NOT NULL AND result_version IS NOT NULL AND payload IS NULL))
);

-- 호출자는 서버 전용입니다. publish 앞에서 예약된 두 파일의 실제 저장소와 콘텐츠를 검증합니다.
CREATE FUNCTION public.write_class_log_document_request(
  p_actor uuid, p_id uuid, p_stage text, p_payload jsonb DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $request$
DECLARE
  actor_role text;
  actor_cohort uuid;
  reservation public.class_log_document_requests%ROWTYPE;
  target_id uuid;
  target_cohort uuid;
  target_author uuid;
  day date;
  revision integer;
  latest_pdf uuid;
  latest_hangul uuid;
  digest_value bytea;
BEGIN
  IF p_stage NOT IN ('reserve', 'inspect', 'publish') OR p_stage IS NULL
     OR (p_stage = 'reserve') IS DISTINCT FROM (p_payload IS NOT NULL) THEN
    RAISE EXCEPTION '잘못된 문서 요청' USING ERRCODE = '22023';
  END IF;

  -- 역할·기수 변경과 사용자별 예약 수 제한을 같은 잠금으로 직렬화합니다.
  SELECT role::text, cohort_id INTO actor_role, actor_cohort
    FROM public.users WHERE id = p_actor FOR UPDATE;
  IF actor_role IS NULL OR actor_role NOT IN ('ADMIN', 'FACULTY', 'MEMBER') THEN
    RETURN jsonb_build_object('state', 'forbidden');
  END IF;

  SELECT * INTO reservation FROM public.class_log_document_requests
    WHERE actor_id = p_actor AND request_id = p_id FOR UPDATE;
  IF FOUND THEN
    target_cohort := reservation.cohort_id;
    target_id := coalesce(reservation.log_id, reservation.result_log_id);
  ELSIF p_stage <> 'reserve' THEN
    RETURN jsonb_build_object('state', 'missing');
  ELSE
    target_id := (p_payload->>'logId')::uuid;
    target_cohort := CASE WHEN actor_role = 'MEMBER' THEN actor_cohort
                         ELSE (p_payload->>'cohortId')::uuid END;
  END IF;

  IF target_id IS NOT NULL THEN
    SELECT r.cohort_id, l.author_id INTO target_cohort, target_author
      FROM public.class_log_document_records r
      JOIN public.class_logs l ON l.id = r.class_log_id
      WHERE r.class_log_id = target_id
      FOR UPDATE OF l;
    IF NOT FOUND OR (actor_role <> 'ADMIN' AND target_author IS DISTINCT FROM p_actor) THEN
      RETURN jsonb_build_object('state', 'forbidden');
    END IF;
  END IF;

  IF target_cohort IS NULL OR (actor_role = 'MEMBER' AND target_cohort IS DISTINCT FROM actor_cohort) THEN
    RETURN jsonb_build_object('state', 'forbidden');
  END IF;

  IF p_stage = 'reserve' THEN
    digest_value := sha256(convert_to(p_payload::text, 'UTF8'));
    IF reservation.request_id IS NOT NULL AND reservation.payload_hash <> digest_value THEN
      RETURN jsonb_build_object('state', 'conflict');
    END IF;
  END IF;

  -- 응답 유실에 같은 요청으로 복구하며, 이미 소비된 파일을 다시 읽지 않습니다.
  IF reservation.result_log_id IS NOT NULL THEN
    RETURN jsonb_build_object('state', 'published', 'logId', reservation.result_log_id, 'version', reservation.result_version);
  END IF;

  IF target_id IS NOT NULL THEN
    SELECT version, pdf_file_id, hangul_file_id INTO revision, latest_pdf, latest_hangul
      FROM public.class_log_document_revisions WHERE class_log_id = target_id ORDER BY version DESC LIMIT 1;
    IF revision IS DISTINCT FROM ((coalesce(reservation.payload, p_payload))->>'version')::integer THEN
      RETURN jsonb_build_object('state', 'conflict');
    END IF;
  ELSIF NOT EXISTS (SELECT FROM public.cohorts WHERE id = target_cohort) THEN
    RETURN jsonb_build_object('state', 'forbidden');
  END IF;

  IF reservation.request_id IS NULL THEN
    IF target_id IS NULL AND EXISTS (
      SELECT FROM public.class_log_document_records
      WHERE cohort_id = target_cohort AND class_day = (p_payload->>'classDay')::date
        AND week_number = (p_payload->>'weekNumber')::integer
    ) THEN
      RETURN jsonb_build_object('state', 'conflict');
    END IF;
    IF NOT (p_payload ? 'pdf' OR p_payload ? 'hangul') THEN
      RAISE EXCEPTION '문서 파일 필요' USING ERRCODE = '22023';
    END IF;
    IF (SELECT count(*) FROM public.class_log_document_requests
           WHERE actor_id = p_actor AND result_log_id IS NULL AND expires_at > now()) >= 3 THEN
      RETURN jsonb_build_object('state', 'busy');
    END IF;
    INSERT INTO public.class_log_document_requests
      (actor_id, request_id, payload_hash, payload, cohort_id, log_id, pdf_id, hangul_id)
    VALUES
      (p_actor, p_id, digest_value, p_payload, target_cohort, target_id,
       CASE WHEN p_payload ? 'pdf' THEN gen_random_uuid() END,
       CASE WHEN p_payload ? 'hangul' THEN gen_random_uuid() END)
    RETURNING * INTO reservation;
  END IF;

  IF reservation.expires_at <= clock_timestamp() THEN
    RETURN jsonb_build_object('state', 'expired');
  END IF;
  IF p_stage <> 'publish' THEN
    RETURN jsonb_build_object('state', 'reserved', 'expiresAt', reservation.expires_at,
      'pdf', CASE WHEN reservation.pdf_id IS NOT NULL THEN
        (reservation.payload->'pdf') || jsonb_build_object('fileId', reservation.pdf_id) END,
      'hangul', CASE WHEN reservation.hangul_id IS NOT NULL THEN
        (reservation.payload->'hangul') || jsonb_build_object('fileId', reservation.hangul_id) END);
  END IF;

  IF target_id IS NULL THEN
    day := (reservation.payload->>'classDay')::date;
    INSERT INTO public.class_logs (title, content, class_date, cohort_id, author_id)
      VALUES (reservation.payload->>'title', coalesce(reservation.payload->>'content', ''),
              day::timestamp - interval '9 hours', target_cohort, p_actor)
      RETURNING id INTO target_id;
    INSERT INTO public.class_log_document_records (class_log_id, cohort_id, class_day, week_number)
      VALUES (target_id, target_cohort, day, (reservation.payload->>'weekNumber')::integer);
    revision := 0;
  END IF;

  INSERT INTO public.class_log_document_files (id, class_log_id, format, byte_size, file_name, storage_key)
    SELECT file_id, target_id, details->>'fileFormat', (details->>'sizeBytes')::integer,
           details->>'originalName', 'class-log-documents/' || file_id::text || '/original'
    FROM (VALUES (reservation.pdf_id, reservation.payload->'pdf'),
                 (reservation.hangul_id, reservation.payload->'hangul')) AS f(file_id, details)
    WHERE file_id IS NOT NULL;

  revision := revision + 1;
  INSERT INTO public.class_log_document_revisions (class_log_id, version, pdf_file_id, hangul_file_id, change_note)
    VALUES (target_id, revision, coalesce(reservation.pdf_id, latest_pdf),
            coalesce(reservation.hangul_id, latest_hangul), reservation.payload->>'changeNote');

  UPDATE public.class_logs SET updated_at = now() WHERE id = target_id;
  UPDATE public.class_log_document_requests
    SET payload = NULL, result_log_id = target_id, result_version = revision
    WHERE actor_id = p_actor AND request_id = p_id;

  RETURN jsonb_build_object('state', 'published', 'logId', target_id, 'version', revision);
END;
$request$;
REVOKE ALL ON FUNCTION public.write_class_log_document_request(uuid, uuid, text, jsonb) FROM PUBLIC;

COMMIT;
