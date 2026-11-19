/**
 * #516 텍스트·발표자료 분리 제출(V2) 최종화 서비스
 *
 * 역할:
 * - 같은 멱등 키의 성공 결과를 Blob 요청보다 먼저 복구합니다(마감·쓰기 중단 뒤에도 복구 가능).
 * - 새 제출이면 각 업로드 원본을 서버가 다시 읽어 형식·SHA-256을 검증한 뒤,
 *   의도 묶음(텍스트·발표자료 1~2개)을 한 DB 트랜잭션에서 원자적으로 확정합니다(정책 3).
 *
 * 사용 위치:
 * - 학생 화면(PR-F)·API v1(PR-G) 연결 전입니다. 기능은 ACADEMIC_SUBMISSION_ARTIFACTS_ENABLED로 기본 비활성입니다.
 *
 * 주의:
 * - 두 원본(각 50MiB 이하)은 병렬로 검증해 Function 실행 시간 안에 끝나도록 합니다. 최대 메모리는 약 100MiB입니다.
 * - 검증 실패는 입력 순서상 첫 실패의 고정 오류를 그대로 전달합니다(파일명·경로 없음).
 */
import "server-only";
import { assertAcademicWritesEnabled } from "@/lib/academic-admin";
import { requireAssignmentTarget } from "@/lib/academic-permissions";
import type { AcademicObservation } from "@/lib/academic-observability";
import { verifyAssignmentArtifactUpload } from "@/features/academics/assignment-uploads/artifacts";
import { assertAcademicSubmissionArtifactsEnabled } from "@/features/academics/assignment-uploads/contract";
import { completeArtifactSubmission } from "./repository";
import { finalizeArtifactSubmissionSchema, SubmissionFinalizationError } from "./validation";

export async function finalizeAssignmentArtifactSubmission(
  input: unknown,
  observation?: AcademicObservation,
) {
  // 기능 gate가 꺼져 있으면 성공 복구 조회도 하지 않습니다(V2 전체 비활성).
  try {
    assertAcademicSubmissionArtifactsEnabled();
  } catch {
    throw new SubmissionFinalizationError("DISABLED");
  }
  const parsed = finalizeArtifactSubmissionSchema.safeParse(input);
  if (!parsed.success) throw new SubmissionFinalizationError("INVALID_INPUT");
  const request = parsed.data;
  const target = await requireAssignmentTarget({ assignmentId: request.assignmentId });
  observation?.authenticated(target.userId);
  observation?.identify({ requestId: request.submissionKey });
  observation?.emit("AUTHORIZED");
  const replay = await completeArtifactSubmission(target, request, false);
  if (replay) return replay;
  // 쓰기 중단은 새로운 검증·최종화에 적용하고, 이미 커밋된 성공 조회는 위에서 복구합니다.
  try {
    assertAcademicWritesEnabled();
  } catch {
    throw new SubmissionFinalizationError("DISABLED");
  }
  // 0개·같은 의도 중복은 DB의 SUB06과 같은 의미이므로 Blob을 읽기 전에 거부합니다.
  if (
    request.uploadIntentIds.length === 0 ||
    new Set(request.uploadIntentIds).size !== request.uploadIntentIds.length
  ) {
    throw new SubmissionFinalizationError("INCOMPLETE");
  }
  const results = await Promise.allSettled(
    request.uploadIntentIds.map((uploadIntentId) =>
      verifyAssignmentArtifactUpload(
        { assignmentId: request.assignmentId, uploadIntentId },
        observation?.fork("UPLOAD_VERIFY", "UPLOAD_INTENT"),
      ),
    ),
  );
  const failure = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (failure) throw failure.reason;
  // 외부 객체를 읽는 동안 세션·배정이 달라졌으면 새로운 권한으로 이어 제출하지 않습니다.
  const current = await requireAssignmentTarget({ assignmentId: request.assignmentId });
  if (current.userId !== target.userId || current.targetId !== target.targetId)
    throw new SubmissionFinalizationError("FORBIDDEN");
  const result = await completeArtifactSubmission(current, request, true);
  if (!result) throw new SubmissionFinalizationError("UNAVAILABLE");
  return result;
}
