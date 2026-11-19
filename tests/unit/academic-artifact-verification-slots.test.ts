// @vitest-environment node
/**
 * #516 V2 원본 검증의 인스턴스 동시 실행 상한을 검증합니다.
 * 원본 버퍼(≤50MiB)를 잡는 검증은 동시에 2개까지만 실행하고, 자리가 나지 않으면 멈추지 않고
 * 재시도 가능한 고정 오류(UNAVAILABLE, 503)를 돌려주며, 실패한 작업도 자리를 반납해야 합니다.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
vi.mock("@vercel/blob", () => ({ head: vi.fn(), get: vi.fn() }));
vi.mock("@/lib/academic-permissions", () => ({ requireAssignmentTarget: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { execute: vi.fn() } }));
import {
  ARTIFACT_VERIFICATION_QUEUE_TIMEOUT_MS,
  MAX_CONCURRENT_ARTIFACT_VERIFICATIONS,
  withArtifactVerificationSlot,
} from "@/features/academics/assignment-uploads/artifacts";

/** 외부에서 끝낼 수 있는 작업 */
function deferred() {
  let finish!: () => void;
  const promise = new Promise<void>((resolve) => {
    finish = resolve;
  });
  return { promise, finish };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("V2 원본 검증 동시 실행 상한", () => {
  it("두 개까지 바로 실행하고 세 번째는 자리가 날 때까지 기다린다", async () => {
    expect(MAX_CONCURRENT_ARTIFACT_VERIFICATIONS).toBe(2);
    const first = deferred();
    const second = deferred();
    let running = 0;
    let peak = 0;
    const job = (gate: Promise<void>) => async () => {
      running += 1;
      peak = Math.max(peak, running);
      await gate;
      running -= 1;
      return "완료";
    };
    const a = withArtifactVerificationSlot(job(first.promise));
    const b = withArtifactVerificationSlot(job(second.promise));
    let thirdStarted = false;
    const c = withArtifactVerificationSlot(async () => {
      thirdStarted = true;
      return "세 번째";
    });
    await Promise.resolve();
    expect(thirdStarted).toBe(false);
    first.finish();
    await expect(a).resolves.toBe("완료");
    await expect(c).resolves.toBe("세 번째");
    second.finish();
    await expect(b).resolves.toBe("완료");
    expect(peak).toBe(2);
  });

  it("대기 시간이 지나면 재시도 가능한 고정 오류로 끝내고, 실패한 작업도 자리를 반납한다", async () => {
    vi.useFakeTimers();
    const hold = deferred();
    const a = withArtifactVerificationSlot(() => hold.promise);
    const b = withArtifactVerificationSlot(async () => {
      throw new Error("검증 실패");
    });
    await expect(b).rejects.toThrow("검증 실패");
    const c = withArtifactVerificationSlot(() => hold.promise);
    const waiting = withArtifactVerificationSlot(async () => "실행되면 안 됨");
    const outcome = expect(waiting).rejects.toMatchObject({ code: "UNAVAILABLE", status: 503 });
    await vi.advanceTimersByTimeAsync(ARTIFACT_VERIFICATION_QUEUE_TIMEOUT_MS);
    await outcome;
    hold.finish();
    await Promise.all([a, c]);
    // 모두 반납되었으므로 다시 두 개를 바로 실행할 수 있다.
    await expect(
      Promise.all([
        withArtifactVerificationSlot(async () => 1),
        withArtifactVerificationSlot(async () => 2),
      ]),
    ).resolves.toEqual([1, 2]);
  });
});
