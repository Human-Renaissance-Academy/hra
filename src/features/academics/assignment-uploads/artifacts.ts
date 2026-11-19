/**
 * #516 텍스트·발표자료 분리 제출(V2) 업로드 서비스
 *
 * 역할:
 * - 산출물 유형(텍스트/발표자료)과 선언 형식(PDF·HWP·HWPX·PPT·PPTX)마다 업로드 의도를 발급합니다.
 * - 업로드된 비공개 Blob을 끝까지 읽어(50MiB 이하) SHA-256을 계산하고, 형식 탐지 모듈의
 *   validateDeclaredDocument로 확장자·선언 형식·정규 MIME·실제 형식·산출물 허용 목록을 교차 검증한 뒤에만
 *   VERIFIED로 기록합니다. 거부 사유는 고정 한국어 문구(INVALID_FILE)로만 돌려줍니다.
 *
 * 사용 위치:
 * - 제출 최종화 서비스(`submissions/artifacts.ts`)가 최종화 직전에 검증을 다시 호출합니다.
 * - 화면·API v1 연결은 후속 PR(#516 PR-F·G)에서 합니다. 기능은 ACADEMIC_SUBMISSION_ARTIFACTS_ENABLED로 기본 비활성입니다.
 *
 * 주의:
 * - 세션 주체·저장 키를 입력으로 받지 않습니다. 대상·소유권·기한은 DB 함수가 다시 확인합니다.
 * - 원본 파일명·저장 경로·URL·토큰은 오류 메시지나 관측 이벤트에 넣지 않습니다.
 */
import "server-only";
import { createHash } from "node:crypto";
import { get, head } from "@vercel/blob";
import { requireAssignmentTarget } from "@/lib/academic-permissions";
import { createAcademicObservation } from "@/lib/academic-observability";
import { observeUpload } from "./observability";
import {
  AcademicUploadError,
  academicUploadPathV2,
  artifactUploadInput,
  assignmentUploadSelection,
  assertAcademicSubmissionArtifactsEnabled,
  MAX_ASSIGNMENT_UPLOAD_BYTES,
} from "./contract";
import { validateDeclaredDocument } from "./formats/detect";
import { DOCUMENT_MIME_TYPES } from "./formats/types";
import { academicSubmissionStore, matchesAcademicBlob } from "./store";
import {
  authorizeUploadRecord,
  issueUploadRecordV2,
  persistUploadVerificationV2,
  reserveAssignmentUploadAttempt,
  type UploadRecord,
} from "./repository";

// DB에서도 다시 검사한다. 이 검사는 불필요한 스토리지 요청을 먼저 차단한다.
function assertOpen(target: { status: string; dueAt: Date }) {
  if (target.status !== "PUBLISHED" || target.dueAt.getTime() <= Date.now())
    throw new AcademicUploadError("EXPIRED");
}

/** V2 의도 원장인지 확인하고 산출물 유형을 좁힙니다. LEGACY_PDF 의도는 이 경로에서 다루지 않습니다. */
function artifactOf(record: UploadRecord): "TEXT" | "SLIDES" | null {
  return record.artifact_type === "TEXT" || record.artifact_type === "SLIDES"
    ? record.artifact_type
    : null;
}

/** 산출물 유형·선언 형식별 업로드 의도를 발급합니다. 반환한 contentType으로만 직접 업로드할 수 있습니다. */
export async function createAssignmentArtifactUploadIntent(
  input: unknown,
  observation = createAcademicObservation("UPLOAD_INTENT", "UPLOAD_INTENT"),
) {
  return observeUpload(observation, async () => {
    assertAcademicSubmissionArtifactsEnabled();
    const parsed = artifactUploadInput.safeParse(input);
    if (!parsed.success) throw new AcademicUploadError("INVALID_FILE", undefined, "SELECTION");
    const request = parsed.data;
    observation.identify({ requestId: request.requestId });
    const target = await requireAssignmentTarget({ assignmentId: request.assignmentId });
    observation.authenticated(target.userId);
    assertOpen(target);
    academicSubmissionStore();
    await reserveAssignmentUploadAttempt(
      target.userId,
      target.targetId,
      "intent",
      request.artifactType,
    );
    // 형식·확장자·크기는 위 입력 검증과 같으므로, 발급 함수의 upload_invalid_file은 과제가 받지 않는 항목(미사용)입니다.
    const id = await issueUploadRecordV2({
      requestId: request.requestId,
      targetId: target.targetId,
      userId: target.userId,
      artifactType: request.artifactType,
      fileFormat: request.fileFormat,
      originalName: request.originalName,
      sizeBytes: request.sizeBytes,
    }).catch((error: unknown) => {
      if (error instanceof AcademicUploadError && error.code === "INVALID_FILE" && !error.reason)
        throw new AcademicUploadError("INVALID_FILE", undefined, "ARTIFACT_DISABLED");
      throw error;
    });
    const record = await authorizeUploadRecord(id, target.userId);
    observation.identify({ requestId: request.requestId, resourceId: id });
    observation.emit("AUTHORIZED");
    return {
      uploadIntentId: id,
      artifactType: request.artifactType,
      fileFormat: request.fileFormat,
      pathname: academicUploadPathV2(id),
      contentType: DOCUMENT_MIME_TYPES[request.fileFormat],
      expiresAt: record.expires_at.toISOString(),
    };
  });
}

/**
 * 인스턴스(프로세스) 단위 원본 검증 동시 실행 상한입니다.
 * 검증은 원본 전체(≤50MiB)를 메모리에 받으므로, Fluid compute처럼 한 인스턴스가 여러 요청을 함께 처리할 때
 * 동시 검증 수를 제한해 원본 버퍼 합계를 최대 약 100MiB로 묶습니다. 자리가 없으면 대기열에서 기다리고,
 * 정해진 시간 안에 자리가 나지 않으면 멈춰 있지 않고 재시도 가능한 고정 오류(UNAVAILABLE, 503)를 돌려줍니다.
 */
export const MAX_CONCURRENT_ARTIFACT_VERIFICATIONS = 2;
export const ARTIFACT_VERIFICATION_QUEUE_TIMEOUT_MS = 10_000;
let activeVerifications = 0;
const verificationQueue: Array<() => void> = [];

/** 자리 하나를 넘겨받거나 반납합니다. 대기자가 있으면 활성 수를 줄이지 않고 바로 넘깁니다. */
function releaseVerificationSlot(): void {
  const next = verificationQueue.shift();
  if (next) next();
  else activeVerifications -= 1;
}

/** 검증 자리를 얻은 뒤 작업을 실행하고, 성공·실패와 관계없이 정확히 한 번 반납합니다. */
export async function withArtifactVerificationSlot<T>(run: () => Promise<T>): Promise<T> {
  if (activeVerifications < MAX_CONCURRENT_ARTIFACT_VERIFICATIONS) {
    activeVerifications += 1;
  } else {
    await new Promise<void>((resolve, reject) => {
      const entry = () => {
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        const index = verificationQueue.indexOf(entry);
        if (index >= 0) verificationQueue.splice(index, 1);
        reject(new AcademicUploadError("UNAVAILABLE"));
      }, ARTIFACT_VERIFICATION_QUEUE_TIMEOUT_MS);
      verificationQueue.push(entry);
    });
  }
  try {
    return await run();
  } finally {
    releaseVerificationSlot();
  }
}

/**
 * 업로드된 V2 원본을 서버가 직접 읽어 검증합니다. 최종 제출이 아니며 같은 의도의 재검증은 멱등입니다.
 * 1) 세션·대상·원장 확인 → 2) 메타(경로·정규 MIME·크기) 대조 → 3) 전체 스트림 수신·SHA-256
 * → 4) 형식 교차 검증 → 5) DB의 현재 권한·기한으로 VERIFIED 기록
 */
export async function verifyAssignmentArtifactUpload(
  input: { assignmentId: string; uploadIntentId: string },
  observation = createAcademicObservation("UPLOAD_VERIFY", "UPLOAD_INTENT"),
): Promise<void> {
  return observeUpload(observation, async () => {
    assertAcademicSubmissionArtifactsEnabled();
    const parsed = assignmentUploadSelection.safeParse(input);
    if (!parsed.success) throw new AcademicUploadError("NOT_FOUND");
    const target = await requireAssignmentTarget({ assignmentId: parsed.data.assignmentId });
    observation.authenticated(target.userId);
    assertOpen(target);
    observation.identify({ resourceId: parsed.data.uploadIntentId });
    const record = await authorizeUploadRecord(parsed.data.uploadIntentId, target.userId);
    const artifact = artifactOf(record);
    if (
      !artifact ||
      record.target_id !== target.targetId ||
      record.storage_key !== academicUploadPathV2(record.intent_id)
    )
      throw new AcademicUploadError("NOT_FOUND");
    observation.emit("AUTHORIZED");
    await reserveAssignmentUploadAttempt(target.userId, target.targetId, "external", artifact);
    const store = academicSubmissionStore();
    const mime = DOCUMENT_MIME_TYPES[record.file_format];
    // 원본 버퍼를 잡는 구간만 인스턴스 동시 실행 상한 안에서 실행합니다.
    await withArtifactVerificationSlot(async () => {
      try {
        const metadata = await head(record.storage_key, {
          token: store.token,
          abortSignal: AbortSignal.timeout(15_000),
        });
        if (
          !matchesAcademicBlob(metadata.url, record.storage_key) ||
          metadata.pathname !== record.storage_key ||
          metadata.contentType !== mime ||
          metadata.size !== record.expected_size ||
          metadata.size < 1 ||
          metadata.size > MAX_ASSIGNMENT_UPLOAD_BYTES
        )
          throw new AcademicUploadError("INVALID_FILE", undefined, "SELECTION");
        const result = await get(record.storage_key, {
          access: "private",
          token: store.token,
          useCache: false,
          abortSignal: AbortSignal.timeout(60_000),
        });
        if (!result || result.statusCode !== 200) throw new AcademicUploadError("NOT_READY");
        if (
          result.blob.pathname !== record.storage_key ||
          !matchesAcademicBlob(result.blob.url, record.storage_key) ||
          result.blob.etag !== metadata.etag ||
          result.blob.size !== metadata.size ||
          result.blob.contentType !== mime
        ) {
          await result.stream.cancel();
          throw new AcademicUploadError("INVALID_FILE", undefined, "SELECTION");
        }
        // 형식 탐지는 ZIP 중앙 디렉터리·CFB FAT처럼 파일 끝을 함께 읽어야 하므로 원본 전체(≤50MiB)를 메모리에 받습니다.
        // 크기는 DB 원장의 예상 크기로 미리 할당하고, 넘치면 즉시 중단합니다. SHA-256은 복사와 함께 스트림으로 계산합니다.
        const bytes = new Uint8Array(record.expected_size);
        const reader = result.stream.getReader();
        const hash = createHash("sha256");
        let length = 0;
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            if (length + chunk.value.byteLength > record.expected_size)
              throw new AcademicUploadError("INVALID_FILE", undefined, "SELECTION");
            bytes.set(chunk.value, length);
            length += chunk.value.byteLength;
            hash.update(chunk.value);
          }
        } finally {
          await reader.cancel();
        }
        if (length !== record.expected_size)
          throw new AcademicUploadError("INVALID_FILE", undefined, "SELECTION");
        const checked = validateDeclaredDocument({
          bytes,
          fileName: record.original_name,
          declaredFormat: record.file_format,
          contentType: result.blob.contentType,
          artifactType: artifact,
        });
        if (!checked.ok) throw new AcademicUploadError("INVALID_FILE", undefined, checked.reason);
        // 원본을 읽는 동안 권한·기한이 바뀌었어도 DB의 현재 값으로 거부한다.
        await persistUploadVerificationV2(
          record.intent_id,
          target.userId,
          hash.digest("hex"),
          metadata.etag,
        ).catch((error: unknown) => {
          // DB의 upload_invalid_file(ETag·체크섬 형식)은 기존 PDF 문구 대신 V2 선택 확인 문구로 안내합니다.
          if (
            error instanceof AcademicUploadError &&
            error.code === "INVALID_FILE" &&
            !error.reason
          )
            throw new AcademicUploadError("INVALID_FILE", undefined, "SELECTION");
          throw error;
        });
      } catch (error) {
        if (error instanceof AcademicUploadError) throw error;
        throw new AcademicUploadError("UNAVAILABLE");
      }
    });
  });
}
