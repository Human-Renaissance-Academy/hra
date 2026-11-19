/**
 * 운영 읽기 전용 점검 스크립트(scripts/ops)의 안전 성질을 mock 클라이언트로 검증한다.
 * 실제 DB·Vercel·Blob 에 접속하지 않는다.
 *   - 첫 문장이 READ ONLY 트랜잭션이고 마지막은 항상 ROLLBACK 이며 COMMIT 을 보내지 않는다.
 *   - 고정 SQL 목록에 쓰기·DDL·권한·트랜잭션 확정 문장이 없다.
 *   - 쓰기 가능 역할은 기본 거부하고, 허용 플래그가 있어도 READ ONLY 트랜잭션을 유지한다.
 *   - 출력에 이메일·URL·호스트·오류 원문이 실리지 않는다.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  BEGIN_READ_ONLY,
  CONTROL_STATEMENTS,
  END,
  PRELUDE,
  QUERIES,
  RELATIONS_QUERY,
  ROLE_QUERY,
  VERIFY_READ_ONLY,
  catalogExpectations,
  parseArguments,
  roleCanWrite,
  runReport,
  sanitizeReport,
  validDatabaseUrl,
} from "../ops/prod-db-readonly-report.mjs";
import { analyzeEnvironmentScopes } from "../ops/vercel-env-scope-report.mjs";
import { countPublicPrefixes, protectedPrefixes } from "../ops/blob-protected-prefix-report.mjs";

const contract = JSON.parse(
  readFileSync(new URL("../db/installation-contract.json", import.meta.url), "utf8"),
);
const manifest = { state: "unset" };
const readOnlyRole = {
  superuser: false,
  create_role: false,
  create_db: false,
  bypass_rls: false,
  database_create: false,
  public_schema_create: false,
  writable_tables: 0,
  owned_relations: 0,
  server_version_num: 170000,
  in_recovery: false,
};
const allTables = [...new Set(QUERIES.flatMap((query) => query.requires))];
const leakEmail = "Leak.Person@example.com";
const leakUrl = "https://secretstore.public.blob.vercel-storage.com/class-materials/x.pdf";

/** 문장을 기록하는 pg 호환 mock. responders 로 특정 문장의 결과·오류를 바꾼다. */
function mockClient({
  role = readOnlyRole,
  readOnly = "on",
  tables = allTables,
  responders = {},
} = {}) {
  const statements = [];
  return {
    statements,
    async query(text, params) {
      statements.push({ text, params });
      if (responders[text]) return responders[text](params);
      if (text === VERIFY_READ_ONLY) return { rows: [{ read_only: readOnly }] };
      if (text === ROLE_QUERY) return { rows: [role] };
      if (text === RELATIONS_QUERY) return { rows: tables.map((name) => ({ name })) };
      // 일반 집계에는 개인정보처럼 보이는 문자열을 섞어 출력 차단을 확인한다.
      return {
        rows: [
          {
            total_users: 3,
            collision_groups: "1",
            email: leakEmail,
            url: leakUrl,
            provider: leakEmail,
            role: "ADMIN",
            users: 2,
          },
        ],
      };
    },
  };
}

/** SQL 주석·문자열 리터럴을 지운 뒤 금지 키워드를 찾는다. */
function forbiddenKeywords(sql) {
  const stripped = sql.replace(/--[^\n]*/g, " ").replace(/'(?:[^']|'')*'/g, "''");
  const forbidden =
    /\b(INSERT|UPDATE|DELETE|MERGE|TRUNCATE|ALTER|CREATE|DROP|GRANT|REVOKE|COMMIT|COPY|CALL|DO|VACUUM|ANALYZE|REINDEX|CLUSTER|LOCK|REFRESH|NOTIFY|LISTEN|SECURITY|nextval|setval|pg_advisory\w*|dblink\w*|pg_terminate_backend|pg_cancel_backend|lo_\w+|claim_\w+|reserve_\w+|apply_\w+|register_\w+|mutate_\w+|publish_\w+|finalize_\w+|complete_\w+|issue_\w+|cancel_\w+)\b/i;
  return stripped.match(forbidden)?.[0] ?? null;
}

test("첫 문장은 READ ONLY 트랜잭션이고 마지막은 ROLLBACK 이며 COMMIT 을 보내지 않는다", async () => {
  const client = mockClient();
  const { report, exitCode } = await runReport({ client, contract, manifest });
  assert.equal(exitCode, 0);
  assert.equal(client.statements[0].text, BEGIN_READ_ONLY);
  assert.match(BEGIN_READ_ONLY, /^BEGIN\b.*\bREAD ONLY$/);
  assert.deepEqual(
    client.statements.slice(1, 1 + PRELUDE.length).map((s) => s.text),
    PRELUDE,
  );
  assert.equal(client.statements[1 + PRELUDE.length].text, VERIFY_READ_ONLY);
  assert.equal(client.statements.at(-1).text, END);
  assert.ok(client.statements.every(({ text }) => !/\bCOMMIT\b/i.test(text)));
  assert.equal(report.readOnly.transaction, true);
  assert.equal(report.readOnly.roleCanWrite, false);
});

test("고정 SQL 목록에 쓰기·DDL·변경 함수 호출이 없다", () => {
  for (const query of QUERIES) assert.equal(forbiddenKeywords(query.text), null, query.id);
  for (const sql of [ROLE_QUERY, RELATIONS_QUERY, VERIFY_READ_ONLY])
    assert.equal(forbiddenKeywords(sql), null);
  // 제어 문장은 트랜잭션 시작·제한·savepoint·ROLLBACK 만 허용한다.
  for (const sql of CONTROL_STATEMENTS) {
    assert.match(
      sql,
      /^(BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY|SET LOCAL \w+ = '\d+s'|SAVEPOINT \w+|RELEASE SAVEPOINT \w+|ROLLBACK( TO SAVEPOINT \w+)?)$/,
    );
  }
  // 검사기 자체의 양성 대조: 금지 문장을 실제로 잡는다.
  assert.equal(forbiddenKeywords("DELETE FROM public.users"), "DELETE");
  assert.equal(
    forbiddenKeywords("SELECT claim_academic_upload_cleanup('x')"),
    "claim_academic_upload_cleanup",
  );
  assert.equal(forbiddenKeywords("SELECT has_table_privilege(c.oid, 'INSERT, UPDATE')"), null);
});

test("READ ONLY 를 DB 에서 확인하지 못하면 집계 없이 ROLLBACK 한다", async () => {
  const client = mockClient({ readOnly: "off" });
  const { report, exitCode } = await runReport({ client, contract, manifest });
  assert.equal(exitCode, 4);
  assert.equal(report.code, "READ_ONLY_NOT_CONFIRMED");
  assert.deepEqual(
    client.statements.map((s) => s.text),
    [BEGIN_READ_ONLY, ...PRELUDE, VERIFY_READ_ONLY, END],
  );
});

test("쓰기 가능 역할은 기본 거부하고 허용 플래그가 있어도 같은 READ ONLY 트랜잭션을 쓴다", async () => {
  const writer = { ...readOnlyRole, writable_tables: 12 };
  const refused = mockClient({ role: writer });
  const first = await runReport({ client: refused, contract, manifest });
  assert.equal(first.exitCode, 3);
  assert.equal(first.report.code, "WRITE_CAPABLE_ROLE");
  assert.ok(!refused.statements.some(({ text }) => QUERIES.some((query) => query.text === text)));
  assert.equal(refused.statements.at(-1).text, END);

  const allowed = mockClient({ role: writer });
  const second = await runReport({ client: allowed, allowRwRole: true, contract, manifest });
  assert.equal(second.exitCode, 0);
  assert.equal(allowed.statements[0].text, BEGIN_READ_ONLY);
  assert.equal(allowed.statements.at(-1).text, END);
  assert.equal(second.report.readOnly.roleCanWrite, true);
  for (const flag of [
    "superuser",
    "create_role",
    "create_db",
    "bypass_rls",
    "database_create",
    "public_schema_create",
  ]) {
    assert.equal(roleCanWrite({ ...readOnlyRole, [flag]: true }), true, flag);
  }
  assert.equal(roleCanWrite(readOnlyRole), false);
  assert.equal(roleCanWrite({ ...readOnlyRole, writable_tables: null }), true);
});

test("출력에는 이메일·URL·호스트·DB 원문 문자열이 실리지 않는다", async () => {
  const client = mockClient({
    responders: {
      [QUERIES.find((q) => q.id === "emailIdentity").text]: () => {
        throw Object.assign(new Error(`host secret ${leakUrl}`), { code: "42P01" });
      },
    },
  });
  const { report } = await runReport({ client, contract, manifest });
  const text = JSON.stringify(sanitizeReport(report));
  for (const leak of [leakEmail, leakUrl, "secretstore", "example.com", "host secret"])
    assert.ok(!text.includes(leak), leak);
  assert.equal(report.sections.emailIdentity.code, "SQLSTATE_42P01");
  assert.equal(report.status, "PARTIAL");
  // 제공자·역할은 고정 집합으로 접힌다.
  assert.deepEqual(Object.keys(report.sections.oauthProviders.data), [
    "none",
    "google",
    "kakao",
    "other",
  ]);
  assert.equal(report.sections.oauthProviders.data.other, 2);
  // 마지막 방어선: 허용 형식 밖 문자열·실수는 예외로 출력 자체를 막는다.
  assert.throws(() => sanitizeReport({ a: leakEmail }), /REDACTION_STRING/);
  assert.throws(() => sanitizeReport({ a: leakUrl }), /REDACTION_STRING/);
  assert.throws(() => sanitizeReport({ a: 1.5 }), /REDACTION_NUMBER/);
  assert.throws(() => sanitizeReport({ "a@b": 1 }), /REDACTION_KEY/);
});

test("없는 테이블을 참조하는 집계는 실행하지 않고 SKIPPED 로 둔다", async () => {
  const client = mockClient({ tables: ["users"] });
  const { report } = await runReport({ client, contract, manifest });
  assert.equal(report.sections.mobileSessions.status, "SKIPPED");
  assert.equal(report.sections["rateLimit.rate_limit_events"].status, "SKIPPED");
  assert.equal(report.sections.emailIdentity.status, "OK");
  assert.ok(
    !client.statements.some(
      ({ text }) => text === QUERIES.find((q) => q.id === "mobileSessions").text,
    ),
  );
});

test("catalog 기대값은 설치 계약의 신규 설치 필수 객체에서 만든다", () => {
  const { groups, objects } = catalogExpectations(contract);
  assert.ok(groups.relation.includes("public.users_email_identity_unique"));
  assert.ok(groups.relation.includes("public.idx_rate_limit_reservation_id"));
  assert.ok(groups.column.includes("public.recruitment_settings.singleton_key"));
  assert.ok(groups.constraint.includes("public.recruitment_settings_singleton_key_unique"));
  assert.ok(
    groups.function.includes("public.reserve_rate_limit(text[],text[],integer[],integer[])"),
  );
  assert.ok(groups.type.includes("public.user_role"));
  assert.ok(groups.trigger.length > 0);
  assert.ok(!objects.some((object) => object.id === "admin-seed"));
});

test("CLI 입력 검사는 알 수 없는 인자와 잘못된 URL 을 접속 전에 거부한다", () => {
  assert.deepEqual(parseArguments([]), { allowRwRole: false });
  assert.deepEqual(parseArguments(["--allow-rw-role"]), { allowRwRole: true });
  assert.equal(parseArguments(["--apply"]), null);
  assert.equal(parseArguments(["--allow-rw-role", "--allow-rw-role"]), null);
  assert.equal(validDatabaseUrl("postgresql://u:p@db.example.invalid/hra"), true);
  assert.equal(validDatabaseUrl("https://db.example.invalid"), false);
  assert.equal(validDatabaseUrl(undefined), false);
});

test("Vercel 범위 보고서는 value 를 버리고 비밀값의 비운영 공유를 실패로 판정한다", () => {
  const result = analyzeEnvironmentScopes({
    envs: [
      {
        key: "DATABASE_URL",
        target: ["production", "preview"],
        type: "encrypted",
        value: "postgres://leak",
      },
      { key: "AUTH_SECRET", target: ["production"], type: "encrypted", value: "leak-secret" },
      { key: "AUTH_SECRET", target: ["preview"], type: "plain", value: "leak-preview" },
      { key: "SOMETHING_NEW", target: ["production"], type: "plain", value: "x" },
      { key: "bad key", target: ["production"], value: "x" },
    ],
  });
  const text = JSON.stringify(result);
  assert.ok(!text.includes("leak"));
  assert.equal(result.ok, false);
  assert.deepEqual(result.findings.map((f) => `${f.key}:${f.code}`).sort(), [
    "AUTH_SECRET:NONPROD_SECRET_PRESENT",
    "AUTH_SECRET:SECRET_NOT_ENCRYPTED",
    "DATABASE_URL:SHARED_SECRET_ACROSS_TARGETS",
    "SOMETHING_NEW:UNKNOWN_KEY",
  ]);
  assert.equal(result.counts.invalidKeys, 1);
  assert.equal(analyzeEnvironmentScopes({}).code, "INPUT_SHAPE");
  assert.equal(
    analyzeEnvironmentScopes({
      envs: [{ key: "DATABASE_URL", target: ["production"], type: "encrypted" }],
    }).ok,
    true,
  );
});

test("공개 Blob 접두사 보고서는 이전 스크립트와 같은 접두사를 쓰고 개수만 출력한다", async () => {
  const source = readFileSync(
    new URL("../migrate-protected-resource-blobs.mjs", import.meta.url),
    "utf8",
  );
  const declared = /const protectedPrefixes = \[([\s\S]*?)\];/
    .exec(source)[1]
    .match(/"[^"]+"/g)
    .map((item) => JSON.parse(item));
  assert.deepEqual(protectedPrefixes, declared);
  const calls = [];
  const list = async (options) => {
    calls.push(options);
    if (options.prefix === "guidebooks/" && !options.cursor)
      return {
        blobs: [{ url: leakUrl, pathname: "guidebooks/a.pdf", size: 10 }],
        hasMore: true,
        cursor: "c1",
      };
    if (options.prefix === "guidebooks/")
      return { blobs: [{ url: leakUrl, pathname: "guidebooks/b.pdf", size: 5 }], hasMore: false };
    return { blobs: [], hasMore: false };
  };
  const result = await countPublicPrefixes(list, "token");
  assert.equal(result.total, 2);
  assert.deepEqual(result.prefixes["guidebooks/"], { objects: 2, bytes: 15 });
  assert.equal(result.code, "PUBLIC_PROTECTED_OBJECTS_FOUND");
  assert.ok(
    !JSON.stringify(result).includes("blob.vercel-storage") &&
      !JSON.stringify(result).includes(".pdf"),
  );
  assert.ok(calls.every((options) => options.token === "token"));
  const empty = await countPublicPrefixes(async () => ({ blobs: [], hasMore: false }), "t");
  assert.equal(empty.ok, true);
});
