# 텍스트·발표자료 분리 제출 DB 변경 절차

과제 제출을 **텍스트**와 **발표자료** 두 항목으로 나누어 받기 위한 DB 구조를 설치하거나 검토할 때 읽는다. 이 문서는 [#516](https://github.com/Human-Renaissance-Academy/hra-website/issues/516) 설계의 PR-C(DB migration) 범위다. 정책은 #516 설계 댓글(2026-11-19)과 [개인 과제 제출 범위](../ASSIGNMENT-SUBMISSION-SCOPE.md)에 추가되는 #516 정책 초안(PR-A)의 권장 결정을 따른다.

> **기능 비활성.** PR-C는 저장소에 SQL·신규 설치 후보·목록·시험만 추가했다. PR-D가 서비스·리포지토리를 V2 함수에 연결했지만 `ACADEMIC_SUBMISSION_ARTIFACTS_ENABLED`(기본 `false`)가 켜지기 전에는 앱이 기존 PDF 단일 제출(v1) 함수만 호출한다. 화면·API v1 연결은 후속 PR(E~H)에서 한다. 운영 DB 적용은 [#280](https://github.com/Human-Renaissance-Academy/hra-website/issues/280) migration gate와 #142 보존 정책 승인 뒤 별도로 승인한다.

## 적용 순서와 전제

`scripts/migrate-academic-submission-artifacts.sql`은 G1 범위 SQL 9개(`academicG1Migrations`의 앞 9개)를 모두 적용한 뒤 마지막으로 실행한다. 공통 절차는 [DB 변경 절차](database-change-procedure.md)를 따른다.

1. 백업과 별도 DB 복원을 확인한다. `npm run db:push`는 사용하지 않는다(비활성).
2. `psql -X -v ON_ERROR_STOP=1 -f scripts/migrate-academic-submission-artifacts.sql`로 실행한다. 파일 전체가 한 트랜잭션이며 `lock_timeout 5s`, `statement_timeout 60s`, advisory lock을 사용한다.
3. 격리 PostgreSQL 검증: `HRA_TEST_PG_BIN=<PostgreSQL bin> npx vitest run tests/unit/academic-submission-artifacts-postgres.test.ts --maxWorkers=1`.

이 SQL을 적용한 뒤에는 앞선 G1 범위 SQL(`migrate-academic-submissions.sql`, `migrate-academic-upload-authorizations.sql` 등)을 다시 실행하지 않는다. 그 파일들은 자신이 만든 v1 구조와 정확히 같은지 대조하므로 v2 구조에서는 불일치로 실패하고 전체 롤백된다. `migrate-academic-submission-finalization.sql`만은 구조 대조가 없어 다시 실행하면 v1 최종화 wrapper의 V2 거부 분기가 사라진다. 그래도 아래 트리거가 V2 과제의 LEGACY 제출을 막지만, 재실행했다면 이 SQL을 다시 적용한다. `migrate-academic-assignment-actions.sql`을 다시 실행해도 과제 변경 함수가 v1 정의로 돌아가 제출 형식 키를 `HRA07`로 거부한다(실패 폐쇄). 이때도 이 SQL을 다시 적용한다. 반대로 이 SQL은 과제 변경 함수(`migrate-academic-assignment-actions.sql`)가 먼저 적용되어 있지 않으면 롤백한다.

## 적용 전 구조 판정

| 현재 DB 상태 | 동작 |
| --- | --- |
| 새 enum·컬럼이 하나도 없음 (G1 v1 구조) | 교체할 v1 CHECK 3개·제출당 단일 파일 UNIQUE·활성 의도 인덱스가 원문 정의와 같을 때만 구조를 바꾼다. 다르면 자동 보정하지 않고 롤백한다. |
| 이미 이 SQL의 v2 구조 | DDL을 건너뛰고 함수만 `CREATE OR REPLACE`한다. 같은 SQL을 두 번 실행해도 함수·제약·인덱스 지문이 바뀌지 않는다. |
| 새 객체가 일부만 있거나 정의가 다름 | 적용 후 전체 구조 대조(enum, 5개 표의 컬럼·기본값·제약·인덱스)에서 실패하고 전체 롤백한다. |

구조 대조는 트랜잭션 안의 임시 비교 스키마(`hra_artifacts_v1_expected`, `hra_artifacts_expected`)로 수행하고 끝나면 삭제한다. 같은 이름의 스키마가 이미 있으면 실패한다. 운영 자료를 복사하지 않는다.

## 추가되는 구조

| 대상 | 변경 |
| --- | --- |
| enum | `assignment_submission_format`(`LEGACY_SINGLE_PDF`·`ARTIFACTS_V2`), `assignment_artifact_requirement`(`REQUIRED`·`OPTIONAL`·`DISABLED`), `assignment_artifact_type`(`LEGACY_PDF`·`TEXT`·`SLIDES`), `assignment_file_format`(`PDF`·`HWP`·`HWPX`·`PPT`·`PPTX`) |
| `assignments` | `submission_format`(기본 `LEGACY_SINGLE_PDF`), `text_requirement`·`slides_requirement`. LEGACY면 두 요구가 NULL, V2면 둘 다 지정하고 둘 다 `DISABLED`일 수 없다. |
| `assignment_upload_intents` | `artifact_type`(기본 `LEGACY_PDF`)·`file_format`(기본 `PDF`). 유형×형식, 형식×정규 MIME CHECK. V2 저장 키는 `academic-uploads/v2/{의도 ID}/original`만 허용한다. |
| `academic_upload_authorizations` | 같은 두 컬럼. 파일명 확장자는 형식과 같아야 하고, 복합 FK로 의도와 유형·형식이 일치한다. 활성 의도 UNIQUE는 `(target_id, artifact_type)`(`academic_upload_authorizations_active_artifact_idx`). |
| `assignment_submissions` | `submission_format`(기본 LEGACY). LEGACY는 `upload_intent_id` 필수, V2는 NULL이다(V2 의도는 파일 저장 키로 연결). |
| `assignment_submission_files` | `artifact_type`·`file_format`. 제출당 단일 파일 UNIQUE를 `(submission_id, artifact_type)`로 넓힌다. 형식×MIME CHECK. 파일별 1~52,428,800바이트(50MiB)는 그대로다. |

형식별 정규 MIME은 형식 탐지 모듈(`src/features/academics/assignment-uploads/formats/types.ts`)과 같다: PDF `application/pdf`, HWP `application/x-hwp`, HWPX `application/hwp+zip`, PPT `application/vnd.ms-powerpoint`, PPTX `application/vnd.openxmlformats-officedocument.presentationml.presentation`.

### 기존 행 보존

새 컬럼은 상수 기본값을 가진 `ADD COLUMN`이라 PostgreSQL이 행을 다시 쓰지 않고 카탈로그 기본값으로 LEGACY 값을 보여 준다. 기존 행을 UPDATE하거나 텍스트·발표자료로 재분류하지 않는다. 격리 시험은 적용 전후 기존 행의 값·`xmin`·체크섬이 같은지 확인한다. 기본값은 유지한다. 기존 v1 작성 경로(과제 생성 함수, v1 업로드 함수, 시험 fixture)가 형식을 지정하지 않아도 LEGACY로 기록되게 하기 위해서다. V2 행은 V2 함수가 항상 명시적으로 기록한다.

### 공개 후 변경과 DRAFT 전환

기존 과제 guard 트리거는 공개 뒤 `status`·`updated_at` 외의 모든 컬럼 변경을 거부한다. 따라서 제출 형식과 필수·선택·미사용은 `DRAFT`에서만 바꿀 수 있고, `PUBLISHED`·`CLOSED` 과제는 LEGACY로 남는다(정책 4·5).

## 트리거와 함수

이 SQL은 기존 트리거가 호출하는 함수 본문만 바꾼다. 그래서 적용 후 5개 표의 보호 트리거 9개가 기대한 함수·지연 설정으로 존재하고 활성(`tgenabled='O'`)인지 확인하며, 하나라도 빠졌거나 비활성이면 전체 롤백한다. V2 제출 행은 단일 의도를 참조하지 않아 INSERT guard가 의도 만료를 볼 수 없으므로, 지연 완결성 검사가 직접 DML로 만료된 의도를 소비하는 경우를 거부한다.

| 함수 | 변경 |
| --- | --- |
| `guard_academic_upload_intent` | 의도 생성 시 LEGACY 과제에는 `LEGACY_PDF`만, V2 과제에는 미사용이 아닌 `TEXT`/`SLIDES`만 허용한다. 유형·형식은 불변이다. |
| `guard_academic_final_submission` | 최종 제출 형식이 과제 형식과 같아야 한다. LEGACY는 기존처럼 검증된 단일 의도를 요구한다. |
| `assert_academic_submission_complete` (지연) | LEGACY는 기존 단일 파일 검사에 유형 일치를 더한다. V2는 파일 1~2개, 유형별 1개, 필수 충족·미사용 없음, 합계 104,857,600바이트(100MiB) 이하, 각 파일이 같은 대상·계정의 소비된 의도(확정 제출 시각보다 늦게 만료)와 검증된 발급 원장(ETag 있음, 취소·정리 아님)에 대응해야 커밋된다. |
| v1 `issue_…`·`verify_authorized_…`·`finalize_…` | V2 과제·의도에서 `upload_conflict`로 거부한다. LEGACY 동작은 같다. |
| v1 `complete_academic_assignment_submission` | V2 과제에서 `SUB01`로 거부한다. 반환 DTO와 기존 오류 코드는 같다. |
| `mutate_academic_assignment` (PR-D) | CREATE/UPDATE_DRAFT payload에 `submissionFormat`·`textRequirement`·`slidesRequirement`를 **세 개 함께 보낼 때만** 받는다. LEGACY는 두 요구가 JSON `null`, V2는 둘 다 지정하고 둘 다 `DISABLED`일 수 없으며 위반은 `HRA07`이다. 키가 없으면 기존 payload·감사 요약·동작과 같고, 키 없는 UPDATE_DRAFT는 기존 형식을 유지한다. 공개 후 수정은 기존처럼 `HRA04`다. |

### V2 전용 진입점

세 함수 모두 `SECURITY INVOKER`, `search_path=pg_catalog,public`이며 `PUBLIC` 실행 권한을 회수한다. 잠금 순서는 G1과 같은 대상 → 계정 → 학생/학적 → 과제 → 업로드 의도 → 발급 원장이다.

- `issue_academic_assignment_upload_v2(request, target, actor, artifact_type, file_format, name, size)`: 유형×형식, 확장자, 파일별 50MiB를 확인한다. 미사용 항목은 `upload_invalid_file`, 형식이 다른 과제·같은 (대상, 유형)의 활성 의도·이미 제출한 과제는 `upload_conflict`다. 같은 요청 ID 재시도는 같은 의도를 돌려준다.
- `verify_authorized_academic_upload_v2(intent, actor, checksum, etag)`: 서버가 비공개 Blob의 실제 형식·크기·SHA-256을 검증한 뒤 호출한다. MIME은 형식별 정규값만 기록한다.
- `complete_academic_assignment_submission_v2(target, actor, intent_ids uuid[], submission_key, finalize)`: 의도 1~2개를 한 트랜잭션에서 확정한다(정책 3). 같은 멱등 키와 같은 의도 묶음(순서 무관)은 마감 뒤에도 기존 결과를 반환하고, 같은 키의 다른 묶음은 `SUB01`이다. 반환 JSON에는 저장 키·체크섬·계정 ID가 없다.

| SQLSTATE | 의미 |
| --- | --- |
| `SUB01` | 이미 제출함·다른 묶음에 쓴 키·취소/정리된 업로드·LEGACY 과제 |
| `SUB02` | 요청 형식 오류, 다른 대상·계정의 의도 포함, 현재 권한 없음 |
| `SUB03` / `SUB04` / `SUB05` | 의도 만료 / 서버 검증 전 / 마감 경과 (v1과 같음) |
| `SUB06` (신규) | 필수 누락, 미사용 항목 첨부, 0개 제출(두 항목 모두 선택이어도 최소 1개, 정책 2), 같은 항목 중복 |
| `SUB07` (신규) | 제출 합계 100MiB 초과. 파일별 50MiB·최대 2개라 정상 경로에서는 도달하지 않는 방어 상한이다. |

`SUB06`·`SUB07`의 HTTP 응답 대응은 아래 PR-D 절의 오류 대응을 따른다. 동시 최종화는 대상 행 잠금으로 직렬화되어 하나만 성공하고 나머지는 `SUB01`이다. 취소(`cancel_academic_assignment_upload`)와 정리 선점(`claim_academic_upload_cleanup`)은 저장 키 기준으로 동작하므로 V2 의도에도 그대로 쓴다.

## Drizzle 모델과 신규 설치

신규 설치는 Drizzle export(v1 구조) → G1 범위 SQL(v1 구조 대조) → 이 SQL 순서다. Drizzle 표 정의에 새 컬럼을 먼저 선언하면 export가 v2 구조를 만들어 G1 SQL의 v1 대조가 실패한다. 그래서 새 컬럼·enum의 정본은 이 SQL이며, `src/lib/db/academic-submission-artifacts.ts`는 enum 값과 상한을 TypeScript 상수로만 미러링한다(`schema.ts`에서 재수출하지 않음). export 소유로 옮길지는 후속에서 결정한다.

신규 설치 후보 `scripts/db/candidates/db-fresh/g1-submission-artifacts.sql`은 원문에서 최외곽 `BEGIN`/`COMMIT`과 `statement_timeout` 행만 뺀 사본이다. 원문·후보 해시와 선행 관계는 `scripts/db/source-inventory.json`, 객체 대응은 `scripts/db/installation-contract.json`이 소유한다. `freshReady`·`productionReady`는 계속 `false`다.

## PR-D(서비스·리포지토리 V2) 연결 결과

PR-C가 남긴 연결 전 항목을 다음과 같이 처리했다. 모든 V2 경로는 `ACADEMIC_ENABLED`·`ACADEMIC_UPLOADS_ENABLED`에 더해 `ACADEMIC_SUBMISSION_ARTIFACTS_ENABLED`가 정확히 `true`일 때만 열린다(기본 `false`, [환경변수 계약](environment-inventory.md)).

| 항목 | 처리 |
| --- | --- |
| Drizzle `uploadIntentId.notNull()` | 신규 설치 export가 v1 구조를 만들어야 하므로 `pgTable` 정의는 바꾸지 않았다. 대신 읽기 타입 `AssignmentSubmission`의 `uploadIntentId`를 `string \| null`로 넓히고 컬럼 주석에 V2 NULL을 적었다. 현재 앱 조회(학생 목록·상세, 제출 현황, 정리, 운영 상태)는 `upload_intent_id`로 업로드 의도를 inner join하지 않으며, 정리·운영 상태 집계는 파일 저장 키 기준 `NOT EXISTS`도 함께 사용해 V2를 빠뜨리지 않는다. |
| 과제 생성·수정 payload | 이 SQL이 `mutate_academic_assignment`를 위 표처럼 확장한다(설치 계약의 `replacement`). 서비스 입력 검증은 같은 규칙을 먼저 검사하고, 기능 gate가 꺼져 있으면 형식 키를 받지 않는다. 관리자 화면 입력은 PR-E다. |
| 다운로드 | 저장 키 정규식이 `academic-uploads/v1/{id}/document.pdf`와 `academic-uploads/v2/{id}/original`을 받는다. MIME은 형식별 정규값만 허용하고 v1 키는 PDF만 허용한다. Blob의 Content-Type은 DB MIME과 같아야 한다. 응답 헤더(`application/octet-stream` 첨부, `sandbox` CSP, `nosniff`, `private, no-store`)는 그대로다. |
| 정리 | 경로 비교가 해당 의도의 v1 또는 v2 정확한 키만 삭제 대상으로 인정한다. |
| 오류 대응 | `SUB06` → `INCOMPLETE`(422), `SUB07` → `TOO_LARGE`(422), 형식 경로가 다른 `SUB01`(DB 고정 문구로 구분) → `WRONG_FORMAT`(409), 그 밖의 `SUB01`과 같은 키·다른 대상의 `23505` → 기존 `CONFLICT`(409). API v1은 새 코드를 기존 공개 코드(`CONFLICT`·`INVALID_INPUT`)로만 대응해 OpenAPI를 바꾸지 않았다. |

### V2 서비스 흐름

1. `createAssignmentArtifactUploadIntent`: (대상, 산출물 유형, 선언 형식)마다 `issue_…_v2`로 의도를 만들고 저장 경로와 형식별 정규 MIME(`contentType`)을 돌려준다. 클라이언트 직접 업로드는 이 MIME으로만 승인된다(SDK 토큰의 `allowedContentTypes`).
2. 토큰 승인(`authorizeAssignmentUploadToken`)은 원장의 산출물 유형을 보고 V2면 기능 gate·v2 저장 키·정규 MIME을 강제한다. v1 의도의 동작은 같다.
3. `verifyAssignmentArtifactUpload`: 비공개 Blob 메타(경로·정규 MIME·크기)를 대조하고 원본 전체(≤50MiB)를 읽어 SHA-256을 계산한 뒤 `validateDeclaredDocument`(확장자·선언 형식·MIME·실제 형식·산출물 허용 목록)를 통과해야 `verify_…_v2`로 기록한다. 거부는 코드 `INVALID_FILE`(422)을 유지하고 사유별 고정 한국어 문구(암호화·매크로·형식 위장·손상 등)로 안내한다.
4. `finalizeAssignmentArtifactSubmission`: 같은 멱등 키 결과를 Blob 요청보다 먼저 복구하고, 새 제출이면 0개·중복을 Blob 읽기 전에 거부한 뒤 원본을 하나씩 다시 검증하고(첫 실패에서 중단) `complete_…_v2`로 한 번에 확정한다.

### 업로드 예산

V2는 대상 예산을 (대상, 산출물 유형)별 4회/60초로 나눈다(scope `academic-upload-intent-artifact`·`academic-upload-artifact-target`). 정상 두 파일 흐름은 파일마다 발급 1회·외부 작업 2회(토큰·검증)라 기존 대상당 4회/60초를 모두 쓰기 때문이다. 대상 전체 상한은 8회/60초가 되고, 사용자 상한(발급·외부 각 6회/60초)은 v1과 같은 scope·값을 공유해 계정 단위 남용 상한을 넓히지 않는다. 최종화 재시도는 파일마다 다시 검증하므로 두 파일 제출은 사용자 외부 작업 6회 안에서 재시도 1회 여유가 있다.

### 실행 시간과 메모리

검증은 형식 탐지를 위해 원본 전체를 메모리에 받는다(SHA-256은 복사와 함께 스트림으로 계산). 메모리 상한을 위해 두 가지를 둔다.

- 한 최종화 요청 안에서는 원본을 **순서대로** 검증해 요청당 원본 버퍼를 50MiB 이하로 둔다.
- 인스턴스(프로세스) 전체의 동시 검증을 **2개**로 제한한다(`withArtifactVerificationSlot`). Fluid compute처럼 한 인스턴스가 여러 요청을 함께 처리해도 원본 버퍼 합계는 약 100MiB를 넘지 않는다. 자리가 없으면 최대 10초 대기하고, 그 안에 자리가 나지 않으면 멈춰 있지 않고 재시도 가능한 `UNAVAILABLE`(503, "잠시 후 다시 시도")을 돌려준다. 같은 멱등 키로 재시도하면 된다.

로컬 측정에서 50MiB PDF의 SHA-256은 약 125ms, 형식 탐지는 약 4ms였다(CPU 기준). 순차 검증이므로 최종화 시간은 두 원본 읽기 시간의 합(파일당 읽기 제한 60초, 메타 조회 15초)과 대기열 시간에 달려 있다. **PR-H에서 실제 비공개 Blob으로 2×50MiB 읽기 시간을 측정해 Function `maxDuration`(120초) 안에 끝나는지 확인해야 한다.** 넘치면 업로드 직후 검증 결과를 재사용하는 방식 등을 별도로 검토한다.

## 남은 위험과 미확인

- 최종화 시 최대 2×50MiB 원본을 실제 비공개 Blob에서 읽는 시간이 Function `maxDuration` 안에 끝나는지는 PR-H(실 저장소 HTTP 검증)에서 측정한다. CPU 비용과 업로드 예산은 위 PR-D 절에 기록했다.
- 실제 운영 DB의 잠금 시간·데이터 규모에서 적용 시간을 측정하지 않았다. 컬럼 추가는 재작성이 없지만 새 CHECK·FK·UNIQUE 검증은 기존 행을 읽는다.
- 로컬 PostgreSQL 14 격리 시험으로 확인했다. CI의 PostgreSQL 버전 결과는 PR CI에서 확인하며, 실제 Neon 운영 대상에서는 실행하지 않았다.
