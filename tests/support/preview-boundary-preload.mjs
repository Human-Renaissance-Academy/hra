/**
 * Preview HTTP 검증의 합성 외부 전송 감시자입니다. 앱 코드를 변경하지 않고
 * fetch·HTTP(S)·TCP의 외부 연결을 차단하고 고정 진단 코드만 출력합니다.
 * 기존 격리 PG 전송이 먼저 로드된 대조군에서는 정확한 합성 Neon 요청만 위임합니다.
 */
import http from "node:http";
import https from "node:https";
import net from "node:net";
import dns from "node:dns";
import dnsPromises from "node:dns/promises";
import { PassThrough, Writable } from "node:stream";
import { syncBuiltinESMExports } from "node:module";
import { qaNeonEndpoint } from "./neon-psql-transport.mjs";

const nativeFetch = globalThis.fetch;
const imageUrl =
  "https://4sompt13gxwuz2x8.public.blob.vercel-storage.com/preview-boundary-sentinel.png";
// 실제 공급자 대신 검증한 1픽셀 PNG를 반환하여 optimizer 양성 대조를 만듭니다.
const image = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWNgYGD4DwABBAEAfbLI3wAAAABJRU5ErkJggg==",
  "base64",
);
const local = (host) => ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host);
const mark = (code) => console.error(`PREVIEW_IO:${code}`);

/** Next 16의 SSRF 검사가 실제 외부 DNS를 조회하지 않도록 합성 공개 주소를 제공합니다. */
const lookup = dnsPromises.lookup;
dnsPromises.lookup = async (hostname, options) => {
  if (hostname === new URL(imageUrl).hostname) {
    mark("IMAGE_DNS");
    return options?.all
      ? [{ address: "93.184.216.34", family: 4 }]
      : { address: "93.184.216.34", family: 4 };
  }
  if (local(hostname)) return lookup(hostname, options);
  mark("DNS");
  throw new Error("PREVIEW_SENTINEL_DNS_BLOCKED");
};
const callbackLookup = dns.lookup;
dns.lookup = function (hostname, ...args) {
  if (local(hostname)) return callbackLookup.call(this, hostname, ...args);
  mark("DNS");
  const callback = args.at(-1);
  queueMicrotask(() => callback(new Error("PREVIEW_SENTINEL_DNS_BLOCKED")));
};

/** SQL은 대조군의 검토된 PG 어댑터로만 전달하고 나머지 외부 fetch는 거부합니다. */
globalThis.fetch = async (input, options) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (local(url.hostname)) return nativeFetch(input, options);
  if (url.href === imageUrl) {
    mark("IMAGE");
    return new Response(image, {
      headers: { "Content-Type": "image/png", "Cache-Control": "no-store" },
    });
  }
  if (url.href === qaNeonEndpoint) {
    mark("DB");
    if (process.env.HRA_RESOURCE_QA_ROOT) return nativeFetch(input, options);
    throw new Error("PREVIEW_SENTINEL_DB_BLOCKED");
  }
  mark("FETCH");
  throw new Error("PREVIEW_SENTINEL_EXTERNAL_BLOCKED");
};

/** fetch 외 전송도 차단합니다. 원문 URL·토큰·본문은 기록하지 않습니다. */
for (const transport of [http, https]) {
  const request = transport.request;
  transport.request = function (input, ...rest) {
    // 설치된 Next의 optimizer는 fetch가 아닌 https.request를 사용합니다.
    // 유효한 허용 URL에서 공급자 전송 단계까지 도달해야 이 응답을 받을 수 있습니다.
    if ((typeof input === "string" || input instanceof URL) && String(input) === imageUrl) {
      mark("IMAGE");
      const response = new PassThrough();
      response.statusCode = 200;
      response.headers = { "content-type": "image/png", "cache-control": "no-store" };
      return new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
        final(done) {
          done();
          queueMicrotask(() => {
            rest.find((argument) => typeof argument === "function")?.(response);
            response.end(image);
          });
        },
      });
    }
    const host =
      typeof input === "string" || input instanceof URL
        ? new URL(input).hostname
        : (input?.hostname ?? input?.host ?? "localhost");
    if (!local(host)) {
      mark("HTTP");
      throw new Error("PREVIEW_SENTINEL_HTTP_BLOCKED");
    }
    return request.call(this, input, ...rest);
  };
  transport.get = function (...args) {
    const request = transport.request(...args);
    request.end();
    return request;
  };
}
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const options = Array.isArray(args[0]) ? args[0][0] : args[0];
  const host =
    typeof options === "object" ? options?.host : typeof args[1] === "string" ? args[1] : undefined;
  if (host && !local(host)) {
    mark("TCP");
    throw new Error("PREVIEW_SENTINEL_TCP_BLOCKED");
  }
  return connect.apply(this, args);
};
syncBuiltinESMExports();
