/**
 * 확정된 수업일지의 버전 이력과 다운로드용 파일 정보를 조회합니다.
 * 공개 DTO에 사용하는 쿼리에는 저장소 좌표를 선택하지 않습니다.
 */
import "server-only";

import { sql } from "drizzle-orm";
import { db } from "@/lib/db";

export type ClassLogDocumentFile = {
  id: string;
  format: "PDF" | "HWP" | "HWPX";
  byteSize: number;
  fileName: string;
  uploadedAt: string;
};

type Revision = {
  version: number;
  changeNote: string | null;
  createdAt: string;
  pdf: ClassLogDocumentFile | null;
  hangul: ClassLogDocumentFile | null;
};

export type ClassLogDocumentHistory = {
  weekNumber: number;
  classDay: string;
  revisions: Revision[];
};

type HistoryRow = Revision & Omit<ClassLogDocumentHistory, "revisions">;

type DownloadRow = Pick<ClassLogDocumentFile, "fileName" | "byteSize" | "format"> & {
  storageKey: string;
};

/** 기존 일지 ID로 조회하고, 최신 버전부터 각 시점의 두 파일 슬롯을 반환합니다. */
export async function findClassLogDocumentHistory(
  classLogId: string,
): Promise<ClassLogDocumentHistory | null> {
  const { rows } = await db.execute<HistoryRow>(sql`
    SELECT record.week_number AS "weekNumber",
           to_char(record.class_day, 'YYYY-MM-DD') AS "classDay",
           revision.version, revision.change_note AS "changeNote",
           to_json(revision.created_at) #>> '{}' AS "createdAt",
           CASE WHEN pdf.id IS NOT NULL THEN json_build_object(
             'id', pdf.id, 'format', pdf.format, 'byteSize', pdf.byte_size,
             'fileName', pdf.file_name, 'uploadedAt', pdf.uploaded_at
           ) END AS pdf,
           CASE WHEN hangul.id IS NOT NULL THEN json_build_object(
             'id', hangul.id, 'format', hangul.format, 'byteSize', hangul.byte_size,
             'fileName', hangul.file_name, 'uploadedAt', hangul.uploaded_at
           ) END AS hangul
    FROM public.class_log_document_records AS record
    JOIN public.class_log_document_revisions AS revision
      ON revision.class_log_id = record.class_log_id
    LEFT JOIN public.class_log_document_files AS pdf
      ON pdf.class_log_id = record.class_log_id AND pdf.id = revision.pdf_file_id
    LEFT JOIN public.class_log_document_files AS hangul
      ON hangul.class_log_id = record.class_log_id AND hangul.id = revision.hangul_file_id
    WHERE record.class_log_id = ${classLogId}::uuid
    ORDER BY revision.version DESC
  `);
  const latest = rows[0];
  if (!latest) return null;
  return {
    weekNumber: latest.weekNumber,
    classDay: latest.classDay,
    revisions: rows.map(({ version, changeNote, createdAt, pdf, hangul }) => ({
      version,
      changeNote,
      createdAt: new Date(createdAt).toISOString(),
      pdf: pdf && { ...pdf, uploadedAt: new Date(pdf.uploadedAt).toISOString() },
      hangul: hangul && { ...hangul, uploadedAt: new Date(hangul.uploadedAt).toISOString() },
    })),
  };
}

/** 파일과 같은 일지에 속한 확정 버전이 있을 때만 비공개 저장 키를 가져옵니다. */
export async function findClassLogDocumentDownload(fileId: string): Promise<DownloadRow | null> {
  const { rows } = await db.execute<DownloadRow>(sql`
    SELECT file.file_name AS "fileName", file.byte_size AS "byteSize", file.format,
           file.storage_key AS "storageKey"
    FROM public.class_log_document_files AS file
    WHERE file.id = ${fileId}::uuid AND EXISTS (
      SELECT 1
      FROM public.class_log_document_revisions AS revision
      WHERE revision.class_log_id = file.class_log_id
        AND (revision.pdf_file_id = file.id OR revision.hangul_file_id = file.id)
    )
  `);
  return rows[0] ?? null;
}

type DocumentSummaryRow = {
  classLogId: string;
  weekNumber: number;
  pdf: boolean;
  hangul: "HWP" | "HWPX" | null;
};

/** 기존 권한으로 조회된 일지 ID만 대상으로 최신본의 문서 형식을 반환합니다. */
export async function findClassLogDocumentSummaries(ids: string[]) {
  if (!ids.length) return [];
  const { rows } = await db.execute<DocumentSummaryRow>(sql`
    SELECT record.class_log_id AS "classLogId", record.week_number AS "weekNumber",
           latest.pdf_file_id IS NOT NULL AS pdf, file.format AS hangul
    FROM public.class_log_document_records record
    JOIN LATERAL (
      SELECT pdf_file_id, hangul_file_id FROM public.class_log_document_revisions
      WHERE class_log_id = record.class_log_id ORDER BY version DESC LIMIT 1
    ) latest ON true
    LEFT JOIN public.class_log_document_files file ON file.id = latest.hangul_file_id
    WHERE record.class_log_id IN (
      SELECT value::uuid FROM jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb)
    )
  `);
  return rows;
}
