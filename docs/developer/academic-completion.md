# 수료 기준 버전과 수료 확정 이력 (#163, 기능 비활성)

> 상태: **데이터 모델·서버 계약·화면 구현, 격리 PostgreSQL 검증 / 운영 미적용·미활성.** 기준: 2026-11-19.
> 정책 근거는 [학사 운영 정책 초안](../ACADEMIC-OPERATIONS-POLICY.md) P13·P14 권장안과 [보존·파기 정책 초안](../ACADEMIC-PRIVACY-RETENTION-POLICY.md) 2-1절이며, 운영 승인 전에는 `ACADEMIC_COMPLETION_ENABLED`를 켜지 않는다. 이 문서는 정책 승인이나 운영 적용 기록이 아니다.

[#163](https://github.com/Human-Renaissance-Academy/hra-website/issues/163)은 기수별 수료 기준을 버전으로 고정하고, 학사 운영 관리자([#165](academic-staff-assignments.md))가 출결([#159](academic-attendance.md))·과제 제출 보조 지표를 보고 수료를 **직접** 확정·취소·정정한 이력을 남긴다. 시스템은 수료를 자동 판정하지 않는다.

## 1. 규칙 한눈에 보기

| 규칙 | 구현 |
| --- | --- |
| 기준 버전(P13) | 기수별 `version` 1, 2, …. 기수당 초안(`DRAFT`) 1개만 두고 초안만 수정한다. **공개(`PUBLISHED`) 후에는 함수·직접 쓰기 모두 불변**이며 변경은 새 버전 + 사유 |
| 기준 내용 | `minAttendancePercent`(0~100 정수), `countLateAsAttended`·`countExcusedAsAttended`(불리언), `requiredSubmissionCount`(0~1000 정수), `notes`(선택, 1~2000자). DB `academic_completion_criteria_valid` CHECK와 `zod/v4` 스키마가 같은 규칙. 실제 값은 운영 확정 전 임시값 |
| 수료 결정(P14) | `COMPLETED`(수료)·`NOT_COMPLETED`(미수료)·`REVOKED`(수료 취소). 결정이 없으면 **심사 전**. 공개된 같은 기수 기준 버전과 사유(1~500자)가 필수 |
| 자동 수료 없음 | 보조 지표는 명부에 참고로만 표시하고 결정 값을 채우지 않는다 |
| 이력 | 결정 행은 추가만 한다. 같은 학적의 결정은 `decision_sequence` 1, 2, …이며 새 결정이 직전 결정(`supersedes_decision_id`)을 한 번만 대체. 현재 상태 = 가장 큰 순번. 이전 결정자·시각·사유·적용 기준 버전은 그대로 남는다 |
| 상충 방지 | 호출자가 본 현재 순번(`expectedSequence`, 없으면 0)이 다르면 `HRA06`. 학적 단위 잠금 후 재조회해 동시 확정 중 하나만 반영 |
| 취소 | 현재 결정이 `COMPLETED`일 때만 `REVOKED` 가능(`HRA04`) |
| 자기 결정 금지 | 결정자 계정이 그 학적의 학생 계정이면 `HRA01` |
| 권한 | 기준 작성·수정·공개, 결정, 심사 명부는 **유효한 학사 운영 관리자 지정**만. 홈페이지 `ADMIN`·`FACULTY`, 지정 승인자, 어드바이저·조교, 학생, `PENDING` 거부 |
| 학생 열람 | 본인 학적의 현재 상태·확정 시각·기준 버전 번호만. 사유·결정자·보조 지표·다른 학생 기록 비공개 |

## 2. DB 변경 (`scripts/migrate-academic-completion.sql`)

G1 학적·과제·제출, #165 운영 인력, #159 출결 SQL 뒤에 적용하는 **추가형** SQL이다. 선행 객체가 없으면 즉시 롤백한다. 소스 목록에는 `g3-completion`(`versioned_candidate`, 선행 `g1-students`·`g1-assignments`·`g1-submissions`·`g2-staff-assignments`·`g2-attendance`)으로, 설치 대응표에는 `fresh.disposition: unresolved`로 등록했고 `g1Order`·schema export·fresh bundle·운영 manifest에는 편입하지 않았다. 적용은 [데이터베이스 변경 절차](database-change-procedure.md)를 따른다.

| 표 | 내용 |
| --- | --- |
| `completion_criteria_versions` | 기수·버전·기준 내용(jsonb)·상태·변경 사유·작성자와 당시 관리자 지정·공개자/공개 시각. `UNIQUE(cohort_id, version)`, 기수당 초안 1개(부분 유일 인덱스) |
| `completion_decisions` | 학적·기수·적용 기준 버전(복합 외래키로 같은 기수 강제)·순번·대체 대상·결정·사유·**확정 당시 보조 지표 요약(`snapshot`)**·결정자와 당시 관리자 지정·시각 |
| `completion_events` | 기준 작성·수정·공개와 결정의 추가 전용 감사. `request_id` 멱등성, 입력 원문 대신 SHA-256 요약 |

- 기존 `cohorts`·`cohort_enrollments`·`users`는 새 표의 외래키(`ON DELETE RESTRICT`)로만 참조하므로 **수료 기록이 있는 기수·학적·결정자 계정은 삭제할 수 없다.** 계정 탈퇴·기수 삭제 처리 방식은 보존 정책 승인 후 파기 절차에서 정한다.
- 결정은 출결 표를 참조하지 않고 확정 당시 지표 **건수 요약**만 저장한다. 출결 보존기간(1년)이 끝나 승인된 파기 함수가 출결을 지워도 수료 기록과 판정 근거 요약은 남는다.
- 쓰기는 트리거가 이 파일 함수의 트랜잭션 범위 표지(`hra.academic_completion_write`)가 켜진 동안만 허용한다. 공개된 기준·기록된 결정은 표지가 켜져 있어도 바꿀 수 없고 모든 DELETE·TRUNCATE를 거부한다(`HRA04`). [출결](academic-attendance.md) 2-1절과 같은 잔여 위험(표 쓰기 권한이 있는 세션의 표지 설정, 소유 역할의 트리거 비활성화)이 있으며 표 쓰기 권한을 앱 DB 소유 역할 밖으로 주지 않는 것이 전제다.

### 2-1. SQL 함수 (모두 `REVOKE ALL ... FROM PUBLIC`)

| 함수 | 역할 | 주요 오류 |
| --- | --- | --- |
| `create_academic_completion_criteria(request, actor, correlation, cohort, criteria, reason)` | 초안 작성(버전 자동 부여) | `HRA01`, `HRA03` 기수 없음, `HRA04` 초안 있음, `HRA07` |
| `update_academic_completion_criteria(…, criteria_version, criteria, reason)` | 초안 수정 | `HRA04` 공개됨 |
| `publish_academic_completion_criteria(…, criteria_version)` | 초안 공개 | `HRA04` 이미 공개 |
| `record_academic_completion_decision(…, enrollment, criteria_version, decision, reason, expected_sequence)` | 수료 결정 기록 | `HRA01` 관리자 아님·자기 결정, `HRA03` 다른 기수 기준, `HRA04` 초안 기준·취소 불가, `HRA06` 순번 |
| `compute_completion_snapshot(enrollment, criteria_version)` | 보조 지표 계산(인가 없음, 아래 함수 안에서만 호출) | `HRA03` |
| `list_academic_completion_cohorts(actor)`·`list_academic_completion_roster(actor, cohort, criteria_version?)` | 관리자용 기수 목록·심사 명부(기준 버전, 학적별 지표·결정 이력) | `HRA01`·`HRA03` |
| `list_own_academic_completion(actor)` | 학생 본인 수료 상태 | — |

보조 지표: 이 학적이 수업일(KST 하루) 중 유효했고 이미 시작된 같은 기수 CLASS 수업일을 분모로 출석·지각·결석·인정결석·**미입력**을 센다. 미입력은 결석이 아니며, 미입력이 하나라도 있으면 출석률 충족 여부는 `null`(판단 보류)이다. 지각·인정결석 포함 여부는 적용 기준 버전을 따른다. 과제는 이 학적이 대상인 공개 과제 수와 최종 제출 수다. 함수를 교체해도 이전 GRANT가 남을 수 있으므로 적용 끝에 12개 함수의 소유자 외 `EXECUTE` 권한이나 기본 ACL이 있으면 전체를 롤백한다.

## 3. 서버 계약과 화면

| 파일 | 책임 |
| --- | --- |
| `src/features/academics/completion/contracts.ts` | `zod/v4` 입력·DTO 스키마, 고정 오류 코드(`AcademicCompletionError`), 한국어 라벨 |
| `src/features/academics/completion/repository.ts` | 위 SQL 함수 호출만 |
| `src/features/academics/completion/service.ts` | `createCriteriaDraft`·`updateCriteriaDraft`·`publishCriteria`·`recordCompletionDecision`·`listCompletionCohorts`·`getCompletionRoster`·`listOwnCompletion` |
| `src/features/academics/completion/actions.ts` | Server Action(FormData → 서비스 입력, 재검증)만 |
| `src/app/(member)/member/academic-operations/completion/` | 학사 운영 관리자 화면: 기수 선택, 기준 버전 작성·수정·공개, 학적별 보조 지표·결정 이력·결정 폼 |
| `src/app/(member)/member/completion/page.tsx` | 학생 본인 수료 상태 |

- 오류 코드: `FORBIDDEN`(403), `NOT_FOUND`·`DISABLED`(404), `CONFLICT`·`VERSION_CONFLICT`(409), `INVALID_INPUT`(422), `UNAVAILABLE`(503). 관리자 화면은 `DISABLED`·`FORBIDDEN`을 404로 숨긴다.
- 사유 입력란에는 진단명·연락처 등 민감 정보를 적지 않도록 안내한다.

## 4. 기능 플래그

`ACADEMIC_COMPLETION_ENABLED`, `ACADEMIC_STAFF_ENABLED`, `ACADEMIC_ENABLED`(모두 기본 `false`)가 **모두 정확히 `true`**일 때만 동작한다. 꺼져 있으면 모든 메서드가 DB 조회 없이 `DISABLED`이고 두 화면은 404다. 변수 설명은 [환경변수 목록](environment-inventory.md)에 생성된다.

## 5. 보존

보존·파기 정책 초안 2-1절 권장값에 따라 수료 기록(결정·사유·확정자)과 그 기준 버전은 **수료 판정 확정일 후 5년** 보존 대상이다. 이 변경은 기간을 표 주석으로 기록할 뿐 파기 작업·함수를 만들지 않으며, 현재 트리거는 모든 삭제를 막는다.

## 6. 검증

```bash
HRA_TEST_PG_BIN=/usr/lib/postgresql/14/bin npx vitest run tests/unit/academic-completion-postgres.test.ts --environment=node --maxWorkers=1 --testTimeout=180000
node scripts/check-db-source-inventory.mjs && node scripts/check-db-installation-contract.mjs
node scripts/check-environment-contract.mjs
```

격리 테스트는 SQL 2회 적용·구조 불일치(컬럼·CHECK·추가 트리거)·남은 EXECUTE 권한 롤백·PUBLIC 실행 권한 없음, 기준 형식 거부·초안 1개·초안 수정·공개 후 함수/직접 쓰기 불변·새 버전 번호·감사 순서, 관리자 지정 없는 `ADMIN`·`FACULTY`·지정 승인자·어드바이저·학생·`PENDING` 거부, 자기 결정 거부, 초안·다른 기수 기준 거부, 취소 조건, 순번 경합과 대체 이력·당시 기준 버전 유지, 결정·감사 수정·삭제 거부, 참조된 학적·기수 삭제 거부, 동시 확정 중 하나만 반영, 요청 멱등성, 보조 지표(시작된 수업·미입력 보류·지각/인정결석 포함 규칙·제출 수)와 확정 당시 지표 고정, 서비스 플래그·오류 변환·명부·학생 본인 조회를 확인한다.

## 7. 남은 작업

- [ ] #143·#142 운영 승인(실제 수료 기준 값·첫 버전 공개 시점·보존기간)과 운영 DB 적용 절차·백업 확인
- [ ] 평가·교수 피드백(#162) 근거의 명부 연결, 로드맵 §8 E2E 역할 조합과 관측 이벤트(#157), 승인된 보존기간 파기 함수
- [ ] #160 운영 화면과의 진입 링크·Web 주체 변환 통합
