/**
 * 학생 본인의 과제 목록·상세를 반환하는 서버 전용 진입점이다.
 * 요청마다 실제 인증과 기능 gate를 확인하고 명시 DTO를 구성한다. 사용자 ID를 인수로 받지 않는다.
 */
import "server-only";
import { z } from "zod/v4";
import { db } from "@/lib/db";
import {
  AcademicAccessError,
  requireAcademicStudent,
  requireAssignmentTarget,
  withAcademicQueryErrors,
} from "@/lib/academic-permissions";
import { isAcademicSubmissionArtifactsEnabled } from "@/features/academics/assignment-uploads/contract";
import {
  ARTIFACT_DOCUMENT_FORMATS,
  DOCUMENT_FORMATS,
  DOCUMENT_MIME_TYPES,
} from "@/features/academics/assignment-uploads/formats/types";
import {
  MAX_ARTIFACT_FILE_BYTES,
  MAX_ARTIFACT_SUBMISSION_BYTES,
} from "@/lib/db/academic-submission-artifacts";
import {
  buildStudentAssignmentArtifactDetailQuery,
  buildStudentAssignmentDetailQuery,
  buildStudentAssignmentListQuery,
  buildStudentSubmissionArtifactFilesQuery,
} from "./data";
import type {
  StudentArtifactFile,
  StudentArtifactType,
  StudentAssignmentDetail,
  StudentAssignmentPage,
  StudentAssignmentSummary,
} from "./contracts";

// 결과 크기와 최대 OFFSET을 제한한다. 서버 페이지는 문자열 검색 인수를 숫자로 정규화한 뒤 전달한다.
const pagination = z
  .object({
    page: z.number().int().min(1).max(10000).default(1),
    pageSize: z.number().int().min(1).max(50).default(20),
  })
  .strict();

type SummaryRow = Awaited<ReturnType<typeof buildStudentAssignmentListQuery>>[number];

// DB 응답 전체를 펼치지 않고 허용 필드만 선택하여 최소 DTO를 만든다.
function toSummary(row: SummaryRow): StudentAssignmentSummary {
  if (
    row.status === "DRAFT" ||
    !row.dueAt ||
    !row.publishedAt ||
    !Number.isFinite(row.dueAt.getTime()) ||
    !Number.isFinite(row.publishedAt.getTime()) ||
    (row.submittedAt && (!row.submissionId || !Number.isFinite(row.submittedAt.getTime())))
  )
    throw new AcademicAccessError("UNAVAILABLE");
  return {
    assignmentId: row.assignmentId,
    targetId: row.targetId,
    title: row.title,
    status: row.status,
    dueAt: row.dueAt.toISOString(),
    publishedAt: row.publishedAt.toISOString(),
    submission:
      row.submittedAt && row.submissionId
        ? { submissionId: row.submissionId, submittedAt: row.submittedAt.toISOString() }
        : null,
  };
}

export async function getMyAssignments(input: unknown = {}): Promise<StudentAssignmentPage> {
  const { userId } = await requireAcademicStudent();
  const parsed = pagination.safeParse(input);
  if (!parsed.success) throw new AcademicAccessError("INVALID_INPUT");
  const { page, pageSize } = parsed.data;
  const rows = await withAcademicQueryErrors(() =>
    buildStudentAssignmentListQuery(db, userId, page, pageSize),
  );
  return {
    items: rows.slice(0, pageSize).map(toSummary),
    page,
    pageSize,
    hasNextPage: rows.length > pageSize,
  };
}

// 상세 UUID가 유효해도 본인 target과 유효 학적·공개 상태가 모두 일치해야 한다.
export async function getMyAssignment(assignmentId: string): Promise<StudentAssignmentDetail> {
  const target = await requireAssignmentTarget({ assignmentId });
  // #516: 분리 제출 gate가 켜졌을 때만 제출 형식을 읽는다. V2 과제는 전용 경로로, 기존 PDF 과제는 아래 기존 경로로 처리한다.
  if (isAcademicSubmissionArtifactsEnabled()) {
    const detail = await getMyArtifactAssignment(target.userId, target.targetId);
    if (detail) return detail;
  }
  const [row] = await withAcademicQueryErrors(() =>
    buildStudentAssignmentDetailQuery(db, target.userId, target.targetId),
  );
  if (!row) throw new AcademicAccessError("NOT_FOUND");
  // DB 최종 기록의 파일 메타가 빠진 상태를 정상 제출 완료로 표시하지 않는다.
  if (
    row.submittedAt &&
    (!row.fileId ||
      !row.originalName ||
      row.mimeType !== "application/pdf" ||
      row.sizeBytes === null ||
      row.sizeBytes < 1 ||
      row.sizeBytes > 52428800)
  )
    throw new AcademicAccessError("UNAVAILABLE");
  const file =
    row.submittedAt && row.fileId && row.originalName && row.mimeType && row.sizeBytes !== null
      ? {
          fileId: row.fileId,
          originalName: row.originalName,
          mimeType: row.mimeType,
          sizeBytes: row.sizeBytes,
        }
      : null;
  return { ...toSummary(row), instructions: row.instructions, file };
}

// V2 요구·파일 메타의 허용 값. DB CHECK와 같은 형식별 정규 MIME만 받습니다.
const requirement = z.enum(["REQUIRED", "OPTIONAL", "DISABLED"]);
const artifactFile = z
  .object({
    fileId: z.uuid(),
    artifactType: z.enum(["TEXT", "SLIDES"]),
    fileFormat: z.enum(DOCUMENT_FORMATS),
    originalName: z.string().min(1).max(255),
    mimeType: z.string(),
    sizeBytes: z.number().int().min(1).max(MAX_ARTIFACT_FILE_BYTES),
  })
  .refine(
    (file) =>
      file.mimeType === DOCUMENT_MIME_TYPES[file.fileFormat] &&
      ARTIFACT_DOCUMENT_FORMATS[file.artifactType].includes(file.fileFormat),
  );

/**
 * V2 과제 상세를 만든다. 기존 PDF 단일 제출 과제이면 null을 돌려 기존 경로가 처리하게 한다.
 * 제출 완료 상태인데 파일이 0개·3개 이상·항목 중복·요구와 불일치이면 정상 제출로 표시하지 않는다(UNAVAILABLE).
 */
async function getMyArtifactAssignment(
  userId: string,
  targetId: string,
): Promise<StudentAssignmentDetail | null> {
  const [row] = await withAcademicQueryErrors(() =>
    buildStudentAssignmentArtifactDetailQuery(db, userId, targetId),
  );
  if (!row) throw new AcademicAccessError("NOT_FOUND");
  if (row.submissionFormat !== "ARTIFACTS_V2") return null;
  const text = requirement.safeParse(row.textRequirement),
    slides = requirement.safeParse(row.slidesRequirement);
  if (!text.success || !slides.success || (text.data === "DISABLED" && slides.data === "DISABLED"))
    throw new AcademicAccessError("UNAVAILABLE");
  let files: StudentArtifactFile[] = [];
  if (row.submittedAt) {
    const rows = await withAcademicQueryErrors(() =>
      buildStudentSubmissionArtifactFilesQuery(db, userId, targetId),
    );
    const parsed = z.array(artifactFile).min(1).max(2).safeParse(rows);
    if (!parsed.success) throw new AcademicAccessError("UNAVAILABLE");
    const types = parsed.data.map((file) => file.artifactType);
    const required = { TEXT: text.data, SLIDES: slides.data };
    if (
      new Set(types).size !== types.length ||
      types.some((type) => required[type] === "DISABLED") ||
      (Object.keys(required) as StudentArtifactType[]).some(
        (type) => required[type] === "REQUIRED" && !types.includes(type),
      ) ||
      parsed.data.reduce((sum, file) => sum + file.sizeBytes, 0) > MAX_ARTIFACT_SUBMISSION_BYTES
    )
      throw new AcademicAccessError("UNAVAILABLE");
    files = parsed.data;
  }
  return {
    ...toSummary(row),
    instructions: row.instructions,
    file: null,
    artifacts: { textRequirement: text.data, slidesRequirement: slides.data, files },
  };
}
