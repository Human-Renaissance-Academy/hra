/**
 * #516 텍스트·발표자료 분리 제출(V2) 학생 제출 폼
 *
 * 역할:
 * - 과제가 요구하는 항목(텍스트·발표자료)마다 파일 선택 → 업로드 의도 발급 → 비공개 직접 전송 → 서버 검증을 진행합니다.
 * - 항목별로 다시 시도·취소할 수 있고, 필수 항목이 모두 확인되고 최소 1개 파일이 있을 때만 최종 제출을 켭니다.
 * - 최종 제출은 멱등 키 하나로 두 항목을 한 번에 원자적으로 확정하며, 완료 뒤에는 제출 파일과 다운로드 링크를 보여 줍니다.
 *
 * 사용 위치:
 * - `src/app/(member)/member/assignments/[id]/page.tsx` (분리 제출 기능 gate가 켜진 V2 과제에서만)
 *
 * 주의:
 * - 브라우저 검사(확장자·50MiB·합계 100MiB·필수 항목)는 안내용입니다. 실제 판정은 서버 검증과 DB 최종화가 다시 수행합니다.
 * - 서버가 돌려준 contentType으로만 업로드하며, 오류는 서버의 고정 한국어 문구만 표시합니다.
 * - 재시도 정보(멱등 키·요청 ID·의도 ID)만 탭 저장소에 남기고 파일·파일명은 저장하지 않습니다.
 */
"use client";
import { useEffect, useRef, useState } from "react";
import { uploadAssignmentArtifactFile } from "@/features/academics/assignment-uploads/client";
import { AcademicUploadError } from "@/features/academics/assignment-uploads/contract";
import { DOCUMENT_MIME_TYPES } from "@/features/academics/assignment-uploads/formats/types";
import {
  cancelArtifactUpload,
  finalizeArtifactSubmission,
  issueArtifactUploadIntent,
  verifyArtifactUpload,
} from "@/features/academics/submissions/artifact-actions";
import { refreshMyAssignment } from "@/features/academics/student-assignments/ui-actions";
import {
  ARTIFACT_LABELS,
  ARTIFACT_ORDER,
  REQUIREMENT_LABELS,
  artifactAccept,
  artifactFormatLabel,
  artifactSubmissionReadiness,
  checkArtifactFile,
  exceedsArtifactTotal,
  formatArtifactSize,
  readArtifactAttempt,
  saveArtifactAttempt,
  type ArtifactAttempt,
} from "@/features/academics/student-assignments/artifact-submission";
import type {
  StudentArtifactType,
  StudentAssignmentDetail,
} from "@/features/academics/student-assignments/contracts";
import { formatKstDateTimeWithSeconds } from "@/lib/date-time";
import { AcademicRequestReference } from "@/components/academics/request-reference";
import { readAcademicRequestReference } from "@/lib/academic-request-reference";

// 항목별 진행 단계. 색상이 아니라 문구로 상태를 구분합니다.
type Stage =
  | "empty" // 파일 미선택 또는 선택만 함
  | "uploading" // 의도 발급·직접 전송 중
  | "verifying" // 서버 검증 중
  | "verified" // 서버 검증 완료(최종 제출 대상)
  | "uploadFailed" // 전송 실패: 같은 요청으로 다시 전송 가능
  | "verifyFailed" // 검증 요청 실패: 같은 업로드로 다시 확인 가능
  | "rejected" // 서버가 파일을 거부: 취소 후 다른 파일 선택
  | "cancelling";
type Section = {
  stage: Stage;
  file: File | null;
  requestId: string;
  uploadIntentId?: string;
  pathname?: string;
  contentType?: string;
  sizeBytes?: number;
  progress: number;
  message: string;
  referenceId?: string;
};
const newSection = (): Section => ({
  stage: "empty",
  file: null,
  requestId: crypto.randomUUID(),
  progress: 0,
  message: "",
});
const storageWarningText =
  "재시도 정보를 저장하지 못했습니다. 현재 화면에서는 다시 시도할 수 있지만 새로고침 후에는 이전 요청을 복구하지 못할 수 있습니다.";

/** 서버 액션 실패 응답에서 화면 문구를 고릅니다. 대기 시간이 있는 요청 한도는 같은 형식의 문구로 다시 만듭니다. */
function failureMessage(result: {
  code: string;
  message: string;
  retryAfterSeconds?: number;
}): string {
  return result.code === "RATE_LIMITED"
    ? new AcademicUploadError("RATE_LIMITED", result.retryAfterSeconds).message
    : result.message;
}

export function ArtifactSubmissionForm({
  assignment,
  open,
}: {
  assignment: StudentAssignmentDetail;
  open: boolean;
}) {
  const policy = assignment.artifacts!;
  const requirements = { TEXT: policy.textRequirement, SLIDES: policy.slidesRequirement };
  const activeTypes = ARTIFACT_ORDER.filter((type) => requirements[type] !== "DISABLED");
  const storageKey = `hra-assignment-artifacts:${assignment.targetId}`;
  const [sections, setSections] = useState<Record<StudentArtifactType, Section>>(() => ({
    TEXT: newSection(),
    SLIDES: newSection(),
  }));
  // 비동기 흐름에서 최신 상태를 읽기 위한 참조와 항목별 세대(취소 시 진행 중 흐름을 멈춤)·전송 중단 컨트롤러
  const latest = useRef(sections);
  const generation = useRef<Record<StudentArtifactType, number>>({ TEXT: 0, SLIDES: 0 });
  const controllers = useRef<Partial<Record<StudentArtifactType, AbortController>>>({});
  const submissionKey = useRef<string>("");
  const inFlight = useRef(false);
  const completeHeading = useRef<HTMLHeadingElement>(null);
  const [finalStage, setFinalStage] = useState<"idle" | "finalizing" | "checking" | "error">(
    "idle",
  );
  const [finalMessage, setFinalMessage] = useState("");
  const [finalReference, setFinalReference] = useState<string>();
  const [storageWarning, setStorageWarning] = useState("");
  const [confirmed, setConfirmed] = useState(assignment.submission ? assignment : null);

  useEffect(() => {
    if (confirmed?.submission) completeHeading.current?.focus();
  }, [confirmed]);
  // 탭 저장소의 이전 시도를 복구합니다. 파일은 저장하지 않으므로 검증·취소만 이어서 할 수 있습니다.
  useEffect(() => {
    submissionKey.current = crypto.randomUUID();
    try {
      const restored: ArtifactAttempt | null = readArtifactAttempt(sessionStorage, storageKey);
      if (!restored) return;
      submissionKey.current = restored.submissionKey;
      const next = { ...latest.current };
      for (const type of ARTIFACT_ORDER) {
        const saved = restored.sections[type];
        if (!saved) continue;
        next[type] = {
          ...newSection(),
          requestId: saved.requestId,
          uploadIntentId: saved.uploadIntentId,
          sizeBytes: saved.sizeBytes,
          stage: saved.uploadIntentId ? (saved.verified ? "verified" : "verifyFailed") : "empty",
          message: saved.uploadIntentId
            ? "이전 업로드를 복구했습니다. 확인을 마치지 않았다면 다시 확인하거나 취소해 주세요."
            : "",
        };
      }
      latest.current = next;
      setSections(next);
    } catch {
      setStorageWarning(storageWarningText);
    }
  }, [storageKey]);

  /** 항목 상태를 바꾸고 재시도에 필요한 식별자만 탭 저장소에 남깁니다. */
  function update(type: StudentArtifactType, patch: Partial<Section>) {
    const next = { ...latest.current, [type]: { ...latest.current[type], ...patch } };
    latest.current = next;
    setSections(next);
    persist(next);
  }
  /** 항목을 새 요청 ID의 빈 상태로 바꿉니다(이전 의도 ID를 남기지 않음). */
  function reset(type: StudentArtifactType, patch: Partial<Section> = {}) {
    const next = { ...latest.current, [type]: { ...newSection(), ...patch } };
    latest.current = next;
    setSections(next);
    persist(next);
  }
  function persist(next: Record<StudentArtifactType, Section>) {
    const value: ArtifactAttempt = {
      submissionKey: submissionKey.current || crypto.randomUUID(),
      sections: {},
    };
    submissionKey.current = value.submissionKey;
    for (const type of ARTIFACT_ORDER) {
      const section = next[type];
      if (section.uploadIntentId || section.stage !== "empty")
        value.sections[type] = {
          requestId: section.requestId,
          uploadIntentId: section.uploadIntentId,
          sizeBytes: section.sizeBytes,
          verified: section.stage === "verified",
        };
    }
    try {
      if (!saveArtifactAttempt(sessionStorage, storageKey, value))
        setStorageWarning(storageWarningText);
    } catch {
      setStorageWarning(storageWarningText);
    }
  }

  /** 파일 선택: 업로드 전에 확장자·크기·합계를 확인합니다. */
  function choose(type: StudentArtifactType, file: File | null) {
    if (!file) {
      update(type, { file: null, message: "" });
      return;
    }
    const checked = checkArtifactFile(type, file);
    if (!checked.ok) {
      update(type, { file: null, message: checked.message, referenceId: undefined });
      return;
    }
    const other = type === "TEXT" ? "SLIDES" : "TEXT";
    const otherSize = latest.current[other].file?.size ?? latest.current[other].sizeBytes;
    if (exceedsArtifactTotal({ [type]: file.size, [other]: otherSize })) {
      update(type, { file: null, message: "두 파일의 합계 용량은 100MiB 이하여야 합니다." });
      return;
    }
    update(type, { file, sizeBytes: file.size, message: "", referenceId: undefined });
  }

  /** 의도 발급 → 직접 전송 → 서버 검증. 같은 요청 ID로 다시 실행하면 서버가 같은 의도를 돌려줍니다. */
  async function upload(type: StudentArtifactType) {
    const section = latest.current[type];
    const file = section.file;
    if (!open) {
      update(type, { message: "제출 마감이 지나 새 파일을 올릴 수 없습니다." });
      return;
    }
    if (!file) {
      update(type, {
        message:
          "올릴 파일을 먼저 선택해 주세요. 이전 업로드를 이어 갈 수 없다면 취소한 뒤 다시 선택해 주세요.",
      });
      return;
    }
    const checked = checkArtifactFile(type, file);
    if (!checked.ok) {
      update(type, { message: checked.message });
      return;
    }
    const run = ++generation.current[type];
    const controller = new AbortController();
    controllers.current[type] = controller;
    update(type, { stage: "uploading", progress: 0, message: "", referenceId: undefined });
    try {
      const issued = await issueArtifactUploadIntent({
        assignmentId: assignment.assignmentId,
        requestId: section.requestId,
        artifactType: type,
        fileFormat: checked.format,
        originalName: file.name,
        sizeBytes: file.size,
        mimeType: DOCUMENT_MIME_TYPES[checked.format],
      });
      if (generation.current[type] !== run) {
        // 취소 뒤 늦게 도착한 발급 결과는 바로 취소해 활성 업로드를 남기지 않습니다.
        if (issued.success)
          await cancelArtifactUpload({
            assignmentId: assignment.assignmentId,
            uploadIntentId: issued.uploadIntentId,
          });
        return;
      }
      if (!issued.success) {
        update(type, {
          stage: issued.code === "INVALID_FILE" ? "empty" : "uploadFailed",
          message: failureMessage(issued),
          referenceId: issued.referenceId,
        });
        return;
      }
      update(type, {
        uploadIntentId: issued.uploadIntentId,
        pathname: issued.pathname,
        contentType: issued.contentType,
      });
      await uploadAssignmentArtifactFile({
        assignmentId: assignment.assignmentId,
        uploadIntentId: issued.uploadIntentId,
        pathname: issued.pathname,
        contentType: issued.contentType,
        file,
        abortSignal: controller.signal,
        onProgress: (value) => {
          if (generation.current[type] === run)
            update(type, { progress: Math.min(100, Math.max(0, Math.round(value))) });
        },
        onRequestReference: (value) =>
          update(type, { referenceId: readAcademicRequestReference(value) }),
      });
    } catch (error) {
      if (generation.current[type] !== run) return;
      update(type, {
        stage: "uploadFailed",
        message:
          error instanceof AcademicUploadError && error.code === "RATE_LIMITED"
            ? error.message
            : "파일을 전송하지 못했습니다. 같은 파일로 다시 시도하거나 취소한 뒤 다른 파일을 선택해 주세요.",
      });
      return;
    }
    if (generation.current[type] !== run) return;
    await verify(type);
  }

  /** 업로드된 원본을 서버가 읽어 형식을 확인합니다. 거부 사유는 서버의 고정 한국어 문구로 안내합니다. */
  async function verify(type: StudentArtifactType) {
    const intent = latest.current[type].uploadIntentId;
    if (!intent) return;
    const run = generation.current[type];
    update(type, { stage: "verifying", message: "", referenceId: undefined });
    try {
      const result = await verifyArtifactUpload({
        assignmentId: assignment.assignmentId,
        uploadIntentId: intent,
      });
      if (generation.current[type] !== run) return;
      if (result.success) {
        update(type, { stage: "verified", message: "파일 확인을 마쳤습니다." });
        return;
      }
      // 파일 자체가 거부되면 같은 파일로 다시 확인해도 결과가 같으므로 취소 후 다른 파일을 고르게 합니다.
      update(type, {
        stage: result.code === "INVALID_FILE" ? "rejected" : "verifyFailed",
        message: failureMessage(result),
        referenceId: result.referenceId,
      });
    } catch {
      if (generation.current[type] !== run) return;
      update(type, {
        stage: "verifyFailed",
        message: "파일 확인 결과를 받지 못했습니다. 다시 확인해 주세요.",
      });
    }
  }

  /** 한 항목의 업로드를 취소합니다. 최종 제출이 이미 확정됐다면 취소하지 않고 결과를 보여 줍니다. */
  async function cancel(type: StudentArtifactType) {
    const run = ++generation.current[type];
    controllers.current[type]?.abort();
    const intent = latest.current[type].uploadIntentId;
    if (!intent) {
      reset(type, { file: latest.current[type].file, sizeBytes: latest.current[type].file?.size });
      return;
    }
    update(type, { stage: "cancelling", message: "", referenceId: undefined });
    try {
      const current = await refreshMyAssignment(assignment.assignmentId);
      if (current.success && current.assignment.submission) {
        setConfirmed(current.assignment);
        clearAttempt();
        return;
      }
      const result = await cancelArtifactUpload({
        assignmentId: assignment.assignmentId,
        uploadIntentId: intent,
      });
      if (generation.current[type] !== run) return;
      if (!result.success) {
        update(type, {
          stage: "verifyFailed",
          message:
            "기존 업로드 취소를 확인하지 못했습니다. 다시 취소하거나 같은 업로드로 확인해 주세요.",
          referenceId: result.referenceId,
        });
        return;
      }
      // 업로드 묶음이 바뀌므로 다음 최종 제출은 새 멱등 키를 사용합니다. 선택한 파일은 그대로 둡니다.
      submissionKey.current = crypto.randomUUID();
      reset(type, {
        file: latest.current[type].file,
        sizeBytes: latest.current[type].file?.size,
        message: "업로드를 취소했습니다. 같은 파일로 다시 올리거나 다른 파일을 선택해 주세요.",
      });
    } catch {
      update(type, {
        stage: "verifyFailed",
        message: "취소 결과를 확인하지 못했습니다. 다시 시도해 주세요.",
      });
    }
  }

  function clearAttempt() {
    try {
      sessionStorage.removeItem(storageKey);
    } catch {
      setStorageWarning(storageWarningText);
    }
  }

  /** 본인 최종 제출을 다시 읽어 완료 상태를 확정합니다. */
  async function confirm() {
    setFinalStage("checking");
    const result = await refreshMyAssignment(assignment.assignmentId);
    if (!result.success || !result.assignment.submission) {
      setFinalStage("error");
      setFinalMessage(result.success ? "아직 최종 제출 기록이 없습니다." : result.message);
      return;
    }
    setConfirmed(result.assignment);
    setFinalStage("idle");
    setFinalMessage("과제 제출을 완료했습니다.");
    clearAttempt();
  }

  /** 검증된 항목을 한 번에 최종 제출합니다. 같은 멱등 키로 다시 시도하면 기존 결과를 복구합니다. */
  async function submit() {
    if (inFlight.current) return;
    const readiness = artifactSubmissionReadiness(requirements, readinessInput(latest.current));
    if (!readiness.ready) {
      setFinalStage("error");
      setFinalMessage(readiness.message);
      return;
    }
    inFlight.current = true;
    setFinalStage("finalizing");
    setFinalMessage("");
    setFinalReference(undefined);
    try {
      const uploadIntentIds = ARTIFACT_ORDER.map((type) => latest.current[type])
        .filter((section) => section.stage === "verified" && section.uploadIntentId)
        .map((section) => section.uploadIntentId!);
      const result = await finalizeArtifactSubmission({
        assignmentId: assignment.assignmentId,
        uploadIntentIds,
        submissionKey: submissionKey.current,
      });
      if (!result.success) {
        setFinalStage("error");
        setFinalMessage(failureMessage(result));
        setFinalReference(result.referenceId);
        return;
      }
      await confirm();
    } catch {
      setFinalStage("error");
      setFinalMessage("제출 결과를 확인하지 못했습니다. 같은 요청으로 다시 시도해 주세요.");
    } finally {
      inFlight.current = false;
    }
  }

  if (confirmed?.submission) {
    const files = confirmed.artifacts?.files ?? [];
    return (
      <section
        className="space-y-3 rounded-xl border border-[#D9D9D9] p-5"
        aria-label="최종 제출 결과"
      >
        <h2 ref={completeHeading} tabIndex={-1} className="text-xl font-bold">
          제출 완료
        </h2>
        <p role="status" aria-live="polite">
          최종 제출 결과를 확인했습니다.
        </p>
        <p>제출 시각: {formatKstDateTimeWithSeconds(new Date(confirmed.submission.submittedAt))}</p>
        <ul className="space-y-2">
          {files.map((file) => (
            <li key={file.fileId} className="break-all">
              <span className="font-medium">{ARTIFACT_LABELS[file.artifactType]}</span> (
              {file.fileFormat}, {formatArtifactSize(file.sizeBytes)}){" "}
              <a
                className="text-[#2563EB] underline"
                href={`/api/academic/submissions/${confirmed.submission!.submissionId}/file/${file.fileId}`}
              >
                {file.originalName} 다운로드
              </a>
            </li>
          ))}
        </ul>
        <p className="text-sm text-[#666666]">
          최종 제출한 파일은 교체하거나 다시 제출할 수 없습니다. 변경이 필요하면 운영진에게 문의해
          주세요.
        </p>
      </section>
    );
  }

  const readiness = artifactSubmissionReadiness(requirements, readinessInput(sections));
  const busy = finalStage === "finalizing" || finalStage === "checking";
  const disabledTypes = ARTIFACT_ORDER.filter((type) => requirements[type] === "DISABLED");
  return (
    <section
      className="space-y-5 rounded-xl border border-[#D9D9D9] p-5"
      aria-label="과제 파일 제출"
    >
      <h2 className="text-xl font-bold">파일 제출</h2>
      {!open && <p>과제가 종료되었거나 제출 마감이 지났습니다.</p>}
      <p id="artifact-help" className="text-sm text-[#666666]">
        항목마다 파일 1개, 파일당 50MiB 이하, 두 파일 합계 100MiB 이하로 제출할 수 있습니다. 필수
        항목을 모두 올리고 확인을 마치면 최종 제출할 수 있으며, 선택 항목만 있는 과제도 최소 1개
        파일이 필요합니다. 최종 제출은 두 항목을 한 번에 확정하며 이후에는 교체할 수 없습니다.
        {disabledTypes.length > 0 &&
          ` 이 과제는 ${disabledTypes.map((type) => ARTIFACT_LABELS[type]).join("·")} 항목을 받지 않습니다.`}
      </p>
      {activeTypes.map((type) => (
        <ArtifactSection
          key={type}
          type={type}
          requirement={REQUIREMENT_LABELS[requirements[type]]}
          section={sections[type]}
          open={open}
          locked={busy}
          onChoose={(file) => choose(type, file)}
          onUpload={() => void upload(type)}
          onVerify={() => void verify(type)}
          onCancel={() => void cancel(type)}
        />
      ))}
      {storageWarning && (
        <p role="note" className="text-sm text-[#666666]">
          {storageWarning}
        </p>
      )}
      <div id="artifact-final-status" role="status" aria-live="polite" aria-atomic="true">
        <p>
          {finalStage === "finalizing"
            ? "파일을 다시 확인하고 최종 제출을 처리하고 있습니다."
            : finalStage === "checking"
              ? "최종 제출 결과를 확인하고 있습니다."
              : finalMessage || (readiness.ready ? "" : readiness.message)}
        </p>
        {finalStage === "error" && <AcademicRequestReference referenceId={finalReference} />}
      </div>
      <div className="flex flex-wrap gap-3">
        <button
          type="button"
          disabled={busy || !readiness.ready}
          aria-describedby="artifact-final-status"
          onClick={() => void submit()}
          className="rounded bg-[#2563EB] px-4 py-3 text-white disabled:opacity-50"
        >
          최종 제출
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            void confirm().catch(() => {
              setFinalStage("error");
              setFinalMessage("제출 결과를 확인하지 못했습니다. 다시 시도해 주세요.");
            });
          }}
          className="rounded border border-[#D9D9D9] px-4 py-3"
        >
          제출 결과 새로 확인
        </button>
      </div>
    </section>
  );
}

/** 최종 제출 가능 여부 계산에 필요한 값만 추립니다. */
function readinessInput(sections: Record<StudentArtifactType, Section>) {
  const pending = (stage: Stage) =>
    stage === "uploading" || stage === "verifying" || stage === "cancelling";
  return {
    TEXT: {
      verified: sections.TEXT.stage === "verified",
      sizeBytes: sections.TEXT.sizeBytes,
      pending: pending(sections.TEXT.stage),
    },
    SLIDES: {
      verified: sections.SLIDES.stage === "verified",
      sizeBytes: sections.SLIDES.sizeBytes,
      pending: pending(sections.SLIDES.stage),
    },
  };
}

// 진행 단계를 색상 없이 문구로 알립니다.
const stageText: Record<Stage, string> = {
  empty: "",
  uploading: "파일을 전송하고 있습니다.",
  verifying: "서버가 파일 형식을 확인하고 있습니다.",
  verified: "확인 완료: 최종 제출에 포함됩니다.",
  uploadFailed: "전송 실패",
  verifyFailed: "확인 필요",
  rejected: "제출할 수 없는 파일",
  cancelling: "업로드를 취소하고 있습니다.",
};

/** 항목 하나의 파일 선택·진행률·상태·다시 시도·취소 영역입니다. */
function ArtifactSection({
  type,
  requirement,
  section,
  open,
  locked,
  onChoose,
  onUpload,
  onVerify,
  onCancel,
}: {
  type: StudentArtifactType;
  requirement: string;
  section: Section;
  open: boolean;
  locked: boolean;
  onChoose: (file: File | null) => void;
  onUpload: () => void;
  onVerify: () => void;
  onCancel: () => void;
}) {
  const id = `artifact-${type.toLowerCase()}`;
  const working =
    section.stage === "uploading" ||
    section.stage === "verifying" ||
    section.stage === "cancelling";
  const hasUpload = Boolean(section.uploadIntentId) || section.stage === "uploading";
  return (
    <fieldset
      className="space-y-2 rounded border border-[#D9D9D9] p-4"
      aria-describedby={`${id}-help`}
    >
      <legend className="px-1 font-bold">
        {ARTIFACT_LABELS[type]} ({requirement})
      </legend>
      <p id={`${id}-help`} className="text-sm text-[#666666]">
        {artifactFormatLabel(type)} 파일, 최대 50MiB
      </p>
      <label htmlFor={`${id}-file`} className="block font-medium">
        {ARTIFACT_LABELS[type]} 파일 선택
      </label>
      <input
        id={`${id}-file`}
        type="file"
        accept={artifactAccept(type)}
        disabled={!open || locked || working || hasUpload}
        aria-describedby={`${id}-help ${id}-status`}
        onChange={(event) => onChoose(event.target.files?.[0] ?? null)}
        className="block w-full max-w-full rounded border border-[#D9D9D9] p-2"
      />
      {section.file && (
        <p className="break-all text-sm">
          선택한 파일: {section.file.name} ({formatArtifactSize(section.file.size)})
        </p>
      )}
      {section.stage === "uploading" && (
        <div>
          <label htmlFor={`${id}-progress`}>
            {ARTIFACT_LABELS[type]} 전송 {section.progress}%
          </label>
          <progress
            id={`${id}-progress`}
            value={section.progress}
            max={100}
            className="block w-full"
          />
        </div>
      )}
      <div
        id={`${id}-status`}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="text-sm"
      >
        {stageText[section.stage] && <p className="font-medium">{stageText[section.stage]}</p>}
        {section.message && <p>{section.message}</p>}
        {(section.stage === "uploadFailed" ||
          section.stage === "verifyFailed" ||
          section.stage === "rejected") && (
          <AcademicRequestReference referenceId={section.referenceId} />
        )}
      </div>
      <div className="flex flex-wrap gap-2">
        {section.stage === "empty" && !section.uploadIntentId && (
          <button
            type="button"
            disabled={!open || locked || !section.file}
            onClick={onUpload}
            className="rounded border border-[#D9D9D9] px-3 py-2 disabled:opacity-50"
          >
            {ARTIFACT_LABELS[type]} 올리기
          </button>
        )}
        {section.stage === "uploadFailed" && (
          <button
            type="button"
            disabled={!open || locked}
            onClick={onUpload}
            className="rounded border border-[#D9D9D9] px-3 py-2 disabled:opacity-50"
          >
            {ARTIFACT_LABELS[type]} 다시 전송
          </button>
        )}
        {section.stage === "verifyFailed" && (
          <button
            type="button"
            disabled={locked}
            onClick={onVerify}
            className="rounded border border-[#D9D9D9] px-3 py-2 disabled:opacity-50"
          >
            {ARTIFACT_LABELS[type]} 다시 확인
          </button>
        )}
        {hasUpload && section.stage !== "cancelling" && (
          <button
            type="button"
            disabled={locked}
            onClick={onCancel}
            className="rounded border border-[#D9D9D9] px-3 py-2 disabled:opacity-50"
          >
            {ARTIFACT_LABELS[type]} 업로드 취소
          </button>
        )}
      </div>
    </fieldset>
  );
}
