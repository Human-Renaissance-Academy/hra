# 주차별 텍스트 기수 열람 범위 정책 초안

> **초안(2026-11-19) — 운영 승인 전 기능 비활성.** [#441](https://github.com/Human-Renaissance-Academy/hra-website/issues/441)의 권장안이다. 승인 전에는 현재 열람 범위를 바꾸지 않는다. 권장안에 따른 구현은 기본 비활성 설정 뒤에 두고, 운영 승인 기록 후에 켠다.

## 1. 현재 동작 — 구현 사실 (2026-11-19, `main@a63f717`)

| 경로 | `MEMBER`의 열람 범위 | 근거 |
| --- | --- | --- |
| Web 목록 `/resources/weekly-texts` | **본인 기수만**(`users.cohortId`). 기수 미배정이면 빈 목록 | `src/app/(member)/resources/weekly-texts/page.tsx` |
| Web 상세·인쇄 `/resources/weekly-texts/[id]`, `[id]/print` | 승인 역할이면 기수 무관 | 같은 디렉터리의 `page.tsx` |
| Web 다운로드 `/api/resources/weekly-texts/[id]/download`, `weekly-text-images` | 승인 역할이면 기수 무관 | `src/app/api/resources/[kind]/[id]/download/route.ts` |
| API v1 목록 `/api/v1/resources/weekly-texts` | **기수 무관 전체 목록** | `src/features/weekly-texts/member/service.ts`의 `listWeeklyTextsForMember` |
| API v1 상세·파일 `/api/v1/resources/weekly-texts/[id]`, `[id]/file` | 승인 역할이면 기수 무관 | 같은 서비스 |

`FACULTY`·`ADMIN`은 모든 경로에서 전체 기수를 본다. `PENDING`·비로그인은 거부한다. 상세·다운로드의 기수 무관 열람은 공동 자료 정책 #100(`src/features/resources/access.ts`)을 따른 것이다. 다만 **Web 목록만 기수로 거르고 API v1 목록은 거르지 않아** 같은 사용자가 경로에 따라 다른 범위를 본다.

## 2. 결정 (권장안)

| 역할 | 목록 | 상세·인쇄·이미지·첨부 다운로드 | API v1 목록·상세·파일 |
| --- | --- | --- | --- |
| `MEMBER` | 본인 기수만 | 본인 기수만. 다른 기수는 404 | 본인 기수만. 다른 기수는 404 |
| `MEMBER`(기수 미배정) | 빈 목록 | 404 | 빈 목록 / 404 |
| `FACULTY` | 전체 기수(현행 유지) | 전체 기수 | 전체 기수 |
| `ADMIN` | 전체 기수(현행 유지) | 전체 기수 | 전체 기수 |
| `PENDING`·비로그인 | 거부(현행 유지) | 거부 | 거부 |

- 주차별 텍스트를 #100의 "기수 무관 공동 자료"에서 **기수 제한 자료**로 분류한다. 강의자료·가이드북 등 다른 공동 자료의 범위는 바꾸지 않는다.
- 업로드·수정·삭제 권한은 기존 규칙(AGENTS.md 권한 표)을 유지한다.
- `FACULTY`·`ADMIN`의 전체 열람은 공동 자료 열람에 한한다. 학사 출결·평가 권한을 넓히지 않는다([학사 운영 정책 초안](ACADEMIC-OPERATIONS-POLICY.md)).

**근거:** 최소 권한 원칙. 목록에 나오지 않는 자료가 직접 URL로 열리는 불일치를 없애고, Web과 API v1이 같은 기준을 쓰게 한다. 타 기수 열람이 필요하다는 실제 사례·민원은 확인되지 않았다.

## 3. 필요한 변경 — 승인 전 비활성

1. 주차별 텍스트 서비스에 **기수 인가 함수 하나**를 두고 Web 목록·상세·인쇄·다운로드(`weekly-texts`, `weekly-text-images`)와 API v1 목록·상세·파일이 모두 호출한다. 화면에서 숨기는 것으로 대신하지 않고 DB 조회 조건에서 거른다.
2. 기수 판정은 서버가 DB의 현재 계정 행에서 읽는다. 클라이언트가 보낸 기수 ID를 쓰지 않는다.
3. 새 동작은 기본 비활성 설정 뒤에 둔다. 비활성 상태에서는 1절의 현재 동작을 그대로 유지한다.
4. 회귀 테스트: 같은 기수·다른 기수·기수 미배정 `MEMBER`, `FACULTY`, `ADMIN`, `PENDING`, 비로그인 × 목록·상세·인쇄·이미지·첨부·API v1 Bearer.
5. 승인 후 설정을 켜고 AGENTS.md 권한 표에 열람 범위 열을 추가한다.

## 4. 운영 승인이 필요한 항목

- [ ] 주차별 텍스트를 기수 제한 자료로 분류하는 데 동의하는지(반대 선택지: 기수 간 공유를 승인하고 Web 목록 필터를 UX 개인화로 문서화)
- [ ] 기수 판정 기준을 현재 `users.cohortId`로 둘지, 학사 학적(`cohort_enrollments`)이 운영되면 그쪽으로 옮길지
- [ ] 수료 후 이전 기수 회원이 자기 기수 자료를 계속 볼 수 있는지
- [ ] `FACULTY` 전체 기수 열람이 필요한지, 담당 기수로 좁힐지
