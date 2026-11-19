/**
 * Server Action 입력의 액션별 길이·개수 상한 상수 모음입니다 (#539).
 * 전역 본문 상한(5MiB)만으로는 한 필드가 요청 전체를 채울 수 있으므로,
 * 각 액션이 저장 전에 이 값으로 입력을 거부합니다. DB 제약은 바꾸지 않습니다.
 * 운영 데이터의 실제 최대 길이는 확인하지 못했으므로 정상 사용 범위보다 넉넉하게 잡았습니다.
 * 사용 위치: notices, class-logs, weekly-texts, faq, report-templates, applications,
 *           press, schedule 액션과 gallery·alumni·faq·press 정렬 액션,
 *           form-data-image-validation.
 */

/**
 * 마크다운 본문(공지 content, 수업일지 content, 주차별 텍스트 body, FAQ answer, 보고서 양식 body).
 * 본문 이미지는 에디터가 Blob에 직접 올리고 URL(수십~수백자)만 본문에 넣으므로
 * 100,000자는 일반 글의 수십 배이며 UTF-8 3바이트 기준 약 0.3MB로 본문 5MiB 안에서 여러 필드가 들어갑니다.
 * 기존 최대 사례는 내장 보고서 가이드 약 2,800자, 학사 과제 안내 상한 50,000자입니다.
 */
export const maxMarkdownBodyLength = 100_000;

/** 지원서 양식 description. 기수 설명(5,000)·갤러리 설명(5,000)과 같은 수준의 안내문 상한입니다. */
export const maxFormDescriptionLength = 5_000;

/** 지원서 질문 저장 상한. 실제 양식은 질문 수십 개 이하이며 질문 제목은 FAQ 질문(500)에 맞춥니다. */
export const applicationQuestionLimits = {
  /** 한 양식의 질문 수 */
  questions: 100,
  /** 질문 제목 길이 */
  title: 500,
  /** 질문 설명 길이 */
  description: 2_000,
  /** 질문 하나의 선택지 수 */
  options: 100,
} as const;

/** 언론보도 url·imageUrl. 교수진·모집 포스터 URL 상한(2,000)과 같습니다. */
export const maxUrlLength = 2_000;

/** 일정 상한. 하루 세션은 많아야 10개 안팎이라 50개면 충분합니다. */
export const scheduleLimits = {
  /** 일정 description (공지 성격의 안내문, 갤러리 설명 5,000의 2배) */
  description: 10_000,
  /** 케이스스터디 세션 subDescription */
  subDescription: 5_000,
  /** 한 일정의 세션 수 */
  sessions: 50,
} as const;

/**
 * 정렬 액션(faq·gallery·alumni·press)이 받는 UUID 배열의 최대 개수.
 * 가장 큰 목록인 앨범 한 개의 이미지도 수십~수백 장이므로 그 위로 넉넉히 잡았습니다.
 */
export const maxReorderIds = 1_000;

/** 수업일지·주차별 텍스트가 서버 경유로 받는 사진의 개수·합계 상한. 직접 업로드가 정상 경로입니다. */
export const serverImageLimits = {
  /** 한 번에 받는 사진 수 (갤러리 직접 업로드 배열 상한 100의 1/5) */
  count: 20,
  /** 사진 합계 바이트 (파일당 10MiB 상한의 2배) */
  totalBytes: 20 * 1024 * 1024,
} as const;
