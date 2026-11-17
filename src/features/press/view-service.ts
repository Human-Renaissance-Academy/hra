/**
 * 공개 언론보도 클릭의 조회수 기록을 제공하는 Application Service입니다.
 * 관리자 업무와 분리하여 기존 비로그인 클릭 허용 정책을 유지합니다.
 */
import "server-only";

import { reservePressView } from "@/lib/rate-limit";
import { incrementViewCount } from "./view-repository";

/**
 * 서버가 확인한 IP·기사의 반복 예약을 제한하고 허용된 클릭만 증가시킵니다.
 * 예약과 증가는 별도 SQL이므로 저장 실패 시 예약이 남아 과소 집계될 수 있습니다.
 */
export async function recordPressView(id: string, ip: string): Promise<void> {
  const reservation = await reservePressView(ip, id);
  if (reservation.blocked) return;

  // 예약 장애는 위에서 억제하되 실제 증가 저장 오류는 기존처럼 호출자에게 전파합니다.
  await incrementViewCount(id);
}
