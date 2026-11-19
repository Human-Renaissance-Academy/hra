// @vitest-environment node
/**
 * #160 출결·운영 인력 Server Action과 화면 진입점의 서버 경계 회귀입니다.
 *
 * - 저장소(repository)만 대체하고 실제 Application Service를 통과시켜, 기능 플래그·세션 주체·입력 검증·
 *   DB 권한 오류 변환·재검증(revalidatePath) 순서를 확인합니다.
 * - 홈페이지 `ADMIN` 역할도 관리자 지정이 없으면(DB가 HRA01 또는 null) 거부되는지 확인합니다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  revalidate: vi.fn(),
  notFound: vi.fn(),
  redirect: vi.fn(),
  staffRepo: {
    activeManagerCondition: vi.fn(),
    hasActiveStaffAssignment: vi.fn(),
    insertStaffAssignment: vi.fn(),
    closeStaffAssignment: vi.fn(),
    swapStaffAssignment: vi.fn(),
    insertManagerDesignation: vi.fn(),
    closeManagerDesignation: vi.fn(),
    selectStaffOverview: vi.fn(),
    selectStaffAudit: vi.fn(),
    selectMyStaffCohorts: vi.fn(),
  },
  attendanceRepo: {
    saveAttendance: vi.fn(),
    insertCorrectionRequest: vi.fn(),
    saveCorrectionDecision: vi.fn(),
    selectEventSheet: vi.fn(),
    selectOwnAttendance: vi.fn(),
    selectClassSessions: vi.fn(),
    selectPendingCorrectionsForManager: vi.fn(),
    selectOwnAttendanceContext: vi.fn(),
    selectAttendanceAccess: vi.fn(),
  },
}));
vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
vi.mock("next/navigation", () => ({ notFound: mocks.notFound, redirect: mocks.redirect }));
vi.mock("@/lib/request-session", () => ({ getRequestSession: mocks.session }));
vi.mock("@/lib/academic-admin", () => ({
  getAcademicApproverId: () => {
    throw new Error("미설정");
  },
}));
vi.mock("@/features/academics/staff/repository", () => mocks.staffRepo);
vi.mock("@/features/academics/attendance/repository", () => mocks.attendanceRepo);

import {
  assignStaffAction,
  endStaffAction,
  replaceStaffAction,
} from "@/features/academics/staff/actions";
import {
  decideCorrectionAction,
  recordAttendanceAction,
  requestCorrectionAction,
} from "@/features/academics/attendance/actions";
import {
  getAttendanceNavigation,
  listClassSessions,
} from "@/features/academics/attendance/service";
import { getStaffManagementOverview } from "@/features/academics/staff/service";
import OperationsPage from "@/app/(member)/member/academic-operations/page";
import StaffAttendancePage from "@/app/(member)/member/attendance/staff/page";
import MyAttendancePage from "@/app/(member)/member/attendance/page";

const ids = {
  user: "16000000-0000-4000-8000-000000000001",
  other: "16000000-0000-4000-8000-000000000002",
  cohort: "16000000-0000-4000-8000-000000000003",
  assignment: "16000000-0000-4000-8000-000000000004",
  evidence: "16000000-0000-4000-8000-000000000005",
  request: "16000000-0000-4000-8000-000000000006",
  event: "16000000-0000-4000-8000-000000000007",
  enrollment: "16000000-0000-4000-8000-000000000008",
  correction: "16000000-0000-4000-8000-000000000009",
};
const idle = { status: "idle" as const };
const sqlError = (code: string) => Object.assign(new Error("DB 원문 메시지"), { code });
const form = (values: Record<string, string>) => {
  const data = new FormData();
  for (const [key, value] of Object.entries(values)) data.set(key, value);
  return data;
};
const loginAs = (role: string, id = ids.user) =>
  mocks.session.mockResolvedValue({ user: { id, role, name: "합성 사용자" } });
const enableAll = () => {
  vi.stubEnv("ACADEMIC_ENABLED", "true");
  vi.stubEnv("ACADEMIC_STAFF_ENABLED", "true");
  vi.stubEnv("ACADEMIC_ATTENDANCE_ENABLED", "true");
};
const assignmentRow = {
  id: ids.assignment,
  cohort_id: ids.cohort,
  user_id: ids.other,
  staff_role: "ASSISTANT",
  valid_from: "2026-11-19T10:00:00+09:00",
  valid_to: null,
  assigned_by_user_id: ids.user,
  replaces_assignment_id: null,
  ended_by_user_id: null,
  ended_at: null,
};
const recordRow = {
  id: ids.request,
  schedule_event_id: ids.event,
  enrollment_id: ids.enrollment,
  cohort_id: ids.cohort,
  class_date: "2026-11-19",
  status: "PRESENT",
  version: 2,
  recorded_by_user_id: ids.user,
  last_correction_id: null,
  recorded_at: "2026-11-19T10:00:00+09:00",
};
const correctionRow = {
  id: ids.correction,
  schedule_event_id: ids.event,
  enrollment_id: ids.enrollment,
  cohort_id: ids.cohort,
  class_date: "2026-11-19",
  base_version: 1,
  previous_status: "ABSENT",
  requested_status: "PRESENT",
  reason: "합성 사유",
  excuse_verification_method: null,
  requested_by_user_id: ids.other,
  requested_at: "2026-11-27T10:00:00+09:00",
  status: "APPROVED",
  decided_by_user_id: ids.user,
  decided_at: "2026-11-27T11:00:00+09:00",
};
const assignForm = (extra: Record<string, string> = {}) =>
  form({
    cohortId: ids.cohort,
    userId: ids.other,
    staffRole: "ASSISTANT",
    verificationMethod: "IN_PERSON",
    evidenceReference: ids.evidence,
    requestId: ids.request,
    ...extra,
  });

beforeEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  enableAll();
  loginAs("MEMBER");
  mocks.notFound.mockImplementation(() => {
    throw new Error("NEXT_NOT_FOUND");
  });
  mocks.redirect.mockImplementation((path: string) => {
    throw new Error(`NEXT_REDIRECT ${path}`);
  });
  vi.spyOn(console, "error").mockImplementation(() => undefined);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("운영 인력 배정 Server Action", () => {
  it.each([undefined, "false", "TRUE"])(
    "기능 플래그(%s)가 꺼져 있으면 DB 호출 없이 거부합니다",
    async (flag) => {
      vi.stubEnv("ACADEMIC_STAFF_ENABLED", flag);
      const result = await assignStaffAction(idle, assignForm());
      expect(result).toMatchObject({ status: "error", code: "DISABLED" });
      expect(mocks.staffRepo.insertStaffAssignment).not.toHaveBeenCalled();
      expect(mocks.revalidate).not.toHaveBeenCalled();
    },
  );

  it("비로그인·식별자 형식 오류 세션은 UNAUTHENTICATED이며 DB를 호출하지 않습니다", async () => {
    mocks.session.mockResolvedValueOnce(null);
    expect(await assignStaffAction(idle, assignForm())).toMatchObject({ code: "UNAUTHENTICATED" });
    mocks.session.mockResolvedValueOnce({ user: { id: "not-a-uuid", role: "MEMBER" } });
    expect(await assignStaffAction(idle, assignForm())).toMatchObject({ code: "UNAUTHENTICATED" });
    expect(mocks.staffRepo.insertStaffAssignment).not.toHaveBeenCalled();
  });

  it("승인 대기 계정은 DB 호출 없이 FORBIDDEN입니다", async () => {
    loginAs("PENDING");
    expect(await assignStaffAction(idle, assignForm())).toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.staffRepo.insertStaffAssignment).not.toHaveBeenCalled();
  });

  it("관리자 지정이 없는 홈페이지 ADMIN은 DB 판정(HRA01)으로 거부되고 원문을 노출하지 않습니다", async () => {
    loginAs("ADMIN");
    mocks.staffRepo.insertStaffAssignment.mockRejectedValue(sqlError("HRA01"));
    const result = await assignStaffAction(idle, assignForm());
    expect(result).toEqual({
      status: "error",
      code: "FORBIDDEN",
      message: "운영 인력을 관리할 권한이 없습니다.",
    });
    expect(JSON.stringify(result)).not.toContain("DB 원문");
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it("상한 초과(23P01)를 고정 문구로 안내합니다", async () => {
    mocks.staffRepo.insertStaffAssignment.mockRejectedValue(sqlError("23P01"));
    expect(await assignStaffAction(idle, assignForm())).toMatchObject({ code: "CAPACITY" });
  });

  it("성공 시 세션 주체를 행위자로 쓰고 폼의 위조 필드를 거부하며 한국시간 입력을 시간대 포함 값으로 바꿉니다", async () => {
    mocks.staffRepo.insertStaffAssignment.mockResolvedValue({
      assignment: assignmentRow,
      replayed: false,
    });
    const result = await assignStaffAction(
      idle,
      assignForm({ validFrom: "2026-12-01T09:30", actorId: ids.other }),
    );
    expect(result).toEqual({ status: "success", message: "운영 인력을 배정했습니다." });
    expect(mocks.staffRepo.insertStaffAssignment).toHaveBeenCalledWith(
      expect.objectContaining({
        actorId: ids.user,
        validFrom: "2026-12-01T09:30:00+09:00",
        validTo: null,
        userId: ids.other,
      }),
    );
    expect(mocks.revalidate).toHaveBeenCalledWith("/member/academic-operations");
  });

  it("사유 없는 종료·잘못된 식별자의 교체는 INVALID_INPUT이며 DB를 호출하지 않습니다", async () => {
    expect(
      await endStaffAction(idle, form({ requestId: ids.request, assignmentId: ids.assignment })),
    ).toMatchObject({ code: "INVALID_INPUT" });
    expect(
      await replaceStaffAction(
        idle,
        form({
          requestId: ids.request,
          assignmentId: ids.assignment,
          userId: "이메일@example.test",
          reason: "교체",
          verificationMethod: "IN_PERSON",
          evidenceReference: ids.evidence,
        }),
      ),
    ).toMatchObject({ code: "INVALID_INPUT" });
    expect(mocks.staffRepo.closeStaffAssignment).not.toHaveBeenCalled();
    expect(mocks.staffRepo.swapStaffAssignment).not.toHaveBeenCalled();
  });

  it("종료 성공 시 사유를 저장소에 넘기고 화면을 재검증합니다", async () => {
    mocks.staffRepo.closeStaffAssignment.mockResolvedValue({
      assignment: assignmentRow,
      replayed: false,
    });
    const result = await endStaffAction(
      idle,
      form({ requestId: ids.request, assignmentId: ids.assignment, reason: "개인 사정" }),
    );
    expect(result.status).toBe("success");
    expect(mocks.staffRepo.closeStaffAssignment).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: ids.user, reason: "개인 사정", effectiveAt: null }),
    );
    expect(mocks.revalidate).toHaveBeenCalledWith("/member/academic-operations");
  });

  it("예상하지 못한 오류는 일반 문구로 바꾸고 기록합니다", async () => {
    mocks.session.mockRejectedValue(new Error("세션 저장소 장애"));
    expect(await assignStaffAction(idle, assignForm())).toEqual({
      status: "error",
      code: "UNAVAILABLE",
      message: "잠시 후 다시 시도해 주세요.",
    });
    expect(console.error).toHaveBeenCalled();
  });
});

describe("출결 Server Action", () => {
  const input = {
    requestId: ids.request,
    scheduleEventId: ids.event,
    enrollmentId: ids.enrollment,
    status: "PRESENT",
    expectedVersion: 1,
  };

  it("출결 플래그가 꺼져 있으면 DB 호출 없이 거부합니다", async () => {
    vi.stubEnv("ACADEMIC_ATTENDANCE_ENABLED", "false");
    expect(await recordAttendanceAction(input)).toMatchObject({ ok: false, code: "DISABLED" });
    expect(mocks.attendanceRepo.saveAttendance).not.toHaveBeenCalled();
  });

  it("배정되지 않은 FACULTY·다른 기수 인력은 DB 판정(HRA01)으로 거부되고 재검증하지 않습니다", async () => {
    loginAs("FACULTY");
    mocks.attendanceRepo.saveAttendance.mockRejectedValue(sqlError("HRA01"));
    expect(await recordAttendanceAction(input)).toEqual({
      ok: false,
      code: "FORBIDDEN",
      message: "출결을 다룰 권한이 없습니다.",
    });
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it("동시 수정 충돌(HRA06)은 VERSION_CONFLICT로 돌려 덮어쓰지 않습니다", async () => {
    mocks.attendanceRepo.saveAttendance.mockRejectedValue(sqlError("HRA06"));
    expect(await recordAttendanceAction(input)).toMatchObject({
      ok: false,
      code: "VERSION_CONFLICT",
    });
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });

  it("추가 필드(행위자 위조)·문자열 버전·빈 입력은 DB 호출 없이 INVALID_INPUT입니다", async () => {
    for (const bad of [
      { ...input, status: "UNMARKED" },
      { ...input, actorId: ids.other },
      { ...input, expectedVersion: "1" },
      null,
    ]) {
      expect(await recordAttendanceAction(bad)).toMatchObject({ ok: false, code: "INVALID_INPUT" });
    }
    expect(mocks.attendanceRepo.saveAttendance).not.toHaveBeenCalled();
  });

  it("인정결석 직접 입력은 DB 판정(HRA08)으로 정정 요청을 안내합니다", async () => {
    mocks.attendanceRepo.saveAttendance.mockRejectedValue(sqlError("HRA08"));
    expect(await recordAttendanceAction({ ...input, status: "EXCUSED" })).toMatchObject({
      ok: false,
      code: "CORRECTION_REQUIRED",
    });
  });

  it("저장 성공 시 새 버전을 돌려주고 출결 입력 화면을 재검증합니다", async () => {
    mocks.attendanceRepo.saveAttendance.mockResolvedValue({
      record: recordRow,
      changed: true,
      replayed: false,
    });
    expect(await recordAttendanceAction(input)).toEqual({
      ok: true,
      status: "PRESENT",
      version: 2,
      recordedAt: "2026-11-19T01:00:00.000Z",
    });
    expect(mocks.attendanceRepo.saveAttendance).toHaveBeenCalledWith(
      expect.objectContaining({ actorId: ids.user, expectedVersion: 1 }),
    );
    expect(mocks.revalidate).toHaveBeenCalledWith("/member/attendance/staff");
  });

  it("정정 요청은 버전을 숫자로 바꾸고 인정결석이 아닌 요청의 확인 방식은 넘기지 않습니다", async () => {
    mocks.attendanceRepo.insertCorrectionRequest.mockResolvedValue({
      correction: {
        ...correctionRow,
        status: "PENDING",
        decided_by_user_id: null,
        decided_at: null,
      },
      replayed: false,
    });
    const result = await requestCorrectionAction(
      idle,
      form({
        requestId: ids.request,
        scheduleEventId: ids.event,
        enrollmentId: ids.enrollment,
        requestedStatus: "PRESENT",
        expectedVersion: "1",
        reason: "개인 사정",
        excuseVerificationMethod: "DOCUMENT_SIGHTED",
      }),
    );
    expect(result.status).toBe("success");
    expect(mocks.attendanceRepo.insertCorrectionRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedVersion: 1,
        excuseVerificationMethod: null,
        reason: "개인 사정",
      }),
    );
    expect(mocks.revalidate).toHaveBeenCalledWith("/member/attendance");
  });

  it("사유 없는 정정·확인 방식 없는 인정결석 요청은 INVALID_INPUT입니다", async () => {
    const base = {
      requestId: ids.request,
      scheduleEventId: ids.event,
      enrollmentId: ids.enrollment,
      expectedVersion: "1",
    };
    expect(
      await requestCorrectionAction(idle, form({ ...base, requestedStatus: "PRESENT" })),
    ).toMatchObject({ code: "INVALID_INPUT" });
    expect(
      await requestCorrectionAction(
        idle,
        form({ ...base, requestedStatus: "EXCUSED", reason: "개인 사정" }),
      ),
    ).toMatchObject({ code: "INVALID_INPUT" });
    expect(mocks.attendanceRepo.insertCorrectionRequest).not.toHaveBeenCalled();
  });

  it("자기 승인(HRA01)은 거부하고, 다른 담당자의 승인은 세 화면을 재검증합니다", async () => {
    const decision = form({
      requestId: ids.request,
      correctionId: ids.correction,
      decision: "APPROVE",
    });
    mocks.attendanceRepo.saveCorrectionDecision.mockRejectedValueOnce(sqlError("HRA01"));
    expect(await decideCorrectionAction(idle, decision)).toMatchObject({ code: "FORBIDDEN" });
    expect(mocks.revalidate).not.toHaveBeenCalled();

    mocks.attendanceRepo.saveCorrectionDecision.mockResolvedValueOnce({
      correction: correctionRow,
      record: recordRow,
      replayed: false,
    });
    expect(await decideCorrectionAction(idle, decision)).toEqual({
      status: "success",
      message: "정정을 승인했습니다.",
    });
    expect(mocks.revalidate.mock.calls.map(([path]) => path)).toEqual([
      "/member/attendance/staff",
      "/member/academic-operations",
      "/member/attendance",
    ]);
  });
});

describe("화면용 읽기 서비스", () => {
  it("관리자 지정이 없으면(저장소 null) 운영 현황을 FORBIDDEN으로 거부합니다", async () => {
    loginAs("ADMIN");
    mocks.staffRepo.selectStaffOverview.mockResolvedValue(null);
    await expect(
      getStaffManagementOverview({ userId: ids.user, role: "ADMIN" }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("배정되지 않은 기수의 수업일은 FORBIDDEN, 잘못된 기수 식별자는 DB 호출 없이 INVALID_INPUT입니다", async () => {
    mocks.attendanceRepo.selectClassSessions.mockResolvedValue(null);
    const principal = { userId: ids.user, role: "MEMBER" };
    await expect(listClassSessions(principal, ids.cohort)).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    mocks.attendanceRepo.selectClassSessions.mockClear();
    await expect(listClassSessions(principal, "1 OR 1=1")).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
    expect(mocks.attendanceRepo.selectClassSessions).not.toHaveBeenCalled();
  });

  it("메뉴 판정은 플래그·승인 대기에서 DB 없이 숨기고, 출결 플래그가 꺼지면 운영 관리만 보입니다", async () => {
    const principal = { userId: ids.user, role: "MEMBER" };
    const hidden = { operations: false, staffAttendance: false, ownAttendance: false };
    vi.stubEnv("ACADEMIC_STAFF_ENABLED", "false");
    expect(await getAttendanceNavigation(principal)).toEqual(hidden);
    enableAll();
    expect(await getAttendanceNavigation({ userId: ids.user, role: "PENDING" })).toEqual(hidden);
    expect(mocks.attendanceRepo.selectAttendanceAccess).not.toHaveBeenCalled();

    mocks.attendanceRepo.selectAttendanceAccess.mockResolvedValue({
      manager: true,
      staff: true,
      student: true,
    });
    vi.stubEnv("ACADEMIC_ATTENDANCE_ENABLED", "false");
    expect(await getAttendanceNavigation(principal)).toEqual({
      operations: true,
      staffAttendance: false,
      ownAttendance: false,
    });
    enableAll();
    expect(await getAttendanceNavigation(principal)).toEqual({
      operations: true,
      staffAttendance: true,
      ownAttendance: true,
    });
  });
});

describe("화면 진입점", () => {
  const pages = [
    ["학사 운영 관리", () => OperationsPage()],
    ["출결 입력", () => StaffAttendancePage({ searchParams: Promise.resolve({}) })],
    ["내 출결", () => MyAttendancePage()],
  ] as const;

  it.each(pages)(
    "%s 화면은 기능 플래그가 꺼져 있으면 세션·DB 조회 없이 404입니다",
    async (_name, render) => {
      vi.stubEnv("ACADEMIC_ENABLED", "false");
      await expect(render()).rejects.toThrow("NEXT_NOT_FOUND");
      expect(mocks.session).not.toHaveBeenCalled();
      for (const fn of [...Object.values(mocks.staffRepo), ...Object.values(mocks.attendanceRepo)])
        expect(fn).not.toHaveBeenCalled();
    },
  );

  it.each(pages)("%s 화면은 비로그인 사용자를 로그인으로 보냅니다", async (_name, render) => {
    mocks.session.mockResolvedValue(null);
    await expect(render()).rejects.toThrow("NEXT_REDIRECT /login");
  });

  it("관리자 지정이 없는 홈페이지 ADMIN에게 학사 운영 관리 화면은 404입니다", async () => {
    loginAs("ADMIN");
    mocks.staffRepo.selectStaffOverview.mockResolvedValue(null);
    await expect(OperationsPage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.staffRepo.selectStaffAudit).not.toHaveBeenCalled();
  });

  it("학생 학적이 없는 승인 대기 계정에게 내 출결 화면은 404입니다", async () => {
    loginAs("PENDING");
    await expect(MyAttendancePage()).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.attendanceRepo.selectOwnAttendance).not.toHaveBeenCalled();
  });
});
