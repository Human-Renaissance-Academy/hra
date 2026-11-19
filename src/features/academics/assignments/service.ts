/** 지정 책임자의 과제 서비스입니다. 세션 주체는 호출 입력에서 받지 않습니다. */
import "server-only";
import { sql } from "drizzle-orm";
import {
  assertAcademicWritesEnabled,
  getAcademicApproverId,
  requireAcademicApprover,
} from "@/lib/academic-admin";
import { db } from "@/lib/db";
import type { AcademicObservation } from "@/lib/academic-observability";
import {
  assignmentResultSchema,
  assignmentTransitionSchema,
  createAssignmentSchema,
  AssignmentInputError,
  AssignmentOperationError,
  listAssignmentsSchema,
  parseAssignmentInput,
  parseAssignmentKst,
  publishAssignmentSchema,
  rethrowAssignmentStorageError,
  updateDraftAssignmentSchema,
} from "./validation";

type Action = "CREATE" | "UPDATE_DRAFT" | "PUBLISH" | "CLOSE";

// 준비되지 않은 운영 DB로 조회·변경 요청이 들어가지 않게 공개 플래그를 먼저 확인합니다.
function assertAssignmentsEnabled() {
  if (process.env.ACADEMIC_ENABLED !== "true")
    throw new AssignmentOperationError("학사 기능을 준비 중입니다.");
}

/** Neon HTTP에서 대화형 트랜잭션 대신 범위 SQL 함수 한 번으로 변경과 감사를 확정합니다. */
async function mutate(action: Action, input: unknown, observation?: AcademicObservation) {
  const actorId = await requireAcademicApprover();
  observation?.authenticated(actorId);
  observation?.emit("AUTHORIZED");
  assertAssignmentsEnabled();
  assertAcademicWritesEnabled();
  const parsed =
    action === "CREATE"
      ? parseAssignmentInput(createAssignmentSchema, input)
      : action === "UPDATE_DRAFT"
        ? parseAssignmentInput(updateDraftAssignmentSchema, input)
        : action === "PUBLISH"
          ? parseAssignmentInput(publishAssignmentSchema, input)
          : parseAssignmentInput(assignmentTransitionSchema, input);
  const { requestId, correlationId, ...fields } = parsed;
  observation?.identify({
    requestId,
    resourceId: "assignmentId" in fields ? fields.assignmentId : undefined,
  });
  let payload: Record<string, unknown> = fields;
  if ("dueAtKst" in fields) {
    const { dueAtKst, submissionFormat, textRequirement, slidesRequirement, ...remaining } = fields;
    payload = {
      ...remaining,
      dueAt: typeof dueAtKst === "string" ? parseAssignmentKst(dueAtKst) : null,
    };
    // #516: 제출 형식 지정은 별도 기능 gate가 켜졌을 때만 받습니다. 꺼져 있으면 기존 payload를 그대로 보냅니다.
    if (submissionFormat !== undefined) {
      if (process.env.ACADEMIC_SUBMISSION_ARTIFACTS_ENABLED !== "true") {
        throw new AssignmentInputError("텍스트·발표자료 분리 제출은 아직 사용할 수 없습니다.");
      }
      payload = {
        ...payload,
        submissionFormat,
        textRequirement: textRequirement ?? null,
        slidesRequirement: slidesRequirement ?? null,
      };
    }
  }
  const result = await db
    .execute(
      sql`SELECT public.mutate_academic_assignment(
    ${action}::text, ${actorId}::uuid, ${getAcademicApproverId()}::uuid,
    ${requestId}::uuid, ${observation?.correlationId ?? correlationId ?? requestId}::uuid, ${JSON.stringify(payload)}::jsonb
  ) AS result`,
    )
    .catch(rethrowAssignmentStorageError);
  return assignmentResultSchema.parse(result.rows[0]?.result);
}

export async function createAssignment(input: unknown, observation?: AcademicObservation) {
  return mutate("CREATE", input, observation);
}
export async function updateDraftAssignment(input: unknown, observation?: AcademicObservation) {
  return mutate("UPDATE_DRAFT", input, observation);
}
export async function publishAssignment(input: unknown, observation?: AcademicObservation) {
  return mutate("PUBLISH", input, observation);
}
export async function closeAssignment(input: unknown, observation?: AcademicObservation) {
  return mutate("CLOSE", input, observation);
}

/** 관리 목록에도 같은 지정 책임자 인가를 적용하고 최대 100건만 반환합니다. */
export async function listAssignmentsAdmin(input: unknown = {}, observation?: AcademicObservation) {
  const actorId = await requireAcademicApprover();
  observation?.authenticated(actorId);
  observation?.emit("AUTHORIZED");
  assertAssignmentsEnabled();
  const filter = parseAssignmentInput(listAssignmentsSchema, input);
  const result = await db.execute(sql`SELECT jsonb_build_object('assignment', to_jsonb(a),
    'targetCount', (SELECT count(*) FROM public.assignment_targets t WHERE t.assignment_id = a.id)) AS result
    FROM public.assignments a
    WHERE (${filter.cohortId ?? null}::uuid IS NULL OR a.cohort_id = ${filter.cohortId ?? null}::uuid)
      AND (${filter.status ?? null}::text IS NULL OR a.status::text = ${filter.status ?? null}::text)
      AND EXISTS (SELECT 1 FROM public.users u WHERE u.id = ${actorId}::uuid AND u.role IN ('ADMIN', 'FACULTY', 'MEMBER'))
    ORDER BY a.updated_at DESC, a.id LIMIT ${filter.limit} OFFSET ${filter.offset}`);
  return result.rows.map((row) => assignmentResultSchema.parse(row.result));
}
