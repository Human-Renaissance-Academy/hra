// @vitest-environment node
/**
 * #516 PR-G 분리 제출 OpenAPI 추가분이 Zod 계약·서버 형식 상수와 일치하고
 * 기존 operation·component를 바꾸지 않는(추가 전용) 문서인지 검증합니다.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  API_V1_ARTIFACT_DOCUMENT_FORMATS,
  API_V1_DOCUMENT_EXTENSIONS,
  API_V1_DOCUMENT_FORMATS,
  API_V1_DOCUMENT_MIME_TYPES,
  apiV1ArtifactUploadIntentInputSchema,
  apiV1ArtifactUploadIntentResponseSchema,
  apiV1AssignmentArtifactsResponseSchema,
  apiV1FinalizeArtifactSubmissionInputSchema,
  apiV1FinalizedArtifactSubmissionResponseSchema,
  apiV1SubmissionArtifactFileSchema,
} from "@hra/contracts/api-v1";
import {
  ARTIFACT_DOCUMENT_FORMATS,
  DOCUMENT_EXTENSIONS,
  DOCUMENT_FORMATS,
  DOCUMENT_MIME_TYPES,
} from "@/features/academics/assignment-uploads/formats/types";

const openapi = JSON.parse(readFileSync("packages/contracts/openapi.json", "utf8"));
const schemas = openapi.components.schemas;
const routes = [
  ["/api/v1/assignments/{id}/artifacts", "get", "getMyAssignmentArtifacts"],
  ["/api/v1/uploads/artifact-intents", "post", "createMyAssignmentArtifactUploadIntent"],
  ["/api/v1/uploads/artifact-intents/{id}", "delete", "cancelMyAssignmentArtifactUploadIntent"],
  ["/api/v1/uploads/artifact-intents/{id}/verify", "post", "verifyMyAssignmentArtifactUpload"],
  ["/api/v1/submissions/artifacts", "post", "finalizeMyAssignmentArtifactSubmission"],
] as const;

describe("분리 제출 OpenAPI 추가분", () => {
  it("추가 전용 검사와 Route 대조를 통과하고 새 operation만 추가한다", () => {
    expect(
      execFileSync(process.execPath, ["scripts/check-openapi-compat.mjs", "--self"], {
        encoding: "utf8",
      }).trim(),
    ).toBe("OPENAPI_APPEND_ONLY_OK self");
    for (const [path, method, operationId] of routes) {
      expect(Object.keys(openapi.paths[path])).toEqual([method]);
      const operation = openapi.paths[path][method];
      expect(operation.operationId).toBe(operationId);
      expect(operation.security).toEqual([{ bearerAuth: [] }]);
      expect(operation.description).toContain("Auth.js Web 세션 쿠키");
      expect(operation.description).toContain("모바일 Bearer access token");
      expect(operation.description).toContain("ACADEMIC_SUBMISSION_ARTIFACTS_ENABLED");
      expect(operation.responses["404"].description).toContain("분리 제출 기능 비활성");
      for (const response of Object.values(operation.responses))
        expect(response).toMatchObject({
          headers: { Vary: { schema: { const: "Cookie, Authorization" } } },
        });
    }
  });

  it("기존 상세의 submission!=null·file==null 조합을 분리 제출로 해석하라는 안내를 명시한다", () => {
    expect(schemas.AcademicAssignmentArtifactsResponse.description).toContain(
      "submission이 null이 아닌데 file이 null이면 분리 제출",
    );
    expect(openapi.paths["/api/v1/assignments/{id}/artifacts"].get.description).toContain(
      "이 operation의 files로 제출물을 확인",
    );
  });

  it("새 DTO의 필수·허용 필드가 Zod 계약과 같다", () => {
    const contracts = [
      ["AcademicSubmissionArtifactFile", apiV1SubmissionArtifactFileSchema],
      ["AcademicAssignmentArtifactsResponse", apiV1AssignmentArtifactsResponseSchema],
      ["AcademicArtifactUploadIntentInput", apiV1ArtifactUploadIntentInputSchema],
      ["AcademicArtifactUploadIntentResponse", apiV1ArtifactUploadIntentResponseSchema],
      ["AcademicFinalizeArtifactSubmissionInput", apiV1FinalizeArtifactSubmissionInputSchema],
      [
        "AcademicFinalizedArtifactSubmissionResponse",
        apiV1FinalizedArtifactSubmissionResponseSchema,
      ],
    ] as const;
    for (const [name, contract] of contracts) {
      expect(schemas[name].additionalProperties).toBe(false);
      expect([...schemas[name].required].sort()).toEqual(Object.keys(contract.shape).sort());
      expect(Object.keys(schemas[name].properties).sort()).toEqual(
        Object.keys(contract.shape).sort(),
      );
    }
    expect(schemas.AcademicSubmissionArtifactFile.properties.mimeType.enum).toEqual(
      Object.values(API_V1_DOCUMENT_MIME_TYPES),
    );
    expect(schemas.AcademicSubmissionArtifactFile.properties.fileFormat.enum).toEqual([
      ...API_V1_DOCUMENT_FORMATS,
    ]);
  });

  it("계약 패키지의 형식·MIME·확장자·항목별 허용 형식이 서버 형식 탐지 상수와 같다", () => {
    expect([...API_V1_DOCUMENT_FORMATS]).toEqual([...DOCUMENT_FORMATS]);
    expect(API_V1_DOCUMENT_MIME_TYPES).toEqual(DOCUMENT_MIME_TYPES);
    expect(API_V1_DOCUMENT_EXTENSIONS).toEqual(DOCUMENT_EXTENSIONS);
    expect(API_V1_ARTIFACT_DOCUMENT_FORMATS).toEqual(ARTIFACT_DOCUMENT_FORMATS);
  });

  it("JSON에 저장한 경로 정규식이 Zod 경계와 같다", () => {
    const pathname = new RegExp(
      schemas.AcademicArtifactUploadIntentResponse.properties.pathname.pattern,
    );
    const download = new RegExp(
      schemas.AcademicSubmissionArtifactFile.properties.downloadPath.pattern,
    );
    const id = "11111111-1111-4111-8111-111111111111";
    expect(pathname.test(`academic-uploads/v2/${id}/original`)).toBe(true);
    expect(pathname.test(`academic-uploads/v1/${id}/document.pdf`)).toBe(false);
    expect(download.test(`/api/v1/submissions/${id}/files/${id}`)).toBe(true);
    expect(download.test(`https://x.invalid/api/v1/submissions/${id}/files/${id}`)).toBe(false);
    const name = new RegExp(
      schemas.AcademicArtifactUploadIntentInput.properties.originalName.pattern,
    );
    for (const invalid of ["../a.hwpx", "a\\b.pptx", "a\u0000.pdf", "확장자없음"])
      expect(name.test(invalid)).toBe(false);
    expect(name.test("본문.HWPX")).toBe(true);
  });

  it("응답 Zod는 V2의 file·LEGACY의 요구·항목 중복·다른 제출의 다운로드 경로를 거부한다", () => {
    const submissionId = "60000000-0000-4000-8000-000000000001";
    const fileId = "70000000-0000-4000-8000-000000000001";
    const file = {
      fileId,
      artifactType: "TEXT",
      fileFormat: "PDF",
      originalName: "a.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1,
      downloadPath: `/api/v1/submissions/${submissionId}/files/${fileId}`,
    };
    const base = {
      assignmentId: submissionId,
      submissionFormat: "ARTIFACTS_V2",
      textRequirement: "REQUIRED",
      slidesRequirement: "DISABLED",
      submission: { submissionId, submittedAt: "2026-10-28T07:00:00.123Z" },
      file: null,
      files: [file],
    };
    expect(apiV1AssignmentArtifactsResponseSchema.safeParse(base).success).toBe(true);
    for (const invalid of [
      {
        ...base,
        file: { fileId, originalName: "a.pdf", mimeType: "application/pdf", sizeBytes: 1 },
      },
      { ...base, files: [file, file] },
      { ...base, textRequirement: "DISABLED" },
      { ...base, submission: null },
      {
        ...base,
        files: [{ ...file, downloadPath: `/api/v1/submissions/${fileId}/files/${fileId}` }],
      },
      { ...base, files: [{ ...file, mimeType: "application/hwp+zip" }] },
      { ...base, submissionFormat: "LEGACY_SINGLE_PDF" },
    ])
      expect(apiV1AssignmentArtifactsResponseSchema.safeParse(invalid).success).toBe(false);
  });
});
