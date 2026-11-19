# 텍스트·발표자료 분리 제출 DB 변경 절차

과제 제출을 **텍스트**와 **발표자료** 두 항목으로 나누어 받기 위한 DB 구조를 설치하거나 검토할 때 읽는다. 이 문서는 [#516](https://github.com/Human-Renaissance-Academy/hra-website/issues/516) 설계의 PR-C(DB migration) 범위다. 정책은 #516 설계 댓글(2026-11-19)과 [개인 과제 제출 범위](../ASSIGNMENT-SUBMISSION-SCOPE.md)에 추가되는 #516 정책 초안(PR-A)의 권장 결정을 따른다.

> **기능 비활성.** 이 변경은 저장소에 SQL·신규 설치 후보·목록·시험만 추가한다. 앱은 계속 기존 PDF 단일 제출(v1) 함수만 호출하며, 새 V2 함수와 화면 연결은 후속 PR(D~H)에서 한다. 운영 DB 적용은 [#280](https://github.com/Human-Renaissance-Academy/hra-website/issues/280) migration gate와 #142 보존 정책 승인 뒤 별도로 승인한다.

## 적용 순서와 전제

`scripts/migrate-academic-submission-artifacts.sql`은 G1 범위 SQL 9개(`academicG1Migrations`의 앞 9개)를 모두 적용한 뒤 마지막으로 실행한다. 공통 절차는 [DB 변경 절차](database-change-procedure.md)를 따른다.

1. 백업과 별도 DB 복원을 확인한다. `npm run db:push`는 사용하지 않는다(비활성).
2. `psql -X -v ON_ERROR_STOP=1 -f scripts/migrate-academic-submission-artifacts.sql`로 실행한다. 파일 전체가 한 트랜잭션이며 `lock_timeout 5s`, `statement_timeout 60s`, advisory lock을 사용한다.
3. 격리 PostgreSQL 검증: `HRA_TEST_PG_BIN=<PostgreSQL bin> npx vitest run tests/unit/academic-submission-artifacts-postgres.test.ts --maxWorkers=1`.

이 SQL을 적용한 뒤에는 앞선 G1 범위 SQL(`migrate-academic-submissions.sql`, `migrate-academic-upload-authorizations.sql` 등)을 다시 실행하지 않는다. 그 파일들은 자신이 만든 v1 구조와 정확히 같은지 대조하므로 v2 구조에서는 불일치로 실패하고 전체 롤백된다. `migrate-academic-submission-finalization.sql`만은 구조 대조가 없어 다시 실행하면 v1 최종화 wrapper의 V2 거부 분기가 사라진다. 그래도 아래 트리거가 V2 과제의 LEGACY 제출을 막지만, 재실행했다면 이 SQL을 다시 적용한다.

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

`SUB06`·`SUB07`의 HTTP 응답 대응은 서비스 연결(PR-D)에서 정한다. 동시 최종화는 대상 행 잠금으로 직렬화되어 하나만 성공하고 나머지는 `SUB01`이다. 취소(`cancel_academic_assignment_upload`)와 정리 선점(`claim_academic_upload_cleanup`)은 저장 키 기준으로 동작하므로 V2 의도에도 그대로 쓴다.

## Drizzle 모델과 신규 설치

신규 설치는 Drizzle export(v1 구조) → G1 범위 SQL(v1 구조 대조) → 이 SQL 순서다. Drizzle 표 정의에 새 컬럼을 먼저 선언하면 export가 v2 구조를 만들어 G1 SQL의 v1 대조가 실패한다. 그래서 새 컬럼·enum의 정본은 이 SQL이며, `src/lib/db/academic-submission-artifacts.ts`는 enum 값과 상한을 TypeScript 상수로만 미러링한다(`schema.ts`에서 재수출하지 않음). export 소유로 옮길지는 후속에서 결정한다.

신규 설치 후보 `scripts/db/candidates/db-fresh/g1-submission-artifacts.sql`은 원문에서 최외곽 `BEGIN`/`COMMIT`과 `statement_timeout` 행만 뺀 사본이다. 원문·후보 해시와 선행 관계는 `scripts/db/source-inventory.json`, 객체 대응은 `scripts/db/installation-contract.json`이 소유한다. `freshReady`·`productionReady`는 계속 `false`다.

## PR-D(서비스·리포지토리 V2) 연결 전 해결할 항목

이 SQL만으로는 V2를 켤 수 없다. 앱이 V2 함수를 호출하기 전에 다음을 함께 바꿔야 한다.

- `src/lib/db/academic-submissions.ts`의 `uploadIntentId`는 `.notNull()`이지만 DB에서는 V2 행에 NULL이다. TypeScript 타입이 실제와 다르며, `upload_intent_id`로 업로드 의도를 inner join하는 조회는 V2 제출을 결과에서 조용히 빠뜨릴 수 있다. 조회를 파일 저장 키 기준으로 바꾸거나 형식별로 분기한다.
- 과제 생성·수정 함수 `mutate_academic_assignment`의 CREATE/UPDATE_DRAFT payload에 `submission_format`·`text_requirement`·`slides_requirement` 키가 없다. 지금은 관리자 화면에서 V2 과제를 만들 수 없고 DB 기본값 LEGACY로만 생성된다(PR-E와 함께 확장).
- 다운로드 저장 키 정규식(`src/features/academics/submission-files/service.ts`)과 정리 작업의 경로 비교(`src/features/academics/assignment-uploads/cleanup.ts`의 `academicUploadPath`)는 `academic-uploads/v1/{id}/document.pdf`만 허용한다. `academic-uploads/v2/{id}/original`도 지원해야 V2 파일을 내려받거나 미사용 객체를 정리할 수 있다.
- v1 최종화 wrapper가 V2 과제에서 내는 `SUB01`은 현재 앱 매핑상 일반 충돌(409)로 보인다. 사용자에게 "새 제출 경로를 사용해야 함"을 구분해 안내하려면 메시지 또는 별도 코드로 매핑한다. 새 `SUB06`·`SUB07`의 HTTP 대응도 추가한다.
- 같은 멱등 키를 다른 대상에 동시에 쓰면 두 트랜잭션이 서로 다른 대상 행을 잠가 직렬화되지 않으므로, 나중 쪽은 `SUB01`이 아니라 `assignment_submissions_key_unique`의 `23505`로 실패할 수 있다. 앱은 이를 충돌로 매핑하되(현재 `23505`→`CONFLICT`) V2 경로에서도 같은 매핑을 유지한다.

## 남은 위험과 미확인

- 최종화 시 최대 2×50MiB 원본 재검증이 Function `maxDuration` 안에 끝나는지와 대상당 외부 작업 한도는 PR-D에서 측정한다.
- 실제 운영 DB의 잠금 시간·데이터 규모에서 적용 시간을 측정하지 않았다. 컬럼 추가는 재작성이 없지만 새 CHECK·FK·UNIQUE 검증은 기존 행을 읽는다.
- 로컬 PostgreSQL 14 격리 시험으로 확인했다. CI의 PostgreSQL 버전 결과는 PR CI에서 확인하며, 실제 Neon 운영 대상에서는 실행하지 않았다.
