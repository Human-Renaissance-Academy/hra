"use client";
/**
 * #160 출결 정정 요청 승인·반려 폼입니다.
 *
 * - 사용 위치: 운영 인력 출결표(`/member/attendance/staff`)와 학사 운영 관리자 화면(`/member/academic-operations`).
 * - 요청 ID는 제출할 때마다 새로 만들어 서버 멱등성 키로 넘깁니다(렌더 중 난수 생성으로 인한 hydration 불일치 방지).
 * - 자기 승인 금지·결정 권한(인정결석은 학사 운영 관리자만)은 서버가 다시 판정합니다. 이 폼의 숨김은 안내용입니다.
 */
import { useActionState } from "react";
import {
  decideCorrectionAction,
  type AttendanceActionState,
} from "@/features/academics/attendance/actions";

export function CorrectionDecisionForm({
  correctionId,
  label,
}: {
  correctionId: string;
  label: string;
}) {
  const [state, action, pending] = useActionState<AttendanceActionState, FormData>(
    async (previous, formData) => {
      formData.set("requestId", crypto.randomUUID());
      return decideCorrectionAction(previous, formData);
    },
    { status: "idle" },
  );

  return (
    <form
      action={action}
      className="flex flex-wrap items-center gap-2"
      aria-label={`${label} 정정 결정`}
    >
      <input type="hidden" name="correctionId" value={correctionId} />
      <button
        type="submit"
        name="decision"
        value="APPROVE"
        disabled={pending}
        className="rounded bg-[#1a1a1a] px-3 py-1.5 text-sm text-white hover:bg-[#333333] disabled:opacity-50"
      >
        승인
      </button>
      <button
        type="submit"
        name="decision"
        value="REJECT"
        disabled={pending}
        className="rounded border border-[#D9D9D9] px-3 py-1.5 text-sm hover:bg-gray-50 disabled:opacity-50"
      >
        반려
      </button>
      {pending && <span className="text-sm text-[#666666]">처리 중…</span>}
      {state.status === "error" && (
        <p role="alert" className="w-full text-sm text-red-700">
          {state.message}
        </p>
      )}
      {state.status === "success" && (
        <p role="status" className="w-full text-sm text-[#1a1a1a]">
          {state.message}
        </p>
      )}
    </form>
  );
}
