/**
 * #160 운영 인력 출결표의 실제 클릭 회귀입니다.
 * 버전 충돌 시 덮어쓰지 않고 안내 후 최신 값을 다시 읽는지, 입력 기간·대기 정정·자기 요청에 따라
 * 조작을 제한하는지, 상태를 글자와 aria-pressed로 표시하는지 확인합니다.
 */
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AttendanceEventSheet } from "@/features/academics/attendance/contracts";

const mocks = vi.hoisted(() => ({
  record: vi.fn(),
  request: vi.fn(),
  decide: vi.fn(),
  refresh: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: mocks.refresh }) }));
vi.mock("@/features/academics/attendance/actions", () => ({
  recordAttendanceAction: mocks.record,
  requestCorrectionAction: mocks.request,
  decideCorrectionAction: mocks.decide,
}));

import { AttendanceGrid } from "@/app/(member)/member/attendance/staff/_components/attendance-grid";

const me = "16000000-0000-4000-8000-0000000000a1";
const other = "16000000-0000-4000-8000-0000000000a2";
const enrollments = [
  "16000000-0000-4000-8000-0000000000b1",
  "16000000-0000-4000-8000-0000000000b2",
];
const sheet = (overrides: Partial<AttendanceEventSheet> = {}): AttendanceEventSheet => ({
  scheduleEventId: "16000000-0000-4000-8000-0000000000c1",
  cohortId: "16000000-0000-4000-8000-0000000000c2",
  classDate: "2026-11-19",
  windowOpensAt: "2026-11-18T15:00:00.000Z",
  windowClosesAt: "2026-11-26T15:00:00.000Z",
  entries: [
    {
      enrollmentId: enrollments[0],
      displayName: "합성 학생 가",
      status: "UNMARKED",
      version: 0,
      recordedAt: null,
      pendingCorrection: null,
    },
    {
      enrollmentId: enrollments[1],
      displayName: "합성 학생 나",
      status: "ABSENT",
      version: 3,
      recordedAt: "2026-11-19T02:00:00.000Z",
      pendingCorrection: null,
    },
  ],
  ...overrides,
});
const open = "2026-11-20T00:00:00.000Z";
const closed = "2026-11-27T00:00:00.000Z";
const row = (name: string) => screen.getByRole("row", { name: new RegExp(name) });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal("crypto", {
    ...globalThis.crypto,
    randomUUID: () => "16000000-0000-4000-8000-0000000000ff",
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("출결표 저장과 충돌 처리", () => {
  it("미입력과 결석을 글자로 구분하고, 저장 성공 시 새 버전과 선택 상태를 반영합니다", async () => {
    mocks.record.mockResolvedValue({
      ok: true,
      status: "PRESENT",
      version: 1,
      recordedAt: "2026-11-20T00:00:00.000Z",
    });
    render(<AttendanceGrid sheet={sheet()} serverNow={open} currentUserId={me} />);
    expect(within(row("합성 학생 가")).getByText("미입력")).toBeTruthy();
    expect(within(row("합성 학생 나")).getAllByText(/결석/).length).toBeGreaterThan(0);

    const group = within(row("합성 학생 가")).getByRole("group", {
      name: "합성 학생 가 출결 입력",
    });
    fireEvent.click(within(group).getByRole("button", { name: "출석" }));
    await waitFor(() =>
      expect(
        within(group).getByRole("button", { name: "✓ 출석" }).getAttribute("aria-pressed"),
      ).toBe("true"),
    );
    expect(mocks.record).toHaveBeenCalledWith({
      requestId: "16000000-0000-4000-8000-0000000000ff",
      scheduleEventId: "16000000-0000-4000-8000-0000000000c1",
      enrollmentId: enrollments[0],
      status: "PRESENT",
      expectedVersion: 0,
    });
    expect((await screen.findByRole("status")).textContent).toContain("출석(으)로 저장했습니다");
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("다른 담당자가 먼저 바꿨으면 덮어쓰지 않고 충돌을 알린 뒤 최신 값을 다시 읽습니다", async () => {
    mocks.record.mockResolvedValue({
      ok: false,
      code: "VERSION_CONFLICT",
      message: "다른 사람이 먼저 출결을 바꿨습니다. 다시 조회해 주세요.",
    });
    render(<AttendanceGrid sheet={sheet()} serverNow={open} currentUserId={me} />);
    const group = within(row("합성 학생 나")).getByRole("group", {
      name: "합성 학생 나 출결 입력",
    });
    fireEvent.click(within(group).getByRole("button", { name: "지각" }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "다른 사람이 먼저 출결을 바꿨습니다",
    );
    expect(mocks.refresh).toHaveBeenCalledOnce();
    expect(mocks.record).toHaveBeenCalledWith(expect.objectContaining({ expectedVersion: 3 }));
    // 화면 값은 서버가 확인한 결석 그대로입니다.
    expect(within(group).getByRole("button", { name: "✓ 결석" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("일괄 출석은 미입력 학생만 저장하고 실패 인원을 요약합니다", async () => {
    mocks.record.mockResolvedValue({
      ok: false,
      code: "FORBIDDEN",
      message: "출결을 다룰 권한이 없습니다.",
    });
    render(<AttendanceGrid sheet={sheet()} serverNow={open} currentUserId={me} />);
    fireEvent.click(screen.getByRole("button", { name: "미입력 학생 1명 모두 출석으로 저장" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("0명 저장, 1명 실패"),
    );
    expect(mocks.record).toHaveBeenCalledTimes(1);
    expect(mocks.record).toHaveBeenCalledWith(
      expect.objectContaining({ enrollmentId: enrollments[0] }),
    );
  });
});

describe("입력 기간과 정정", () => {
  it("입력 기간이 지나면 직접 입력을 막고 정정 요청만 제공합니다", () => {
    render(<AttendanceGrid sheet={sheet()} serverNow={closed} currentUserId={me} />);
    expect(screen.getByText(/입력 기간이 지났습니다/)).toBeTruthy();
    const group = within(row("합성 학생 나")).getByRole("group", {
      name: "합성 학생 나 출결 입력",
    });
    for (const button of within(group).getAllByRole("button"))
      expect(button.hasAttribute("disabled")).toBe(true);
    expect(
      within(row("합성 학생 나")).getByRole("form", { name: "합성 학생 나 출결 정정 요청" }),
    ).toBeTruthy();
  });

  it("입력 기간 중 정정 요청은 인정결석 지정만 고를 수 있습니다", () => {
    render(<AttendanceGrid sheet={sheet()} serverNow={open} currentUserId={me} />);
    const select = within(row("합성 학생 나")).getByLabelText("요청할 상태");
    const options = within(select)
      .getAllByRole("option")
      .map((option) => option.textContent);
    expect(options).toEqual(["상태를 선택해 주세요", "인정결석"]);
  });

  it("본인이 요청한 정정에는 결정 버튼을 주지 않고, 다른 담당자의 요청에는 승인·반려를 제공합니다", () => {
    const pending = (
      requestedByUserId: string | null,
      reason: string | null,
      requestedStatus: "PRESENT" | "EXCUSED" = "PRESENT",
    ) => ({
      id: "16000000-0000-4000-8000-0000000000d1",
      requestedStatus,
      previousStatus: "ABSENT" as const,
      reason,
      requestedByUserId,
      requestedAt: "2026-11-27T00:00:00.000Z",
    });
    const base = sheet();
    const { rerender } = render(
      <AttendanceGrid
        sheet={{
          ...base,
          entries: [{ ...base.entries[1], pendingCorrection: pending(me, "개인 사정") }],
        }}
        serverNow={closed}
        currentUserId={me}
      />,
    );
    expect(screen.getByText("본인이 요청한 정정은 다른 담당자가 결정합니다.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "승인" })).toBeNull();

    rerender(
      <AttendanceGrid
        key="other"
        sheet={{
          ...base,
          entries: [{ ...base.entries[1], pendingCorrection: pending(other, "개인 사정") }],
        }}
        serverNow={closed}
        currentUserId={me}
      />,
    );
    expect(screen.getByRole("button", { name: "승인" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "반려" })).toBeTruthy();

    // 인정결석 관련 요청의 사유가 서버 DTO에서 가려졌으면(관리자 아님) 결정할 수 없다고 안내합니다.
    rerender(
      <AttendanceGrid
        key="excused"
        sheet={{
          ...base,
          entries: [{ ...base.entries[1], pendingCorrection: pending(null, null, "EXCUSED") }],
        }}
        serverNow={closed}
        currentUserId={me}
      />,
    );
    expect(screen.getByText("인정결석 관련 정정은 학사 운영 관리자가 결정합니다.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "승인" })).toBeNull();
  });
});
