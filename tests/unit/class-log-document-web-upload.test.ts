// @vitest-environment node
/** 수업일지 전송과 확정 실패 후 재시도에서 요청 번호와 완료 슬롯을 보존하는지 검증합니다. */
import { afterEach, expect, it, vi } from "vitest";
import { submitClassLogDocument } from "@/app/(member)/resources/class-logs/_components/class-log-document-upload";

const { put } = vi.hoisted(() => ({ put: vi.fn() }));
vi.mock("@vercel/blob/client", () => ({ put }));

const id = "10000000-0000-4000-8000-000000000001";
const fields = { logId: id, version: 1 };
const published = { state: "published", logId: id, version: 2 };
const pdf = new File(["%PDF-1.7"], "일지.pdf");
const hangul = new File([new Uint8Array(5 * 1024 * 1024 + 1)], "일지.hwpx");
const targets = [
  {
    slot: "pdf",
    pathname: "class-log-documents/1/original",
    contentType: "application/pdf",
    token: "pdf-token",
  },
  {
    slot: "hangul",
    pathname: "class-log-documents/2/original",
    contentType: "application/zip",
    token: "hangul-token",
  },
];

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

it("확정이 준비 상태를 돌려주면 같은 요청 번호로 확정만 반복합니다", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ state: "upload", files: [targets[0]] }))
    .mockResolvedValueOnce(Response.json({ code: "NOT_READY" }, { status: 409 }))
    .mockResolvedValueOnce(Response.json(published));
  vi.stubGlobal("fetch", fetchMock);
  put.mockResolvedValueOnce({});
  const attempt = { requestId: id, uploaded: {}, finalizeOnly: false };

  await expect(submitClassLogDocument(attempt, fields, { pdf }, vi.fn())).rejects.toThrow(
    "다시 시도",
  );
  await expect(submitClassLogDocument(attempt, fields, { pdf }, vi.fn())).resolves.toEqual(
    published,
  );

  expect(put).toHaveBeenCalledExactlyOnceWith(targets[0].pathname, pdf, {
    access: "private",
    token: targets[0].token,
    contentType: targets[0].contentType,
    multipart: false,
  });
  expect(fetchMock.mock.calls.map(([, input]) => JSON.parse(input.body))).toEqual([
    { action: "reserve", requestId: id, ...fields },
    { action: "finalize", requestId: id },
    { action: "finalize", requestId: id },
  ]);
});

it("일부 슬롯 전송이 실패하면 이미 성공한 파일을 다시 보내지 않습니다", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ state: "upload", files: targets }))
    .mockResolvedValueOnce(Response.json({ code: "NOT_READY" }, { status: 409 }))
    .mockResolvedValueOnce(Response.json({ state: "upload", files: targets }))
    .mockResolvedValueOnce(Response.json(published));
  vi.stubGlobal("fetch", fetchMock);
  put
    .mockResolvedValueOnce({})
    .mockRejectedValueOnce(new Error("일시 실패"))
    .mockResolvedValueOnce({});
  const attempt = { requestId: id, uploaded: {}, finalizeOnly: false };

  await expect(submitClassLogDocument(attempt, fields, { pdf, hangul }, vi.fn())).rejects.toThrow(
    "전송을 확인하지 못했습니다",
  );
  await expect(submitClassLogDocument(attempt, fields, { pdf, hangul }, vi.fn())).resolves.toEqual(
    published,
  );

  expect(put.mock.calls.map(([pathname]) => pathname)).toEqual([
    targets[0].pathname,
    targets[1].pathname,
    targets[1].pathname,
  ]);
  expect(put.mock.calls[2][2]).toMatchObject({ multipart: true });
  expect(fetchMock.mock.calls.map(([, input]) => JSON.parse(input.body).requestId)).toEqual([
    id,
    id,
    id,
    id,
  ]);
});

it("전송 응답이 유실되어도 서버가 파일을 확인하면 확정 결과를 사용합니다", async () => {
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ state: "upload", files: [targets[0]] }))
    .mockResolvedValueOnce(Response.json(published));
  vi.stubGlobal("fetch", fetchMock);
  put.mockRejectedValueOnce(new Error("전송 응답 유실"));
  const attempt = { requestId: id, uploaded: {}, finalizeOnly: false };

  await expect(submitClassLogDocument(attempt, fields, { pdf }, vi.fn())).resolves.toEqual(
    published,
  );
  expect(put).toHaveBeenCalledTimes(1);
  expect(fetchMock.mock.calls.map(([, input]) => JSON.parse(input.body).action)).toEqual([
    "reserve",
    "finalize",
  ]);
});
