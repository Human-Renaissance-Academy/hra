// @vitest-environment node
/** 지정 학사 승인자의 현황·CSV API를 검증한다. 운영 DB나 개인정보 로그를 사용하지 않는다. */
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ auth: vi.fn(), execute: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/db", () => ({ db: { execute: mocks.execute } }));
import { listAssignmentSubmissionStatuses } from "@/features/academics/submission-statuses/queries";
import {
  renderSubmissionStatusesCsv,
  submissionCsvCell,
  submissionCsvDisposition,
} from "@/features/academics/submission-statuses/csv";
import { GET } from "@/app/api/academic/assignments/[id]/submissions/export/route";
const approver = "10000000-0000-4000-8000-000000000001";
const other = "10000000-0000-4000-8000-000000000002";
const id = "20000000-0000-4000-8000-000000000001";
const target = "30000000-0000-4000-8000-000000000001";
const snapshot = {
  authorized: true,
  assignment: { id, title: '한글/과제\r\n"제목', cohortId: other, status: "PUBLISHED" },
  counts: { total: 1, submitted: 1, unsubmitted: 0 },
  filteredCount: 1,
  rows: [
    {
      targetId: target,
      displayName: '=수식,"이름"',
      accountLinked: true,
      enrollmentActive: true,
      submittedAt: "2026-10-01T00:01:02+00:00",
    },
  ],
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("ACADEMIC_ENABLED", "true");
  vi.stubEnv("ACADEMIC_APPROVER_USER_ID", approver);
  mocks.auth.mockResolvedValue({ user: { id: approver, role: "ADMIN" } });
  mocks.execute.mockResolvedValue({ rows: [snapshot] });
});
afterEach(() => vi.unstubAllEnvs());

it.each([null, "ADMIN", "MEMBER", "FACULTY", "PENDING"])(
  "지정되지 않은 %s는 목록과 CSV에서 정보를 얻지 못한다",
  async (role) => {
    mocks.auth.mockResolvedValue(role ? { user: { id: other, role } } : null);
    await expect(listAssignmentSubmissionStatuses({ assignmentId: id })).rejects.toMatchObject({
      status: 403,
    });
    const response = await GET(
      new Request(`http://localhost/api/academic/assignments/${id}/submissions/export`),
      { params: Promise.resolve({ id }) },
    );
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).not.toContain(snapshot.rows[0].displayName);
    expect(mocks.execute).not.toHaveBeenCalled();
  },
);
it("명시적으로 지정된 FACULTY 승인자는 조회할 수 있고 PENDING은 지정해도 차단한다", async () => {
  mocks.auth.mockResolvedValue({ user: { id: approver, role: "FACULTY" } });
  expect((await listAssignmentSubmissionStatuses({ assignmentId: id })).counts.total).toBe(1);
  mocks.auth.mockResolvedValue({ user: { id: approver, role: "PENDING" } });
  await expect(listAssignmentSubmissionStatuses({ assignmentId: id })).rejects.toMatchObject({
    status: 403,
  });
});
it("인증 다음 기능 gate를 검사하고 비활성이면 DB를 조회하지 않는다", async () => {
  vi.stubEnv("ACADEMIC_ENABLED", "false");
  await expect(listAssignmentSubmissionStatuses({ assignmentId: id })).rejects.toMatchObject({
    status: 404,
  });
  expect(mocks.auth).toHaveBeenCalledOnce();
  expect(mocks.execute).not.toHaveBeenCalled();
  mocks.auth.mockResolvedValue(null);
  await expect(listAssignmentSubmissionStatuses({ assignmentId: id })).rejects.toMatchObject({
    status: 403,
  });
});
it("잘못된 입력과 기수는 DB전 검증하고 내부 오류 원문을 노출하지 않는다", async () => {
  for (const input of [
    { assignmentId: "잘못된 ID" },
    { assignmentId: id, page: 0 },
    { assignmentId: id, cohortId: "잘못된 기수" },
    { assignmentId: id, sort: "비밀 SQL" },
  ])
    await expect(listAssignmentSubmissionStatuses(input)).rejects.toMatchObject({ status: 422 });
  expect(mocks.execute).not.toHaveBeenCalled();
  mocks.execute.mockRejectedValue(new Error("비밀 DB 주소와 개인 이름"));
  await expect(listAssignmentSubmissionStatuses({ assignmentId: id })).rejects.toMatchObject({
    status: 503,
    message: "제출 현황을 조회할 수 없습니다. 잠시 후 다시 시도해 주세요.",
  });
});
it("CSV는 BOM·한국시간·최소필드·인용·수식 방어를 적용한다", async () => {
  const response = await GET(
    new Request(`http://localhost/api/academic/assignments/${id}/submissions/export`),
    { params: Promise.resolve({ id }) },
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("content-disposition")).not.toContain("\r");
  expect(response.headers.get("content-disposition")).toContain("filename*=UTF-8''");
  const bytes = new Uint8Array(await response.arrayBuffer());
  expect([...bytes.slice(0, 3)]).toEqual([239, 187, 191]);
  const csv = new TextDecoder().decode(bytes);
  expect(csv).toContain('"\'=수식,""이름"""');
  expect(csv).toContain("2026-10-01 09:01:02");
  for (const value of [approver, target, "storageKey", "fileUrl", "계정 연결"])
    expect(csv).not.toContain(value);
});
it.each(["=SUM(1)", "+1", "-1", "@name", "  =1", "\t1", "\r\n=1"])(
  "CSV 위험 필드 %s를 작은따옴표로 무력화한다",
  (value) => {
    expect(submissionCsvCell(value)).toMatch(/^"'/);
  },
);
it("미제출 CSV에는 시간과 파일 링크가 없고 이름의 개행·따옴표는 인용한다", () => {
  const csv = renderSubmissionStatusesCsv([
    { ...snapshot.rows[0], displayName: '이름\n"인용"', submittedAt: null },
  ]);
  expect(csv).toContain('"이름\n""인용""","미제출",""');
  expect(submissionCsvDisposition("\r\n/\\")).not.toMatch(/[\r\n]/);
});
it("CSV는 페이지 범위가 아니라 전체 필터 결과를 조회하고 과도한 내보내기는 잘라 보내지 않는다", async () => {
  mocks.execute.mockResolvedValue({ rows: [{ ...snapshot, filteredCount: 10001 }] });
  const response = await GET(
    new Request(`http://localhost/api/academic/assignments/${id}/submissions/export?page=2`),
    { params: Promise.resolve({ id }) },
  );
  expect(response.status).toBe(422);
});
it("중복·미지원 API 쿼리를 조용히 무시하지 않는다", async () => {
  for (const suffix of ["?cohortId=x&cohortId=y", "?userId=임의계정", "?page=NaN"]) {
    const response = await GET(
      new Request(`http://localhost/api/academic/assignments/${id}/submissions/export${suffix}`),
      { params: Promise.resolve({ id }) },
    );
    expect(response.status).toBe(422);
  }
  expect(mocks.execute).not.toHaveBeenCalled();
});

it("CSV 파일명은 코드포인트 경계로 잘라 이모지 제목도 인코딩한다", () => {
  const title = "가".repeat(79) + "😀";
  expect(submissionCsvDisposition(title)).toContain(encodeURIComponent(`${title}-제출현황.csv`));
});

// CSV 사본 생성 관측: 서버 요청 참조 전파와 이벤트 형태·개인정보 비노출을 함께 확인한다.
function exportRequest() {
  return GET(new Request(`http://localhost/api/academic/assignments/${id}/submissions/export`), {
    params: Promise.resolve({ id }),
  });
}
// 성공은 console.info의 평탄 이벤트, 거부·실패는 logServerError의 context로 기록된다.
function loggedEvents() {
  const info = vi.mocked(console.info).mock.calls.map((call) => call[1]);
  const errors = vi
    .mocked(console.error)
    .mock.calls.map((call) => (call[1] as { context?: unknown } | undefined)?.context);
  return [...info, ...errors].filter(Boolean) as Array<Record<string, unknown>>;
}
it("CSV 성공은 SQL 재검사 뒤 actor를 연결한 COMPLETED 이벤트와 같은 X-Request-Id를 남긴다", async () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  const response = await exportRequest();
  const referenceId = response.headers.get("x-request-id");
  expect(response.status).toBe(200);
  expect(referenceId).toMatch(/^[0-9a-f-]{36}$/);
  const events = loggedEvents();
  expect(events).toHaveLength(1);
  expect(Object.keys(events[0]).sort()).toEqual([
    "action",
    "actorUserId",
    "correlationId",
    "failureCode",
    "outcome",
    "requestId",
    "resourceId",
    "resourceType",
    "retryCount",
    "schemaVersion",
    "sqlState",
    "timestamp",
  ]);
  expect(events[0]).toMatchObject({
    action: "SUBMISSION_EXPORT",
    resourceType: "ASSIGNMENT",
    resourceId: id,
    actorUserId: approver,
    outcome: "COMPLETED",
    correlationId: referenceId,
  });
  const logged = JSON.stringify([
    vi.mocked(console.info).mock.calls,
    vi.mocked(console.error).mock.calls,
  ]);
  for (const value of [snapshot.rows[0].displayName, "한글/과제", target])
    expect(logged).not.toContain(value);
  vi.restoreAllMocks();
});
it("CSV 거부·실패는 고정 안내와 헤더와 같은 참조만 반환하고 actor·원본 오류를 기록하지 않는다", async () => {
  vi.spyOn(console, "info").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.execute.mockResolvedValue({ rows: [{ authorized: false }] });
  const denied = await exportRequest();
  expect(denied.status).toBe(403);
  expect(await denied.json()).toEqual({
    message: "지정된 학사 운영 책임자만 조회할 수 있습니다.",
    referenceId: denied.headers.get("x-request-id"),
  });
  expect(loggedEvents().at(-1)).toMatchObject({
    outcome: "DENIED",
    failureCode: "AUTHORIZATION",
    actorUserId: null,
  });
  mocks.execute.mockRejectedValue(new Error("비밀 DB 주소와 개인 이름"));
  const failed = await exportRequest();
  expect(failed.status).toBe(503);
  expect(await failed.json()).toEqual({
    message: "제출 현황을 조회할 수 없습니다. 잠시 후 다시 시도해 주세요.",
    referenceId: failed.headers.get("x-request-id"),
  });
  expect(loggedEvents().at(-1)).toMatchObject({
    outcome: "FAILED",
    failureCode: "UNKNOWN",
    correlationId: failed.headers.get("x-request-id"),
  });
  expect(JSON.stringify(vi.mocked(console.error).mock.calls)).not.toContain("비밀 DB 주소");
  vi.restoreAllMocks();
});
