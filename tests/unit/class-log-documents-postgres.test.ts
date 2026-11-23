// @vitest-environment node
/**
 * 수업일지 문서 additive SQL의 기존 데이터 호환성과 불변 제약을 검증합니다.
 * 환경 파일이나 운영 서비스 없이 격리 PostgreSQL에서 실제 스키마에 SQL을 적용합니다.
 */
import { execFile } from "node:child_process";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportQaSchemaSql } from "../support/qa-schema-export.mjs";
import { createQaPostgres } from "../support/resource-qa-postgres.mjs";

const bin = process.env.HRA_TEST_PG_BIN;
const cohort = "10000000-0000-4000-8000-000000000001";
const oldCohort = "10000000-0000-4000-8000-000000000002";
const oldLog = "20000000-0000-4000-8000-000000000001";
const documentLog = "20000000-0000-4000-8000-000000000002";
const otherLog = "20000000-0000-4000-8000-000000000003";
const pdf = "30000000-0000-4000-8000-000000000001";
const hangul = "30000000-0000-4000-8000-000000000002";
const otherPdf = "30000000-0000-4000-8000-000000000003";
const rejectedFile = "30000000-0000-4000-8000-000000000004";

describe.skipIf(!bin)("수업일지 원본과 수정본 PostgreSQL 계약", () => {
  let cluster: ReturnType<typeof createQaPostgres> | undefined;
  let migration: string;
  let baseSchema: string;

  /** 준비된 격리 클러스터에서만 SQL을 실행합니다. */
  function sql(statement: string) {
    if (!cluster) throw new Error("격리 DB를 준비하지 못했습니다.");
    return cluster.sql(statement);
  }

  /** 테스트용 SQLSTATE를 DB에서 확인하고, 계약이 어긋나면 격리 SQL 실행을 실패시킵니다. */
  function rejects(statement: string, sqlState: "23503" | "23505" | "23514") {
    sql(`
      DO $guard$
      BEGIN
        ${statement};
        RAISE EXCEPTION '예상한 제약 위반이 발생하지 않았습니다.';
      EXCEPTION WHEN SQLSTATE '${sqlState}' THEN
        NULL;
      END;
      $guard$;
    `);
  }

  /** 첫 세션이 행을 등록한 뒤 두 번째 세션이 실제 잠금 대기에 들어가는지 확인합니다. */
  async function verifyDuplicateRace(first: string, second: string) {
    if (!bin || !cluster) throw new Error("격리 DB를 준비하지 못했습니다.");
    const environment: NodeJS.ProcessEnv = {
      ...cluster.environment,
      LC_ALL: "C",
      NODE_ENV: "test",
    };
    const psql = join(bin, "psql");
    const args = ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"];
    const options = { env: environment, timeout: 8_000, encoding: "utf8" as const };
    const loserName = "class_log_documents_race_loser";
    const firstResult = Promise.withResolvers<string>();
    const firstSession = execFile(psql, args, options, (error) => {
      firstResult.resolve(error ? "error" : "committed");
    });
    let ready = false;
    firstSession.stdout?.on("data", (value: Buffer) => {
      if (value.toString().includes("READY")) ready = true;
    });
    firstSession.stdin?.write(`BEGIN; ${first}; SELECT 'READY';
`);
    let secondResult: Promise<string> | undefined;
    try {
      for (let attempt = 0; attempt < 60 && !ready; attempt++) await delay(25);
      expect(ready).toBe(true);
      secondResult = new Promise<string>((resolve) => {
        const secondSession = execFile(
          psql,
          args,
          { ...options, env: { ...environment, PGAPPNAME: loserName } },
          (error, _stdout, stderr) =>
            resolve(!error ? "committed" : /ERROR:\s+23505:/.test(stderr) ? "duplicate" : "error"),
        );
        secondSession.stdin?.end(`BEGIN; ${second}; COMMIT;
`);
      });
      let waiting = false;
      for (let attempt = 0; attempt < 60 && !waiting; attempt++) {
        waiting =
          sql(`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE application_name = '${loserName}' AND wait_event_type = 'Lock'
        )`) === "t";
        if (!waiting) await delay(25);
      }
      expect(waiting).toBe(true);
      firstSession.stdin?.end("COMMIT;\n");
      expect(await Promise.all([firstResult.promise, secondResult])).toEqual([
        "committed",
        "duplicate",
      ]);
    } finally {
      if (firstSession.stdin?.writable) firstSession.stdin.end();
      await Promise.all([firstResult.promise, secondResult]);
    }
  }

  beforeAll(() => {
    migration = readFileSync(
      new URL("../../scripts/migrate-class-log-documents.sql", import.meta.url),
      "utf8",
    );
    cluster = createQaPostgres(bin);
    baseSchema = exportQaSchemaSql();
    sql(baseSchema);
    sql(`
      INSERT INTO cohorts (id, name) VALUES ('${cohort}', '문서 시험 기수'), ('${oldCohort}', '기존 시험 기수');
      INSERT INTO class_logs (id, title, content, class_date, cohort_id) VALUES
        ('${oldLog}', '기존 제목', '기존 본문', '2026-11-20 07:15', '${oldCohort}'),
        ('${documentLog}', '문서 일지', '문서 본문', '2026-11-19 15:00', '${cohort}'),
        ('${otherLog}', '다른 일지', '다른 본문', '2026-11-26 15:00', '${cohort}');
      INSERT INTO class_log_images (class_log_id, url, alt)
        VALUES ('${oldLog}', 'https://synthetic.invalid/photo.png', '기존 사진');
    `);
    sql(migration);
    sql(`
      BEGIN;
      INSERT INTO class_log_document_records (class_log_id, cohort_id, class_day, week_number) VALUES
        ('${documentLog}', '${cohort}', '2026-11-20', 1),
        ('${otherLog}', '${cohort}', '2026-11-27', 2);
      INSERT INTO class_log_document_files (id, class_log_id, format, byte_size, file_name, storage_key) VALUES
        ('${pdf}', '${documentLog}', 'PDF', 12, '시험.pdf', 'class-log-documents/${pdf}/original'),
        ('${hangul}', '${documentLog}', 'HWPX', 24, '시험.hwpx', 'class-log-documents/${hangul}/original'),
        ('${otherPdf}', '${otherLog}', 'PDF', 36, '다른.pdf', 'class-log-documents/${otherPdf}/original');
      INSERT INTO class_log_document_revisions (class_log_id, version, pdf_file_id, hangul_file_id, change_note) VALUES
        ('${documentLog}', 1, '${pdf}', NULL, NULL),
        ('${documentLog}', 2, '${pdf}', '${hangul}', '한글본 추가'),
        ('${otherLog}', 1, '${otherPdf}', NULL, NULL);
      COMMIT;
    `);
  }, 60_000);

  afterAll(() => cluster?.close());

  it("기존 본문·사진을 보존하고 기존 방식의 본문 및 사진 편집을 허용한다", () => {
    expect(
      sql(`
      SELECT l.title, l.content, l.class_date, i.alt FROM class_logs l JOIN class_log_images i ON i.class_log_id = l.id
      WHERE l.id = '${oldLog}';
    `),
    ).toBe("기존 제목|기존 본문|2026-11-20 07:15:00|기존 사진");
    expect(
      sql(`
      BEGIN;
      UPDATE class_logs SET title = '편집 제목', content = '편집 본문', class_date = '2026-11-21 07:15'
        WHERE id = '${oldLog}';
      UPDATE class_log_images SET alt = '편집 사진' WHERE class_log_id = '${oldLog}';
      UPDATE class_logs SET content = '문서 일지 본문 편집' WHERE id = '${documentLog}';
      DELETE FROM cohorts WHERE id = '${oldCohort}';
      SELECT l.title, l.content, l.cohort_id IS NULL, i.alt FROM class_logs l JOIN class_log_images i ON i.class_log_id = l.id
        WHERE l.id = '${oldLog}';
      ROLLBACK;
    `),
    ).toContain("편집 제목|편집 본문|t|편집 사진");
  });

  it("1차 PDF를 유지하면서 2차에 한글 원본을 추가하고 버전 건너뛰기와 중복을 막는다", () => {
    expect(
      sql(`
      SELECT version, pdf_file_id, hangul_file_id FROM class_log_document_revisions
      WHERE class_log_id = '${documentLog}' ORDER BY version;
    `),
    ).toBe(`1|${pdf}|\n2|${pdf}|${hangul}`);
    rejects(
      `
      INSERT INTO class_log_document_revisions (class_log_id, version, pdf_file_id, change_note)
        VALUES ('${documentLog}', 4, '${pdf}', '건너뛴 버전')
    `,
      "23503",
    );
    rejects(
      `
      INSERT INTO class_log_document_revisions (class_log_id, version, pdf_file_id, change_note)
        VALUES ('${documentLog}', 2, '${pdf}', '중복 버전')
    `,
      "23505",
    );
  });

  it("1차 수정본이 없는 문서 레코드의 커밋을 거부하고 전체 트랜잭션을 되돌린다", () => {
    expect(() =>
      sql(`
      BEGIN;
      UPDATE class_logs SET class_date = '2026-12-03 15:00', cohort_id = '${cohort}' WHERE id = '${oldLog}';
      INSERT INTO class_log_document_records (class_log_id, cohort_id, class_day, week_number)
        VALUES ('${oldLog}', '${cohort}', '2026-12-04', 3);
      COMMIT;
    `),
    ).toThrow();
    expect(sql(`SELECT class_date FROM class_logs WHERE id = '${oldLog}';`)).toBe(
      "2026-11-20 07:15:00",
    );
    expect(
      sql(`SELECT count(*) FROM class_log_document_records WHERE class_log_id = '${oldLog}';`),
    ).toBe("0");
  });

  it("동일 기수·수업일·주차를 다른 수업일지에 중복 부여할 수 없다", () => {
    rejects(
      `
      UPDATE class_logs SET class_date = '2026-11-19 15:00', cohort_id = '${cohort}' WHERE id = '${oldLog}';
      INSERT INTO class_log_document_records (class_log_id, cohort_id, class_day, week_number)
        VALUES ('${oldLog}', '${cohort}', '2026-11-20', 1)
    `,
      "23505",
    );
  });

  it.each([
    ["다른 일지의 PDF", `'${otherPdf}', NULL`, "23503"],
    ["PDF 칸의 한글 파일", `'${hangul}', NULL`, "23503"],
    ["한글 칸의 PDF", `NULL, '${pdf}'`, "23503"],
    ["원본 없는 수정본", "NULL, NULL", "23514"],
  ] as const)("%s 참조를 거부한다", (_label, slots, sqlState) => {
    rejects(
      `
      INSERT INTO class_log_document_revisions (class_log_id, version, pdf_file_id, hangul_file_id, change_note)
        VALUES ('${documentLog}', 3, ${slots}, '제약 시험')
    `,
      sqlState,
    );
  });

  it("파일 ID와 불일치하는 저장 키를 거부한다", () => {
    rejects(
      `
      INSERT INTO class_log_document_files (id, class_log_id, format, byte_size, file_name, storage_key)
        VALUES ('${rejectedFile}', '${documentLog}', 'PDF', 12, '시험.pdf', 'class-log-documents/${pdf}/original')
    `,
      "23514",
    );
  });

  it.each([
    ["수업일지 삭제", `DELETE FROM class_logs WHERE id = '${documentLog}'`, "23503"],
    [
      "수업일시 변경",
      `UPDATE class_logs SET class_date = '2026-11-20 15:00' WHERE id = '${documentLog}'`,
      "23503",
    ],
    [
      "기수 변경",
      `UPDATE class_logs SET cohort_id = '${oldCohort}' WHERE id = '${documentLog}'`,
      "23503",
    ],
    ["기수 삭제", `DELETE FROM cohorts WHERE id = '${cohort}'`, "23503"],
    [
      "주차 변경",
      `UPDATE class_log_document_records SET week_number = 3 WHERE class_log_id = '${documentLog}'`,
      "23514",
    ],
    [
      "수정본 삭제",
      `DELETE FROM class_log_document_revisions WHERE class_log_id = '${documentLog}' AND version = 2`,
      "23514",
    ],
    [
      "수정본 변경",
      `UPDATE class_log_document_revisions SET change_note = '변경' WHERE class_log_id = '${documentLog}' AND version = 2`,
      "23514",
    ],
    [
      "원본 변경",
      `UPDATE class_log_document_files SET byte_size = 99 WHERE id = '${pdf}'`,
      "23514",
    ],
    ["참조 원본 삭제", `DELETE FROM class_log_document_files WHERE id = '${pdf}'`, "23503"],
  ] as const)("문서를 보존하기 위해 %s 작업을 거부한다", (_label, statement, sqlState) => {
    rejects(statement, sqlState);
  });

  it("SQL 재적용 실패 후 기존 레코드와 수정본이 유지된다", () => {
    const counts = `
      SELECT (SELECT count(*) FROM class_log_document_records),
             (SELECT count(*) FROM class_log_document_files),
             (SELECT count(*) FROM class_log_document_revisions);
    `;
    const before = sql(counts);
    expect(() => sql(migration)).toThrow("격리 PostgreSQL psql 실행 실패");
    expect(sql(counts)).toBe(before);
  });

  it("수업일지가 없는 새 스키마에도 문서 테이블 세 개를 설치한다", () => {
    const fresh = createQaPostgres(bin);
    try {
      fresh.sql(baseSchema);
      fresh.sql(migration);
      expect(
        fresh.sql(`
        SELECT (SELECT count(*) FROM class_logs),
               (SELECT count(*) FROM class_log_document_records),
               (SELECT count(*) FROM class_log_document_files),
               (SELECT count(*) FROM class_log_document_revisions);
      `),
      ).toBe("0|0|0|0");
    } finally {
      fresh.close();
    }
  }, 30_000);

  it("같은 문서 식별자를 두 세션에서 등록하면 한 세션만 모두 커밋한다", async () => {
    const winnerLog = "20000000-0000-4000-8000-000000000004";
    const loserLog = "20000000-0000-4000-8000-000000000005";
    const winnerFile = "30000000-0000-4000-8000-000000000005";
    const loserFile = "30000000-0000-4000-8000-000000000006";
    const register = (logId: string, fileId: string) => `
      INSERT INTO class_logs (id, title, content, class_date, cohort_id)
        VALUES ('${logId}', '경합 일지', '경합 본문', '2026-12-03 15:00', '${cohort}');
      INSERT INTO class_log_document_records (class_log_id, cohort_id, class_day, week_number)
        VALUES ('${logId}', '${cohort}', '2026-12-04', 3);
      INSERT INTO class_log_document_files (id, class_log_id, format, byte_size, file_name, storage_key)
        VALUES ('${fileId}', '${logId}', 'PDF', 12, '경합.pdf', 'class-log-documents/${fileId}/original');
      INSERT INTO class_log_document_revisions (class_log_id, version, pdf_file_id)
        VALUES ('${logId}', 1, '${fileId}')`;
    await verifyDuplicateRace(register(winnerLog, winnerFile), register(loserLog, loserFile));
    expect(
      sql(`
      SELECT r.class_log_id, f.id, v.version FROM class_log_document_records r
        JOIN class_log_document_files f ON f.class_log_id = r.class_log_id
        JOIN class_log_document_revisions v ON v.class_log_id = r.class_log_id AND v.pdf_file_id = f.id
      WHERE r.cohort_id = '${cohort}' AND r.class_day = '2026-12-04' AND r.week_number = 3;
    `),
    ).toBe(`${winnerLog}|${winnerFile}|1`);
    expect(
      sql(`
      SELECT (SELECT count(*) FROM class_logs WHERE id = '${loserLog}'),
             (SELECT count(*) FROM class_log_document_records WHERE class_log_id = '${loserLog}'),
             (SELECT count(*) FROM class_log_document_files WHERE id = '${loserFile}'),
             (SELECT count(*) FROM class_log_document_revisions WHERE class_log_id = '${loserLog}');
    `),
    ).toBe("0|0|0|0");
  }, 15_000);

  it("같은 수정본 버전을 두 세션에서 등록하면 패자의 새 원본도 되돌린다", async () => {
    const winnerFile = "30000000-0000-4000-8000-000000000007";
    const loserFile = "30000000-0000-4000-8000-000000000008";
    const revise = (fileId: string) => `
      INSERT INTO class_log_document_files (id, class_log_id, format, byte_size, file_name, storage_key)
        VALUES ('${fileId}', '${otherLog}', 'PDF', 48, '경합.pdf', 'class-log-documents/${fileId}/original');
      INSERT INTO class_log_document_revisions (class_log_id, version, pdf_file_id, change_note)
        VALUES ('${otherLog}', 2, '${fileId}', '원본 PDF 수정')`;
    await verifyDuplicateRace(revise(winnerFile), revise(loserFile));
    expect(
      sql(`
      SELECT pdf_file_id FROM class_log_document_revisions
      WHERE class_log_id = '${otherLog}' AND version = 2;
    `),
    ).toBe(winnerFile);
    expect(sql(`SELECT count(*) FROM class_log_document_files WHERE id = '${loserFile}';`)).toBe(
      "0",
    );
  }, 15_000);

  it("중간 DDL에서 이름이 충돌하면 앞서 만든 테이블과 제약까지 되돌린다", () => {
    const partial = createQaPostgres(bin);
    try {
      partial.sql(baseSchema);
      partial.sql("CREATE TABLE public.class_log_document_revisions (sentinel integer);");
      expect(() => partial.sql(migration)).toThrow("격리 PostgreSQL psql 실행 실패");
      expect(
        partial.sql(`
        SELECT to_regclass('public.class_log_document_records') IS NULL,
               to_regclass('public.class_log_document_files') IS NULL,
               NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'class_logs_document_identity_key');
      `),
      ).toBe("t|t|t");
    } finally {
      partial.close();
    }
  }, 30_000);
});
