/** DB에서 현재 인가와 예약/확정 결과를 한 SQL 호출로 확인합니다. */
import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod/v4";
import { db } from "@/lib/db";
import { classLogDocumentUploadSelection } from "./upload-contract";

const reservedFile = classLogDocumentUploadSelection.extend({ fileId: z.uuid() });
const response = z.union([
  z.object({
    state: z.literal("reserved"),
    expiresAt: z.iso.datetime({ offset: true }),
    pdf: reservedFile.nullable(),
    hangul: reservedFile.nullable(),
  }),
  z.object({
    state: z.literal("published"),
    logId: z.uuid(),
    version: z.number().int().positive(),
  }),
  z.object({ state: z.enum(["forbidden", "missing", "expired", "conflict", "busy"]) }),
]);

export async function writeClassLogDocumentRequest(
  actorId: string,
  requestId: string,
  stage: "reserve" | "inspect" | "publish",
  payload?: object,
) {
  // JSON과 UUID는 바인딩 파라미터로만 전달합니다. 중복 기록은 고정 결과로 매핑합니다.
  try {
    const result = await db.execute(sql`SELECT public.write_class_log_document_request(
      ${actorId}::uuid, ${requestId}::uuid, ${stage}::text,
      ${payload ? JSON.stringify(payload) : null}::jsonb
    ) AS result`);
    return response.parse(result.rows[0]?.result);
  } catch (error) {
    if (
      error instanceof Error &&
      error.cause &&
      typeof error.cause === "object" &&
      "code" in error.cause &&
      error.cause.code === "23505"
    ) {
      return { state: "conflict" } as const;
    }
    throw error;
  }
}

/** 기존 관리자 편집과 삭제가 문서형 일지의 고정 식별자를 건드리지 않게 합니다. */
export async function isClassLogDocumentRecord(id: string): Promise<boolean> {
  // 읽기 플래그를 꺼도 확정 문서의 기존 관리자 편집·삭제 경계를 유지합니다.
  if (process.env.CLASS_LOG_DOCUMENTS_ENABLED !== "true") {
    const catalog = await db.execute(
      sql`SELECT to_regclass('public.class_log_document_records') IS NOT NULL AS installed`,
    );
    if (catalog.rows[0]?.installed !== true) return false;
  }
  const result = await db.execute(sql`SELECT EXISTS (
    SELECT 1 FROM public.class_log_document_records WHERE class_log_id = ${id}::uuid
  ) AS present`);
  return result.rows[0]?.present === true;
}

/** 정본 작성자 ID를 화면에 전달하지 않고 수정본 폼의 표시 여부만 확인합니다. */
export async function isClassLogDocumentAuthor(id: string, actorId: string): Promise<boolean> {
  const result = await db.execute(sql`SELECT EXISTS (
    SELECT 1 FROM public.class_logs l JOIN public.users u ON u.id = l.author_id
    WHERE l.id = ${id}::uuid AND u.id = ${actorId}::uuid
      AND (u.role = 'FACULTY' OR (u.role = 'MEMBER' AND u.cohort_id = l.cohort_id))
  ) AS permitted`);
  return result.rows[0]?.permitted === true;
}
