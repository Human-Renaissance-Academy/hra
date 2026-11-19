# 기수별 운영 인력 배정과 출결 권한 판정 (#165, 기능 비활성)

> 상태: **데이터 모델·서버 계약·권한 서비스 구현, 격리 PostgreSQL 검증 / 화면 없음 / 운영 미적용·미활성.** 기준: 2026-11-19.
> 정책 근거는 [학사 운영 정책 초안](../ACADEMIC-OPERATIONS-POLICY.md) P1~P4·P10 권장안이며, 그 문서의 4절 운영 승인 전에는 `ACADEMIC_STAFF_ENABLED`를 켜지 않는다. 이 문서는 정책 승인이나 운영 적용 기록이 아니다.

[#165](https://github.com/Human-Renaissance-Academy/hra-website/issues/165)의 첫 단계로, 기수별 어드바이저·조교의 기간 배정과 학사 운영 관리자 지정, 그리고 출결 경로가 공통으로 호출할 권한 판정을 추가한다. 출결 기록(#159)과 화면(#160)은 아직 없다.

## 1. 권한 구조 한눈에 보기

| 권한 | 부여 근거 | 부여·종료 주체 | 홈페이지 역할과의 관계 |
| --- | --- | --- | --- |
| 학사 운영 관리자 | `academic_operations_managers`의 유효 기간 행 | G1 지정 승인자(`ACADEMIC_APPROVER_USER_ID`). 자기 지정 금지 | `ADMIN`이어도 지정 없으면 권한 없음 |
| 기수 운영 인력(ADVISOR·ASSISTANT) | `academic_cohort_staff_assignments`의 유효 기간 행 | 유효한 학사 운영 관리자. 자기 배정 금지 | `ADMIN`·`FACULTY`여도 배정 없으면 출결 권한 없음 |
| 출결 기록 | 위 배정이 해당 기수·시각에 유효 + 계정이 `PENDING` 아님 | — | 관리자 지정만으로는 출결 권한 없음 |

- 모든 대상 계정은 기존 로그인 계정이며 `PENDING`이 아니어야 한다. 연결 확인 방식(`IN_PERSON`·`VERIFIED_CONTACT`)과 확인 근거 참조 UUID를 함께 기록하며, 이메일·이름 일치로 자동 연결하지 않는다.
- 학사 운영 관리자와 G1 지정 승인자가 같은 사람인지는 정책 초안 4절의 미정 항목이다. 현재 구현은 자기 지정을 막으므로 두 권한을 한 계정에 줄 수 없다. 운영 결정이 달라지면 SQL과 테스트를 함께 바꾼다.

## 2. DB 변경 (`scripts/migrate-academic-staff-assignments.sql`)

`users`·`cohorts`만 참조하는 **추가형** SQL이다. G1의 `g1Order`에 넣지 않았고, 소스 목록에는 `g2-staff-assignments`(`versioned_candidate`, 선행 없음)로, 설치 대응표에는 `fresh.disposition: unresolved`로 등록했다. schema export·fresh bundle·운영 manifest에는 편입하지 않았다. 적용은 [데이터베이스 변경 절차](database-change-procedure.md)를 따른다.

| 표 | 내용 |
| --- | --- |
| `academic_operations_managers` | 관리자 계정·유효 기간(`valid_from`·`valid_to`)·확인 방식·지정자·종료자/시각/사유 |
| `academic_cohort_staff_assignments` | 기수·계정·역할(`ADVISOR`·`ASSISTANT`)·유효 기간·확인 방식·배정자·교체 대상(`replaces_assignment_id`)·종료자/시각/사유 |
| `academic_staff_events` | 지정·종료·배정·해제·교체의 추가 전용 감사. `request_id`로 재시도 멱등성, 입력 원문 대신 SHA-256 요약만 저장 |

불변조건은 `guard_academic_staff_period` 트리거가 모든 쓰기 경로에서 강제한다.

- **기간 표현:** `[valid_from, valid_to)` 반열린 구간이며 `valid_to`가 없으면 무기한이다.
- **동시 유효 상한:** 같은 기수에서 겹치는 기간의 `ADVISOR`는 1명, `ASSISTANT`는 2명까지다. 새 조교의 기간 안에서 기존 조교 두 명이 동시에 유효한 순간이 하나라도 있으면 거부한다(SQLSTATE `23P01`).
- **같은 계정 중복:** 같은 기수에서 같은 계정의 배정 기간은 역할과 무관하게 겹칠 수 없다(`23P01`).
- **동시성:** `btree_gist` 확장 없이, 신규 행마다 기수 단위 advisory lock을 잡은 뒤 최신 커밋을 다시 조회한다. 이 보장은 READ COMMITTED에서만 성립하므로 다른 격리 수준의 신규 행은 거부한다(`HRA07`). 관리자 지정은 계정 단위 잠금으로 같은 계정의 기간 중복을 막는다.
- **불변성:** 종료(`valid_to`를 앞당기고 종료자·시각·사유를 한 번 기록) 외의 UPDATE, 모든 DELETE·TRUNCATE를 거부한다(`HRA04`). 감사 표는 추가만 허용한다. 보존기간 종료 후 파기는 [보존·파기 정책 초안](../ACADEMIC-PRIVACY-RETENTION-POLICY.md)의 별도 승인 함수가 생길 때까지 지원하지 않는다.
- **소급 금지:** 배정 시작과 종료·교체 시각은 DB 현재 시각 이후만 받는다. 과거 출결의 권한 근거를 사후에 바꾸지 않기 위해서다. 함수 밖 직접 UPDATE로 현재 이전 시각에 종료하는 것도 트리거가 거부한다(`HRA07`).
- **설치 검사:** 재적용 시 이 파일이 만든 것 외의 사용자 트리거(비활성 포함)나 꺼진 보호 트리거, 소유자 외 EXECUTE 권한이 남은 함수가 있으면 전체를 롤백한다. 이전 초안의 시각 인자 판정 함수 `can_record_academic_attendance(uuid, uuid, timestamptz)`는 제거한다.

SQL 함수(모두 `REVOKE ALL ... FROM PUBLIC`, 앱 DB 소유 역할로 실행):

| 함수 | 역할 | 주요 오류 |
| --- | --- | --- |
| `designate_academic_operations_manager` / `end_academic_operations_manager` | 지정 승인자의 관리자 지정·종료 | `HRA01` 승인자 아님·자기 지정, `HRA03` 대상 없음·`PENDING` |
| `assign_academic_cohort_staff` | 관리자의 배정 | `HRA01` 관리자 아님·자기 배정, `HRA03` 기수·대상 없음, `23P01` 상한·중복 |
| `end_academic_cohort_staff` | 관리자의 배정 종료(해제) | `HRA04` 이미 종료 |
| `replace_academic_cohort_staff` | 기존 행 종료 + 같은 기수·역할의 새 행 추가(기존 계획 종료 시각 승계) | 위와 같음 |
| `can_record_academic_attendance(user, cohort)` | 출결 권한 판정. **DB `now()`(트랜잭션 시작 시각) 기준**이며 시각 인자를 받지 않는다 | — |

공통으로 `HRA02`는 같은 요청 ID를 다른 입력에 재사용한 경우, `HRA07`은 입력 오류다. G1과 같이 SECURITY DEFINER는 쓰지 않는다. 앱이 소유 역할로 접속하므로 권한 상승 경로만 늘리기 때문이다.

## 3. 서버 계약 (`src/features/academics/staff/`)

| 파일 | 책임 |
| --- | --- |
| `contracts.ts` | `zod/v4` 입력 스키마, 고정 오류 코드(`AcademicStaffError`), SQLSTATE → 코드 변환, 행 → DTO(확인 근거·사유 원문 제외) |
| `repository.ts` | 위 SQL 함수 호출만 담당하는 저장소 |
| `service.ts` | Application Service. 주체 확인 → 기능 플래그 → 입력 검증 → 저장소 호출 |

- `canRecordAttendance(principal, cohortId)`: #159·#160의 **모든 출결 경로가 호출해야 하는 중앙 판정**이다. 판정 시각은 DB 현재 시각으로 고정되어 배정 종료 즉시 권한이 끝난다(P10). 과거 시점의 배정 이력 조회가 필요하면 권한 판정과 이름이 다른 별도 조회 함수로 만든다. 플래그가 꺼져 있거나 주체가 `PENDING`이면 DB 조회 없이 `false`, DB 장애는 `false`로 숨기지 않고 `UNAVAILABLE` 오류를 던진다.
- `assignCohortStaff`·`endCohortStaffAssignment`·`replaceCohortStaff`: 학사 운영 관리자 변경. 관리자 여부는 DB가 호출마다 다시 확인한다.
- `designateOperationsManager`·`endOperationsManagerDesignation`: 주체가 설정된 지정 승인자와 같을 때만 DB를 호출한다.
- 주체(`{ userId, role }`)는 호출자(향후 Server Action·`/api/v1` 어댑터)가 실제 세션·모바일 토큰에서 확정해 넘긴다. 배정 종료·계정 `PENDING` 전환은 세션에 권한을 저장하지 않으므로 다음 호출부터 즉시 반영된다.
- **#159 구현 시 주의:** 출결 쓰기 SQL은 같은 트랜잭션 안에서 `can_record_academic_attendance`를 다시 호출하고 배정 행을 잠가, 판정과 기록 사이에 배정이 종료되는 경합을 막는다.

## 4. 남은 위험

- **앱 DB 역할이 표 소유자다.** 소유 역할로 직접 `INSERT`하거나 `ALTER TABLE ... DISABLE TRIGGER`를 실행하면 관리자 인가·자기 배정 금지·감사 기록을 우회할 수 있다. 인가와 감사는 **SQL 함수 경로로만 보장**되며 이는 G1과 같은 한계다. 트리거는 함수 밖 쓰기에도 상한·불변성·소급 금지를 적용하지만 인가 주체는 확인하지 않는다. 역할 분리(소유자와 실행 역할 분리)는 #280 운영 권한 검토에서 다룬다.
- **종료 사유(`end_reason`)는 개인정보를 적지 않는다.** 진단명·연락처 같은 민감 정보를 사유에 쓰지 않도록 #160 화면에서 안내하고, 응답 DTO에도 사유 원문은 내보내지 않는다.
- 배정은 READ COMMITTED 트랜잭션에서만 기록한다(REPEATABLE READ·SERIALIZABLE은 `HRA07`로 거부). Neon HTTP와 앱 함수 호출의 기본값이다.

## 5. 기능 플래그

`ACADEMIC_STAFF_ENABLED`(기본 `false`)와 `ACADEMIC_ENABLED`가 **모두 정확히 `true`**일 때만 동작한다. 꺼져 있으면 변경은 `DISABLED`, 판정은 항상 `false`이며 학사 표에 접속하지 않는다. 변수 설명은 [환경변수 목록](environment-inventory.md)에 생성된다.

## 6. 검증

```bash
HRA_TEST_PG_BIN=/usr/lib/postgresql/14/bin npx vitest run tests/unit/academic-staff-assignments-postgres.test.ts
node scripts/check-db-source-inventory.mjs && node scripts/check-db-installation-contract.mjs
node scripts/check-environment-contract.mjs
```

격리 테스트는 SQL 2회 적용·구조 불일치 롤백·PUBLIC 실행 권한 없음, 관리자 지정·종료와 자기 지정 거부, 미지정 `ADMIN`·`FACULTY`의 배정 거부, 자기 배정·`PENDING`·소급 시작 거부, 상한·기간 중복, 두 번째 어드바이저·세 번째 조교의 **동시 배정 경합**(기수 잠금 제거 시 실패함을 확인), 같은 요청 ID 동시 재시도(배정·감사 1건, 한쪽 재생 응답), REPEATABLE READ·SERIALIZABLE 거부, 숨긴 트리거·남은 EXECUTE 권한 거부와 옛 판정 함수 제거, 직접 소급 종료 거부, 다른 기수·미배정 역할의 판정 거부, 배정 종료·`PENDING` 전환 후 권한 상실, 학기 중 교체 경계, 행·감사 불변성, 요청 멱등성, 서비스 플래그·오류 변환을 확인한다.

## 7. 남은 작업

- [ ] #143 운영 승인(정책 초안 4절)과 학사 운영 관리자 실제 지정, 운영 DB 적용 절차·백업 확인
- [ ] #159 출결 모델에서 `canRecordAttendance`·`can_record_academic_attendance` 사용, #160 배정·현황 화면과 Server Action
- [ ] 로드맵 §8의 E2E 역할 조합(어드바이저·조교 × 기수 A/B × 수업일 A/B)과 관측 이벤트 연결
