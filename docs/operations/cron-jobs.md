# 정리 Cron 운영 정책 (#494)

저장소에는 `/api/cron/` 아래에 정리 진입점이 세 개 있지만 `vercel.json`에 등록된 것은 한 개뿐입니다. 이 문서는 각 진입점의 등록 상태, 삭제 대상, 안전 장치, 등록 승인 조건을 한곳에 정리합니다. 개별 기능의 세부 설명은 아래 링크한 문서가 정본이며 이 문서에서 반복하지 않습니다.

> **검토 기준:** 저장소의 `main` 코드와 설정(`vercel.json`, 각 `route.ts`, `cleanup.ts`, `repository.ts`)을 정적으로 읽은 결과입니다. 운영 서비스의 Vercel Cron 대시보드, 실제 환경변수, 운영 데이터 규모, 백업·보존 승인 상태는 **확인하지 않았습니다.** 아래 표의 "등록 여부"는 저장소 설정 기준이며, 실제 호출 여부는 운영자가 해당 환경의 배포와 Cron 실행 기록으로 따로 확인해야 합니다.

## 1. 한눈에 보기

| 항목 | `cleanup-rate-limits` | `cleanup-academic-uploads` | `cleanup-mobile-sessions` |
| --- | --- | --- | --- |
| 코드 | `src/app/api/cron/cleanup-rate-limits/route.ts` | `src/app/api/cron/cleanup-academic-uploads/route.ts`, `src/features/academics/assignment-uploads/cleanup.ts` | `src/app/api/cron/cleanup-mobile-sessions/route.ts`, `src/features/auth/mobile-session/repository.ts` |
| `vercel.json` 등록 | 등록됨 | **미등록(의도적)** | **미등록(의도적)** |
| 스케줄 | `0 3 * * *` = 매일 03:00 UTC = 12:00 KST | 없음 | 없음 (권장안은 매시간, 승인 전) |
| 인증 | `Authorization: Bearer <CRON_SECRET>`, 길이 확인 후 `timingSafeEqual`. 미설정 시 503, 불일치 시 401 | 동일 (미설정 503, 불일치 401) | 동일 (미설정·저장소 장애 503, 불일치 401) |
| 추가 활성화 조건 | 없음 | `ACADEMIC_UPLOAD_CLEANUP_ENABLED=true` 없으면 아무것도 조회하지 않고 `enabled:false`로 응답. 실제 삭제는 `ACADEMIC_UPLOAD_CLEANUP_DELETE_ENABLED=true`가 추가로 필요 | 없음 (호출되면 곧바로 삭제) |
| 삭제 대상 | `rate_limit_events`, `login_attempts`, `upload_rate_limit_log`, `application_submissions_log` 중 48시간보다 오래된 행 | 만료+5분 유예가 지났고, 제출·파일에 연결되지 않은 `CONSUMED` 아닌 업로드 의도의 비공개 Blob | 갱신·절대 만료 또는 회수 시각이 지난 `mobile_sessions` 행과 cascade되는 종속 이력 |
| dry-run | 없음 | 있음 (삭제 플래그가 없으면 기본 dry-run) | **없음** |
| 배치 한도 | **없음** (조건에 맞는 행을 한 번에 삭제, 행 수 제한 없음) | 1~100, 기본 25. 라우트는 값을 넘기지 않으므로 항상 25 | 호출당 최대 1,000행 (`LIMIT` + `FOR UPDATE SKIP LOCKED`) |
| 중복·동시 호출 | 같은 조건의 `DELETE`라 반복·동시 호출해도 결과가 같음 (멱등) | 행마다 `claim_academic_upload_cleanup`으로 선점해 동시 호출이 같은 객체를 중복 삭제하지 않음. 실패·중단된 건은 다음 호출에서 재시도 | `SKIP LOCKED`로 잠긴 행은 건너뜀. 반복 호출은 안전하며 남은 행만 지움 |
| 위험 데이터 | 요청 제한 기록(짧은 보존 전제) | 학사 과제 제출 파일(개인정보·법적 보존 가능성) | 모바일 로그인 세션·이력(복구 불가) |
| 응답 | `{status:"ok"}` | 후보·삭제·실패 건수와 `referenceId` | `{deletedCount}` |
| 로그·경보 | 실패 시 `logServerError("rate-limit/cleanup")`, 응답 500 | `UPLOAD_CLEANUP` 관찰 이벤트([학사 관찰성](../developer/academic-observability.md)) | 모바일 인증 응답 래퍼의 오류 응답만 있음 (전용 경보 없음) |
| 관련 이슈 | #121 | #142, #157, #282, #284 | #273, #280, #491 |
| 상세 문서 | [요청 제한](rate-limits.md) | [학사 과제 업로드](../developer/academic-assignment-uploads.md) | [모바일 인증 경로](../developer/mobile-auth-routes.md), [모바일 세션 이전](../developer/mobile-session-migration.md) |

## 2. 등록된 작업: `cleanup-rate-limits`

- 가장 긴 제한 창(24시간)보다 긴 48시간만 보존합니다. 요청 제한의 의미와 `CRON_SECRET` 등록 절차는 [요청 제한](rate-limits.md) §2를 따릅니다.
- 과거 제한 테이블이 없는 환경에서는 `to_regclass`로 존재를 확인한 뒤 있는 테이블만 정리합니다.
- 삭제는 4개 테이블에 대해 순서대로 실행되며 하나의 트랜잭션으로 묶여 있지 않습니다. 중간에 실패하면 500을 응답하고 다음 날 호출에서 다시 시도합니다.
- 배치 한도가 없으므로 정리가 오래 중단된 뒤 첫 호출은 한 번에 많은 행을 지울 수 있습니다. 현재 행 규모는 확인하지 않았습니다.
- Vercel Cron은 `CRON_SECRET`이 설정되어 있으면 호출에 자동으로 Bearer 헤더를 붙입니다. 같은 작업이 드물게 중복 전달될 수 있으나 위와 같이 멱등이므로 문제가 없습니다. 실제 동작은 [Vercel Cron 문서](https://vercel.com/docs/cron-jobs/manage-cron-jobs)를 기준으로 운영자가 확인합니다.

## 3. 미등록 작업은 의도적으로 등록하지 않았습니다

`cleanup-academic-uploads`와 `cleanup-mobile-sessions`는 코드가 있다는 이유로 일정이 빠진 것이 아닙니다. 삭제 대상이 복구할 수 없는 사용자 데이터이고, 승인 정책과 운영 DB 상태가 아직 확정되지 않아 **승인 전까지 등록하지 않는 것이 현재 결정**입니다. 미등록 자체는 결함이 아닙니다. 아래 조건이 모두 충족되기 전에는 `vercel.json`에 일정을 추가하거나 삭제 플래그를 켜지 않습니다.

### 3.1 학사 업로드 정리 (`cleanup-academic-uploads`)

등록 전 선행 조건:

1. 학사 G1 기능을 운영에서 실제로 사용하는지 확인합니다. 사용하지 않으면 정리할 대상이 없으므로 등록하지 않습니다.
2. #142의 보존·파기·백업 정책이 승인되어야 합니다. 현재 [학사 개인정보 보존·파기 정책 초안](../ACADEMIC-PRIVACY-RETENTION-POLICY.md)은 미정입니다. 이 API는 법적 보존 대상의 파기 수단으로 쓰지 않습니다.
3. 운영 환경의 Blob 저장소·업로드 원장 스키마가 적용되어 있고(#157 및 [DB 변경 절차](../developer/database-change-procedure.md)) 필요한 DB 함수가 있는지 확인합니다.
4. 운영 환경에 `CRON_SECRET`이 설정되어 있는지 확인합니다.

등록 절차:

1. 운영에서 `ACADEMIC_UPLOAD_CLEANUP_ENABLED=true`만 켜고 `ACADEMIC_UPLOAD_CLEANUP_DELETE_ENABLED`는 설정하지 않아 **dry-run**으로 둡니다. 환경변수는 환경별로 독립 설정하며 Preview에 Production 자격정보를 상속하지 않습니다([환경변수 목록](../developer/environment-inventory.md)).
2. 승인된 담당자가 §4의 절차로 직접 한 번 호출해 `candidates`, `failed`를 확인합니다.
3. `candidates`는 **전체 대상 수가 아니라 이번 호출의 상한(25) 이하 값**입니다. 25에 도달하면 대상이 더 있다는 뜻일 뿐입니다. 또한 이미 삭제 처리된 원장 행도 후보에 다시 포함될 수 있으므로 실제 삭제될 Blob 수와 같다고 단정하지 않습니다. 전체 건수가 필요하면 운영 DB에서 읽기 전용 질의로 별도 확인하되, 질의는 대상 DB와 승인을 확인한 뒤 실행합니다.
4. 대상 유형과 민감 데이터 보존 의무가 문제없다는 승인을 받은 뒤에만 `ACADEMIC_UPLOAD_CLEANUP_DELETE_ENABLED=true`를 설정합니다.
5. 처음 실제 삭제도 수동 호출로 시작해 `deleted`, `failed`, 관찰 이벤트를 확인합니다.
6. 주기 실행이 필요하다고 결정되면 별도 PR에서 `vercel.json`에 일정을 추가합니다. 한 호출은 25건까지만 처리하므로 대기열 규모에 맞는 주기를 정하고, 삭제 플래그를 되돌리는 방법(환경변수 제거 후 재배포)을 함께 적습니다.

### 3.2 모바일 세션 정리 (`cleanup-mobile-sessions`)

이 경로는 **dry-run이 없습니다.** 인증된 호출은 즉시 최대 1,000행을 삭제합니다.

등록 전 선행 조건:

1. 모바일 앱의 출시·사용 여부를 결정합니다. 사용하지 않으면 등록하지 않고 코드만 보관할지 제거할지 정합니다.
2. 운영 DB에 `mobile_sessions`와 종속 이력 스키마가 적용되어 있어야 합니다(#273, #280, #491). 현재 운영 적용 여부는 확인하지 않았습니다.
3. 만료·회수 세션과 소비 이력에 별도 감사 보존기간이 필요 없는지 확인합니다. [모바일 세션 이전](../developer/mobile-session-migration.md)은 별도 보존기간을 두지 않는다고 설명하지만 백업의 보존·파기는 운영자가 따로 확인합니다.
4. `CRON_SECRET`이 운영에 설정되어 있어야 합니다.

등록 절차:

1. 코드에 dry-run이 없으므로 먼저 운영 DB에서 만료·회수 조건에 해당하는 행 수를 **읽기 전용 질의**로 확인합니다. 조건은 `refresh_expires_at`·`absolute_expires_at`·`revoked_at`이 현재 시각 이하인 행입니다(`repository.ts`의 `deleteExpiredSessions`).
2. 대상 행 수가 한 번의 1,000행을 크게 넘으면 처음에는 수동 호출을 반복해 남은 수가 줄어드는 것을 확인합니다.
3. 승인 후 별도 PR에서 `vercel.json`에 일정을 추가합니다. 권장 주기는 매시간이지만(위 이전 문서), **Vercel 요금제에 따라 일일 1회를 넘는 Cron이 제한될 수 있습니다.** 허용 여부는 운영 계정에서 확인하지 못했으므로 등록 PR에서 검증합니다.
4. 등록 후 `deletedCount`가 1,000으로 계속 유지되면 대기열이 밀리는 신호이므로 주기·배치를 조정합니다. 현재 전용 경보는 없습니다.

## 4. 수동 호출을 안전하게 하는 방법

수동 호출은 운영 데이터를 바꿀 수 있으므로 승인된 담당자가 대상 환경을 확인한 뒤 실행합니다.

1. 호출할 환경과 도메인을 확인합니다. Preview와 Production은 DB·Blob·`CRON_SECRET`이 다릅니다.
2. `CRON_SECRET`을 셸 기록에 남기지 않습니다. 값을 명령줄 인자에 직접 쓰지 말고, 화면 입력으로 환경변수에 넣은 뒤 사용합니다. 이슈·PR·댓글에는 값과 응답 전문을 붙이지 않습니다.
3. 요청은 `GET`이며 `Authorization: Bearer <CRON_SECRET>` 헤더가 필요합니다.
4. 학사 정리는 반드시 `ACADEMIC_UPLOAD_CLEANUP_DELETE_ENABLED`가 **없는 상태**(dry-run)에서 먼저 호출합니다. 응답의 `dryRun`이 `true`인지 확인합니다.
5. 모바일 정리와 `cleanup-rate-limits`에는 dry-run이 없으므로 호출 자체가 삭제입니다. 승인 전에는 호출하지 않습니다.
6. 응답 코드를 확인합니다. 503은 설정 누락 또는 저장소 장애, 401은 인증 실패, 500은 정리 실패입니다. 실패했다고 반복 호출을 늘리지 말고 원인을 먼저 확인합니다.

## 5. 문서화하지 못한 항목과 열려 있는 결정

다음은 이 문서를 쓰는 시점에 확인하지 못했으며 운영자·소유자의 결정 또는 확인이 필요합니다.

- 운영 Vercel Cron 대시보드의 실제 등록·실행 기록, 요금제별 Cron 제한
- 운영 `CRON_SECRET`의 설정 여부, 학사 정리 두 환경변수의 실제 값
- 운영 DB의 요청 제한 로그·미완료 업로드·만료 모바일 세션의 실제 행 수와 증가 속도
- #142 보존·파기·백업 승인 상태, 학사 G1 기능과 모바일 앱의 운영 사용 여부
- 정리 실패에 대한 외부 경보와 재시도 기준 (현재는 앱 로그와 호출 응답뿐)
- 사용하지 않기로 결정된 라우트를 제거할 경우: 해당 `route.ts`, 관련 테스트, `scripts/_lib/environment-inventory.mjs`의 env 계약과 [환경변수 목록](../developer/environment-inventory.md), 이 문서를 함께 갱신하고 운영에서 해당 경로를 호출하는 실행자가 없는지 먼저 확인합니다.

관련: #142 #157 #273 #280 #282 #284 #491 #494.
