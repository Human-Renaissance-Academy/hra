# Android 출시 검토용 데이터 흐름 조사

[이슈 #580](https://github.com/Human-Renaissance-Academy/hra/issues/580)의 데이터 흐름 초안입니다. 저장소에서 Android 화면이 호출하는 경로를 서버·저장소까지 따라가 확인했습니다. 실제 출시 AAB의 전이 SDK·권한·전송, Play Console 답변, 운영 로그·복구 정책은 출시 검증 단계에서 확인합니다.

## 코드에서 확인한 흐름

| 기능 | 데이터와 이동 | 저장·접근 경계 | 주요 근거 |
| --- | --- | --- | --- |
| 비밀번호 로그인 | 이메일·비밀번호와 OS 구분·앱 버전이 앱에서 HRA `POST /api/v1/auth/login`으로 이동합니다. 서버는 비밀번호 해시와 비교합니다. 서버 계약의 선택 기기 이름은 Android 앱이 보내지 않습니다. | 기존 회원 레코드와 모바일 세션을 사용합니다. 요청 IP, 정규화 이메일 및 조합으로 만든 제한 키를 해시해 DB에 기록합니다. | `apps/mobile/src/auth/{login-screen.tsx,auth-api.ts}`, `src/features/auth/mobile-login/service.ts`, `src/lib/rate-limit.ts` |
| 세션·로그아웃 | 접근 토큰은 HRA API의 Bearer 인증에, 갱신 토큰은 갱신·단일 로그아웃에 사용합니다. 서버는 만료·사용 시각, 세션 버전 및 회전·회수 상태를 관리합니다. 갱신 제한 키에는 IP·세션 ID가 쓰입니다. | 접근 토큰은 메모리, 갱신 토큰·만료 시각·최소 프로필(회원 ID·이름·역할)은 기기 SecureStore에 저장합니다. PostgreSQL에는 토큰 해시와 회전 이력을 저장합니다. 재사용·회수 사건의 서버 로그에는 세션 식별자가 포함될 수 있습니다. | `apps/mobile/src/auth/token-store.ts`, `src/features/auth/mobile-login/{service,repository}.ts`, `src/features/auth/mobile-session/repository.ts` |
| 내 정보·학적 | 인증된 앱은 `GET /api/v1/me`에서 회원 ID·이름·표시용 이메일·역할·기수 ID·프로필 이미지 URL을 수신합니다. 과제 인가에는 서버의 계정·학적 연결 및 과제 대상 정보가 쓰입니다. | 프로필·학적의 정본은 PostgreSQL입니다. 앱의 조회 데이터는 React Query 메모리 캐시에 둡니다. 전체 학생 명부를 내려주는 Android 경로는 조사 범위의 화면에서 발견되지 않았습니다. | 프로필 탭, `apps/mobile/src/query/client.ts`, `src/app/api/v1/me/route.ts`, `src/app/api/v1/assignments/route.ts`, `packages/contracts/src/api-v1.ts` |
| 공지·일정과 본문 | HRA API는 목록·본문·월별 일정에 응답합니다. 본문은 HRA API 호스트·Vercel 공개 Blob의 허용된 HTTPS 이미지를 문서 예산 안에서 자동 로드할 수 있습니다. 그 밖의 허용 HTTPS 이미지는 사용자 조작 뒤 로드합니다. 사용자가 확인한 본문 링크는 OS가 처리합니다. | 원격 이미지는 URL을 네이티브 이미지 컴포넌트에 전달합니다. 이 경로에는 HRA Bearer를 넣지 않습니다. 원격 이미지 요청의 호스트·IP 등은 릴리스 기기에서 확인합니다. | `apps/mobile/src/features/{notices,schedule,markdown}/`, `apps/mobile/src/features/markdown/{image-policy,markdown-inline-view,markdown-view}.tsx` |
| 과제 조회·제출 준비 | 학생은 본인 과제와 제출 상태·파일 메타데이터를 조회합니다. Android 문서 선택기에서 선택한 PDF를 앱 캐시로 복사합니다. 과제 식별자, 파일명·크기·형식은 HRA 업로드 의도 생성 요청에 포함됩니다. | 서버는 과제 접근·제출 권한과 업로드 의도를 확인합니다. 재개용 SecureStore에는 과제 ID·업로드 의도 ID·요청 ID·제출 키·단계만 담습니다. | `apps/mobile/src/features/assignments/submit-runtime.ts`, `apps/mobile/src/features/submission/{submit-flow,resume-store}.ts`, `src/app/api/v1/uploads/intents/route.ts` |
| PDF 업로드·제출 확정 | 앱은 HRA가 발급한 Blob 클라이언트 토큰으로 Vercel Blob에 PDF 바이트와 지정 경로·형식·크기·요청 식별 정보를 HTTPS로 전송합니다. 이어 HRA API의 검증·확정 경로를 호출합니다. | PDF 원본은 Private Blob, 업로드 의도·확정된 제출·파일 메타데이터는 PostgreSQL에 둡니다. 앱은 세션 전환 때 전송을 중단하고 보호 캐시·재개 기록을 정리합니다. 운영의 고아 Blob 삭제·학사 보존은 별도 확인이 필요합니다. | `apps/mobile/src/features/submission/{submission-api,blob-upload,expo-blob-transport}.ts`, `src/app/api/v1/uploads/route.ts`, `src/app/api/v1/submissions/route.ts` |
| 보호 파일 받기·열기 | 가이드북과 권한이 있는 본인 제출 PDF를 인증된 HRA 엔드포인트에서 받아 캐시에 저장합니다. Android는 읽기 권한이 붙은 로컬 콘텐츠 URI로 PDF 뷰어를 열며, 열기 실패 시 공유 시트 경로가 있습니다. | HRA 다운로드 인증과 별도로 OS가 파일을 사용자 선택 앱에 전달할 수 있습니다. 받은 앱이 보관한 사본의 후속 처리는 HRA의 앱 캐시 정리 범위 밖입니다. | `apps/mobile/src/features/files/{protected-request,download-protected-file,open-file,session-cleanup}.ts`, [자료 파일 접근 정책](../resource-file-access-policy.md) |
| 플랫폼·SDK | 네이티브 입력·파일 경로에 Expo SecureStore·문서 선택기·파일 시스템·인텐트·공유 모듈을 사용합니다. Expo·React Native·Expo Router와 React Query·OpenAPI 클라이언트는 직접 의존성 목록에 있습니다. | 직접 의존성·앱 경로에서 광고·분석·충돌 수집 SDK 호출과 푸시 토큰 등록을 발견하지 않았습니다. 전이 의존성·최종 AAB의 네이티브 모듈·백업 규칙·기기 전송은 별도로 확인합니다. | `apps/mobile/package.json`, `apps/mobile/app.config.ts`, [모바일 앱의 개인정보·권한 검토](mobile-app.md) |

## 출시용 증거가 남은 항목

- #578의 출시 AAB와 #579의 합성 계정 실기기 검증에서 연결 호스트·TLS·앱 권한·SDK·백업과 전송 흐름을 확인합니다. 특히 PDF의 Vercel 전송과 시스템 뷰어·공유 경로를 포함합니다. 운영 호스팅·DB·Blob의 로그 범위, 보존·삭제·복구, 처리 담당자는 승인된 운영 정책과 대조합니다. [개인정보 보존 및 파기 이슈 #142](https://github.com/Human-Renaissance-Academy/hra/issues/142)
- Android 라우트에는 현재 비밀번호 로그인과 승인 대기 화면이 있으며 앱 내 계정 생성·삭제 요청 경로는 발견되지 않았습니다. 웹에는 별도 회원가입 경로가 있으며, 관리자 회원 삭제와 모바일 단일·전체 로그아웃은 각각 관리자 작업 및 세션 회수입니다. 출시 후보에서 가입 화면이나 외부 링크를 통한 계정 생성 가능성을 확인한 뒤 Console의 계정 삭제 질문 적용 여부를 판단합니다.
- 프로필의 개인정보 처리방침 버튼은 설정에 유효한 URL이 있을 때만 노출됩니다. 현재 기본값은 빈 문자열입니다. 공개 정책 URL과 앱 내 진입점·담당자·학사 보존 예외는 승인된 내용과 출시 후보에서 확인합니다. `apps/mobile/src/features/profile/{config,model,components}.*`
- Console의 수집·공유·삭제·전송 암호화·콘텐츠 등급·대상 연령·광고 응답은 출시 후보와 제출 시점에 확인합니다. 로그인 보호 화면을 위한 별도 합성 심사 계정과 안내도 실제 경로로 검증합니다. [Google Play 사용자 데이터 정책](https://support.google.com/googleplay/android-developer/answer/10144311) · [데이터 보안 설문 안내](https://support.google.com/googleplay/android-developer/answer/10787469) · [계정 삭제 안내](https://support.google.com/googleplay/android-developer/answer/13327111)
