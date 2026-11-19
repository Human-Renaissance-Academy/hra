/**
 * 세 게시글 생성 액션이 첨부 메타를 글과 같은 배치에 넣고 실패 후 Blob을 정리하는지 검증합니다.
 * 실제 운영 DB·Blob에는 쓰지 않으며 외부 경계에 실패를 주입합니다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  requireAdmin: vi.fn(),
  put: vi.fn(),
  recordOwnedBlob: vi.fn(),
  deleteBlobIfExists: vi.fn(),
  batch: vi.fn(),
  insertValues: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn(),
  logServerError: vi.fn(),
  existing: false,
  validateResourceUploadReference: vi.fn(),
  validateWeeklyTextImageReference: vi.fn(),
  validateAlumniImageReference: vi.fn(),
  validateFacultyImageReference: vi.fn(),
}));

vi.mock("@vercel/blob", () => ({ put: mocks.put }));
vi.mock("@/lib/auth", () => ({ auth: mocks.auth }));
vi.mock("@/lib/admin", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/owned-blob", () => ({ recordOwnedBlob: mocks.recordOwnedBlob }));
vi.mock("@/lib/blob-utils", () => ({ deleteBlobIfExists: mocks.deleteBlobIfExists }));
vi.mock("@/lib/resource-upload-server", () => ({
  validateResourceUploadReference: mocks.validateResourceUploadReference,
}));
vi.mock("@/lib/weekly-text-image-upload", () => ({
  validateWeeklyTextImageReference: mocks.validateWeeklyTextImageReference,
}));
vi.mock("@/lib/alumni-upload-server", () => ({
  validateAlumniImageReference: mocks.validateAlumniImageReference,
}));
vi.mock("@/lib/faculty-upload-server", () => ({
  validateFacultyImageReference: mocks.validateFacultyImageReference,
}));
vi.mock("@/lib/errors", () => ({ logServerError: mocks.logServerError }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/db", () => ({
  db: {
    insert: (table: unknown) => ({
      values: (values: unknown) => {
        mocks.insertValues(table, values);
        return {
          table,
          values,
          then: (resolve: (value: unknown) => void) =>
            Promise.resolve([{ id: "created" }]).then(resolve),
        };
      },
    }),
    batch: mocks.batch,
    select: (fields: Record<string, unknown>) => ({
      from: () => ({
        then: (resolve: (value: unknown) => void) =>
          Promise.resolve([{ maxOrder: 0 }]).then(resolve),
        where: () => ({
          limit: () =>
            Promise.resolve(mocks.existing ? [{ id: "created", fileUrl: "https://blob/old" }] : []),
          then: (resolve: (value: unknown) => void) =>
            Promise.resolve(fields.url ? [{ url: "https://blob/old" }] : []).then(resolve),
        }),
      }),
    }),
  },
}));

import { createClassLog } from "@/features/class-logs/actions";
import { createWeeklyText } from "@/features/weekly-texts/actions";
import { createAlumniStory } from "@/features/alumni/actions";
import { createFaculty } from "@/features/faculty/actions";

const requestId = "11111111-1111-4111-8111-111111111111";
const userId = "22222222-2222-4222-8222-222222222222";

function image() {
  return new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], "photo.png", {
    type: "image/png",
  });
}

function classLogForm() {
  const form = new FormData();
  form.set("requestId", requestId);
  form.set("title", "수업일지");
  form.set("content", "수업 내용");
  form.set("classDate", "2026-10-13");
  form.append("images", image());
  return form;
}

function weeklyTextForm() {
  const form = new FormData();
  form.set("requestId", requestId);
  form.set("title", "주차별 텍스트");
  form.set("body", "본문");
  form.append("images", image());
  return form;
}

function alumniForm() {
  const form = new FormData();
  form.set("requestId", requestId);
  form.set("name", "수료생");
  form.set("quote", "대표 문구");
  form.set("content", "본문");
  form.append("images", image());
  return form;
}

describe("게시글과 첨부 메타 생성", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.existing = false;
    mocks.requireAdmin.mockResolvedValue({ user: { id: userId, role: "ADMIN" } });
    mocks.auth.mockResolvedValue({ user: { id: userId, role: "ADMIN" } });
    mocks.put.mockResolvedValue({ url: "https://blob/new" });
    mocks.recordOwnedBlob.mockResolvedValue(undefined);
    mocks.deleteBlobIfExists.mockResolvedValue(undefined);
    mocks.batch.mockResolvedValue([]);
    mocks.validateResourceUploadReference.mockResolvedValue({
      url: "https://blob/direct",
      fileName: "자료.pdf",
    });
    mocks.validateWeeklyTextImageReference.mockResolvedValue(true);
    mocks.validateAlumniImageReference.mockResolvedValue(true);
    mocks.validateFacultyImageReference.mockResolvedValue(true);
  });

  it.each([
    ["수업일지", createClassLog, classLogForm],
    ["주차별 텍스트", createWeeklyText, weeklyTextForm],
    ["수료생 이야기", createAlumniStory, alumniForm],
  ])(
    "%s 첨부 INSERT 실패 시 글·메타 배치가 실패하고 새 Blob을 정리한다",
    async (_label, create, makeForm) => {
      mocks.batch.mockRejectedValueOnce(new Error("첨부 INSERT 실패"));

      const result = await create(makeForm());

      expect(result?.success).toBe(false);
      expect(mocks.batch).toHaveBeenCalledTimes(1);
      expect(mocks.batch.mock.calls[0]?.[0]).toHaveLength(2);
      expect(mocks.deleteBlobIfExists).toHaveBeenCalledExactlyOnceWith("https://blob/new");
    },
  );

  // 같은 폼 입력으로 두 생성 액션의 이미지 검증 계약을 추출 전에 고정합니다.
  describe.each([
    ["수업일지", createClassLog, classLogForm, "class-logs/"],
    ["주차별 텍스트", createWeeklyText, weeklyTextForm, "weekly-texts/images/"],
  ] as const)("%s 이미지 FormData 계약", (_label, create, makeForm, namespace) => {
    // 기존 필수 입력은 유지하고 images 필드만 시험별로 교체합니다.
    function withImages(...entries: (File | string)[]) {
      const form = makeForm();
      form.delete("images");
      for (const entry of entries) form.append("images", entry);
      return form;
    }

    it("문자열·빈 파일은 제외하고 복수 파일의 MIME과 저장 순서를 유지한다", async () => {
      const png = image();
      const gif = new File(["GIF89a"], "second.gif");
      expect(
        await create(withImages("무시할 문자열", png, new File([], "empty.png"), gif)),
      ).toEqual({ success: true });
      expect(
        mocks.put.mock.calls.map(([path, file, options]) => ({
          namespace: path.startsWith(namespace),
          name: file.name,
          contentType: options.contentType,
        })),
      ).toEqual([
        { namespace: true, name: "photo.png", contentType: "image/png" },
        { namespace: true, name: "second.gif", contentType: "image/gif" },
      ]);
      expect(
        mocks.batch.mock.calls[0]?.[0][1].values.map((row: { order: number }) => row.order),
      ).toEqual([0, 1]);
    });

    it("정확히 10MiB인 실제 PNG 파일을 허용한다", async () => {
      const bytes = new Uint8Array(10 * 1024 * 1024);
      bytes.set(new Uint8Array(await image().arrayBuffer()));
      expect(
        await create(withImages(new File([bytes], "limit.png", { type: "image/png" }))),
      ).toEqual({ success: true });
      expect(mocks.put).toHaveBeenCalledExactlyOnceWith(
        expect.stringContaining(namespace),
        expect.any(File),
        expect.objectContaining({ contentType: "image/png" }),
      );
    });

    it("이미지가 모두 비어 있으면 본문만 저장하고 첨부를 만들지 않는다", async () => {
      expect(await create(withImages("문자열", new File([], "empty.png")))).toEqual({
        success: true,
      });
      expect(mocks.insertValues).toHaveBeenCalledTimes(1);
      expect(mocks.put).not.toHaveBeenCalled();
      expect(mocks.batch).not.toHaveBeenCalled();
    });

    // 서버 경유 이미지는 직접 URL 목록(100개)과 별도로 20장 상한(#539)을 적용한다.
    it("FormData 이미지는 20장까지 저장하고 21장부터는 업로드 전에 거부한다", async () => {
      expect(await create(withImages(...Array.from({ length: 20 }, () => image())))).toEqual({
        success: true,
      });
      expect(mocks.put).toHaveBeenCalledTimes(20);
      expect(mocks.batch.mock.calls[0]?.[0][1].values).toHaveLength(20);

      mocks.put.mockClear();
      mocks.batch.mockClear();
      expect(await create(withImages(...Array.from({ length: 21 }, () => image())))).toEqual({
        success: false,
        error: "사진은 한 번에 20장까지 올릴 수 있습니다.",
      });
      expect(mocks.put).not.toHaveBeenCalled();
      expect(mocks.batch).not.toHaveBeenCalled();
    });

    it.each([
      [
        "시그니처 위장",
        () => [new File(["not an image"], "fake.png", { type: "image/png" })],
        "사진은 JPG, PNG, WEBP, GIF 형식만 업로드할 수 있습니다.",
      ],
      [
        "선언 MIME 위장",
        () => [
          new File([new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])], "fake.gif", {
            type: "image/png",
          }),
        ],
        "사진은 JPG, PNG, WEBP, GIF 형식만 업로드할 수 있습니다.",
      ],
      [
        "10MiB 초과",
        () => [
          new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.png", { type: "image/png" }),
        ],
        "사진 파일은 10MB 이하여야 합니다.",
      ],
      [
        "위장 다음 초과",
        () => [
          new File(["fake"], "fake.png"),
          new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.png"),
        ],
        "사진은 JPG, PNG, WEBP, GIF 형식만 업로드할 수 있습니다.",
      ],
      [
        "초과 다음 위장",
        () => [
          new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.png"),
          new File(["fake"], "fake.png"),
        ],
        "사진 파일은 10MB 이하여야 합니다.",
      ],
    ] as const)(
      "%s는 첫 오류 문구를 반환하고 업로드·저장·정리·캐시를 실행하지 않는다",
      async (_case, files, error) => {
        expect(await create(withImages(...files()))).toEqual({ success: false, error });
        expect(mocks.put).not.toHaveBeenCalled();
        expect(mocks.insertValues).not.toHaveBeenCalled();
        expect(mocks.batch).not.toHaveBeenCalled();
        expect(mocks.deleteBlobIfExists).not.toHaveBeenCalled();
        expect(mocks.revalidatePath).not.toHaveBeenCalled();
      },
    );
  });

  it("수업일지의 업로드 실패는 DB 배치를 실행하지 않고 같은 요청 키로 재시도할 수 있다", async () => {
    mocks.put.mockRejectedValueOnce(new Error("업로드 실패"));
    const failed = await createClassLog(classLogForm());
    expect(failed.success).toBe(false);
    expect(mocks.batch).not.toHaveBeenCalled();

    const retried = await createClassLog(classLogForm());
    expect(retried.success).toBe(true);
    expect(mocks.batch).toHaveBeenCalledTimes(1);
    expect(mocks.batch.mock.calls[0]?.[0][0].values.id).toBe(requestId);
    expect(mocks.put).toHaveBeenLastCalledWith(
      expect.any(String),
      expect.any(File),
      expect.objectContaining({ contentType: "image/png" }),
    );
  });

  it("같은 요청 키의 재제출은 Blob 업로드와 DB INSERT를 다시 하지 않는다", async () => {
    mocks.existing = true;
    const result = await createClassLog(classLogForm());
    expect(result.success).toBe(true);
    expect(mocks.put).not.toHaveBeenCalled();
    expect(mocks.batch).not.toHaveBeenCalled();
  });

  it("같은 키의 동시 제출로 배치가 충돌하면 나중 요청의 Blob만 정리한다", async () => {
    mocks.batch.mockImplementationOnce(() => {
      mocks.existing = true;
      return Promise.reject(new Error("중복 키"));
    });

    const result = await createClassLog(classLogForm());
    expect(result.success).toBe(true);
    expect(mocks.deleteBlobIfExists).toHaveBeenCalledExactlyOnceWith("https://blob/new");
  });

  it("날짜 검증 실패는 파일을 올리지 않는다", async () => {
    const form = weeklyTextForm();
    form.set("classDate", "잘못된 날짜");
    const result = await createWeeklyText(form);
    expect(result.success).toBe(false);
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("선언 MIME만 PDF인 가짜 문서는 Blob에 올리지 않는다", async () => {
    const form = weeklyTextForm();
    form.set("file", new File(["<html>"], "가짜.pdf", { type: "application/pdf" }));
    const result = await createWeeklyText(form);
    expect(result.success).toBe(false);
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("주차별 텍스트의 검증된 직접 업로드 URL만 DB에 저장한다", async () => {
    const form = new FormData();
    form.set("requestId", requestId);
    form.set("title", "주차별 텍스트");
    form.set("uploadedFileUrl", "https://blob/direct");
    form.set("uploadedFileName", "자료.pdf");
    const result = await createWeeklyText(form);
    expect(result.success).toBe(true);
    expect(mocks.validateResourceUploadReference).toHaveBeenCalledWith(
      "weekly-texts",
      userId,
      "https://blob/direct",
      "자료.pdf",
    );
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fileUrl: "https://blob/direct", fileName: "자료.pdf" }),
    );
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("주차별 텍스트의 위조된 완료 URL은 DB에 저장하지 않는다", async () => {
    const form = new FormData();
    form.set("requestId", requestId);
    form.set("title", "주차별 텍스트");
    form.set("uploadedFileUrl", "https://evil.example/file.pdf");
    form.set("uploadedFileName", "자료.pdf");
    mocks.validateResourceUploadReference.mockResolvedValue({ error: "위조된 URL" });
    const result = await createWeeklyText(form);
    expect(result.success).toBe(false);
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });

  it("주차별 텍스트의 검증된 직접 업로드 사진을 첨부 행으로 저장한다", async () => {
    const form = new FormData();
    form.set("requestId", requestId);
    form.set("title", "주차별 텍스트");
    form.set("body", "본문");
    form.set("uploadedImageUrls", JSON.stringify(["https://blob/photo"]));
    const result = await createWeeklyText(form);
    expect(result.success).toBe(true);
    expect(mocks.validateWeeklyTextImageReference).toHaveBeenCalledWith(
      requestId,
      userId,
      "https://blob/photo",
    );
    expect(mocks.batch).toHaveBeenCalledOnce();
    expect(mocks.batch.mock.calls[0]?.[0][1].values[0].url).toBe("https://blob/photo");
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("주차별 텍스트의 위조된 사진 URL은 첨부 행에 저장하지 않는다", async () => {
    const form = new FormData();
    form.set("requestId", requestId);
    form.set("title", "주차별 텍스트");
    form.set("body", "본문");
    form.set("uploadedImageUrls", JSON.stringify(["https://evil.example/photo.png"]));
    mocks.validateWeeklyTextImageReference.mockResolvedValue(false);
    expect((await createWeeklyText(form)).success).toBe(false);
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });

  it("수료생 사진의 검증된 직접 업로드 URL만 글과 첨부 행에 저장한다", async () => {
    const form = alumniForm();
    form.delete("images");
    form.set("uploadedImageUrls", JSON.stringify(["https://blob/alumni"]));
    await createAlumniStory(form);
    expect(mocks.validateAlumniImageReference).toHaveBeenCalledWith(
      requestId,
      userId,
      "https://blob/alumni",
    );
    expect(mocks.batch.mock.calls[0]?.[0][1].values[0].url).toBe("https://blob/alumni");
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("수료생 사진의 위조된 완료 URL은 저장하지 않는다", async () => {
    const form = alumniForm();
    form.delete("images");
    form.set("uploadedImageUrls", JSON.stringify(["https://evil.example/photo.png"]));
    mocks.validateAlumniImageReference.mockResolvedValue(false);
    const result = await createAlumniStory(form);
    expect(result?.success).toBe(false);
    expect(mocks.batch).not.toHaveBeenCalled();
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("교수진 생성은 검증된 직접 업로드 사진만 DB에 저장한다", async () => {
    const form = new FormData();
    form.set("name", "교수");
    form.set("category", "CLASSICS");
    form.set("order", "0");
    form.set("uploadTargetId", requestId);
    form.set("uploadedImageUrl", "https://blob/faculty");
    await createFaculty(form);
    expect(mocks.validateFacultyImageReference).toHaveBeenCalledWith(
      requestId,
      userId,
      "https://blob/faculty",
    );
    expect(mocks.insertValues).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ imageUrl: "https://blob/faculty" }),
    );
    expect(mocks.put).not.toHaveBeenCalled();
  });

  it("교수진 생성은 위조된 사진 URL을 DB에 저장하지 않는다", async () => {
    const form = new FormData();
    form.set("name", "교수");
    form.set("category", "CLASSICS");
    form.set("order", "0");
    form.set("uploadTargetId", requestId);
    form.set("uploadedImageUrl", "https://evil.example/photo.png");
    mocks.validateFacultyImageReference.mockResolvedValue(false);
    const result = await createFaculty(form);
    expect(result.success).toBe(false);
    expect(mocks.insertValues).not.toHaveBeenCalled();
  });
});
