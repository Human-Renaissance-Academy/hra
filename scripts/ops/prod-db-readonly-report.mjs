/**
 * 운영 DB 읽기 전용 집계 보고서 (#280 #287 #268 #494 #507).
 *
 * 역할:
 *   - 운영자가 자신의 자격정보로 직접 실행하고, 출력된 JSON(집계 숫자·고정 코드만)을 이슈 검토에 붙여 넣는다.
 *   - 저장소 작업자·에이전트는 이 명령을 운영 DB에 실행하지 않는다. 절차는
 *     docs/operations/production-verification-runbook.md 를 따른다.
 *
 * 안전 경계:
 *   1) 접속 직후 첫 문장으로 `BEGIN ... READ ONLY` 트랜잭션을 연다. 세션 수준 SET 은 사용하지 않는다(풀러 오염 방지).
 *   2) `transaction_read_only=on` 을 DB에서 다시 확인하지 못하면 어떤 집계도 실행하지 않는다.
 *   3) 접속 역할에 쓰기 권한(슈퍼유저·DB/스키마 CREATE·public 테이블 쓰기)이 있으면 기본 거부한다.
 *      `--allow-rw-role` 을 주면 계속하지만 트랜잭션은 여전히 READ ONLY 이다.
 *   4) 모든 SQL 은 이 파일의 고정 문자열이며 끝은 항상 ROLLBACK 이다. COMMIT 은 보내지 않는다.
 *   5) 출력은 숫자·불리언·고정 코드·저장소 상수 이름만 허용한다. 이메일·URL·호스트·ID·오류 원문은 출력하지 않는다.
 *
 * 입력: 환경변수 DATABASE_URL(읽기 전용 역할 권장). `.env` 를 읽지 않는다.
 * 출력: stdout 에 JSON 한 개. 종료 코드 0=성공, 2=입력 오류, 3=쓰기 가능 역할 거부, 4=읽기 전용 확인 실패, 1=기타 실패.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

// 트랜잭션 시작 문장. 반드시 첫 번째로 실행한다(테스트가 순서를 검증한다).
export const BEGIN_READ_ONLY = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY";
// 트랜잭션 안에서만 유효한 제한. 잠금 대기·장시간 조회로 운영에 영향을 주지 않게 짧게 둔다.
export const PRELUDE = [
  "SET LOCAL statement_timeout = '15s'",
  "SET LOCAL lock_timeout = '2s'",
  "SET LOCAL idle_in_transaction_session_timeout = '60s'",
];
export const VERIFY_READ_ONLY = "SELECT current_setting('transaction_read_only') AS read_only";
export const END = "ROLLBACK";

// 각 섹션을 서로 격리하는 savepoint. 읽기 전용 트랜잭션에서도 허용되며 데이터를 바꾸지 않는다.
const SAVEPOINT = "SAVEPOINT hra_ops_section";
const RELEASE = "RELEASE SAVEPOINT hra_ops_section";
const ROLLBACK_TO = "ROLLBACK TO SAVEPOINT hra_ops_section";
export const CONTROL_STATEMENTS = [
  BEGIN_READ_ONLY,
  ...PRELUDE,
  SAVEPOINT,
  RELEASE,
  ROLLBACK_TO,
  END,
];

// 접속 역할의 쓰기 가능성. 문자열 안의 권한 이름은 조회 인자일 뿐 실행 문장이 아니다.
export const ROLE_QUERY = `SELECT r.rolsuper AS superuser, r.rolcreaterole AS create_role, r.rolcreatedb AS create_db,
  r.rolbypassrls AS bypass_rls,
  has_database_privilege(current_database(), 'CREATE') AS database_create,
  coalesce(has_schema_privilege(to_regnamespace('public'), 'CREATE'), false) AS public_schema_create,
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
      AND has_table_privilege(c.oid, 'INSERT, UPDATE, DELETE, TRUNCATE'))::int AS writable_tables,
  (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND pg_has_role(c.relowner, 'USAGE'))::int AS owned_relations,
  current_setting('server_version_num')::int AS server_version_num,
  pg_is_in_recovery() AS in_recovery
FROM pg_roles r WHERE r.rolname = current_user`;

// 존재하는 public 테이블 목록만 읽는다. 없는 테이블을 참조하는 집계는 실행하지 않고 SKIPPED 로 표시한다.
export const RELATIONS_QUERY = `SELECT c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p', 'v', 'm')`;

// 요청 제한 테이블과 정리 기준 시각 열(cleanup-rate-limits 의 48시간 기준과 같다).
const rateTables = [
  ["rate_limit_events", "attempted_at"],
  ["login_attempts", "attempted_at"],
  ["upload_rate_limit_log", "attempted_at"],
  ["application_submissions_log", "created_at"],
];

// 보호 자료 참조(migrate-protected-resource-blobs.mjs 의 resourceRows 와 같은 대상).
const protectedRefs = [
  ["class_materials", "class_materials", "file_url", ""],
  ["guidebooks", "guidebooks", "file_url", ""],
  ["weekly_texts", "weekly_texts", "file_url", " WHERE file_url <> ''"],
  ["weekly_text_images", "weekly_text_images", "url", ""],
  ["class_log_images", "class_log_images", "url", ""],
];

// #287 에서 검토 중인 자식 FK 후보. 실제 인덱스 추가 결정은 행 수·스캔 통계를 보고 별도로 한다.
export const FK_CANDIDATES = [
  ["gallery_images", "gallery_id"],
  ["application_answers", "submission_id"],
  ["application_answers", "question_id"],
  ["class_logs", "cohort_id"],
  ["schedule_sessions", "schedule_event_id"],
];

/**
 * 집계 질의 목록. requires 의 테이블이 모두 있을 때만 실행한다.
 * text 는 상수이며 사용자 입력을 문자열로 이어 붙이지 않는다(배열 인자는 params 로만 전달).
 */
export const QUERIES = [
  {
    id: "emailIdentity",
    issue: "#507",
    requires: ["users"],
    text: String.raw`WITH u AS (
  SELECT email, role::text AS role, password_hash IS NOT NULL AS has_password,
    oauth_provider, oauth_provider_account_id FROM public.users
), k AS (
  SELECT lower(btrim(email)) AS identity, count(*) AS n, bool_or(role = 'ADMIN') AS has_admin
  FROM u GROUP BY 1 HAVING count(*) > 1
)
SELECT
  (SELECT count(*) FROM u)::int AS total_users,
  (SELECT count(*) FROM k)::int AS collision_groups,
  (SELECT coalesce(sum(n), 0) FROM k)::int AS collision_rows,
  (SELECT count(*) FROM k WHERE has_admin)::int AS collision_groups_with_admin,
  (SELECT count(*) FROM (SELECT email FROM u GROUP BY email HAVING count(*) > 1) e)::int AS exact_duplicate_groups,
  (SELECT count(*) FROM u WHERE email <> btrim(email))::int AS untrimmed,
  (SELECT count(*) FROM u WHERE email <> lower(email))::int AS non_lowercase,
  (SELECT count(*) FROM u WHERE btrim(email) = '')::int AS empty,
  (SELECT count(*) FROM u WHERE email ~ '[^\x01-\x7e]')::int AS non_ascii,
  (SELECT count(*) FROM u WHERE email LIKE '%@oauth.placeholder')::int AS placeholder_rows,
  (SELECT count(*) FROM u WHERE email LIKE '%@oauth.placeholder' AND oauth_provider IS NULL)::int AS placeholder_unbound,
  (SELECT count(*) FROM u WHERE email LIKE '%@oauth.placeholder' AND oauth_provider IS NOT NULL
    AND email <> oauth_provider || '_' || oauth_provider_account_id || '@oauth.placeholder')::int AS placeholder_binding_mismatch,
  (SELECT count(*) FROM u WHERE has_password)::int AS credential_users,
  (SELECT count(*) FROM u WHERE has_password AND oauth_provider IS NOT NULL)::int AS credential_and_oauth_users`,
  },
  {
    id: "oauthProviders",
    issue: "#267",
    requires: ["users"],
    text: `SELECT CASE WHEN oauth_provider IS NULL THEN 'none'
    WHEN oauth_provider IN ('google', 'kakao') THEN oauth_provider ELSE 'other' END AS provider,
  count(*)::int AS users
FROM public.users GROUP BY 1`,
  },
  {
    id: "usersByRole",
    issue: "#507",
    requires: ["users"],
    text: "SELECT role::text AS role, count(*)::int AS users FROM public.users GROUP BY 1",
  },
  {
    id: "emailIdentityIndex",
    issue: "#507",
    requires: ["users"],
    text: `SELECT
  to_regclass('public.users_email_identity_unique') IS NOT NULL AS present,
  coalesce((SELECT i.indisunique AND i.indisvalid AND i.indisready AND i.indislive AND i.indpred IS NULL
    AND i.indrelid = 'public.users'::regclass
    FROM pg_index i WHERE i.indexrelid = to_regclass('public.users_email_identity_unique')), false) AS usable,
  coalesce((SELECT pg_get_indexdef(i.indexrelid) LIKE '%(lower(btrim((email)::text)))'
    FROM pg_index i WHERE i.indexrelid = to_regclass('public.users_email_identity_unique')), false) AS expression_matches,
  EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.users'::regclass
    AND conname = 'users_email_unique' AND contype = 'u') AS exact_email_unique,
  EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.users'::regclass
    AND conname = 'users_oauth_binding_unique' AND contype = 'u') AS oauth_binding_unique,
  EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.users'::regclass
    AND conname = 'users_oauth_binding_both_or_neither' AND contype = 'c') AS oauth_binding_check,
  (SELECT count(*) FROM pg_index i WHERE i.indrelid = 'public.users'::regclass
    AND i.indisunique AND i.indexprs IS NOT NULL)::int AS expression_unique_indexes`,
  },
  ...rateTables.map(([table, column]) => ({
    id: `rateLimit.${table}`,
    issue: "#494",
    requires: [table],
    text: `SELECT count(*)::bigint AS rows,
  count(*) FILTER (WHERE ${column} < clock_timestamp() - interval '48 hours')::bigint AS older_than_48h,
  coalesce(floor(extract(epoch FROM clock_timestamp() - min(${column})) / 3600), 0)::int AS oldest_age_hours,
  pg_total_relation_size('public.${table}'::regclass)::bigint AS total_bytes
FROM public.${table}`,
  })),
  {
    id: "rateLimitReservationIndex",
    issue: "#287",
    requires: ["rate_limit_events"],
    text: `SELECT
  to_regclass('public.idx_rate_limit_reservation_id') IS NOT NULL AS present,
  coalesce((SELECT i.indisvalid AND i.indisready AND i.indislive FROM pg_index i
    WHERE i.indexrelid = to_regclass('public.idx_rate_limit_reservation_id')
      AND i.indrelid = 'public.rate_limit_events'::regclass), false) AS usable,
  coalesce((SELECT pg_get_indexdef(i.indexrelid) =
      'CREATE INDEX idx_rate_limit_reservation_id ON public.rate_limit_events USING btree (reservation_id)'
    FROM pg_index i WHERE i.indexrelid = to_regclass('public.idx_rate_limit_reservation_id')), false) AS definition_matches,
  (SELECT count(*) FROM pg_index i WHERE i.indrelid = 'public.rate_limit_events'::regclass
    AND i.indexrelid IS DISTINCT FROM to_regclass('public.idx_rate_limit_reservation_id')
    AND i.indisvalid AND i.indpred IS NULL
    AND i.indkey[0] = (SELECT attnum FROM pg_attribute WHERE attrelid = 'public.rate_limit_events'::regclass
      AND attname = 'reservation_id' AND NOT attisdropped))::int AS other_leading_indexes`,
  },
  {
    id: "foreignKeyCandidates",
    issue: "#287",
    requires: [],
    params: [FK_CANDIDATES.map(([table]) => table), FK_CANDIDATES.map(([, column]) => column)],
    text: `SELECT t.ord::int AS ord, c.oid IS NOT NULL AS table_present,
  coalesce(c.reltuples, -1)::bigint AS estimated_rows,
  coalesce(s.seq_scan, 0)::bigint AS seq_scan, coalesce(s.idx_scan, 0)::bigint AS idx_scan,
  coalesce(s.n_tup_ins + s.n_tup_upd + s.n_tup_del, 0)::bigint AS writes,
  coalesce(pg_total_relation_size(c.oid), 0)::bigint AS total_bytes,
  EXISTS (SELECT 1 FROM pg_index i JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = i.indkey[0]
    WHERE i.indrelid = c.oid AND a.attname = t.column_name AND i.indisvalid AND i.indpred IS NULL) AS leading_index
FROM unnest($1::text[], $2::text[]) WITH ORDINALITY AS t(table_name, column_name, ord)
LEFT JOIN pg_class c ON c.oid = to_regclass('public.' || quote_ident(t.table_name))
LEFT JOIN pg_stat_user_tables s ON s.relid = c.oid
ORDER BY t.ord`,
  },
  {
    id: "academicUploadCleanup",
    issue: "#494",
    requires: [
      "assignment_upload_intents",
      "academic_upload_authorizations",
      "assignment_submissions",
      "assignment_submission_files",
    ],
    // cleanup.ts 의 후보 조건을 LIMIT 없이 개수로만 센다. claim 함수는 호출하지 않는다.
    text: `SELECT count(*) FILTER (WHERE eligible)::int AS eligible_total,
  count(*) FILTER (WHERE eligible AND previously_deleted)::int AS eligible_previously_deleted,
  count(*) FILTER (WHERE eligible AND previously_claimed)::int AS eligible_previously_claimed,
  count(*)::int AS authorized_intents
FROM (
  SELECT i.state <> 'CONSUMED' AND i.expires_at + interval '5 minutes' <= clock_timestamp()
      AND NOT EXISTS (SELECT 1 FROM public.assignment_submissions s WHERE s.upload_intent_id = i.id)
      AND NOT EXISTS (SELECT 1 FROM public.assignment_submission_files f WHERE f.storage_key = i.storage_key) AS eligible,
    a.deleted_at IS NOT NULL AS previously_deleted,
    a.cleanup_claimed_at IS NOT NULL AS previously_claimed
  FROM public.assignment_upload_intents i JOIN public.academic_upload_authorizations a ON a.intent_id = i.id
) x`,
  },
  {
    id: "academicUploadStates",
    issue: "#494",
    requires: ["assignment_upload_intents"],
    text: "SELECT state::text AS state, count(*)::int AS intents FROM public.assignment_upload_intents GROUP BY 1",
  },
  {
    id: "mobileSessions",
    issue: "#494",
    requires: ["mobile_sessions", "mobile_session_refresh_history"],
    // repository.ts 의 deleteExpiredSessions 조건과 같다. 삭제하지 않고 개수만 센다.
    text: `SELECT count(*)::int AS total,
  count(*) FILTER (WHERE refresh_expires_at <= clock_timestamp() OR absolute_expires_at <= clock_timestamp()
    OR revoked_at <= clock_timestamp())::int AS cleanup_eligible,
  count(*) FILTER (WHERE revoked_at IS NOT NULL)::int AS revoked,
  (SELECT count(*) FROM public.mobile_session_refresh_history)::int AS refresh_history_rows
FROM public.mobile_sessions`,
  },
  ...protectedRefs.map(([kind, table, column, where]) => ({
    id: `protectedBlobRefs.${kind}`,
    issue: "#268",
    requires: [table],
    // 호스트는 DB 안에서 분류만 하고 값은 반환하지 않는다.
    text: String.raw`SELECT count(*)::int AS total,
  count(*) FILTER (WHERE host ~ '\.public\.blob\.vercel-storage\.com$')::int AS public_blob,
  count(*) FILTER (WHERE host ~ '\.private\.blob\.vercel-storage\.com$')::int AS private_blob,
  count(*) FILTER (WHERE host IS NULL)::int AS unparseable,
  count(DISTINCT host) FILTER (WHERE host ~ '\.public\.blob\.vercel-storage\.com$')::int AS distinct_public_hosts,
  count(DISTINCT host) FILTER (WHERE host ~ '\.private\.blob\.vercel-storage\.com$')::int AS distinct_private_hosts
FROM (SELECT substring(${column} FROM '^https://([a-z0-9.-]+)/[^?#]') AS host FROM public.${table}${where}) r`,
  })),
  {
    id: "migrationLedger",
    issue: "#280",
    requires: [],
    text: `SELECT to_regnamespace('hra_migrations') IS NOT NULL AS hra_migrations_schema,
  to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS drizzle_ledger,
  to_regclass('public.__drizzle_migrations') IS NOT NULL AS public_drizzle_ledger`,
  },
  {
    id: "catalog",
    issue: "#280",
    requires: [],
    // params 는 installation-contract.json 에서 만든 저장소 상수 이름 배열이다.
    // 정의 원문은 반환하지 않고 md5 지문만 반환한다.
    text: `SELECT 'relation' AS kind, n AS name, to_regclass(n) IS NOT NULL AS present,
  CASE WHEN to_regclass(n) IS NULL THEN NULL
    WHEN (SELECT relkind FROM pg_class WHERE oid = to_regclass(n)) = 'i' THEN md5(pg_get_indexdef(to_regclass(n)))
    WHEN (SELECT relkind FROM pg_class WHERE oid = to_regclass(n)) IN ('v', 'm') THEN md5(pg_get_viewdef(to_regclass(n)))
    ELSE (SELECT md5(string_agg(a.attname || ':' || format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text, ',' ORDER BY a.attnum))
      FROM pg_attribute a WHERE a.attrelid = to_regclass(n) AND a.attnum > 0 AND NOT a.attisdropped) END AS fingerprint
FROM unnest($1::text[]) AS n
UNION ALL
SELECT 'column', n, a.attnum IS NOT NULL,
  CASE WHEN a.attnum IS NULL THEN NULL ELSE md5(format_type(a.atttypid, a.atttypmod) || ':' || a.attnotnull::text || ':'
    || coalesce(pg_get_expr(d.adbin, d.adrelid), '')) END
FROM unnest($2::text[]) AS n
LEFT JOIN pg_attribute a ON a.attrelid = to_regclass(split_part(n, '.', 1) || '.' || split_part(n, '.', 2))
  AND a.attname = split_part(n, '.', 3) AND a.attnum > 0 AND NOT a.attisdropped
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
UNION ALL
SELECT 'constraint', n, count(c.oid) > 0, md5(string_agg(pg_get_constraintdef(c.oid), ';' ORDER BY c.oid))
FROM unnest($3::text[]) AS n
LEFT JOIN pg_constraint c ON c.conname = split_part(n, '.', 2) AND c.connamespace = to_regnamespace(split_part(n, '.', 1))
GROUP BY n
UNION ALL
SELECT 'function', n, to_regprocedure(n) IS NOT NULL,
  CASE WHEN to_regprocedure(n) IS NULL THEN NULL ELSE md5(pg_get_functiondef(to_regprocedure(n))) END
FROM unnest($4::text[]) AS n
UNION ALL
SELECT 'type', n, to_regtype(n) IS NOT NULL,
  (SELECT md5(string_agg(e.enumlabel, ',' ORDER BY e.enumsortorder)) FROM pg_enum e WHERE e.enumtypid = to_regtype(n))
FROM unnest($5::text[]) AS n
UNION ALL
SELECT 'trigger', n, count(t.oid) > 0, md5(string_agg(pg_get_triggerdef(t.oid), ';' ORDER BY t.oid))
FROM unnest($6::text[]) AS n
LEFT JOIN pg_trigger t ON t.tgname = split_part(n, '.', 2) AND NOT t.tgisinternal
  AND t.tgrelid IN (SELECT c.oid FROM pg_class c WHERE c.relnamespace = to_regnamespace(split_part(n, '.', 1)))
GROUP BY n`,
  },
];

/** installation-contract.json 의 신규 설치 필수 객체를 catalog 조회 인자로 변환한다. */
export function catalogExpectations(contract) {
  const groups = { relation: [], column: [], constraint: [], function: [], type: [], trigger: [] };
  const objects = [];
  for (const object of contract.objects) {
    if (!object.requiredForFresh) continue;
    const entries = [];
    for (const name of object.names) {
      const parts = name.split(".");
      let kind = null;
      if (["table-set", "index-set", "view"].includes(object.kind)) kind = "relation";
      else if (object.kind === "column" || (object.kind === "constraint-set" && parts.length === 3))
        kind = "column";
      else if (object.kind === "constraint-set") kind = "constraint";
      else if (object.kind === "function-set") kind = "function";
      else if (object.kind === "type-set") kind = "type";
      else if (object.kind === "trigger-set") kind = "trigger";
      if (!kind) continue;
      groups[kind].push(name);
      entries.push({ kind, name });
    }
    if (entries.length) objects.push({ id: object.id, entries });
  }
  return { groups, objects };
}

/** DB 정수 값(문자열 bigint 포함)을 안전한 0 이상 정수로 바꾼다. 이상 값은 null 로 둔다. */
function count(value) {
  const number = typeof value === "string" ? Number(value) : value;
  return Number.isSafeInteger(number) && number >= -1 ? number : null;
}

/** 고정 집합 밖의 문자열은 'other' 로 접는다. DB 원문 문자열을 출력에 그대로 싣지 않는다. */
function label(value, allowed) {
  return allowed.includes(value) ? value : "other";
}

const ROLES = ["ADMIN", "FACULTY", "MEMBER", "PENDING"];
const PROVIDERS = ["none", "google", "kakao", "other"];
const UPLOAD_STATES = ["INTENDED", "VERIFIED", "CONSUMED", "EXPIRED"];

/** 섹션별 원시 행을 숫자·불리언만 남긴 결과로 변환한다. */
function shape(query, rows, catalog) {
  const first = rows[0] ?? {};
  const numbers = (row) =>
    Object.fromEntries(
      Object.entries(row).map(([key, value]) => [
        key,
        typeof value === "boolean" ? value : count(value),
      ]),
    );
  switch (query.id) {
    case "oauthProviders":
      return Object.fromEntries(
        PROVIDERS.map((provider) => [
          provider,
          rows
            .filter((row) => label(row.provider, PROVIDERS) === provider)
            .reduce((sum, row) => sum + (count(row.users) ?? 0), 0),
        ]),
      );
    case "usersByRole":
      return Object.fromEntries(
        [...ROLES, "other"].map((role) => [
          role,
          rows
            .filter((row) => label(row.role, ROLES) === role)
            .reduce((sum, row) => sum + (count(row.users) ?? 0), 0),
        ]),
      );
    case "academicUploadStates":
      return Object.fromEntries(
        [...UPLOAD_STATES, "other"].map((state) => [
          state,
          rows
            .filter((row) => label(row.state, UPLOAD_STATES) === state)
            .reduce((sum, row) => sum + (count(row.intents) ?? 0), 0),
        ]),
      );
    case "foreignKeyCandidates":
      return FK_CANDIDATES.map(([table, column], index) => {
        const row = rows.find((candidate) => count(candidate.ord) === index + 1) ?? {};
        // ord 는 대응 확인용 순번이라 결과에서 제외한다.
        const rest = Object.fromEntries(Object.entries(row).filter(([key]) => key !== "ord"));
        return { table, column, ...numbers(rest) };
      });
    case "mobileSessions": {
      const result = numbers(first);
      result.cleanup_calls_at_1000 =
        typeof result.cleanup_eligible === "number"
          ? Math.ceil(result.cleanup_eligible / 1000)
          : null;
      return result;
    }
    case "catalog": {
      const seen = new Map(rows.map((row) => [`${row.kind}|${row.name}`, row]));
      const objects = catalog.objects.map(({ id, entries }) => {
        const missing = entries
          .filter(({ kind, name }) => seen.get(`${kind}|${name}`)?.present !== true)
          .map(({ name }) => name);
        return { id, expected: entries.length, present: entries.length - missing.length, missing };
      });
      // 정의 지문은 저장소 상수 이름과 md5 만으로 만든다. 실행 전후·배포 전후 비교용이며 정답 기준선은 아니다.
      const lines = catalog.objects
        .flatMap(({ entries }) => entries)
        .map(({ kind, name }) => {
          const fingerprint = seen.get(`${kind}|${name}`)?.fingerprint;
          return `${kind}|${name}|${typeof fingerprint === "string" && /^[0-9a-f]{32}$/.test(fingerprint) ? fingerprint : "-"}`;
        })
        .sort();
      return {
        expectedObjects: objects.length,
        completeObjects: objects.filter((object) => object.present === object.expected).length,
        missingNames: objects.reduce((sum, object) => sum + object.missing.length, 0),
        catalogDigest: createHash("sha256").update(lines.join("\n")).digest("hex"),
        objects,
      };
    }
    default:
      return numbers(first);
  }
}

/** 접속 역할이 쓰기 가능한지 판정한다. 하나라도 참이면 쓰기 가능으로 본다. */
export function roleCanWrite(role) {
  return Boolean(
    role.superuser ||
      role.create_role ||
      role.create_db ||
      role.bypass_rls ||
      role.database_create ||
      role.public_schema_create ||
      (count(role.writable_tables) ?? 1) > 0,
  );
}

/**
 * 보고서를 만든다. client 는 pg 호환 `query(text, params)` 만 사용한다(테스트에서는 mock).
 * 어떤 경로로 끝나도 마지막 문장은 ROLLBACK 이다.
 */
export async function runReport({
  client,
  allowRwRole = false,
  contract,
  manifest,
  now = new Date(),
}) {
  const report = {
    schemaVersion: 1,
    tool: "prod-db-readonly-report",
    generatedAt: now.toISOString(),
    readOnly: { transaction: false, roleCanWrite: null, allowRwRole },
    status: "ERROR",
    code: "UNKNOWN",
    sections: {},
  };
  let begun = false;
  try {
    await client.query(BEGIN_READ_ONLY);
    begun = true;
    for (const statement of PRELUDE) await client.query(statement);
    const verify = await client.query(VERIFY_READ_ONLY);
    if (verify.rows?.[0]?.read_only !== "on") {
      report.code = "READ_ONLY_NOT_CONFIRMED";
      return { report, exitCode: 4 };
    }
    report.readOnly.transaction = true;

    const role = (await client.query(ROLE_QUERY)).rows?.[0] ?? {};
    const canWrite = roleCanWrite(role);
    report.readOnly.roleCanWrite = canWrite;
    report.server = {
      versionNum: count(role.server_version_num),
      inRecovery: Boolean(role.in_recovery),
    };
    if (canWrite && !allowRwRole) {
      report.code = "WRITE_CAPABLE_ROLE";
      return { report, exitCode: 3 };
    }

    const relations = new Set(
      ((await client.query(RELATIONS_QUERY)).rows ?? []).map((row) => row.name),
    );
    const catalog = catalogExpectations(contract);
    const catalogParams = ["relation", "column", "constraint", "function", "type", "trigger"].map(
      (kind) => catalog.groups[kind],
    );
    for (const query of QUERIES) {
      if (!query.requires.every((table) => relations.has(table))) {
        report.sections[query.id] = {
          issue: query.issue,
          status: "SKIPPED",
          code: "RELATION_MISSING",
        };
        continue;
      }
      await client.query(SAVEPOINT);
      try {
        const params = query.id === "catalog" ? catalogParams : query.params;
        const result = await client.query(query.text, params);
        await client.query(RELEASE);
        report.sections[query.id] = {
          issue: query.issue,
          status: "OK",
          data: shape(query, result.rows ?? [], catalog),
        };
      } catch (error) {
        await client.query(ROLLBACK_TO);
        // 오류 원문에는 호스트·값이 섞일 수 있으므로 SQLSTATE 형식만 남긴다.
        const sqlstate =
          typeof error?.code === "string" && /^[0-9A-Z]{5}$/.test(error.code)
            ? error.code
            : "UNKNOWN";
        report.sections[query.id] = {
          issue: query.issue,
          status: "ERROR",
          code: `SQLSTATE_${sqlstate}`,
        };
      }
    }
    report.repo = { manifestState: label(manifest?.state, ["unset", "set"]) };
    report.status = Object.values(report.sections).some((section) => section.status === "ERROR")
      ? "PARTIAL"
      : "OK";
    report.code = report.status;
    return { report, exitCode: 0 };
  } catch (error) {
    const sqlstate =
      typeof error?.code === "string" && /^[0-9A-Z]{5}$/.test(error.code) ? error.code : null;
    report.code = begun
      ? sqlstate
        ? `SQLSTATE_${sqlstate}`
        : "QUERY_FAILED"
      : "CONNECT_OR_BEGIN_FAILED";
    return { report, exitCode: 1 };
  } finally {
    if (begun) {
      try {
        await client.query(END);
      } catch {
        // 연결이 이미 끊겼다면 서버가 트랜잭션을 폐기한다. 원문을 출력하지 않는다.
        report.rollbackFailed = true;
      }
    }
  }
}

// 출력에 허용하는 문자열: 고정 코드·저장소 상수 이름(함수 인자의 [] 포함)·ISO 시각·hex 지문. '@', '/', 공백은 허용하지 않는다.
const SAFE_STRING = /^[A-Za-z0-9_.:,()[\]#+-]{0,160}$/;

/** 출력 직전 마지막 방어선. 허용 형식 밖의 값이 있으면 예외를 던져 출력 자체를 막는다. */
export function sanitizeReport(value, path = "$") {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`REDACTION_NUMBER ${path}`);
    return value;
  }
  if (typeof value === "string") {
    if (!SAFE_STRING.test(value)) throw new Error(`REDACTION_STRING ${path}`);
    return value;
  }
  if (Array.isArray(value))
    return value.map((item, index) => sanitizeReport(item, `${path}[${index}]`));
  if (typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        if (!/^[A-Za-z0-9_.]{1,80}$/.test(key)) throw new Error(`REDACTION_KEY ${path}`);
        return [key, sanitizeReport(item, `${path}.${key}`)];
      }),
    );
  }
  throw new Error(`REDACTION_TYPE ${path}`);
}

/** CLI 인자: --allow-rw-role 만 허용한다. 알 수 없는 인자는 접속 전에 거부한다. */
export function parseArguments(argv) {
  const allowed = new Set(["--allow-rw-role"]);
  if (argv.some((arg) => !allowed.has(arg)) || new Set(argv).size !== argv.length) return null;
  return { allowRwRole: argv.includes("--allow-rw-role") };
}

/** DATABASE_URL 형식만 확인한다. 값은 어떤 출력에도 쓰지 않는다. */
export function validDatabaseUrl(value) {
  if (typeof value !== "string" || !value) return false;
  try {
    const url = new URL(value);
    return (
      ["postgres:", "postgresql:"].includes(url.protocol) &&
      Boolean(url.hostname) &&
      Boolean(url.username)
    );
  } catch {
    return false;
  }
}

async function main() {
  const emit = (report) =>
    process.stdout.write(`${JSON.stringify(sanitizeReport(report), null, 2)}\n`);
  const base = { schemaVersion: 1, tool: "prod-db-readonly-report", status: "ERROR" };
  const options = parseArguments(process.argv.slice(2));
  if (!options) {
    emit({ ...base, code: "USAGE" });
    process.exitCode = 2;
    return;
  }
  const url = process.env.DATABASE_URL;
  if (!validDatabaseUrl(url)) {
    emit({ ...base, code: "DATABASE_URL_INVALID" });
    process.exitCode = 2;
    return;
  }
  const contract = JSON.parse(
    readFileSync(join(root, "scripts/db/installation-contract.json"), "utf8"),
  );
  const manifest = JSON.parse(
    readFileSync(join(root, "scripts/db/migration-manifest.json"), "utf8"),
  );
  // 앱과 같은 Neon 드라이버의 WebSocket Client(pg 호환)를 사용한다. 새 의존성을 추가하지 않는다.
  const { Client, neonConfig } = await import("@neondatabase/serverless");
  if (!neonConfig.webSocketConstructor) neonConfig.webSocketConstructor = globalThis.WebSocket;
  const client = new Client({ connectionString: url });
  // 연결 오류 이벤트의 원문을 출력하지 않는다.
  client.on?.("error", () => undefined);
  let result;
  try {
    await client.connect();
    result = await runReport({ client, allowRwRole: options.allowRwRole, contract, manifest });
  } catch {
    result = { report: { ...base, code: "CONNECT_FAILED" }, exitCode: 1 };
  } finally {
    // 종료 실패는 결과 판정에 영향을 주지 않으며 원문을 출력하지 않는다.
    await client.end().catch(() => undefined);
  }
  try {
    emit(result.report);
    process.exitCode = result.exitCode;
  } catch {
    process.stdout.write(`${JSON.stringify({ ...base, code: "REDACTION_BLOCKED" })}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
