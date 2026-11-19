# 학생별 출결 기록과 정정 승인 (#159, 기능 비활성)

> 상태: **데이터 모델·서버 계약 구현, 격리 PostgreSQL 검증 / 화면 없음 / 운영 미적용·미활성.** 기준: 2026-11-19.
> 정책 근거는 [학사 운영 정책 초안](../ACADEMIC-OPERATIONS-POLICY.md) P5~P10 권장안이며, 그 문서 4절의 운영 승인 전에는 `ACADEMIC_ATTENDANCE_ENABLED`를 켜지 않는다. 이 문서는 정책 승인이나 운영 적용 기록이 아니다.

[#159](https://github.com/Human-Renaissance-Academy/hra-website/issues/159)는 기수별 어드바이저·조교([#165 운영 인력 배정](academic-staff-assignments.md))가 입력하는 학생별 출결을 기존 CLASS 수업일(`schedule_events`)과 G1 학적(`cohort_enrollments`)에 연결한다. 화면·Server Action은 [#160](https://github.com/Human-Renaissance-Academy/hra-website/issues/160)에서 다룬다.

## 1. 규칙 한눈에 보기

| 규칙 | 구현 |
| --- | --- |
| 출결 단위 | 셀 = (CLASS 수업일 `schedule_event_id`, 학적 `enrollment_id`). `UNIQUE(schedule_event_id, enrollment_id)`. 같은 기수의 학적이어야 하고 학적이 수업일(KST 하루) 중 유효했어야 한다 |
| 상태(P5) | `PRESENT`(출석)·`LATE`(지각)·`ABSENT`(결석)·`EXCUSED`(인정결석). **행이 없으면 미입력**이며 결석이 아니다. 서비스 DTO는 미입력을 `UNMARKED`로 표시한다 |
| 수업일 | `schedule_events.event_date`(시간대 없는 UTC 저장값)를 `Asia/Seoul` 날짜로 해석한다(`academic_attendance_class_date`) |
| 7일 입력 창(P6) | **수업일 KST 00:00 이상, 수업일+7일 KST 24:00 미만**(`academic_attendance_window`, `[수업일 00:00, 수업일+8일 00:00)` KST). 판정 시각은 DB `now()`이며 클라이언트 시각을 받지 않는다 |
| 직접 입력 | 창 안에서 요청 시각에 그 기수에 유효하게 배정된 어드바이저·조교 누구나 `PRESENT`·`LATE`·`ABSENT`를 입력·수정(P4·P6) |
| 정정(P7) | 창이 지난 셀의 변경은 사유와 함께 정정 요청 → **요청자와 다른 사람**(같은 기수의 다른 유효 배정자 또는 학사 운영 관리자)이 승인해야 현재 값에 반영. 승인 전에는 기존 값 유지 |
| 인정결석(P8) | `EXCUSED` 지정·해제는 창 안팎과 관계없이 정정 요청으로만 하고 **학사 운영 관리자만** 승인. 증빙 원본은 저장하지 않고 확인 방식(`DOCUMENT_SIGHTED`·`VERIFIED_CONTACT`, 운영 확정 전 임시값)만 기록 |
| 학생 열람(P9) | 로그인 계정에 연결된 본인 학적의, 이미 시작된 CLASS 수업일 출결만. 운영 인력 식별자·정정 사유는 내보내지 않음 |
| 운영 인력 열람(P10) | 배정 기수 수업일의 최소 명단(학적 UUID·표시 이름)과 셀 상태·버전·대기 중 정정만. 배정 종료 즉시 차단 |
| 거부 | 홈페이지 `ADMIN`·교수 `FACULTY` 역할, 학사 운영 관리자 지정만 있는 계정(입력·조회), 다른 기수 배정자, 배정 종료자, `PENDING`·익명 |

## 2. DB 변경 (`scripts/migrate-academic-attendance.sql`)

G1 학적(`scripts/migrate-academic-students.sql`)과 #165 운영 인력 SQL 뒤에 적용하는 **추가형** SQL이다. 선행 객체가 없으면 즉시 롤백한다. 소스 목록에는 `g2-attendance`(`versioned_candidate`, 선행 `g1-students`·`g2-staff-assignments`)로, 설치 대응표에는 `fresh.disposition: unresolved`로 등록했고 G1 `g1Order`·schema export·fresh bundle·운영 manifest에는 편입하지 않았다. 적용은 [데이터베이스 변경 절차](database-change-procedure.md)를 따른다.

기존 `schedule_events`·`cohort_enrollments`에는 컬럼·트리거를 추가하지 않고 새 표의 외래키(`ON DELETE RESTRICT`)로만 참조한다. 그 결과 **출결·정정 기록이 참조하는 수업·학적은 삭제할 수 없다**(23503). 수업 일자·기수가 기록 뒤에 바뀌어도 기존 셀은 기록 당시의 `cohort_id`·`class_date`를 유지하고, 그 셀의 직접 수정·승인은 `HRA04`로 거부한다.

| 표 | 내용 |
| --- | --- |
| `academic_attendance_records` | 셀별 현재 상태·`version`(1부터, 변경마다 +1)·현재 값의 입력자와 당시 배정·반영된 정정·기록 당시 기수/수업일 |
| `academic_attendance_corrections` | 정정 요청(요청 당시 버전 `base_version`·이전/요청 상태·사유·인정결석 확인 방식·요청자와 당시 배정)과 결정(승인/반려·결정자·결정 권한 근거·시각). 셀당 대기 요청 1건(부분 유일 인덱스) |
| `academic_attendance_events` | 입력·정정 요청·승인·반려의 추가 전용 이력. 행위자와 당시 권한 근거(배정 또는 관리자 지정), 전후 상태·버전, `request_id` 멱등성, 입력 원문 대신 SHA-256 요약 |

표 제약으로도 막는 것: 요청자 = 결정자(`academic_attendance_corrections_self_approval_check`), 관리자 근거 없는 인정결석 결정(`…_excused_authority_check`), 정정 없이 `EXCUSED`인 현재 값(`academic_attendance_records_excused_check`), 같은 값으로의 정정, 사유 길이 1~500자.

### 2-1. 동시성과 불변성

- **셀 직렬화:** 입력·정정 요청·결정은 셀 단위 advisory lock 후 최신 커밋을 다시 읽는다(READ COMMITTED만 허용). 호출자는 본 버전(`expectedVersion`, 미입력은 0)을 넘기고 다르면 `HRA06`이다. 두 운영 인력이 같은 셀에 동시에 입력하면 하나만 반영된다.
- **권한 재판정:** 함수 안에서 #165 `can_record_academic_attendance(user, cohort)`(DB `now()` 기준)를 다시 호출하고 배정·계정 행을 `FOR SHARE`로 잡아 판정과 기록 사이의 배정 종료 경합을 막는다.
- **대기 중 정정:** 대기 요청이 있는 셀은 직접 입력하지 않는다(`HRA04`). 승인은 요청 당시 버전이 그대로일 때만 반영한다(`HRA06`).
- **쓰기 경로:** 세 표의 쓰기는 트리거가 이 파일 함수의 트랜잭션 범위 표지(`hra.academic_attendance_write`)가 켜진 동안만 허용한다. 출결은 셀 정보·버전 규칙, 정정은 대기 → 결정 1회만 허용하고 이력은 추가만 한다. 모든 DELETE·TRUNCATE를 거부한다(`HRA04`).
- **잔여 위험:** 앱 DB 소유 역할은 표지를 직접 켜거나 트리거를 끌 수 있다. G1·#165와 같은 수준의 보호이며, 직접 SQL 운영 변경은 [데이터베이스 변경 절차](database-change-procedure.md)의 승인 대상이다.

### 2-2. SQL 함수 (모두 `REVOKE ALL ... FROM PUBLIC`)

| 함수 | 역할 | 주요 오류 |
| --- | --- | --- |
| `record_academic_attendance(request, actor, correlation, event, enrollment, status, expected_version)` | 7일 창 안의 직접 입력·수정 | `HRA01` 배정 없음, `HRA03` 셀 아님, `HRA05` 창 시작 전, `HRA06` 버전, `HRA08` 창 지남·인정결석 |
| `request_academic_attendance_correction(…, requested_status, expected_version, reason, excuse_method)` | 정정·인정결석 요청 | `HRA04` 대기 요청 있음, `HRA07` 창 안 일반 변경·입력 오류 |
| `decide_academic_attendance_correction(request, actor, correlation, correction, 'APPROVE'\|'REJECT')` | 승인·반려 | `HRA01` 자기 결정·권한 없음, `HRA04` 이미 결정 |
| `list_academic_attendance_for_event(actor, event)` | 운영 인력용 수업일 출결표 | `HRA01`·`HRA03` |
| `list_own_academic_attendance(actor)` | 학생 본인 출결 | — |

공통으로 `HRA02`는 같은 요청 ID를 다른 입력에 재사용한 경우다. SECURITY DEFINER는 쓰지 않는다.

## 3. 서버 계약 (`src/features/academics/attendance/`)

| 파일 | 책임 |
| --- | --- |
| `contracts.ts` | `zod/v4` 입력 스키마, 고정 오류 코드(`AcademicAttendanceError`), SQLSTATE → 코드 변환, 결과 → DTO(내부 배정 ID 제외, 미입력 `UNMARKED`) |
| `repository.ts` | 위 SQL 함수 호출만 담당 |
| `service.ts` | `recordAttendance`·`requestCorrection`·`decideCorrection`·`listForCohortSession`(운영 인력 전용)·`listOwn`(학생 본인 전용) |

- 주체(`{ userId, role }`)는 호출자(향후 Server Action·`/api/v1` 어댑터)가 실제 세션·모바일 토큰에서 확정해 넘긴다. `PENDING`·형식 오류 주체는 DB 전에 거부한다.
- 오류 코드: `FORBIDDEN`(403), `NOT_FOUND`·`DISABLED`(404), `CONFLICT`·`VERSION_CONFLICT`·`OUTSIDE_WINDOW`·`CORRECTION_REQUIRED`(409), `INVALID_INPUT`(422), `UNAVAILABLE`(503).

## 4. 기능 플래그

`ACADEMIC_ATTENDANCE_ENABLED`, `ACADEMIC_STAFF_ENABLED`, `ACADEMIC_ENABLED`(모두 기본 `false`)가 **모두 정확히 `true`**일 때만 동작한다. 꺼져 있으면 모든 메서드가 DB 조회 없이 `DISABLED`다. 변수 설명은 [환경변수 목록](environment-inventory.md)에 생성된다.

## 5. 보존

[보존·파기 정책 초안](../ACADEMIC-PRIVACY-RETENTION-POLICY.md) 2-1절 권장값에 따라 개별 출결·정정 요청/승인(사유 원문 포함)·인정결석 확인 기록은 **수료 판정 확정일 후 1년** 보존 대상이다. 이 변경은 기간을 기록할 뿐 **파기 작업·함수를 만들지 않으며**, 현재 트리거는 모든 삭제를 막는다. 수료 결과는 출결 표를 참조하지 않으므로 이후 승인된 파기 함수가 출결을 지워도 수료 기록(#163)은 남길 수 있다.

## 6. 검증

```bash
HRA_TEST_PG_BIN=/usr/lib/postgresql/14/bin npx vitest run tests/unit/academic-attendance-postgres.test.ts --environment=node --maxWorkers=1 --testTimeout=120000
node scripts/check-db-source-inventory.mjs && node scripts/check-db-installation-contract.mjs
node scripts/check-environment-contract.mjs
```

격리 테스트는 SQL 2회 적용·구조 불일치(컬럼·CHECK·추가 트리거) 롤백·PUBLIC 실행 권한 없음, KST 수업일 해석과 창 경계(직전·시작·마지막 순간·종료), 수업 7일 뒤 허용·8일째 정정 필요·수업 전 거부, `ADMIN`·`FACULTY`·관리자·지정 승인자·다른 기수 배정자·`PENDING`·학생 거부, CLASS 아닌 일정·다른 기수 학적·수업 뒤 등록 학적 거부, 배정 종료 후 거부와 과거 입력자·당시 배정 보존, 참조된 수업 삭제 거부, 동시 입력 버전 충돌, 정정 요청·자기 승인 거부·다른 배정자/관리자 승인, 인정결석의 관리자 전용 승인·직접 변경 거부·반려, 함수 밖 쓰기·이력 변경 거부, 표 제약의 자기 승인 거부, 요청 멱등성, 서비스 플래그·오류 변환·출결표·학생 본인 조회를 확인한다.

## 7. 남은 작업

- [ ] #143 운영 승인(정책 초안 4절: 지각 기준, 인정결석 사유·확인 방식, 관리자 부재 시 대체 승인자 등)과 운영 DB 적용 절차·백업 확인
- [ ] #160 운영 화면·Server Action, 학생 본인 조회 화면
- [ ] 로드맵 §8의 E2E 역할 조합과 관측 이벤트(#157) 연결, 승인된 보존기간 파기 함수
