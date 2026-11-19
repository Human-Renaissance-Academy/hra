# 교수 계정 연결과 수업별 과제 검토 권한 (#161, 기능 비활성)

> 상태: **데이터 모델·서버 계약·권한 서비스 구현, 격리 PostgreSQL 검증 / 화면 없음 / 운영 미적용·미활성.** 기준: 2026-11-19.
> 정책 근거는 [학사 운영 정책 초안](../ACADEMIC-OPERATIONS-POLICY.md) P11 권장안이며, 그 문서의 운영 승인 전에는 `ACADEMIC_FACULTY_REVIEW_ENABLED`를 켜지 않는다. 이 문서는 정책 승인이나 운영 적용 기록이 아니다.

[#161](https://github.com/Human-Renaissance-Academy/hra-website/issues/161)의 첫 단계로, 공개 교수 프로필(`faculty`)과 실제 로그인 계정의 검증된 연결, 수업별 과제 검토자 지정, 그리고 #162 검토·피드백 경로가 공통으로 호출할 **과제 검토 권한 판정**을 추가한다. 제출물·파일 열람과 피드백(#162), 화면은 아직 없다.

**교수는 출결 담당자가 아니다.** 이 문서의 연결·지정·판정은 출결 조회·입력·정정 권한의 근거가 아니며, [운영 인력 배정과 출결 권한 판정](academic-staff-assignments.md)의 `can_record_academic_attendance`와 서로 참조하지 않는다.

## 1. 권한 구조 한눈에 보기

| 권한 | 부여 근거 | 부여·종료 주체 | 홈페이지 역할과의 관계 |
| --- | --- | --- | --- |
| 교수 프로필↔계정 연결 | `academic_faculty_account_links`의 유효 기간 행 | 유효한 학사 운영 관리자(#165). 자기 연결 금지 | `FACULTY` 역할이어도 연결 없으면 교수로 보지 않음 |
| 수업별 과제 검토자 | `academic_class_reviewer_designations`의 유효 기간 행 | 유효한 학사 운영 관리자. 자기와 연결된 교수 지정 금지 | `schedule_sessions.faculty_id`(수업 내용 담당)는 지정 근거가 아님 |
| 과제 검토 | 위 연결과 지정이 **DB 현재 시각**에 모두 유효 + 과제가 그 수업에 연결 + 과제 공개됨 + 계정이 `PENDING` 아님 | — | `ADMIN`·`FACULTY`·학사 운영 관리자·운영 인력 배정만으로는 권한 없음 |

- 연결 대상 계정은 기존 로그인 계정이며 `PENDING`이 아니어야 한다. 확인 방식(`IN_PERSON`·`VERIFIED_CONTACT`)과 확인 근거 참조 UUID를 함께 기록하며, **이메일·이름(동명이인) 일치로 자동 연결하지 않는다.**
- 한 교수 프로필에는 동시에 하나의 계정, 한 계정에는 동시에 하나의 교수 프로필만 연결된다. 해제 후 다른 계정을 연결하면 수업 지정은 교수 기준이므로 새 계정이 이어받는다.
- 이슈 본문은 연결 승인 주체를 `ADMIN`으로 적었으나, 정책 초안 P11과 AGENTS.md §4(홈페이지 `ADMIN`은 학사 권한이 아님)에 따라 **학사 운영 관리자**가 연결·지정한다.

## 2. DB 변경 (`scripts/migrate-academic-faculty-reviewers.sql`)

G1 과제(`public.assignments`, #147)와 #165의 `require_academic_operations_manager`·`require_academic_staff_account`가 선행해야 하는 **추가형** SQL이다. 선행 표·함수가 없으면 아무것도 만들지 않고 중단한다. G1 `g1Order`에 넣지 않았고, 소스 목록에는 `g2-faculty-reviewers`(`versioned_candidate`, 선행 `g1-assignments`·`g2-staff-assignments`)로, 설치 대응표에는 `fresh.disposition: unresolved`로 등록했다. schema export·fresh bundle·운영 manifest에는 편입하지 않았다. 적용은 [데이터베이스 변경 절차](database-change-procedure.md)를 따른다.

| 표 | 내용 |
| --- | --- |
| `academic_faculty_account_links` | 교수 프로필·계정·유효 기간·확인 방식·확인자(`verified_by_user_id`)·종료자/시각/사유 |
| `academic_class_reviewer_designations` | 교수 프로필·수업 일정(`schedule_event_id`)·선택 세션(`schedule_session_id`)·유효 기간·지정자·종료자/시각/사유 |
| `academic_faculty_review_events` | 연결·해제·지정·지정 종료의 추가 전용 감사. `request_id`로 재시도 멱등성, 입력 원문 대신 SHA-256 요약만 저장 |

- **검토 대상 범위:** 세션을 지정하면 그 세션에 연결된 과제만, 세션 없이 일정을 지정하면 그 일정에 연결된 모든 과제(세션 과제 포함)를 검토할 수 있다. 수업에 연결되지 않은 과제와 `DRAFT` 과제는 어떤 교수도 검토할 수 없다. 세션은 지정한 일정에 속해야 한다(`HRA03`).
- **기간·불변성:** `[valid_from, valid_to)` 반열린 구간. 종료 외의 UPDATE와 모든 DELETE·TRUNCATE를 `guard_academic_faculty_review_period` 트리거가 거부한다(`HRA04`). 시작·종료는 DB 현재 시각 이후만 받고, 함수 밖 직접 UPDATE로 소급 종료하는 것도 거부한다(`HRA07`). 감사 표는 추가만 허용한다.
- **동시 유효 연결 1건:** 교수 단위 → 계정 단위의 고정 순서 advisory lock 뒤 최신 커밋을 재조회해 같은 교수·같은 계정의 기간 중복을 거부한다(`23P01`). READ COMMITTED에서만 성립하므로 다른 격리 수준의 신규 행은 거부한다(`HRA07`). 같은 교수·같은 수업 대상의 지정 기간 중복도 거부한다. 한 수업에 여러 교수를 지정하는 것은 허용한다.
- **자기 연결·자기 지정 금지:** 관리자는 자기 계정을 연결할 수 없고(CHECK와 함수), 지정 기간 중 자기와 연결된 교수를 지정할 수 없다(`HRA01`). 지정 후에 지정자 본인이 그 교수와 연결되더라도 판정 함수가 **지정자 = 연결 계정** 조합을 제외한다.
- **설치 검사:** #165와 같이 재적용 시 컬럼·제약·인덱스·RLS·CHECK 정의를 catalog로 대조하고, 이 파일이 만든 것 외의 사용자 트리거(비활성 포함), 소유자 외 EXECUTE 권한, 판정·목록 함수의 다중 정의가 있으면 전체를 롤백한다.
- **참조 삭제:** 연결·지정 행은 `faculty`·`users`·`schedule_events`·`schedule_sessions`를 `ON DELETE RESTRICT`로 참조한다. 연결·지정 기록이 생긴 교수 프로필·일정·세션은 삭제할 수 없으며, 보존기간 후 파기 절차는 [보존·파기 정책 초안](../ACADEMIC-PRIVACY-RETENTION-POLICY.md)의 별도 승인 함수가 생길 때까지 지원하지 않는다. 기존 관리자 화면은 이 제약 위반을 고정 안내로 바꾼다. 교수 삭제는 "학사 검토 권한 기록이 연결된 교수는 삭제할 수 없습니다.", 일정 삭제는 "검토자 지정이 있는 수업은 삭제할 수 없습니다.", 일정 수정 중 세션 제거는 "검토자 지정이 있는 세션은 삭제할 수 없습니다."를 보여 주고 기록을 보존한다(SQLSTATE `23503`·`23001`과 제약명이 함께 일치할 때만). 기능이 꺼져 있는 동안에는 행이 생기지 않으므로 실제 삭제 동작은 바뀌지 않는다.

SQL 함수(모두 `REVOKE ALL ... FROM PUBLIC`, 앱 DB 소유 역할로 실행):

| 함수 | 역할 | 주요 오류 |
| --- | --- | --- |
| `link_academic_faculty_account` / `end_academic_faculty_account_link` | 관리자의 교수 계정 연결·해제 | `HRA01` 관리자 아님·자기 연결, `HRA03` 교수·대상 없음·`PENDING`, `23P01` 중복 연결 |
| `designate_academic_class_reviewer` / `end_academic_class_reviewer` | 관리자의 수업별 검토자 지정·종료 | `HRA01` 관리자 아님·자기 지정, `HRA03` 교수·일정·세션 없음, `23P01` 중복 지정 |
| `can_review_assignment(user, assignment)` | 과제 검토 권한 판정. **DB `now()`** 기준이며 시각 인자를 받지 않는다 | — |
| `list_reviewable_academic_assignments(user)` | 위 판정이 참인 과제의 메타데이터(ID·기수·일정·세션·제목·상태·마감)만 반환. 지시사항 본문·제출물·학생 정보 없음 | — |

공통으로 `HRA02`는 같은 요청 ID를 다른 입력에 재사용한 경우, `HRA04`는 이미 종료된 행, `HRA07`은 입력 오류다. SECURITY DEFINER는 쓰지 않는다.

## 3. 서버 계약 (`src/features/academics/faculty-review/`)

| 파일 | 책임 |
| --- | --- |
| `contracts.ts` | `zod/v4` 입력 스키마, 고정 오류 코드(`FacultyReviewError`), SQLSTATE → 코드 변환, 행 → DTO(확인 근거·사유 원문 제외) |
| `repository.ts` | 위 SQL 함수 호출만 담당하는 저장소 |
| `service.ts` | Application Service. 주체 확인 → 기능 플래그 → 입력 검증 → 저장소 호출 |

- `canReviewAssignment(principal, assignmentId)`: #162의 **모든 검토·피드백·제출물 열람 경로가 호출해야 하는 중앙 판정**이다. 플래그가 꺼져 있거나 주체가 `PENDING`이면 DB 조회 없이 `false`, DB 장애는 `false`로 숨기지 않고 `UNAVAILABLE` 오류를 던진다.
- `listReviewableAssignments(principal)`: 읽기 전용 메타데이터 목록. 플래그가 꺼져 있으면 `DISABLED`.
- `linkFacultyAccount`·`unlinkFacultyAccount`·`designateReviewer`·`endDesignation`: 학사 운영 관리자 변경. 관리자 여부는 DB가 호출마다 다시 확인한다. 요청 주체는 #165와 같은 `{ userId, role }` 형식이다.
- **#162 구현 시 주의:** 제출물·파일 조회 SQL은 같은 트랜잭션 안에서 `can_review_assignment`를 다시 호출해 판정과 열람 사이의 연결 해제·지정 종료 경합을 막는다. 교수가 담당하지 않은 수업의 과제·파일 요청은 정보 노출을 줄이기 위해 404로 응답한다(정책 초안 P11 표). 피드백의 학생 공개는 학사 운영 관리자가 따로 처리한다(P12).
- **자기 검토 금지(#162 필수):** `can_review_assignment`는 과제 단위 판정이므로 검토자 본인이 그 과제의 대상 학생인 경우를 걸러내지 않는다. #162의 제출물 열람·피드백 경로는 `can_review_assignment`에 더해 **제출물 학생의 로그인 계정(`user_id`)이 검토자 계정과 같으면 열람·피드백을 거부**해야 하며, 같은 트랜잭션의 SQL에서 함께 검사한다.
- **운영 확인:** 학사 운영 관리자는 교수 계정을 연결하기 전에 그 계정이 수강 학적(`cohort_enrollments`)에 연결된 학생 계정이 아닌지 확인한다. #160 연결 화면은 대상 계정에 학적이 연결되어 있으면 경고를 표시하도록 권장한다.

## 4. 남은 위험

- **앱 DB 역할이 표 소유자다.** 소유 역할로 직접 `INSERT`하거나 트리거를 끄면 관리자 인가·자기 연결 금지·감사를 우회할 수 있다. 인가와 감사는 SQL 함수 경로로만 보장되며 G1·#165와 같은 한계다. 역할 분리는 #280 운영 권한 검토에서 다룬다.
- **종료 사유(`end_reason`)에 개인정보를 적지 않는다.** 응답 DTO에도 사유 원문은 내보내지 않는다.
- 연결 대상 계정의 전역 역할은 `PENDING`만 거부한다. 교수 연결은 `FACULTY` 역할을 요구하지 않는데, 연결 자체가 관리자 확인 절차이고 전역 역할을 권한 근거로 쓰지 않기 위해서다. 운영 결정이 달라지면 SQL과 테스트를 함께 바꾼다.
- 계정 삭제는 `users` 참조가 `ON DELETE RESTRICT`라 연결 기록이 있으면 막힌다. 권한 회수는 연결 해제 또는 계정 `PENDING` 전환으로 즉시 이뤄진다.

## 5. 기능 플래그

`ACADEMIC_FACULTY_REVIEW_ENABLED`(기본 `false`)와 `ACADEMIC_ENABLED`가 **모두 정확히 `true`**일 때만 동작한다. 꺼져 있으면 변경·목록은 `DISABLED`, 판정은 항상 `false`이며 학사 표에 접속하지 않는다. 변수 설명은 [환경변수 목록](environment-inventory.md)에 생성된다.

## 6. 검증

```bash
HRA_TEST_PG_BIN=/usr/lib/postgresql/14/bin npx vitest run tests/unit/academic-faculty-reviewers-postgres.test.ts --environment=node --maxWorkers=1
node scripts/check-db-source-inventory.mjs && node scripts/check-db-installation-contract.mjs
node scripts/check-environment-contract.mjs
```

격리 테스트는 SQL 2회 적용·구조 불일치(컬럼·CHECK·추가 인덱스) 롤백·숨긴 트리거·남은 EXECUTE 권한·판정 함수 다중 정의 거부·PUBLIC 실행 권한 없음, 관리자 아닌 `ADMIN`·`FACULTY`·지정 승인자의 연결·지정·종료 거부, 자기 연결·`PENDING`·없는 교수·소급 시작 거부, 교수·계정별 중복 연결 거부와 **동시 연결 경합**(잠금 제거 시 실패함을 확인), REPEATABLE READ·SERIALIZABLE 거부, 연결·지정 없는 `FACULTY`·`ADMIN`·수업 내용 담당 교수의 거부, 연결만 된 교수·다른 수업 지정 교수의 거부, 세션·일정 지정 범위, 초안·수업 미연결 과제 거부, 검토자에게 출결 권한이 생기지 않음, 지정 종료·연결 해제·`PENDING` 전환 즉시 권한 상실과 후임 계정 승계, 예약 시작 전 거부, 자기 지정 거부와 지정자 사후 연결 제외, 행·감사 불변성과 직접 소급 종료 거부, 요청 멱등성, 서비스 플래그·오류 변환·목록 DTO를 확인한다.

## 7. 남은 작업

- [ ] #143 운영 승인(정책 초안 P11·P12)과 운영 DB 적용 절차·백업 확인
- [x] #162 제출물 열람·피드백 작성에서 `can_review_assignment` 사용과 학사 운영 관리자의 피드백 공개 처리([과제 검토·피드백](academic-assignment-reviews.md), 기능 비활성)
- [ ] 연결·지정 관리 화면과 Server Action, 이슈 #161 완료 조건의 역할 조합(ADMIN/교수 A·B/Advisor A·B/MEMBER/PENDING/익명) E2E
