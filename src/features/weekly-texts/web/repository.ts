/**
 * 웹 주차별 텍스트 상세·인쇄 조회에 필요한 DB 열을 이 Repository가 소유합니다 (#271).
 * 실제 Blob URL·이미지 원본 URL은 Page props로 반환하지 않습니다.
 * 승인 역할 확인은 서비스가 먼저 수행하고, 기수 열람 범위(#441)는 모든 조회가 `../access` 의 같은 SQL 조건을
 * WHERE에 두어 강제합니다. 범위 밖 텍스트는 없는 텍스트와 같은 null입니다.
 */
import "server-only";

import { and, asc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { cohorts, weeklyTextImages, weeklyTexts } from "@/lib/db/schema";
import { weeklyTextReadFilter } from "../access";

/** 세션에서 받은 사용자 식별자와 역할입니다. 기수는 SQL 안에서 현재 `users` 행을 읽어 판정합니다. */
export type WebWeeklyTextReader = { id: string; role: string };

export type WebWeeklyTextDetail = {
  id: string;
  title: string;
  body: string | null;
  hasFile: boolean;
  fileName: string | null;
  cohortName: string | null;
  textType: string | null;
  createdAt: Date;
  images: Array<{ id: string; alt: string | null; order: number }>;
};

export type WebWeeklyTextPrintable = {
  id: string;
  title: string;
  body: string | null;
  createdAt: Date;
  cohortName: string | null;
  textType: string | null;
};

/** 메타데이터 요청은 승인 역할을 통과한 뒤 제목 한 열만 읽습니다. */
export async function findWebWeeklyTextTitle(
  reader: WebWeeklyTextReader,
  id: string,
): Promise<string | null> {
  const [row] = await db
    .select({ title: weeklyTexts.title })
    .from(weeklyTexts)
    .where(and(eq(weeklyTexts.id, id), weeklyTextReadFilter(reader)))
    .limit(1);
  return row?.title ?? null;
}

/** 본문/첨부 여부/사진 ID만 반환합니다. 다운로드는 기존 별도 인증 API가 수행합니다. */
export async function findWebWeeklyTextDetail(
  reader: WebWeeklyTextReader,
  id: string,
): Promise<WebWeeklyTextDetail | null> {
  const [text] = await db
    .select({
      id: weeklyTexts.id,
      title: weeklyTexts.title,
      body: weeklyTexts.body,
      hasFile: sql<boolean>`coalesce(${weeklyTexts.fileUrl} <> '', false)`,
      fileName: weeklyTexts.fileName,
      cohortName: cohorts.name,
      textType: weeklyTexts.textType,
      createdAt: weeklyTexts.createdAt,
    })
    .from(weeklyTexts)
    .leftJoin(cohorts, eq(weeklyTexts.cohortId, cohorts.id))
    .where(and(eq(weeklyTexts.id, id), weeklyTextReadFilter(reader)))
    .limit(1);
  // 범위 밖 텍스트는 여기서 끝나므로 사진 ID는 열람 가능한 텍스트에 대해서만 읽습니다.
  if (!text) return null;

  const images = await db
    .select({
      id: weeklyTextImages.id,
      alt: weeklyTextImages.alt,
      order: weeklyTextImages.order,
    })
    .from(weeklyTextImages)
    .where(eq(weeklyTextImages.weeklyTextId, id))
    .orderBy(asc(weeklyTextImages.order), asc(weeklyTextImages.createdAt));

  return { ...text, images };
}

/** 인쇄에는 이미지·파일 URL을 조회하지 않고 본문 표시 열만 읽습니다. */
export async function findWebWeeklyTextPrintable(
  reader: WebWeeklyTextReader,
  id: string,
): Promise<WebWeeklyTextPrintable | null> {
  const [text] = await db
    .select({
      id: weeklyTexts.id,
      title: weeklyTexts.title,
      body: weeklyTexts.body,
      createdAt: weeklyTexts.createdAt,
      cohortName: cohorts.name,
      textType: weeklyTexts.textType,
    })
    .from(weeklyTexts)
    .leftJoin(cohorts, eq(weeklyTexts.cohortId, cohorts.id))
    .where(and(eq(weeklyTexts.id, id), weeklyTextReadFilter(reader)))
    .limit(1);
  return text ?? null;
}
