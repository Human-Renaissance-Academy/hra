// @vitest-environment node
/**
 * 주차별 텍스트 기수 열람 범위(#441)를 소유 PostgreSQL에서 모든 열람 경로에 대해 검증합니다.
 *
 * - MEMBER는 DB에 배정된 본인 기수 텍스트만 열람하고, 다른 기수·기수 미지정 텍스트와 기수 미배정 계정은 404(없는 자료)입니다.
 * - FACULTY·ADMIN은 전체 기수를 열람합니다. PENDING은 기존처럼 조회 전에 거부합니다.
 * - 경로: Web 통합 목록(`/resources`), Web 상세·제목·인쇄, Web 다운로드(첨부·사진), API v1 목록·상세·파일.
 * - 수업일지(class logs)는 기수와 무관한 공동 자료로 남는지 함께 확인합니다.
 * 합성 사용자·자료만 사용하고 Neon 요청은 임시 Unix 소켓으로 한정하며 Blob 공급자는 mock입니다.
 */
import { neon, neonConfig } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import { PgDialect } from "drizzle-orm/pg-core";
import { existsSync } from "node:fs";
import type { get } from "@vercel/blob";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { projectBlobHost } from "@/lib/blob-host";
import { createQaPostgres } from "../support/resource-qa-postgres.mjs";
import {
  createPsqlTransport,
  qaDatabaseUrl,
  qaNeonEndpoint,
} from "../support/neon-psql-transport.mjs";

const mocks = vi.hoisted(() => ({
  database: undefined as NeonHttpDatabase<typeof schema> | undefined,
  get: vi.fn(),
  requireReader: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({
  get db() {
    if (!mocks.database) throw new Error("격리 DB 준비 전 호출");
    return mocks.database;
  },
}));
vi.mock("@vercel/blob", () => ({ get: mocks.get }));
vi.mock("@/lib/resource-access", () => ({ requireSharedResourceReader: mocks.requireReader }));
// 조회 빈도 제한(#444)은 이 파일의 관심사가 아니므로 항상 허용합니다.
vi.mock("@/lib/rate-limit", () => ({
  reserveResourceRead: async () => ({ blocked: false, retryAfterSec: 0, reservationId: null }),
}));

import { GET as downloadRoute } from "@/app/api/resources/[kind]/[id]/download/route";
import { loadResourcesOverviewRows } from "@/features/resources/overview/repository";
import { ResourceFileError } from "@/features/resources/file-download/service";
import { weeklyTextReadFilter } from "@/features/weekly-texts/access";
import {
  downloadWeeklyTextFile,
  getWeeklyTextForMember,
  listWeeklyTextsForMember,
} from "@/features/weekly-texts/member/service";
import {
  getWebWeeklyTextDetail,
  getWebWeeklyTextPrintable,
  getWebWeeklyTextTitle,
} from "@/features/weekly-texts/web/service";

const bin = process.env.HRA_TEST_PG_BIN;
const cohorts = {
  a: "84000000-0000-4000-8000-00000000000a",
  b: "84000000-0000-4000-8000-00000000000b",
};
const users = {
  memberA: "84000000-0000-4000-8000-000000000001",
  memberB: "84000000-0000-4000-8000-000000000002",
  memberNone: "84000000-0000-4000-8000-000000000003",
  faculty: "84000000-0000-4000-8000-000000000004",
  admin: "84000000-0000-4000-8000-000000000005",
  pending: "84000000-0000-4000-8000-000000000006",
};
const texts = {
  a: "86000000-0000-4000-8000-00000000000a",
  b: "86000000-0000-4000-8000-00000000000b",
  none: "86000000-0000-4000-8000-00000000000c",
};
const images = {
  a: "87000000-0000-4000-8000-00000000000a",
  b: "87000000-0000-4000-8000-00000000000b",
};
const logs = {
  a: "88000000-0000-4000-8000-00000000000a",
  b: "88000000-0000-4000-8000-00000000000b",
};
const blobUrl = (name: string) => `https://${projectBlobHost}/weekly-texts/${name}`;
const allTexts = [texts.a, texts.b, texts.none].sort();

type Approved = "ADMIN" | "FACULTY" | "MEMBER";
const actors: Record<
  "memberA" | "memberB" | "memberNone" | "faculty" | "admin",
  { id: string; role: Approved }
> = {
  memberA: { id: users.memberA, role: "MEMBER" },
  memberB: { id: users.memberB, role: "MEMBER" },
  memberNone: { id: users.memberNone, role: "MEMBER" },
  faculty: { id: users.faculty, role: "FACULTY" },
  admin: { id: users.admin, role: "ADMIN" },
};
// 각 주체가 열람할 수 있어야 하는 텍스트 ID(정렬)입니다.
const expected: Record<keyof typeof actors, string[]> = {
  memberA: [texts.a],
  memberB: [texts.b],
  memberNone: [],
  faculty: allTexts,
  admin: allTexts,
};

/** 설치된 SDK의 200 응답 형식을 충족하는 합성 Blob 결과입니다. 외부 요청을 만들지 않습니다. */
function blobResult(url: string, contentType: string) {
  return {
    statusCode: 200,
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("QA"));
        controller.close();
      },
    }),
    headers: new Headers({ "Content-Type": contentType }),
    blob: {
      url,
      downloadUrl: url,
      pathname: new URL(url).pathname.slice(1),
      contentDisposition: "attachment",
      cacheControl: "private, no-store",
      uploadedAt: new Date("2026-11-01T00:00:00Z"),
      etag: '"qa"',
      contentType,
      size: 2,
    },
  } as Awaited<ReturnType<typeof get>>;
}

/** Web 다운로드 경로를 실제 Route로 호출하고 상태만 반환합니다. 본문은 정리합니다. */
async function download(
  actor: { id: string; role: string },
  kind: string,
  id: string,
): Promise<number> {
  mocks.requireReader.mockResolvedValueOnce({ user: actor });
  const response = await downloadRoute(new Request("http://localhost"), {
    params: Promise.resolve({ kind, id }),
  });
  await response.body?.cancel();
  return response.status;
}

describe.skipIf(!bin)("주차별 텍스트 기수 열람 범위(#441) 실제 PostgreSQL 경계", () => {
  let cluster: ReturnType<typeof createQaPostgres> | undefined;
  const previousFetch = neonConfig.fetchFunction;
  const previousEndpoint = neonConfig.fetchEndpoint;

  beforeAll(() => {
    cluster = createQaPostgres(bin);
    cluster.sql(`
      CREATE TYPE user_role AS ENUM ('ADMIN','FACULTY','MEMBER','PENDING');
      CREATE TABLE cohorts (id uuid PRIMARY KEY, name varchar(100) NOT NULL);
      CREATE TABLE users (
        id uuid PRIMARY KEY, name varchar(100) NOT NULL, email varchar(255) NOT NULL,
        role user_role NOT NULL, cohort_id uuid REFERENCES cohorts(id), image text
      );
      CREATE TABLE weekly_texts (
        id uuid PRIMARY KEY, title varchar(300) NOT NULL, file_url text NOT NULL DEFAULT '', file_name varchar(500),
        body text, cohort_id uuid REFERENCES cohorts(id), text_type varchar(20), class_date timestamp,
        created_at timestamp NOT NULL
      );
      CREATE TABLE weekly_text_images (
        id uuid PRIMARY KEY, weekly_text_id uuid NOT NULL REFERENCES weekly_texts(id), url text NOT NULL,
        alt varchar(255), "order" integer NOT NULL DEFAULT 0, created_at timestamp NOT NULL DEFAULT now()
      );
      CREATE TABLE class_logs (
        id uuid PRIMARY KEY, title varchar(300) NOT NULL, class_date timestamp NOT NULL,
        cohort_id uuid REFERENCES cohorts(id), author_id uuid REFERENCES users(id), created_at timestamp NOT NULL
      );
      CREATE TABLE class_materials (
        id uuid PRIMARY KEY, title varchar(300) NOT NULL, audience varchar(20) NOT NULL DEFAULT 'STUDENT',
        week_number integer, lecture_title varchar(200), uploaded_by_id uuid REFERENCES users(id),
        class_date timestamp, created_at timestamp NOT NULL
      );
      CREATE TABLE guidebooks (id uuid PRIMARY KEY, title varchar(300) NOT NULL, created_at timestamp NOT NULL);
      CREATE TABLE report_templates (
        id uuid PRIMARY KEY, slug varchar(200) NOT NULL, title varchar(300) NOT NULL, category varchar(20) NOT NULL,
        published boolean NOT NULL DEFAULT true, "order" integer NOT NULL DEFAULT 0, created_at timestamp NOT NULL
      );
      INSERT INTO cohorts(id,name) VALUES ('${cohorts.a}','합성 A기'),('${cohorts.b}','합성 B기');
      INSERT INTO users(id,name,email,role,cohort_id) VALUES
        ('${users.memberA}','합성 A기 회원','a@fixture.invalid','MEMBER','${cohorts.a}'),
        ('${users.memberB}','합성 B기 회원','b@fixture.invalid','MEMBER','${cohorts.b}'),
        ('${users.memberNone}','합성 미배정 회원','none@fixture.invalid','MEMBER',NULL),
        ('${users.faculty}','합성 교수','faculty@fixture.invalid','FACULTY',NULL),
        ('${users.admin}','합성 관리자','admin@fixture.invalid','ADMIN',NULL),
        ('${users.pending}','합성 대기','pending@fixture.invalid','PENDING','${cohorts.a}');
      INSERT INTO weekly_texts(id,title,file_url,file_name,body,cohort_id,text_type,class_date,created_at) VALUES
        ('${texts.a}','A기 텍스트','${blobUrl("a.pdf")}','a.pdf','# A','${cohorts.a}','고전명작','2026-10-03 00:00:00','2026-10-01 09:00:00'),
        ('${texts.b}','B기 텍스트','${blobUrl("b.pdf")}','b.pdf','# B','${cohorts.b}','경영서','2026-10-04 00:00:00','2026-10-01 09:00:00'),
        ('${texts.none}','기수 미지정 텍스트','${blobUrl("none.pdf")}','none.pdf','# 공통',NULL,NULL,NULL,'2026-10-02 09:00:00');
      INSERT INTO weekly_text_images(id,weekly_text_id,url) VALUES
        ('${images.a}','${texts.a}','${blobUrl("a.png")}'),
        ('${images.b}','${texts.b}','${blobUrl("b.png")}');
      INSERT INTO class_logs(id,title,class_date,cohort_id,author_id,created_at) VALUES
        ('${logs.a}','A기 일지','2026-10-03 00:00:00','${cohorts.a}',NULL,'2026-10-03 09:00:00'),
        ('${logs.b}','B기 일지','2026-10-04 00:00:00','${cohorts.b}',NULL,'2026-10-04 09:00:00');
    `);

    const transport = createPsqlTransport(cluster.environment);
    neonConfig.fetchEndpoint = qaNeonEndpoint;
    neonConfig.fetchFunction = async (input: unknown, options: RequestInit) => {
      if (
        String(input) !== qaNeonEndpoint ||
        options.method !== "POST" ||
        new Headers(options.headers).get("Neon-Connection-String") !== qaDatabaseUrl
      ) {
        throw new Error("격리 SQL 범위 이외 요청 차단");
      }
      try {
        return Response.json(await transport(JSON.parse(String(options.body))));
      } catch {
        return Response.json(
          { message: "격리 SQL 실행 거부", code: "QA_TRANSPORT_ERROR" },
          { status: 400 },
        );
      }
    };
    mocks.database = drizzle(neon(qaDatabaseUrl), { schema });
  }, 30_000);

  afterAll(() => {
    neonConfig.fetchFunction = previousFetch;
    neonConfig.fetchEndpoint = previousEndpoint;
    mocks.database = undefined;
    const ownedRoot = cluster?.root;
    cluster?.close();
    if (ownedRoot) expect(existsSync(ownedRoot)).toBe(false);
  });

  beforeEach(() => {
    mocks.get.mockReset();
    mocks.requireReader.mockReset();
    mocks.get.mockImplementation(async (url: string) =>
      blobResult(url, url.endsWith(".png") ? "image/png" : "application/pdf"),
    );
  });

  it.each(Object.keys(actors) as (keyof typeof actors)[])(
    "%s: Web 통합 목록·API v1 목록은 열람 범위의 텍스트만 반환하고 수업일지는 기수와 무관하다",
    async (name) => {
      const actor = actors[name];
      const overview = await loadResourcesOverviewRows(actor);
      expect(overview.weeklyTexts.map((row) => row.id).sort()).toEqual(expected[name]);
      // 수업일지는 #100 공동 자료로 남아 모든 승인 주체가 두 기수의 일지를 모두 봅니다.
      expect(overview.logs.map((row) => row.id).sort()).toEqual([logs.a, logs.b]);

      const list = await listWeeklyTextsForMember({
        principal: { userId: actor.id, role: actor.role },
        page: 1,
        pageSize: 10,
      });
      expect(list.kind).toBe("ok");
      if (list.kind !== "ok") return;
      expect(list.totalCount).toBe(expected[name].length);
      expect(list.items.map((item) => item.id).sort()).toEqual(expected[name]);
    },
  );

  it.each(Object.keys(actors) as (keyof typeof actors)[])(
    "%s: Web 상세·제목·인쇄·다운로드와 API v1 상세·파일은 범위 밖 텍스트를 없는 자료(404)로 처리한다",
    async (name) => {
      const actor = actors[name];
      for (const textId of allTexts) {
        const allowed = expected[name].includes(textId);

        expect((await getWebWeeklyTextTitle(actor, textId)) !== null).toBe(allowed);
        expect((await getWebWeeklyTextDetail(actor, textId)) !== null).toBe(allowed);
        expect((await getWebWeeklyTextPrintable(actor, textId)) !== null).toBe(allowed);
        expect(await download(actor, "weekly-texts", textId)).toBe(allowed ? 200 : 404);

        const detail = await getWeeklyTextForMember({ userId: actor.id, role: actor.role }, textId);
        expect(detail.kind).toBe(allowed ? "ok" : "not_found");

        mocks.get.mockClear();
        const file = downloadWeeklyTextFile({ userId: actor.id, role: actor.role }, textId);
        if (allowed) {
          const response = await file;
          expect(response.status).toBe(200);
          await response.body?.cancel();
        } else {
          await expect(file).rejects.toEqual(new ResourceFileError("NOT_FOUND"));
          // 범위 밖이면 저장소 원본을 읽지 않습니다.
          expect(mocks.get).not.toHaveBeenCalled();
        }
      }

      // 첨부 사진은 소속 텍스트의 기수 범위를 그대로 따릅니다.
      expect(await download(actor, "weekly-text-images", images.a)).toBe(
        expected[name].includes(texts.a) ? 200 : 404,
      );
      expect(await download(actor, "weekly-text-images", images.b)).toBe(
        expected[name].includes(texts.b) ? 200 : 404,
      );
    },
  );

  it("기수 판정은 세션 값이 아니라 조회 시점의 현재 계정 행을 따른다", async () => {
    cluster?.sql(`UPDATE users SET cohort_id='${cohorts.b}' WHERE id='${users.memberA}';`);
    try {
      expect(await getWebWeeklyTextDetail(actors.memberA, texts.a)).toBeNull();
      expect(await getWebWeeklyTextDetail(actors.memberA, texts.b)).not.toBeNull();
    } finally {
      cluster?.sql(`UPDATE users SET cohort_id='${cohorts.a}' WHERE id='${users.memberA}';`);
    }
  });

  it("PENDING은 기존처럼 조회 전에 거부하고, 식별자 없는 주체·알 수 없는 역할은 SQL에서도 거짓이다", async () => {
    expect(
      await listWeeklyTextsForMember({
        principal: { userId: users.pending, role: "PENDING" },
        page: 1,
        pageSize: 10,
      }),
    ).toEqual({ kind: "forbidden" });
    expect(
      await getWeeklyTextForMember({ userId: users.pending, role: "PENDING" }, texts.a),
    ).toEqual({ kind: "forbidden" });
    await expect(
      downloadWeeklyTextFile({ userId: users.pending, role: "PENDING" }, texts.a),
    ).rejects.toEqual(new ResourceFileError("FORBIDDEN"));
    expect(
      await getWebWeeklyTextDetail({ id: users.pending, role: "PENDING" }, texts.a),
    ).toBeNull();

    const rendered = (filter: ReturnType<typeof weeklyTextReadFilter>) =>
      new PgDialect().sqlToQuery(filter).sql;
    expect(rendered(weeklyTextReadFilter({ id: users.pending, role: "PENDING" }))).toBe("false");
    expect(rendered(weeklyTextReadFilter({ role: "ADMIN" }))).toBe("false");
    expect(rendered(weeklyTextReadFilter(null))).toBe("false");
  });
});
