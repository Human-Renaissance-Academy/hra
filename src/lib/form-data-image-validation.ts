/**
 * 수업일지와 주차별 텍스트 액션의 이미지 FormData 입력을 검증합니다.
 * 인증·업로드·DB 저장 없이 파일 순서와 서버가 판정한 MIME을 함께 반환합니다.
 */
import { validateImageUpload } from "@/lib/upload-file-validation";

// 기존 폼 업로드의 경계값을 유지하며 정확히 10MiB인 파일은 허용합니다.
const maxImageSize = 10 * 1024 * 1024;

/** 문자열과 빈 파일은 제외하고 각 파일을 순차 검사해 첫 오류에서 멈춥니다. */
export const getValidatedImageFiles = async (formData: FormData) => {
  const files = formData
    .getAll("images")
    .filter((value): value is File => value instanceof File && value.size > 0);

  const contentTypes: string[] = [];
  for (const file of files) {
    if (file.size > maxImageSize) {
      return { error: "사진 파일은 10MB 이하여야 합니다." } as const;
    }
    const contentType = await validateImageUpload(file);
    if (!contentType) {
      return {
        error: "사진은 JPG, PNG, WEBP, GIF 형식만 업로드할 수 있습니다.",
      } as const;
    }
    contentTypes.push(contentType);
  }

  return { files, contentTypes } as const;
};
