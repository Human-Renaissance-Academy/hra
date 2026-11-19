/**
 * 운영자 점검 스크립트(scripts/ops)가 앱의 TypeScript 모듈(예: 문서 형식 탐지)을 그대로 불러오기 위한 로더 (#516 PR-H).
 *
 * 역할:
 *   - Node 의 동기 모듈 훅(`module.registerHooks`)으로 `.ts` 파일을 `typescript` 의 transpileModule 로 변환해 싣는다.
 *   - 확장자 없는 상대 import(`./cfb`)를 `.ts` 로 해석하고, `server-only` 표식은 빈 모듈로 대체한다.
 *   - 새 의존성 없이 이미 설치된 `typescript` 만 사용한다. 타입 검사는 하지 않는다(변환만).
 * 사용 위치: scripts/ops/hancom-sample-check.mjs, scripts/ops/academic-artifact-read-benchmark.mjs
 * 주의: 앱 번들이 아니라 운영자 로컬 Node 에서만 쓴다. 한 프로세스에서 한 번만 등록한다.
 */
import { existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** 변환을 허용하는 저장소 루트 URL(이 파일 기준 두 단계 위) */
const REPO_ROOT_URL = new URL("../../", import.meta.url).href;

let registered = false;

/** 훅을 한 번만 등록한다. */
export function registerTypeScriptLoader() {
  if (registered) return;
  registered = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      // Next 의 서버 전용 표식은 점검 스크립트에서 의미가 없으므로 빈 모듈로 둔다.
      if (specifier === "server-only") return { url: "data:text/javascript,", shortCircuit: true };
      // 확장자 없는 상대 경로는 .ts 파일로 해석한다.
      if (
        specifier.startsWith(".") &&
        context.parentURL?.endsWith(".ts") &&
        !/\.[a-z]+$/.test(specifier)
      ) {
        const candidate = new URL(`${specifier}.ts`, context.parentURL);
        if (existsSync(fileURLToPath(candidate)))
          return { url: candidate.href, shortCircuit: true };
      }
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (!url.endsWith(".ts")) return nextLoad(url, context);
      // 저장소 루트 밖의 .ts 파일은 변환하지 않는다(임의 경로 코드 실행 방지).
      if (!url.startsWith(REPO_ROOT_URL)) return nextLoad(url, context);
      const source = readFileSync(fileURLToPath(url), "utf8");
      const output = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
      });
      return { format: "module", source: output.outputText, shortCircuit: true };
    },
  });
}

/** 형식 탐지 모듈(detect.ts)을 불러온다. */
export async function loadDocumentFormats() {
  registerTypeScriptLoader();
  const url = new URL(
    "../../src/features/academics/assignment-uploads/formats/detect.ts",
    import.meta.url,
  );
  return import(url.href);
}
