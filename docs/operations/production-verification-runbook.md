# 운영 읽기 전용 확인 절차 (운영자 실행용)

이 문서는 열린 운영 이슈를 닫는 데 필요한 **실제 운영 증거**를 운영자가 직접 모으는 방법입니다. 저장소 작업자·에이전트는 운영 자격정보를 갖지 않으며 운영 DB·Blob·Vercel에 접속하지 않습니다. 운영자가 아래 명령을 자신의 자격정보로 실행하고, **정해진 형식의 결과만** 이슈 검토에 붙여 넣습니다.

관련 이슈: [#280](https://github.com/Human-Renaissance-Academy/hra-website/issues/280) · [#279](https://github.com/Human-Renaissance-Academy/hra-website/issues/279) · [#268](https://github.com/Human-Renaissance-Academy/hra-website/issues/268) · [#267](https://github.com/Human-Renaissance-Academy/hra-website/issues/267) · [#507](https://github.com/Human-Renaissance-Academy/hra-website/issues/507) · [#178](https://github.com/Human-Renaissance-Academy/hra-website/issues/178) · [#287](https://github.com/Human-Renaissance-Academy/hra-website/issues/287) · [#413](https://github.com/Human-Renaissance-Academy/hra-website/issues/413) · [#494](https://github.com/Human-Renaissance-Academy/hra-website/issues/494)

## 0. 공통 규칙

### 무엇을 실행하는가

| 도구                                                  | 접속 대상                        | 쓰기                                                             | 출력                                               |
| ----------------------------------------------------- | -------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------- |
| `scripts/ops/prod-db-readonly-report.mjs`             | `DATABASE_URL`의 PostgreSQL      | 없음. 첫 문장 `BEGIN ... READ ONLY`, 마지막 문장 항상 `ROLLBACK` | 집계 숫자·불리언·고정 코드·저장소 상수 이름의 JSON |
| `scripts/ops/vercel-env-scope-report.mjs`             | 없음(stdin JSON만 읽음)          | 없음                                                             | 환경변수 이름·적용 대상·판정 코드 JSON             |
| `scripts/ops/blob-protected-prefix-report.mjs`        | 공개 Blob 저장소의 `list`만 호출 | 없음                                                             | 보호 접두사별 개수·바이트 JSON                     |
| `scripts/migrate-protected-resource-blobs.mjs` (기존) | DB 조회                          | **인자 없이 실행할 때만** 없음                                   | 공개/비공개/확인 필요 참조 개수                    |
| `npm run verify:production-smoke` (기존)              | 공개 운영 주소 GET 6회           | 없음                                                             | 경로별 상태·고정 코드 JSON                         |

`prod-db-readonly-report`의 안전 경계:

- 트랜잭션을 `READ ONLY`로 열고 DB에서 `transaction_read_only=on`을 다시 확인한 뒤에만 집계합니다. 확인하지 못하면 종료 코드 4로 끝납니다.
- 접속 역할이 쓰기 가능(슈퍼유저·DB/스키마 CREATE·public 테이블 쓰기 권한 등)이면 **기본 거부**(종료 코드 3, `WRITE_CAPABLE_ROLE`)합니다. Neon 기본 소유자 역할은 쓰기 가능하므로 대부분 이 결과가 먼저 나옵니다. 아래 두 방법 중 하나를 선택합니다.
  1. 권장: Neon에 SELECT 전용 로그인 역할을 따로 만들어 그 URL을 사용합니다. 역할 생성은 운영 DB의 권한 변경이므로 운영자가 직접 판단·승인합니다. 예: `CREATE ROLE hra_ops_ro LOGIN PASSWORD '...'; GRANT CONNECT ON DATABASE <db> TO hra_ops_ro; GRANT USAGE ON SCHEMA public TO hra_ops_ro; GRANT SELECT ON ALL TABLES IN SCHEMA public TO hra_ops_ro;`
  2. 소유자 역할 URL을 그대로 쓰려면 `--allow-rw-role`을 붙입니다. 역할 검사만 통과시키며 **트랜잭션은 여전히 READ ONLY**입니다. 결과의 `readOnly.roleCanWrite=true`가 그대로 기록됩니다.
- 문장별 제한은 `statement_timeout=15s`, `lock_timeout=2s`입니다. 세션 수준 설정은 바꾸지 않습니다(연결 풀 오염 방지).
- 출력 직전 검사에서 이메일·URL·호스트처럼 허용 형식 밖의 문자열이 있으면 출력 자체를 막고 `REDACTION_BLOCKED`로 끝납니다. DB 오류는 SQLSTATE 코드만 남깁니다.
- `.env`를 읽지 않습니다. 접속 정보는 환경변수 `DATABASE_URL` 하나로만 받습니다.

### 비밀값 다루기

- DB URL·토큰을 명령줄에 직접 쓰지 않습니다. 저장소 밖의 권한 600 파일에 두고 `$(cat 파일)`로 넘깁니다. 예: `~/.config/hra/prod-ro.url`.
- Claude Code 대화창에서 실행하려면 맨 앞에 `! `를 붙입니다(운영자 셸에서 실행되고 출력이 대화에 남습니다). 명령 문자열은 대화에 남으므로 비밀값 자체가 아니라 파일 경로만 포함해야 합니다. 직접 터미널에서 실행하고 결과 JSON만 붙여 넣어도 됩니다.
- 붙여 넣는 결과에는 이메일·이름·실제 호스트·파일 URL·토큰·DB URL이 없어야 합니다. 이 문서의 도구 출력은 그 조건을 만족하도록 만들어졌지만, 기존 도구나 수동 확인 결과는 붙이기 전에 직접 확인합니다.

### 준비

```bash
git switch main && git pull --ff-only
npm ci
node --test scripts/tests/ops-readonly-report.test.mjs   # 도구 자체의 안전 성질(합성 mock) 확인
```

### DB 보고서 한 번 실행 (여러 이슈 공통)

```bash
! DATABASE_URL="$(cat ~/.config/hra/prod-ro.url)" node scripts/ops/prod-db-readonly-report.mjs > /tmp/hra-db-report.json; echo "exit=$?"; cat /tmp/hra-db-report.json
```

소유자 역할을 쓰는 경우에만 끝에 `--allow-rw-role`을 붙입니다. 필요한 환경변수 이름: `DATABASE_URL`.

**출력 형태**

```json
{
  "schemaVersion": 1,
  "tool": "prod-db-readonly-report",
  "generatedAt": "2026-11-19T00:00:00.000Z",
  "readOnly": { "transaction": true, "roleCanWrite": false, "allowRwRole": false },
  "status": "OK",
  "code": "OK",
  "server": { "versionNum": 170000, "inRecovery": false },
  "sections": {
    "emailIdentity": {
      "issue": "#507",
      "status": "OK",
      "data": { "total_users": 0, "collision_groups": 0 }
    },
    "mobileSessions": { "issue": "#494", "status": "SKIPPED", "code": "RELATION_MISSING" }
  },
  "repo": { "manifestState": "unset" }
}
```

| 종료 코드·`code`                   | 의미                                       | 다음 행동                                                     |
| ---------------------------------- | ------------------------------------------ | ------------------------------------------------------------- |
| 0 / `OK`                           | 모든 섹션 성공 또는 테이블 없음으로 생략   | 결과 전체를 붙여 넣기                                         |
| 0 / `PARTIAL`                      | 일부 섹션에서 SQL 오류(`SQLSTATE_xxxxx`)   | 결과와 함께 어떤 섹션이 실패했는지 알림. 재실행으로 덮지 않음 |
| 2 / `USAGE`·`DATABASE_URL_INVALID` | 인자·URL 형식 오류(접속 전)                | 명령 확인                                                     |
| 3 / `WRITE_CAPABLE_ROLE`           | 쓰기 가능 역할 거부(집계 0건)              | 위 두 방법 중 선택                                            |
| 4 / `READ_ONLY_NOT_CONFIRMED`      | DB가 읽기 전용 트랜잭션을 확인해 주지 않음 | 중단하고 보고. 플래그로 우회할 수 없음                        |
| 1 / `CONNECT_FAILED` 등            | 접속·기타 실패(원문 미출력)                | 대상·네트워크 확인 후 재실행 여부 판단                        |

**붙여 넣을 것:** JSON 전체(개인정보 없음). `sections.*.status`가 `SKIPPED`이면 해당 테이블이 운영 DB에 **없다는 사실 자체**가 중요한 증거입니다.

---

## 1. #280 운영 DB catalog·백업·복구 증거

**목적:** 운영 DB에 저장소가 기대하는 객체(테이블·제약·함수·인덱스·트리거·enum)가 실제로 있는지, 적용 이력(ledger)이 있는지 관측해 기존 DB baseline의 출발점을 만듭니다. 또한 백업에서 복원한 DB가 운영과 같은 구조인지 비교해 "복구 검증"의 최소 증거를 남깁니다.

**선행 조건:** 운영 Neon 프로젝트의 콘솔 접근 권한, 읽기 전용 URL(또는 `--allow-rw-role` 결정), 실행 시점의 운영 배포 SHA 기록.

**명령:** 위 "DB 보고서 한 번 실행". 기대 객체 목록은 `scripts/db/installation-contract.json`의 신규 설치 필수 객체(`requiredForFresh=true`)를 그대로 사용합니다(별도 목록을 만들지 않음).

**관련 출력:**

- `sections.catalog.data.objects[]`: 객체 묶음별 `expected`/`present`/`missing`(저장소 상수 이름).
- `sections.catalog.data.catalogDigest`: 이름과 정의 md5로 만든 sha256 지문. 같은 구조의 DB면 같은 값입니다. 정의 원문은 출력하지 않습니다.
- `sections.migrationLedger`: `hra_migrations` 스키마·Drizzle 이력 테이블 존재 여부. `repo.manifestState`는 저장소 manifest 상태(현재 `unset`).

**백업·복구 증거(수동):**

1. Neon 콘솔에서 운영 브랜치의 복원 가능 기간(history retention/PITR)을 확인하고 값만 기록합니다.
2. 운영 데이터를 바꾸지 않는 방식으로 **과거 시점의 새 브랜치**를 만듭니다(운영자 판단·승인 필요. 운영 브랜치를 덮어쓰는 restore는 사용하지 않음).
3. 그 브랜치의 URL로 같은 DB 보고서를 실행해 `catalogDigest`와 주요 집계를 운영 결과와 비교합니다.
4. 확인 후 임시 브랜치를 삭제하고 삭제 사실을 기록합니다.

**판정:**

- 통과: 운영 보고서가 `OK`이고 `missing`이 왜 비어 있지 않은지(아직 적용 안 한 #507/#287 인덱스 등) 모두 설명 가능하며, 복원 브랜치의 `catalogDigest`가 같은 시점 운영과 일치합니다.
- 실패·추가 조치: 설명할 수 없는 `missing`, `PARTIAL`, 복원 브랜치 생성 불가 또는 지문 불일치.

**붙여 넣을 것:** 운영·복원 브랜치 보고서 JSON, 복원 가능 기간 값, 복원 시점(분 단위), 임시 브랜치 삭제 여부. 프로젝트 ID·호스트·URL은 붙이지 않습니다.

**해제하는 결정:** 기존 DB baseline의 기준 지문 확정, versioned manifest의 첫 항목 설계, "복구 검증 완료" 표시 여부(#280 완료 조건), #287·#507 인덱스 적용 일정.

## 2. #279 Preview와 Production 데이터 분리

**목적:** Production 비밀값(DB·Auth·Kakao·Blob·Cron)이 Preview/Development와 **같은 값으로 공유되지 않음**을 설정 이름·적용 대상만으로 확인하고, 실제 Preview 응답이 거부 계약을 지키는지 확인합니다.

**선행 조건:** Vercel 프로젝트 읽기 권한이 있는 토큰(운영자 셸의 `VERCEL_TOKEN`), 프로젝트 이름, 팀 범위(`teamId`)가 있으면 그 값.

**명령:**

```bash
! curl -fsS -H "Authorization: Bearer $(cat ~/.config/hra/vercel.token)" "https://api.vercel.com/v10/projects/<프로젝트 이름>/env?teamId=<팀 ID>" | node scripts/ops/vercel-env-scope-report.mjs
```

- `decrypt=true`를 붙이지 않습니다. 스크립트는 입력의 `value` 계열 필드를 읽지 않고 버리지만, 복호화된 값이 파이프를 지나가지 않게 합니다.
- 스크립트는 네트워크·환경변수에 접근하지 않습니다. 필요한 환경변수 이름: 없음(토큰은 curl에만 사용).

**출력 형태:** `{ ok, code: "SCOPE_OK"|"SCOPE_FAIL", counts, findings: [{ key, code, severity }], variables: { 이름: { secret, known, production, preview, development, entries, branchScoped, types } } }`

**판정:**

| 코드                           | 심각도 | 의미                                                                                   |
| ------------------------------ | ------ | -------------------------------------------------------------------------------------- |
| `SHARED_SECRET_ACROSS_TARGETS` | 실패   | 하나의 비밀값 항목이 production과 preview/development를 함께 대상으로 함(같은 값 노출) |
| `NONPROD_SECRET_PRESENT`       | 검토   | 비운영 전용 항목이 있음. 격리 테스트 자원인지 운영자가 확인                            |
| `SECRET_NOT_ENCRYPTED`         | 검토   | 비밀값이 plain 유형                                                                    |
| `UNKNOWN_KEY`                  | 검토   | 저장소 [환경변수 계약](../developer/environment-inventory.md)에 없는 이름              |

비밀값 판정 기준은 `scripts/_lib/environment-inventory.mjs`의 `secret` 메타데이터입니다. 이름만 같은 별도 항목은 값을 비교하지 않으므로 "격리됨"을 증명하지 않습니다.

**Preview 응답 확인(수동):** 보호된 Preview 배포에 계정 권한으로 접근해 다음을 확인합니다. 응답 본문은 붙이지 않습니다.

- [ ] `/robots.txt` 200·전체 차단, `/sitemap.xml` 200·URL 0개
- [ ] `/`와 `/api/health`가 [환경 전략](../developer/environment-strategy.md)의 Preview 거부 계약대로 503(`no-store`, `noindex`)이고 홈 500이 아님
- [ ] 로그인 쿠키가 발급되지 않음

**붙여 넣을 것:** 스크립트 JSON 전체(이름·대상만 포함), Preview 확인 체크 결과와 배포 SHA 앞 7자리. Preview URL·토큰은 붙이지 않습니다.

**해제하는 결정:** #279 "자격증명 오등록 탐지 체크리스트" 항목, Preview 유지/중단 결정, Preview 홈 500 처리 방식.

## 3. #268 보호 자료 Private Blob 전환 상태

**목적:** 보호 자료의 DB 참조가 모두 비공개 저장소를 가리키고, 공개 저장소에 보호 접두사 객체가 남아 있지 않은지 개수로 확인합니다.

**선행 조건:** 운영 DB 읽기 URL, 운영 `RESOURCE_PRIVATE_BLOB_HOST` 값, 공개 저장소 토큰(`BLOB_READ_WRITE_TOKEN`).

**명령:**

```bash
# 1) DB 보고서의 protectedBlobRefs.* 섹션(종류별 공개/비공개/기타 개수)을 확인
# 2) 기존 이전 도구의 기본 dry-run(인자 없음 = 조회만). --apply/--delete-public 은 절대 붙이지 않음
! DATABASE_URL="$(cat ~/.config/hra/prod-ro.url)" RESOURCE_PRIVATE_BLOB_HOST="$(cat ~/.config/hra/private-blob.host)" node scripts/migrate-protected-resource-blobs.mjs
# 3) 공개 저장소의 보호 접두사 잔존 개수
! BLOB_READ_WRITE_TOKEN="$(cat ~/.config/hra/public-blob.token)" node scripts/ops/blob-protected-prefix-report.mjs
```

필요한 환경변수 이름: `DATABASE_URL`, `RESOURCE_PRIVATE_BLOB_HOST`, `BLOB_READ_WRITE_TOKEN`.

**출력 형태:**

- DB 보고서 `protectedBlobRefs.<종류>`: `total`, `public_blob`, `private_blob`, `unparseable`, `distinct_public_hosts`, `distinct_private_hosts`(호스트 값은 출력하지 않음).
- 기존 dry-run: `보호 자료 참조: 공개 N개, 비공개 N개, 확인 필요 N개` 한 줄과 완료 문구.
- 접두사 보고서: `{ ok, code, total, truncated, prefixes: { "class-materials/": { objects, bytes }, ... } }`.

**판정:** 통과는 모든 종류의 `public_blob=0`, `unparseable=0`, `distinct_private_hosts`가 1 이하, 기존 dry-run의 공개·확인 필요 0, 접두사 보고서 `NO_PUBLIC_PROTECTED_OBJECTS`입니다. 하나라도 0이 아니면 이전 대상이 남은 것이며 [#268](https://github.com/Human-Renaissance-Academy/hra-website/issues/268) 절차(`--apply` → 검증 → `--delete-public`)를 별도 승인 후 진행합니다. `TRUNCATED`는 조회 상한(접두사당 50페이지)에 걸린 것이므로 개수를 확정하지 않습니다.

**권한별 다운로드 확인(수동, 합성·승인된 계정만):**

- [ ] 익명: `/api/resources/<종류>/<id>/download` 거부(로그인 유도 또는 401/403)
- [ ] PENDING 계정: 거부
- [ ] 승인된 MEMBER/FACULTY 계정: 대상 권한이 있는 자료만 내려받기 성공
- [ ] 비공개 객체의 직접 주소를 브라우저 비로그인 창에서 열면 거부

**붙여 넣을 것:** 세 출력의 숫자·코드, 수동 확인 체크 결과. 자료 ID·파일명·URL·계정 이메일은 붙이지 않습니다.

**해제하는 결정:** 공개 원본 잔존 0 확정 또는 이전 실행 승인, "익명/권한 없음 거부" 완료 조건 체크.

## 4. #267 · #507 · #178 OAuth 로그인·계정 연결·이메일 정규화

**목적:** 실제 제공자(Google·Kakao)와 Credentials의 정상 로그인, 기존 바인딩 보존, 이메일 대소문자 충돌 여부를 운영에서 확인합니다.

**선행 조건:** 각 제공자의 운영 콘솔 접근 권한, 승인된 테스트 계정(실제 회원 계정 사용 금지), 운영 DB 읽기 URL.

### 4.1 DB 계수 (#507)

DB 보고서의 다음 섹션을 확인합니다.

| 섹션·필드                                                                            | 기대                             | 0이 아니면                                                                           |
| ------------------------------------------------------------------------------------ | -------------------------------- | ------------------------------------------------------------------------------------ |
| `emailIdentity.collision_groups` / `collision_rows`                                  | 0                                | `lower(btrim(email))` 충돌. UNIQUE 적용 불가. 자동 병합하지 않고 수동 처리 계획 수립 |
| `emailIdentity.collision_groups_with_admin`                                          | 0                                | 관리자 비밀번호 로그인이 거부될 수 있는 상태                                         |
| `emailIdentity.exact_duplicate_groups`                                               | 0                                | 기존 exact UNIQUE가 없거나 무효라는 신호                                             |
| `untrimmed`·`empty`·`non_ascii`·`non_lowercase`                                      | 기록만                           | 정규화 정책 결정 입력                                                                |
| `placeholder_unbound`·`placeholder_binding_mismatch`                                 | 0                                | 임시 주소와 OAuth 바인딩 불일치                                                      |
| `emailIdentityIndex.present`·`usable`·`expression_matches`                           | 적용 전 false, 적용 후 모두 true | 적용 후 false면 인덱스 정의 재검토                                                   |
| `emailIdentityIndex.exact_email_unique`·`oauth_binding_unique`·`oauth_binding_check` | true                             | 기존 보호 제약 누락                                                                  |
| `oauthProviders`                                                                     | `google`·`kakao`·`none` 개수     | Google 활성 여부 판단 입력                                                           |

### 4.2 수동 로그인 체크리스트

운영 배포 SHA를 먼저 기록합니다. 각 항목은 성공/실패와 화면에 보인 오류 코드만 기록합니다.

- [ ] `/api/auth/providers`가 의도한 제공자만 반환(현재 의도: Kakao·Credentials. Google을 켤 계획이면 콘솔·환경변수 준비 후 재확인)
- [ ] Credentials: 승인된 관리자 테스트 계정 로그인 성공, 잘못된 비밀번호는 거부
- [ ] Credentials: 대소문자만 다른 이메일 입력(예: 첫 글자 대문자)으로 같은 계정 로그인이 되는지 결과 기록(#507 정책 입력)
- [ ] Kakao 신규 테스트 계정: 가입 후 `PENDING` 상태, 임시 주소는 마이페이지에서 연락처로 표시되지 않음
- [ ] Kakao 기존 바인딩 테스트 계정: 재로그인 시 같은 계정으로 들어감(새 계정 생성 없음)
- [ ] Google(활성화한 경우만): 신규 가입 `PENDING`, 재로그인 같은 계정
- [ ] 이메일만 같은 다른 제공자 계정으로 로그인해도 기존 계정에 **자동 연결되지 않음**
- [ ] 로그아웃 후 보호 페이지 접근이 로그인으로 돌아감

### 4.3 Kakao 이메일 동의 (#178)

[카카오 이메일 동의](kakao-email-consent.md) 절차를 따릅니다. 4.1의 충돌 0과 #507 보안 검토가 끝나기 전에는 `AUTH_KAKAO_EMAIL_SCOPE=true`를 켜지 않습니다.

- [ ] 콘솔에서 `account_email`·`profile_nickname`·`profile_image` 동의 항목 사용 가능 여부(가능/불가만 기록)
- [ ] 켠 경우: 기존 바인딩 테스트 계정 재로그인 후 임시 주소가 실제 주소로 바뀌고 마이페이지에 표시됨
- [ ] 동의 거부·이메일 미제공 계정의 로그인 유지
- [ ] 다른 계정과 같은 이메일이면 갱신하지 않고 로그인 유지
- [ ] 갱신 후 DB 보고서 재실행: `placeholder_rows` 감소, `collision_groups` 0 유지

필요한 환경변수 이름: `DATABASE_URL`(DB 계수만). 로그인 확인은 브라우저로 합니다.

**붙여 넣을 것:** DB 보고서의 `emailIdentity`·`emailIdentityIndex`·`oauthProviders`·`usersByRole` 섹션, 체크리스트 결과와 배포 SHA. 계정 이메일·이름·제공자 ID·스크린샷은 붙이지 않습니다.

**해제하는 결정:** #267 "제공자별 정상 로그인" 체크, #507 UNIQUE 적용 가능 여부(충돌 0일 때 #280 절차로 `scripts/migrate-507-email-identity-unique.sql` 적용 검토), #178 이메일 범위 활성화.

## 5. #287 인덱스 적용 판단 (#280 이후)

**목적:** 예약 ID 인덱스와 FK 후보 인덱스가 운영에 필요한지, 이미 있는지 판단할 근거를 모읍니다. **적용 자체는 #280의 대상·백업·복구·승인 절차가 끝난 뒤** 별도로 합니다.

**선행 조건:** 1절의 #280 보고서. 같은 DB 보고서를 사용합니다.

**관련 출력:**

- `rateLimitReservationIndex`: `present`, `usable`, `definition_matches`(`scripts/migrate-287-rate-limit-reservation-index.sql`의 정의와 정확히 일치), `other_leading_indexes`.
- `foreignKeyCandidates[]`: 후보(table, column)별 `estimated_rows`(통계 추정, -1은 통계 없음), `seq_scan`, `idx_scan`, `writes`, `total_bytes`, `leading_index`.
- `rateLimit.<테이블>.rows`·`total_bytes`.

**판정:** 예약 인덱스가 `present=false`이고 `rate_limit_events` 행이 적으면 급하지 않습니다. `present=true`인데 `definition_matches=false` 또는 `other_leading_indexes>0`이면 SQL이 의도적으로 실패하므로 정의를 먼저 검토합니다. FK 후보는 행 수가 작고 `seq_scan`이 문제되지 않으면 추가하지 않는 것이 기본입니다(작은 표의 순차 스캔은 실패가 아님).

**붙여 넣을 것:** 위 섹션 JSON. **해제하는 결정:** #287 인덱스별 적용/보류와 적용 순서.

## 6. #413 Search Console

**목적:** 운영 도메인의 Search Console 소유 확인과 sitemap 제출 상태를 기록합니다. 저장소 도구로 확인할 수 없는 외부 계정 항목입니다.

**선행 조건:** Search Console 계정 접근 권한.

**명령(공개 응답 재확인):**

```bash
! npm run verify:production-smoke -- --sha "$(git rev-parse HEAD)" --sha-kind main --output /tmp/hra-smoke.json; cat /tmp/hra-smoke.json
```

**수동 체크리스트:**

- [ ] 운영 도메인 속성의 소유 확인 상태(확인됨/아님)와 확인 방식(DNS·HTML 태그 등 이름만)
- [ ] `/sitemap.xml` 제출 여부, 마지막 읽기 상태(성공/오류)와 발견 URL 수
- [ ] 색인 생성 보고서의 오류 유형 이름과 개수(예: "noindex로 제외됨" 수)
- [ ] Preview 주소가 색인되어 있지 않음(검색 결과 확인)

**판정:** 소유 확인·sitemap 성공·Preview 미색인이면 통과. smoke JSON은 `ok` 및 robots/sitemap 경로 200이어야 합니다.

**붙여 넣을 것:** 체크 결과와 개수, smoke JSON. 계정 이메일·확인 토큰은 붙이지 않습니다. **해제하는 결정:** #413 Search Console 완료 조건 체크.

## 7. #494 Cron 사용 현황과 정리 대상 규모

**목적:** 등록된 요청 제한 정리가 실제로 돌고 있는지, 미등록 학사 업로드·모바일 세션 정리의 대상 규모가 얼마인지 **삭제 없이** 확인합니다.

**선행 조건:** 운영 DB 읽기 URL, Vercel Cron 화면 접근 권한.

**명령:** 같은 DB 보고서. 정리 API를 호출하지 않습니다(`cleanup-rate-limits`·`cleanup-mobile-sessions`는 dry-run이 없어 호출 자체가 삭제입니다).

**관련 출력:**

| 섹션                     | 필드                                                                                                 | 해석                                                                                                       |
| ------------------------ | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `rateLimit.<4개 테이블>` | `rows`, `older_than_48h`, `oldest_age_hours`, `total_bytes`                                          | 일일 정리가 동작하면 `older_than_48h`가 작고 `oldest_age_hours`가 대략 72 이하. 크면 Cron 미실행·실패 의심 |
| `academicUploadCleanup`  | `eligible_total`, `eligible_previously_deleted`, `eligible_previously_claimed`, `authorized_intents` | `cleanup.ts`의 후보 조건을 상한 없이 센 값. 라우트는 호출당 25건만 처리                                    |
| `academicUploadStates`   | 상태별 개수                                                                                          | 학사 업로드 실제 사용 여부 판단                                                                            |
| `mobileSessions`         | `total`, `cleanup_eligible`, `revoked`, `refresh_history_rows`, `cleanup_calls_at_1000`              | 모바일 정리의 첫 실행 규모(호출당 1,000행)                                                                 |

`SKIPPED`/`RELATION_MISSING`이면 해당 기능의 스키마가 운영에 없다는 뜻이며 그 Cron은 등록 대상이 아닙니다.

**수동 체크리스트(Vercel):**

- [ ] Cron 목록에 `/api/cron/cleanup-rate-limits`만 있음
- [ ] 최근 실행 기록의 상태 코드(200/401/500/503)와 마지막 성공 일자
- [ ] Production에 `CRON_SECRET` 이름이 있음(2절 스크립트의 `variables.CRON_SECRET.production`)
- [ ] `ACADEMIC_UPLOAD_CLEANUP_ENABLED`·`ACADEMIC_UPLOAD_CLEANUP_DELETE_ENABLED` 이름의 존재 여부

**판정:** 요청 제한 정리가 정상이고, 학사·모바일 대상이 0이거나 테이블이 없으면 "미등록 유지 또는 코드 제거" 결정을 내릴 수 있습니다. 대상이 있으면 [정리 Cron 운영](cron-jobs.md)의 승인 조건(#142 보존 정책)을 먼저 확인합니다.

**붙여 넣을 것:** 위 섹션 JSON, Cron 체크 결과. **해제하는 결정:** 학사·모바일 Cron 등록/비활성/제거, 요청 제한 정리의 배치 한도 필요성.

---

## 결과를 받은 뒤

검토자는 붙여 넣은 결과에 개인정보·비밀값이 없는지 먼저 확인하고, 이슈 댓글에는 숫자와 판정만 요약합니다. 이 문서의 도구는 운영 DB·Blob·설정을 바꾸지 않으며, 결과가 곧 적용 승인이나 완료 증거가 되지 않습니다. 적용·삭제·설정 변경은 각 이슈와 [DB 변경 절차](../developer/database-change-procedure.md)의 별도 승인으로 진행합니다.

근거 코드: `scripts/ops/prod-db-readonly-report.mjs`, `scripts/ops/vercel-env-scope-report.mjs`, `scripts/ops/blob-protected-prefix-report.mjs`, `scripts/tests/ops-readonly-report.test.mjs`, `scripts/db/installation-contract.json`.
