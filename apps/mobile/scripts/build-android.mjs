/**
 * 생성된 Gradle wrapper를 Android 디렉터리에서 실행하고 실제 종료 코드를 전달합니다.
 * - 인자 없음: CI 컴파일 검증용 debug APK (Metro 개발 서버 필요)
 * - `release`: 내부 설치 테스트용 release APK (#573). JS 번들을 포함하므로 기기 단독 실행이 가능합니다.
 *   서명은 Expo 템플릿 기본(공개 debug keystore)이라 스토어 업로드·배포에 쓰지 않습니다.
 *   실제 기기 대부분이 arm64이므로 arm64-v8a만 빌드해 CI 시간과 APK 크기를 줄입니다.
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// 허용한 변형만 받습니다. 오타가 조용히 debug 빌드로 바뀌지 않도록 알 수 없는 값은 거부합니다.
const VARIANT_TASKS = {
  debug: ['assembleDebug'],
  release: ['assembleRelease', '-PreactNativeArchitectures=arm64-v8a'],
};
const args = process.argv.slice(2);
const variant = args[0] ?? 'debug';
if (args.length > 1 || !Object.hasOwn(VARIANT_TASKS, variant)) {
  console.error(`알 수 없는 Android 빌드 변형입니다: ${args.join(' ')}`);
  process.exit(2);
}

const result = spawnSync('./gradlew', [...VARIANT_TASKS[variant], '--no-daemon', '--max-workers=2', '--stacktrace', '--console=plain'], {
  cwd: fileURLToPath(new URL('../android', import.meta.url)),
  stdio: 'inherit',
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
