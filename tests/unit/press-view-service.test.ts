// @vitest-environment node
/**
 * 공개 기사 클릭의 예약 완료·차단·저장 오류를 서비스 경계에서 검증합니다.
 * 예약과 카운터는 별도 작업이며 저장 실패를 성공으로 숨기지 않아야 합니다.
 */
import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ reserve: vi.fn(), increment: vi.fn(), release: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  reservePressView: mocks.reserve,
  releaseSuccessfulLogin: mocks.release,
}));
vi.mock("@/features/press/view-repository", () => ({ incrementViewCount: mocks.increment }));

import { recordPressView } from "@/features/press/view-service";

const id = "81000000-0000-4000-8000-000000000001";
const ip = "203.0.113.1";
beforeEach(() => {
  vi.resetAllMocks();
  mocks.reserve.mockResolvedValue({ blocked: false, reservationId: id, retryAfterSec: 0 });
});

it("예약이 끝난 뒤에만 증가시키고 로그인 예약 해제는 사용하지 않는다", async () => {
  const pending = Promise.withResolvers<{ blocked: boolean }>();
  mocks.reserve.mockReturnValueOnce(pending.promise);
  const result = recordPressView(id, ip);
  expect(mocks.reserve).toHaveBeenCalledExactlyOnceWith(ip, id);
  expect(mocks.increment).not.toHaveBeenCalled();
  pending.resolve({ blocked: false });
  await expect(result).resolves.toBeUndefined();
  expect(mocks.increment).toHaveBeenCalledExactlyOnceWith(id);
  expect(mocks.release).not.toHaveBeenCalled();
});

it.each([false, true])(
  "제한 또는 예약 저장 장애(%s)는 증가 없이 void로 끝난다",
  async (unavailable) => {
    mocks.reserve.mockResolvedValueOnce({ blocked: true, unavailable });
    await expect(recordPressView(id, ip)).resolves.toBeUndefined();
    expect(mocks.increment).not.toHaveBeenCalled();
    expect(mocks.release).not.toHaveBeenCalled();
  },
);

it("증가 저장 오류는 전파하고 이미 소비한 예약은 해제하지 않는다", async () => {
  const error = new Error("합성 증가 저장 실패");
  mocks.increment.mockRejectedValueOnce(error);
  await expect(recordPressView(id, ip)).rejects.toBe(error);
  expect(mocks.release).not.toHaveBeenCalled();
});
