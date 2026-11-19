"use client";

/**
 * 관리자 교수진 목록에서 삭제 액션의 결과를 표시하는 폼입니다.
 * 학사 검토 권한 기록(#161)이 연결된 교수처럼 삭제가 거부되면 한국어 이유를 알리고,
 * 처리 중에는 중복 제출을 막습니다.
 */
import { useActionState } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { deleteFaculty, type FacultyDeleteState } from "@/features/faculty/actions";

const initialState: FacultyDeleteState = { success: false, message: "" };

export function FacultyDeleteButton({ id }: { id: string }) {
  // 서버가 반환한 실패는 그대로 안내하고, 통신 예외는 원문 없이 재시도를 안내합니다.
  const [state, formAction, isPending] = useActionState(async () => {
    try {
      return await deleteFaculty(id);
    } catch {
      return {
        success: false,
        message: "삭제 요청을 완료하지 못했습니다. 잠시 후 다시 시도해주세요.",
      };
    }
  }, initialState);

  return (
    <form action={formAction} className="flex flex-col items-end gap-2">
      <Button type="submit" variant="destructive" disabled={isPending}>
        <Trash2 className="size-3.5" />
        {isPending ? "삭제 중..." : "삭제"}
      </Button>
      {!state.success && state.message && (
        <p role="alert" className="max-w-xs text-left text-sm text-red-600">
          {state.message}
        </p>
      )}
    </form>
  );
}
