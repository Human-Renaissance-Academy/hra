// @vitest-environment node
/**
 * 교수진 관리자 저장소의 정렬·기본값·사진 동시 변경·멱등 삭제를 격리 PostgreSQL에서 검증합니다.
 * 실제 Neon SQL은 소유 임시 클러스터로만 전달하고 외부 통신은 차단합니다.
 */
import { neon, neonConfig } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { createQaPostgres } from "../support/resource-qa-postgres.mjs";
import {
  createPsqlTransport,
  qaDatabaseUrl,
  qaNeonEndpoint,
} from "../support/neon-psql-transport.mjs";

const mocks = vi.hoisted(() => {
  const state: { database: NeonHttpDatabase<typeof schema> | undefined } = { database: undefined };
  return state;
});
vi.mock("@/lib/db", () => ({
  get db() {
    if (!mocks.database) throw new Error("격리 DB 준비 전 호출");
    return mocks.database;
  },
}));
vi.mock("@/lib/server-upload-intent", () => ({ uploadWithOwnedIntent: vi.fn() }));
import * as repository from "@/features/faculty/admin/repository";
import {
  createAdminFaculty,
  deleteAdminFaculty,
  listAdminFaculty,
} from "@/features/faculty/admin/service";
const bin = process.env.HRA_TEST_PG_BIN;
const actor = { userId: "admin-1", role: "ADMIN" };
const id = "81000000-0000-4000-8000-000000000001";
// #161 검토 권한 기록의 실제 RESTRICT FK 검증용 합성 계정·수업입니다.
const reviewIds = {
  manager: "81000000-0000-4000-8000-0000000000a1",
  linked: "81000000-0000-4000-8000-0000000000a2",
  cohort: "81000000-0000-4000-8000-0000000000b1",
  event: "81000000-0000-4000-8000-0000000000c1",
};
const values = {
  name: "수정 교수",
  category: "CLASSICS" as const,
  currentPosition: null,
  formerPosition: null,
  order: 0,
  imageUrl: "https://fixture.invalid/request.png",
};

describe.skipIf(!bin)("교수진 관리자 실제 PostgreSQL 경계", () => {
  let cluster: ReturnType<typeof createQaPostgres>;
  const previousFetch = neonConfig.fetchFunction;
  const previousEndpoint = neonConfig.fetchEndpoint;
  beforeAll(() => {
    cluster = createQaPostgres(bin);
    cluster.sql(`CREATE TYPE faculty_category AS ENUM ('CLASSICS','BUSINESS','LECTURE');
      CREATE TABLE faculty (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name varchar(100) NOT NULL,
        category faculty_category NOT NULL, current_position text, former_position text,
        image_url text, "order" integer NOT NULL DEFAULT 0,
        created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now()
      );
      CREATE TABLE users (id uuid PRIMARY KEY, role text NOT NULL);
      CREATE TABLE cohorts (id uuid PRIMARY KEY);
      CREATE TABLE schedule_events (id uuid PRIMARY KEY);
      CREATE TABLE schedule_sessions (id uuid PRIMARY KEY, schedule_event_id uuid NOT NULL REFERENCES schedule_events(id));
      CREATE TABLE assignments (id uuid PRIMARY KEY, cohort_id uuid NOT NULL, schedule_event_id uuid, schedule_session_id uuid,
        title varchar(200) NOT NULL, status text NOT NULL, due_at timestamptz);
      INSERT INTO users VALUES ('${reviewIds.manager}','MEMBER'),('${reviewIds.linked}','FACULTY');
      INSERT INTO cohorts VALUES ('${reviewIds.cohort}'); INSERT INTO schedule_events VALUES ('${reviewIds.event}');`);
    // #161 교수 검토 권한 SQL(선행: #165)을 그대로 설치해 교수 프로필 RESTRICT FK를 재현합니다.
    cluster.sql(readFileSync("scripts/migrate-academic-staff-assignments.sql", "utf8"));
    cluster.sql(readFileSync("scripts/migrate-academic-faculty-reviewers.sql", "utf8"));
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
      } catch (error) {
        // 실제 SQLSTATE·제약명만 Neon 오류 응답으로 전달합니다.
        const fields =
          error && typeof error === "object"
            ? (error as { code?: unknown; constraint?: unknown })
            : {};
        return Response.json(
          { message: "격리 SQL 실행 거부", code: fields.code, constraint: fields.constraint },
          { status: 400 },
        );
      }
    };
    mocks.database = drizzle(neon(qaDatabaseUrl), { schema });
  }, 30_000);
  beforeEach(() => {
    // 검토 권한 기록 표는 보호 트리거가 비우기를 막으므로 이 격리 DB에서만 트리거를 끄고 함께 비웁니다.
    cluster.sql(`SET session_replication_role = replica;
      TRUNCATE academic_faculty_review_events, academic_faculty_account_links, academic_class_reviewer_designations, faculty;
      SET session_replication_role = origin;`);
  });
  afterAll(() => {
    neonConfig.fetchFunction = previousFetch;
    neonConfig.fetchEndpoint = previousEndpoint;
    mocks.database = undefined;
    cluster?.close();
  });

  it("목록은 순서 오름차순 뒤 이름 오름차순을 유지한다", async () => {
    // 준비: 이름과 순서의 기준이 다른 세 행입니다.
    cluster.sql(`INSERT INTO faculty(name,category,"order") VALUES
      ('나 교수','CLASSICS',2),('가 교수','BUSINESS',2),('다 교수','LECTURE',1)`);
    // 실행: 실제 service·repository를 통과합니다.
    const rows = await listAdminFaculty(actor);
    // 확인: 정렬과 다섯 표시 열만 남습니다.
    expect(rows.map((row) => row.name)).toEqual(["다 교수", "가 교수", "나 교수"]);
    expect(Object.keys(rows[0])).toEqual([
      "id",
      "name",
      "category",
      "currentPosition",
      "formerPosition",
    ]);
  });

  it("생성은 null 직함·사진과 순서 0 및 DB 생성 기본값을 유지한다", async () => {
    // 준비·실행: adapter가 검증한 이미지 없는 입력입니다.
    await createAdminFaculty(actor, {
      name: "합성 교수",
      category: "CLASSICS",
      order: 0,
      directImageUrl: null,
      image: undefined,
    });
    // 확인: 실제 저장 행의 기본값입니다.
    expect(
      cluster.sql(`SELECT name,category,current_position IS NULL,former_position IS NULL,
      image_url IS NULL,"order",id IS NOT NULL,created_at IS NOT NULL,updated_at IS NOT NULL FROM faculty`),
    ).toBe("합성 교수|CLASSICS|t|t|t|0|t|t|t");
  });

  it.each([null, "https://fixture.invalid/old.png"])(
    "이전 사진 %s 조회 후 다른 관리자가 교체하면 수정하지 않는다",
    async (imageUrl) => {
      // 준비: 조회 이후 다른 연결이 사진을 바꾼 상황입니다.
      cluster.sql(`INSERT INTO faculty(id,name,category,image_url) VALUES
      ('${id}','원래 교수','CLASSICS',${imageUrl === null ? "NULL" : `'${imageUrl}'`})`);
      const existing = await repository.getExistingImage(id);
      if (!existing) throw new Error("합성 행 준비 실패");
      cluster.sql(
        `UPDATE faculty SET image_url='https://fixture.invalid/concurrent.png' WHERE id='${id}'`,
      );
      // 실행: 이전 URL 조건으로 실제 UPDATE를 실행합니다.
      const updated = await repository.updateFacultyRow(id, values, existing.imageUrl);
      // 확인: 타 관리자의 사진과 원래 이름이 보존됩니다.
      expect(updated).toBe(false);
      expect(cluster.sql(`SELECT name,image_url FROM faculty WHERE id='${id}'`)).toBe(
        "원래 교수|https://fixture.invalid/concurrent.png",
      );
    },
  );

  it.each([null, "https://fixture.invalid/old.png"])(
    "이전 사진 %s 조건이 일치하면 수정한다",
    async (imageUrl) => {
      // 준비: 현재 사진이 변경되지 않은 행입니다.
      cluster.sql(`INSERT INTO faculty(id,name,category,image_url) VALUES
      ('${id}','원래 교수','CLASSICS',${imageUrl === null ? "NULL" : `'${imageUrl}'`})`);
      // 실행: 실제 조건부 UPDATE입니다.
      expect(await repository.updateFacultyRow(id, values, imageUrl)).toBe(true);
      // 확인: 사진과 입력이 저장됩니다.
      expect(cluster.sql(`SELECT name,image_url FROM faculty WHERE id='${id}'`)).toBe(
        "수정 교수|https://fixture.invalid/request.png",
      );
    },
  );

  it("이미 삭제한 ID를 다시 삭제해도 성공한다", async () => {
    // 준비: 첫 삭제를 완료한 행입니다.
    cluster.sql(`INSERT INTO faculty(id,name,category) VALUES('${id}','합성 교수','CLASSICS')`);
    await repository.deleteFacultyRow(id);
    // 실행·확인: 같은 ID의 재삭제는 멱등한 명령입니다.
    await expect(repository.deleteFacultyRow(id)).resolves.toBeUndefined();
    expect(cluster.sql("SELECT count(*) FROM faculty")).toBe("0");
  });

  it.each(["연결", "지정"])(
    "#161 검토 권한 %s 기록이 있는 교수는 삭제하지 않고 고정 안내를 반환한다",
    async (kind) => {
      // 준비: 소유 역할의 직접 INSERT로 실제 FK가 있는 연결 또는 검토자 지정 행을 만듭니다.
      cluster.sql(`INSERT INTO faculty(id,name,category) VALUES('${id}','검토 교수','CLASSICS')`);
      cluster.sql(
        kind === "연결"
          ? `INSERT INTO academic_faculty_account_links (faculty_id,user_id,valid_from,verification_method,evidence_reference,verified_by_user_id)
         VALUES ('${id}','${reviewIds.linked}',now(),'IN_PERSON',gen_random_uuid(),'${reviewIds.manager}')`
          : `INSERT INTO academic_class_reviewer_designations (faculty_id,schedule_event_id,valid_from,designated_by_user_id)
         VALUES ('${id}','${reviewIds.event}',now(),'${reviewIds.manager}')`,
      );
      // 실행: 실제 service·repository 삭제입니다.
      const result = await deleteAdminFaculty(actor, id);
      // 확인: 원본 오류 없이 안내하며 교수와 검토 권한 기록이 보존됩니다.
      expect(result).toEqual({
        success: false,
        message: "학사 검토 권한 기록이 연결된 교수는 삭제할 수 없습니다.",
      });
      expect(JSON.stringify(result)).not.toMatch(/academic_|23503|23001/);
      expect(cluster.sql(`SELECT count(*) FROM faculty WHERE id='${id}'`)).toBe("1");
      expect(
        cluster.sql(
          `SELECT (SELECT count(*) FROM academic_faculty_account_links)+(SELECT count(*) FROM academic_class_reviewer_designations)`,
        ),
      ).toBe("1");
    },
  );

  it("검토 권한과 무관한 참조 오류는 안내로 바꾸지 않고 그대로 전달한다", async () => {
    // 준비: 이름이 다른 RESTRICT FK가 교수를 참조합니다.
    cluster.sql(`INSERT INTO faculty(id,name,category) VALUES('${id}','참조 교수','CLASSICS');
      CREATE TABLE unrelated_faculty_links (faculty_id uuid CONSTRAINT unrelated_faculty_fk REFERENCES faculty(id) ON DELETE RESTRICT);
      INSERT INTO unrelated_faculty_links VALUES ('${id}');`);
    try {
      // 실행·확인: 알려진 제약이 아니므로 Web 어댑터의 정제 로그 경계로 오류가 전달됩니다.
      await expect(deleteAdminFaculty(actor, id)).rejects.toBeDefined();
      expect(cluster.sql(`SELECT count(*) FROM faculty WHERE id='${id}'`)).toBe("1");
    } finally {
      cluster.sql("DROP TABLE unrelated_faculty_links");
    }
  });
});
