/**
 * #516 PR-E·F 화면 검증
 * - 학생 분리 제출 규칙(확장자·50MiB·합계 100MiB·필수·최소 1개)과 최종 제출 버튼 활성 조건
 * - 학생 폼의 항목별 표시·업로드→검증→원자적 최종 제출·서버 거부 문구·취소, 완료 후 두 파일 다운로드 링크
 * - 관리자 과제 폼의 제출 형식 선택(기능 gate)·둘 다 미사용 차단·payload
 */
import { createElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  issue: vi.fn(),
  verify: vi.fn(),
  cancel: vi.fn(),
  finalize: vi.fn(),
  upload: vi.fn(),
  refresh: vi.fn(),
  replace: vi.fn(),
  routerRefresh: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));
vi.mock("@/features/academics/submissions/artifact-actions", () => ({
  issueArtifactUploadIntent: mocks.issue,
  verifyArtifactUpload: mocks.verify,
  cancelArtifactUpload: mocks.cancel,
  finalizeArtifactSubmission: mocks.finalize,
}));
vi.mock("@/features/academics/assignment-uploads/client", () => ({
  uploadAssignmentArtifactFile: mocks.upload,
}));
vi.mock("@/features/academics/student-assignments/ui-actions", () => ({
  refreshMyAssignment: mocks.refresh,
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace, refresh: mocks.routerRefresh }),
}));
vi.mock("@/features/academics/assignments/actions", () => ({
  createAssignment: mocks.create,
  updateDraftAssignment: mocks.update,
}));

import { ArtifactSubmissionForm } from "@/app/(member)/member/assignments/_components/artifact-submission-form";
import { AssignmentForm } from "@/app/(academic)/admin/academics/assignments/_components/assignment-form";
import {
  artifactAccept,
  artifactSubmissionReadiness,
  checkArtifactFile,
  declaredArtifactFormat,
  exceedsArtifactTotal,
} from "@/features/academics/student-assignments/artifact-submission";
import type {
  StudentAssignmentDetail,
  StudentArtifactRequirement,
} from "@/features/academics/student-assignments/contracts";
import { describeSubmissionPolicy } from "@/features/academics/assignments/admin-display";

const MiB = 1024 * 1024;
const assignmentId = "20000000-0000-4000-8000-000000000001";
const textIntent = "40000000-0000-4000-8000-000000000001";
const slidesIntent = "40000000-0000-4000-8000-000000000002";
const submissionId = "70000000-0000-4000-8000-000000000001";
const reference = "90000000-0000-4000-8000-000000000001";
const detail = (
  text: StudentArtifactRequirement,
  slides: StudentArtifactRequirement,
  submitted = false,
): StudentAssignmentDetail => ({
  assignmentId,
  targetId: "30000000-0000-4000-8000-000000000001",
  title: "분리 제출 과제",
  status: "PUBLISHED",
  dueAt: "2099-01-01T00:00:00.000Z",
  publishedAt: "2026-01-01T00:00:00.000Z",
  instructions: "",
  submission: submitted ? { submissionId, submittedAt: "2026-11-19T01:00:00.000Z" } : null,
  file: null,
  artifacts: {
    textRequirement: text,
    slidesRequirement: slides,
    files: submitted
      ? [
          {
            fileId: "80000000-0000-4000-8000-000000000001",
            artifactType: "TEXT",
            fileFormat: "HWPX",
            originalName: "본문.hwpx",
            mimeType: "application/hwp+zip",
            sizeBytes: 3 * MiB,
          },
          {
            fileId: "80000000-0000-4000-8000-000000000002",
            artifactType: "SLIDES",
            fileFormat: "PPTX",
            originalName: "발표.pptx",
            mimeType: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            sizeBytes: 2048,
          },
        ]
      : [],
  },
});
const file = (name: string, size = 2048) => {
  const value = new File(["x"], name);
  Object.defineProperty(value, "size", { value: size });
  return value;
};
const section = (verified: boolean, sizeBytes?: number, pending = false) => ({
  verified,
  sizeBytes,
  pending,
});

beforeEach(() => {
  vi.resetAllMocks();
  sessionStorage.clear();
});
afterEach(cleanup);

describe("분리 제출 규칙", () => {
  it("항목별 확장자만 받고 크기·합계 상한을 확인한다", () => {
    expect(declaredArtifactFormat("TEXT", "과제.HWPX")).toBe("HWPX");
    expect(declaredArtifactFormat("TEXT", "과제.pptx")).toBeNull();
    expect(declaredArtifactFormat("SLIDES", "발표.ppt")).toBe("PPT");
    expect(declaredArtifactFormat("SLIDES", "발표.pptm")).toBeNull();
    expect(artifactAccept("TEXT")).toContain(".hwp");
    expect(artifactAccept("TEXT")).not.toContain(".ppt");
    expect(checkArtifactFile("TEXT", { name: "과제.hwp", size: 50 * MiB })).toEqual({
      ok: true,
      format: "HWP",
    });
    expect(checkArtifactFile("TEXT", { name: "과제.hwp", size: 50 * MiB + 1 })).toMatchObject({
      ok: false,
      message: expect.stringContaining("50MiB"),
    });
    expect(checkArtifactFile("TEXT", { name: "과제.hwp", size: 0 })).toMatchObject({ ok: false });
    expect(checkArtifactFile("SLIDES", { name: "과제.hwp", size: 10 })).toMatchObject({
      ok: false,
      message: expect.stringContaining("PPT·PPTX·PDF"),
    });
    expect(exceedsArtifactTotal({ TEXT: 50 * MiB, SLIDES: 50 * MiB })).toBe(false);
    expect(exceedsArtifactTotal({ TEXT: 50 * MiB, SLIDES: 50 * MiB + 1 })).toBe(true);
  });

  it("필수 항목 누락·0개·진행 중·미사용 첨부·합계 초과에서는 최종 제출을 막는다", () => {
    const both = { TEXT: "REQUIRED", SLIDES: "REQUIRED" } as const;
    expect(
      artifactSubmissionReadiness(both, { TEXT: section(true, 10), SLIDES: section(false) }),
    ).toMatchObject({ ready: false, message: expect.stringContaining("발표자료") });
    expect(
      artifactSubmissionReadiness(both, { TEXT: section(true, 10), SLIDES: section(true, 10) }),
    ).toEqual({ ready: true });
    const optional = { TEXT: "OPTIONAL", SLIDES: "OPTIONAL" } as const;
    expect(
      artifactSubmissionReadiness(optional, { TEXT: section(false), SLIDES: section(false) }),
    ).toMatchObject({ ready: false, message: expect.stringContaining("최소 1개") });
    expect(
      artifactSubmissionReadiness(optional, { TEXT: section(false), SLIDES: section(true, 10) }),
    ).toEqual({ ready: true });
    expect(
      artifactSubmissionReadiness(optional, {
        TEXT: section(false, 10, true),
        SLIDES: section(true, 10),
      }),
    ).toMatchObject({ ready: false });
    expect(
      artifactSubmissionReadiness(
        { TEXT: "REQUIRED", SLIDES: "DISABLED" },
        { TEXT: section(true, 10), SLIDES: section(true, 10) },
      ),
    ).toMatchObject({ ready: false });
    expect(
      artifactSubmissionReadiness(optional, {
        TEXT: section(true, 60 * MiB),
        SLIDES: section(true, 50 * MiB),
      }),
    ).toMatchObject({ ready: false, message: expect.stringContaining("100MiB") });
  });
});

describe("학생 분리 제출 폼", () => {
  it("미사용 항목은 표시하지 않고 항목별 형식 안내와 필터를 제공한다", () => {
    render(
      createElement(ArtifactSubmissionForm, {
        assignment: detail("REQUIRED", "DISABLED"),
        open: true,
      }),
    );
    expect(screen.getByRole("group", { name: "텍스트 (필수)" })).toBeTruthy();
    expect(screen.queryByRole("group", { name: /발표자료/ })).toBeNull();
    expect((screen.getByLabelText("텍스트 파일 선택") as HTMLInputElement).accept).toContain(
      ".hwpx",
    );
    expect(screen.getByText(/발표자료 항목을 받지 않습니다/)).toBeTruthy();
    expect((screen.getByRole("button", { name: "최종 제출" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it("업로드·검증을 마친 필수 항목만으로 원자적 최종 제출하고 완료 후 두 파일을 보여 준다", async () => {
    mocks.issue.mockImplementation(async (input: { artifactType: string }) => ({
      success: true,
      uploadIntentId: input.artifactType === "TEXT" ? textIntent : slidesIntent,
      pathname: "academic-uploads/v2/x/original",
      contentType:
        input.artifactType === "TEXT"
          ? "application/hwp+zip"
          : "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      referenceId: reference,
    }));
    mocks.upload.mockResolvedValue(undefined);
    mocks.verify.mockResolvedValue({ success: true, referenceId: reference });
    mocks.finalize.mockResolvedValue({ success: true, referenceId: reference });
    mocks.refresh.mockResolvedValue({
      success: true,
      assignment: detail("REQUIRED", "OPTIONAL", true),
    });
    render(
      createElement(ArtifactSubmissionForm, {
        assignment: detail("REQUIRED", "OPTIONAL"),
        open: true,
      }),
    );
    const submit = screen.getByRole("button", { name: "최종 제출" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("텍스트 파일 선택"), {
      target: { files: [file("본문.hwpx", 3 * MiB)] },
    });
    fireEvent.click(screen.getByRole("button", { name: "텍스트 올리기" }));
    await waitFor(() =>
      expect(screen.getByText("확인 완료: 최종 제출에 포함됩니다.")).toBeTruthy(),
    );
    expect(mocks.issue).toHaveBeenCalledWith(
      expect.objectContaining({
        assignmentId,
        artifactType: "TEXT",
        fileFormat: "HWPX",
        originalName: "본문.hwpx",
        sizeBytes: 3 * MiB,
        mimeType: "application/hwp+zip",
      }),
    );
    // 서버가 돌려준 contentType으로만 전송한다.
    expect(mocks.upload).toHaveBeenCalledWith(
      expect.objectContaining({ uploadIntentId: textIntent, contentType: "application/hwp+zip" }),
    );
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    await waitFor(() => expect(screen.getByRole("heading", { name: "제출 완료" })).toBeTruthy());
    const payload = mocks.finalize.mock.calls[0][0];
    expect(payload).toMatchObject({ assignmentId, uploadIntentIds: [textIntent] });
    expect(payload.submissionKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(screen.getByRole("link", { name: "본문.hwpx 다운로드" }).getAttribute("href")).toBe(
      `/api/academic/submissions/${submissionId}/file/80000000-0000-4000-8000-000000000001`,
    );
    expect(screen.getByRole("link", { name: "발표.pptx 다운로드" })).toBeTruthy();
    expect(
      sessionStorage.getItem("hra-assignment-artifacts:30000000-0000-4000-8000-000000000001"),
    ).toBeNull();
  });

  it("서버 검증 거부 사유 문구를 그대로 안내하고 취소 후 다시 선택하게 한다", async () => {
    mocks.issue.mockResolvedValue({
      success: true,
      uploadIntentId: slidesIntent,
      pathname: "p",
      contentType: "application/vnd.ms-powerpoint",
      referenceId: reference,
    });
    mocks.upload.mockResolvedValue(undefined);
    mocks.verify.mockResolvedValue({
      success: false,
      status: 422,
      code: "INVALID_FILE",
      reason: "MACRO",
      message:
        "매크로·VBA가 포함된 발표자료는 제출할 수 없습니다. 매크로를 제거하거나 PDF로 저장해 올려 주세요.",
      referenceId: reference,
    });
    mocks.refresh.mockResolvedValue({ success: true, assignment: detail("OPTIONAL", "OPTIONAL") });
    mocks.cancel.mockResolvedValue({ success: true, state: "CANCELLED", referenceId: reference });
    render(
      createElement(ArtifactSubmissionForm, {
        assignment: detail("OPTIONAL", "OPTIONAL"),
        open: true,
      }),
    );
    fireEvent.change(screen.getByLabelText("발표자료 파일 선택"), {
      target: { files: [file("발표.ppt")] },
    });
    fireEvent.click(screen.getByRole("button", { name: "발표자료 올리기" }));
    await waitFor(() => expect(screen.getByText(/매크로·VBA가 포함된 발표자료/)).toBeTruthy());
    expect(screen.getByText("제출할 수 없는 파일")).toBeTruthy();
    expect(screen.getByText(`요청 참조: ${reference}`)).toBeTruthy();
    expect((screen.getByRole("button", { name: "최종 제출" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.click(screen.getByRole("button", { name: "발표자료 업로드 취소" }));
    await waitFor(() => expect(screen.getByText(/업로드를 취소했습니다/)).toBeTruthy());
    expect(mocks.cancel).toHaveBeenCalledWith({ assignmentId, uploadIntentId: slidesIntent });
    expect((screen.getByLabelText("발표자료 파일 선택") as HTMLInputElement).disabled).toBe(false);
  });

  it("50MiB 초과 파일은 업로드 요청 전에 거부한다", () => {
    render(
      createElement(ArtifactSubmissionForm, {
        assignment: detail("REQUIRED", "REQUIRED"),
        open: true,
      }),
    );
    fireEvent.change(screen.getByLabelText("텍스트 파일 선택"), {
      target: { files: [file("큰파일.pdf", 50 * MiB + 1)] },
    });
    expect(screen.getByText("파일은 하나당 50MiB 이하만 제출할 수 있습니다.")).toBeTruthy();
    expect(
      (screen.getByRole("button", { name: "텍스트 올리기" }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(mocks.issue).not.toHaveBeenCalled();
  });

  it("전송 실패는 같은 요청으로 다시 전송할 수 있다", async () => {
    mocks.issue.mockResolvedValue({
      success: true,
      uploadIntentId: textIntent,
      pathname: "p",
      contentType: "application/pdf",
      referenceId: reference,
    });
    mocks.upload.mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce(undefined);
    mocks.verify.mockResolvedValue({ success: true, referenceId: reference });
    render(
      createElement(ArtifactSubmissionForm, {
        assignment: detail("REQUIRED", "OPTIONAL"),
        open: true,
      }),
    );
    fireEvent.change(screen.getByLabelText("텍스트 파일 선택"), {
      target: { files: [file("본문.pdf")] },
    });
    fireEvent.click(screen.getByRole("button", { name: "텍스트 올리기" }));
    await waitFor(() => expect(screen.getByText("전송 실패")).toBeTruthy());
    fireEvent.click(screen.getByRole("button", { name: "텍스트 다시 전송" }));
    await waitFor(() =>
      expect(screen.getByText("확인 완료: 최종 제출에 포함됩니다.")).toBeTruthy(),
    );
    expect(mocks.issue.mock.calls[0][0].requestId).toBe(mocks.issue.mock.calls[1][0].requestId);
  });

  it("이미 제출한 과제는 제출 완료 상태로 표시한다", () => {
    render(
      createElement(ArtifactSubmissionForm, {
        assignment: detail("REQUIRED", "REQUIRED", true),
        open: true,
      }),
    );
    expect(screen.getByRole("heading", { name: "제출 완료" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "최종 제출" })).toBeNull();
  });
});

describe("관리자 과제 폼의 제출 형식", () => {
  const cohort = "10000000-0000-4000-8000-000000000001";
  const options = { cohorts: [{ id: cohort, name: "가 기수" }], events: [], sessions: [] };

  it("기능 gate가 꺼져 있으면 제출 형식 입력을 보이지 않고 형식 키도 보내지 않는다", async () => {
    mocks.create.mockResolvedValue({ success: true, assignment: { id: assignmentId } });
    const view = render(
      createElement(AssignmentForm, { options, requestId: assignmentId, writable: true }),
    );
    expect(screen.queryByRole("group", { name: "제출 형식" })).toBeNull();
    fireEvent.change(screen.getByLabelText("대상 기수", { exact: true }), {
      target: { value: cohort },
    });
    fireEvent.change(screen.getByLabelText("과제 제목", { exact: true }), {
      target: { value: "시험" },
    });
    fireEvent.submit(view.container.querySelector("form")!);
    await waitFor(() => expect(mocks.create).toHaveBeenCalled());
    expect(Object.keys(mocks.create.mock.calls[0][0])).not.toContain("submissionFormat");
  });

  it("분리 제출을 고르면 항목별 요구를 보내고 둘 다 미사용이면 저장을 막는다", async () => {
    mocks.create.mockResolvedValue({ success: true, assignment: { id: assignmentId } });
    const view = render(
      createElement(AssignmentForm, {
        options,
        requestId: assignmentId,
        writable: true,
        artifactsEnabled: true,
      }),
    );
    expect(screen.getByRole("group", { name: "제출 형식" }).textContent).toContain("HWP·HWPX·PDF");
    fireEvent.change(screen.getByLabelText("대상 기수", { exact: true }), {
      target: { value: cohort },
    });
    fireEvent.change(screen.getByLabelText("과제 제목", { exact: true }), {
      target: { value: "시험" },
    });
    fireEvent.click(screen.getByLabelText("텍스트·발표자료 분리 제출"));
    fireEvent.change(screen.getByLabelText("텍스트 제출"), { target: { value: "DISABLED" } });
    fireEvent.change(screen.getByLabelText("발표자료 제출"), { target: { value: "DISABLED" } });
    expect(screen.getByRole("alert").textContent).toContain("모두 미사용으로 둘 수 없습니다");
    expect((screen.getByRole("button", { name: "초안 저장" }) as HTMLButtonElement).disabled).toBe(
      true,
    );
    fireEvent.change(screen.getByLabelText("발표자료 제출"), { target: { value: "REQUIRED" } });
    fireEvent.submit(view.container.querySelector("form")!);
    await waitFor(() => expect(mocks.create).toHaveBeenCalled());
    expect(mocks.create.mock.calls[0][0]).toMatchObject({
      submissionFormat: "ARTIFACTS_V2",
      textRequirement: "DISABLED",
      slidesRequirement: "REQUIRED",
    });
  });

  it("기존 PDF 방식은 두 요구를 비워 보내고 공개 후 요약을 한국어로 표시한다", async () => {
    mocks.create.mockResolvedValue({ success: true, assignment: { id: assignmentId } });
    const view = render(
      createElement(AssignmentForm, {
        options,
        requestId: assignmentId,
        writable: true,
        artifactsEnabled: true,
      }),
    );
    fireEvent.change(screen.getByLabelText("대상 기수", { exact: true }), {
      target: { value: cohort },
    });
    fireEvent.change(screen.getByLabelText("과제 제목", { exact: true }), {
      target: { value: "시험" },
    });
    fireEvent.submit(view.container.querySelector("form")!);
    await waitFor(() => expect(mocks.create).toHaveBeenCalled());
    expect(mocks.create.mock.calls[0][0]).toMatchObject({
      submissionFormat: "LEGACY_SINGLE_PDF",
      textRequirement: null,
      slidesRequirement: null,
    });
    expect(
      describeSubmissionPolicy({
        submissionFormat: "ARTIFACTS_V2",
        textRequirement: "REQUIRED",
        slidesRequirement: "OPTIONAL",
      }),
    ).toBe("텍스트·발표자료 분리 제출 (텍스트 필수 · 발표자료 선택)");
    expect(
      describeSubmissionPolicy({
        submissionFormat: "LEGACY_SINGLE_PDF",
        textRequirement: null,
        slidesRequirement: null,
      }),
    ).toBe("PDF 1개 (기존 방식)");
  });
});
