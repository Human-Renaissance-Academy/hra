"use client";
/**
 * #163 학사 운영 관리자의 수료 기준 작성·수정·공개와 수료 결정 폼입니다.
 *
 * - 사용 위치: `/member/academic-operations/completion` 화면.
 * - 요청 ID는 제출할 때마다 새로 만들어 서버 멱등성 키로 넘깁니다(렌더 중 난수 생성으로 인한 hydration 불일치 방지).
 * - 수료 결정은 화면에서 본 현재 순번을 함께 보내 다른 관리자가 먼저 결정했으면 서버가 거부합니다.
 * - 보조 지표는 참고용이며 결정 값을 자동으로 채우지 않습니다(자동 수료 없음).
 */
import { useActionState, useId } from "react";
import {
  createCriteriaAction,
  publishCriteriaAction,
  recordDecisionAction,
  updateCriteriaAction,
  type CompletionActionState,
} from "@/features/academics/completion/actions";
import {
  COMPLETION_REASON_NOTICE,
  COMPLETION_STATUS_LABELS,
  type CompletionCriteria,
  type CompletionStatus,
} from "@/features/academics/completion/contracts";

const inputClass = "w-full rounded border border-[#D9D9D9] p-2";
const primaryButton =
  "rounded bg-[#1a1a1a] px-4 py-2 text-white hover:bg-[#333333] disabled:opacity-50";
const initialState: CompletionActionState = { status: "idle" };

/** 서버 액션 앞에서 새 요청 ID만 붙이는 래퍼입니다. */
function withRequestId(
  action: (previous: CompletionActionState, formData: FormData) => Promise<CompletionActionState>,
) {
  return (previous: CompletionActionState, formData: FormData) => {
    formData.set("requestId", crypto.randomUUID());
    return action(previous, formData);
  };
}

function Result({ state }: { state: CompletionActionState }) {
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

/** 사유 입력. 개인정보 금지 안내를 함께 읽어 줍니다. */
function ReasonField({ id, label }: { id: string; label: string }) {
  return (
    <div className="space-y-1">
      <label htmlFor={`${id}-reason`} className="block font-medium">
        {label}
      </label>
      <textarea
        id={`${id}-reason`}
        name="reason"
        required
        maxLength={500}
        rows={2}
        className={inputClass}
        aria-describedby={`${id}-reason-help`}
      />
      <p id={`${id}-reason-help`} className="text-sm text-[#666666]">
        {COMPLETION_REASON_NOTICE}
      </p>
    </div>
  );
}

/** 기준 내용 입력(작성·수정 공용). 수정 시 현재 초안 값을 기본값으로 채웁니다. */
function CriteriaFields({ id, defaults }: { id: string; defaults?: CompletionCriteria }) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <label htmlFor={`${id}-attendance`} className="block font-medium">
            최소 출석률(%)
          </label>
          <input
            id={`${id}-attendance`}
            name="minAttendancePercent"
            type="number"
            min={0}
            max={100}
            step={1}
            required
            defaultValue={defaults?.minAttendancePercent ?? 80}
            className={inputClass}
          />
        </div>
        <div className="space-y-1">
          <label htmlFor={`${id}-submissions`} className="block font-medium">
            필요한 과제 제출 수
          </label>
          <input
            id={`${id}-submissions`}
            name="requiredSubmissionCount"
            type="number"
            min={0}
            max={1000}
            step={1}
            required
            defaultValue={defaults?.requiredSubmissionCount ?? 0}
            className={inputClass}
          />
        </div>
      </div>
      <div className="flex flex-wrap gap-6">
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="countLateAsAttended"
            defaultChecked={defaults?.countLateAsAttended ?? true}
          />
          지각을 출석으로 셈
        </label>
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="countExcusedAsAttended"
            defaultChecked={defaults?.countExcusedAsAttended ?? true}
          />
          인정결석을 출석으로 셈
        </label>
      </div>
      <div className="space-y-1">
        <label htmlFor={`${id}-notes`} className="block font-medium">
          비고(선택)
        </label>
        <textarea
          id={`${id}-notes`}
          name="notes"
          maxLength={2000}
          rows={2}
          defaultValue={defaults?.notes ?? ""}
          className={inputClass}
        />
      </div>
    </>
  );
}

/** 새 기준 초안 작성. 기수당 초안은 하나이며 버전 번호는 서버가 이어서 붙입니다. */
export function CreateCriteriaForm({ cohortId }: { cohortId: string }) {
  const id = useId();
  const [state, action, pending] = useActionState(
    withRequestId(createCriteriaAction),
    initialState,
  );
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="cohortId" value={cohortId} />
      <CriteriaFields id={id} />
      <ReasonField id={id} label="작성·변경 사유" />
      <button type="submit" disabled={pending} className={primaryButton}>
        새 기준 초안 만들기
      </button>
      <Result state={state} />
    </form>
  );
}

/** 초안 수정. 공개된 기준은 서버가 거부합니다. */
export function UpdateCriteriaForm({
  criteriaVersionId,
  defaults,
}: {
  criteriaVersionId: string;
  defaults: CompletionCriteria;
}) {
  const id = useId();
  const [state, action, pending] = useActionState(
    withRequestId(updateCriteriaAction),
    initialState,
  );
  return (
    <form action={action} className="space-y-3">
      <input type="hidden" name="criteriaVersionId" value={criteriaVersionId} />
      <CriteriaFields id={id} defaults={defaults} />
      <ReasonField id={id} label="수정 사유" />
      <button type="submit" disabled={pending} className={primaryButton}>
        초안 고치기
      </button>
      <Result state={state} />
    </form>
  );
}

/** 초안 공개. 공개 뒤에는 내용을 바꿀 수 없다는 점을 버튼 설명으로 알립니다. */
export function PublishCriteriaForm({
  criteriaVersionId,
  version,
}: {
  criteriaVersionId: string;
  version: number;
}) {
  const id = useId();
  const [state, action, pending] = useActionState(
    withRequestId(publishCriteriaAction),
    initialState,
  );
  return (
    <form action={action} className="space-y-2">
      <input type="hidden" name="criteriaVersionId" value={criteriaVersionId} />
      <p id={`${id}-help`} className="text-sm text-[#666666]">
        공개한 기준은 내용을 바꿀 수 없습니다. 바꾸려면 새 버전을 만들어야 합니다.
      </p>
      <button
        type="submit"
        disabled={pending}
        className={primaryButton}
        aria-describedby={`${id}-help`}
      >
        {version}판 기준 공개
      </button>
      <Result state={state} />
    </form>
  );
}

/** 학적별 수료 결정. 현재 상태에 따라 고를 수 있는 결정만 보여 줍니다(취소는 수료 상태에서만). */
export function DecisionForm({
  enrollmentId,
  displayName,
  criteriaVersionId,
  criteriaVersion,
  currentStatus,
  currentSequence,
}: {
  enrollmentId: string;
  displayName: string;
  criteriaVersionId: string;
  criteriaVersion: number;
  currentStatus: CompletionStatus;
  currentSequence: number;
}) {
  const id = useId();
  const [state, action, pending] = useActionState(
    withRequestId(recordDecisionAction),
    initialState,
  );
  const options = (["COMPLETED", "NOT_COMPLETED", "REVOKED"] as const).filter(
    (option) => option !== "REVOKED" || currentStatus === "COMPLETED",
  );
  return (
    <form action={action} className="space-y-2" aria-label={`${displayName} 수료 결정`}>
      <input type="hidden" name="enrollmentId" value={enrollmentId} />
      <input type="hidden" name="criteriaVersionId" value={criteriaVersionId} />
      <input type="hidden" name="expectedSequence" value={currentSequence} />
      <div className="space-y-1">
        <label htmlFor={`${id}-decision`} className="block font-medium">
          결정({criteriaVersion}판 기준 적용)
        </label>
        <select
          id={`${id}-decision`}
          name="decision"
          required
          defaultValue=""
          className={inputClass}
        >
          <option value="" disabled>
            결정을 선택해 주세요
          </option>
          {options.map((option) => (
            <option key={option} value={option}>
              {COMPLETION_STATUS_LABELS[option]}
            </option>
          ))}
        </select>
      </div>
      <ReasonField id={id} label="결정 사유" />
      <button type="submit" disabled={pending} className={primaryButton}>
        결정 기록
      </button>
      <Result state={state} />
    </form>
  );
}
