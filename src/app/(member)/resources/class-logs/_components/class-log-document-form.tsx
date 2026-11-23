"use client";

/**
 * 회원 자료실의 문서형 수업일지와 수정본 등록 폼입니다.
 * 파일은 비공개 저장소로 직접 전송하고, 결과는 기존 일지 상세에서 표시합니다.
 */
import { useId, useRef, useState, type FormEvent } from "react";
import { MAX_DOCUMENT_BYTES } from "@/features/academics/assignment-uploads/formats/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  ClassLogDocumentUploadError,
  submitClassLogDocument,
  type ClassLogDocumentAttempt,
} from "./class-log-document-upload";

type ClassLogDocumentFormProps =
  | {
      mode: "create";
      cohorts: ReadonlyArray<{ id: string; name: string }>;
      lockedCohortId?: string | null;
    }
  | { mode: "revision"; logId: string; version: number };

/** 미선택인 파일 입력은 브라우저가 빈 파일로 반환할 수 있습니다. */
function readFile(form: FormData, name: string) {
  const file = form.get(name);
  return file instanceof File && file.name ? file : undefined;
}

function readText(form: FormData, name: string) {
  const value = form.get(name);
  return typeof value === "string" ? value.trim() : "";
}

export function ClassLogDocumentForm(props: ClassLogDocumentFormProps) {
  const id = useId();
  const attempt = useRef<ClassLogDocumentAttempt | null>(null);
  const submitting = useRef(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [weekNumber, setWeekNumber] = useState("");
  const create = props.mode === "create";
  const week = Number(weekNumber);
  const suggestedTitle = `${week}주차 수업일지`;
  const defaultTitle = week > 0 ? suggestedTitle : "주차를 입력하면 제목이 채워집니다.";

  function resetAttempt() {
    attempt.current = null;
    setError("");
  }

  /** 입력이 바뀔 때 새 요청 번호를 쓰고 같은 입력의 재시도에는 기존 번호를 유지합니다. */
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting.current) return;
    setError("");
    const form = new FormData(event.currentTarget);
    const pdf = readFile(form, "pdf");
    const hangul = readFile(form, "hangul");
    const isHwpx = hangul?.name.toLowerCase().endsWith(".hwpx");

    if (!pdf && !hangul) {
      setError("등록할 파일을 한 개 이상 선택해 주세요.");
      return;
    }
    if (pdf && (!pdf.size || !pdf.name.toLowerCase().endsWith(".pdf"))) {
      setError("비어 있지 않은 PDF 파일을 선택해 주세요.");
      return;
    }
    if (hangul && (!hangul.size || (!isHwpx && !hangul.name.toLowerCase().endsWith(".hwp")))) {
      setError("비어 있지 않은 HWP 또는 HWPX 파일을 선택해 주세요.");
      return;
    }

    if ((pdf && pdf.size > MAX_DOCUMENT_BYTES) || (hangul && hangul.size > MAX_DOCUMENT_BYTES)) {
      setError("파일은 각각 50MB 이하로 선택해 주세요.");
      return;
    }

    const classDay = readText(form, "classDay");
    const cohortId = create ? props.lockedCohortId || readText(form, "cohortId") : "";
    if (
      create &&
      (!cohortId ||
        !/^\d{4}-\d{2}-\d{2}$/.test(classDay) ||
        !Number.isInteger(week) ||
        week < 1 ||
        week > 999)
    ) {
      setError("기수, 수업 날짜와 주차를 확인해 주세요.");
      return;
    }

    const content = form.get("content");
    const fields = create
      ? {
          title: readText(form, "title") || suggestedTitle,
          content: typeof content === "string" ? content : "",
          classDay,
          weekNumber: week,
          cohortId,
        }
      : {
          logId: props.logId,
          version: props.version,
          changeNote: readText(form, "changeNote") || undefined,
        };

    submitting.current = true;
    setBusy(true);
    let published = false;
    try {
      attempt.current ??= { requestId: crypto.randomUUID(), uploaded: {}, finalizeOnly: false };
      const result = await submitClassLogDocument(
        attempt.current,
        {
          ...fields,
          pdf: pdf && { fileFormat: "PDF", originalName: pdf.name, sizeBytes: pdf.size },
          hangul: hangul && {
            fileFormat: isHwpx ? "HWPX" : "HWP",
            originalName: hangul.name,
            sizeBytes: hangul.size,
          },
        },
        { pdf, hangul },
        setStatus,
      );
      window.location.assign(`/resources/${result.logId}`);
      published = true;
    } catch (failure) {
      if (failure instanceof ClassLogDocumentUploadError && failure.restart) attempt.current = null;
      setError(
        failure instanceof ClassLogDocumentUploadError
          ? failure.message
          : "등록하지 못했습니다. 같은 입력으로 다시 시도해 주세요.",
      );
    } finally {
      if (!published) {
        submitting.current = false;
        setBusy(false);
        setStatus("");
      }
    }
  }

  return (
    <form
      method="post"
      onSubmit={submit}
      onChange={resetAttempt}
      className="space-y-3 rounded-lg border border-[#D9D9D9] p-4 sm:p-5"
    >
      <fieldset disabled={busy} className="min-w-0 space-y-4">
        <legend className="mb-3 text-base font-semibold text-[#1a1a1a]">
          {create ? "수업일지 파일 등록" : "수정본 등록"}
        </legend>
        {create ? (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="min-w-0 space-y-2">
                <Label htmlFor={`${id}-cohort`}>기수</Label>
                <select
                  id={`${id}-cohort`}
                  name="cohortId"
                  required
                  disabled={Boolean(props.lockedCohortId)}
                  defaultValue={props.lockedCohortId ?? ""}
                  className="h-9 w-full rounded-md border border-input bg-background px-2.5 text-sm disabled:opacity-70"
                >
                  <option value="" disabled>
                    기수를 선택하세요
                  </option>
                  {props.cohorts.map((cohort) => (
                    <option key={cohort.id} value={cohort.id}>
                      {cohort.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="min-w-0 space-y-2">
                <Label htmlFor={`${id}-class-day`}>수업 날짜</Label>
                <Input id={`${id}-class-day`} name="classDay" type="date" required />
              </div>
              <div className="min-w-0 space-y-2">
                <Label htmlFor={`${id}-week`}>주차</Label>
                <Input
                  id={`${id}-week`}
                  name="weekNumber"
                  type="number"
                  min={1}
                  max={999}
                  step={1}
                  required
                  value={weekNumber}
                  onChange={(event) => setWeekNumber(event.currentTarget.value)}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${id}-title`}>제목 (선택)</Label>
              <Input id={`${id}-title`} name="title" maxLength={300} placeholder={defaultTitle} />
            </div>
            <div className="space-y-2">
              <Label htmlFor={`${id}-content`}>수업 내용 (선택)</Label>
              <Textarea id={`${id}-content`} name="content" maxLength={15_000} rows={3} />
            </div>
          </>
        ) : (
          <div className="space-y-2">
            <Label htmlFor={`${id}-change-note`}>변경 메모 (선택)</Label>
            <Textarea id={`${id}-change-note`} name="changeNote" maxLength={500} rows={2} />
          </div>
        )}
        <p id={`${id}-files`} className="text-sm text-[#666666]">
          {create
            ? "PDF와 한글 파일 중 한 개 이상 선택하세요."
            : "바꿀 파일을 선택하세요. 선택하지 않은 형식은 현재 파일을 유지합니다."}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="min-w-0 space-y-2">
            <Label htmlFor={`${id}-pdf`}>PDF 파일</Label>
            <Input
              id={`${id}-pdf`}
              name="pdf"
              type="file"
              accept=".pdf,application/pdf"
              aria-describedby={`${id}-files`}
            />
          </div>
          <div className="min-w-0 space-y-2">
            <Label htmlFor={`${id}-hangul`}>한글 파일 (HWP 또는 HWPX)</Label>
            <Input
              id={`${id}-hangul`}
              name="hangul"
              type="file"
              accept=".hwp,.hwpx"
              aria-describedby={`${id}-files`}
            />
          </div>
        </div>
        <Button type="submit" disabled={create && !props.cohorts.length}>
          {busy ? "등록 중" : create ? "수업일지 등록" : "수정본 등록"}
        </Button>
      </fieldset>
      {status && (
        <p role="status" className="text-sm text-[#666666]">
          {status}
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
    </form>
  );
}
