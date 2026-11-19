/**
 * 주차별 텍스트 Web adapter의 Application Service 경계입니다 (#271).
 * 승인 역할을 확인한 뒤 읽기 쿼리를 Repository에 위임하며, 기수 열람 범위(#441)는
 * Repository 조회의 SQL 조건으로 강제합니다(MEMBER 본인 기수만, FACULTY·ADMIN 전체 기수).
 * 현재 Web 열람 정책은 API v1 메타데이터의 추가 읽기 예산과 별개이므로
 * Page로 이동할 때 갑자기 API read-limit을 추가하지 않습니다.
 */
import "server-only";

import { canReadSharedResource } from "@/features/resources/access";
import {
  findWebWeeklyTextDetail,
  findWebWeeklyTextPrintable,
  findWebWeeklyTextTitle,
  type WebWeeklyTextReader,
} from "./repository";

/** Web 세션의 사용자 정보입니다. 식별자가 없거나 승인 역할이 아니면 조회하지 않습니다. */
type WebWeeklyTextUser = { id?: string | null; role?: string | null } | null | undefined;

/** 승인 역할과 사용자 식별자가 모두 있을 때만 Repository에 넘길 열람 주체를 만듭니다. */
function toReader(user: WebWeeklyTextUser): WebWeeklyTextReader | null {
  if (!user?.id || !user.role || !canReadSharedResource(user.role)) return null;
  return { id: user.id, role: user.role };
}

export async function getWebWeeklyTextTitle(
  user: WebWeeklyTextUser,
  id: string,
): Promise<string | null> {
  const reader = toReader(user);
  if (!reader) return null;
  return findWebWeeklyTextTitle(reader, id);
}

/** 이 서비스는 승인된 역할만 받아들이고 실제 DB 쿼리는 Repository가 수행합니다. */
export async function getWebWeeklyTextDetail(user: WebWeeklyTextUser, id: string) {
  const reader = toReader(user);
  if (!reader) return null;
  return findWebWeeklyTextDetail(reader, id);
}

export async function getWebWeeklyTextPrintable(user: WebWeeklyTextUser, id: string) {
  const reader = toReader(user);
  if (!reader) return null;
  return findWebWeeklyTextPrintable(reader, id);
}
