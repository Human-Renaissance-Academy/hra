/**
 * 학생 과제 조회의 명시적 응답 타입이다.
 * 클라이언트에는 자기 과제·최종 제출 메타만 전달하고 저장 키·URL·계정·학적 식별자를 포함하지 않는다.
 */

// 학생 상세 경로와 업로드 액션이 선택할 수 있는 식별자 종류다. 소유권은 서버 DB 조인으로 다시 확인한다.
export type AssignmentTargetSelector = { assignmentId: string } | { targetId: string };
export type StudentAssignmentStatus = "PUBLISHED" | "CLOSED";

// 목록은 파일 식별자를 포함하지 않고 최종 제출 여부와 시각만 보여준다.
export interface StudentAssignmentSummary {
  assignmentId: string;
  targetId: string;
  title: string;
  status: StudentAssignmentStatus;
  dueAt: string;
  publishedAt: string;
  submission: { submissionId: string; submittedAt: string } | null;
}

// 상세에서도 해당 학생의 파일 메타만 제공한다. 실제 다운로드는 별도 서버 인가를 거친다.
export interface StudentAssignmentDetail extends StudentAssignmentSummary {
  instructions: string;
  file: { fileId: string; originalName: string; mimeType: string; sizeBytes: number } | null;
  /**
   * #516 텍스트·발표자료 분리 제출(V2) 과제에만 있습니다. 분리 제출 기능 gate가 꺼져 있거나
   * 기존 PDF 단일 제출 과제이면 키 자체가 없고 위 `file`로 기존 화면을 그대로 사용합니다.
   */
  artifacts?: StudentAssignmentArtifacts;
}

export type StudentArtifactType = "TEXT" | "SLIDES";
export type StudentArtifactRequirement = "REQUIRED" | "OPTIONAL" | "DISABLED";

// V2 최종 제출 파일 메타. 저장 키·체크섬은 포함하지 않으며 다운로드는 기존 서버 인가 경로를 사용합니다.
export interface StudentArtifactFile {
  fileId: string;
  artifactType: StudentArtifactType;
  fileFormat: "PDF" | "HWP" | "HWPX" | "PPT" | "PPTX";
  originalName: string;
  mimeType: string;
  sizeBytes: number;
}

export interface StudentAssignmentArtifacts {
  textRequirement: StudentArtifactRequirement;
  slidesRequirement: StudentArtifactRequirement;
  // 최종 제출 전에는 빈 배열, 제출 후에는 1~2개(항목별 1개)입니다.
  files: StudentArtifactFile[];
}

export interface StudentAssignmentPage {
  items: StudentAssignmentSummary[];
  page: number;
  pageSize: number;
  hasNextPage: boolean;
}

// 신뢰할 수 있는 서버 모듈끼리만 사용하는 일회성 조회 결과다. 직렬화해 권한 증명으로 재사용하지 않는다.
export interface AuthorizedAssignmentTarget {
  userId: string;
  assignmentId: string;
  targetId: string;
  status: StudentAssignmentStatus;
  dueAt: Date;
  publishedAt: Date;
}
