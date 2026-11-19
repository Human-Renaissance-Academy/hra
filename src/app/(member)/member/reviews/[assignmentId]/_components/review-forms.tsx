"use client";
/**
 * #162 지정 검토자의 피드백 초안 저장·제출 폼입니다.
 *
 * - 화면이 읽은 버전(expectedVersion)을 함께 보내 다른 요청이 먼저 바꾼 경우 서버가 충돌로 거부합니다.
 * - 제출한 피드백을 고치면 사유가 필요하고 다시 초안이 됩니다. 이전 내용과 사유는 이력에 남습니다.
 * - 권한·자기 검토 금지·상태는 서버가 매 요청 다시 판정합니다. 피드백에 불필요한 개인정보를 적지 않도록 안내합니다.
 */
import { useActionState, useId } from "react";
import {
  saveReviewAction,
  submitReviewAction,
  type ReviewActionState,
} from "@/features/academics/assignment-reviews/actions";
import {
  FEEDBACK_BODY_MAX,
  GRADE_LABEL_MAX,
} from "@/features/academics/assignment-reviews/contracts";

const inputClass = "w-full rounded border border-[#D9D9D9] p-2";
const primaryButton =
  "rounded bg-[#1a1a1a] px-4 py-2 text-white hover:bg-[#333333] disabled:opacity-50";
const initialState: ReviewActionState = { status: "idle" };

function Result({ state }: { state: ReviewActionState }) {
  if (state.status === "error")
    return (
      <p role="alert" className="text-sm text-red-700">
        {state.message}
      </p>
    );
  if (state.status === "success")
    return (
      <p role="status" className="text-sm">
        {state.message}
      </p>
    );
  return null;
}

/** 피드백 초안 저장(신규·수정) 폼입니다. */
export function ReviewForm(props: {
  assignmentId: string;
  submissionId: string;
  version: number;
  body: string;
  gradeLabel: string;
  requiresReason: boolean;
}) {
  const id = useId();
  const [state, action, pending] = useActionState(saveReviewAction, initialState);
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="assignmentId" value={props.assignmentId} />
      <input type="hidden" name="submissionId" value={props.submissionId} />
      <input type="hidden" name="expectedVersion" value={props.version} />
      <div className="space-y-1">
        <label htmlFor={`${id}-body`} className="block font-medium">
          피드백
        </label>
        <textarea
          id={`${id}-body`}
          name="body"
          required
          rows={6}
          maxLength={FEEDBACK_BODY_MAX}
          defaultValue={props.body}
          className={inputClass}
          aria-describedby={`${id}-body-help`}
        />
        <p id={`${id}-body-help`} className="text-sm text-[#666666]">
          학생에게 공개될 수 있는 내용입니다. 학생의 연락처·건강 등 불필요한 개인정보를 적지 마세요.
        </p>
      </div>
      <div className="space-y-1">
        <label htmlFor={`${id}-grade`} className="block font-medium">
          평가 표기(선택)
        </label>
        <input
          id={`${id}-grade`}
          name="gradeLabel"
          maxLength={GRADE_LABEL_MAX}
          defaultValue={props.gradeLabel}
          className={inputClass}
          aria-describedby={`${id}-grade-help`}
        />
        <p id={`${id}-grade-help`} className="text-sm text-[#666666]">
          운영 규칙이 정한 짧은 표기만 적습니다. 점수 계산·순위에는 쓰지 않습니다.
        </p>
      </div>
      {props.requiresReason && (
        <div className="space-y-1">
          <label htmlFor={`${id}-reason`} className="block font-medium">
            수정 사유
          </label>
          <input
            id={`${id}-reason`}
            name="reason"
            required
            maxLength={500}
            className={inputClass}
          />
        </div>
      )}
      <button type="submit" disabled={pending} className={primaryButton}>
        {pending ? "저장 중…" : "초안 저장"}
      </button>
      <Result state={state} />
    </form>
  );
}

/** 저장한 초안을 제출합니다. 학생 공개는 학사 운영 관리자가 따로 처리합니다. */
export function SubmitReviewForm(props: {
  assignmentId: string;
  reviewId: string;
  version: number;
}) {
  const [state, action, pending] = useActionState(submitReviewAction, initialState);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="assignmentId" value={props.assignmentId} />
      <input type="hidden" name="reviewId" value={props.reviewId} />
      <input type="hidden" name="expectedVersion" value={props.version} />
      <button type="submit" disabled={pending} className={primaryButton}>
        {pending ? "제출 중…" : "피드백 제출"}
      </button>
      <Result state={state} />
    </form>
  );
}
