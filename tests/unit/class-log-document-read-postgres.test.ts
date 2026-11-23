// @vitest-environment node
/**
 * 임시 PostgreSQL에 문서 저장 SQL을 적용하고 실제 이력과 확정 파일 조회를 검증합니다.
 * 기존 일지, 이전 버전의 파일과 참조 없는 파일을 합성 데이터로 비교합니다.
 */
import { readFileSync } from "node:fs";
import { neon, neonConfig } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  findClassLogDocumentDownload,
  findClassLogDocumentSummaries,
  findClassLogDocumentHistory,
} from "@/features/class-logs/documents/read-repository";
import {
  createPsqlTransport,
  qaDatabaseUrl,
  qaNeonEndpoint,
} from "../support/neon-psql-transport.mjs";
import { createQaPostgres } from "../support/resource-qa-postgres.mjs";

const mocks = vi.hoisted(() => ({ db: undefined as NeonHttpDatabase | undefined }));
vi.mock("@/lib/db", () => ({
  get db() {
    return mocks.db;
  },
}));

const classLogId = "20000000-0000-4000-8000-000000000001";
const legacyId = "20000000-0000-4000-8000-000000000002";
const cohort = "10000000-0000-4000-8000-000000000001";
const firstPdf = "30000000-0000-4000-8000-000000000001";
const nextPdf = "30000000-0000-4000-8000-000000000002";
const hangul = "30000000-0000-4000-8000-000000000003";
const orphan = "30000000-0000-4000-8000-000000000004";
const bin = process.env.HRA_TEST_PG_BIN;

describe.skipIf(!bin)("수업일지 문서 읽기 계약", () => {
  let cluster: ReturnType<typeof createQaPostgres>;
  const previousFetch = neonConfig.fetchFunction;
  const previousEndpoint = neonConfig.fetchEndpoint;

  beforeAll(() => {
    cluster = createQaPostgres(bin);
    cluster.sql(`
      CREATE TABLE public.class_logs (
        id uuid PRIMARY KEY, cohort_id uuid NOT NULL, class_date timestamp NOT NULL
      );
      INSERT INTO public.class_logs VALUES
        ('${classLogId}', '${cohort}', '2026-11-19 15:00:00'),
        ('${legacyId}', '${cohort}', '2026-11-26 15:00:00');
    `);
    cluster.sql(
      readFileSync(
        new URL("../../scripts/migrate-class-log-documents.sql", import.meta.url),
        "utf8",
      ),
    );
    cluster.sql(`
      BEGIN;
      INSERT INTO public.class_log_document_records (class_log_id, cohort_id, class_day, week_number)
      VALUES ('${classLogId}', '${cohort}', '2026-11-20', 9);
      INSERT INTO public.class_log_document_files
        (id, class_log_id, format, byte_size, file_name, storage_key, uploaded_at)
      VALUES
        ('${firstPdf}', '${classLogId}', 'PDF', 12, '이전.pdf',
          'class-log-documents/${firstPdf}/original', '2026-11-24 09:00:00+09'),
        ('${nextPdf}', '${classLogId}', 'PDF', 13, '최신.pdf',
          'class-log-documents/${nextPdf}/original', '2026-11-25 09:00:00+09'),
        ('${hangul}', '${classLogId}', 'HWPX', 24, '합성.hwpx',
          'class-log-documents/${hangul}/original', '2026-11-24 09:00:00+09'),
        ('${orphan}', '${classLogId}', 'HWP', 30, '참조 없음.hwp',
          'class-log-documents/${orphan}/original', '2026-11-25 09:00:00+09');
      INSERT INTO public.class_log_document_revisions
        (class_log_id, version, pdf_file_id, hangul_file_id, change_note, created_at)
      VALUES
        ('${classLogId}', 1, '${firstPdf}', '${hangul}', NULL, '2026-11-24 09:01:00+09'),
        ('${classLogId}', 2, '${nextPdf}', '${hangul}', 'PDF 교체', '2026-11-25 09:01:00+09');
      COMMIT;
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
      return Response.json(await transport(JSON.parse(String(options.body))));
    };
    mocks.db = drizzle(neon(qaDatabaseUrl));
  }, 30_000);

  afterAll(() => {
    neonConfig.fetchFunction = previousFetch;
    neonConfig.fetchEndpoint = previousEndpoint;
    cluster?.close();
  });

  it("허용된 일지 목록에 최신 PDF와 한글 형식만 표시합니다", async () => {
    expect(await findClassLogDocumentSummaries([classLogId, legacyId])).toEqual([
      { classLogId, weekNumber: 9, pdf: true, hangul: "HWPX" },
    ]);
    expect(await findClassLogDocumentSummaries([legacyId])).toEqual([]);
    expect(await findClassLogDocumentSummaries([])).toEqual([]);
  });

  it("시간과 버전별 파일 표시 정보만 최신 순서로 반환합니다", async () => {
    expect(await findClassLogDocumentHistory(classLogId)).toEqual({
      weekNumber: 9,
      classDay: "2026-11-20",
      revisions: [
        {
          version: 2,
          changeNote: "PDF 교체",
          createdAt: "2026-11-25T00:01:00.000Z",
          pdf: {
            id: nextPdf,
            format: "PDF",
            byteSize: 13,
            fileName: "최신.pdf",
            uploadedAt: "2026-11-25T00:00:00.000Z",
          },
          hangul: {
            id: hangul,
            format: "HWPX",
            byteSize: 24,
            fileName: "합성.hwpx",
            uploadedAt: "2026-11-24T00:00:00.000Z",
          },
        },
        {
          version: 1,
          changeNote: null,
          createdAt: "2026-11-24T00:01:00.000Z",
          pdf: {
            id: firstPdf,
            format: "PDF",
            byteSize: 12,
            fileName: "이전.pdf",
            uploadedAt: "2026-11-24T00:00:00.000Z",
          },
          hangul: {
            id: hangul,
            format: "HWPX",
            byteSize: 24,
            fileName: "합성.hwpx",
            uploadedAt: "2026-11-24T00:00:00.000Z",
          },
        },
      ],
    });
    expect(await findClassLogDocumentHistory(legacyId)).toBeNull();
  });

  it("이전 버전의 원본은 읽을 수 있고 확정 버전에 연결되지 않은 원본은 제외합니다", async () => {
    expect(await findClassLogDocumentDownload(firstPdf)).toEqual({
      fileName: "이전.pdf",
      byteSize: 12,
      format: "PDF",
      storageKey: `class-log-documents/${firstPdf}/original`,
    });
    expect(await findClassLogDocumentDownload(orphan)).toBeNull();
    expect(await findClassLogDocumentDownload(legacyId)).toBeNull();
  });
});
