/**
 * #516 텍스트·발표자료 분리 제출(V2) 학생 화면용 서버 액션
 *
 * 역할:
 * - 업로드 의도 발급·업로드 원본 검증·업로드 취소·원자적 최종 제출을 PR-D 서비스에 그대로 위임하는 얇은 경계입니다.
 * - 요청 주체는 입력으로 받지 않습니다. 각 서비스가 웹 세션에서 학생 본인 대상(requireAssignmentTarget)을 다시 확인합니다.
 * - 화면에는 고정 코드·고정 한국어 문구·검증 거부 사유 코드·요청 참조만 돌려주고, 원본 오류·저장 경로·URL은 숨깁니다.
 *
 * 사용 위치:
 * - `src/app/(member)/member/assignments/_components/artifact-submission-form.tsx`
 *
 * 주의:
 * - 모든 경로는 ACADEMIC_ENABLED·ACADEMIC_UPLOADS_ENABLED·ACADEMIC_SUBMISSION_ARTIFACTS_ENABLED가 모두 켜져야 열립니다.
 *   기본값(꺼짐)에서는 서비스가 DISABLED로 거부하며, 기존 PDF 단일 제출(v1) 액션·경로는 바꾸지 않습니다.
 * - 직접 업로드(PUT)와 SDK 토큰 교환은 기존 `/api/academic/uploads` 경로를 그대로 사용합니다.
 */
"use server";

import { revalidatePath } from "next/cache";
import {
  academicSqlState,
  createAcademicObservation,
  type AcademicObservation,
} from "@/lib/academic-observability";
import { AcademicAccessError } from "@/lib/academic-permissions";
import {
  AcademicUploadError,
  assertAcademicSubmissionArtifactsEnabled,
} from "@/features/academics/assignment-uploads/contract";
import {
  createAssignmentArtifactUploadIntent,
  verifyAssignmentArtifactUpload,
} from "@/features/academics/assignment-uploads/artifacts";
import { cancelAssignmentUploadIntent } from "@/features/academics/assignment-uploads/server";
import { finalizeAssignmentArtifactSubmission } from "./artifacts";
import { SubmissionFinalizationError } from "./validation";

/** 화면이 받는 실패 응답입니다. reason은 V2 파일 검증 거부 사유(고정 코드)일 때만 포함합니다. */
type ArtifactActionFailure = {
  success: false;
  status: number;
  code: string;
  message: string;
  reason?: string;
  retryAfterSeconds?: number;
  referenceId: string;
};

const unavailableMessage = "요청을 처리하지 못했습니다. 잠시 후 같은 요청으로 다시 시도해 주세요.";

/** 알려진 오류만 고정 코드·문구로 바꾸고, 그 밖의 오류는 원문 없이 UNAVAILABLE로 응답합니다. */
function toFailure(error: unknown, observation: AcademicObservation): ArtifactActionFailure {
  if (
    error instanceof AcademicAccessError ||
    error instanceof AcademicUploadError ||
    error instanceof SubmissionFinalizationError
  ) {
    return {
      success: false,
      status: error.status,
      code: error.code,
      message: error.message,
      ...(error instanceof AcademicUploadError && error.reason ? { reason: error.reason } : {}),
      ...(error instanceof AcademicUploadError && error.code === "RATE_LIMITED"
        ? { retryAfterSeconds: error.retryAfterSeconds }
        : {}),
      referenceId: observation.correlationId,
    };
  }
  return {
    success: false,
    status: 503,
    code: "UNAVAILABLE",
    message: unavailableMessage,
    referenceId: observation.correlationId,
  };
}

/** 산출물(텍스트/발표자료)·선언 형식별 업로드 의도를 발급합니다. 반환한 contentType으로만 직접 업로드할 수 있습니다. */
export async function issueArtifactUploadIntent(input: unknown) {
  const observation = createAcademicObservation("UPLOAD_INTENT", "UPLOAD_INTENT");
  try {
    // 실패 관측은 서비스(observeUpload)가 기록합니다.
    const issued = await createAssignmentArtifactUploadIntent(input, observation);
    return { success: true as const, ...issued, referenceId: observation.correlationId };
  } catch (error) {
    return toFailure(error, observation);
  }
}

/** 업로드된 원본을 서버가 읽어 형식·크기·SHA-256을 검증합니다. 최종 제출이 아니며 같은 의도의 재검증은 멱등입니다. */
export async function verifyArtifactUpload(input: unknown) {
  const observation = createAcademicObservation("UPLOAD_VERIFY", "UPLOAD_INTENT");
  try {
    if (typeof input !== "object" || input === null) throw new AcademicUploadError("NOT_FOUND");
    const { assignmentId, uploadIntentId } = input as Record<string, unknown>;
    // 형식 검사는 서비스의 zod 스키마가 수행합니다. 여기서는 다른 키를 버리고 두 값만 넘깁니다.
    await verifyAssignmentArtifactUpload(
      { assignmentId: String(assignmentId ?? ""), uploadIntentId: String(uploadIntentId ?? "") },
      observation,
    );
    return { success: true as const, referenceId: observation.correlationId };
  } catch (error) {
    return toFailure(error, observation);
  }
}

/** 한 항목의 진행 중 업로드를 취소합니다. 발급 원장만 종료하고 객체를 즉시 삭제하지 않습니다. */
export async function cancelArtifactUpload(input: unknown) {
  const observation = createAcademicObservation("UPLOAD_CANCEL", "UPLOAD_INTENT");
  try {
    // 취소 서비스는 기존 업로드 gate만 확인하므로, V2 화면 경로에서는 분리 제출 gate를 먼저 확인합니다.
    assertAcademicSubmissionArtifactsEnabled();
    await cancelAssignmentUploadIntent(input, observation);
    return {
      success: true as const,
      state: "CANCELLED" as const,
      referenceId: observation.correlationId,
    };
  } catch (error) {
    // gate 거부는 서비스 밖에서 났으므로 여기서 한 번 기록합니다(서비스 실패는 이미 기록됨).
    if (!observation.failureRecorded)
      observation.emit("FAILED", {
        failureCode:
          error instanceof AcademicUploadError && error.code === "DISABLED" ? "GATE" : "STORAGE",
        sqlState: academicSqlState(error),
      });
    return toFailure(error, observation);
  }
}

/** 검증된 업로드 1~2개를 멱등 키로 한 번에 원자적으로 최종 제출합니다. */
export async function finalizeArtifactSubmission(input: unknown) {
  const observation = createAcademicObservation("SUBMISSION_FINALIZE", "SUBMISSION");
  try {
    const result = await finalizeAssignmentArtifactSubmission(input, observation);
    observation.emit(result.replayed ? "REPLAYED" : "COMPLETED", {
      resourceId: result.submissionId,
    });
    revalidatePath("/member/assignments");
    revalidatePath(`/member/assignments/${result.assignmentId}`);
    revalidatePath("/admin/academics/assignments");
    revalidatePath(`/admin/academics/assignments/${result.assignmentId}/submissions`);
    return {
      success: true as const,
      message: "과제 제출을 완료했습니다.",
      ...result,
      referenceId: observation.correlationId,
    };
  } catch (error) {
    // v1 최종화 액션과 같은 고정 분류로 실패를 기록합니다.
    const known =
      error instanceof AcademicAccessError ||
      error instanceof AcademicUploadError ||
      error instanceof SubmissionFinalizationError;
    const code = known ? error.code : null;
    const denied = code !== null && ["UNAUTHENTICATED", "FORBIDDEN", "NOT_FOUND"].includes(code);
    if (!observation.failureRecorded)
      observation.emit(denied ? "DENIED" : "FAILED", {
        failureCode: denied
          ? "AUTHORIZATION"
          : code !== null &&
              ["INVALID_INPUT", "INVALID_FILE", "INCOMPLETE", "TOO_LARGE"].includes(code)
            ? "INPUT"
            : code === "DISABLED"
              ? "GATE"
              : code !== null &&
                  ["CONFLICT", "EXPIRED", "DEADLINE", "RATE_LIMITED", "WRONG_FORMAT"].includes(code)
                ? "CONFLICT"
                : code === "NOT_READY"
                  ? "NOT_READY"
                  : "STORAGE",
        sqlState: academicSqlState(error),
      });
    return toFailure(error, observation);
  }
}
