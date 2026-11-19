// @vitest-environment node
/**
 * #162 과제 검토·피드백 이력과 지정 검토자 제출 파일 열람의 실제 PostgreSQL 회귀입니다.
 *
 * - 소유 임시 클러스터(HRA_TEST_PG_BIN)에 실제 G1 학적·과제·제출 SQL과 #165·#161·#162 SQL을 설치합니다.
 *   운영 DB·환경 파일·Blob에는 접속하지 않습니다(다운로드는 Blob SDK를 대체해 응답 헤더·감사만 확인).
 * - SQL 직접 호출로 인가·자기 검토 금지·버전 충돌·이력·공개 분리를, Drizzle·Neon SDK 경로로 서비스 플래그·DTO·다운로드를 확인합니다.
 */
import { neon, neonConfig } from "@neondatabase/serverless";
import { drizzle, type NeonHttpDatabase } from "drizzle-orm/neon-http";
import { execFile, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as schema from "@/lib/db/schema";
import { createQaPostgres } from "../support/resource-qa-postgres.mjs";
import {
  createPsqlTransport,
  qaDatabaseUrl,
  qaNeonEndpoint,
  sqlLiteral,
} from "../support/neon-psql-transport.mjs";
import {
  fileQaIdentities,
  fileQaIds,
  installSubmissionFileIdentities,
  installSubmissionFileMigrations,
} from "../support/academic-submission-file-fixture.mjs";
import { resourceQaPdfBytes, resourceQaPdfSha256 } from "../support/resource-qa-pdf.mjs";

const mocks = vi.hoisted(() => ({
  database: undefined as NeonHttpDatabase<typeof schema> | undefined,
  calls: 0,
  blobGet: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth", () => ({ auth: vi.fn() }));
vi.mock("@/lib/api-v1-principal", () => ({ freshMobilePrincipalIdentity: vi.fn() }));
vi.mock("@vercel/blob", () => ({ get: mocks.blobGet }));
vi.mock("@/lib/db", () => ({
  get db() {
    if (!mocks.database) throw new Error("격리 DB 준비 전 호출");
    return mocks.database;
  },
}));

import {
  downloadReviewerSubmissionFile,
  listFeedbackForPublication,
  listMyPublishedFeedback,
  listReviewSubmissions,
  publishAssignmentFeedback,
  saveAssignmentReview,
  submitAssignmentReview,
} from "@/features/academics/assignment-reviews/service";

const bin = process.env.HRA_TEST_PG_BIN;
const execFileAsync = promisify(execFile);
const script = (name: string) =>
  readFileSync(new URL(`../../scripts/${name}`, import.meta.url), "utf8");
const migration = script("migrate-academic-assignment-reviews.sql");
const evidence = "16200000-0000-4000-8000-0000000000ee";
const blobHost = "qareview.private.blob.vercel-storage.com";

type Outcome = { ok: true; out: string } | { ok: false; code: string };

describe.skipIf(!bin)("#162 과제 검토·피드백(격리 PostgreSQL)", () => {
  let cluster: ReturnType<typeof createQaPostgres>;
  const previousFetch = neonConfig.fetchFunction;
  const previousEndpoint = neonConfig.fetchEndpoint;

  /** 원문 오류 대신 성공 출력 또는 SQLSTATE만 돌려줍니다. */
  const run = (statement: string): Outcome => {
    const result = spawnSync(
      join(bin!, "psql"),
      ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose"],
      {
        input: statement,
        encoding: "utf8",
        env: { LC_ALL: "C", NODE_ENV: "test", ...cluster.environment },
        timeout: 30_000,
      },
    );
    if (result.status === 0) return { ok: true, out: result.stdout.trim() };
    return { ok: false, code: /ERROR:\s+([0-9A-Z]{5}):/.exec(result.stderr)?.[1] ?? "UNKNOWN" };
  };
  const runAsync = async (statement: string): Promise<Outcome> => {
    try {
      const { stdout } = await execFileAsync(
        join(bin!, "psql"),
        ["-X", "-q", "-At", "-v", "ON_ERROR_STOP=1", "-v", "VERBOSITY=verbose", "-c", statement],
        { env: { LC_ALL: "C", NODE_ENV: "test", ...cluster.environment }, timeout: 30_000 },
      );
      return { ok: true, out: stdout.trim() };
    } catch (error) {
      const stderr =
        error && typeof error === "object" && "stderr" in error ? String(error.stderr) : "";
      return { ok: false, code: /ERROR:\s+([0-9A-Z]{5}):/.exec(stderr)?.[1] ?? "UNKNOWN" };
    }
  };
  const value = (statement: string) => {
    const outcome = run(statement);
    if (!outcome.ok) throw new Error(`예상하지 못한 SQL 실패 ${outcome.code}`);
    return outcome.out;
  };
  const created = (outcome: Outcome) => {
    if (!outcome.ok) throw new Error(`준비 실패 ${outcome.code}`);
    return outcome.out;
  };

  // 합성 계정. 역할은 판정 근거가 아니며 ADMIN·FACULTY도 연결·지정 없이는 거부되어야 합니다.
  const people = {
    approver: fileQaIdentities.approver.id,
    owner: fileQaIdentities.owner.id,
    peer: fileQaIdentities.peer.id,
    admin: fileQaIdentities.admin.id,
    otherFaculty: fileQaIdentities.otherFaculty.id,
    manager: "16200000-0000-4000-8000-000000000001",
    reviewer: "16200000-0000-4000-8000-000000000002",
    reviewerManager: "16200000-0000-4000-8000-000000000003",
    otherReviewer: "16200000-0000-4000-8000-000000000004",
  };
  const ids = {
    event: "16200000-0000-4000-8000-000000000101",
    otherEvent: "16200000-0000-4000-8000-000000000102",
    assignment: "16200000-0000-4000-8000-000000000201",
    draftAssignment: "16200000-0000-4000-8000-000000000202",
    otherAssignment: "16200000-0000-4000-8000-000000000203",
  };
  const submissions: Record<
    "owner" | "peer",
    { submissionId: string; fileId: string; storageKey: string }
  > = {
    owner: { submissionId: "", fileId: "", storageKey: "" },
    peer: { submissionId: "", fileId: "", storageKey: "" },
  };
  const designations: Record<string, string> = {};

  const addUser = (id: string, role: string) =>
    value(`INSERT INTO users (id,name,email,password_hash,role)
      SELECT '${id}','검토 시험 계정','${id}@review-qa.invalid',password_hash,'${role}' FROM users WHERE id='${people.owner}';`);
  const linkAndDesignate = (user: string, event: string) => {
    const faculty = randomUUID();
    value(`INSERT INTO faculty(id,name) VALUES('${faculty}','합성 교수');`);
    created(
      run(`SELECT (public.link_academic_faculty_account('${randomUUID()}','${people.manager}','${randomUUID()}',
      '${faculty}','${user}',NULL,NULL,'IN_PERSON','${evidence}'))->'link'->>'id';`),
    );
    designations[user] = created(
      run(`SELECT (public.designate_academic_class_reviewer('${randomUUID()}',
      '${people.manager}','${randomUUID()}','${faculty}','${event}',
      NULL,NULL,NULL))->'designation'->>'id';`),
    );
  };
  const finalSubmission = (person: string, enrollment: string, request: string) => {
    const intent = randomUUID();
    const key = `academic-uploads/v1/${intent}/document.pdf`;
    const target = value(
      `SELECT id FROM assignment_targets WHERE enrollment_id='${enrollment}' AND assignment_id='${ids.assignment}'`,
    );
    value(`INSERT INTO assignment_upload_intents(id,assignment_target_id,user_id,storage_key,expires_at)
      VALUES('${intent}','${target}','${person}',${sqlLiteral(key)},clock_timestamp()+interval '30 minutes');
      SELECT verify_academic_assignment_upload('${intent}','${person}','한글 과제.pdf','application/pdf',
        ${resourceQaPdfBytes().length},'${resourceQaPdfSha256()}');`);
    const submissionId = value(
      `SELECT finalize_academic_assignment_submission('${target}','${person}','${intent}','${request}')`,
    );
    const fileId = value(
      `SELECT id FROM assignment_submission_files WHERE submission_id='${submissionId}'`,
    );
    return { submissionId, fileId, storageKey: key };
  };

  // SQL 직접 호출 도우미. 결과는 jsonb 문자열을 객체로 바꿉니다.
  const save = (
    actor: string,
    submission: string,
    expected: number,
    body = "합성 피드백",
    reason: string | null = null,
  ) =>
    run(`SELECT public.save_academic_assignment_review('${actor}','${submission}',${expected},${sqlLiteral(body)},NULL,
      ${reason === null ? "NULL" : sqlLiteral(reason)});`);
  const submit = (actor: string, review: string, expected: number) =>
    run(`SELECT public.submit_academic_assignment_review('${actor}','${review}',${expected});`);
  const publish = (actor: string, review: string, expected: number) =>
    run(`SELECT public.publish_academic_assignment_feedback('${actor}','${review}',${expected});`);
  const retract = (actor: string, review: string, expected: number, reason: string) =>
    run(
      `SELECT public.retract_academic_assignment_feedback('${actor}','${review}',${expected},${sqlLiteral(reason)});`,
    );
  const json = (outcome: Outcome) =>
    JSON.parse(created(outcome)) as {
      id: string;
      version: number;
      status: string;
      visibility: string;
    };
  const reviewOf = (reviewer: string, submission: string) =>
    value(
      `SELECT id FROM academic_assignment_reviews WHERE reviewer_user_id='${reviewer}' AND submission_id='${submission}'`,
    );
  const fileRead = (actor: string, submission: string, file: string) =>
    run(`SELECT public.authorize_academic_review_file_read('${actor}','${submission}','${file}');`);
  const principal = (userId: string, role = "FACULTY") => ({ userId, role });

  beforeAll(() => {
    cluster = createQaPostgres(bin);
    installSubmissionFileIdentities(cluster);
    installSubmissionFileMigrations(cluster);
    cluster.sql("CREATE TABLE faculty(id uuid PRIMARY KEY, name text NOT NULL);");
    cluster.sql(script("migrate-academic-staff-assignments.sql"));
    cluster.sql(script("migrate-academic-faculty-reviewers.sql"));
    // 같은 DB에 두 번 적용해도 성공해야 합니다(재실행 멱등성).
    cluster.sql(migration);
    cluster.sql(migration);
    for (const [key, role] of [
      ["manager", "MEMBER"],
      ["reviewer", "FACULTY"],
      ["reviewerManager", "FACULTY"],
      ["otherReviewer", "FACULTY"],
    ] as const)
      addUser(people[key], role);
    cluster.sql(`UPDATE users SET role='MEMBER' WHERE id IN ('${people.owner}','${people.peer}');
      INSERT INTO academic_students(id,user_id,display_name) VALUES
        ('${fileQaIds.student}','${people.owner}','검토 시험 학생'),('${fileQaIds.peer}','${people.peer}','같은 기수 학생');
      INSERT INTO cohort_enrollments(id,student_id,cohort_id) VALUES
        ('${fileQaIds.enrollment}','${fileQaIds.student}','${fileQaIds.cohort}'),
        ('${fileQaIds.peerEnrollment}','${fileQaIds.peer}','${fileQaIds.cohort}');
      INSERT INTO schedule_events(id,cohort_id) VALUES('${ids.event}','${fileQaIds.cohort}'),('${ids.otherEvent}','${fileQaIds.cohort}');
      INSERT INTO assignments(id,cohort_id,schedule_event_id,title,due_at,created_by_user_id) VALUES
        ('${ids.assignment}','${fileQaIds.cohort}','${ids.event}','검토 시험 과제',clock_timestamp()+interval '1 hour','${people.approver}'),
        ('${ids.draftAssignment}','${fileQaIds.cohort}','${ids.event}','초안 과제',clock_timestamp()+interval '1 hour','${people.approver}'),
        ('${ids.otherAssignment}','${fileQaIds.cohort}','${ids.otherEvent}','다른 수업 과제',clock_timestamp()+interval '1 hour','${people.approver}');
      SELECT publish_academic_assignment('${ids.assignment}','${people.approver}');
      SELECT publish_academic_assignment('${ids.otherAssignment}','${people.approver}');`);
    submissions.owner = finalSubmission(
      people.owner,
      fileQaIds.enrollment,
      "16200000-0000-4000-8000-000000000301",
    );
    submissions.peer = finalSubmission(
      people.peer,
      fileQaIds.peerEnrollment,
      "16200000-0000-4000-8000-000000000302",
    );
    // G1 지정 승인자가 학사 운영 관리자 두 명을 지정합니다(reviewerManager는 검토자이자 관리자).
    for (const manager of [people.manager, people.reviewerManager])
      created(
        run(`SELECT (public.designate_academic_operations_manager('${randomUUID()}','${people.approver}',
        '${people.approver}','${randomUUID()}','${manager}',NULL,NULL,'IN_PERSON','${evidence}'))->'designation'->>'id';`),
      );
    linkAndDesignate(people.reviewer, ids.event);
    linkAndDesignate(people.reviewerManager, ids.event);
    linkAndDesignate(people.otherReviewer, ids.otherEvent);
    // 제출 학생 본인 계정이 교수로 잘못 연결·지정된 경우(자기 검토 금지 확인용).
    linkAndDesignate(people.owner, ids.event);

    const transport = createPsqlTransport(cluster.environment);
    neonConfig.fetchEndpoint = qaNeonEndpoint;
    neonConfig.fetchFunction = async (address: unknown, options: RequestInit) => {
      if (
        String(address) !== qaNeonEndpoint ||
        new Headers(options.headers).get("Neon-Connection-String") !== qaDatabaseUrl
      )
        throw new Error("격리 SQL 범위 이외 요청 차단");
      mocks.calls++;
      try {
        return Response.json(await transport(JSON.parse(String(options.body))));
      } catch (error) {
        return Response.json(
          {
            message: "격리 SQL 실행 거부",
            ...(error && typeof error === "object" && "code" in error ? { code: error.code } : {}),
          },
          { status: 400 },
        );
      }
    };
    mocks.database = drizzle(neon(qaDatabaseUrl), { schema });
  }, 120_000);

  beforeEach(() => {
    mocks.calls = 0;
    mocks.blobGet.mockReset();
    vi.unstubAllEnvs();
    vi.stubEnv("ACADEMIC_ENABLED", "true");
    vi.stubEnv("ACADEMIC_FACULTY_REVIEW_ENABLED", "true");
    vi.stubEnv("ACADEMIC_ASSIGNMENT_REVIEW_ENABLED", "true");
  });

  afterAll(() => {
    mocks.database = undefined;
    neonConfig.fetchFunction = previousFetch;
    neonConfig.fetchEndpoint = previousEndpoint;
    vi.unstubAllEnvs();
    cluster?.close();
  });

  describe("SQL 설치 형태", () => {
    it("구조 불일치·숨긴 트리거·남은 EXECUTE 권한을 거부하고 PUBLIC 실행 권한이 없습니다", () => {
      value("ALTER TABLE academic_assignment_reviews ADD COLUMN score integer;");
      expect(run(migration)).toMatchObject({ ok: false });
      value("ALTER TABLE academic_assignment_reviews DROP COLUMN score;");
      value(
        "ALTER TABLE academic_assignment_reviews DROP CONSTRAINT academic_assignment_reviews_publication_check;",
      );
      expect(run(migration)).toMatchObject({ ok: false });
      value(`ALTER TABLE academic_assignment_reviews ADD CONSTRAINT academic_assignment_reviews_publication_check CHECK (
        (visibility = 'PRIVATE' AND published_by_user_id IS NULL AND published_at IS NULL)
        OR (visibility = 'PUBLISHED_TO_STUDENT' AND status = 'SUBMITTED' AND published_by_user_id IS NOT NULL
          AND published_at IS NOT NULL AND published_by_user_id <> reviewer_user_id));`);
      expect(run(migration)).toMatchObject({ ok: true });
      value(`CREATE TRIGGER review_probe_hidden BEFORE INSERT ON academic_assignment_review_events
        FOR EACH ROW EXECUTE FUNCTION public.guard_academic_assignment_review_events();
        ALTER TABLE academic_assignment_review_events DISABLE TRIGGER review_probe_hidden;`);
      expect(run(migration)).toMatchObject({ ok: false });
      value("DROP TRIGGER review_probe_hidden ON academic_assignment_review_events;");
      value(
        "DO $$BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='review_probe') THEN CREATE ROLE review_probe NOLOGIN; END IF; END$$;",
      );
      value(
        "GRANT EXECUTE ON FUNCTION public.publish_academic_assignment_feedback(uuid,uuid,integer) TO review_probe;",
      );
      expect(run(migration)).toMatchObject({ ok: false });
      value(
        "REVOKE EXECUTE ON FUNCTION public.publish_academic_assignment_feedback(uuid,uuid,integer) FROM review_probe;",
      );
      expect(run(migration)).toMatchObject({ ok: true });
      expect(
        value(`SELECT bool_or(has_function_privilege('review_probe', p.oid, 'EXECUTE')) FROM pg_proc p
        JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND (p.proname LIKE '%academic_assignment_review%'
        OR p.proname LIKE '%academic_assignment_feedback%' OR p.proname IN ('require_academic_submission_reviewer',
        'list_academic_review_submissions','list_published_academic_feedback','authorize_academic_review_file_read'));`),
      ).toBe("f");
    });
  });

  describe("검토 권한", () => {
    it("지정되지 않은 FACULTY·ADMIN·다른 수업 검토자·학사 운영 관리자는 저장·열람·목록이 거부됩니다", () => {
      for (const actor of [
        people.otherFaculty,
        people.admin,
        people.otherReviewer,
        people.manager,
        people.approver,
      ])
        expect(save(actor, submissions.peer.submissionId, 0)).toEqual({ ok: false, code: "HRA03" });
      for (const actor of [people.otherFaculty, people.admin, people.otherReviewer])
        expect(fileRead(actor, submissions.peer.submissionId, submissions.peer.fileId)).toEqual({
          ok: false,
          code: "HRA03",
        });
      expect(
        value(
          `SELECT count(*) FROM list_academic_review_submissions('${people.otherFaculty}','${ids.assignment}')`,
        ),
      ).toBe("0");
      expect(value("SELECT count(*) FROM academic_assignment_review_file_reads")).toBe("0");
    });

    it("초안 과제는 지정 검토자도 검토할 수 없습니다", () => {
      expect(
        value(`SELECT public.can_review_assignment('${people.reviewer}','${ids.draftAssignment}')`),
      ).toBe("f");
      expect(
        value(
          `SELECT count(*) FROM list_academic_review_submissions('${people.reviewer}','${ids.draftAssignment}')`,
        ),
      ).toBe("0");
    });

    it("제출 학생 본인 계정이 검토자로 지정되어도 본인 제출물의 저장·파일 열람은 거부되고 목록에서 빠집니다", () => {
      expect(save(people.owner, submissions.owner.submissionId, 0)).toEqual({
        ok: false,
        code: "HRA01",
      });
      expect(
        fileRead(people.owner, submissions.owner.submissionId, submissions.owner.fileId),
      ).toEqual({ ok: false, code: "HRA01" });
      expect(
        value(
          `SELECT string_agg(submission_id::text, ',') FROM list_academic_review_submissions('${people.owner}','${ids.assignment}')`,
        ),
      ).toBe(submissions.peer.submissionId);
    });

    it("지정 검토자의 파일 열람은 허가될 때마다 감사가 남고 다른 제출의 파일 ID는 거부됩니다", () => {
      const before = Number(value("SELECT count(*) FROM academic_assignment_review_file_reads"));
      const granted = JSON.parse(
        created(fileRead(people.reviewer, submissions.peer.submissionId, submissions.peer.fileId)),
      );
      expect(granted).toMatchObject({
        storage_key: submissions.peer.storageKey,
        mime_type: "application/pdf",
      });
      expect(
        fileRead(people.reviewer, submissions.peer.submissionId, submissions.owner.fileId),
      ).toEqual({ ok: false, code: "HRA03" });
      expect(Number(value("SELECT count(*) FROM academic_assignment_review_file_reads"))).toBe(
        before + 1,
      );
      expect(run("DELETE FROM academic_assignment_review_file_reads")).toEqual({
        ok: false,
        code: "HRA04",
      });
    });
  });

  describe("피드백 작성·제출·공개", () => {
    it("초안 → 제출 → 관리자 공개 → 공개 취소 → 사유 있는 수정의 이력을 모두 보존합니다", () => {
      const draft = json(save(people.reviewer, submissions.owner.submissionId, 0, "첫 피드백"));
      expect(draft).toMatchObject({ version: 1, status: "DRAFT", visibility: "PRIVATE" });
      // 초안은 공개할 수 없고, 제출해도 학생에게는 보이지 않습니다.
      expect(publish(people.manager, draft.id, 1)).toEqual({ ok: false, code: "HRA04" });
      expect(json(submit(people.reviewer, draft.id, 1))).toMatchObject({
        version: 2,
        status: "SUBMITTED",
      });
      expect(
        value(
          `SELECT count(*) FROM list_published_academic_feedback('${people.owner}','${ids.assignment}')`,
        ),
      ).toBe("0");
      // 검토자 본인은 공개할 수 없고(관리자가 아니면 HRA01), 관리자가 아닌 ADMIN도 거부합니다.
      expect(publish(people.reviewer, draft.id, 2)).toEqual({ ok: false, code: "HRA01" });
      expect(publish(people.admin, draft.id, 2)).toEqual({ ok: false, code: "HRA01" });
      expect(json(publish(people.manager, draft.id, 2))).toMatchObject({
        version: 3,
        visibility: "PUBLISHED_TO_STUDENT",
      });
      // 학생 본인만 공개 피드백을 보고, 같은 기수의 다른 학생은 보지 못합니다.
      expect(
        value(
          `SELECT body FROM list_published_academic_feedback('${people.owner}','${ids.assignment}')`,
        ),
      ).toBe("첫 피드백");
      expect(
        value(
          `SELECT count(*) FROM list_published_academic_feedback('${people.peer}','${ids.assignment}')`,
        ),
      ).toBe("0");
      // 공개된 피드백은 공개 취소 전 수정할 수 없습니다.
      expect(
        save(people.reviewer, submissions.owner.submissionId, 3, "고친 피드백", "오기 수정"),
      ).toEqual({ ok: false, code: "HRA04" });
      expect(retract(people.reviewer, draft.id, 3, "검토자 취소")).toEqual({
        ok: false,
        code: "HRA01",
      });
      expect(json(retract(people.manager, draft.id, 3, "표현 재검토"))).toMatchObject({
        version: 4,
        visibility: "PRIVATE",
      });
      expect(
        value(
          `SELECT count(*) FROM list_published_academic_feedback('${people.owner}','${ids.assignment}')`,
        ),
      ).toBe("0");
      // 제출한 피드백의 수정은 사유가 필요하고 다시 초안이 됩니다.
      expect(save(people.reviewer, submissions.owner.submissionId, 4, "고친 피드백")).toEqual({
        ok: false,
        code: "HRA07",
      });
      expect(
        json(save(people.reviewer, submissions.owner.submissionId, 4, "고친 피드백", "오기 수정")),
      ).toMatchObject({ version: 5, status: "DRAFT" });
      expect(
        value(`SELECT string_agg(version || ':' || action || ':' || body || ':' || COALESCE(reason, '-'), '|' ORDER BY version)
        FROM academic_assignment_review_events WHERE review_id='${draft.id}'`),
      ).toBe(
        "1:SAVE:첫 피드백:-|2:SUBMIT:첫 피드백:-|3:PUBLISH:첫 피드백:-|4:RETRACT:첫 피드백:표현 재검토|5:SAVE:고친 피드백:오기 수정",
      );
      expect(
        run(
          `UPDATE academic_assignment_review_events SET body='변조' WHERE review_id='${draft.id}'`,
        ),
      ).toEqual({ ok: false, code: "HRA04" });
      expect(run(`DELETE FROM academic_assignment_reviews WHERE id='${draft.id}'`)).toEqual({
        ok: false,
        code: "HRA04",
      });
      // 함수 밖 직접 수정은 같은 버전의 이력이 없으면 커밋 시 거부됩니다.
      expect(
        run(
          `UPDATE academic_assignment_reviews SET version=version+1, body='몰래 수정' WHERE id='${draft.id}'`,
        ),
      ).toEqual({ ok: false, code: "HRA04" });
    });

    it("검토자이자 관리자인 계정은 본인 피드백을 공개할 수 없고 다른 관리자가 공개합니다", () => {
      const review = json(
        save(people.reviewerManager, submissions.peer.submissionId, 0, "관리자 겸 검토자 피드백"),
      );
      json(submit(people.reviewerManager, review.id, 1));
      expect(publish(people.reviewerManager, review.id, 2)).toEqual({ ok: false, code: "HRA01" });
      expect(json(publish(people.manager, review.id, 2))).toMatchObject({
        visibility: "PUBLISHED_TO_STUDENT",
      });
      // 직접 쓰기로도 작성자 = 공개자 조합은 CHECK가 막습니다.
      expect(
        run(
          `UPDATE academic_assignment_reviews SET published_by_user_id=reviewer_user_id, version=version+1 WHERE id='${review.id}'`,
        ),
      ).toMatchObject({ ok: false });
    });

    it("동시 저장은 버전으로 직렬화되어 하나만 성공하고 나머지는 충돌입니다", async () => {
      const results = await Promise.all(
        ["경합 A", "경합 B", "경합 C"].map((body) =>
          runAsync(
            `SELECT public.save_academic_assignment_review('${people.otherReviewer}','${submissions.peer.submissionId}',0,'${body}',NULL,NULL);`,
          ),
        ),
      );
      // 다른 수업 검토자는 권한이 없으므로 모두 거부(경합과 무관하게 404 계열)
      expect(results.every((result) => !result.ok && result.code === "HRA03")).toBe(true);
      const first = await Promise.all(
        ["첫 경합 A", "첫 경합 B"].map((body) =>
          runAsync(
            `SELECT public.save_academic_assignment_review('${people.reviewer}','${submissions.peer.submissionId}',0,'${body}',NULL,NULL);`,
          ),
        ),
      );
      expect(first.filter((result) => result.ok)).toHaveLength(1);
      expect(first.filter((result) => !result.ok && result.code === "HRA04")).toHaveLength(1);
      const review = reviewOf(people.reviewer, submissions.peer.submissionId);
      const second = await Promise.all(
        ["둘째 경합 A", "둘째 경합 B", "둘째 경합 C"].map((body) =>
          runAsync(
            `SELECT public.save_academic_assignment_review('${people.reviewer}','${submissions.peer.submissionId}',1,'${body}',NULL,NULL);`,
          ),
        ),
      );
      expect(second.filter((result) => result.ok)).toHaveLength(1);
      expect(second.filter((result) => !result.ok && result.code === "HRA04")).toHaveLength(2);
      expect(value(`SELECT version FROM academic_assignment_reviews WHERE id='${review}'`)).toBe(
        "2",
      );
      expect(
        value(`SELECT count(*) FROM academic_assignment_review_events WHERE review_id='${review}'`),
      ).toBe("2");
    });

    it("지정 종료 후에는 즉시 저장·열람이 거부되지만 이미 쓴 피드백과 이력, 계정 참조는 보존됩니다", () => {
      const target = submissions.peer.submissionId;
      created(
        run(`SELECT public.end_academic_class_reviewer('${randomUUID()}','${people.manager}','${randomUUID()}',
        '${designations[people.otherReviewer]}',NULL,'합성 종료');`),
      );
      expect(save(people.otherReviewer, target, 0)).toEqual({ ok: false, code: "HRA03" });
      // 검토 기록이 있는 계정은 삭제할 수 없어 작성자 의미가 유지됩니다.
      expect(run(`DELETE FROM users WHERE id='${people.reviewerManager}'`)).toMatchObject({
        ok: false,
        code: "23503",
      });
      expect(
        value(
          `SELECT count(*) FROM academic_assignment_reviews WHERE reviewer_user_id='${people.reviewerManager}'`,
        ),
      ).toBe("1");
    });
  });

  describe("서비스·다운로드 경계", () => {
    it("플래그가 하나라도 꺼져 있으면 DB 조회 없이 거부하거나 빈 목록입니다", async () => {
      for (const flag of [
        "ACADEMIC_ENABLED",
        "ACADEMIC_FACULTY_REVIEW_ENABLED",
        "ACADEMIC_ASSIGNMENT_REVIEW_ENABLED",
      ]) {
        vi.stubEnv(flag, "false");
        await expect(
          listReviewSubmissions(principal(people.reviewer), ids.assignment),
        ).rejects.toMatchObject({ code: "DISABLED" });
        await expect(
          listFeedbackForPublication(principal(people.manager, "MEMBER")),
        ).rejects.toMatchObject({ code: "DISABLED" });
        expect(
          await listMyPublishedFeedback(principal(people.owner, "MEMBER"), ids.assignment),
        ).toEqual([]);
        const response = await downloadReviewerSubmissionFile(
          principal(people.reviewer),
          Promise.resolve({ id: submissions.peer.submissionId, fileId: submissions.peer.fileId }),
        );
        expect(response.status).toBe(404);
        vi.stubEnv(flag, "true");
      }
      expect(mocks.calls).toBe(0);
      expect(mocks.blobGet).not.toHaveBeenCalled();
    });

    it("서비스 목록·저장·제출·공개와 학생 공개 피드백 DTO는 내부 식별자를 노출하지 않습니다", async () => {
      const reviewer = principal(people.reviewer);
      const rows = await listReviewSubmissions(reviewer, ids.assignment);
      expect(rows.map((row) => row.submissionId).sort()).toEqual(
        [submissions.owner.submissionId, submissions.peer.submissionId].sort(),
      );
      expect(rows[0]).not.toHaveProperty("studentUserId");
      await expect(
        listReviewSubmissions(principal(people.otherFaculty), ids.assignment),
      ).resolves.toEqual([]);
      const peerRow = rows.find((row) => row.submissionId === submissions.peer.submissionId);
      await expect(
        saveAssignmentReview(reviewer, {
          submissionId: submissions.peer.submissionId,
          expectedVersion: 0,
          body: "늦은 요청",
        }),
      ).rejects.toMatchObject({ code: "CONFLICT" });
      const saved = await saveAssignmentReview(reviewer, {
        submissionId: submissions.peer.submissionId,
        expectedVersion: peerRow!.review!.version,
        body: "서비스 피드백",
        gradeLabel: "충실",
      });
      const submitted = await submitAssignmentReview(reviewer, {
        reviewId: saved.id,
        expectedVersion: saved.version,
      });
      await expect(
        publishAssignmentFeedback(reviewer, {
          reviewId: saved.id,
          expectedVersion: submitted.version,
        }),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(
        listFeedbackForPublication(principal(people.admin, "ADMIN")),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      const pending = (await listFeedbackForPublication(principal(people.manager, "MEMBER"))).find(
        (item) => item.reviewId === saved.id,
      );
      expect(pending).toMatchObject({
        visibility: "PRIVATE",
        body: "서비스 피드백",
        selfRelated: false,
      });
      await publishAssignmentFeedback(principal(people.manager, "MEMBER"), {
        reviewId: saved.id,
        expectedVersion: submitted.version,
      });
      const visible = await listMyPublishedFeedback(
        principal(people.peer, "MEMBER"),
        ids.assignment,
      );
      expect(visible.map((item) => item.body)).toContain("서비스 피드백");
      expect(visible[0]).not.toHaveProperty("reviewerUserId");
      expect(
        await listMyPublishedFeedback(principal(people.owner, "MEMBER"), ids.assignment),
      ).toEqual([]);
      await expect(
        saveAssignmentReview(reviewer, {
          submissionId: submissions.peer.submissionId,
          expectedVersion: 0,
          body: "",
        }),
      ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    });

    it("지정 검토자의 다운로드는 G1과 같은 비공개 첨부 헤더로 전달되고 감사가 남으며 비지정·본인은 404입니다", async () => {
      vi.stubEnv("ACADEMIC_SUBMISSION_BLOB_HOST", blobHost);
      vi.stubEnv("ACADEMIC_SUBMISSION_READ_WRITE_TOKEN", "test-only-token");
      const bytes = resourceQaPdfBytes();
      mocks.blobGet.mockImplementation(async (key: string) => ({
        statusCode: 200,
        blob: {
          url: `https://${blobHost}/${key}`,
          pathname: key,
          size: bytes.length,
          contentType: "application/pdf",
        },
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array(bytes));
            controller.close();
          },
        }),
      }));
      const before = Number(value("SELECT count(*) FROM academic_assignment_review_file_reads"));
      const response = await downloadReviewerSubmissionFile(
        principal(people.reviewer),
        Promise.resolve({ id: submissions.peer.submissionId, fileId: submissions.peer.fileId }),
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(response.headers.get("Content-Type")).toBe("application/octet-stream");
      expect(response.headers.get("Content-Security-Policy")).toBe("sandbox; default-src 'none'");
      expect(response.headers.get("Content-Disposition")).toContain("attachment");
      expect((await response.arrayBuffer()).byteLength).toBe(bytes.length);
      expect(Number(value("SELECT count(*) FROM academic_assignment_review_file_reads"))).toBe(
        before + 1,
      );
      for (const [actor, target] of [
        [people.otherFaculty, submissions.peer],
        [people.admin, submissions.peer],
        [people.owner, submissions.owner],
      ] as const) {
        const denied = await downloadReviewerSubmissionFile(
          principal(actor),
          Promise.resolve({ id: target.submissionId, fileId: target.fileId }),
        );
        expect(denied.status).toBe(404);
      }
      expect(Number(value("SELECT count(*) FROM academic_assignment_review_file_reads"))).toBe(
        before + 1,
      );
      expect(mocks.blobGet).toHaveBeenCalledTimes(1);
    });
  });
});
