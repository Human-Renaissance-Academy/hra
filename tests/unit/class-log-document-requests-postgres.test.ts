// @vitest-environment node
/**
 * 수업일지 문서 예약과 확정의 권한 및 트랜잭션 계약을 격리 PostgreSQL에서 검증합니다.
 * 업로드한 객체의 실제 확인은 서버 책임이므로 예약된 합성 메타데이터만 넘깁니다.
 */
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportQaSchemaSql } from "../support/qa-schema-export.mjs";
import { createQaPostgres } from "../support/resource-qa-postgres.mjs";

const bin = process.env.HRA_TEST_PG_BIN;
const cohort = randomUUID();
const otherCohort = randomUUID();
const member = randomUUID();
const unassigned = randomUUID();
const otherMember = randomUUID();
const faculty = randomUUID();
const otherFaculty = randomUUID();
const admin = randomUUID();
const pending = randomUUID();
const pdf = { fileFormat: "PDF", sizeBytes: 12, originalName: "일지.pdf" };
const hangul = { fileFormat: "HWPX", sizeBytes: 24, originalName: "일지.hwpx" };

type RequestResult = {
  state: string;
  logId?: string;
  version?: number;
  pdf?: { fileId: string } | null;
  hangul?: { fileId: string } | null;
};

describe.skipIf(!bin)("수업일지 문서 예약 및 확정 PostgreSQL 계약", () => {
  let cluster: ReturnType<typeof createQaPostgres> | undefined;

  /** 격리 클러스터 안에서만 시험 데이터를 만들고 읽습니다. */
  function sql(statement: string) {
    if (!cluster) throw new Error("격리 DB를 준비하지 못했습니다.");
    return cluster.sql(statement);
  }

  /** 합성 요청을 서버 진입점과 같은 함수로 전달합니다. */
  function call(
    actor: string,
    id: string,
    stage: "reserve" | "inspect" | "publish",
    payload?: object,
  ) {
    const argument = payload ? `'${JSON.stringify(payload).replaceAll("'", "''")}'::jsonb` : "NULL";
    return JSON.parse(
      sql(
        `SELECT public.write_class_log_document_request('${actor}', '${id}', '${stage}', ${argument});`,
      ),
    ) as RequestResult;
  }

  /** 신규 일지용 합성 입력을 만듭니다. */
  function registration(classDay: string) {
    return { cohortId: otherCohort, classDay, weekNumber: 1, title: "문서 일지", pdf };
  }

  /** 확정 결과에서 후속 수정에 필요한 일지 ID를 가져옵니다. */
  function publish(actor: string, id: string) {
    const result = call(actor, id, "publish");
    expect(result.state).toBe("published");
    if (!result.logId) throw new Error("확정 응답에 일지 ID가 없습니다.");
    return { ...result, logId: result.logId };
  }

  beforeAll(() => {
    cluster = createQaPostgres(bin);
    sql(exportQaSchemaSql());
    for (const name of [
      "migrate-class-log-documents.sql",
      "migrate-class-log-document-requests.sql",
    ]) {
      sql(readFileSync(new URL(`../../scripts/${name}`, import.meta.url), "utf8"));
    }
    sql(`
      INSERT INTO cohorts (id, name) VALUES ('${cohort}', '첫 기수'), ('${otherCohort}', '다른 기수');
      INSERT INTO users (id, name, email, role, cohort_id) VALUES
        ('${member}', '작성자', 'author@test.invalid', 'MEMBER', '${cohort}'),
        ('${unassigned}', '미배정', 'unassigned@test.invalid', 'MEMBER', NULL),
        ('${otherMember}', '다른 회원', 'other@test.invalid', 'MEMBER', '${cohort}'),
        ('${faculty}', '교수', 'faculty@test.invalid', 'FACULTY', NULL),
        ('${otherFaculty}', '다른 교수', 'other-faculty@test.invalid', 'FACULTY', NULL),
        ('${admin}', '관리자', 'admin@test.invalid', 'ADMIN', NULL),
        ('${pending}', '승인 대기', 'pending@test.invalid', 'PENDING', '${cohort}');
    `);
  }, 60_000);

  afterAll(() => cluster?.close());

  it("예약과 확정에 현재 회원의 배정 기수를 적용하고 승인 대기 및 미배정을 거부한다", () => {
    const request = randomUUID();
    const input = registration("2026-12-01");
    expect(call(pending, request, "reserve", input).state).toBe("forbidden");
    expect(call(unassigned, request, "reserve", input).state).toBe("forbidden");
    expect(call(member, request, "reserve", input).state).toBe("reserved");
    expect(call(otherMember, request, "inspect").state).toBe("missing");
    try {
      sql(`UPDATE users SET cohort_id = '${otherCohort}' WHERE id = '${member}';`);
      expect(call(member, request, "inspect").state).toBe("forbidden");
      expect(call(member, request, "publish").state).toBe("forbidden");
    } finally {
      sql(`UPDATE users SET cohort_id = '${cohort}' WHERE id = '${member}';`);
    }
    const { logId } = publish(member, request);
    expect(
      sql(`SELECT cohort_id, author_id, class_date FROM class_logs WHERE id = '${logId}';`),
    ).toBe(`${cohort}|${member}|2026-11-30 15:00:00`);
  });

  it("예약을 다시 읽고 동일한 확정 결과를 재사용하며 다른 입력으로 요청 키를 재사용하지 못한다", () => {
    const request = randomUUID();
    const input = { ...registration("2026-12-02"), hangul };
    const reservation = call(admin, request, "reserve", input);
    expect(reservation).toMatchObject({
      state: "reserved",
      pdf: { ...pdf, fileId: expect.any(String) },
      hangul: { ...hangul, fileId: expect.any(String) },
    });
    expect(call(admin, request, "inspect")).toEqual(reservation);
    expect(call(admin, request, "reserve", input)).toEqual(reservation);
    expect(call(admin, request, "reserve", { ...input, title: "다른 제목" }).state).toBe(
      "conflict",
    );
    const result = publish(admin, request);
    expect(result.version).toBe(1);
    expect(call(admin, request, "reserve", input)).toEqual(result);
    expect(call(admin, request, "inspect")).toEqual(result);
    expect(call(admin, request, "publish")).toEqual(result);
    expect(call(admin, request, "reserve", { ...input, title: "다른 제목" }).state).toBe(
      "conflict",
    );
    expect(
      sql(`
      SELECT q.payload IS NULL, r.version, r.pdf_file_id, r.hangul_file_id
      FROM class_log_document_requests q
      JOIN class_log_document_revisions r ON r.class_log_id = q.result_log_id
      WHERE q.actor_id = '${admin}' AND q.request_id = '${request}';
    `),
    ).toBe(`t|1|${reservation.pdf?.fileId}|${reservation.hangul?.fileId}`);
  });

  it("만료된 예약의 조회·재예약·확정을 거부하고 일지를 만들지 않는다", () => {
    const request = randomUUID();
    const input = registration("2026-12-03");
    expect(call(faculty, request, "reserve", input).state).toBe("reserved");
    sql(`UPDATE class_log_document_requests SET expires_at = now() - interval '1 second'
      WHERE actor_id = '${faculty}' AND request_id = '${request}';`);
    expect(call(faculty, request, "inspect").state).toBe("expired");
    expect(call(faculty, request, "reserve", input).state).toBe("expired");
    expect(call(faculty, request, "publish").state).toBe("expired");
    expect(
      sql(`SELECT count(*) FROM class_log_document_records WHERE class_day = '2026-12-03';`),
    ).toBe("0");
  });

  it("교수 작성자와 관리자만 해당 일지를 수정하고 미변경 PDF를 다음 버전에도 유지한다", () => {
    const request = randomUUID();
    const first = call(faculty, request, "reserve", registration("2026-12-04"));
    expect(first.state).toBe("reserved");
    const { logId } = publish(faculty, request);
    const input = { logId, version: 1, hangul, changeNote: "한글 원본 추가" };
    for (const actor of [member, otherMember, otherFaculty, pending]) {
      expect(call(actor, randomUUID(), "reserve", input).state).toBe("forbidden");
    }
    const facultyRevision = randomUUID();
    const second = call(faculty, facultyRevision, "reserve", input);
    expect(second.state).toBe("reserved");
    expect(publish(faculty, facultyRevision).version).toBe(2);
    const adminRevision = randomUUID();
    expect(call(admin, adminRevision, "reserve", { ...input, version: 2 }).state).toBe("reserved");
    expect(publish(admin, adminRevision).version).toBe(3);
    expect(
      sql(`
      SELECT version, pdf_file_id, hangul_file_id, change_note
      FROM class_log_document_revisions WHERE class_log_id = '${logId}' AND version <= 2 ORDER BY version;
    `),
    ).toBe(
      `1|${first.pdf?.fileId}||\n2|${first.pdf?.fileId}|${second.hangul?.fileId}|한글 원본 추가`,
    );
  });

  it("회원 작성자의 예약 이후 기수 변경과 다른 수정본의 선행 확정을 다시 검사한다", () => {
    const request = randomUUID();
    expect(call(member, request, "reserve", registration("2026-12-05")).state).toBe("reserved");
    const { logId } = publish(member, request);
    const input = { logId, version: 1, hangul };
    const stale = randomUUID();
    const reserved = call(member, stale, "reserve", input);
    expect(reserved.state).toBe("reserved");
    try {
      sql(`UPDATE users SET cohort_id = '${otherCohort}' WHERE id = '${member}';`);
      expect(call(member, stale, "publish").state).toBe("forbidden");
    } finally {
      sql(`UPDATE users SET cohort_id = '${cohort}' WHERE id = '${member}';`);
    }
    const winner = randomUUID();
    expect(call(admin, winner, "reserve", input).state).toBe("reserved");
    expect(publish(admin, winner).version).toBe(2);
    expect(call(member, stale, "inspect").state).toBe("conflict");
    expect(call(member, stale, "publish").state).toBe("conflict");
    expect(call(member, randomUUID(), "reserve", input).state).toBe("conflict");
    expect(
      sql(`SELECT count(*) FROM class_log_document_files WHERE id = '${reserved.hangul?.fileId}';`),
    ).toBe("0");
  });

  it("기수·수업일·주차 중복 확정에서 기존 행을 보존하고 패자 저장 전체를 되돌린다", () => {
    const winner = randomUUID();
    const loser = randomUUID();
    const input = registration("2026-12-06");
    expect(call(admin, winner, "reserve", input).state).toBe("reserved");
    const reserved = call(faculty, loser, "reserve", input);
    expect(reserved.state).toBe("reserved");
    const { logId } = publish(admin, winner);
    // 함수 호출을 예외 블록으로 감싸 PG의 유일성 위반과 하위 쓰기 롤백을 함께 확인합니다.
    sql(`
      DO $test$
      BEGIN
        PERFORM public.write_class_log_document_request('${faculty}', '${loser}', 'publish');
        RAISE EXCEPTION '예상한 유일성 위반이 발생하지 않았습니다.';
      EXCEPTION WHEN unique_violation THEN
        NULL;
      END;
      $test$;
    `);
    expect(
      sql(`
      SELECT id FROM class_logs WHERE cohort_id = '${otherCohort}' AND class_date = '2026-12-05 15:00';
    `),
    ).toBe(logId);
    expect(
      sql(`SELECT count(*) FROM class_log_document_files WHERE id = '${reserved.pdf?.fileId}';`),
    ).toBe("0");
    expect(
      sql(`SELECT payload IS NOT NULL, result_log_id IS NULL, result_version IS NULL
      FROM class_log_document_requests WHERE actor_id = '${faculty}' AND request_id = '${loser}';`),
    ).toBe("t|t|t");
  });
});
