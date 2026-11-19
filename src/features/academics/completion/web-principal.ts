/**
 * #163 수료 화면과 Server Action이 쓰는 Web 세션 → 요청 주체 변환입니다.
 *
 * - 사용 위치: `completion/actions.ts`, `/member/academic-operations/completion`, `/member/completion` 화면.
 * - 실제 Auth.js 세션의 id·role만 옮깁니다. 클라이언트 입력·모바일 Bearer는 받지 않습니다.
 * - 권한 판정은 하지 않습니다. 학사 운영 관리자 지정·본인 학적은 서비스가 DB 현재 시각 기준으로 다시 확인합니다.
 *   (#160의 `staff/web-principal.ts`와 같은 변환이며, 두 브랜치 병합 후 하나로 합칠 수 있습니다.)
 */
import "server-only";
import { getRequestSession } from "@/lib/request-session";
import { isUserRole, isValidUuid } from "@/lib/auth-session";
import type { AcademicStaffPrincipal } from "@/features/academics/staff/contracts";

/** 로그인 세션이 없거나 식별자 형식이 올바르지 않으면 null입니다(서비스가 UNAUTHENTICATED로 거부). */
export async function getWebCompletionPrincipal(): Promise<AcademicStaffPrincipal | null> {
  const session = await getRequestSession();
  const user = session?.user;
  if (!user || !isValidUuid(user.id) || !isUserRole(user.role)) return null;
  return { userId: user.id, role: user.role };
}
