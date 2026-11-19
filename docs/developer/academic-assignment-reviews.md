# 과제 검토·피드백 이력과 담당 검토자 평가 화면 (#162, 기능 비활성)

> 상태: **데이터 모델·서버 계약·화면 구현, 격리 PostgreSQL 검증 / 운영 미적용·미활성.** 기준: 2026-11-19.
> 정책 근거는 [학사 운영 정책 초안](../ACADEMIC-OPERATIONS-POLICY.md) P11(지정된 교수 검토자만 열람·피드백)·P12(학생 공개는 학사 운영 관리자)이며, 그 문서의 운영 승인 전에는 `ACADEMIC_ASSIGNMENT_REVIEW_ENABLED`를 켜지 않는다. 이 문서는 정책 승인이나 운영 적용 기록이 아니다.

[#162](https://github.com/Human-Renaissance-Academy/hra-website/issues/162)는 G1 최종 제출물을 기준으로 지정된 교수 검토자의 정성 피드백을 기록하고, 학사 운영 관리자가 확인한 피드백만 학생 본인에게 공개한다. 검토 권한은 [#161 교수 과제 검토 권한](academic-faculty-reviewers.md)의 `can_review_assignment`만 근거로 쓰며, 홈페이지 `ADMIN`·`FACULTY` 역할과 출결 권한은 관여하지 않는다. G1 제출 행·파일은 바꾸지 않는다.

## 1. 흐름과 권한

| 단계 | 주체 | 조건 |
| --- | --- | --- |
| 제출물 목록·파일 열람 | 지정 검토자 | DB 현재 시각에 `can_review_assignment`가 참, 과제 공개(초안 불가), **제출 학생 계정·제출 계정 ≠ 검토자 계정** |
| 피드백 초안 저장·수정 | 지정 검토자 | 위와 같음. 화면이 읽은 버전(`expectedVersion`)이 현재 버전과 같아야 함. 공개된 피드백은 공개 취소 전 수정 불가. 제출한 피드백 수정은 사유 필수이며 다시 초안이 됨 |
| 피드백 제출 | 작성 검토자 | 초안 상태·버전 일치. 제출만으로 학생에게 공개되지 않음 |
| 학생 공개·공개 취소 | 학사 운영 관리자(#165) | 관리자 지정 유효, **작성 검토자 본인·제출 학생 본인이 아님**, 제출 상태·버전 일치. 공개 취소는 사유 필수 |
| 공개 피드백 조회 | 학생 본인 | `MEMBER` 계정, 본인 학생 학적·본인 제출, `SUBMITTED`·`PUBLISHED_TO_STUDENT`만. 초안·비공개·검토자 식별자·이력 비노출 |

- 담당하지 않은 과제·없는 제출물·다른 제출의 파일은 같은 404(`HRA03`)로 응답한다. 자기 제출물은 `HRA01`(403)이며 다운로드 경로에서는 404로 숨긴다.
- **자기 검토 금지:** 저장·제출·파일 열람은 SQL 함수 `require_academic_submission_reviewer` 안에서 제출물·대상·과제·학적·학생 행과 요청 계정·현재 연결·현재 지정 행을 잠근 뒤 `can_review_assignment`를 다시 호출하고 같은 트랜잭션에서 제출 학생 계정을 비교한다. 연결 해제·지정 종료·`PENDING` 전환과의 경합은 이 잠금으로 직렬화된다.
- 숫자 점수·학점·GPA·순위는 두지 않는다. 선택 평가 표기(`grade_label`, 20자)는 계산하지 않는 짧은 문구이며 운영 규칙 없이 숫자 성적으로 쓰지 않는다.

## 2. DB 변경 (`scripts/migrate-academic-assignment-reviews.sql`)

G1 과제·제출(#147·#148), #165 `require_academic_operations_manager`, #161 `can_review_assignment`가 선행해야 하는 **추가형** SQL이다. 선행 표·함수가 없으면 중단한다. 소스 목록에는 `g3-assignment-reviews`(`versioned_candidate`, 선행 `g1-submissions`·`g2-faculty-reviewers`), 설치 대응표에는 `fresh.disposition: unresolved`로 등록했고 G1 순서·schema export·fresh bundle·운영 manifest에는 편입하지 않았다. 적용은 [데이터베이스 변경 절차](database-change-procedure.md)를 따른다.

| 표 | 내용 |
| --- | --- |
| `academic_assignment_reviews` | 제출물·검토자마다 1행(`UNIQUE(submission_id, reviewer_user_id)`). 본문(1~5,000자), 선택 평가 표기, `status`(`DRAFT`·`SUBMITTED`), `visibility`(`PRIVATE`·`PUBLISHED_TO_STUDENT`), 공개자·공개 시각, `version` |
| `academic_assignment_review_events` | 버전마다 본문·평가 표기·상태·공개 여부·행위(`SAVE`·`SUBMIT`·`PUBLISH`·`RETRACT`)·행위자·사유를 남기는 추가 전용 이력(`UNIQUE(review_id, version)`) |
| `academic_assignment_review_file_reads` | 지정 검토자의 제출 파일 전달 허가 감사(추가 전용). G1 `academic_submission_file_reads`의 `access_scope` CHECK를 바꾸지 않으려고 별도 표로 둔다 |

- **불변성:** 검토 행은 대상·검토자·생성 시각을 바꿀 수 없고 버전을 1씩 올리는 변경만 허용한다(`HRA04`). 삭제·TRUNCATE를 거부한다. 지연 제약 트리거 `academic_assignment_reviews_history`가 커밋 시점에 현재 버전과 같은 내용의 이력 행이 있는지 확인하므로 함수 밖 직접 수정도 이력 없이 끝나지 않는다. 이력·감사 표는 추가만 허용한다.
- **작성자 공개 금지:** CHECK `academic_assignment_reviews_publication_check`가 `published_by_user_id <> reviewer_user_id`를 강제한다.
- **동시성:** 저장은 제출물·검토자 단위 advisory lock 뒤 행을 `FOR UPDATE`로 잠그고 `expectedVersion`을 비교한다. 동시 첫 작성·동시 수정 중 하나만 성공하고 나머지는 `HRA04`(409)다.
- **참조 삭제:** 모든 참조는 `ON DELETE RESTRICT`다. 검토 기록이 있는 계정·제출물·과제는 삭제할 수 없어 작성자·대상의 의미가 유지된다. 피드백은 [보존·파기 정책 초안](../ACADEMIC-PRIVACY-RETENTION-POLICY.md)에 따라 수료 판정 확정일부터 1년 보존 후 삭제 대상이지만, 승인된 파기 함수가 생길 때까지 삭제를 지원하지 않는다.
- **설치 검사:** #161과 같이 재적용 시 컬럼·제약·인덱스·RLS·CHECK를 catalog로 대조하고, 이 파일이 만든 것 외의 사용자 트리거(비활성 포함), 소유자 외 EXECUTE 권한, 함수 다중 정의가 있으면 전체를 롤백한다. SECURITY DEFINER는 쓰지 않는다.

| 함수 | 역할 |
| --- | --- |
| `save_academic_assignment_review` / `submit_academic_assignment_review` | 검토자 초안 저장·제출 |
| `publish_academic_assignment_feedback` / `retract_academic_assignment_feedback` | 학사 운영 관리자 학생 공개·공개 취소 |
| `list_academic_review_submissions(user, assignment)` | 검토자 화면 목록(학생 표시 이름·제출 시각·파일 ID·본인 피드백). 본인 제출물 제외, 다른 검토자 피드백·학생 계정 ID 없음 |
| `list_academic_feedback_for_publication(actor)` | 관리자 공개 화면 목록(제출된 피드백). 관리자 본인 관련 행은 `self_related`로 표시 |
| `list_published_academic_feedback(user, assignment)` | 학생 본인 공개 피드백 |
| `authorize_academic_review_file_read(user, submission, file)` | 검토자 파일 전달 허가와 감사 행을 한 트랜잭션으로 확정 |
| `require_academic_submission_reviewer` | 내부 공통 인가(잠금 → `can_review_assignment` → 자기 검토 거부) |

오류 코드: `HRA01` 권한 없음·자기 검토·작성자 공개, `HRA03` 대상 없음(담당 아님 포함), `HRA04` 버전 충돌·상태 불일치·불변성 위반, `HRA07` 입력 오류.

## 3. 서버 계약과 화면

| 위치 | 책임 |
| --- | --- |
| `src/features/academics/assignment-reviews/contracts.ts` | `zod/v4` 입력, 고정 오류 코드(`AssignmentReviewError`), SQLSTATE 변환, DTO(학생 계정 ID·저장 키·검토자 ID(학생용) 제외) |
| `repository.ts` / `service.ts` | SQL 함수 호출 / 주체 확인 → 플래그 → 입력 검증 → 저장소 |
| `actions.ts` | Server Action(FormData 변환, Web 세션 → 주체, 재검증) |
| `/member/reviews`, `/member/reviews/[assignmentId]` | 검토자 과제 목록, 제출물 파일 내려받기·피드백 초안 저장·제출 |
| `/member/academic-operations/feedback` | 학사 운영 관리자 공개·공개 취소(#160 학사 운영 화면과 같은 회원 영역) |
| `/member/assignments/[id]` | 학생 본인의 공개 피드백 표시(기능이 꺼져 있으면 DB 조회 없이 생략) |
| `/api/academic/reviews/submissions/[id]/file/[fileId]` | 검토자 파일 다운로드. G1 `deliverSubmissionFile` 전달 경로를 재사용해 `Cache-Control: private, no-store`, `nosniff`, `Content-Disposition: attachment`, `CSP sandbox` 등 같은 헤더와 관측 이벤트를 쓴다 |

G1 `downloadSubmissionFile`은 인증·인가 단계만 분리(`deliverSubmissionFile`)했으며 본인·관리 열람 동작은 바뀌지 않는다.

## 4. 기능 플래그

`ACADEMIC_ENABLED`·`ACADEMIC_FACULTY_REVIEW_ENABLED`·`ACADEMIC_ASSIGNMENT_REVIEW_ENABLED`(기본 `false`)가 **모두 정확히 `true`**일 때만 동작한다. 꺼져 있으면 검토·공개 화면은 404, 서비스 변경·목록은 `DISABLED`, 검토자 다운로드는 404, 학생 피드백은 빈 목록이며 학사 표에 접속하지 않는다. 변수 설명은 [환경변수 목록](environment-inventory.md)에 생성된다.

## 5. 검증

```bash
HRA_TEST_PG_BIN=/usr/lib/postgresql/14/bin npx vitest run tests/unit/academic-assignment-reviews-postgres.test.ts --environment=node --maxWorkers=1 --testTimeout=180000
node scripts/check-db-source-inventory.mjs && node scripts/check-db-installation-contract.mjs
node scripts/check-environment-contract.mjs
```

격리 테스트는 실제 G1 학적·과제·제출 SQL과 #165·#161·#162 SQL을 설치해 SQL 2회 적용·구조 불일치·숨긴 트리거·남은 EXECUTE 권한 거부와 PUBLIC 실행 권한 없음, 지정되지 않은 `FACULTY`·`ADMIN`·다른 수업 검토자·학사 운영 관리자·지정 승인자의 저장·열람 거부, 초안 과제 거부, 제출 학생 본인이 검토자로 지정된 경우의 저장·파일 열람 거부와 목록 제외, 파일 열람 감사와 다른 제출 파일 거부, 초안→제출→공개→공개 취소→사유 있는 수정의 이력 보존, 검토자 본인·관리자 아닌 `ADMIN`의 공개 거부, 검토자 겸 관리자의 본인 피드백 공개 거부, 학생 본인 공개 피드백만 조회, 이력 변조·검토 삭제·이력 없는 직접 수정 거부, 동시 첫 작성·동시 수정의 버전 직렬화, 지정 종료 즉시 거부와 계정 삭제 차단, 플래그별 DB 미접속, 서비스 DTO, 다운로드 헤더·감사와 비지정·본인 404를 확인한다.

## 6. 남은 위험·작업

- **앱 DB 역할이 표 소유자다.** 소유 역할로 트리거를 끄면 인가·이력을 우회할 수 있다(G1·#165·#161과 같은 한계, #280).
- 공개 취소 사유·수정 사유에 개인정보를 적지 않는다. 화면은 사유를 다시 표시하지 않는다.
- 제출 파일을 내려받은 뒤의 외부 유출은 기술적으로 막을 수 없다. 화면은 검토 목적 외 공유 금지를 안내하고 열람 감사를 남긴다.
- [ ] #143 운영 승인(P11·P12)과 운영 DB 적용 절차·백업 확인
- [ ] 피드백 1년 보존 후 파기 함수(별도 승인)
- [ ] 검토자·관리자·학생 화면 E2E
