// @vitest-environment node
/**
 * 수업일지 문서 쓰기 경로의 입력·권한·응답 계약을 검증합니다.
 * DB 원장과 비공개 저장소, 토큰 발급을 합성 응답으로 대체합니다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POST } from "@/app/api/resources/class-log-documents/route";
import { ClassLogDocumentUploadError } from "@/features/class-logs/documents/upload-storage";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  limit: vi.fn(),
  write: vi.fn(),
  store: vi.fn(),
  verify: vi.fn(),
  token: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/rate-limit", () => ({ reserveUploadAttempt: mocks.limit }));
vi.mock("@/features/class-logs/documents/write-repository", () => ({
  writeClassLogDocumentRequest: mocks.write,
}));
vi.mock("@/features/class-logs/documents/upload-storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/class-logs/documents/upload-storage")>()),
  classLogDocumentStore: mocks.store,
  verifyClassLogDocumentUpload: mocks.verify,
}));
vi.mock("@vercel/blob/client", () => ({
  generateClientTokenFromReadWriteToken: mocks.token,
}));

const base = "https://resource.invalid";
const actor = "10000000-0000-4000-8000-000000000001";
const requestId = "20000000-0000-4000-8000-000000000001";
const fileId = "30000000-0000-4000-8000-000000000001";
const logId = "40000000-0000-4000-8000-000000000001";
const pdf = { fileFormat: "PDF", originalName: "시험.pdf", sizeBytes: 12 };
const payload = {
  title: "문서 일지",
  content: "",
  classDay: "2026-12-01",
  weekNumber: 1,
  cohortId: null,
  pdf,
};
const registration = { action: "reserve", requestId, ...payload };
const finalize = { action: "finalize", requestId };
const reservation = {
  state: "reserved",
  expiresAt: "2026-12-01T00:15:00Z",
  pdf: { ...pdf, fileId },
  hangul: null,
};
const published = { state: "published", logId, version: 1 };

/** 브라우저와 동일하게 작성 요청의 출처와 JSON 본문을 전달합니다. */
function submit(payload: object, origin = base) {
  return POST(
    new Request(`${base}/api/resources/class-log-documents`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    }),
  );
}

describe("수업일지 문서 쓰기 경로", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("CLASS_LOG_DOCUMENTS_ENABLED", "true");
    vi.stubEnv("CLASS_LOG_DOCUMENT_WRITES_ENABLED", "true");
    mocks.auth.mockResolvedValue({ user: { id: actor, role: "MEMBER" } });
    mocks.limit.mockResolvedValue({ blocked: false, unavailable: false });
    mocks.store.mockReturnValue({ token: "서버 전용 시험 토큰" });
    mocks.token.mockResolvedValue("시험 업로드 토큰");
  });

  afterEach(() => vi.unstubAllEnvs());

  it("기능 비활성과 다른 출처는 세션 확인 전에 차단합니다", async () => {
    vi.stubEnv("CLASS_LOG_DOCUMENTS_ENABLED", "false");
    expect((await submit(registration)).status).toBe(404);
    vi.stubEnv("CLASS_LOG_DOCUMENTS_ENABLED", "true");
    vi.stubEnv("CLASS_LOG_DOCUMENT_WRITES_ENABLED", "true");
    expect((await submit(registration, "https://other.invalid")).status).toBe(403);
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.limit).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it.each([null, { user: { id: actor, role: "PENDING" } }])(
    "로그인하지 않았거나 승인 대기 중이면 요청을 저장하지 않습니다",
    async (session) => {
      mocks.auth.mockResolvedValue(session);
      expect((await submit(registration)).status).toBe(403);
      expect(mocks.limit).not.toHaveBeenCalled();
      expect(mocks.write).not.toHaveBeenCalled();
    },
  );

  it("스키마에 맞는 JSON도 실제 요청 바이트 한도를 넘으면 저장하지 않습니다", async () => {
    // 유효한 입력에 공백만 더해 스키마 실패와 전송 크기 제한을 구분합니다.
    const response = await POST(
      new Request(`${base}/api/resources/class-log-documents`, {
        method: "POST",
        headers: { Origin: base, "Content-Type": "application/json" },
        body: " ".repeat(64 * 1024) + JSON.stringify(registration),
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_INPUT" });
    expect(mocks.limit).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("요청 한도 초과와 제한 저장소 장애는 문서 쓰기 전에 응답합니다", async () => {
    mocks.limit.mockResolvedValueOnce({ blocked: true, retryAfterSec: 10 });
    const limited = await submit(registration);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("10");
    mocks.limit.mockResolvedValueOnce({ unavailable: true });
    expect((await submit(registration)).status).toBe(503);
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it("정상 예약은 정확한 파일 경로·크기·만료를 가진 업로드 토큰을 발급합니다", async () => {
    mocks.write.mockResolvedValueOnce(reservation);
    const response = await submit(registration);
    const pathname = `class-log-documents/${fileId}/original`;
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await response.json()).toEqual({
      state: "upload",
      files: [{ slot: "pdf", pathname, contentType: "application/pdf", token: "시험 업로드 토큰" }],
    });
    expect(mocks.write).toHaveBeenCalledExactlyOnceWith(actor, requestId, "reserve", payload);
    expect(mocks.token).toHaveBeenCalledExactlyOnceWith({
      token: "서버 전용 시험 토큰",
      pathname,
      allowedContentTypes: ["application/pdf"],
      maximumSizeInBytes: 12,
      validUntil: Date.parse(reservation.expiresAt),
      addRandomSuffix: false,
      allowOverwrite: false,
    });
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("미전송 파일은 재시도 응답을 받고 확인 이후 한 번 확정합니다", async () => {
    mocks.write
      .mockResolvedValueOnce(reservation)
      .mockResolvedValueOnce(reservation)
      .mockResolvedValueOnce(published)
      .mockResolvedValueOnce(published);
    mocks.verify.mockRejectedValueOnce(new ClassLogDocumentUploadError("NOT_READY"));

    const retry = await submit(finalize);
    expect(retry.status).toBe(409);
    expect(await retry.json()).toMatchObject({ code: "NOT_READY" });
    expect(mocks.write).toHaveBeenCalledTimes(1);

    const success = await submit(finalize);
    expect(success.status).toBe(200);
    expect(await success.json()).toEqual(published);
    expect(mocks.verify).toHaveBeenLastCalledWith(reservation.pdf);
    expect(mocks.write).toHaveBeenNthCalledWith(3, actor, requestId, "publish");

    expect(await (await submit(finalize)).json()).toEqual(published);
    expect(mocks.verify).toHaveBeenCalledTimes(2);
    expect(mocks.write).toHaveBeenNthCalledWith(4, actor, requestId, "inspect", undefined);
    expect(mocks.token).not.toHaveBeenCalled();
  });

  it.each([
    ["expired", "EXPIRED"],
    ["missing", "EXPIRED"],
    ["conflict", "CONFLICT"],
  ])("확정 중 원장 상태 %s를 재시도 응답으로 전달합니다", async (state, code) => {
    mocks.write.mockResolvedValueOnce({ state });
    const response = await submit(finalize);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code });
    expect(mocks.verify).not.toHaveBeenCalled();
  });
});
