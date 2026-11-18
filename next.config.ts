/**
 * ======================================================
 * Next.js 프레임워크 설정 파일
 * ======================================================
 *
 * Next.js 프레임워크의 동작 방식을 커스터마이징하는 파일입니다.
 * 여기서 설정할 수 있는 것들:
 *
 * - 이미지 로딩할 때 사용 가능한 도메인 설정
 * - URL 리다이렉트 규칙 (옛날 주소 → 새로운 주소)
 * - 환경변수 설정
 * - 빌드 최적화 옵션
 * - 웹팩 설정 (고급)
 *
 * 현재는 기본 설정만 사용 중이므로, 필요한 것이 생기면 여기에 추가하면 됩니다.
 * 예를 들어, 외부 이미지를 사용하면 domains 배열에 도메인을 등록해야 합니다.
 */

import type { NextConfig } from "next";
import { projectBlobHost } from "./src/lib/blob-host";
import { isRestrictedPreview } from "./src/lib/preview-boundary";

// HTML nonce 정책은 Proxy가 요청별로 제공한다. 파일 API의 임베드 경계만 정적으로 둔다.
// 자료실 PDF 미리보기(`?inline=1`)는 같은 출처의 자료실 페이지 iframe에만 임베드한다.
// Chromium은 sandbox CSP에서도 PDF를 표시했지만 Firefox·Safari 뷰어 호환성은 확인 전이라(#513) 기존 값을 유지한다.
const inlinePdfCsp =
  "frame-ancestors 'self'; base-uri 'self'; object-src 'none'; form-action 'self'";
// 그 외 자료실 첨부 다운로드·이미지는 문서로 열려도 스크립트·하위 리소스가 실행되지 않도록
// API v1 파일·학사 제출 파일과 같은 sandbox 경계를 둔다. 같은 출처 임베드 허용 범위는 유지한다.
const attachmentCsp = "sandbox; default-src 'none'; frame-ancestors 'self'";
// Auth.js의 API HTML 응답에도 기존 정적 보호를 유지한다. HTML nonce 경로와는 겹치지 않는다.
const apiCsp = "frame-ancestors 'none'; base-uri 'self'; object-src 'none'; form-action 'self'";

const nextConfig: NextConfig = {
  // 내부 contracts workspace의 TypeScript 원본을 Web 서버·클라이언트 번들에 포함합니다.
  transpilePackages: ["@hra/contracts"],
  async rewrites() {
    // 빌드·실행 환경이 같은 Preview만 지원합니다. Production 승격 시 반드시 다시 빌드합니다.
    // API를 Proxy matcher에 추가하지 않아 운영 요청의 본문 buffer 범위를 유지합니다.
    // 알 수 없는 _next 경로의 Page 진입도 거부하되 실제 정적 chunk 처리는 보존합니다.
    const beforeFiles = isRestrictedPreview(process.env.VERCEL, process.env.VERCEL_ENV)
      ? ["/api/:path*", "/_next", "/_next/:path((?!static(?:/|$)).*)"].map((source) => ({
          source,
          destination: "/preview-unavailable",
        }))
      : [];
    return { beforeFiles, afterFiles: [], fallback: [] };
  },
  async headers() {
    return [
      {
        source: "/api/:path*",
        headers: [{ key: "Content-Security-Policy", value: apiCsp }],
      },
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
      {
        // 자료실 파일은 기본적으로 sandbox 첨부 경계를 적용합니다. PDF는 같은 출처에만 임베드합니다.
        source: "/api/resources/:kind/:id/download",
        headers: [
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
          { key: "Content-Security-Policy", value: attachmentCsp },
        ],
      },
      {
        // `inline=1` 미리보기 요청만 뒤에서 PDF 뷰어용 정책으로 덮어씁니다.
        // Next는 같은 query가 반복되면 마지막 값을, Route는 첫 값을 읽습니다. 두 값이 어긋나면
        // sandbox가 붙은 PDF 또는 기존 정책의 첨부 다운로드가 되므로 보호가 약해지지 않습니다.
        source: "/api/resources/:kind/:id/download",
        has: [{ type: "query", key: "inline", value: "1" }],
        headers: [{ key: "Content-Security-Policy", value: inlinePdfCsp }],
      },
      {
        // Next의 정적 헤더가 Route 응답보다 우선하므로 학사 파일 sandbox를 마지막에 고정한다.
        source: "/api/academic/submissions/:id/file/:fileId",
        headers: [{ key: "Content-Security-Policy", value: "sandbox; default-src 'none'" }],
      },
      {
        // 버전 API도 같은 개인 파일을 전달하므로 일반 API 헤더 뒤에서 sandbox를 고정합니다.
        source: "/api/v1/submissions/:id/files/:fileId",
        headers: [{ key: "Content-Security-Policy", value: "sandbox; default-src 'none'" }],
      },
      // 공동 자료 API v1 파일도 첨부 스트림이므로 일반 API CSP 뒤에서 같은 sandbox를 고정합니다.
      {
        source: "/api/v1/resources/guidebooks/:id/file",
        headers: [{ key: "Content-Security-Policy", value: "sandbox; default-src 'none'" }],
      },
      {
        source: "/api/v1/resources/class-materials/:id/file",
        headers: [{ key: "Content-Security-Policy", value: "sandbox; default-src 'none'" }],
      },
      {
        source: "/api/v1/resources/weekly-texts/:id/file",
        headers: [{ key: "Content-Security-Policy", value: "sandbox; default-src 'none'" }],
      },
    ];
  },
  experimental: {
    // 원본 문서는 Blob으로 직접 전송하고, Action은 메타데이터 중심으로 받습니다.
    // 기수 폼의 4MiB 이미지와 multipart 여유를 포함해 전체 본문은 5MiB로 제한합니다.
    // 이 상한은 파일별 검증과 별개이며 큰 raw 호환 요청은 액션 실행 전에 거부됩니다.
    serverActions: {
      bodySizeLimit: "5mb",
    },
  },
  // Preview의 원격·동적 이미지 대상을 허용하지 않습니다. 자동 추가된 빌드 정적 패턴은 배포에서 확인합니다.
  images: isRestrictedPreview(process.env.VERCEL, process.env.VERCEL_ENV)
    ? { unoptimized: true, remotePatterns: [], localPatterns: [] }
    : {
        remotePatterns: [
          {
            protocol: "https",
            hostname: projectBlobHost,
          },
        ],
      },
};

export default nextConfig;
