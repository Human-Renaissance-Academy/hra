"use client";
/**
 * #160 출결 정정 요청 폼(운영 인력용)입니다.
 *
 * - 입력 기간이 지난 셀의 변경, 그리고 기간과 무관한 인정결석 지정·해제에 사용합니다(P7·P8).
 * - 요청한 값은 다른 담당자(인정결석은 학사 운영 관리자)가 승인해야 반영됩니다. 승인 전에는 현재 값이 유지됩니다.
 * - 사유에는 개인정보·민감정보를 적지 않도록 안내합니다. 증빙 원본은 받지 않고 확인 방식만 기록합니다.
 */
import { useActionState, useId, useState } from "react";
import {
  requestCorrectionAction,
  type AttendanceActionState,
} from "@/features/academics/attendance/actions";
import type { AttendanceStatus } from "@/features/academics/attendance/contracts";
import {
  ATTENDANCE_STATUS_LABELS,
  EXCUSE_METHOD_LABELS,
  REASON_PRIVACY_NOTICE,
} from "@/features/academics/attendance/labels";

export function CorrectionRequestForm({
  scheduleEventId,
  enrollmentId,
  expectedVersion,
  options,
  studentName,
}: {
  scheduleEventId: string;
  enrollmentId: string;
  expectedVersion: number;
  // 현재 상태·입력 기간에 따라 서버 규칙상 요청 가능한 상태만 넘깁니다.
  options: AttendanceStatus[];
  studentName: string;
}) {
  const id = useId();
  const [requested, setRequested] = useState<AttendanceStatus | "">("");
  const [state, action, pending] = useActionState<AttendanceActionState, FormData>(
    async (previous, formData) => {
      formData.set("requestId", crypto.randomUUID());
      return requestCorrectionAction(previous, formData);
    },
    { status: "idle" },
  );
  const inputClass = "w-full rounded border border-[#D9D9D9] p-2";

  return (
    <form action={action} className="mt-2 space-y-3" aria-label={`${studentName} 출결 정정 요청`}>
      <input type="hidden" name="scheduleEventId" value={scheduleEventId} />
      <input type="hidden" name="enrollmentId" value={enrollmentId} />
      <input type="hidden" name="expectedVersion" value={expectedVersion} />
      <div className="space-y-1">
        <label htmlFor={`${id}-status`} className="block text-sm font-medium">
          요청할 상태
        </label>
        <select
          id={`${id}-status`}
          name="requestedStatus"
          required
          className={inputClass}
          value={requested}
          onChange={(event) => setRequested(event.target.value as AttendanceStatus | "")}
        >
          <option value="" disabled>
            상태를 선택해 주세요
          </option>
          {options.map((status) => (
            <option key={status} value={status}>
              {ATTENDANCE_STATUS_LABELS[status]}
            </option>
          ))}
        </select>
      </div>
      {requested === "EXCUSED" && (
        <div className="space-y-1">
          <label htmlFor={`${id}-excuse`} className="block text-sm font-medium">
            인정결석 확인 방식
          </label>
          <select
            id={`${id}-excuse`}
            name="excuseVerificationMethod"
            required
            defaultValue=""
            className={inputClass}
          >
            <option value="" disabled>
              확인 방식을 선택해 주세요
            </option>
            {(Object.keys(EXCUSE_METHOD_LABELS) as (keyof typeof EXCUSE_METHOD_LABELS)[]).map(
              (method) => (
                <option key={method} value={method}>
                  {EXCUSE_METHOD_LABELS[method]}
                </option>
              ),
            )}
          </select>
          <p className="text-sm text-[#666666]">
            증빙 원본은 이 시스템에 올리거나 적지 않습니다. 확인한 방식만 선택하세요.
          </p>
        </div>
      )}
      <div className="space-y-1">
        <label htmlFor={`${id}-reason`} className="block text-sm font-medium">
          정정 사유
        </label>
        <textarea
          id={`${id}-reason`}
          name="reason"
          required
          maxLength={500}
          rows={3}
          className={inputClass}
          aria-describedby={`${id}-reason-help`}
        />
        <p id={`${id}-reason-help`} className="text-sm text-[#666666]">
          {REASON_PRIVACY_NOTICE}
        </p>
      </div>
      <button
        type="submit"
        disabled={pending || options.length === 0}
        className="rounded bg-[#1a1a1a] px-4 py-2 text-sm text-white hover:bg-[#333333] disabled:opacity-50"
      >
        {pending ? "요청 중…" : "정정 요청"}
      </button>
      {state.status === "error" && (
        <p role="alert" className="text-sm text-red-700">
          {state.message}
        </p>
      )}
      {state.status === "success" && (
        <p role="status" className="text-sm">
          {state.message}
        </p>
      )}
    </form>
  );
}
