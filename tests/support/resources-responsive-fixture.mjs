/**
 * 회원 자료실 반응형 회귀(#601) 전용 합성 계정·자료 fixture입니다.
 *
 * 역할:
 * - 실제 Drizzle 스키마가 설치된 새 격리 PostgreSQL에만 합성 행을 넣습니다.
 * - 운영 회원·자료·URL을 복사하지 않으며, 이메일은 `.invalid` 도메인과 고정 시험 비밀번호만 사용합니다.
 * - 브라우저 spec은 이 모듈의 식별자·제목 상수를 그대로 읽어 링크·필터·페이지네이션을 검증합니다.
 *
 * 사용 위치: scripts/verify-resources-responsive.mjs, tests/e2e/resources-responsive.spec.ts
 */
import { hashSync } from "bcryptjs";

/** UUID 형식의 합성 식별자를 그룹·번호로 만듭니다. 운영 UUID와 겹치지 않는 고정 접두사를 씁니다. */
const id = (group, number) => `9${group}000000-0000-4000-8000-${String(number).padStart(12, "0")}`;

// 로그인 전용 합성 비밀번호입니다. 격리 DB에서만 해시로 저장합니다.
export const resourcesResponsivePassword = "resources-responsive-only-password";

// MEMBER·FACULTY 두 역할만 브라우저에서 로그인합니다. 업로드 버튼 노출 조건이 역할별로 다릅니다.
export const resourcesResponsiveUsers = {
  member: {
    id: id(1, 1),
    name: "자료 시험 회원",
    email: "member@resources-responsive.invalid",
    role: "MEMBER",
  },
  faculty: {
    id: id(1, 2),
    name: "자료 시험 교수",
    email: "faculty@resources-responsive.invalid",
    role: "FACULTY",
  },
};

export const resourcesResponsiveIds = {
  cohortA: id(2, 1),
  cohortB: id(2, 2),
  log: id(3, 1),
  weeklyBody: id(4, 1),
  weeklyFile: id(4, 2),
  weeklyOther: id(4, 3),
  materialStudent: id(5, 1),
  materialFaculty: id(5, 2),
  template: id(6, 1),
  guide: id(6, 2),
  // 가이드북은 페이지네이션(10개 단위) 확인을 위해 12개를 만듭니다.
  guidebooks: Array.from({ length: 12 }, (_, index) => id(7, index + 1)),
};

// 좁은 화면 줄바꿈을 확인하기 위해 공백 없는 긴 제목을 가장 최신 가이드북에 둡니다.
export const resourcesResponsiveLongTitle = `합성반응형점검용아주긴가이드북제목${"가나다라마바사".repeat(6)}`;

export const resourcesResponsiveTitles = {
  cohortA: "자료 시험 1기",
  cohortB: "자료 시험 2기",
  log: "합성 수업일지 1주차",
  weeklyBody: "합성 주차 텍스트 본문",
  weeklyFile: "합성 주차 텍스트 첨부",
  weeklyOther: "합성 다른 기수 텍스트",
  materialStudent: "합성 학생용 강의자료",
  materialFaculty: "합성 교수용 강의자료",
  template: "합성 보고서 양식",
  guide: "합성 작성 안내서",
  guidebook: (index) =>
    index === 0
      ? resourcesResponsiveLongTitle
      : `합성 가이드북 ${String(index + 1).padStart(2, "0")}`,
};

export const resourcesResponsiveSlugs = {
  template: "resources-responsive-template",
  guide: "resources-responsive-guide",
};

/** 문자열 리터럴만 이 모듈의 고정 상수로 만들며 외부 입력은 받지 않습니다. */
const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;

/** 새 격리 클러스터에 합성 계정·기수·여섯 종류 자료를 설치합니다. */
export function installResourcesResponsiveFixture(cluster) {
  const hash = hashSync(resourcesResponsivePassword, 12);
  const { member, faculty } = resourcesResponsiveUsers;
  const ids = resourcesResponsiveIds;
  const titles = resourcesResponsiveTitles;
  // 비공개 Blob 형식의 주소지만 실제로 존재하지 않는 시험 경로입니다. 목록은 파일 URL을 노출하지 않습니다.
  const fileUrl = literal(
    "https://resources-responsive.private.blob.vercel-storage.com/qa/unused.pdf",
  );
  cluster.sql(`
    INSERT INTO cohorts(id, name) VALUES
      (${literal(ids.cohortA)}, ${literal(titles.cohortA)}),
      (${literal(ids.cohortB)}, ${literal(titles.cohortB)});
    INSERT INTO users(id, name, email, password_hash, role, cohort_id) VALUES
      (${literal(member.id)}, ${literal(member.name)}, ${literal(member.email)}, ${literal(hash)}, 'MEMBER', ${literal(ids.cohortA)}),
      (${literal(faculty.id)}, ${literal(faculty.name)}, ${literal(faculty.email)}, ${literal(hash)}, 'FACULTY', NULL);
    INSERT INTO class_logs(id, title, content, class_date, cohort_id, author_id) VALUES
      (${literal(ids.log)}, ${literal(titles.log)}, '합성 수업일지 본문', now() - interval '1 day', ${literal(ids.cohortA)}, ${literal(member.id)});
    INSERT INTO weekly_texts(id, title, body, file_url, cohort_id, text_type, class_date) VALUES
      (${literal(ids.weeklyBody)}, ${literal(titles.weeklyBody)}, '합성 본문', '', ${literal(ids.cohortA)}, '고전명작', now() - interval '2 day'),
      (${literal(ids.weeklyFile)}, ${literal(titles.weeklyFile)}, NULL, ${fileUrl}, ${literal(ids.cohortA)}, NULL, now() - interval '3 day'),
      (${literal(ids.weeklyOther)}, ${literal(titles.weeklyOther)}, '합성 본문', '', ${literal(ids.cohortB)}, '경영서', now() - interval '4 day');
    INSERT INTO class_materials(id, title, file_url, file_name, week_number, lecture_title, audience, uploaded_by_id, class_date) VALUES
      (${literal(ids.materialStudent)}, ${literal(titles.materialStudent)}, ${fileUrl}, '합성.pdf', 3, '합성 강의 제목', 'STUDENT', ${literal(faculty.id)}, now() - interval '1 day'),
      (${literal(ids.materialFaculty)}, ${literal(titles.materialFaculty)}, ${fileUrl}, '합성.pdf', NULL, NULL, 'FACULTY', ${literal(faculty.id)}, now() - interval '2 day');
    INSERT INTO report_templates(id, slug, title, category, body) VALUES
      (${literal(ids.template)}, ${literal(resourcesResponsiveSlugs.template)}, ${literal(titles.template)}, 'template', '합성 양식'),
      (${literal(ids.guide)}, ${literal(resourcesResponsiveSlugs.guide)}, ${literal(titles.guide)}, 'guide', '합성 안내');
    INSERT INTO guidebooks(id, title, file_url, file_name, created_at) VALUES
      ${ids.guidebooks
        .map(
          (guidebookId, index) =>
            `(${literal(guidebookId)}, ${literal(titles.guidebook(index))}, ${fileUrl}, '합성.pdf', now() - interval '${index} hour')`,
        )
        .join(",\n      ")};
  `);
}
