/**
 * #516 텍스트·발표자료 분리 제출(V2) 최종화의 DB 어댑터
 *
 * 역할:
 * - `complete_academic_assignment_submission_v2` 범위 SQL 함수 한 번으로 성공 복구(finalize=false) 또는
 *   의도 묶음(1~2개)의 원자적 최종화(finalize=true)를 수행합니다.
 * - 알려진 SQLSTATE(SUB01~SUB07, 23505)만 고정 오류로 바꾸고 SQL·매개변수·원본 메시지는 응답에 복사하지 않습니다.
 *
 * 사용 위치:
 * - `submissions/artifacts.ts`의 V2 최종화 서비스만 호출합니다. 기존 v1 최종화는 `service.ts`를 그대로 사용합니다.
 */
import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  finalizedArtifactSubmissionSchema,
  translateFinalizationError,
  type FinalizeArtifactSubmissionInput,
  type FinalizedArtifactSubmission,
} from "./validation";

/** 세션에서 결정한 대상·계정과 검증된 입력만 받습니다. 결과가 없으면(복구 조회의 미제출) null입니다. */
export async function completeArtifactSubmission(
  target: { userId: string; targetId: string },
  input: FinalizeArtifactSubmissionInput,
  finalize: boolean,
): Promise<FinalizedArtifactSubmission | null> {
  try {
    // drizzle의 배열 매개변수는 목록으로 펼쳐지므로 uuid 원소를 하나씩 결합해 uuid[] 리터럴을 만듭니다.
    const intents = sql.join(
      input.uploadIntentIds.map((id) => sql`${id}::uuid`),
      sql`,`,
    );
    const result = await db.execute(sql`SELECT public.complete_academic_assignment_submission_v2(
      ${target.targetId}::uuid, ${target.userId}::uuid, ARRAY[${intents}]::uuid[],
      ${input.submissionKey}::uuid, ${finalize}::boolean
    ) AS result`);
    const value = result.rows[0]?.result;
    if (value === null) return null;
    return finalizedArtifactSubmissionSchema.parse(value);
  } catch (error) {
    throw translateFinalizationError(error);
  }
}
