"use client";
/**
 * #160 학사 운영 관리자의 운영 인력 배정·종료·교체 폼입니다.
 *
 * - 요청 ID는 제출할 때마다 새로 만들어 서버 멱등성 키로 넘깁니다(렌더 중 난수 생성으로 인한 hydration 불일치 방지).
 * - 대상 계정은 이메일·이름 일치로 추정하지 않고, 별도 확인 절차를 거친 계정 식별자(UUID)로만 지정합니다.
 * - 사유·확인 근거에는 개인정보를 적지 않도록 안내합니다. 관리자 지정·상한·기간 중복은 서버가 다시 판정합니다.
 */
import { useActionState, useId } from "react";
import {
  assignStaffAction,
  endStaffAction,
  replaceStaffAction,
  type StaffActionState,
} from "@/features/academics/staff/actions";
import { REASON_PRIVACY_NOTICE, STAFF_ROLE_LABELS } from "@/features/academics/attendance/labels";

const inputClass = "w-full rounded border border-[#D9D9D9] p-2";
const primaryButton =
  "rounded bg-[#1a1a1a] px-4 py-2 text-white hover:bg-[#333333] disabled:opacity-50";
const initialState: StaffActionState = { status: "idle" };

/** 서버 액션 앞에서 새 요청 ID만 붙이는 래퍼입니다. */
function withRequestId(
  action: (previous: StaffActionState, formData: FormData) => Promise<StaffActionState>,
) {
  return (previous: StaffActionState, formData: FormData) => {
    formData.set("requestId", crypto.randomUUID());
    return action(previous, formData);
  };
}

function Result({ state }: { state: StaffActionState }) {
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

/** 대상 계정·연결 확인 방식·확인 근거 참조 입력(배정·교체 공용). */
function AccountFields({ id }: { id: string }) {
  return (
    <>
      <div className="space-y-1">
        <label htmlFor={`${id}-user`} className="block font-medium">
          대상 계정 식별자
        </label>
        <input
          id={`${id}-user`}
          name="userId"
          required
          className={inputClass}
          aria-describedby={`${id}-user-help`}
        />
        <p id={`${id}-user-help`} className="text-sm text-[#666666]">
          본인 확인을 마친 로그인 계정의 식별자(UUID)를 입력하세요. 이름·이메일만으로 계정을
          연결하지 않습니다. 승인 대기 계정과 본인 계정은 배정할 수 없습니다.
        </p>
      </div>
      <div className="space-y-1">
        <label htmlFor={`${id}-verification`} className="block font-medium">
          계정 연결 확인 방식
        </label>
        <select
          id={`${id}-verification`}
          name="verificationMethod"
          required
          defaultValue=""
          className={inputClass}
        >
          <option value="" disabled>
            확인 방식을 선택해 주세요
          </option>
          <option value="IN_PERSON">대면 확인</option>
          <option value="VERIFIED_CONTACT">검증된 연락 경로 확인</option>
        </select>
      </div>
      <div className="space-y-1">
        <label htmlFor={`${id}-evidence`} className="block font-medium">
          확인 근거 참조 식별자
        </label>
        <input
          id={`${id}-evidence`}
          name="evidenceReference"
          required
          className={inputClass}
          aria-describedby={`${id}-evidence-help`}
        />
        <p id={`${id}-evidence-help`} className="text-sm text-[#666666]">
          운영자가 별도로 관리하는 확인 기록의 식별자(UUID)를 입력하세요. 증빙
          원문·전화번호·이메일은 입력하지 마세요.
        </p>
      </div>
    </>
  );
}

/** 사유 입력(종료·교체 공용). 개인정보 금지 안내를 함께 읽어 줍니다. */
function ReasonField({ id }: { id: string }) {
  return (
    <div className="space-y-1">
      <label htmlFor={`${id}-reason`} className="block font-medium">
        사유
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
        {REASON_PRIVACY_NOTICE}
      </p>
    </div>
  );
}

/** 적용 시각(선택). 비우면 서버의 현재 시각에 적용합니다. 과거 시각은 서버가 거부합니다. */
function InstantField({ id, name, label }: { id: string; name: string; label: string }) {
  return (
    <div className="space-y-1">
      <label htmlFor={`${id}-${name}`} className="block font-medium">
        {label} (선택, 한국시간)
      </label>
      <input
        id={`${id}-${name}`}
        name={name}
        type="datetime-local"
        className={inputClass}
        aria-describedby={`${id}-${name}-help`}
      />
      <p id={`${id}-${name}-help`} className="text-sm text-[#666666]">
        비워 두면 지금 바로 적용합니다. 지난 시각으로 소급할 수 없습니다.
      </p>
    </div>
  );
}

export function AssignStaffForm({ cohorts }: { cohorts: { id: string; name: string }[] }) {
  const id = useId();
  const [state, action, pending] = useActionState(withRequestId(assignStaffAction), initialState);
  return (
    <form action={action} className="max-w-xl space-y-4" aria-label="운영 인력 배정">
      <div className="space-y-1">
        <label htmlFor={`${id}-cohort`} className="block font-medium">
          기수
        </label>
        <select id={`${id}-cohort`} name="cohortId" required defaultValue="" className={inputClass}>
          <option value="" disabled>
            기수를 선택해 주세요
          </option>
          {cohorts.map((cohort) => (
            <option key={cohort.id} value={cohort.id}>
              {cohort.name}
            </option>
          ))}
        </select>
      </div>
      <div className="space-y-1">
        <label htmlFor={`${id}-role`} className="block font-medium">
          역할
        </label>
        <select id={`${id}-role`} name="staffRole" required defaultValue="" className={inputClass}>
          <option value="" disabled>
            역할을 선택해 주세요
          </option>
          <option value="ADVISOR">{STAFF_ROLE_LABELS.ADVISOR}</option>
          <option value="ASSISTANT">{STAFF_ROLE_LABELS.ASSISTANT}</option>
        </select>
      </div>
      <AccountFields id={id} />
      <InstantField id={id} name="validFrom" label="시작 시각" />
      <InstantField id={id} name="validTo" label="종료 예정 시각" />
      <p className="text-sm text-[#666666]">
        같은 기간에 어드바이저는 1명, 조교는 2명까지 배정할 수 있습니다.
      </p>
      <button type="submit" disabled={pending || cohorts.length === 0} className={primaryButton}>
        {pending ? "배정 중…" : "배정"}
      </button>
      <Result state={state} />
    </form>
  );
}

export function EndStaffForm({ assignmentId, label }: { assignmentId: string; label: string }) {
  const id = useId();
  const [state, action, pending] = useActionState(withRequestId(endStaffAction), initialState);
  return (
    <form action={action} className="mt-2 space-y-3" aria-label={`${label} 배정 종료`}>
      <input type="hidden" name="assignmentId" value={assignmentId} />
      <InstantField id={id} name="effectiveAt" label="종료 시각" />
      <ReasonField id={id} />
      <button type="submit" disabled={pending} className={primaryButton}>
        {pending ? "처리 중…" : "배정 종료"}
      </button>
      <Result state={state} />
    </form>
  );
}

export function ReplaceStaffForm({ assignmentId, label }: { assignmentId: string; label: string }) {
  const id = useId();
  const [state, action, pending] = useActionState(withRequestId(replaceStaffAction), initialState);
  return (
    <form action={action} className="mt-2 space-y-3" aria-label={`${label} 교체`}>
      <input type="hidden" name="assignmentId" value={assignmentId} />
      <AccountFields id={id} />
      <InstantField id={id} name="effectiveAt" label="교체 시각" />
      <ReasonField id={id} />
      <button type="submit" disabled={pending} className={primaryButton}>
        {pending ? "처리 중…" : "교체"}
      </button>
      <Result state={state} />
    </form>
  );
}
