# 변경 이력 (CHANGELOG)

이 문서는 HRA 웹사이트의 주요 변경 사항을 기록합니다.

---

## [0.4.0](https://github.com/Human-Renaissance-Academy/hra/compare/v0.3.0...v0.4.0) (2026-11-23)


### 새 기능

* **db:** 수업일지 원본과 수정 이력을 DB 제약으로 보호한다 ([5414842](https://github.com/Human-Renaissance-Academy/hra/commit/541484217ae013deea9e653c807afb4e322e822b)), closes [#636](https://github.com/Human-Renaissance-Academy/hra/issues/636)
* **mobile:** 로그인 후 4탭·학생 교수 홈 최소화 ([90fb55b](https://github.com/Human-Renaissance-Academy/hra/commit/90fb55b1e963324c15afdb23af24b61c21503f95)), closes [#633](https://github.com/Human-Renaissance-Academy/hra/issues/633)
* **resources:** 수업일지 원본과 수정본을 자료실에 연결한다 ([f4d82dc](https://github.com/Human-Renaissance-Academy/hra/commit/f4d82dcec40595a6d84bb1e4d67e153caf681c11)), closes [#636](https://github.com/Human-Renaissance-Academy/hra/issues/636)
* **web:** 로그인 후 학사포털을 핵심 동선으로 간소화 ([a8417e1](https://github.com/Human-Renaissance-Academy/hra/commit/a8417e14df31bc311ddc73e6de0985d2f7e6c047)), closes [#632](https://github.com/Human-Renaissance-Academy/hra/issues/632)


### 버그 수정

* **resources:** 상세에서 돌아갈 때 자료 분류를 유지한다 ([2b53532](https://github.com/Human-Renaissance-Academy/hra/commit/2b5353226b22f0e08b51389a83fb11ef3f6d4175)), closes [#632](https://github.com/Human-Renaissance-Academy/hra/issues/632)

## [0.3.0](https://github.com/Human-Renaissance-Academy/hra/compare/v0.2.2...v0.3.0) (2026-11-22)


### 새 기능

* **web:** 학생·교수 학사포털을 실제 자료실 화면에 반영 ([d662cd2](https://github.com/Human-Renaissance-Academy/hra/commit/d662cd2a9f48bdf409c0e2e3ced331ee663edecf))

## [0.2.2](https://github.com/Human-Renaissance-Academy/hra/compare/v0.2.1...v0.2.2) (2026-11-22)


### 버그 수정

* **ci:** 병합 뒤 라벨 변경으로 닫힌 릴리스 PR의 형식 검사가 실패하지 않게 한다 ([#622](https://github.com/Human-Renaissance-Academy/hra/issues/622)) ([f7cb8c3](https://github.com/Human-Renaissance-Academy/hra/commit/f7cb8c3e0bb9cda0357d5d53ee621c4f3f559c3c))

## [0.2.1](https://github.com/Human-Renaissance-Academy/hra/compare/v0.2.0...v0.2.1) (2026-11-21)


### 버그 수정

* **release:** 단일 패키지 통합 release PR 병합 뒤 Release·태그가 생성되게 한다 ([#619](https://github.com/Human-Renaissance-Academy/hra/issues/619)) ([03aada2](https://github.com/Human-Renaissance-Academy/hra/commit/03aada2b9d62700fcb86ac2f7d42863f375ff6ea))

## [0.2.0](https://github.com/Human-Renaissance-Academy/hra/compare/v0.1.0...v0.2.0) (2026-11-21)


### ⚠ BREAKING CHANGES

* **actions:** 전체 본문 5MiB를 넘는 Server Action HTTP 요청은 액션 실행 전에 거부됩니다. 기존 자체 호스팅의 raw 10MiB 이미지·30MiB 문서 전송은 새 총량 상한에서 거부될 수 있습니다. 직접 Blob 업로드와 도메인 파일별 계약은 변경하지 않습니다.
* **preview:** Vercel Preview의 로그인·API·업로드·동적 페이지는 503을 반환한다. Preview artifact의 Production 승격 및 prebuilt 재사용 대신 정상 Git Production 빌드를 사용한다.
* **security:** HRA 의존성 검토 원장 v2와 parsed-lock API를 v3 및 authoritative Buffer 쌍 API로 전환한다. 루트와 모바일의 원문 binding을 함께 검토해야 한다.
* **db:** `node scripts/migrate-html-to-markdown.mjs`는 더 이상 `.env`·`DATABASE_URL`을 읽지 않으며 notices·class_logs·weekly_texts·report_templates·recruitment_settings 본문을 조회하거나 UPDATE하지 않습니다. 이전 무인자 실행은 대상 확인·백업·승인·전체 transaction 없이 HTML로 보이는 행마다 즉시 UPDATE했습니다. 선택 인자 `--dry-run`은 같은 실제 조회 뒤 행 id와 변환 결과 앞 200자를 출력하는 미리보기(UPDATE 없음)였습니다. 두 경로 모두 제공하지 않으며, 남은 HTML 본문 변환은 #280의 검증된 데이터 적용 경계 뒤 별도로 수행해야 합니다.
* **db:** `node scripts/seed-faculty.mjs`·`seed-press.mjs`·`seed-alumni.mjs`는 더 이상 `DATABASE_URL`을 읽거나 `faculty`·`press_articles`·`alumni_stories`에 INSERT하지 않습니다. 누락 행 입력은 #280의 검증된 데이터 적용 경계 뒤 별도로 수행해야 합니다.
* **db:** `seed-cohorts`는 더 이상 `.env`를 읽거나 `cohorts`에 INSERT하지 않습니다. 누락 기수 입력은 #280의 검증된 데이터 적용 경계 뒤 별도로 수행해야 합니다.
* **db:** 과거 로그 설치 CLI의 사전 검사·대상별 테이블/인덱스 transaction·사후 조회는 비활성이다. 무인자는 계획만 출력하고 --confirm-apply도 접속 전에 거부한다. 기존 DB 설치는 #280의 신뢰된 대상·복구·승인 경계 뒤 별도로 적용해야 한다.
* **db:** 지원서 UNIQUE CLI의 사전 검사·단일 ALTER·경합 재확인·사후 조회는 비활성이다. 무인자는 계획만 출력하며 --confirm-apply도 접속 전에 거부한다. 기존 DB 설치는 #280의 신뢰된 대상·복구·승인 경계 뒤 별도로 적용해야 한다.
* **db:** 모집설정 CLI의 기존 복수 행 사전 검사·컬럼/제약/기본행 결합 설치·사후 단일 행 검증은 비활성이다. 무인자는 계획만 출력하며 --confirm-apply도 접속 전에 거부한다. 실제 기존 DB 업그레이드는 #280의 신뢰된 대상·복구·승인 경계가 마련된 뒤 별도로 적용해야 한다.
* **db:** Markdown 이미지 원장 CLI의 기존 사전 조회·테이블/인덱스/뷰 결합 설치·후조건 확인 경로는 비활성이다. 무인자는 계획만 출력하고 --confirm-apply도 접속 전에 거부한다. 기존 DB 업그레이드는 #280의 신뢰된 대상·복구·승인 절차가 마련된 뒤 별도로 적용해야 한다.
* **db:** 질문 설치 CLI의 기존 ALTER·두 함수 결합 적용 경로는 비활성이다. 무인자는 계획만 출력하고 --confirm-apply도 접속 전에 거부한다. 기존 DB 업그레이드는 #280의 신뢰된 대상·복구·승인 절차가 마련된 뒤 별도로 적용해야 한다.
* **db:** 두 db:migrate 명령은 무인자에서 DB를 변경하지 않는다. 적용하려면 명시 DB URL과 --confirm-apply가 필요하며 잘못된 인자·기존 정의는 거부한다.
* **db:** db:migrate-rate-limit-reservations는 URL에 사용자명·비밀번호와 지원한 접속 옵션을 명시해야 한다. ambient PG service/password 파일이나 미지원 query 옵션으로 접속을 보완하지 않는다.
* **db:** npm run db:push는 모든 대상에서 접속 없이 실패 종료한다. SQL 생성은 drizzle-kit export/generate를 사용하고 실제 적용은 DB 변경 문서의 별도 검토 절차를 따른다.

### 새 기능

* **academics:** 과제 검토 피드백과 담당 검토자 평가 화면을 추가한다 ([acedb99](https://github.com/Human-Renaissance-Academy/hra/commit/acedb99f60e4bbf6fa03aab411bd020b57e31c75)), closes [#162](https://github.com/Human-Renaissance-Academy/hra/issues/162)
* **academics:** 과제 검토 피드백과 담당 검토자 평가 화면을 추가한다 ([#565](https://github.com/Human-Renaissance-Academy/hra/issues/565)) ([acedb99](https://github.com/Human-Renaissance-Academy/hra/commit/acedb99f60e4bbf6fa03aab411bd020b57e31c75))
* **academics:** 과제 문서 형식 탐지와 구조 검증 모듈을 추가한다 ([d26f76c](https://github.com/Human-Renaissance-Academy/hra/commit/d26f76c75edf3b981d28b8cc8fb0ae82b8313615)), closes [#516](https://github.com/Human-Renaissance-Academy/hra/issues/516)
* **academics:** 과제 문서 형식 탐지와 구조 검증 모듈을 추가한다 ([#541](https://github.com/Human-Renaissance-Academy/hra/issues/541)) ([d26f76c](https://github.com/Human-Renaissance-Academy/hra/commit/d26f76c75edf3b981d28b8cc8fb0ae82b8313615))
* **academics:** 교수 계정 연결과 담당 수업 과제 검토 권한을 추가한다 ([c50f6fa](https://github.com/Human-Renaissance-Academy/hra/commit/c50f6fa0953e28a680fb152f5e291ab613d82a85)), closes [#161](https://github.com/Human-Renaissance-Academy/hra/issues/161)
* **academics:** 교수 계정 연결과 담당 수업 과제 검토 권한을 추가한다 ([#561](https://github.com/Human-Renaissance-Academy/hra/issues/561)) ([c50f6fa](https://github.com/Human-Renaissance-Academy/hra/commit/c50f6fa0953e28a680fb152f5e291ab613d82a85))
* **academics:** 기수별 운영 인력 배정과 출결 권한 판정을 추가한다 ([4219527](https://github.com/Human-Renaissance-Academy/hra/commit/42195279cb2392339e78556f8d7aac6b0d34ef26)), closes [#165](https://github.com/Human-Renaissance-Academy/hra/issues/165)
* **academics:** 기수별 운영 인력 배정과 출결 권한 판정을 추가한다 ([#556](https://github.com/Human-Renaissance-Academy/hra/issues/556)) ([4219527](https://github.com/Human-Renaissance-Academy/hra/commit/42195279cb2392339e78556f8d7aac6b0d34ef26))
* **academics:** 분리 제출 V2를 서비스 계층에 연결한다 ([369aa75](https://github.com/Human-Renaissance-Academy/hra/commit/369aa75f438009cce349dbf91d4e80e651e878c2)), closes [#516](https://github.com/Human-Renaissance-Academy/hra/issues/516)
* **academics:** 분리 제출 V2를 서비스 계층에 연결한다 ([#564](https://github.com/Human-Renaissance-Academy/hra/issues/564)) ([369aa75](https://github.com/Human-Renaissance-Academy/hra/commit/369aa75f438009cce349dbf91d4e80e651e878c2))
* **academics:** 분리 제출 과제 설정과 학생 제출 화면을 추가한다 ([e453a77](https://github.com/Human-Renaissance-Academy/hra/commit/e453a774d960fef5b322730947c817267541e508)), closes [#516](https://github.com/Human-Renaissance-Academy/hra/issues/516)
* **academics:** 분리 제출 과제 설정과 학생 제출 화면을 추가한다 ([#568](https://github.com/Human-Renaissance-Academy/hra/issues/568)) ([e453a77](https://github.com/Human-Renaissance-Academy/hra/commit/e453a774d960fef5b322730947c817267541e508))
* **academics:** 분리 제출을 API v1·OpenAPI·제출 현황에 반영한다 ([a4c484d](https://github.com/Human-Renaissance-Academy/hra/commit/a4c484d8fd0237bafec7e1bb8159d3d7679f5743)), closes [#516](https://github.com/Human-Renaissance-Academy/hra/issues/516)
* **academics:** 분리 제출을 API v1·OpenAPI·제출 현황에 반영한다 ([#569](https://github.com/Human-Renaissance-Academy/hra/issues/569)) ([a4c484d](https://github.com/Human-Renaissance-Academy/hra/commit/a4c484d8fd0237bafec7e1bb8159d3d7679f5743))
* **academics:** 수료 기준 버전과 수료 확정 이력을 추가한다 ([cfc8741](https://github.com/Human-Renaissance-Academy/hra/commit/cfc8741856fdc6e0d94be88a3afe2d2566d8937d)), closes [#163](https://github.com/Human-Renaissance-Academy/hra/issues/163)
* **academics:** 수료 기준 버전과 수료 확정 이력을 추가한다 ([#566](https://github.com/Human-Renaissance-Academy/hra/issues/566)) ([cfc8741](https://github.com/Human-Renaissance-Academy/hra/commit/cfc8741856fdc6e0d94be88a3afe2d2566d8937d))
* **academics:** 출결 입력·운영 인력 관리·학생 본인 출결 화면을 추가한다 ([eef0dbd](https://github.com/Human-Renaissance-Academy/hra/commit/eef0dbd2c0a33a4afc883f71a888ad03e0801a5c)), closes [#160](https://github.com/Human-Renaissance-Academy/hra/issues/160)
* **academics:** 출결 입력·운영 인력 관리·학생 본인 출결 화면을 추가한다 ([#562](https://github.com/Human-Renaissance-Academy/hra/issues/562)) ([eef0dbd](https://github.com/Human-Renaissance-Academy/hra/commit/eef0dbd2c0a33a4afc883f71a888ad03e0801a5c))
* **academics:** 텍스트·발표자료 분리 제출을 위한 추가형 DB 마이그레이션을 정의한다 ([6eb5a50](https://github.com/Human-Renaissance-Academy/hra/commit/6eb5a502e8bd48e8ce0be365ed9348d7dce7969b)), closes [#516](https://github.com/Human-Renaissance-Academy/hra/issues/516)
* **academics:** 텍스트·발표자료 분리 제출을 위한 추가형 DB 마이그레이션을 정의한다 ([#555](https://github.com/Human-Renaissance-Academy/hra/issues/555)) ([6eb5a50](https://github.com/Human-Renaissance-Academy/hra/commit/6eb5a502e8bd48e8ce0be365ed9348d7dce7969b))
* **academics:** 학사 요청 추적과 실패 정리 관측을 보강한다 ([cd0edf2](https://github.com/Human-Renaissance-Academy/hra/commit/cd0edf255095a43276b8ce33cae7a265b5533d30)), closes [#157](https://github.com/Human-Renaissance-Academy/hra/issues/157)
* **academics:** 학사 요청 추적과 실패 정리 관측을 보강한다 ([#559](https://github.com/Human-Renaissance-Academy/hra/issues/559)) ([cd0edf2](https://github.com/Human-Renaissance-Academy/hra/commit/cd0edf255095a43276b8ce33cae7a265b5533d30))
* **academics:** 학생별 출결 기록과 정정 승인 서버 계약을 추가한다 ([377f939](https://github.com/Human-Renaissance-Academy/hra/commit/377f9399c95315f29ff6c6fefc91a3bf9dad82e0)), closes [#159](https://github.com/Human-Renaissance-Academy/hra/issues/159)
* **academics:** 학생별 출결 기록과 정정 승인 서버 계약을 추가한다 ([#560](https://github.com/Human-Renaissance-Academy/hra/issues/560)) ([377f939](https://github.com/Human-Renaissance-Academy/hra/commit/377f9399c95315f29ff6c6fefc91a3bf9dad82e0))
* **academic:** 검증된 학생 계정 연결과 안전한 백필 추가 ([#234](https://github.com/Human-Renaissance-Academy/hra/issues/234)) ([6522d85](https://github.com/Human-Renaissance-Academy/hra/commit/6522d85659d4078770696ef7390034a087951580))
* **academic:** 과제 관리 액션과 공개 확인 검증 추가 ([#240](https://github.com/Human-Renaissance-Academy/hra/issues/240)) ([d04d4cc](https://github.com/Human-Renaissance-Academy/hra/commit/d04d4ccaee3c49ba04fc3e0fa1a14fc5281e67c5))
* **academic:** 과제 정의와 공개 대상 스냅샷 도입 ([#236](https://github.com/Human-Renaissance-Academy/hra/issues/236)) ([9027ecb](https://github.com/Human-Renaissance-Academy/hra/commit/9027ecb87d02dbe9744d6db607165539e7d98351))
* **academic:** 과제 편집과 공개 관리 화면 추가 ([#244](https://github.com/Human-Renaissance-Academy/hra/issues/244)) ([88054af](https://github.com/Human-Renaissance-Academy/hra/commit/88054affe8b27fcf3f95ae119ff282be04b2fb13))
* **academic:** 대상 전원 제출 현황과 CSV 추가 ([#245](https://github.com/Human-Renaissance-Academy/hra/issues/245)) ([946858a](https://github.com/Human-Renaissance-Academy/hra/commit/946858abe6bee994ac215f7ce54c14c5e5b24a6f))
* **academic:** 비공개 과제 업로드 검증과 안전한 정리 추가 ([#241](https://github.com/Human-Renaissance-Academy/hra/issues/241)) ([baed9f9](https://github.com/Human-Renaissance-Academy/hra/commit/baed9f99fa162a1851602bf05ca8ebd7ceb3e0ac))
* **academic:** 안전한 요청 관측과 오류 참조 표시 추가 ([#248](https://github.com/Human-Renaissance-Academy/hra/issues/248)) ([0219f6a](https://github.com/Human-Renaissance-Academy/hra/commit/0219f6a545b908ef409ce987e593f95d188cd9f4))
* **academic:** 원자적 제출 확정과 응답 유실 복구 추가 ([#242](https://github.com/Human-Renaissance-Academy/hra/issues/242)) ([05a4b5e](https://github.com/Human-Renaissance-Academy/hra/commit/05a4b5ebe187380dbb750d04ffa9894d4727e537))
* **academic:** 제출 파일별 비공개 다운로드와 접근 감사 추가 ([#243](https://github.com/Human-Renaissance-Academy/hra/issues/243)) ([35bcf78](https://github.com/Human-Renaissance-Academy/hra/commit/35bcf784551a17286fcd88a849defdf0a5888b77))
* **academic:** 지정 승인자의 기수별 학생 명부 관리 추가 ([#237](https://github.com/Human-Renaissance-Academy/hra/issues/237)) ([2197f9e](https://github.com/Human-Renaissance-Academy/hra/commit/2197f9efec8e93633a9134f52bddffcb08665f18))
* **academic:** 최종 제출과 비공개 업로드 의도 스키마 도입 ([#238](https://github.com/Human-Renaissance-Academy/hra/issues/238)) ([1bd0a72](https://github.com/Human-Renaissance-Academy/hra/commit/1bd0a725958722e00d8665bf8d3f8a2a29650342))
* **academic:** 학생 과제 제출 화면과 실패 복구 추가 ([#246](https://github.com/Human-Renaissance-Academy/hra/issues/246)) ([7223fbf](https://github.com/Human-Renaissance-Academy/hra/commit/7223fbfe083dc72891422e9f6441edb38829e422))
* **academic:** 학생 본인 과제 조회와 객체 권한 계약 추가 ([#239](https://github.com/Human-Renaissance-Academy/hra/issues/239)) ([08b12bf](https://github.com/Human-Renaissance-Academy/hra/commit/08b12bf8906ae65d259499f7ad0065b5ef63d1c9))
* **academic:** 학생 식별자와 기수별 등록 스키마 도입 ([#233](https://github.com/Human-Renaissance-Academy/hra/issues/233)) ([904bf4b](https://github.com/Human-Renaissance-Academy/hra/commit/904bf4b01624384e7ff29ba9f75e925ca73bffe9))
* **api:** 공개 일정을 한국 벽시계 계약으로 제공 ([77b6feb](https://github.com/Human-Renaissance-Academy/hra/commit/77b6febfdd44da56e45982c3adc1b07e63137308))
* **api:** 공지 목록을 공용 API v1 계약으로 제공 ([02e1cd0](https://github.com/Human-Renaissance-Academy/hra/commit/02e1cd0c4ce6e6fc885536d6e6c1ddabd62598a3))
* **api:** 본인 과제·제출·업로드·파일 API v1 경로를 추가한다 ([9c4430a](https://github.com/Human-Renaissance-Academy/hra/commit/9c4430a325e2f7b9bba84b5d76bbf39eaf6419ca))
* **api:** 본인 프로필을 Web 세션 API v1로 제공 ([a1d2bdd](https://github.com/Human-Renaissance-Academy/hra/commit/a1d2bddb686e70eac76a8d9a5d0bbfc29f77c4fd))
* **api:** 승인 회원에게 파일 경로 없는 가이드북 목록 제공 ([57bf3de](https://github.com/Human-Renaissance-Academy/hra/commit/57bf3de3d2a260e9834acc36977008bc861daf1a))
* **api:** 웹과 모바일에 일관된 공개 공지 상세 계약 제공 ([45659cb](https://github.com/Human-Renaissance-Academy/hra/commit/45659cb0cd0c88a0596f004dadafc05aee784146)), closes [#272](https://github.com/Human-Renaissance-Academy/hra/issues/272)
* **api:** 자료실 강의자료·주차별 텍스트·가이드북 파일 API v1 경로를 추가한다 ([#440](https://github.com/Human-Renaissance-Academy/hra/issues/440)) ([769ffdc](https://github.com/Human-Renaissance-Academy/hra/commit/769ffdc76059af637508f72e08b66c915925360d))
* **contracts:** 공용 API v1 계약 정본과 페이지 클라이언트 props 최소 투영 적용 ([#304](https://github.com/Human-Renaissance-Academy/hra/issues/304)) ([2b8e4a5](https://github.com/Human-Renaissance-Academy/hra/commit/2b8e4a5a55b8e08695450f444a43c5ca2a3a9bcc))
* **mobile:** EAS Preview·Production 빌드 경계와 수동 출시 게이트 준비 ([c6d83d4](https://github.com/Human-Renaissance-Academy/hra/commit/c6d83d4bb3fe5fbd8184cb4b4a94ed5f824d311a))
* **mobile:** React Native Expo 앱 기반과 Android MVP를 추가한다 ([#445](https://github.com/Human-Renaissance-Academy/hra/issues/445)) ([1935f2d](https://github.com/Human-Renaissance-Academy/hra/commit/1935f2d3fda06916a41a3900a6183d894266b592))
* **notifications:** Android·iOS 공용 푸시 전송 계약과 재시도 규칙 구축 ([957a485](https://github.com/Human-Renaissance-Academy/hra/commit/957a485ae801c3649aea0b04c7ece3d1e7ca5c80))
* **ops:** 분리 제출 실제 저장소 측정과 한컴 샘플 점검 도구를 추가한다 ([45e03f2](https://github.com/Human-Renaissance-Academy/hra/commit/45e03f2a49172f0a27829b2066127ca297e5fb7b)), closes [#516](https://github.com/Human-Renaissance-Academy/hra/issues/516)
* **ops:** 분리 제출 실제 저장소 측정과 한컴 샘플 점검 도구를 추가한다 ([#567](https://github.com/Human-Renaissance-Academy/hra/issues/567)) ([45e03f2](https://github.com/Human-Renaissance-Academy/hra/commit/45e03f2a49172f0a27829b2066127ca297e5fb7b))
* **ops:** 운영 읽기 전용 점검 스크립트와 확인 절차를 추가한다 ([994328c](https://github.com/Human-Renaissance-Academy/hra/commit/994328c6322f18b8ca4890bfe74dc27e687f08b5))
* **ops:** 운영 읽기 전용 점검 스크립트와 확인 절차를 추가한다 ([#554](https://github.com/Human-Renaissance-Academy/hra/issues/554)) ([994328c](https://github.com/Human-Renaissance-Academy/hra/commit/994328c6322f18b8ca4890bfe74dc27e687f08b5))
* **recruitment:** 모집안내와 지원 CTA에 접수 채널·상태를 명확히 표시한다 ([#419](https://github.com/Human-Renaissance-Academy/hra/issues/419)) ([851e305](https://github.com/Human-Renaissance-Academy/hra/commit/851e305422f342cd4cca1ecdd792ab6a849b000d))
* **resources:** 자료실 파일·메타데이터 조회에 사용자별 빈도 제한을 적용한다 ([#453](https://github.com/Human-Renaissance-Academy/hra/issues/453)) ([2c2d575](https://github.com/Human-Renaissance-Academy/hra/commit/2c2d57524187fce44bf1869e30cec9f8ca745338))
* **security:** 의존성 원장 변화 유형을 진단하고 재생성 도구를 추가한다 ([49e182d](https://github.com/Human-Renaissance-Academy/hra/commit/49e182d7ea240c9b5e0e9683e8fb7b96081b0c56)), closes [#368](https://github.com/Human-Renaissance-Academy/hra/issues/368)
* **security:** 의존성 원장 변화 유형을 진단하고 재생성 도구를 추가한다 ([#552](https://github.com/Human-Renaissance-Academy/hra/issues/552)) ([49e182d](https://github.com/Human-Renaissance-Academy/hra/commit/49e182d7ea240c9b5e0e9683e8fb7b96081b0c56))
* **seo:** 환경별 canonical 기준과 sitemap·robots를 제공한다 ([#422](https://github.com/Human-Renaissance-Academy/hra/issues/422)) ([f4acebd](https://github.com/Human-Renaissance-Academy/hra/commit/f4acebdb571bca452c27155cd7419c31731855c9))


### 버그 수정

* **a11y:** FAQ 접힌 답변을 접근성 트리와 탭 순서에서 제외한다 ([#421](https://github.com/Human-Renaissance-Academy/hra/issues/421)) ([2c46d82](https://github.com/Human-Renaissance-Academy/hra/commit/2c46d824f7e157a798a83c89e18db90c5ea99c0d))
* **a11y:** 모바일 Header 메뉴의 확장 상태와 키보드 탐색을 보강한다 ([#418](https://github.com/Human-Renaissance-Academy/hra/issues/418)) ([a678544](https://github.com/Human-Renaissance-Academy/hra/commit/a6785444f60290ab4ebb312cca2aea9b9d68af10))
* **a11y:** 홈 Hero 타이핑 애니메이션에 모션 감소 설정을 적용한다 ([#420](https://github.com/Human-Renaissance-Academy/hra/issues/420)) ([da359b0](https://github.com/Human-Renaissance-Academy/hra/commit/da359b017a30deba0de473b700a544d259af6066))
* **academics:** 한글 기본 스크립트 저장소를 매크로로 오인하지 않는다 ([4c1cff6](https://github.com/Human-Renaissance-Academy/hra/commit/4c1cff6b7de1e70f51f49e8c07c59bf8192e6d04)), closes [#516](https://github.com/Human-Renaissance-Academy/hra/issues/516)
* **academics:** 한글 기본 스크립트 저장소를 매크로로 오인하지 않는다 ([#551](https://github.com/Human-Renaissance-Academy/hra/issues/551)) ([4c1cff6](https://github.com/Human-Renaissance-Academy/hra/commit/4c1cff6b7de1e70f51f49e8c07c59bf8192e6d04))
* **academic:** 업로드 승인 거부 응답을 구분 ([#247](https://github.com/Human-Renaissance-Academy/hra/issues/247)) ([9edf939](https://github.com/Human-Renaissance-Academy/hra/commit/9edf93957cefd950c34ac7ac10afce17d5a24c15))
* **academic:** 정상 업로드 복구가 내부 단계 예산에 막히지 않게 한다 ([928787c](https://github.com/Human-Renaissance-Academy/hra/commit/928787cf85ef1a25ff9d8dd14ff43ee6812f6ea7))
* **actions:** 기수 업로드를 보존하며 과도한 본문 파싱을 제한한다 ([83084e7](https://github.com/Human-Renaissance-Academy/hra/commit/83084e73f9ad08ec586819bf4759d4d7107b6214))
* **actions:** 긴 텍스트·배열 입력에 액션별 상한을 둔다 ([a63f717](https://github.com/Human-Renaissance-Academy/hra/commit/a63f7173db6fa6035ccd587613cd75e39b254b41)), closes [#539](https://github.com/Human-Renaissance-Academy/hra/issues/539)
* **actions:** 긴 텍스트·배열 입력에 액션별 상한을 둔다 ([#543](https://github.com/Human-Renaissance-Academy/hra/issues/543)) ([a63f717](https://github.com/Human-Renaissance-Academy/hra/commit/a63f7173db6fa6035ccd587613cd75e39b254b41))
* **admin:** 동시 상태 변경이 서로 덮어쓰지 않도록 한다 ([897a626](https://github.com/Human-Renaissance-Academy/hra/commit/897a6269fa31d1437e9543904b510debd401f65e))
* **admin:** 없는 수정 대상의 성공 처리 방지 ([#259](https://github.com/Human-Renaissance-Academy/hra/issues/259)) ([9019cad](https://github.com/Human-Renaissance-Academy/hra/commit/9019cade4d8ec9826effdd453162c9edb9eb3ad7))
* **alumni:** 수료생 사진 브라우저 직접 업로드 적용 ([#225](https://github.com/Human-Renaissance-Academy/hra/issues/225)) ([ebffa11](https://github.com/Human-Renaissance-Academy/hra/commit/ebffa11fa30e09f9bc5f7bc74649ae159cbc436e))
* **auth:** Auth.js 보안 수정과 OAuth 제공자 경계 회귀 적용 ([09e74b7](https://github.com/Human-Renaissance-Academy/hra/commit/09e74b7ace6e05efa3e16c3f936a9a8abe2a55b3))
* **auth:** Proxy의 보호 경로 접근 거부를 명시적인 응답으로 처리 ([a56122c](https://github.com/Human-Renaissance-Academy/hra/commit/a56122c0ebbc7665d63f8f1eda7aad1aa11e0f82))
* **auth:** 미인식 역할의 양식 조회와 이미지 저장을 차단 ([352a5a8](https://github.com/Human-Renaissance-Academy/hra/commit/352a5a83de766f9b883cd5ee81e58c4c85bc214b)), closes [#509](https://github.com/Human-Renaissance-Academy/hra/issues/509)
* **auth:** 보호 경로에서 거부된 요청이 Proxy를 통과하지 않게 한다 ([a56122c](https://github.com/Human-Renaissance-Academy/hra/commit/a56122c0ebbc7665d63f8f1eda7aad1aa11e0f82))
* **auth:** 보호 경로에서 거부된 요청이 Proxy를 통과하지 않게 한다 ([be1656a](https://github.com/Human-Renaissance-Academy/hra/commit/be1656ad900f02a137d9f9e5b84a74df54d70f12))
* **auth:** 승인대기 화면 서버 렌더링 오류 수정 ([#253](https://github.com/Human-Renaissance-Academy/hra/issues/253)) ([53db13b](https://github.com/Human-Renaissance-Academy/hra/commit/53db13b602eb5ca9ffd2daacd1bc289021800061))
* **auth:** 이메일 식별 불일치로 인한 계정 조회 장애를 줄인다 ([0dfdc73](https://github.com/Human-Renaissance-Academy/hra/commit/0dfdc739c65a9bfea6a23d152849668cebf43e2c))
* **auth:** 이메일 축 로그인 한도를 30회로 완화하고 차단 관측과 해제 절차를 둔다 ([9c657c8](https://github.com/Human-Renaissance-Academy/hra/commit/9c657c8137121713492d012ab941012fd150f131)), closes [#508](https://github.com/Human-Renaissance-Academy/hra/issues/508)
* **auth:** 이메일 축 로그인 한도를 30회로 완화하고 차단 관측과 해제 절차를 둔다 ([#548](https://github.com/Human-Renaissance-Academy/hra/issues/548)) ([9c657c8](https://github.com/Human-Renaissance-Academy/hra/commit/9c657c8137121713492d012ab941012fd150f131))
* **auth:** 제공자가 다른 OAuth 검사 쿠키의 수용을 막는다 ([09e74b7](https://github.com/Human-Renaissance-Academy/hra/commit/09e74b7ace6e05efa3e16c3f936a9a8abe2a55b3))
* **auth:** 제공자가 다른 OAuth 검사 쿠키의 수용을 막는다 ([92e41d3](https://github.com/Human-Renaissance-Academy/hra/commit/92e41d3f13e00588d02f05f1c5b59b8d2361ba5f))
* **auth:** 차단된 로그인 요청의 조회와 비밀번호 계산을 줄인다 ([96890f7](https://github.com/Human-Renaissance-Academy/hra/commit/96890f7fcbbefc17a7c402c30ac6b01b9e8a3742))
* **auth:** 회원 승인 오류와 가입 안내 누락 수정 ([#251](https://github.com/Human-Renaissance-Academy/hra/issues/251)) ([ed38701](https://github.com/Human-Renaissance-Academy/hra/commit/ed387014a11db472409f77e454fd36cbeed2f6f9))
* **blob:** 비공개 사본 확인 오류로 자료 주소가 노출되지 않게 한다 ([e720ef0](https://github.com/Human-Renaissance-Academy/hra/commit/e720ef0a7fc8ac054e230f12400dd99b5d36b246)), closes [#280](https://github.com/Human-Renaissance-Academy/hra/issues/280) [#268](https://github.com/Human-Renaissance-Academy/hra/issues/268)
* **blob:** 참조 교체 결과가 불확실할 때 보호 자료 유실 방지 ([f987f62](https://github.com/Human-Renaissance-Academy/hra/commit/f987f62568f94618a9b9779ad8cdafd14a50bc5e))
* **calendar:** 태블릿 화면의 달력 가로 넘침 방지 ([#261](https://github.com/Human-Renaissance-Academy/hra/issues/261)) ([e7f4bb6](https://github.com/Human-Renaissance-Academy/hra/commit/e7f4bb6474268bb56c2caa79b94697b7e7fff852))
* **ci:** PR 형식 검사의 gh 출력 버퍼 초과(ENOBUFS)를 해결한다 ([#448](https://github.com/Human-Renaissance-Academy/hra/issues/448)) ([e0aff18](https://github.com/Human-Renaissance-Academy/hra/commit/e0aff18ec47dfab2e98c788cb0aee151a6e55b52))
* **ci:** 뒤처진 PR의 커밋 메시지 검사를 merge-base 이후 커밋으로 한정한다 ([#434](https://github.com/Human-Renaissance-Academy/hra/issues/434)) ([bc22096](https://github.com/Human-Renaissance-Academy/hra/commit/bc2209609290210fb3abc469c6ff6f71bd1268be))
* **content:** 동시 반전 명령이 이전 값을 덮어쓰지 않게 한다 ([efb8ee1](https://github.com/Human-Renaissance-Academy/hra/commit/efb8ee1a22934569c6b845da9498a1acc1b79259))
* **db:** HTML→Markdown 변환 명령의 무검증 DB 쓰기를 차단한다 ([#437](https://github.com/Human-Renaissance-Academy/hra/issues/437)) ([fe18308](https://github.com/Human-Renaissance-Academy/hra/commit/fe183085a28c58339b39db9535b9e385cc532a42))
* **db:** 검증되지 않은 DB의 전체 스키마 변경 방지 ([eb03a25](https://github.com/Human-Renaissance-Academy/hra/commit/eb03a25d4d72f6c8a6d0199ae5018cb0d7170c2a)), closes [#280](https://github.com/Human-Renaissance-Academy/hra/issues/280) [#269](https://github.com/Human-Renaissance-Academy/hra/issues/269)
* **db:** 검증되지 않은 이미지 원장 설치의 DB 쓰기를 차단한다 ([c13f6eb](https://github.com/Human-Renaissance-Academy/hra/commit/c13f6eba086dde78a84f98986d8d318424c6495c)), closes [#280](https://github.com/Human-Renaissance-Academy/hra/issues/280)
* **db:** 검증되지 않은 질문 설치 명령의 DB 쓰기를 차단한다 ([20e2c22](https://github.com/Human-Renaissance-Academy/hra/commit/20e2c223a380b4218517421f5df19d8d48ea0c5d)), closes [#280](https://github.com/Human-Renaissance-Academy/hra/issues/280)
* **db:** 과거 로그 설치 명령의 무검증 DB 접근을 차단한다 ([9c987d5](https://github.com/Human-Renaissance-Academy/hra/commit/9c987d573d64ac306ed71ce3a7f724b6e6efafc0)), closes [#280](https://github.com/Human-Renaissance-Academy/hra/issues/280)
* **db:** 교수진·언론보도·수료생 seed의 무검증 DB 쓰기를 차단한다 ([#425](https://github.com/Human-Renaissance-Academy/hra/issues/425)) ([e8f4874](https://github.com/Human-Renaissance-Academy/hra/commit/e8f48749227f2cc11b4bfd2f176d6c535048c6d5))
* **db:** 기수 seed의 무검증 DB 쓰기를 차단한다 ([93d76c6](https://github.com/Human-Renaissance-Academy/hra/commit/93d76c6318f4bbabdb5b8ae761b9066d1f4bd4ef))
* **db:** 모집설정 기본행 정의를 보존하며 무검증 쓰기를 차단한다 ([1fa2537](https://github.com/Human-Renaissance-Academy/hra/commit/1fa25370fb4ca787857ede618f3de86e5ecbcc38)), closes [#280](https://github.com/Human-Renaissance-Academy/hra/issues/280)
* **db:** 순서 저장 대상을 모두 확인한 뒤 원자적으로 갱신 ([#256](https://github.com/Human-Renaissance-Academy/hra/issues/256)) ([84076e9](https://github.com/Human-Renaissance-Academy/hra/commit/84076e933d9e987d7d67c12a3cac7dc88d1aec0d))
* **db:** 요청 제한 설치 대상의 환경변수 우회 차단 ([3b73a23](https://github.com/Human-Renaissance-Academy/hra/commit/3b73a23146db0cd04546862203c98699209183b6)), closes [#280](https://github.com/Human-Renaissance-Academy/hra/issues/280)
* **db:** 지원서 중복 제약 설치의 무검증 DB 접근을 차단한다 ([fc93082](https://github.com/Human-Renaissance-Academy/hra/commit/fc93082b8638d8071bf5171ceb40838163d9d77b)), closes [#280](https://github.com/Human-Renaissance-Academy/hra/issues/280)
* **db:** 한정 스키마 설치의 무인자 DB 변경 방지 ([5514d90](https://github.com/Human-Renaissance-Academy/hra/commit/5514d9011d2dac237a7abdb596781e7e3837b475)), closes [#280](https://github.com/Human-Renaissance-Academy/hra/issues/280)
* **deps:** fast-uri와 undici 패치로 신규 보안 경고 해소 ([43a261a](https://github.com/Human-Renaissance-Academy/hra/commit/43a261a8e30d8fd37ad8179b82ea17ce7d34c319))
* **deps:** lockfile 의존성을 공식 npm registry로 고정하고 외부 피드를 차단한다 ([#435](https://github.com/Human-Renaissance-Academy/hra/issues/435)) ([2e6d5e2](https://github.com/Human-Renaissance-Academy/hra/commit/2e6d5e280f30e6bbe96638d18df44d7f0b22d411))
* **deps:** Vitest 갱신과 Node 타입의 peer 호환성을 보장한다 ([45bab9b](https://github.com/Human-Renaissance-Academy/hra/commit/45bab9b528dfc45a9fd4a74c299b0a615a2e6fcb))
* **deps:** YAML 보안 예외를 수정 버전으로 대체한다 ([9a3b739](https://github.com/Human-Renaissance-Academy/hra/commit/9a3b739b716ed906e62d924205dd390b30fc9150))
* **deps:** 감사 불일치를 원문 노출 없이 진단 가능하게 한다 ([5bdab4e](https://github.com/Human-Renaissance-Academy/hra/commit/5bdab4e2c5a5b42dcd8d874dfdeaf8670204c1be))
* **deps:** 만료 예정 보안 검토 원장을 권고별로 재검토한다 ([#424](https://github.com/Human-Renaissance-Academy/hra/issues/424)) ([4422324](https://github.com/Human-Renaissance-Academy/hra/commit/4422324166f6685f01839772f5d67129ad288b48))
* **deps:** 변경된 공개 권고를 검토해 보안 검사의 차단 원인을 해소한다 ([0c556e7](https://github.com/Human-Renaissance-Academy/hra/commit/0c556e78419e3e05147ea1d79691481bef9605ee))
* **deps:** 신규 minimatch 공개 권고를 검토해 보안 검토 원장을 복구한다 ([37dfb0f](https://github.com/Human-Renaissance-Academy/hra/commit/37dfb0f73c0486c28c2e32e972076ab05c1e4620))
* **deps:** 전이 body-parser 패치로 새 보안 경고 차단 ([12b4b48](https://github.com/Human-Renaissance-Academy/hra/commit/12b4b48601c625da9ada37fff54df92d1fc82558))
* **deps:** 직접 import가 하위 의존성 호이스팅에 의존하지 않게 한다 ([94c6adc](https://github.com/Human-Renaissance-Academy/hra/commit/94c6adce6d60df27c29edcea2e5b21e0a0ab08e4))
* **deps:** 직접 사용하는 Markdown과 에디터 패키지의 설치 계약을 고정한다 ([b7f0953](https://github.com/Human-Renaissance-Academy/hra/commit/b7f09530e0eaae22820cec2af4538c924e442aae))
* **deps:** 패치된 Zod로 신규 서비스 중단 위험 차단 ([850ebd3](https://github.com/Human-Renaissance-Academy/hra/commit/850ebd3b7deabb8547c38dc5b69ff2b122d10b7b))
* **deps:** 편집기 붙여넣기 경로가 취약 버전에 머물지 않게 한다 ([2dd63be](https://github.com/Human-Renaissance-Academy/hra/commit/2dd63be845ccf307112f71eb0966f503c545bdd5))
* **deps:** 편집기 의존성이 검증한 보안 하한을 유지하게 한다 ([1955d21](https://github.com/Human-Renaissance-Academy/hra/commit/1955d213efe3cf5e17116501d40c0cd8a260f7a9)), closes [#269](https://github.com/Human-Renaissance-Academy/hra/issues/269)
* **deps:** 호환되는 의존성 갱신으로 Preview 설치 실패를 막는다 ([95c53ad](https://github.com/Human-Renaissance-Academy/hra/commit/95c53ad184196be3032612ca598550c872400bc9))
* **deps:** 호환되는 편집기 버전으로 Preview 설치와 이미지 보존을 회복한다 ([b0d5d0d](https://github.com/Human-Renaissance-Academy/hra/commit/b0d5d0dd7de3cbc9305b428f3f7e7aa152fdccce))
* **editor:** 이미지 브라우저 직접 업로드 적용 ([0dc3149](https://github.com/Human-Renaissance-Academy/hra/commit/0dc314981b8fa2701dbe13a5e91e020df2ab1508))
* **editor:** 이미지 설명과 주소가 저장 과정에서 손상되지 않게 한다 ([0e05de3](https://github.com/Human-Renaissance-Academy/hra/commit/0e05de3e07d1c3cfb4df0328baf243fcca7bc553))
* **editor:** 이미지 속성이 저장과 재개방 때 변형되지 않게 한다 ([896ef71](https://github.com/Human-Renaissance-Academy/hra/commit/896ef71f961d3aa01e0957c3251fb6fafeae9601))
* **editor:** 전체화면 미리보기를 키보드로 조작할 수 있게 한다 ([a812484](https://github.com/Human-Renaissance-Academy/hra/commit/a812484bdb6cf68b3569c43086f49f83cc88c875))
* **editor:** 전체화면 미리보기에서 키보드 편집 흐름을 지킨다 ([742e4e5](https://github.com/Human-Renaissance-Academy/hra/commit/742e4e59d1090348d031f0dc32931d9421d0e622))
* **faculty:** 프로필 사진 브라우저 직접 업로드 적용 ([#226](https://github.com/Human-Renaissance-Academy/hra/issues/226)) ([f7775bb](https://github.com/Human-Renaissance-Academy/hra/commit/f7775bb0b8460b72a8e611c5d726fd3be06a8f36))
* **gallery:** 갤러리 이미지 브라우저 직접 업로드 적용 ([1a80c81](https://github.com/Human-Renaissance-Academy/hra/commit/1a80c81d678f532b52fad338ec7a781b64243a21))
* **logging:** 서버 오류 로그의 정보 정제 경계 보완 ([#258](https://github.com/Human-Renaissance-Academy/hra/issues/258)) ([18f11b4](https://github.com/Human-Renaissance-Academy/hra/commit/18f11b490ae5ea4b7e065108c5c1f3185294d9ab))
* **logging:** 서버 오류 원문이 로그에 남지 않도록 허용 필드만 기록 ([362c251](https://github.com/Human-Renaissance-Academy/hra/commit/362c251a303a863a908841fe3f289aeeeecb52e6))
* **markdown:** 환경별 신뢰한 사이트 이미지 주소를 반영 ([71c6f4b](https://github.com/Human-Renaissance-Academy/hra/commit/71c6f4b99dedc41376d5bccdd9888f474e06e465)), closes [#512](https://github.com/Human-Renaissance-Academy/hra/issues/512)
* **mobile:** 승인된 공통 앱 식별자 com.hra.mobile 적용 ([#598](https://github.com/Human-Renaissance-Academy/hra/issues/598)) ([4123ecd](https://github.com/Human-Renaissance-Academy/hra/commit/4123ecd035536cb6402b50e074624c33936e2788))
* **notices:** 방문 기록 이동 시 검색 입력 동기화 ([#260](https://github.com/Human-Renaissance-Academy/hra/issues/260)) ([7ba4e94](https://github.com/Human-Renaissance-Academy/hra/commit/7ba4e9465b9a32edf69e00e1fdefbe2dda19165a))
* **notices:** 중복 검색 쿼리의 서버 오류 방지 ([#252](https://github.com/Human-Renaissance-Academy/hra/issues/252)) ([ddba934](https://github.com/Human-Renaissance-Academy/hra/commit/ddba9347ab2d9fe4b70c9be06e6c855c90f80235))
* **press:** 반복 요청의 조회수 오염과 쓰기 부담을 줄인다 ([b7a4ae4](https://github.com/Human-Renaissance-Academy/hra/commit/b7a4ae4f7bebc00c23dbb642dae41e22b22bf1d4))
* **press:** 삭제와 순서 저장의 통신 실패 복구 ([#264](https://github.com/Human-Renaissance-Academy/hra/issues/264)) ([0203fca](https://github.com/Human-Renaissance-Academy/hra/commit/0203fcadb192aaae9d145b6565402a170127741d))
* **preview:** 운영 데이터 접근을 차단하는 미리보기 경계 적용 ([3c459a4](https://github.com/Human-Renaissance-Academy/hra/commit/3c459a4668c7937442a43f85b0e7587daf2d998e))
* **recruitment:** 포스터 브라우저 직접 업로드 적용 ([#227](https://github.com/Human-Renaissance-Academy/hra/issues/227)) ([ae4bbd5](https://github.com/Human-Renaissance-Academy/hra/commit/ae4bbd5eebe344421c28b26b8830f864f97247e9))
* **release:** 조직 이전 후 릴리스 실행 조건과 저장소 링크 정정 ([999b2b0](https://github.com/Human-Renaissance-Academy/hra/commit/999b2b0dc05cfb031bd32d2bfa8e896096fa15f6))
* **resources:** 공개 원본 삭제 전 비공개 사본 재검증 ([#231](https://github.com/Human-Renaissance-Academy/hra/issues/231)) ([ac37d70](https://github.com/Human-Renaissance-Academy/hra/commit/ac37d70b28958a8b85fd703327f30b96c4276e4f))
* **resources:** 다운로드 스트림 종료와 실패 처리 보완 ([#263](https://github.com/Human-Renaissance-Academy/hra/issues/263)) ([d26e672](https://github.com/Human-Renaissance-Academy/hra/commit/d26e6722e07cc8197962391d3405c62d320d27f5))
* **resources:** 모바일 자료실 가독성과 필터 반응형 개선 ([#602](https://github.com/Human-Renaissance-Academy/hra/issues/602)) ([e72c4d7](https://github.com/Human-Renaissance-Academy/hra/commit/e72c4d7357d1001d6e5f3ad24d42845dcc27ab4a))
* **resources:** 반복 inline 파라미터를 미리보기로 취급하지 않고 업로드 한도를 보완한다 ([612397b](https://github.com/Human-Renaissance-Academy/hra/commit/612397ba3b26e1f3f40d85805bf23b866c274a91))
* **resources:** 반복 inline 파라미터를 미리보기로 취급하지 않고 업로드 한도를 보완한다 ([#546](https://github.com/Human-Renaissance-Academy/hra/issues/546)) ([612397b](https://github.com/Human-Renaissance-Academy/hra/commit/612397ba3b26e1f3f40d85805bf23b866c274a91))
* **resources:** 보호 파일 읽기를 인증 경로로 통합 ([#228](https://github.com/Human-Renaissance-Academy/hra/issues/228)) ([858889f](https://github.com/Human-Renaissance-Academy/hra/commit/858889f59cddfcf171687b1482e3c0aafa54d0c4))
* **resources:** 비공개 Blob 업로드 전환과 이전 절차 추가 ([#230](https://github.com/Human-Renaissance-Academy/hra/issues/230)) ([2284baa](https://github.com/Human-Renaissance-Academy/hra/commit/2284baa9ed5d2be51ef0567d3b432e767b31f7ff))
* **resources:** 주차별 텍스트 파일과 사진 직접 업로드 적용 ([abd172c](https://github.com/Human-Renaissance-Academy/hra/commit/abd172cb618007ff5403fee7a0f804139f740402))
* **resources:** 주차별 텍스트를 회원 본인 기수로만 열람하게 한다 ([992b0aa](https://github.com/Human-Renaissance-Academy/hra/commit/992b0aa345ad6089c77c6e963a3d9db39ab6948c)), closes [#441](https://github.com/Human-Renaissance-Academy/hra/issues/441)
* **resources:** 주차별 텍스트를 회원 본인 기수로만 열람하게 한다 ([#553](https://github.com/Human-Renaissance-Academy/hra/issues/553)) ([992b0aa](https://github.com/Human-Renaissance-Academy/hra/commit/992b0aa345ad6089c77c6e963a3d9db39ab6948c))
* **schedule:** 과제 참조로 거부된 일정 삭제 결과를 관리자에게 표시 ([6bf25c7](https://github.com/Human-Renaissance-Academy/hra/commit/6bf25c71c74bf57f4bef021062ab4047377dccb6))
* **schedule:** 참조된 일정의 삭제 거부를 관리자에게 알린다 ([6bf25c7](https://github.com/Human-Renaissance-Academy/hra/commit/6bf25c71c74bf57f4bef021062ab4047377dccb6))
* **schedule:** 참조된 일정의 삭제 거부를 관리자에게 알린다 ([90a41db](https://github.com/Human-Renaissance-Academy/hra/commit/90a41dbbd24793cfebd1617d10827f0310844fe5))
* **security:** Next.js·sharp 보안 수정 버전과 회귀 게이트 적용 ([d96ec23](https://github.com/Human-Renaissance-Academy/hra/commit/d96ec23cb5486bcb8a2d3d02fcf2401e0110147c))
* **security:** npm audit의 파생 범위 변동으로 인한 불필요한 CI 차단 방지 ([8bd22d4](https://github.com/Human-Renaissance-Academy/hra/commit/8bd22d4ef60cb112dbcd4e75f0f5505b4e9656d6))
* **security:** 검토된 입력과 출처별 위험 도달을 고정 ([0273f72](https://github.com/Human-Renaissance-Academy/hra/commit/0273f72491b4e565fc04157111ea5596393280d1))
* **security:** 공개 변경의 보안 경계 회귀 방지 ([bb16f4b](https://github.com/Human-Renaissance-Academy/hra/commit/bb16f4b264d199dc547641c538e5f818508b38bd)), closes [#269](https://github.com/Human-Renaissance-Academy/hra/issues/269)
* **security:** 만료 예정 의존성 검토 3건을 새 근거로 재검토한다 ([a50944a](https://github.com/Human-Renaissance-Academy/hra/commit/a50944ad26f6d839fea83dc5353230b061d4637e)), closes [#368](https://github.com/Human-Renaissance-Academy/hra/issues/368)
* **security:** 만료 예정 의존성 검토 3건을 새 근거로 재검토한다 ([#545](https://github.com/Human-Renaissance-Academy/hra/issues/545)) ([a50944a](https://github.com/Human-Renaissance-Academy/hra/commit/a50944ad26f6d839fea83dc5353230b061d4637e))
* **security:** 알려진 프레임워크 취약 버전의 재유입을 막는다 ([d96ec23](https://github.com/Human-Renaissance-Academy/hra/commit/d96ec23cb5486bcb8a2d3d02fcf2401e0110147c))
* **security:** 알려진 프레임워크 취약 버전의 재유입을 막는다 ([5a72a46](https://github.com/Human-Renaissance-Academy/hra/commit/5a72a46a359e28bdd2d22cb34f892f162d71d7c7))
* **security:** 자료실 첨부 다운로드에 sandbox CSP를 적용한다 ([#529](https://github.com/Human-Renaissance-Academy/hra/issues/529)) ([03b5fc6](https://github.com/Human-Renaissance-Academy/hra/commit/03b5fc61005c2b872f9ef00ce824c3f035c3cabc))
* **security:** 철회된 권고로 차단된 dependency 검토 게이트 복구 ([f9c8914](https://github.com/Human-Renaissance-Academy/hra/commit/f9c89144cbb504b342c5c494271ca22ea695f7a1)), closes [#359](https://github.com/Human-Renaissance-Academy/hra/issues/359) [#359](https://github.com/Human-Renaissance-Academy/hra/issues/359)
* **security:** 철회된 권고를 정리해 실제 감사와 원장 정합성을 회복한다 ([0c23a1c](https://github.com/Human-Renaissance-Academy/hra/commit/0c23a1cfef48a3b8ada71a24150fe1e9dddd6800)), closes [#368](https://github.com/Human-Renaissance-Academy/hra/issues/368)
* **seo:** 공유 이미지 메타데이터를 복원하고 홈 제목 중복을 없앤다 ([cd11c5f](https://github.com/Human-Renaissance-Academy/hra/commit/cd11c5f8b66aa4347e6121fd555426b4eb14173f)), closes [#414](https://github.com/Human-Renaissance-Academy/hra/issues/414)
* **seo:** 공유 이미지 메타데이터를 복원하고 홈 제목 중복을 없앤다 ([#544](https://github.com/Human-Renaissance-Academy/hra/issues/544)) ([cd11c5f](https://github.com/Human-Renaissance-Academy/hra/commit/cd11c5f8b66aa4347e6121fd555426b4eb14173f))
* **templates:** 관리자 양식 편집 서버 액션 연결 수정 ([#254](https://github.com/Human-Renaissance-Academy/hra/issues/254)) ([bc57be4](https://github.com/Human-Renaissance-Academy/hra/commit/bc57be4db8a2e644ea15343b738f9a05d248f775))
* **test:** 비동기 고정 버튼 회귀가 정상 갱신 CI를 불안정하게 하지 않게 한다 ([15665df](https://github.com/Human-Renaissance-Academy/hra/commit/15665df4674fe8bdc2f48a885063c301bfff0925))
* **upload:** 관리자 이미지 서버 업로드와 포스터 변환의 소유권 원장 선예약 통일 ([#303](https://github.com/Human-Renaissance-Academy/hra/issues/303)) ([91181c3](https://github.com/Human-Renaissance-Academy/hra/commit/91181c3458a1cc32b7ff8e167448aa445097a79c))
* **upload:** 교체 응답 유실로 참조 파일을 잃지 않게 한다 ([1794fe9](https://github.com/Human-Renaissance-Academy/hra/commit/1794fe9a57270f3154fdf01d0c514a139a9405f1))
* **upload:** 교체 응답 유실에도 참조 파일과 소유권을 보존한다 ([c84877b](https://github.com/Human-Renaissance-Academy/hra/commit/c84877b906a8e9521af0872dc1d059a908c622ce))
* **upload:** 실제 요청 Host로 업로드 출처 비교 ([#262](https://github.com/Human-Renaissance-Academy/hra/issues/262)) ([f20784f](https://github.com/Human-Renaissance-Academy/hra/commit/f20784fab76cb35ef818874f99d354118a00b7c4))
* **upload:** 잘못된 이미지 요청 본문을 400으로 거부 ([#255](https://github.com/Human-Renaissance-Academy/hra/issues/255)) ([7ee475f](https://github.com/Human-Renaissance-Academy/hra/commit/7ee475f910208a79fddd6928c8145ea801485219))
* **users:** 학적 참조 회원 삭제 실패를 안전하게 안내 ([#257](https://github.com/Human-Renaissance-Academy/hra/issues/257)) ([82a28ce](https://github.com/Human-Renaissance-Academy/hra/commit/82a28cec17b5239c086c3fbd963983dd02c3a6eb))
* **views:** 응답 뒤 조회수 작업의 실행 수명을 연결한다 ([c37931c](https://github.com/Human-Renaissance-Academy/hra/commit/c37931c6a06e1eb9521f362b09702695b1c4311f))
* **views:** 응답 뒤에도 조회수 갱신이 완료되도록 수명주기를 연결한다 ([dadb899](https://github.com/Human-Renaissance-Academy/hra/commit/dadb899eb5c1c75e37d40960f0db14c48650b72d))


### 성능 개선

* **auth:** 권한 회수 지연 없이 인증 중복 비용 방지 ([d1747cf](https://github.com/Human-Renaissance-Academy/hra/commit/d1747cf1a07e76ec711eceaab8ab0fcd42ea5e36))
* **ci:** 삭제 ref push에서 코드 없는 중복 빌드를 생략한다 ([6f03bcd](https://github.com/Human-Renaissance-Academy/hra/commit/6f03bcd16687f7d529ff13d4d3f37fda9a8038a1)), closes [#367](https://github.com/Human-Renaissance-Academy/hra/issues/367)
* **db:** 성공한 요청의 예약 정리가 전체 이벤트를 훑지 않게 한다 ([39030d5](https://github.com/Human-Renaissance-Academy/hra/commit/39030d513dfc2c99ee61b9f4d3e8d6d347f36bce))
* **db:** 예약 정리의 불필요한 전체 탐색을 줄인다 ([5e672ea](https://github.com/Human-Renaissance-Academy/hra/commit/5e672eaf2092df592d685d15fae2c5e8584f59af))
* **markdown:** 공개 본문에 불필요한 파서 전달을 줄인다 ([62fb198](https://github.com/Human-Renaissance-Academy/hra/commit/62fb1985ac3ba1594d6a1cbd3b4054354a304c02)), closes [#293](https://github.com/Human-Renaissance-Academy/hra/issues/293)
* **markdown:** 공개 본문에 불필요한 파서 전송을 줄인다 ([1832fc4](https://github.com/Human-Renaissance-Academy/hra/commit/1832fc4462c8b7de15982acf4d148a36958ba02d))

## 2026-04-26

### PR #36 — 카카오 로그인 이메일 미제공 대응 (`fix/kakao-login-no-email`)
- **문제**: 카카오 OAuth는 비즈앱 심사 없이 이메일을 제공하지 않아 `signIn` 콜백에서 `return false` → Access Denied
- **수정**: `src/lib/auth.ts` — 이메일이 없는 경우 `{provider}_{providerAccountId}@oauth.placeholder` 형태의 placeholder 이메일 생성
- **스키마 변경 없음**: 기존 `email NOT NULL UNIQUE` 제약 유지
- **머지 완료**: 2026-04-26

### PR #35 — 언론보도 페이지 게시판 형태 전환 (`feat/press-board-layout`)
- **변경**: `src/app/(public)/press/page.tsx` — 카드형 레이아웃을 4열 게시판(번호·제목·매체·날짜) 테이블로 전환
- **디자인**: 데스크톱 `md:grid-cols-[80px_1fr_180px_140px]`, 모바일 제목 + "매체 · 날짜" 한 줄
- **호버**: 행 `bg-[#F5F5F5]`, 제목 `text-[#2563EB]`
- **번호 체계**: `totalCount - index` (최신 기사 = 가장 큰 번호)
- **제거**: `Image`, `ExternalLink` import (게시판에서 불필요)
- **머지 완료**: 2026-04-26

### PR #34 — 카카오 로그인 우선 배치 (`feat(auth)`)
- **변경**: `src/app/(auth)/login/login-form.tsx` — 카카오 로그인 버튼을 최상단에 배치, 구글 로그인 아래로 이동
- **머지 완료**: 2026-04-26

### PR #33 — 카카오 콘솔 2025 개편 반영 가이드 (`docs`)
- **신규 문서**: `docs/KAKAO-LOGIN-SETUP.md` — 카카오 개발자 콘솔 2025 개편(Redirect URI, Client Secret 위치 변경)을 반영한 9단계 설정 가이드
- **Playwright 검증**: 실제 콘솔 화면을 브라우저 자동화로 확인하여 위치 확정
- **머지 완료**: 2026-04-26

### PR #32 — 홈 하단 CTA 섹션 제거 (`chore(home)`)
- **변경**: `src/app/(public)/page.tsx` — "지원하기" CTA 섹션 제거 (사용자 요청)
- **머지 완료**: 2026-04-26

### HRA 관련 언론 기사 전수 검색 완료
- **방법**: Exa websearch 10건+ 병렬 실행, librarian 에이전트 3건 가동
- **검증 기준**: "위즈덤시티", "제주대학교", "Human Renaissance Academy", "HRA", "취업역량강화 아카데미" 키워드 매칭
- **결과**: 4건 확정 (상세 → `docs/PRESS-ARTICLES.md`)

### 카카오 로그인 설정 완료
- 카카오 콘솔 앱 OAuth Redirect URI 2개 등록 (프로덕션 + localhost)
- Vercel 환경변수(`AUTH_KAKAO_ID`, `AUTH_KAKAO_SECRET`) 등록 + Redeploy 완료
- 프로덕션 로그인 테스트 통과 (Playwright 자동 검증)

---

## 2026-04-25 이전

### 보고서 시스템 구축
- 보고서 양식·가이드 관리자 CRUD 페이지 (`feat(admin)`)
- 회원 보고서 양식·가이드 열람 + PDF 저장 기능 (`feat(member)`)
- Markdown 렌더링(rehype-raw) 및 양식 통합 리졸버 (`feat(markdown)`)
- 양식 삭제를 비공개 전환(soft-delete)으로 변경 (`fix`)
- 보고서 저장 방식·라우팅·품질 게이트 문서화 (`docs`)

### 보안 패치
- `/member/*` 경로 인증 보호 추가 (`fix(security)`)
- 보호 경로 회귀 점검 항목 문서화 (`docs`)

### 인프라
- `test-results`를 `.gitignore`에 추가
- 한국어 맞춤법 검사 스크립트 추가
