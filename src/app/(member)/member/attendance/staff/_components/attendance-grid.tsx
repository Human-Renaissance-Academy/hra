"use client";
/**
 * #160 운영 인력용 수업일 출결표(학생 × 상태 버튼)입니다.
 *
 * - 서버가 내려준 최소 명단(표시 이름)·셀 상태·버전만 사용합니다. 다른 학생 정보는 받지 않습니다.
 * - 저장은 셀마다 본 버전(`expectedVersion`)을 함께 보내 덮어쓰기를 막습니다. 다른 담당자가 먼저 바꿨으면
 *   VERSION_CONFLICT 안내 후 최신 값을 다시 읽습니다(router.refresh).
 * - 상태는 글자(출석/지각/결석/인정결석/미입력)와 aria-pressed로 표시해 색에만 의존하지 않습니다.
 *   모든 조작은 기본 버튼·폼이라 키보드(Tab·Enter·Space)로 사용할 수 있습니다.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { recordAttendanceAction } from "@/features/academics/attendance/actions";
import type {
  AttendanceEventSheet,
  AttendanceStatus,
} from "@/features/academics/attendance/contracts";
import {
  DIRECT_STATUSES,
  correctionOptions,
  entryWindowState,
} from "@/features/academics/attendance/grid-rules";
import { ATTENDANCE_STATUS_LABELS } from "@/features/academics/attendance/labels";
import { formatKstDateTime } from "@/lib/date-time";
import { CorrectionDecisionForm } from "@/components/academics/correction-decision-form";
import { CorrectionRequestForm } from "./correction-request-form";

type Entry = AttendanceEventSheet["entries"][number];
type Notice = { kind: "error" | "status"; text: string } | null;

export function AttendanceGrid({
  sheet,
  serverNow,
  currentUserId,
}: {
  sheet: AttendanceEventSheet;
  serverNow: string;
  currentUserId: string;
}) {
  const router = useRouter();
  // 저장 성공 결과를 즉시 반영하기 위한 화면 사본. 서버 값이 바뀌면 상위에서 key로 다시 마운트합니다.
  const [entries, setEntries] = useState<Entry[]>(sheet.entries);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const windowState = entryWindowState(serverNow, sheet.windowOpensAt, sheet.windowClosesAt);
  const canEdit = windowState === "OPEN";
  const unmarked = entries.filter(
    (entry) => entry.status === "UNMARKED" && !entry.pendingCorrection,
  );

  /** 셀 하나를 저장합니다. 성공하면 상태·버전을 갱신하고, 실패하면 이유를 알립니다. */
  async function save(entry: Entry, status: AttendanceStatus): Promise<boolean> {
    const result = await recordAttendanceAction({
      requestId: crypto.randomUUID(),
      scheduleEventId: sheet.scheduleEventId,
      enrollmentId: entry.enrollmentId,
      status,
      expectedVersion: entry.version,
    });
    if (result.ok) {
      setEntries((current) =>
        current.map((item) =>
          item.enrollmentId === entry.enrollmentId
            ? {
                ...item,
                status: result.status,
                version: result.version,
                recordedAt: result.recordedAt,
              }
            : item,
        ),
      );
      return true;
    }
    if (result.code === "VERSION_CONFLICT") {
      setNotice({
        kind: "error",
        text: `${entry.displayName}: ${result.message} 최신 출결을 다시 불러옵니다.`,
      });
      router.refresh();
    } else {
      setNotice({ kind: "error", text: `${entry.displayName}: ${result.message}` });
    }
    return false;
  }

  async function handleStatus(entry: Entry, status: AttendanceStatus) {
    setSavingId(entry.enrollmentId);
    setNotice(null);
    const saved = await save(entry, status);
    if (saved) {
      setNotice({
        kind: "status",
        text: `${entry.displayName}: ${ATTENDANCE_STATUS_LABELS[status]}(으)로 저장했습니다.`,
      });
    }
    setSavingId(null);
  }

  /** 미입력 학생을 한 명씩 출석으로 저장합니다. 일부 실패해도 나머지는 계속 진행하고 결과를 요약합니다. */
  async function markAllPresent() {
    setSavingId("ALL");
    setNotice(null);
    let saved = 0;
    const failed: string[] = [];
    for (const entry of unmarked) {
      if (await save(entry, "PRESENT")) saved += 1;
      else failed.push(entry.displayName);
    }
    setNotice(
      failed.length
        ? {
            kind: "error",
            text: `${saved}명 저장, ${failed.length}명 실패(${failed.join(", ")}). 실패한 학생은 다시 확인해 주세요.`,
          }
        : { kind: "status", text: `미입력 학생 ${saved}명을 출석으로 저장했습니다.` },
    );
    setSavingId(null);
  }

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-[#D9D9D9] p-4 shadow-[var(--shadow-soft)]">
        <p className="font-semibold">
          입력 기간: {formatKstDateTime(new Date(sheet.windowOpensAt))} 부터{" "}
          {formatKstDateTime(new Date(sheet.windowClosesAt))} 전까지
        </p>
        <p className="mt-1 text-[#666666]">
          {windowState === "OPEN" &&
            "지금 직접 입력·수정할 수 있습니다. 인정결석은 정정 요청으로만 지정합니다."}
          {windowState === "BEFORE" &&
            "아직 입력 기간이 아닙니다. 수업일 당일부터 입력할 수 있습니다."}
          {windowState === "CLOSED" &&
            "입력 기간이 지났습니다. 변경하려면 정정 요청을 남기고 다른 담당자의 승인을 받아야 합니다."}
        </p>
      </div>

      {canEdit && unmarked.length > 0 && (
        <button
          type="button"
          onClick={markAllPresent}
          disabled={savingId !== null}
          className="rounded border border-[#D9D9D9] px-4 py-2 hover:bg-gray-50 disabled:opacity-50"
        >
          미입력 학생 {unmarked.length}명 모두 출석으로 저장
        </button>
      )}

      <div aria-live="polite" className="min-h-6">
        {notice && (
          <p
            role={notice.kind === "error" ? "alert" : "status"}
            className={notice.kind === "error" ? "text-red-700" : ""}
          >
            {notice.text}
          </p>
        )}
      </div>

      {entries.length === 0 ? (
        <p>이 수업일의 출결 대상 학생이 없습니다.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <caption className="sr-only">수업일 출결표. 학생별 현재 상태와 입력 버튼</caption>
            <thead>
              <tr className="border-b border-[#D9D9D9]">
                <th scope="col" className="p-3">
                  학생
                </th>
                <th scope="col" className="p-3">
                  현재 상태
                </th>
                <th scope="col" className="p-3">
                  입력
                </th>
                <th scope="col" className="p-3">
                  정정
                </th>
              </tr>
            </thead>
            <tbody>
              {entries.map((entry) => {
                const pending = entry.pendingCorrection;
                const options = pending ? [] : correctionOptions(entry.status, windowState);
                const excuseRelated =
                  pending &&
                  (pending.requestedStatus === "EXCUSED" || pending.previousStatus === "EXCUSED");
                return (
                  <tr key={entry.enrollmentId} className="border-b border-[#D9D9D9] align-top">
                    <th scope="row" className="p-3 font-medium">
                      {entry.displayName}
                    </th>
                    <td className="p-3">
                      <span
                        className={entry.status === "UNMARKED" ? "text-[#666666]" : "font-semibold"}
                      >
                        {ATTENDANCE_STATUS_LABELS[entry.status]}
                      </span>
                      {entry.recordedAt && (
                        <span className="block text-sm text-[#666666]">
                          {formatKstDateTime(new Date(entry.recordedAt))} 기록
                        </span>
                      )}
                    </td>
                    <td className="p-3">
                      <div
                        role="group"
                        aria-label={`${entry.displayName} 출결 입력`}
                        className="flex flex-wrap gap-2"
                      >
                        {DIRECT_STATUSES.map((status) => {
                          const selected = entry.status === status;
                          return (
                            <button
                              key={status}
                              type="button"
                              aria-pressed={selected}
                              disabled={
                                !canEdit ||
                                Boolean(pending) ||
                                entry.status === "EXCUSED" ||
                                savingId !== null
                              }
                              onClick={() => handleStatus(entry, status)}
                              className={`rounded border px-3 py-1.5 text-sm disabled:opacity-50 ${
                                selected
                                  ? "border-[#1a1a1a] bg-[#1a1a1a] font-semibold text-white"
                                  : "border-[#D9D9D9] hover:bg-gray-50"
                              }`}
                            >
                              {selected
                                ? `✓ ${ATTENDANCE_STATUS_LABELS[status]}`
                                : ATTENDANCE_STATUS_LABELS[status]}
                            </button>
                          );
                        })}
                      </div>
                      {savingId === entry.enrollmentId && (
                        <span className="text-sm text-[#666666]">저장 중…</span>
                      )}
                    </td>
                    <td className="p-3">
                      {pending ? (
                        <div className="space-y-2">
                          <p>
                            정정 결정 대기: {ATTENDANCE_STATUS_LABELS[pending.previousStatus]} →{" "}
                            {ATTENDANCE_STATUS_LABELS[pending.requestedStatus]}
                          </p>
                          <p className="text-sm text-[#666666]">
                            사유:{" "}
                            {pending.reason ??
                              "인정결석 관련 사유는 학사 운영 관리자만 볼 수 있습니다."}
                          </p>
                          {pending.requestedByUserId === currentUserId ? (
                            <p className="text-sm text-[#666666]">
                              본인이 요청한 정정은 다른 담당자가 결정합니다.
                            </p>
                          ) : excuseRelated && pending.reason === null ? (
                            <p className="text-sm text-[#666666]">
                              인정결석 관련 정정은 학사 운영 관리자가 결정합니다.
                            </p>
                          ) : (
                            <CorrectionDecisionForm
                              correctionId={pending.id}
                              label={entry.displayName}
                            />
                          )}
                        </div>
                      ) : options.length > 0 ? (
                        <details>
                          <summary className="cursor-pointer text-[#2563EB] underline">
                            정정 요청
                          </summary>
                          <CorrectionRequestForm
                            scheduleEventId={sheet.scheduleEventId}
                            enrollmentId={entry.enrollmentId}
                            expectedVersion={entry.version}
                            options={options}
                            studentName={entry.displayName}
                          />
                        </details>
                      ) : (
                        <span className="text-sm text-[#666666]">-</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
