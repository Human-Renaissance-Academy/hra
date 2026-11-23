// @vitest-environment node
/** 수업일지 원본 검증에서 비공개 저장소, 파일 형식과 본문 제한을 확인합니다. */
import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLASS_LOG_DOCUMENT_MIME_TYPES,
  MAX_CLASS_LOG_DOCUMENT_BYTES,
  classLogDocumentUploadPath,
  classLogDocumentUploadSelection,
  type ClassLogDocumentFormat,
} from "@/features/class-logs/documents/upload-contract";
import { verifyClassLogDocumentUpload } from "@/features/class-logs/documents/upload-storage";
import {
  buildZip,
  hwpxEntries,
  syntheticHwp,
  syntheticPdf,
} from "../support/academic-document-fixtures";

const mocks = vi.hoisted(() => ({ head: vi.fn(), get: vi.fn() }));
vi.mock("@vercel/blob", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@vercel/blob")>()),
  ...mocks,
}));

const fileId = "91bb230e-7239-4563-8d59-e5feddc85035";
const pathname = `class-log-documents/${fileId}/original`;
const host = "example.private.blob.vercel-storage.com";
const token = "synthetic-private-token";
const pdf = syntheticPdf();

/** 정상 Blob의 응답을 준비하고 테스트별로 교체할 부분을 반환합니다. */
function mockOriginal(bytes: Uint8Array, fileFormat: ClassLogDocumentFormat = "PDF") {
  const metadata = {
    url: `https://${host}/${pathname}`,
    pathname,
    contentType: CLASS_LOG_DOCUMENT_MIME_TYPES[fileFormat],
    size: bytes.length,
    etag: '"fixture-etag"',
  };
  const result = {
    statusCode: 200,
    blob: { ...metadata },
    headers: new Headers({ "content-length": String(bytes.length) }),
    stream: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 5));
        controller.enqueue(bytes.subarray(5));
        controller.close();
      },
    }),
  };
  mocks.head.mockResolvedValue(metadata);
  mocks.get.mockResolvedValue(result);
  return { metadata, result };
}

const selection = (fileFormat: ClassLogDocumentFormat = "PDF", sizeBytes = pdf.length) => ({
  fileId,
  fileFormat,
  originalName: `2주차 수업일지.${fileFormat}`,
  sizeBytes,
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("RESOURCE_PRIVATE_BLOB_ENABLED", "true");
  vi.stubEnv("RESOURCE_PRIVATE_BLOB_HOST", host);
  vi.stubEnv("RESOURCE_PRIVATE_READ_WRITE_TOKEN", token);
  vi.stubEnv("VERCEL_ENV", "");
});

afterEach(() => vi.unstubAllEnvs());

describe("수업일지 원본 선택", () => {
  it("파일 UUID에서 원본 경로를 만들고 파일별 상한을 적용합니다", () => {
    expect(classLogDocumentUploadPath(fileId.toUpperCase())).toBe(pathname);
    expect(() => classLogDocumentUploadPath("임의 파일 이름.pdf")).toThrow();
    const input = { fileFormat: "HWPX", originalName: "일지.HWPX" };
    expect(
      classLogDocumentUploadSelection.safeParse({
        ...input,
        sizeBytes: MAX_CLASS_LOG_DOCUMENT_BYTES,
      }).success,
    ).toBe(true);
    expect(
      classLogDocumentUploadSelection.safeParse({
        ...input,
        sizeBytes: MAX_CLASS_LOG_DOCUMENT_BYTES + 1,
      }).success,
    ).toBe(false);
    expect(
      classLogDocumentUploadSelection.safeParse({
        ...input,
        originalName: "일지.pdf",
        sizeBytes: 1,
      }).success,
    ).toBe(false);
  });
});

describe("수업일지 비공개 원본 검증", () => {
  it.each([
    ["PDF", pdf],
    ["HWP", syntheticHwp().bytes],
    ["HWPX", buildZip(hwpxEntries())],
  ] as const)("%s 원본의 검증 결과를 돌려줍니다", async (format, bytes) => {
    mockOriginal(bytes, format);
    await expect(verifyClassLogDocumentUpload(selection(format, bytes.length))).resolves.toEqual({
      etag: '"fixture-etag"',
      sha256: createHash("sha256").update(bytes).digest("hex"),
    });
    expect(mocks.head).toHaveBeenCalledWith(
      pathname,
      expect.objectContaining({ token, abortSignal: expect.any(AbortSignal) }),
    );
    expect(mocks.get).toHaveBeenCalledWith(
      pathname,
      expect.objectContaining({
        access: "private",
        useCache: false,
        token,
        abortSignal: expect.any(AbortSignal),
      }),
    );
  });

  it("공개 저장소 대체 설정에서는 객체 조회를 시작하지 않습니다", async () => {
    vi.stubEnv("RESOURCE_PRIVATE_BLOB_ENABLED", "false");
    await expect(verifyClassLogDocumentUpload(selection())).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    expect(mocks.head).not.toHaveBeenCalled();
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("다른 저장소에서 반환된 메타데이터를 거부합니다", async () => {
    const { metadata } = mockOriginal(pdf);
    metadata.url = `https://different.private.blob.vercel-storage.com/${pathname}`;
    await expect(verifyClassLogDocumentUpload(selection())).rejects.toMatchObject({
      code: "INVALID_FILE",
    });
    expect(mocks.get).not.toHaveBeenCalled();
  });

  it("HEAD 이후 바뀐 객체의 응답 스트림을 취소합니다", async () => {
    const { result } = mockOriginal(pdf);
    const cancel = vi.fn();
    result.blob.etag = '"different-etag"';
    result.stream = new ReadableStream({ cancel });
    await expect(verifyClassLogDocumentUpload(selection())).rejects.toMatchObject({
      code: "INVALID_FILE",
    });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([-1, 1])("실제 스트림 길이가 기대값과 %s바이트 다르면 거부합니다", async (delta) => {
    const { result } = mockOriginal(pdf);
    result.stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(pdf.length + delta));
        controller.close();
      },
    });
    await expect(verifyClassLogDocumentUpload(selection())).rejects.toMatchObject({
      code: "INVALID_FILE",
    });
  });

  it("확장자와 정규 MIME이 일치해도 실제 형식이 다르면 거부합니다", async () => {
    const bytes = buildZip(hwpxEntries());
    mockOriginal(bytes, "PDF");
    await expect(
      verifyClassLogDocumentUpload(selection("PDF", bytes.length)),
    ).rejects.toMatchObject({
      code: "INVALID_FILE",
    });
  });

  it("한 인스턴스에서 원본 두 개를 동시에 읽지 않으며 실패 후 재시도할 수 있습니다", async () => {
    const { metadata } = mockOriginal(pdf);
    const pending = Promise.withResolvers<typeof metadata>();
    mocks.head.mockReturnValueOnce(pending.promise);
    const verification = verifyClassLogDocumentUpload(selection());
    const failed = expect(verification).rejects.toMatchObject({ code: "INVALID_FILE" });

    await expect(verifyClassLogDocumentUpload(selection())).rejects.toMatchObject({
      code: "UNAVAILABLE",
    });
    pending.resolve({ ...metadata, size: 1 });
    await failed;
    await expect(verifyClassLogDocumentUpload(selection())).resolves.toMatchObject({
      etag: metadata.etag,
    });
  });
});
