// @vitest-environment node
/**
 * 수업일지 다운로드의 공동 열람 권한, 비활성 경로, 조회 제한과 첨부 응답을 검증합니다.
 * 합성 스트림으로 응답을 읽으며 외부 저장소에 연결하지 않습니다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/resources/class-log-documents/[id]/download/route";
import {
  getClassLogDocumentDownload,
  listClassLogDocumentHistory,
} from "@/features/class-logs/documents/read-service";
import {
  ResourceReadLimitUnavailableError,
  ResourceReadRateLimitError,
} from "@/features/resources/read-limit";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  reserve: vi.fn(),
  download: vi.fn(),
  history: vi.fn(),
  get: vi.fn(),
}));
vi.mock("@/lib/request-session", () => ({ getRequestSession: mocks.session }));
vi.mock("@/features/resources/read-limit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/resources/read-limit")>()),
  enforceResourceReadLimit: mocks.reserve,
}));
vi.mock("@/features/class-logs/documents/read-repository", () => ({
  findClassLogDocumentDownload: mocks.download,
  findClassLogDocumentHistory: mocks.history,
}));
vi.mock("@vercel/blob", () => ({ get: mocks.get }));

const fileId = "30000000-0000-4000-8000-000000000001";
const key = `class-log-documents/${fileId}/original`;
const host = "test-only.private.blob.vercel-storage.com";
const file = { storageKey: key, fileName: "시험.pdf", byteSize: 3, format: "PDF" };
const userId = "10000000-0000-4000-8000-000000000001";

function download(id = fileId) {
  const request = new Request("https://resource.invalid?inline=1");
  return GET(request, { params: Promise.resolve({ id }) });
}

function mockBlob(bytes: Uint8Array, url = `https://${host}/${key}`) {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  mocks.get.mockResolvedValue({
    statusCode: 200,
    stream,
    blob: { pathname: key, size: 3, url, contentType: "application/pdf" },
  });
  return stream;
}

describe("수업일지 원본 보호 다운로드", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("CLASS_LOG_DOCUMENTS_ENABLED", "true");
    vi.stubEnv("RESOURCE_PRIVATE_BLOB_HOST", host);
    vi.stubEnv("RESOURCE_PRIVATE_READ_WRITE_TOKEN", "test-only-token");
    mocks.session.mockResolvedValue({ user: { id: userId, role: "MEMBER" } });
    mocks.download.mockResolvedValue(file);
  });

  afterEach(() => vi.unstubAllEnvs());

  it.each([
    [null, "/login"],
    [{ user: { role: "PENDING" } }, "/pending"],
  ])(
    "공동 자료 열람 권한 밖에서는 두 읽기 경로가 모두 이동 처리합니다",
    async (session, destination) => {
      vi.stubEnv("CLASS_LOG_DOCUMENTS_ENABLED", "false");
      mocks.session.mockResolvedValue(session);
      const digest = `NEXT_REDIRECT;replace;${destination};307;`;
      await expect(download()).rejects.toMatchObject({ digest });
      await expect(listClassLogDocumentHistory(fileId)).rejects.toMatchObject({ digest });
      expect(mocks.reserve).not.toHaveBeenCalled();
      expect(mocks.download).not.toHaveBeenCalled();
      expect(mocks.history).not.toHaveBeenCalled();
      expect(mocks.get).not.toHaveBeenCalled();
    },
  );

  it("PDF 미리보기에서 한글 파일은 저장소를 조회하지 않으며 확인된 PDF만 브라우저로 전달합니다", async () => {
    const preview = () => getClassLogDocumentDownload(Promise.resolve({ id: fileId }), true);
    mocks.download.mockResolvedValueOnce({ ...file, format: "HWPX" });
    expect((await preview()).status).toBe(404);
    expect(mocks.get).not.toHaveBeenCalled();
    mockBlob(Uint8Array.of(1, 2, 3));
    const response = await preview();
    expect(response.headers.get("Content-Type")).toBe("application/pdf");
    expect(response.headers.get("Content-Disposition")).toMatch(/^inline/);
    expect(response.headers.get("Content-Security-Policy")).toContain("sandbox");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.of(1, 2, 3));
  });

  it("비활성이거나 ID가 잘못되면 자료 조회 없이 종료합니다", async () => {
    vi.stubEnv("CLASS_LOG_DOCUMENTS_ENABLED", "false");
    expect((await download()).status).toBe(404);
    expect(await listClassLogDocumentHistory(fileId)).toBeNull();
    vi.stubEnv("CLASS_LOG_DOCUMENTS_ENABLED", "true");
    expect((await download("잘못된 ID")).status).toBe(404);
    expect(await listClassLogDocumentHistory("잘못된 ID")).toBeNull();
    expect(mocks.reserve).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.history).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("조회 한도 초과나 제한 저장소 장애에서는 원본을 조회하지 않습니다", async () => {
    mocks.reserve.mockRejectedValueOnce(new ResourceReadRateLimitError(15));
    const limited = await download();
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("15");
    mocks.reserve.mockRejectedValueOnce(new ResourceReadLimitUnavailableError());
    expect((await download()).status).toBe(503);
    expect(mocks.reserve).toHaveBeenLastCalledWith(userId);
    expect(mocks.download).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("확정 버전에 연결된 행과 일치하는 저장 키가 있어야 저장소를 조회합니다", async () => {
    mocks.download.mockResolvedValueOnce(null).mockResolvedValueOnce({
      ...file,
      storageKey: "class-log-documents/다른-키/original",
    });
    const missing = await download();
    const inconsistent = await download();
    expect(missing.status).toBe(404);
    expect(inconsistent.status).toBe(404);
    expect(await missing.text()).toBe(await inconsistent.text());
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it.each(["MEMBER", "FACULTY", "ADMIN"])(
    "%s에게 같은 첨부 다운로드를 제공합니다",
    async (role) => {
      mocks.session.mockResolvedValue({ user: { id: userId, role } });
      mockBlob(Uint8Array.of(1, 2, 3));
      const response = await download();
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
      expect(response.headers.get("Content-Disposition")).toMatch(/^attachment;.*%EC%8B%9C/);
      expect(response.headers.get("Location")).toBeNull();
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(Uint8Array.of(1, 2, 3));
      expect(mocks.get).toHaveBeenCalledOnce();
      expect(mocks.get).toHaveBeenCalledWith(key, {
        abortSignal: expect.any(AbortSignal),
        access: "private",
        token: "test-only-token",
        storeId: "test-only",
        useCache: false,
      });
    },
  );

  it("비공개 설정 누락 시 파일을 제공하지 않습니다", async () => {
    vi.stubEnv("RESOURCE_PRIVATE_READ_WRITE_TOKEN", undefined);
    expect((await download()).status).toBe(502);
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("반환된 객체 정보가 일치하지 않을 때 스트림을 닫습니다", async () => {
    const stream = mockBlob(Uint8Array.of(1, 2, 3), "https://other.invalid/fixture");
    expect((await download()).status).toBe(502);
    expect((await stream.getReader().read()).done).toBe(true);
  });

  it("전송 바이트가 확정 정보보다 짧으면 본문 읽기를 실패 처리합니다", async () => {
    mockBlob(Uint8Array.of(1, 2));
    await expect((await download()).arrayBuffer()).rejects.toThrow("파일 전송이 중단되었습니다.");
  });
});
