/** 실제 기수 Action의 SQL은 격리 PG로, Blob SDK PUT은 소유 loopback 공급자로만 전달합니다. */
import "./resource-qa-preload.mjs";
import { Socket } from "node:net";
import { join } from "node:path";
import { IncomingMessage } from "node:http";
import { appendFileSync } from "node:fs";
import { Agent, Dispatcher, setGlobalDispatcher } from "undici";

// 소비자를 추가하지 않고 서버 입력 push만 계수해 multipart 파일을 생략하는 CDP 표현과 구분합니다.
const received = new WeakMap();
const push = IncomingMessage.prototype.push;
IncomingMessage.prototype.push = function (chunk, encoding) {
  if (this.method === "POST" && this.headers["next-action"]) {
    const count = received.get(this) ?? 0;
    if (chunk !== null) received.set(this, count + Buffer.byteLength(chunk, encoding));
    else
      appendFileSync(
        join(process.cwd(), ".next/cohort-wire.jsonl"),
        `${JSON.stringify({ bytes: count, contentType: this.headers["content-type"] })}\n`,
      );
  }
  return push.call(this, chunk, encoding);
};

const app = new URL(process.env.AUTH_URL);
const store = new URL(process.env.HRA_G1_STORE_ORIGIN);
for (const url of [app, store])
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port)
    throw new Error("COHORT_QA_ORIGIN");
const socket = join(process.env.HRA_RESOURCE_QA_ROOT, `.s.PGSQL.${process.env.PGPORT}`);
const deny = () => {
  console.error("COHORT_QA_NETWORK_BLOCKED");
  return new Error("COHORT_QA_NETWORK_BLOCKED");
};
const connect = Socket.prototype.connect;
Socket.prototype.connect = function (...args) {
  const values = Array.isArray(args[0]) ? args[0] : args;
  const first = values[0];
  const options =
    first && typeof first === "object"
      ? { ...first }
      : typeof first === "string" && !/^\d+$/.test(first)
        ? { path: first }
        : { port: first, host: typeof values[1] === "string" ? values[1] : "localhost" };
  if (options.path !== undefined) {
    if (options.path !== socket) throw deny();
  } else {
    if (
      ![app.port, store.port].includes(String(options.port)) ||
      !["127.0.0.1", "localhost"].includes(options.host ?? "localhost")
    )
      throw deny();
    options.host = "127.0.0.1";
    delete options.lookup;
  }
  const callback = values.findLast((value) => typeof value === "function");
  return callback ? connect.call(this, options, callback) : connect.call(this, options);
};
const agent = new Agent();
class CohortDispatcher extends Dispatcher {
  dispatch(options, handler) {
    const url = new URL(options.path, String(options.origin));
    if (
      url.origin === "https://vercel.com" &&
      ["/api/blob", "/api/blob/"].includes(url.pathname) &&
      options.method === "PUT"
    ) {
      return agent.dispatch({ ...options, origin: store.origin }, handler);
    }
    if (url.origin === app.origin || url.origin === store.origin)
      return agent.dispatch(options, handler);
    handler.onError(deny());
    return false;
  }
}
// SDK dispatcher의 종료 계약은 Agent에 그대로 위임합니다.
const dispatcher = new CohortDispatcher();
dispatcher.close = (...args) => agent.close(...args);
dispatcher.destroy = (...args) => agent.destroy(...args);
setGlobalDispatcher(dispatcher);
