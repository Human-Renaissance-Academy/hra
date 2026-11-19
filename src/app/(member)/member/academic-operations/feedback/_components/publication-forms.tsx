"use client";
/**
 * #162 학사 운영 관리자의 피드백 공개·공개 취소 폼입니다.
 *
 * - 화면이 읽은 버전을 함께 보내 검토자 수정·다른 관리자 처리와 겹치면 서버가 충돌로 거부합니다.
 * - 관리자 지정·작성자 본인 공개 금지는 서버가 매 요청 다시 판정합니다.
 */
import { useActionState, useId } from "react";
import {
  publishFeedbackAction,
  retractFeedbackAction,
  type ReviewActionState,
} from "@/features/academics/assignment-reviews/actions";

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

/** 제출된 비공개 피드백을 학생에게 공개합니다. */
export function PublishFeedbackForm({ reviewId, version }: { reviewId: string; version: number }) {
  const [state, action, pending] = useActionState(publishFeedbackAction, initialState);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="reviewId" value={reviewId} />
      <input type="hidden" name="expectedVersion" value={version} />
      <button type="submit" disabled={pending} className={primaryButton}>
        {pending ? "공개 중…" : "학생에게 공개"}
      </button>
      <Result state={state} />
    </form>
  );
}

/** 공개한 피드백을 사유와 함께 비공개로 되돌립니다. */
export function RetractFeedbackForm({ reviewId, version }: { reviewId: string; version: number }) {
  const id = useId();
  const [state, action, pending] = useActionState(retractFeedbackAction, initialState);
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="reviewId" value={reviewId} />
      <input type="hidden" name="expectedVersion" value={version} />
      <label htmlFor={`${id}-reason`} className="block font-medium">
        공개 취소 사유
      </label>
      <input id={`${id}-reason`} name="reason" required maxLength={500} className={inputClass} />
      <button type="submit" disabled={pending} className={primaryButton}>
        {pending ? "취소 중…" : "공개 취소"}
      </button>
      <Result state={state} />
    </form>
  );
}
