// @vitest-environment node
/**
 * #507 이메일 식별 규칙을 실제 Drizzle·Neon SDK와 소유 PostgreSQL에서 검증합니다.
 * 운영 환경 파일·DB·계정은 사용하지 않으며 seed도 격리 전송을 설치한 실제 자식으로 실행합니다.
 */
import { neon, neonConfig } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import { execFile, spawnSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { compare } from "bcryptjs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { createQaPostgres } from "../support/resource-qa-postgres.mjs";
import {
  createPsqlTransport,
  qaDatabaseUrl,
  qaNeonEndpoint,
} from "../support/neon-psql-transport.mjs";
import { exportQaSchemaSql } from "../support/qa-schema-export.mjs";

const mocks = vi.hoisted(() => {
  let database: NeonHttpDatabase<typeof schema> | undefined;
  return {
    get database() {
      return database;
    },
    set database(value: NeonHttpDatabase<typeof schema> | undefined) {
      database = value;
    },
  };
});
vi.mock("@/lib/db", () => ({
  get db() {
    if (!mocks.database) throw new Error("격리 DB 준비 전 호출");
    return mocks.database;
  },
}));

import { findCredentialUser } from "@/lib/auth-credentials";
import { createDrizzleSignInIO, handleOAuthSignIn } from "@/lib/auth-signin";

const bin = process.env.HRA_TEST_PG_BIN;
const execFileAsync = promisify(execFile);
const requireFromQa = createRequire(import.meta.url);
const first = "50700000-0000-4000-8000-000000000001";
const second = "50700000-0000-4000-8000-000000000002";
const input = (email: string | null, provider = "google", accountId = "Account-Mixed") => ({
  user: { name: "합성 회원", email, image: null },
  account: { provider, providerAccountId: accountId },
});

describe.skipIf(!bin)("이메일 식별 실제 PostgreSQL·seed 경계", () => {
  let cluster: ReturnType<typeof createQaPostgres>;
  let io: ReturnType<typeof createDrizzleSignInIO>;
  const previousFetch = neonConfig.fetchFunction;
  const previousEndpoint = neonConfig.fetchEndpoint;
  let sqlCalls = 0;
  let beforeEmailUpdate: (() => void) | undefined;
  let asynchronous = false;
  let writeGate: string | undefined;
  let transportModule: string;
  let asyncTransport: (
    payload: Parameters<ReturnType<typeof createPsqlTransport>>[0],
    gate?: string,
  ) => ReturnType<ReturnType<typeof createPsqlTransport>>;

  beforeAll(() => {
    cluster = createQaPostgres(bin);
    cluster.sql(exportQaSchemaSql());
    const transport = createPsqlTransport(cluster.environment);
    // 각 SDK 요청을 별도 Node 자식에서 기존 전송으로 실행해 부모 이벤트 루프를 막지 않습니다.
    // 공유 전송의 bindParameters·소유 표식·socket·DB identity 검사를 그대로 재사용합니다.
    transportModule = join(cluster.root, "async-transport.mjs");
    writeFileSync(
      transportModule,
      `
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {dirname,basename} from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createPsqlTransport} from ${JSON.stringify(new URL("../support/neon-psql-transport.mjs", import.meta.url).href)};
const environment=${JSON.stringify(cluster.environment)};
const execute=promisify(execFile),filename=fileURLToPath(import.meta.url);
export async function query(payload,gate){
 const running=execute(process.execPath,[filename,'--worker'],{env:{...environment,NODE_ENV:'test'},encoding:'utf8',timeout:10000,maxBuffer:8*1024*1024});
 running.child.stdin.end(JSON.stringify({payload,gate}));
 const response=JSON.parse((await running).stdout);
 if(response.error)throw Object.assign(new Error('격리 비동기 SQL 거부'),response.error);
 return response.result;
}
async function worker(){
 try{
  const transport=createPsqlTransport(environment);
  const {payload,gate}=JSON.parse(readFileSync(0,'utf8'));
  const verb=payload.query.trimStart().toLowerCase();
  if(gate&&(verb.startsWith('insert ')||verb.startsWith('update '))){
   if(dirname(gate)!==environment.HRA_RESOURCE_QA_ROOT||!/^auth507-gate-[a-f0-9-]{36}$/.test(basename(gate)))throw new Error('격리 barrier 거부');
   writeFileSync(gate+'.'+randomUUID()+'.ready','',{mode:0o600,flag:'wx'});
   const started=Date.now();
   while(!existsSync(gate+'.release')){if(Date.now()-started>3000)throw new Error('격리 barrier 기한');await delay(5)}
  }
  process.stdout.write(JSON.stringify({result:await transport(payload)}));
 }catch(error){process.stdout.write(JSON.stringify({error:{code:error.code||'QA_TRANSPORT_ERROR',...(error.constraint?{constraint:error.constraint}:{})}}))}
}
if(process.argv[1]===filename&&process.argv[2]==='--worker')void worker();
`,
      { mode: 0o600 },
    );
    const loaded: { query: typeof asyncTransport } = requireFromQa(transportModule);
    if (typeof loaded.query !== "function") throw new Error("격리 비동기 전송 준비 실패");
    asyncTransport = loaded.query;
    neonConfig.fetchEndpoint = qaNeonEndpoint;
    neonConfig.fetchFunction = async (address: unknown, options: RequestInit) => {
      if (
        String(address) !== qaNeonEndpoint ||
        options.method !== "POST" ||
        new Headers(options.headers).get("Neon-Connection-String") !== qaDatabaseUrl
      )
        throw new Error("외부 SQL 전송 차단");
      sqlCalls++;
      const payload = JSON.parse(String(options.body));
      if (/^update .*set "email"/i.test(payload.query) && beforeEmailUpdate) {
        const run = beforeEmailUpdate;
        beforeEmailUpdate = undefined;
        run();
      }
      try {
        return Response.json(
          await (asynchronous ? asyncTransport(payload, writeGate) : transport(payload)),
        );
      } catch (error) {
        return Response.json(
          {
            message: "격리 SQL 실행 거부",
            ...(error && typeof error === "object" && "code" in error ? { code: error.code } : {}),
            ...(error && typeof error === "object" && "constraint" in error
              ? { constraint: error.constraint }
              : {}),
          },
          { status: 400 },
        );
      }
    };
    const database = drizzle(neon(qaDatabaseUrl), { schema });
    mocks.database = database;
    io = createDrizzleSignInIO(database);
  }, 60_000);

  beforeEach(() => {
    cluster.sql(
      "DROP TRIGGER IF EXISTS auth507_pause ON public.users; DROP FUNCTION IF EXISTS public.auth507_pause(); DROP INDEX IF EXISTS public.users_email_identity_unique; TRUNCATE public.users CASCADE;",
    );
    sqlCalls = 0;
    beforeEmailUpdate = undefined;
    asynchronous = false;
    writeGate = undefined;
  });

  afterAll(() => {
    mocks.database = undefined;
    neonConfig.fetchFunction = previousFetch;
    neonConfig.fetchEndpoint = previousEndpoint;
    cluster?.close();
  });

  /** 기존 계정의 이메일·tuple·역할·해시·버전만 비교해 자동 승계/재작성 여부를 확인합니다. */
  const identities = () =>
    cluster.sql(
      "SELECT json_agg(row_to_json(value)) FROM (SELECT id,email,oauth_provider,oauth_provider_account_id,role,password_hash,session_version FROM public.users ORDER BY id) AS value;",
    );

  /** SQL은 검토 후보만 읽고 소유 fixture에 명시적으로 적용합니다. 운영 적용기가 아닙니다. */
  const applyCandidate = () =>
    cluster.sql(
      readFileSync(
        new URL("../../scripts/migrate-507-email-identity-unique.sql", import.meta.url),
        "utf8",
      ),
    );

  /** 별도 연결의 실제 경합 결과는 원문 오류 대신 성공 또는 SQLSTATE만 반환합니다. */
  const raceStatement = async (statement: string) => {
    try {
      await execFileAsync(
        join(bin!, "psql"),
        ["-X", "-q", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-c", statement],
        { env: { ...cluster.environment, NODE_ENV: "test" }, timeout: 10_000 },
      );
      return "ok";
    } catch (error) {
      const stderr =
        error && typeof error === "object" && "stderr" in error && typeof error.stderr === "string"
          ? error.stderr
          : "";
      return stderr.match(/ERROR:\s+([0-9A-Z]{5}):/)?.[1] ?? "unexpected";
    }
  };

  /** 두 실제 writer가 읽기·해시 준비를 마친 뒤 함께 SQL에 진입하도록 제어합니다. */
  const prepareRace = () => {
    writeGate = join(cluster.root, `auth507-gate-${randomUUID()}`);
    cluster.sql(
      "CREATE FUNCTION public.auth507_pause() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN PERFORM pg_sleep(0.5); RETURN NEW; END $$; CREATE TRIGGER auth507_pause BEFORE INSERT OR UPDATE ON public.users FOR EACH ROW EXECUTE FUNCTION public.auth507_pause();",
    );
    return writeGate;
  };

  /** 대기 실패 때도 release해 자식이 남지 않게 하며 assertion은 결과를 회수한 뒤 수행합니다. */
  const releaseWriters = async (gate: string) => {
    const prefix = gate.slice(gate.lastIndexOf("/") + 1) + ".";
    const started = Date.now();
    while (Date.now() - started < 2_000) {
      if (
        readdirSync(cluster.root).filter(
          (name) => name.startsWith(prefix) && name.endsWith(".ready"),
        ).length === 2
      )
        break;
      await delay(5);
    }
    const ready = readdirSync(cluster.root).filter(
      (name) => name.startsWith(prefix) && name.endsWith(".ready"),
    ).length;
    writeFileSync(gate + ".release", "", { mode: 0o600, flag: "wx" });
    return ready;
  };

  /** 소유 DB에서 동시에 잠든/잠금을 기다리는 서로 다른 backend 수만 계수합니다. */
  const observeOverlap = async (rowLock = false) => {
    let sample = { sleeping: 0, locking: 0, connections: 0 };
    const started = Date.now();
    while (Date.now() - started < 1_500) {
      const values = cluster
        .sql(
          "SELECT count(*) FILTER (WHERE wait_event='PgSleep') || '|' || count(*) FILTER (WHERE wait_event_type='Lock') || '|' || count(DISTINCT pid) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state='active' AND (wait_event='PgSleep' OR wait_event_type='Lock');",
        )
        .split("|")
        .map(Number);
      sample = { sleeping: values[0], locking: values[1], connections: values[2] };
      if (
        sample.connections >= 2 &&
        (rowLock ? sample.sleeping >= 1 && sample.locking >= 1 : sample.sleeping >= 2)
      )
        break;
      await delay(5);
    }
    return sample;
  };

  it("ASCII legacy 공백·대소문자는 동일 PG 식으로 찾고 두 행이면 거부한다", async () => {
    cluster.sql(
      `INSERT INTO public.users(id,name,email,role,password_hash,session_version) VALUES('${first}','합성 회원','  Legacy@Example.INVALID  ','ADMIN','synthetic-hash',7);`,
    );
    const found = await findCredentialUser(" LEGACY@example.invalid ");
    expect(found?.id).toBe(first);
    expect(found?.email).toBe("  Legacy@Example.INVALID  ");
    cluster.sql(
      `INSERT INTO public.users(id,name,email,role) VALUES('${second}','합성 회원','legacy@example.invalid','PENDING');`,
    );
    expect(await findCredentialUser("legacy@example.invalid")).toBeNull();
  });

  it("Google 신규 저장과 직접 어댑터 저장은 정규화하고 tuple 원문을 보존한다", async () => {
    const attempt = input("  Mixed@Example.INVALID  ");
    expect(await handleOAuthSignIn(attempt, io)).toBe(true);
    expect(
      cluster.sql(
        "SELECT email || '|' || oauth_provider_account_id || '|' || role FROM public.users",
      ),
    ).toBe("mixed@example.invalid|Account-Mixed|PENDING");
    expect(attempt.user.email).toBe("mixed@example.invalid");
    await io.insertNew({
      name: "합성 회원",
      email: "  Direct@Example.INVALID  ",
      role: "PENDING",
      oauthProvider: "kakao",
      oauthProviderAccountId: "Raw-Account",
    });
    expect(cluster.sql("SELECT email FROM public.users WHERE oauth_provider='kakao'")).toBe(
      "direct@example.invalid",
    );
  });

  it("같은 정규 주소의 로컬 계정은 OAuth로 바인딩·승격되지 않는다", async () => {
    cluster.sql(
      `INSERT INTO public.users(id,name,email,role,password_hash,session_version) VALUES('${first}','합성 회원',' Admin@Example.INVALID ','ADMIN','synthetic-hash',9);`,
    );
    const before = identities();
    expect(await handleOAuthSignIn(input("admin@example.invalid"), io)).toBe(
      "/login?error=OAuthAccountNotLinked",
    );
    expect(identities()).toBe(before);
  });

  it("미바인딩 OAuth의 legacy 중복은 임의 행 선택·새 생성 없이 거부한다", async () => {
    cluster.sql(
      `INSERT INTO public.users(id,name,email,role) VALUES('${first}','합성 회원','Member@Example.INVALID','MEMBER'),('${second}','합성 회원','member@example.invalid','PENDING');`,
    );
    const before = identities();
    expect(await handleOAuthSignIn(input(" MEMBER@example.invalid "), io)).toBe(
      "/login?error=OAuthAccountNotLinked",
    );
    expect(identities()).toBe(before);
  });

  it("이미 바인딩된 legacy 주소는 중복 검색에도 원문과 권한·버전을 유지한다", async () => {
    cluster.sql(
      `INSERT INTO public.users(id,name,email,role,oauth_provider,oauth_provider_account_id,session_version) VALUES('${first}','합성 회원','Legacy@Example.INVALID','MEMBER','google','Account-Mixed',11),('${second}','합성 회원','legacy@example.invalid','ADMIN',NULL,NULL,3);`,
    );
    const before = identities();
    const attempt = input("legacy@example.invalid");
    expect(await handleOAuthSignIn(attempt, io)).toBe(true);
    expect(attempt.user.email).toBe("Legacy@Example.INVALID");
    expect(identities()).toBe(before);
  });

  it("provider의 공백 이메일보다 기존 tuple을 우선하고 원문·권한을 보존한다", async () => {
    cluster.sql(
      `INSERT INTO public.users(id,name,email,role,password_hash,oauth_provider,oauth_provider_account_id,session_version) VALUES('${first}','합성 회원',' Legacy@Example.INVALID ','MEMBER','synthetic-hash','google','Account-Mixed',11);`,
    );
    const before = identities();
    const attempt = input("   ");
    expect(await handleOAuthSignIn(attempt, io)).toBe(true);
    expect(attempt.user.email).toBe(" Legacy@Example.INVALID ");
    expect(identities()).toBe(before);
  });

  it("Kakao 원문 검증 후 placeholder만 정규 주소로 승격한다", async () => {
    cluster.sql(
      `INSERT INTO public.users(id,name,email,role,oauth_provider,oauth_provider_account_id,session_version) VALUES('${first}','합성 회원','kakao_123@oauth.placeholder','MEMBER','kakao','123',12);`,
    );
    const attempt = {
      ...input("Verified@Example.INVALID", "kakao", "123"),
      profile: {
        kakao_account: {
          email: "Verified@Example.INVALID",
          is_email_valid: true,
          is_email_verified: true,
        },
      },
    };
    expect(await handleOAuthSignIn(attempt, io)).toBe(true);
    expect(
      cluster.sql("SELECT email || '|' || role || '|' || session_version FROM public.users"),
    ).toBe("verified@example.invalid|MEMBER|12");
    expect(attempt.user.email).toBe("verified@example.invalid");
  });

  it("대소문자만 다른 다른 계정 주소와 충돌하면 placeholder를 유지한다", async () => {
    cluster.sql(
      `INSERT INTO public.users(id,name,email,role,oauth_provider,oauth_provider_account_id,session_version) VALUES('${first}','합성 회원','kakao_123@oauth.placeholder','MEMBER','kakao','123',12),('${second}','합성 회원','Taken@Example.INVALID','ADMIN',NULL,NULL,2);`,
    );
    const before = identities();
    const attempt = {
      ...input("taken@example.invalid", "kakao", "123"),
      profile: {
        kakao_account: {
          email: "taken@example.invalid",
          is_email_valid: true,
          is_email_verified: true,
        },
      },
    };
    expect(await handleOAuthSignIn(attempt, io)).toBe(true);
    expect(identities()).toBe(before);
  });

  it("JS가 정규화한 신규 비ASCII 주소는 찾되 legacy NBSP·Unicode 차이는 숨기지 않는다", async () => {
    await io.insertNew({
      name: "합성 회원",
      email: "\u00a0İ@Example.INVALID\u00a0",
      role: "PENDING",
    });
    expect((await findCredentialUser("\u00a0İ@Example.INVALID\u00a0"))?.email).toBe(
      "i\u0307@example.invalid",
    );
    cluster.sql(
      `TRUNCATE public.users CASCADE; INSERT INTO public.users(id,name,email,role) VALUES('${first}','합성 회원',U&'\\00A0Legacy@Example.INVALID\\00A0','MEMBER');`,
    );
    expect(await findCredentialUser("\u00a0Legacy@Example.INVALID\u00a0")).toBeNull();
    expect(cluster.sql("SELECT (btrim(U&'\\00A0x\\00A0') = 'x')::text")).toBe("false");
    expect(cluster.sql("SELECT (btrim(E'\\tx\\t') = 'x')::text")).toBe("false");
    // fixture의 C locale도 JS의 Unicode lowercase와 같다고 가정하지 않습니다.
    expect(cluster.sql("SELECT (lower(U&'\\0130') = U&'i\\0307')::text")).toBe("false");
  });

  it("검토 후보는 기존 충돌을 병합하지 않고 원자적으로 거부한다", () => {
    cluster.sql(
      `INSERT INTO public.users(id,name,email,role) VALUES('${first}','합성 회원',' Dup@Example.INVALID ','ADMIN'),('${second}','합성 회원','dup@example.invalid','MEMBER');`,
    );
    // 기존 exact UNIQUE만으로는 두 행이 공존한다는 실제 DB 재현입니다.
    expect(cluster.sql("SELECT count(*) FROM public.users")).toBe("2");
    const before = identities();
    expect(applyCandidate).toThrow();
    expect(identities()).toBe(before);
    expect(
      cluster.sql("SELECT (to_regclass('public.users_email_identity_unique') IS NULL)::text"),
    ).toBe("true");
  });

  it("후보 UNIQUE는 동시 INSERT를 한 행만 허용하고 기존 exact UNIQUE를 남긴다", async () => {
    applyCandidate();
    const results = await Promise.all(
      [" Race@Example.INVALID ", "race@example.invalid"].map((email) =>
        raceStatement(
          `BEGIN; INSERT INTO public.users(name,email) VALUES('합성 회원','${email}'); SELECT pg_sleep(0.15); COMMIT;`,
        ),
      ),
    );
    expect(results.sort()).toEqual(["23505", "ok"]);
    expect(cluster.sql("SELECT count(*) FROM public.users")).toBe("1");
    expect(
      cluster.sql(
        "SELECT count(*) FROM pg_constraint WHERE conrelid='public.users'::regclass AND conname='users_email_unique'",
      ),
    ).toBe("1");
    const before = identities();
    // 동명 객체를 IF NOT EXISTS로 신뢰하지 않고 재실행도 검토 전에는 거부합니다.
    expect(applyCandidate).toThrow();
    expect(identities()).toBe(before);
  });

  it("후보 UNIQUE는 동시 UPDATE의 같은 식별키 승격도 한 행만 허용한다", async () => {
    cluster.sql(
      `INSERT INTO public.users(id,name,email,role) VALUES('${first}','합성 회원','first@example.invalid','MEMBER'),('${second}','합성 회원','second@example.invalid','PENDING');`,
    );
    applyCandidate();
    const results = await Promise.all(
      [
        [first, " Target@Example.INVALID "],
        [second, "target@example.invalid"],
      ].map(([id, email]) =>
        raceStatement(
          `BEGIN; UPDATE public.users SET email='${email}' WHERE id='${id}'; SELECT pg_sleep(0.15); COMMIT;`,
        ),
      ),
    );
    expect(results.sort()).toEqual(["23505", "ok"]);
    expect(
      cluster.sql(
        "SELECT count(*) FROM public.users WHERE lower(btrim(email))='target@example.invalid'",
      ),
    ).toBe("1");
    expect(cluster.sql("SELECT count(*) FROM public.users")).toBe("2");
  });

  it("OAuth 가입의 실제 연결 중첩은 하나의 PENDING row만 남긴다", async () => {
    applyCandidate();
    asynchronous = true;
    const gate = prepareRace();
    const pending = Promise.allSettled([
      handleOAuthSignIn(input("Same@Example.INVALID", "google", "First-Account"), io),
      handleOAuthSignIn(input(" same@example.invalid ", "kakao", "Second-Account"), io),
    ]);
    const ready = await releaseWriters(gate);
    const overlap = await observeOverlap();
    const settled = await pending;
    expect(ready).toBe(2);
    expect(overlap.sleeping).toBe(2);
    expect(overlap.connections).toBe(2);
    expect(settled.every((result) => result.status === "fulfilled")).toBe(true);
    const results = settled.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    expect(results.filter((value) => value === true)).toHaveLength(1);
    expect(results.filter((value) => value === "/login?error=OAuthAccountNotLinked")).toHaveLength(
      1,
    );
    expect(
      cluster.sql(
        "SELECT count(*) FROM public.users WHERE email='same@example.invalid' AND role='PENDING' AND password_hash IS NULL AND session_version=0",
      ),
    ).toBe("1");
    expect(
      cluster.sql("SELECT oauth_provider || '|' || oauth_provider_account_id FROM public.users"),
    ).toBe(results[0] === true ? "google|First-Account" : "kakao|Second-Account");
    console.info("AUTH507_CONCURRENCY", JSON.stringify({ kind: "oauth-signup", ...overlap }));
  });

  it("서로 다른 tuple의 실제 동시 승격은 이메일 하나만 바꾸고 권한·해시·버전을 보존한다", async () => {
    cluster.sql(
      `INSERT INTO public.users(id,name,email,role,password_hash,oauth_provider,oauth_provider_account_id,session_version) VALUES('${first}','합성 회원','kakao_123@oauth.placeholder','MEMBER','first-hash','kakao','123',7),('${second}','합성 회원','kakao_456@oauth.placeholder','FACULTY','second-hash','kakao','456',9);`,
    );
    const preserved = () =>
      cluster.sql(
        "SELECT json_agg(row_to_json(value)) FROM (SELECT id,role,password_hash,oauth_provider,oauth_provider_account_id,session_version FROM public.users ORDER BY id) AS value;",
      );
    const before = preserved();
    applyCandidate();
    asynchronous = true;
    const gate = prepareRace();
    const attempts = ["123", "456"].map((accountId) => ({
      ...input("Promote@Example.INVALID", "kakao", accountId),
      profile: {
        kakao_account: {
          email: "Promote@Example.INVALID",
          is_email_valid: true,
          is_email_verified: true,
        },
      },
    }));
    const pending = Promise.allSettled(attempts.map((attempt) => handleOAuthSignIn(attempt, io)));
    const ready = await releaseWriters(gate);
    const overlap = await observeOverlap();
    const settled = await pending;
    expect(ready).toBe(2);
    expect(overlap.sleeping).toBe(2);
    expect(overlap.connections).toBe(2);
    expect(settled.every((result) => result.status === "fulfilled" && result.value === true)).toBe(
      true,
    );
    expect(preserved()).toBe(before);
    expect(
      cluster.sql("SELECT count(*) FROM public.users WHERE email='promote@example.invalid'"),
    ).toBe("1");
    expect(
      cluster.sql("SELECT count(*) FROM public.users WHERE email LIKE '%@oauth.placeholder'"),
    ).toBe("1");
    expect(cluster.sql(`SELECT email FROM public.users WHERE id='${first}'`)).toBe(
      attempts[0].user.email,
    );
    expect(cluster.sql(`SELECT email FROM public.users WHERE id='${second}'`)).toBe(
      attempts[1].user.email,
    );
    console.info("AUTH507_CONCURRENCY", JSON.stringify({ kind: "oauth-promotion", ...overlap }));
  });

  it("Kakao 승격 직전 생긴 대소문자 충돌은 기존 placeholder·tuple·버전을 보존한다", async () => {
    cluster.sql(
      `INSERT INTO public.users(id,name,email,role,oauth_provider,oauth_provider_account_id,session_version) VALUES('${first}','합성 회원','kakao_123@oauth.placeholder','MEMBER','kakao','123',7);`,
    );
    applyCandidate();
    beforeEmailUpdate = () =>
      cluster.sql(
        `INSERT INTO public.users(id,name,email,role) VALUES('${second}','합성 회원','Race@Example.INVALID','ADMIN');`,
      );
    const attempt = {
      ...input("race@example.invalid", "kakao", "123"),
      profile: {
        kakao_account: {
          email: "race@example.invalid",
          is_email_valid: true,
          is_email_verified: true,
        },
      },
    };
    expect(await handleOAuthSignIn(attempt, io)).toBe(true);
    expect(attempt.user.email).toBe("kakao_123@oauth.placeholder");
    expect(
      cluster.sql(
        `SELECT email || '|' || role || '|' || session_version || '|' || oauth_provider_account_id FROM public.users WHERE id='${first}'`,
      ),
    ).toBe("kakao_123@oauth.placeholder|MEMBER|7|123");
  });

  it("승격 전에 주소가 바뀌면 CAS가 다른 주소를 덮어쓰지 않는다", async () => {
    cluster.sql(
      `INSERT INTO public.users(id,name,email,role,oauth_provider,oauth_provider_account_id,session_version) VALUES('${first}','합성 회원','kakao_123@oauth.placeholder','MEMBER','kakao','123',7);`,
    );
    beforeEmailUpdate = () =>
      cluster.sql(
        `UPDATE public.users SET email='concurrent@example.invalid' WHERE id='${first}';`,
      );
    const attempt = {
      ...input("verified@example.invalid", "kakao", "123"),
      profile: {
        kakao_account: {
          email: "verified@example.invalid",
          is_email_valid: true,
          is_email_verified: true,
        },
      },
    };
    expect(await handleOAuthSignIn(attempt, io)).toBe(true);
    expect(cluster.sql("SELECT email || '|' || session_version FROM public.users")).toBe(
      "concurrent@example.invalid|7",
    );
  });

  type SeedOptions = {
    changeBeforeUpdate?: "version" | "email";
    failQuery?: boolean;
    concurrent?: boolean;
    password?: string;
  };

  /** 동시 자식도 preload·계수 파일을 공유하지 않으며 소유 전송과 합성 환경만 받습니다. */
  const prepareSeed = (email: string, args: string[], options: SeedOptions = {}) => {
    const nonce = randomUUID();
    const preload = join(cluster.root, `seed-preload-${nonce}.mjs`);
    const countsFile = join(cluster.root, `seed-counts-${nonce}.json`);
    const password = options.password ?? "synthetic-password-only";
    if (options.concurrent && !writeGate) throw new Error("동시 seed barrier가 필요합니다.");
    writeFileSync(
      preload,
      `
import {neonConfig} from ${JSON.stringify(new URL("../../node_modules/@neondatabase/serverless/index.mjs", import.meta.url).href)};
import {createPsqlTransport,qaDatabaseUrl,qaNeonEndpoint} from ${JSON.stringify(new URL("../support/neon-psql-transport.mjs", import.meta.url).href)};
import {writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
const counts={sql:0,network:0,inserts:0,updates:0,updatedRows:0};process.on('exit',()=>writeFileSync(${JSON.stringify(countsFile)},JSON.stringify(counts),{mode:0o600}));
const transport=${options.concurrent ? `createRequire(import.meta.url)(${JSON.stringify(transportModule)}).query` : `createPsqlTransport(${JSON.stringify(cluster.environment)})`};
neonConfig.fetchEndpoint=qaNeonEndpoint;
neonConfig.fetchFunction=async(address,options)=>{
 if(String(address)!==qaNeonEndpoint||options.method!=='POST'||new Headers(options.headers).get('Neon-Connection-String')!==qaDatabaseUrl){counts.network++;throw new Error('외부 전송 거부')}
 const payload=JSON.parse(String(options.body)),verb=payload.query.trimStart().toUpperCase();
 counts.sql++;if(verb.startsWith('INSERT '))counts.inserts++;if(verb.startsWith('UPDATE '))counts.updates++;
 if(${Boolean(options.failQuery)}) throw new Error('SENSITIVE_SENTINEL');
 if(${JSON.stringify(options.changeBeforeUpdate ?? null)} && verb.startsWith('UPDATE USERS')) await transport({query:${JSON.stringify(options.changeBeforeUpdate === "email" ? "UPDATE public.users SET email='concurrent@example.invalid'" : "UPDATE public.users SET session_version=session_version+1")},params:[]});
 try{const result=await transport(payload,${options.concurrent ? JSON.stringify(writeGate) : "undefined"});if(verb.startsWith('UPDATE '))counts.updatedRows+=result.rowCount;return Response.json(result)}
 catch(error){return Response.json({message:'격리 SQL 거부',code:error.code,constraint:error.constraint},{status:400})}
};
globalThis.fetch=()=>{counts.network++;throw new Error('외부 전송 거부')};
`,
      { mode: 0o600 },
    );
    const environment: NodeJS.ProcessEnv = {
      NODE_ENV: "test",
      PATH: process.env.PATH,
      ...cluster.environment,
      TMPDIR: cluster.root,
      ADMIN_EMAIL: email,
      ADMIN_NAME: "합성 관리자 이름",
      ADMIN_PASSWORD: password,
    };
    return {
      args: [
        "--import",
        preload,
        new URL("../../scripts/seed-admin.mjs", import.meta.url).pathname,
        ...args,
      ],
      environment,
      countsFile,
      password,
    };
  };

  /** 결과 판정에는 exit·계수만 쓰고 자식 원문을 assertion이나 로그에 반사하지 않습니다. */
  const seedResult = (
    result: { status: number | null; stdout: string; stderr: string },
    prepared: ReturnType<typeof prepareSeed>,
    email: string,
  ) => {
    const counts = JSON.parse(readFileSync(prepared.countsFile, "utf8"));
    expect(counts.network).toBe(0);
    const output = result.stdout + result.stderr;
    return {
      status: result.status,
      sql: counts.sql,
      inserts: counts.inserts,
      updates: counts.updates,
      updatedRows: counts.updatedRows,
      privateOutputAbsent: ![
        email,
        email.trim().toLowerCase(),
        "합성 관리자 이름",
        prepared.password,
        qaDatabaseUrl,
        "SENSITIVE_SENTINEL",
        "SELECT",
        "INSERT",
        "UPDATE",
      ].some((value) => output.includes(value)),
    };
  };

  /** 기존 사례는 순차 실행·결정적 CAS 사전 변경 주입이며 genuine race와 구분합니다. */
  const seed = (
    email: string,
    args: string[],
    changeBeforeUpdate: "version" | "email" | undefined = undefined,
    failQuery = false,
  ) => {
    const prepared = prepareSeed(email, args, { changeBeforeUpdate, failQuery });
    const result = spawnSync(process.execPath, prepared.args, {
      cwd: cluster.root,
      env: prepared.environment,
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(Boolean(result.error)).toBe(false);
    return seedResult(result, prepared, email);
  };

  /** 별도 Node seed 둘을 동시에 실행하고 각 SDK 쿼리도 비동기 별도 연결로 보냅니다. */
  const seedAsync = async (email: string, args: string[], password: string) => {
    const prepared = prepareSeed(email, args, { concurrent: true, password });
    try {
      const result = await execFileAsync(process.execPath, prepared.args, {
        cwd: cluster.root,
        env: prepared.environment,
        encoding: "utf8",
        timeout: 20_000,
      });
      return seedResult({ status: 0, ...result }, prepared, email);
    } catch (error) {
      if (
        !error ||
        typeof error !== "object" ||
        !("code" in error) ||
        typeof error.code !== "number" ||
        !("stdout" in error) ||
        typeof error.stdout !== "string" ||
        !("stderr" in error) ||
        typeof error.stderr !== "string"
      )
        throw new Error("격리 seed 자식 완료 실패");
      return seedResult(
        { status: error.code, stdout: error.stdout, stderr: error.stderr },
        prepared,
        email,
      );
    }
  };

  it("seed 신규 생성은 정규 저장하고 출력에 이메일·이름·자격정보를 넣지 않는다", async () => {
    const result = seed("  Seed@Example.INVALID  ", ["--confirm-create"]);
    expect(result.status).toBe(0);
    expect(
      cluster.sql("SELECT email || '|' || role || '|' || session_version FROM public.users"),
    ).toBe("seed@example.invalid|ADMIN|0");
    expect(result.privateOutputAbsent).toBe(true);
    expect(
      await compare(
        "synthetic-password-only",
        cluster.sql("SELECT password_hash FROM public.users"),
      ),
    ).toBe(true);
  });

  it("seed 무확인·원문과 다른 승격 확인은 연결 전에 거부한다", () => {
    for (const args of [[], ["--confirm-promote=seed@example.invalid"]]) {
      const result = seed("Seed@Example.INVALID", args);
      expect(result.status).toBe(1);
      expect(result.sql).toBe(0);
    }
  });

  it("seed create는 대소문자가 다른 기존 계정을 승격하지 않는다", () => {
    cluster.sql(
      `INSERT INTO public.users(id,name,email,role,session_version) VALUES('${first}','합성 회원','Existing@Example.INVALID','MEMBER',4);`,
    );
    const before = identities();
    expect(seed("existing@example.invalid", ["--confirm-create"]).status).toBe(1);
    expect(identities()).toBe(before);
  });

  it("seed는 관리자 포함 legacy 중복을 선택하지 않는다", () => {
    cluster.sql(
      `INSERT INTO public.users(id,name,email,role) VALUES('${first}','합성 회원','Admin@Example.INVALID','ADMIN'),('${second}','합성 회원','admin@example.invalid','MEMBER');`,
    );
    const before = identities();
    expect(seed("Admin@Example.INVALID", ["--confirm-create"]).status).toBe(1);
    expect(identities()).toBe(before);
  });

  it("seed 명시 원문 확인은 기존 binding·표시 주소를 보존하고 버전만 한 번 올린다", () => {
    cluster.sql(
      `INSERT INTO public.users(id,name,email,role,oauth_provider,oauth_provider_account_id,session_version) VALUES('${first}','합성 회원','Legacy@Example.INVALID','MEMBER','google','Existing-Account',4);`,
    );
    const raw = " legacy@example.invalid ";
    expect(seed(raw, [`--confirm-promote=${raw}`]).status).toBe(0);
    expect(
      cluster.sql(
        "SELECT email || '|' || role || '|' || session_version || '|' || oauth_provider_account_id FROM public.users",
      ),
    ).toBe("Legacy@Example.INVALID|ADMIN|5|Existing-Account");
    expect(sqlCalls).toBe(0);
  });

  it("seed 조회 뒤 버전이 바뀌면 역할·비밀번호·binding을 덮어쓰지 않는다", () => {
    cluster.sql(
      `INSERT INTO public.users(id,name,email,role,password_hash,oauth_provider,oauth_provider_account_id,session_version) VALUES('${first}','합성 회원','Legacy@Example.INVALID','MEMBER','synthetic-hash','google','Existing-Account',4);`,
    );
    const raw = "legacy@example.invalid";
    expect(seed(raw, [`--confirm-promote=${raw}`], "version").status).toBe(1);
    expect(
      cluster.sql(
        "SELECT email || '|' || role || '|' || password_hash || '|' || session_version || '|' || oauth_provider_account_id FROM public.users",
      ),
    ).toBe("Legacy@Example.INVALID|MEMBER|synthetic-hash|5|Existing-Account");
  });

  it("seed 조회 뒤 이메일 식별키가 바뀌면 원래 확인으로 다른 주소를 승격하지 않는다", () => {
    cluster.sql(
      `INSERT INTO public.users(id,name,email,role,password_hash,session_version) VALUES('${first}','합성 회원','Legacy@Example.INVALID','MEMBER','synthetic-hash',4);`,
    );
    const raw = "legacy@example.invalid";
    expect(seed(raw, [`--confirm-promote=${raw}`], "email").status).toBe(1);
    expect(
      cluster.sql(
        "SELECT email || '|' || role || '|' || password_hash || '|' || session_version FROM public.users",
      ),
    ).toBe("concurrent@example.invalid|MEMBER|synthetic-hash|4");
  });

  it("seed DB 오류도 원문·이메일·자격정보 없는 일반 실패로 종료한다", () => {
    const result = seed("private-synthetic@example.invalid", ["--confirm-create"], undefined, true);
    expect(result.status).toBe(1);
    expect(result.privateOutputAbsent).toBe(true);
    expect(cluster.sql("SELECT count(*) FROM public.users")).toBe("0");
  });

  it("두 실제 seed 생성 자식이 겹쳐도 canonical ADMIN과 한 비밀번호만 저장한다", async () => {
    applyCandidate();
    const gate = prepareRace();
    const passwords = ["first-synthetic-password", "second-synthetic-password"];
    const pending = Promise.allSettled([
      seedAsync("Seed@Example.INVALID", ["--confirm-create"], passwords[0]),
      seedAsync(" seed@example.invalid ", ["--confirm-create"], passwords[1]),
    ]);
    const ready = await releaseWriters(gate);
    const overlap = await observeOverlap();
    const settled = await pending;
    expect(ready).toBe(2);
    expect(overlap.sleeping).toBe(2);
    expect(overlap.connections).toBe(2);
    expect(settled.every((result) => result.status === "fulfilled")).toBe(true);
    const results = settled.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    expect(results.map((result) => result.status).sort()).toEqual([0, 1]);
    expect(results.map((result) => result.inserts)).toEqual([1, 1]);
    expect(results.every((result) => result.privateOutputAbsent)).toBe(true);
    expect(
      cluster.sql(
        "SELECT count(*) FROM public.users WHERE email='seed@example.invalid' AND role='ADMIN' AND session_version=0 AND oauth_provider IS NULL AND oauth_provider_account_id IS NULL",
      ),
    ).toBe("1");
    const hash = cluster.sql("SELECT password_hash FROM public.users");
    const winner = results.findIndex((result) => result.status === 0);
    expect(await compare(passwords[winner], hash)).toBe(true);
    expect(await compare(passwords[1 - winner], hash)).toBe(false);
    console.info("AUTH507_CONCURRENCY", JSON.stringify({ kind: "seed-create", ...overlap }));
  });

  it("같은 row의 실제 seed 승격은 연결·row lock이 겹쳐도 CAS 한 번만 확정한다", async () => {
    cluster.sql(
      `INSERT INTO public.users(id,name,email,role,password_hash,oauth_provider,oauth_provider_account_id,session_version) VALUES('${first}','합성 회원','Legacy@Example.INVALID','MEMBER','initial-hash','google','Existing-Account',4);`,
    );
    applyCandidate();
    const gate = prepareRace();
    const emails = ["Legacy@Example.INVALID", " legacy@example.invalid "];
    const passwords = ["first-synthetic-password", "second-synthetic-password"];
    const pending = Promise.allSettled(
      emails.map((email, index) =>
        seedAsync(email, [`--confirm-promote=${email}`], passwords[index]),
      ),
    );
    const ready = await releaseWriters(gate);
    const overlap = await observeOverlap(true);
    const settled = await pending;
    expect(ready).toBe(2);
    expect(overlap.sleeping).toBe(1);
    expect(overlap.locking).toBe(1);
    expect(overlap.connections).toBe(2);
    expect(settled.every((result) => result.status === "fulfilled")).toBe(true);
    const results = settled.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    expect(results.map((result) => result.status).sort()).toEqual([0, 1]);
    expect(results.map((result) => result.updates)).toEqual([1, 1]);
    expect(results.map((result) => result.updatedRows).sort()).toEqual([0, 1]);
    expect(results.every((result) => result.privateOutputAbsent)).toBe(true);
    expect(cluster.sql("SELECT count(*) FROM public.users")).toBe("1");
    expect(
      cluster.sql(
        "SELECT id || '|' || email || '|' || role || '|' || session_version || '|' || oauth_provider || '|' || oauth_provider_account_id FROM public.users",
      ),
    ).toBe(`${first}|Legacy@Example.INVALID|ADMIN|5|google|Existing-Account`);
    const hash = cluster.sql("SELECT password_hash FROM public.users");
    const winner = results.findIndex((result) => result.status === 0);
    expect(await compare(passwords[winner], hash)).toBe(true);
    expect(await compare(passwords[1 - winner], hash)).toBe(false);
    console.info("AUTH507_CONCURRENCY", JSON.stringify({ kind: "seed-promotion", ...overlap }));
  });
});
