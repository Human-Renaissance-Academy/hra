# HRA 환경 분리 및 배포 전략

> **현재 운영 정책 (2026-11-16): 1인 개발·저관여 유지보수, Production 한 곳만 상시 운영.**
> 이 문서는 목표와 실제 구축 상태를 구분한다. 환경별 연결·백업·운영 복구가 모두 검증됐다는 뜻은 아니다. 이슈 #279(환경 경계), #284(배포·운영), #492(CI), #491(모바일 투자), #576(Android 출시 재개)를 따른다.

HRA는 예상 사용자 1~200명 규모다. 개발자가 매일 대시보드를 보거나 여러 환경의 자격증명·마이그레이션·비용을 관리하기 어렵다는 것을 기본 조건으로 한다. **운영 인프라를 적게 유지하되, 운영 데이터와 비밀값을 개발·검증에서 보호한다.** 로컬·CI·Preview는 사용 목적이지 별도의 상시 서버 3개를 뜻하지 않는다.

현재 앱은 저장소 루트의 Next.js, Neon HTTP DB 드라이버, Vercel Blob을 사용한다. Android Google Play 출시는 2026-11-20 #576 결정([기록](../decisions/2026-11-20-android-play-release-resume.md))에 따라 필요한 범위만 진행하며(2026-11-19 #491 [동결](../decisions/2026-11-19-mobile-api-freeze.md)은 이 범위에서 대체됨), iOS·monorepo 확대 설계는 시작하지 않는다. 모바일은 Web 운영의 선행 조건이 아니다. 초기 설치·DB 변경·Production 자격증명 적용은 [배포 안내](../DEPLOYMENT.md)와 [DB 변경 절차](database-change-procedure.md)를 참고한다.

## 1. 꼭 필요한 운영 구성

| 구분 | 기본 정책 | 데이터·로그인 경계 |
| --- | --- | --- |
| Local Development | 개발자 PC에서만 실행. 별도 Dev 서버 없음 | 개발용 Neon DB 또는 지원된 격리 테스트 DB, 합성 자료. Production 비밀값 사용 금지 |
| GitHub CI | PR/main에서 코드·보안·주요 회귀 자동 확인 | 운영 secret 없이 격리 PostgreSQL·mock/합성 자료. Production에 쓰기 금지 |
| Vercel PR Preview | **선택 사항**. 화면·통합 검증이 필요할 때만 | 격리된 **공용** Test DB/Blob을 사용하거나 DB·업로드·OAuth 의존 기능을 명시적으로 비활성화 |
| Production | **유일한 상시 웹 환경** | 실제 사용자용 Vercel + Production Neon + 별도 공개/Private Blob·실제 OAuth |
| Staging | **지금은 없음** | 실제 외부 검수·모바일 내부 테스트가 필요하고 감당할 운영 비용이 확인될 때만 재검토 |

**PR별 Neon branch·Blob·OAuth를 자동으로 생성하고 PR 종료 시 정리하는 체계는 기본 목표에서 제외한다.** 테스트가 필요할 때 공용 Test DB를 재사용하되 PR 병렬 테스트 간 충돌을 막기 위해 테스트 데이터를 분리·초기화하거나 CI의 격리 DB를 사용한다. 공용 Test DB도 운영 DB와 연결되지 않는다.

Vercel이 Preview 배포를 자동 생성할 수 있으나, 배포 성공 자체가 실제 DB 연결과 인증·파일 검증 성공을 뜻하지 않는다. Preview를 쓰지 않기로 했다면 기존 GitHub 필수 체크와 Vercel 프로젝트 설정을 확인하여 안전하게 비활성화한다. 기존 required check를 이름 변경·제거 없이 건너뛰어도 통과한다고 가정하지 않는다(#408/#492).

**2026-11-14 읽기 점검:** 비운영 전용 DB/Blob 자격증명이 설정되지 않은 상태에서 Preview 홈 HTTP 500이 관찰됐다(#279). 이는 안전한 테스트 환경을 갖췄다는 증거가 아니다. 운영 DB를 Preview에 넣어 해결하지 않는다. Preview를 계속 사용하면 안전한 Test DB와 합성 스키마를 준비하거나 의존 기능을 비활성화해야 한다.

### 자원이 없는 Preview의 거부 계약 (#279)

코드는 정확히 `VERCEL=1`과 `VERCEL_ENV=preview`가 함께 있을 때 HTML·RSC·Server Action을 인증 조회 전에 한국어 HTTP 503으로 거부한다. API 전체(health·cron·인증·파일 포함)는 **Preview 빌드에서 생성한** `beforeFiles` rewrite가 순수 503 Route로 보낸다. 이미지는 같은 정확한 Preview 빌드에서만 `unoptimized=true`, `remotePatterns=[]`, `localPatterns=[]`를 설정한다. Next가 자동 추가하는 두 빌드 정적 media 경로 외의 운영 Blob·동적 로컬 이미지를 허용하지 않는 제한 후보이며, 일반 `next start`의 rewrite나 unoptimized 설정만으로 Vercel의 별도 이미지 서비스를 제거했다고 판단하지 않는다. 응답은 `no-store`, `noindex, nofollow`이며 로그인 쿠키나 복구 시각을 발급하지 않는다. 이 Preview는 기능 검수 환경이 아니다.

허용한 읽기는 정확한 `/robots.txt`, `/sitemap.xml`의 GET/HEAD와 현재 Proxy matcher가 제외하는 실제 정적 자원·빌드 chunk다. robots는 전체 차단, sitemap은 비어 있다. metadata의 POST는 503이다. 임의 이미지 확장자나 원격 이미지 최적화는 안전 읽기 예외가 아니다. 프레임워크의 잘못된 경로·미지원 메서드 거부는 앱 503과 구분한다. Next 16.4.5의 고정 `/globe.svg` POST fixture는 내부 405 렌더에서 plain 500으로 끝나며, Local·Production 대조와 요청별 앱 함수 실행·외부 IO 0을 별도로 검사한다. 또한 고정 `/api/health`·`/resources`의 TRACE는 Next Request adapter가 handler 전에 거부하면서 plain 500을 반환한다. 정확한 미지원 메서드 진단과 Local·Production 대조·외부 IO 0을 함께 검사한다. 이 한정된 프레임워크 거부를 일반 500 허용이나 지원하는 일곱 메서드의 503 성공으로 확대 해석하지 않는다. 이 장치는 네트워크 수신·Next의 본문 clone/buffer 자체가 없다는 보장이 아니다.

이미지 경계는 배포의 `images` 출력과 실제 응답을 함께 확인한다. 기존 배포의 최적화 경로가 비개인 정적 아이콘을 HTTP 200으로 제공하고 실제 decode되는 양성 대조를 먼저 확보한 뒤, 변경 배포의 원격 패턴0·배포 domains0·정확한 두 빌드 정적 경로와 빈 query 조건, 캐시된 같은 아이콘의 검증 거부·직접 정적 읽기 보존을 비교한다. 이미지 서비스의 완전 제거나 모든 로컬 경로 거부를 주장하지 않는다. 운영 Blob 합성 주소와 로컬 업무 주소·절대 자기 주소·인코딩된 경로 조작도 실제로 거부돼야 한다. 플랫폼의 패턴 검증 거부는 업무 API의 503과 구분하며, 400/404만으로 NoIO를 주장하지 않는다. 새 테스트 사진·운영 Blob 객체는 사용하지 않는다. 향후 Preview 페이지를 허용하면 `unoptimized`가 원본 이미지 URL을 직접 사용하는 경계도 다시 검토한다.

**운영 적용 게이트:** 일반 `next start`의 rewrite 검증만으로 Vercel을 승인하지 않는다. Vercel adapter/minimalMode의 routing artifact와 실제 Preview 응답에서 API·이미지 선행 거부, 최종 시스템 환경값·override·secret scope를 별도로 확인한다. `VERCEL_ENV=preview`만 있는 로컬은 이 차단 대상이 아니다. 빌드와 실행의 tuple이 달라지면 API rewrite와 Proxy 조건이 불일치하므로 **prebuilt 재사용·Preview artifact의 Production 승격을 지원하지 않는다. 대상 환경에서 다시 빌드한다.**

코드 503와 별개로 Preview에 Production DB·Blob·OAuth·세션·Cron 자격정보를 공급하지 않는다. 실제 플랫폼 경계가 불명확하거나 업무 handler·외부 IO가 실행되면 Preview 공유·기능 검증을 중단하고, 권한 있는 운영자가 선택적 Preview 중단 또는 독립 정적 안내 배포를 적용한다. 이 문서의 코드 계약은 실제 Vercel 격리·#279 종료를 선언하지 않는다.

## 2. DB와 파일

- **Production DB가 유일한 실사용 정본**이다. 개발·PR에서 운영 데이터를 조회·수정하거나 데이터베이스를 복제해 테스트하지 않는다.
- Local 앱은 개발용 Neon URL을 사용한다. **일반 로컬 PostgreSQL URL을 앱의 Neon HTTP 드라이버에 그대로 넣어 실행할 수 있다고 가정하지 않는다.** 로컬 PostgreSQL은 해당 격리 테스트 실행기에서 사용한다.
- CI는 현재의 격리 테스트를 기본 검증 수단으로 활용한다. PR별 DB 자원 생성·삭제 자동화를 추가하지 않는다.
- Preview를 사용한다면 별도의 공용 테스트 DB와 합성 데이터로 기능을 검증한다. 실제 사용자 PII·운영 관리자 계정은 복제하지 않는다.
- 공개 이미지용 Blob과 회원 보호 자료·학생 제출 Private Blob의 **운영 저장소·토큰은 비운영 환경에 전달하지 않는다.** 필요한 종류의 테스트 Blob만 준비하며 없으면 해당 업로드·다운로드 쓰기를 비활성화하거나 명시적으로 거부한다.
- 운영 보호 자료의 실제 Private Blob 전환·접근 통제는 #268을 따른다. 환경 분리와 기존 자료의 비공개 이전은 서로 다른 검증이다.

## 3. OAuth·설정값·Cron

- Production의 Google/Kakao callback 및 Auth.js secret은 Production에만 등록한다.
- Local은 개발용 callback/client를 사용하거나 해당 로그인을 비활성화한다. Preview에서 검증 전용 callback을 안정적으로 제공할 수 없으면 소셜 로그인을 비활성화한다.
- 변수의 이름·용도·비밀 여부·적용 범위·설정 누락 시 동작은 [환경변수 계약](environment-inventory.md)과 `.env.example`을 정본으로 유지한다. `NEXT_PUBLIC_` 환경변수에 비밀값을 넣지 않는다.
- Production 대상 비밀값이 Preview에 잘못 적용되지 않았는지 확인하고, 불분명하면 비운영의 DB·Blob 쓰기 기능을 차단한다.
- Cron은 실제 사용하는 기능에만 최소 수를 등록한다. **기능이 존재한다고 자동으로 삭제 Cron을 활성화하지 않는다.** 학사·세션 정리는 승인된 보존 기간, dry-run, 중복 호출·재시도·배치 한도·알림을 검증한 후 활성화한다(#142/#494).
- 모바일 내부 앱 배포의 EAS 환경은 웹 Vercel 환경과 별개다. #576 Android 출시 결정(#491 동결 대체)에서도 고정 Staging/API URL 추가는 승인되지 않았으므로 별도 결정 전에는 추가하지 않는다.

## 4. DB 변경과 일반 배포를 분리

일반 웹 변경은 **PR → 최신 head CI/필수 리뷰 → main 병합 → Production 배포 → 배포 SHA 일치 및 공개 smoke/실패 알림**으로 끝내는 것을 목표로 한다.

DB 변경이 없다면 매 배포마다 별도 마이그레이션 작업·승인·테스트 서버를 만들지 않는다. DB 구조 또는 데이터 변경이 있을 때만 [DB 변경 절차](database-change-procedure.md)와 #280을 적용한다.

1. 변경 SQL, 기존 데이터·이전 앱과의 호환성, 대상 DB를 확인한다.
2. 백업 시점·보관·**실제 복구 방법**을 확인한다. 백업이 있다는 추정만으로 복구 가능하다고 판단하지 않는다.
3. 격리 DB에서 검증하고, 운영에는 승인된 변경만 수동·통제된 절차로 적용한다. `db:push`나 빌드 시 자동 destructive migration은 금지한다.
4. DB 적용 후 새로운 앱을 배포하고 필수 경로·상태를 검증한다. 불명확한 적용 결과를 자동 재시도로 덮어쓰지 않는다.
5. 장애 시 애플리케이션 코드 되돌리기와 DB/파일 복구를 **별개**로 판단한다.

#280의 실제 Production migration gate, DB baseline 및 restore 증거는 아직 미완료일 수 있다. 이 문서가 구축 완료를 선언하지 않는다.

## 5. 적은 관심으로 유지할 운영 기준

- **알림 기반 운영:** 이미 구축된 Production 공개 smoke/실패 알림(#333)을 유지한다. 일일 수동 조회에 의존하지 않는다. 알림의 실제 수신 채널·담당자·연속 실패 시 대응은 주기적으로 점검한다.
- **데이터 보호:** 보존·파기 정책(#142), Private Blob(#268), 인증/OAuth(#267/#507), 운영 DB 백업·복구(#280)는 확장 기능보다 우선한다.
- **비용·한도:** Vercel·Neon·Blob 사용량/무료 한도, 저장 용량과 알림 정책을 실제 서비스 조건에 맞게 확인한다. 사용하지 않는 preview·DB·배포 자원을 늘리지 않는다.
- **보안 갱신:** 지원 중인 런타임과 인증·보안 패치, 의존성 경보는 유지하되 반복 수작업 위험 원장과 중복 CI는 실측 후 간소화한다(#368/#492).
- **복구:** 사람이 바빠도 다시 시작할 수 있도록 배포 SHA, 최근 성공 버전, 담당자/접근권한, 백업 확인, 장애 시 기본 조치를 짧은 운영 메모로 관리한다([1인 운영 체크리스트](../operations/solo-operations.md)).
- **기능:** 실제 사용자에게 필요한 웹 기능을 우선한다. Android 출시 필수 범위(#576)를 넘는 Android 기능과 iOS·Push·광범위 API/monorepo는 실수요와 유지 가능 시간 검증 전 신규 확대하지 않는다(#491 동결 중 Android 출시 범위만 #576으로 대체).

## 6. Staging 도입 조건

다음이 모두 확인되기 전에는 고정 Staging을 만들지 않는다.

1. 실제 Android/iOS 내부 테스트, 외부 운영진 공동 검수, 반복되는 callback·고정 주소 검증 같은 필요가 있다.
2. 로컬/CI/선택적 Preview로 대체할 수 없다.
3. 추가 DB·Blob·OAuth·비용·취약점 업데이트·장애 알림을 지속 관리할 담당 여력이 있다.

추가할 경우 Production PII/DB/Blob/secret과 분리하고 합성 데이터로 검증한다.

## 7. 완료와 미검증의 구분

- [ ] Vercel 환경별 운영/비운영 secret scope와 DB·Blob 연결 대상 실제 검증 (#279)
- [ ] 선택적 Preview를 유지할지 확정하고, 유지한다면 2026-11-14 홈 HTTP 500 및 합성 기능 검증 해결 (#279)
- [ ] DB/파일 백업 보관·복구 실행의 실제 증거 확보 (#280)
- [ ] 운영 변경 후 기존 필수 CI·Production smoke·알림과 SHA 검증 유지 (#333/#408/#492)
- [x] 상시 Dev/QA/Staging 및 PR별 DB 분기 생성을 기본 정책에서 제외 (문서상 결정)
- [x] 고정 Staging은 실제 수요 확인 전 미도입 (정책 결정)

**원칙:** 단순화는 운영 자원을 줄이는 결정이고, 보안·권한·데이터 복원 가능성을 약화시키는 결정이 아니다.
