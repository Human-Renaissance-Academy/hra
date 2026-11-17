/** 파서 fixture의 Node 전송을 소유 앱 loopback 포트 하나로 제한합니다. 운영에서는 import하지 않습니다. */
import { Socket } from "node:net";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";

const app = new URL(process.env.AUTH_URL);
if (app.protocol !== "http:" || app.hostname !== "127.0.0.1" || !app.port)
  throw new Error("CAP_NETWORK_CONFIG");
const fail = () => {
  console.error("CAP_NETWORK_BLOCKED");
  return new Error("CAP_NETWORK_BLOCKED");
};
const connect = Socket.prototype.connect;
Socket.prototype.connect = function (...args) {
  const values = Array.isArray(args[0]) ? args[0] : args;
  const first = values[0];
  const options =
    first && typeof first === "object"
      ? { ...first }
      : { port: first, host: typeof values[1] === "string" ? values[1] : "localhost" };
  if (
    options.path ||
    Number(options.port) !== Number(app.port) ||
    !["127.0.0.1", "localhost"].includes(options.host ?? "localhost")
  )
    throw fail();
  options.host = "127.0.0.1";
  delete options.lookup;
  const callback = values.findLast((value) => typeof value === "function");
  return callback ? connect.call(this, options, callback) : connect.call(this, options);
};
const original = getGlobalDispatcher();
setGlobalDispatcher({
  dispatch(options, handler) {
    if (String(options.origin) !== app.origin) {
      handler.onError(fail());
      return false;
    }
    return original.dispatch(options, handler);
  },
  close: (...args) => original.close(...args),
  destroy: (...args) => original.destroy(...args),
});
