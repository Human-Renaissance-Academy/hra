/**
 * #162 과제 검토·피드백의 Application Service입니다.
 *
 * - 호출자: `actions.ts`(Server Action), `/member/reviews`·`/member/academic-operations/feedback`·학생 과제 상세 화면,
 *   검토자 제출 파일 다운로드 Route. 화면·Route는 DB를 직접 호출하지 않고 이 서비스만 호출합니다.
 * - 요청 주체(Principal)는 호출자가 실제 세션에서 확정해 넘깁니다. 클라이언트 입력으로 받지 않습니다.
 * - 기능 플래그: `ACADEMIC_ENABLED`·`ACADEMIC_FACULTY_REVIEW_ENABLED`·`ACADEMIC_ASSIGNMENT_REVIEW_ENABLED`가 모두
 *   정확히 "true"가 아니면 DB에 접속하지 않고 DISABLED로 거부합니다(정책 운영 승인 전 비활성).
 * - 검토 권한은 #161 `can_review_assignment`를 SQL 함수 안에서 다시 호출해 판정하며, 제출 학생 계정이 검토자와 같으면 거부합니다.
 *   학생 공개·공개 취소는 학사 운영 관리자만 하고 작성 검토자 본인은 할 수 없습니다(P12).
 *   홈페이지 `ADMIN`·`FACULTY` 역할은 어떤 판정에도 쓰지 않으며 이 서비스는 출결 권한을 다루지 않습니다.
 */
import "server-only";
import { z } from "zod/v4";
import {
  isAcademicStaffPrincipal,
  type AcademicStaffPrincipal,
} from "@/features/academics/staff/contracts";
import { isFacultyReviewEnabled } from "@/features/academics/faculty-review/service";
import {
  deliverSubmissionFile,
  type SubmissionFileParams,
} from "@/features/academics/submission-files/service";
import { SubmissionFileAccessError } from "@/features/academics/submission-files/access";
import {
  AssignmentReviewError,
  publicationListSchema,
  publishFeedbackSchema,
  publishedFeedbackListSchema,
  retractFeedbackSchema,
  reviewResultSchema,
  reviewSubmissionListSchema,
  saveReviewSchema,
  submitReviewSchema,
  toAssignmentReviewError,
} from "./contracts";
import {
  authorizeReviewerFileRead,
  publishFeedback,
  retractFeedback,
  saveReview,
  selectFeedbackForPublication,
  selectPublishedFeedback,
  selectReviewSubmissions,
  submitReview,
} from "./repository";

/** 정책 운영 승인 전에는 false입니다. 학사·교수 검토 권한·과제 검토 플래그가 모두 정확히 "true"일 때만 켭니다. */
export function isAssignmentReviewEnabled(): boolean {
  return isFacultyReviewEnabled() && process.env.ACADEMIC_ASSIGNMENT_REVIEW_ENABLED === "true";
}

/** 주체 형식 → 승인 대기 계정 → 기능 플래그 순서로 확인해 비활성 환경에서는 학사 표를 조회하지 않습니다. */
function requireActor(principal: unknown): AcademicStaffPrincipal {
  if (!isAcademicStaffPrincipal(principal)) throw new AssignmentReviewError("UNAUTHENTICATED");
  if (principal.role === "PENDING") throw new AssignmentReviewError("FORBIDDEN");
  if (!isAssignmentReviewEnabled()) throw new AssignmentReviewError("DISABLED");
  return principal;
}

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw new AssignmentReviewError("INVALID_INPUT");
  return parsed.data;
}

/** 저장소 호출과 결과 형식 검증을 묶고, 실패는 고정 오류 코드로만 바꿉니다. */
async function run<T>(schema: z.ZodType<T>, call: () => Promise<unknown>): Promise<T> {
  let raw: unknown;
  try {
    raw = await call();
  } catch (error) {
    throw toAssignmentReviewError(error);
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw new AssignmentReviewError("UNAVAILABLE");
  return parsed.data;
}

function assignmentIdOf(value: unknown): string {
  return parse(z.uuid(), value);
}

/** 검토자가 지금 검토할 수 있는 과제의 제출물과 본인 피드백 목록입니다. 권한이 없으면 빈 목록입니다(본인 제출물 제외). */
export async function listReviewSubmissions(principal: unknown, assignmentId: unknown) {
  const actor = requireActor(principal);
  const id = assignmentIdOf(assignmentId);
  return run(reviewSubmissionListSchema, () => selectReviewSubmissions(actor.userId, id));
}

/** 검토자의 피드백 초안 저장(신규·수정). 다른 요청이 먼저 바꿨으면 CONFLICT입니다. */
export async function saveAssignmentReview(principal: unknown, input: unknown) {
  const actor = requireActor(principal);
  const data = parse(saveReviewSchema, input);
  return run(reviewResultSchema, () =>
    saveReview({
      actorId: actor.userId,
      submissionId: data.submissionId,
      expectedVersion: data.expectedVersion,
      body: data.body,
      gradeLabel: data.gradeLabel || null,
      reason: data.reason ?? null,
    }),
  );
}

/** 검토자가 초안을 제출합니다. 학생 공개는 학사 운영 관리자가 따로 처리합니다. */
export async function submitAssignmentReview(principal: unknown, input: unknown) {
  const actor = requireActor(principal);
  const data = parse(submitReviewSchema, input);
  return run(reviewResultSchema, () =>
    submitReview({
      actorId: actor.userId,
      reviewId: data.reviewId,
      expectedVersion: data.expectedVersion,
    }),
  );
}

/** 학사 운영 관리자가 제출된 피드백을 학생에게 공개합니다. 작성 검토자 본인은 공개할 수 없습니다. */
export async function publishAssignmentFeedback(principal: unknown, input: unknown) {
  const actor = requireActor(principal);
  const data = parse(publishFeedbackSchema, input);
  return run(reviewResultSchema, () =>
    publishFeedback({
      actorId: actor.userId,
      reviewId: data.reviewId,
      expectedVersion: data.expectedVersion,
    }),
  );
}

/** 학사 운영 관리자가 공개한 피드백을 사유와 함께 비공개로 되돌립니다. 이전 공개 사실은 이력에 남습니다. */
export async function retractAssignmentFeedback(principal: unknown, input: unknown) {
  const actor = requireActor(principal);
  const data = parse(retractFeedbackSchema, input);
  return run(reviewResultSchema, () =>
    retractFeedback({
      actorId: actor.userId,
      reviewId: data.reviewId,
      expectedVersion: data.expectedVersion,
      reason: data.reason,
    }),
  );
}

/** 학사 운영 관리자의 공개 대기·공개 중 피드백 목록입니다. 관리자 지정이 없으면 FORBIDDEN입니다. */
export async function listFeedbackForPublication(principal: unknown) {
  const actor = requireActor(principal);
  return run(publicationListSchema, () => selectFeedbackForPublication(actor.userId));
}

/**
 * 학생 본인에게 공개된 본인 과제 피드백입니다. 기능이 꺼져 있으면 DB 조회 없이 빈 목록을 돌려
 * 기존 학생 과제 화면 동작을 바꾸지 않습니다.
 */
export async function listMyPublishedFeedback(principal: unknown, assignmentId: unknown) {
  if (!isAcademicStaffPrincipal(principal) || principal.role !== "MEMBER") return [];
  if (!isAssignmentReviewEnabled()) return [];
  const id = z.uuid().safeParse(assignmentId);
  if (!id.success) return [];
  return run(publishedFeedbackListSchema, () => selectPublishedFeedback(principal.userId, id.data));
}

/**
 * 지정 검토자의 제출 파일 다운로드입니다. 인가·감사는 SQL 함수 한 번으로 확정하고, 전달·헤더·관측은 G1 제출 파일 경로를 재사용합니다.
 * 담당하지 않은 과제·본인 제출물·없는 파일·기능 꺼짐은 모두 같은 404 본문으로 응답합니다.
 */
export async function downloadReviewerSubmissionFile(
  principal: unknown,
  params: Promise<SubmissionFileParams>,
): Promise<Response> {
  return deliverSubmissionFile(params, {
    authenticate: async () => {
      if (!isAcademicStaffPrincipal(principal))
        throw new SubmissionFileAccessError("UNAUTHENTICATED");
      if (principal.role === "PENDING") throw new SubmissionFileAccessError("FORBIDDEN");
      if (!isAssignmentReviewEnabled()) throw new SubmissionFileAccessError("DISABLED");
      return principal.userId;
    },
    authorize: async (ids) => {
      if (!isAcademicStaffPrincipal(principal))
        throw new SubmissionFileAccessError("UNAUTHENTICATED");
      try {
        return (await authorizeReviewerFileRead(principal.userId, ids.id, ids.fileId)) ?? undefined;
      } catch (error) {
        const mapped = toAssignmentReviewError(error);
        if (mapped.code === "UNAVAILABLE") throw new SubmissionFileAccessError("UNAVAILABLE");
        throw new SubmissionFileAccessError("NOT_FOUND");
      }
    },
  });
}
