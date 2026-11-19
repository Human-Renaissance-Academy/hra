/**
 * 지정된 학사 승인자만 현재 필터에 맞는 대상 전원의 최소 CSV를 내려받는 API다.
 * CSV는 앱 밖 업무 사본이 되므로 성공·거부·실패를 개인정보 없는 관측 이벤트로 남기고,
 * 모든 응답에 같은 서버 요청 참조를 `X-Request-Id`로 붙인다. 오류 본문에는 고정 안내와 참조만 둔다.
 */
import { exportAssignmentSubmissionStatuses } from "@/features/academics/submission-statuses/queries";
import {
  SubmissionStatusError,
  submissionStatusRequestInput,
} from "@/features/academics/submission-statuses/contracts";
import {
  renderSubmissionStatusesCsv,
  submissionCsvDisposition,
} from "@/features/academics/submission-statuses/csv";
import { createAcademicObservation } from "@/lib/academic-observability";

export const dynamic = "force-dynamic";

// 오류 상태별 고정 실패 코드다. 404는 기능 비활성과 과제 없음을 구분하지 않는다.
function failureCodeFor(status: number) {
  if (status === 403) return "AUTHORIZATION" as const;
  if (status === 404 || status === 422) return "INPUT" as const;
  return "UNKNOWN" as const;
}

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const observation = createAcademicObservation("SUBMISSION_EXPORT", "ASSIGNMENT");
  const headers = {
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    "X-Request-Id": observation.correlationId,
  };
  try {
    const { id } = await params;
    // UUID가 아닌 경로 값은 관측기에서 null로 버려지므로 원문이 로그에 남지 않는다.
    observation.identify({ resourceId: id });
    const result = await exportAssignmentSubmissionStatuses(
      submissionStatusRequestInput(id, new URL(request.url).searchParams),
      observation,
    );
    const body = renderSubmissionStatusesCsv(result.rows);
    observation.emit("COMPLETED");
    return new Response(body, {
      headers: {
        ...headers,
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": submissionCsvDisposition(result.assignment.title),
      },
    });
  } catch (error) {
    const safe =
      error instanceof SubmissionStatusError ? error : new SubmissionStatusError("UNAVAILABLE");
    observation.emit(safe.status === 403 ? "DENIED" : "FAILED", {
      failureCode: failureCodeFor(safe.status),
    });
    return Response.json(
      { message: safe.message, referenceId: observation.correlationId },
      { status: safe.status, headers },
    );
  }
}
