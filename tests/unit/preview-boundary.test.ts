// @vitest-environment node
/** 정확한 환경 조합과 인증 전 거부, 순수 응답·rewrite 계약을 검증합니다. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { NextFetchEvent } from "next/dist/server/web/spec-extension/fetch-event";
import {
  isRestrictedPreview,
  isSafePreviewMetadata,
  previewUnavailableResponse,
} from "@/lib/preview-boundary";
import * as route from "../../src/app/preview-unavailable/route";
import nextConfig from "../../next.config";
import { collectEnvironmentReferences } from "../../scripts/_lib/environment-contract.mjs";
import { environmentInventory } from "../../scripts/_lib/environment-inventory.mjs";

const calls = vi.hoisted(() => ({ wrapper: vi.fn(), session: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  auth: (next: () => Response) => {
    calls.wrapper();
    return () => {
      calls.session();
      return next();
    };
  },
}));
import proxy from "../../src/proxy";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it("Preview QA의 정확한 시스템 복사만 허용하고 새 키·추가 동적 접근은 거부한다", () => {
  const path = "scripts/verify-preview-boundary-http.mjs";
  const exception = environmentInventory.dynamicAccess.find((entry) => entry.path === path);
  if (!exception) throw new Error("PREVIEW_QA_ENVIRONMENT_CONTRACT_MISSING");
  const text = readFileSync(path, "utf8");
  expect(collectEnvironmentReferences([{ path, text }], [exception]).errors).toEqual([]);
  for (const changed of [
    text.replace('"PATH"', '"UNREVIEWED_DYNAMIC_SETTING"'),
    `${text}\nconst unexpected = process.env[extraName];`,
  ]) {
    expect(
      collectEnvironmentReferences([{ path, text: changed }], [exception]).errors.length,
    ).toBeGreaterThan(0);
  }
});

it("정확한 플랫폼 값의 조합만 Preview로 판정한다", () => {
  for (const vercel of [undefined, "", "0", "true", " 1", "1 ", "1"]) {
    for (const environment of [undefined, "", "Preview", "preview ", "production", "preview"]) {
      expect(isRestrictedPreview(vercel, environment)).toBe(
        vercel === "1" && environment === "preview",
      );
    }
  }
});

it("안전 읽기는 정확한 두 metadata의 GET/HEAD뿐이다", () => {
  for (const path of [
    "/robots.txt",
    "/sitemap.xml",
    "/robots.txt/",
    "/sitemap.xml/child",
    "/opengraph-image",
    "/missing.pdf",
  ]) {
    for (const method of ["GET", "HEAD", "POST", "OPTIONS", "get"]) {
      expect(isSafePreviewMetadata(path, method)).toBe(
        ["/robots.txt", "/sitemap.xml"].includes(path) && ["GET", "HEAD"].includes(method),
      );
    }
  }
});

it("Preview HTML·Action은 인증 래퍼 생성과 본문 읽기 전에 거부한다", async () => {
  vi.stubEnv("VERCEL", "1");
  vi.stubEnv("VERCEL_ENV", "preview");
  for (const path of [
    "/",
    "/login",
    "/admin",
    "/resources/x",
    "/member/x",
    "/mypage",
    "/opengraph-image",
    "/robots.txt",
  ]) {
    for (const method of ["POST", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const request = new NextRequest(`https://fixture.invalid${path}`, {
        method,
        body: "미해석 본문",
        headers: {
          cookie: "authjs.session-token=synthetic",
          "next-action": "synthetic",
          rsc: "1",
          "x-vercel-env": "production",
        },
      });
      const readers = (["clone", "text", "json", "formData", "arrayBuffer"] as const).map((name) =>
        vi.spyOn(request, name),
      );
      const response = await proxy(
        request,
        new NextFetchEvent({ request, page: path, context: undefined }),
      );
      expect(response.status).toBe(503);
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("location")).toBeNull();
      expect(request.bodyUsed).toBe(false);
      for (const reader of readers) expect(reader).not.toHaveBeenCalled();
    }
  }
  expect(calls.wrapper).not.toHaveBeenCalled();
  expect(calls.session).not.toHaveBeenCalled();
});

it("한국어 503은 모든 메서드에서 no-store/noindex이며 HEAD만 본문이 없다", async () => {
  for (const method of ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const) {
    const request = new Request("https://fixture.invalid/preview-unavailable", { method });
    const response = route[method](request);
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(await response.text()).toBe(
      method === "HEAD" ? "" : "미리보기에서는 서비스 기능을 제공하지 않습니다.",
    );
  }
  expect(previewUnavailableResponse("GET").headers.has("retry-after")).toBe(false);
});

it("순수 경계와 거부 route의 의존성에 인증·DB·SDK가 없다", () => {
  for (const path of ["src/lib/preview-boundary.ts", "src/app/preview-unavailable/route.ts"]) {
    const source = readFileSync(path, "utf8");
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((match) => match[1]);
    expect(imports).toEqual(path.endsWith("route.ts") ? ["@/lib/preview-boundary"] : []);
    expect(source).not.toMatch(/\bimport\s*\(|\brequire\s*\(|\bfetch\s*\(/);
    expect(source).not.toMatch(/\.(?:json|formData|text|arrayBuffer|clone)\(/);
  }
});

describe("빌드 전용 rewrite", () => {
  it("Preview에서만 API·최적화 이미지·data를 순수 route로 보내며 loop가 없다", async () => {
    for (const [vercel, environment] of [
      ["1", "preview"],
      ["1", "production"],
      ["", "preview"],
      ["", ""],
    ]) {
      vi.stubEnv("VERCEL", vercel);
      vi.stubEnv("VERCEL_ENV", environment);
      expect(await nextConfig.rewrites?.()).toEqual({
        beforeFiles:
          vercel === "1" && environment === "preview"
            ? ["/api/:path*", "/_next", "/_next/:path((?!static(?:/|$)).*)"].map((source) => ({
                source,
                destination: "/preview-unavailable",
              }))
            : [],
        afterFiles: [],
        fallback: [],
      });
    }
  });
});
