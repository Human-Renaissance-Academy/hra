"use client";

/** 비공개 원본 주소 대신 현재 로그인 보호 수업일지 주소를 복사합니다. */
import { useState } from "react";
import { Button } from "@/components/ui/button";

export function ClassLogDocumentShare() {
  const [message, setMessage] = useState("");

  async function copy() {
    try {
      await navigator.clipboard.writeText(window.location.origin + window.location.pathname);
      setMessage("수업일지 주소를 복사했습니다.");
    } catch {
      setMessage("복사할 수 없습니다. 주소창의 수업일지 주소를 복사해 주세요.");
    }
  }

  return (
    <div className="space-y-1">
      <Button type="button" size="sm" variant="outline" onClick={copy}>
        공유 링크 복사
      </Button>
      <p role="status" className="text-sm">
        {message}
      </p>
    </div>
  );
}
