/**
 * 공유 카드(Open Graph / Twitter) 기본 이미지 상수.
 *
 * - 이미지 원본은 `src/app/opengraph-image.tsx` 파일 컨벤션이 만드는 같은 출처의
 *   `/opengraph-image` 경로(1200x630 PNG)입니다. 상대 경로이므로 루트 레이아웃의
 *   `metadataBase`와 합쳐져 환경별(Production/Preview) 절대 URL이 됩니다.
 * - 사용 이유: Next.js의 파일 컨벤션 이미지는 그 파일이 있는 루트 세그먼트에만 주입되고,
 *   페이지가 `openGraph`/`twitter` 객체를 직접 선언하면 상위 값 전체가 대체되어
 *   이미지가 사라집니다(#414: 홈·공지 상세). 그래서 `openGraph`/`twitter`를 직접 선언하는
 *   페이지는 이 상수를 `images`에 명시해 이미지를 유지합니다.
 * - 사용 위치: 홈, 공지 상세, 갤러리 상세(사진이 없는 앨범의 대체 이미지).
 */

/** 기본 공유 이미지 경로(같은 출처이므로 CSP img-src 'self'로 허용됨). */
export const DEFAULT_SHARE_IMAGE_PATH = "/opengraph-image";

/** 공유 이미지 대체 텍스트. `opengraph-image.tsx`의 alt와 같은 값을 유지합니다. */
export const DEFAULT_SHARE_IMAGE_ALT = "HRA - Human Renaissance Academy";

/** `openGraph.images`에 그대로 넘기는 기본 이미지 목록. */
export const defaultOpenGraphImages = [
  {
    url: DEFAULT_SHARE_IMAGE_PATH,
    width: 1200,
    height: 630,
    alt: DEFAULT_SHARE_IMAGE_ALT,
  },
];

/** `twitter.images`에 그대로 넘기는 기본 이미지 목록. */
export const defaultTwitterImages = [DEFAULT_SHARE_IMAGE_PATH];
