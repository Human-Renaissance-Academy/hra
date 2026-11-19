/**
 * 승인 회원용 주차별 텍스트 목록·상세·파일의 PostgreSQL 조회를 소유합니다.
 *
 * - 주차별 텍스트는 기수 제한 자료입니다(#441). MEMBER는 본인 기수만, FACULTY·ADMIN은 전체 기수를 읽으며
 *   모든 조회가 `../access` 의 같은 SQL 조건을 WHERE에 둡니다. 역할 확인은 서비스가 먼저 수행합니다.
 * - 목록은 본문·원본 파일 URL을 읽지 않고 존재 여부만 DB에서 계산합니다.
 * - 첨부 사진(weekly_text_images)은 이 저장소에서 조회하지 않습니다.
 */
import "server-only";

import { and, count, desc, eq, sql } from "drizzle-orm";
import { db } from "@/lib/db";
import { cohorts, weeklyTexts } from "@/lib/db/schema";
import { weeklyTextReadFilter } from "../access";

/** 현재 DB 행으로 확인한 승인 회원입니다. 기수는 SQL 안에서 `users` 행을 다시 읽어 판정합니다. */
export type WeeklyTextReader = { id: string; role: "ADMIN" | "FACULTY" | "MEMBER" };

export type WeeklyTextRecord = {
  id: string;
  title: string;
  textType: string | null;
  classDate: Date | null;
  cohortId: string | null;
  cohortName: string | null;
  hasBody: boolean;
  hasFile: boolean;
};

// 본문·파일 URL은 결과에 싣지 않고 기존 Web 목록과 같은 truthy 분기만 DB에서 계산합니다.
const summaryColumns = {
  id: weeklyTexts.id,
  title: weeklyTexts.title,
  textType: weeklyTexts.textType,
  classDate: weeklyTexts.classDate,
  cohortId: cohorts.id,
  cohortName: cohorts.name,
  hasBody: sql<boolean>`coalesce(${weeklyTexts.body} <> '', false)`,
  hasFile: sql<boolean>`coalesce(${weeklyTexts.fileUrl} <> '', false)`,
};

/** 열람 가능한 주차별 텍스트 수를 셉니다. 초안 상태가 없으므로 열람 범위의 모든 행이 대상입니다. */
export async function countWeeklyTexts(reader: WeeklyTextReader): Promise<number> {
  const [{ total }] = await db
    .select({ total: count() })
    .from(weeklyTexts)
    .where(weeklyTextReadFilter(reader));
  return total;
}

/** Web 통합 목록과 같은 수업일 역순(NULL 마지막)·작성 시각 역순에 ID를 더해 안정된 페이지를 읽습니다. */
export async function listWeeklyTexts(
  reader: WeeklyTextReader,
  pageSize: number,
  offset: number,
): Promise<WeeklyTextRecord[]> {
  return db
    .select(summaryColumns)
    .from(weeklyTexts)
    .leftJoin(cohorts, eq(weeklyTexts.cohortId, cohorts.id))
    .where(weeklyTextReadFilter(reader))
    .orderBy(
      sql`${weeklyTexts.classDate} DESC NULLS LAST`,
      desc(weeklyTexts.createdAt),
      desc(weeklyTexts.id),
    )
    .limit(pageSize)
    .offset(offset);
}

/** 상세는 Markdown 본문과 첨부 표시용 파일명을 추가로 읽고 저장 위치는 읽지 않습니다. */
export async function findWeeklyText(
  reader: WeeklyTextReader,
  id: string,
): Promise<(WeeklyTextRecord & { body: string | null; fileName: string | null }) | null> {
  const [row] = await db
    .select({ ...summaryColumns, body: weeklyTexts.body, fileName: weeklyTexts.fileName })
    .from(weeklyTexts)
    .leftJoin(cohorts, eq(weeklyTexts.cohortId, cohorts.id))
    .where(and(eq(weeklyTexts.id, id), weeklyTextReadFilter(reader)))
    .limit(1);
  return row ?? null;
}

/** 다운로드에 필요한 저장 위치와 원본 파일명만 읽습니다. 본문만 있는 텍스트는 빈 URL, 범위 밖은 null입니다. */
export async function findWeeklyTextFile(
  reader: WeeklyTextReader,
  id: string,
): Promise<{ fileUrl: string; fileName: string | null } | null> {
  const [row] = await db
    .select({ fileUrl: weeklyTexts.fileUrl, fileName: weeklyTexts.fileName })
    .from(weeklyTexts)
    .where(and(eq(weeklyTexts.id, id), weeklyTextReadFilter(reader)))
    .limit(1);
  return row ?? null;
}
