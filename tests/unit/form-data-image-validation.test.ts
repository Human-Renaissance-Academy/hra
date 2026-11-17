/**
 * 공통 이미지 FormData 헬퍼의 반환 계약과 순차 검증 중단을 확인합니다.
 * 업로드·DB 경계는 기존 생성 액션 회귀가 검증하므로 여기서는 순수 입력만 사용합니다.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { getValidatedImageFiles } from "@/lib/form-data-image-validation";
import * as uploadValidation from "@/lib/upload-file-validation";

// 유효한 GIF 헤더로 실제 하위 validator를 통과시키는 합성 파일입니다.
const image = (name: string) => new File(["GIF89a"], name, { type: "image/gif" });

afterEach(() => vi.restoreAllMocks());

describe("공통 이미지 FormData 검증", () => {
  it("이미지가 없으면 비어 있는 파일·MIME 배열을 반환한다", async () => {
    expect(await getValidatedImageFiles(new FormData())).toEqual({ files: [], contentTypes: [] });
  });

  it("선별한 원본 File과 서버 MIME을 같은 인덱스로 반환한다", async () => {
    const form = new FormData();
    const first = image("first.gif");
    const second = image("second.gif");
    form.append("images", "무시할 문자열");
    form.append("images", first);
    form.append("images", new File([], "empty.gif"));
    form.append("images", second);

    const result = await getValidatedImageFiles(form);
    expect(result).toEqual({ files: [first, second], contentTypes: ["image/gif", "image/gif"] });
    if ("error" in result) throw new Error("유효한 입력의 예상하지 못한 검증 오류");
    expect(result.files[0]).toBe(first);
    expect(result.files[1]).toBe(second);
  });

  it("첫 파일 검증을 기다리고 다음 파일 오류 뒤의 파일은 검사하지 않는다", async () => {
    const form = new FormData();
    const files = [image("first.gif"), image("invalid.gif"), image("unread.gif")];
    for (const file of files) form.append("images", file);

    // 첫 검증 Promise를 직접 완료시켜 병렬 검증으로 바뀌는 회귀를 탐지합니다.
    let finishFirst: ((contentType: string) => void) | undefined;
    const pendingFirst = new Promise<string>((resolve) => {
      finishFirst = resolve;
    });
    const validate = vi
      .spyOn(uploadValidation, "validateImageUpload")
      .mockReturnValueOnce(pendingFirst)
      .mockResolvedValueOnce(null);
    const pendingResult = getValidatedImageFiles(form);
    expect(validate).toHaveBeenCalledExactlyOnceWith(files[0]);
    if (!finishFirst) throw new Error("첫 파일 검증 완료 함수가 준비되지 않았습니다.");
    finishFirst("image/gif");

    expect(await pendingResult).toEqual({
      error: "사진은 JPG, PNG, WEBP, GIF 형식만 업로드할 수 있습니다.",
    });
    expect(validate.mock.calls.map(([file]) => file)).toEqual(files.slice(0, 2));
  });
});
