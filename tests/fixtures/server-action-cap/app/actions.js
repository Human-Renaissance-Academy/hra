"use server";

/** 파서 시험 전용 액션입니다. 진입 즉시 소유 파일에 기록하고 받은 값의 크기·해시를 반환합니다. */
import { appendFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

export async function inspectPayload(input) {
  appendFileSync(join(process.cwd(), "invocations.jsonl"), "entry\n");
  const padding = typeof input === "string" ? input : input.get("padding");
  if (typeof padding !== "string") throw new Error("CAP_FIXTURE_INPUT");
  const result = {
    bytes: Buffer.byteLength(padding),
    sha256: createHash("sha256").update(padding).digest("hex"),
  };
  appendFileSync(join(process.cwd(), "entries.jsonl"), `${JSON.stringify(result)}\n`);
  return result;
}
