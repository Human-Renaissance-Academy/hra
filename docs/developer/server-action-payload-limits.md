# Server Action 입력 상한과 직접 업로드 현황

관련: #511. 이 문서는 `"use server"` 액션이 받는 입력 크기 상한을 **정적 코드 분석**으로 정리한 기록입니다. 실제 HTTP 요청이나 배포 환경에서 새로 측정한 값은 없습니다. 근거는 소스의 `파일:줄`이며 줄 번호는 작성 시점(`03b5fc6`) 기준이라 코드가 바뀌면 달라질 수 있습니다.

## 현재 구조

- `next.config.ts`의 `experimental.serverActions.bodySizeLimit`은 `5mb`(5,242,880바이트)입니다. Next 공식 문서는 이 값이 `multipart/form-data`의 boundary·파트 헤더·필드 메타데이터를 포함한 **raw HTTP 본문 전체**에 적용된다고 설명합니다(설치된 `node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/serverActions.md`의 `bodySizeLimit` 절).
- 큰 원본(문서·대용량 이미지)은 Server Action을 거치지 않고 브라우저가 Vercel Blob에 직접 올립니다(#102). Action은 업로드 결과 URL·파일명 같은 메타데이터와 텍스트만 받습니다.
- 아래 직접 업로드 상한은 Server Action 본문 상한과 **별개**입니다. 30MiB 문서를 올려도 Action 본문에는 URL 문자열만 실립니다.

### 직접 Blob 업로드 경로

| 용도 | 토큰 발급 경로 | 파일별 상한 | 근거 |
| --- | --- | --- | --- |
| 강의자료 | `/api/resource-uploads` | 50MiB | `src/lib/resource-upload-contract.ts:23` |
| 가이드북 | `/api/resource-uploads` | 30MiB | `src/lib/resource-upload-contract.ts:24` |
| 주차별 텍스트 문서 | `/api/resource-uploads` | 30MiB | `src/lib/resource-upload-contract.ts:25` |
| 주차별 텍스트·갤러리 이미지 | `/api/weekly-text-image-uploads`, `/api/gallery-uploads` | 10MiB | `src/lib/gallery-upload-contract.ts:5` |
| 모집 포스터 | `/api/poster-uploads` | 10MiB | `src/lib/poster-upload-contract.ts:4` |
| 교수진 사진 | `/api/faculty-uploads` | 5MiB | `src/lib/faculty-upload-contract.ts:4` |
| 수료생 사진 | `/api/alumni-uploads` | 5MiB | `src/lib/alumni-upload-contract.ts:4` |
| 에디터 본문 이미지 | `/api/editor-image-uploads` | `maxEditorImageBytes` 상수 | `src/app/api/editor-image-uploads/route.ts:68` |
| 학사 과제 제출 PDF | 학사 업로드 API | 확정 입력 메타 52,428,800바이트 | `src/features/academics/submissions/validation.ts:14` |

## 액션별 입력과 상한

"정상 최대"는 코드에 상한이 있는 필드를 합산한 값입니다. 한글은 UTF-8에서 글자당 최대 3바이트로 계산했고 폼 인코딩 오버헤드는 무시했습니다. 실제 요청으로 측정한 값이 아닙니다. "없음"으로 표시된 필드는 전역 본문 5MiB가 유일한 방어선입니다.

| 액션(파일, `src/features/` 기준) | 입력 | 파일 경유 방식 | 필드 상한 근거 | 5MiB 초과 가능성 |
| --- | --- | --- | --- | --- |
| 교수진 생성·수정 (`faculty/actions/index.ts`) | name, category, 현직·전직, order, 사진 | 직접 업로드 우선. 서버 경유 폴백은 3MiB 초과 거부(`:98`) | 이름 100(`:17`), 현직·전직 각 500(`:22,27`), URL 2,000(`:113`) | 정상 최대 약 3MiB. 없음 |
| 기수 생성·수정 (`recruitment/actions/index.ts`) | name, description, 날짜, isActive, image | **서버 경유** 이미지 4MiB(`:148`) | 이름 100(`:30`), 설명 5,000(`:34`) | 정상 최대 약 4.03MiB. 없음. 4MiB 이미지가 본문 대부분을 쓰므로 상한 축소 시 주의 |
| 모집 설정 (`recruitment-settings/actions/index.ts`) | 포스터 모드·URL, 기수, 상태, 구글폼 URL, 날짜, detailsMarkdown, posterFile | 직접 업로드 우선. 서버 경유 폴백 3MiB 초과 거부(`:108`) | detailsMarkdown 20,000(`:43,383`), 포스터 URL 2,000(`:122`). posterImageUrl·googleFormUrl 길이 상한은 이 분석에서 확인 못함 | 정상 최대 약 3MiB. 없음 |
| 수료생 이야기 (`alumni/actions/index.ts`) | name, title, quote, content, imageUrl, images | 직접 업로드 우선. 서버 경유 폴백은 합계 3MiB 초과 거부(`:93`) | 이름 100, 직함 100, 문구 500, 내용 5,000(`:19-22`), 업로드 URL JSON 100,000자·최대 100개(`:104,111`) | 정상 최대 약 3MiB. 없음 |
| 갤러리 (`gallery/actions/index.ts`) | title, description, alt, uploadedImageUrls | 직접 업로드만. 파일 본문 없음 | 제목 300(`:27`), 설명 5,000(`:28`), alt 255(`:32`), URL 배열 1~100개(`:158`) | 없음. 단 URL 각 문자열 길이 상한은 없음 |
| 주차별 텍스트 (`weekly-texts/actions/index.ts`) | title, cohortId, textType, classDate, body, file, 업로드 URL·파일명, uploadedImageUrls, requestId | 직접 업로드 우선. 서버 경유 `file`은 30MiB 검증(`:68,103`)이지만 본문 5MiB에서 먼저 거부 | 제목 300(`:47`), URL 배열 1~100개(`:201`). **body 길이 없음**(`:52-65`) | 정상 사용은 없음. 격차 1 |
| 수업일지 (`class-logs/actions/index.ts`) | title, content, classDate, cohortId, requestId, images | 관리자 폼에 이미지 입력 없음. 서버 경유 이미지는 파일당 10MiB(`lib/form-data-image-validation.ts:8`), 개수·합계 상한 없음 | 제목 300(`:54`). **content 길이 없음**(`:55`) | 정상 사용은 없음. 격차 1·2 |
| 강의자료 (`class-materials/actions/index.ts`) | title, weekNumber, lectureTitle, audience, classDate, 업로드 URL·파일명 | 직접 업로드만. 서버 경유 `file`이 오면 거부(`:174-176`) | 제목 300(`:23`), 강의명 200(`:28`) | 없음. 업로드 URL·파일명은 `validateResourceUploadReference`가 검증하며 이 분석에서 길이는 확인 못함 |
| 가이드북 (`guidebooks/actions/index.ts`) | title, 업로드 URL·파일명 | 직접 업로드만 | 제목 300(`:39`) | 없음 |
| 공지사항 (`notices/actions/index.ts`) | title, content(마크다운), status, pinned | 파일 없음. 본문 이미지는 에디터가 직접 업로드 | 제목 300(`:14`). **content 길이 없음**(`:15`) | 정상 사용은 없음. 격차 1 |
| 언론보도 (`press/actions/index.ts`) | title, source, url, publishedAt, description, imageUrl | 파일 없음 | 제목 300, 언론사 200, 요약 5,000(`:18-26`). url·imageUrl은 `httpUrl` 형식만 | 없음. 격차 3 |
| FAQ 연락처 (`faq/actions/index.ts`) | contactName, contactPhone, contactRole | 파일 없음 | 100·20·100(`:24-26`) | 없음 |
| FAQ 항목 (같은 파일) | question, answer | 파일 없음 | 질문 500(`:109`). **answer 길이 없음**(`:110`) | 정상 사용은 없음. 격차 1 |
| 보고서 양식·가이드 (`report-templates/actions/index.ts`) | slug, title, category, reportCategory, description, version, body, published, order | 파일 없음 | slug 200, 제목 300, 설명 500, 버전 20, order 0~9999(`:36-61`). **body 길이 없음**(`:63`) | 정상 사용은 없음. 격차 1 |
| 지원서 양식 (`applications/actions/forms.ts`) | title, description, cohortId, isPublished | 파일 없음 | 제목 255(`:17`). **description 길이 없음**(`:18`) | 정상 사용은 없음. 격차 1 |
| 지원서 질문 저장 (`applications/actions/questions.ts`) | formId, questions[], expectedRevision | 파일 없음 | 선택지 값 1,000(`question-validation.ts:11`). **질문 제목·설명 길이, 질문 수, 선택지 수 없음** | 정상 양식은 해당 없음. 격차 4 |
| 지원서 제출 (`applications/actions/submissions.ts`) | formId, 이름·이메일·연락처, 질문별 답변 | 파일 없음 | 이름 100, 이메일 255, 연락처 20, 단문 1,000, 장문 10,000, 선택지 1,000, 체크박스 10,000(`input-limits.ts:7-13`). 질문 수는 DB의 양식 정의가 결정 | 장문 질문 수십 개 수준에서는 해당 없음. 질문 수에 비례 |
| 일정 (`schedule/actions/index.ts`) | eventDate, startTime, endTime, eventType, title, cohortId, weekNumber, description, isPublic, sessionsJson | 파일 없음 | 제목 200(`:39`), 세션 content 500, 분야 50, 부제 300(`:23-25`). **description·subDescription 길이, 세션 수 없음** | 정상 사용은 없음. 격차 5 |
| 학사 명단 (`academics/roster/actions/index.ts`) | requestId, cohortId, studentId, displayName, verificationMethod, evidenceReference | 파일 없음 | displayName 100(`input.ts:13`), 나머지는 UUID·열거값 | 없음 |
| 학사 과제 (`academics/assignments/actions.ts`) | 입력 객체 | 파일 없음 | 제목 200(`validation.ts:23`), 안내 50,000(`:24`), 목록 limit 100·offset 10,000(`:42`) | 없음 |
| 학사 제출 확정 (`academics/submissions/actions.ts`) | assignmentId, uploadIntentId, submissionKey, 파일 메타 | 직접 업로드만. 본문은 식별자와 메타 | 파일명 255, 크기 값 1~52,428,800(`validation.ts:13-14`) | 없음 |
| 학사 수강 연결·학생 새로고침 (`academics/enrollments/actions.ts`, `academics/student-assignments/ui-actions.ts`) | 식별자 | 파일 없음 | 각 서비스의 입력 스키마 | 없음 |
| 회원 그룹 변경·삭제 (`users/actions/index.ts`) | userId, groupValue | 파일 없음 | UUID·그룹 값 검증 | 없음 |
| 관리자 교수진 삭제 폼 (`app/(admin)/admin/faculty/page.tsx:100-106`) | id | 파일 없음 | `typeof` 확인 후 `deleteFaculty`에 전달 | 없음 |

정렬·삭제·토글 계열 액션은 식별자만 받습니다. 정렬 액션(`faq`, `gallery`, `alumni`, `press`의 `reorder*`)은 `z.array(z.uuid()).min(1)`만 검증하고 배열 개수 상한은 없습니다. 정상 사용에서는 목록 크기 이내입니다.

## 5MiB를 넘을 수 있는 정상 요청

이 정적 분석에서는 **찾지 못했습니다.** 서버 경유로 가장 큰 정상 경로는 기수 이미지 4MiB(`recruitment/actions/index.ts:148`)이며, `83084e7`은 실제 폼 요청이 4,210,196바이트였다고 기록했습니다. 교수진·모집 포스터·수료생 이미지는 직접 업로드가 정상 경로이고 서버 경유 폴백은 3MiB 이하만 받습니다. 직접 업로드가 실패해 큰 파일이 서버 경유로 오면 Action 실행 전에 거부되며, 이는 `83084e7`의 BREAKING CHANGE에 적힌 의도된 동작입니다.

## 입력 상한 격차

전역 본문 5MiB가 방어선이므로 즉각적인 문제는 아닙니다. 이 브랜치에서는 로직을 바꾸지 않고 기록만 합니다. 대부분 관리자·승인 회원이 호출하는 액션이며, 각 액션의 인증 순서는 이 분석에서 다시 확인하지 않았습니다.

1. 긴 본문 필드에 문자 수 상한이 없습니다. 공지 `content`, 수업일지 `content`, 주차별 텍스트 `body`, FAQ `answer`, 보고서 양식 `body`, 지원서 양식 `description`입니다. 같은 코드의 제목(300)·갤러리 설명(5,000)·학사 과제 안내(50,000)와 일관되지 않습니다. 이 경우 하나의 필드가 본문 5MiB까지 채울 수 있습니다.
2. 수업일지의 서버 경유 `images`는 파일당 10MiB 상한만 있고 개수·합계 상한이 없습니다(`lib/form-data-image-validation.ts:8-18`). 현재는 본문 5MiB가 실제 상한이지만 `bodySizeLimit`을 올리면 바로 노출됩니다. 주차별 텍스트도 같은 검증 함수를 씁니다.
3. 언론보도 `url`·`imageUrl`은 형식만 검증하고 길이 상한이 없습니다(`press/actions/index.ts:24,27`).
4. 지원서 질문 저장은 질문 수·질문 제목·설명·선택지 수에 상한이 없습니다(`question-validation.ts`).
5. 일정의 `description`, 세션 `subDescription`, 세션 배열 개수에 상한이 없습니다(`schedule/actions/index.ts:23-25,40,44`).

필드별 상한은 사용자 입력 계약을 바꾸므로 운영 데이터의 실제 최대 길이를 조사한 뒤 별도 이슈·테스트로 진행하는 것이 안전합니다. 이 문서는 해당 조사를 하지 않았습니다.

## 플랫폼 413

| 항목 | 상태 |
| --- | --- |
| Vercel Functions 요청·응답 본문 4.5MB 제한([Vercel Functions Limits](https://vercel.com/docs/functions/limitations)) | #511이 인용한 공식 문서의 서술입니다. 이 작업에서 문서를 다시 열어 확인하지 않았습니다. `docs/developer/academic-assignment-uploads.md:23`도 같은 전제입니다. |
| `bodySizeLimit`이 raw 본문(multipart 오버헤드 포함)에 적용([serverActions](https://nextjs.org/docs/app/api-reference/config/next-config-js/serverActions)) | 설치된 Next 16 문서에서 확인했습니다. |
| `5mb` 설정에서 Next가 초과 요청을 Action 실행 전에 거부 | `83084e7`이 5MiB 경계 QA를 로컬 서버에서 수행했다고 기록했습니다. 이 작업에서는 재실행하지 않았습니다. |
| Vercel 배포 환경에서 4.5MB 초과 요청의 응답 코드·본문 형태 | **미검증.** 배포 환경에 요청하지 않았습니다. |
| 4.5MB와 5MiB 사이 구간의 동작 | **미검증.** 플랫폼 한도가 4.5MB라면 Vercel에서는 이 구간이 Next 검사보다 먼저 막힐 수 있고 자체 호스팅에서는 5MiB까지 통과할 수 있습니다. 4.5MB의 단위(10^6 또는 MiB)도 확인하지 않았습니다. 기수 폼 이미지 요청(4,210,196바이트)은 어느 쪽 해석에서도 4.5MB 아래입니다. |
| 413 응답을 사용자에게 한국어로 안내하는지 | **미검증.** 클라이언트 폼의 413 처리를 확인하지 않았습니다. |

따라서 이슈 #511의 "플랫폼 413 회귀 검증"은 이 문서만으로 완료로 볼 수 없습니다. 배포 환경 확인은 별도 운영 확인으로 남깁니다.

## 유지 관리 규칙

- `bodySizeLimit`을 바꾸기 전에 서버 경유 파일 경로(기수 이미지, 교수진·포스터·수료생 폴백)와 직접 업로드 경로를 구분해 확인합니다.
- 큰 파일은 Action 본문에 넣지 않고 직접 Blob 업로드를 사용합니다.
- 새 Action을 추가하면 모든 문자열·배열 입력에 상한을 두고 이 표에 한 줄을 추가합니다.
