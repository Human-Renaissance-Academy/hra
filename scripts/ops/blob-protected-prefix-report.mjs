/**
 * 공개 Blob 저장소에 보호 자료 접두사의 객체가 남아 있는지 개수만 세는 읽기 전용 보고서 (#268).
 *
 * 역할:
 *   - 운영자가 공개 저장소 토큰(BLOB_READ_WRITE_TOKEN)으로 직접 실행한다. SDK 의 list 만 호출하며
 *     put/del/copy 는 import 하지 않는다.
 *   - 출력은 접두사별 개수·총 바이트뿐이다. 객체 URL·경로·파일명은 출력하지 않는다.
 *   - 접두사 정본은 scripts/migrate-protected-resource-blobs.mjs 의 protectedPrefixes 이며,
 *     단위 테스트가 두 목록의 일치를 검사한다(이전 스크립트는 import 시 실행되므로 복제했다).
 *
 * 저장소 확인: 표본·조회 객체의 URL 호스트가 공개 저장소 형식이 아니면 WRONG_STORE 로 실패한다(호스트 미출력).
 *   저장소가 완전히 비어 있으면 토큰의 저장소를 확인할 수 없어 STORE_EMPTY_UNVERIFIED 로 둔다.
 * 출력: stdout 에 JSON 한 개. 종료 코드 0=공개 잔존 0개(저장소 확인됨), 1=잔존·미확인·조회 실패, 2=입력 오류.
 */
import { pathToFileURL } from "node:url";

export const protectedPrefixes = [
  "class-materials/",
  "guidebooks/",
  "weekly-texts/",
  "class-logs/",
  "weekly-text-images/",
  "resource-uploads/class-materials/",
  "resource-uploads/guidebooks/",
  "resource-uploads/weekly-texts/",
];
// 한 접두사당 최대 조회 페이지 수. 비정상적으로 큰 저장소에서 무한 조회하지 않는다.
const MAX_PAGES = 50;
// 공개 저장소 객체의 호스트 접미사. 토큰이 비공개 저장소 것이면 "공개 잔존 0"을 잘못 보고하므로 확인한다.
const PUBLIC_HOST_SUFFIX = ".public.blob.vercel-storage.com";

/** 객체 URL 이 공개 저장소 호스트인지만 판정한다. 호스트 값은 반환·출력하지 않는다. */
function isPublicStoreUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname.endsWith(PUBLIC_HOST_SUFFIX);
  } catch {
    // 해석할 수 없는 URL 은 공개 저장소로 인정하지 않는다.
    return false;
  }
}

/** list 함수(테스트에서는 mock)로 접두사별 개수와 바이트 합계만 계산한다. */
export async function countPublicPrefixes(list, token) {
  const prefixes = {};
  let truncated = false;
  let wrongStore = false;
  // 접두사와 무관한 표본 1개로 토큰이 공개 저장소의 것인지 먼저 확인한다(저장소가 비어 있으면 확인 불가).
  const sample = await list({ limit: 1, token });
  const sampled = (sample.blobs ?? []).length > 0;
  if ((sample.blobs ?? []).some((blob) => !isPublicStoreUrl(blob.url))) wrongStore = true;
  for (const prefix of protectedPrefixes) {
    let cursor;
    let objects = 0;
    let bytes = 0;
    let pages = 0;
    do {
      const page = await list({ prefix, cursor, limit: 1000, token });
      for (const blob of page.blobs ?? []) {
        if (!isPublicStoreUrl(blob.url)) wrongStore = true;
        objects += 1;
        bytes += Number.isSafeInteger(blob.size) ? blob.size : 0;
      }
      cursor = page.hasMore ? page.cursor : undefined;
      pages += 1;
    } while (cursor && pages < MAX_PAGES);
    if (cursor) truncated = true;
    prefixes[prefix] = { objects, bytes };
  }
  const total = Object.values(prefixes).reduce((sum, item) => sum + item.objects, 0);
  if (wrongStore) {
    // 다른 저장소의 목록이므로 개수를 판정에 쓰지 않는다. 호스트는 출력하지 않는다.
    return {
      ok: false,
      code: "WRONG_STORE",
      storeVerified: false,
      total: null,
      truncated,
      prefixes: {},
    };
  }
  return {
    ok: total === 0 && !truncated && sampled,
    storeVerified: sampled,
    code: !sampled
      ? "STORE_EMPTY_UNVERIFIED"
      : truncated
        ? "TRUNCATED"
        : total === 0
          ? "NO_PUBLIC_PROTECTED_OBJECTS"
          : "PUBLIC_PROTECTED_OBJECTS_FOUND",
    total,
    truncated,
    prefixes,
  };
}

async function main() {
  const emit = (value) =>
    process.stdout.write(
      `${JSON.stringify({ schemaVersion: 1, tool: "blob-protected-prefix-report", ...value }, null, 2)}\n`,
    );
  if (process.argv.length !== 2) {
    emit({ ok: false, code: "USAGE" });
    process.exitCode = 2;
    return;
  }
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) {
    emit({ ok: false, code: "TOKEN_MISSING" });
    process.exitCode = 2;
    return;
  }
  const { list } = await import("@vercel/blob");
  try {
    const result = await countPublicPrefixes(list, token);
    emit(result);
    process.exitCode = result.ok ? 0 : 1;
  } catch (error) {
    // SDK 오류 원문에는 저장소 주소가 섞일 수 있어 오류 이름만 남긴다.
    emit({
      ok: false,
      code: "LIST_FAILED",
      error: error instanceof Error ? error.name : "UnknownError",
    });
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
