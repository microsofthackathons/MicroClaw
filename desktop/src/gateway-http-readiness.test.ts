import { describe, expect, it, vi } from "vitest";
import { waitForGatewayHttpReadiness } from "./gateway-http-readiness";

function clock() {
  let value = 0;
  return {
    now: () => value,
    sleep: vi.fn(async (milliseconds: number) => {
      value += milliseconds;
    }),
  };
}

describe("Gateway HTTP readiness", () => {
  it("waits through delayed health responses", async () => {
    const time = clock();
    const probe = vi
      .fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(false)
      .mockResolvedValue(true);

    await expect(
      waitForGatewayHttpReadiness({
        probe,
        isProcessAlive: () => true,
        timeoutMs: 5_000,
        pollIntervalMs: 500,
        ...time,
      }),
    ).resolves.toBe(true);

    expect(probe).toHaveBeenCalledTimes(3);
    expect(time.sleep).toHaveBeenCalledTimes(2);
  });

  it("stops immediately when the managed process exits", async () => {
    const probe = vi.fn();

    await expect(
      waitForGatewayHttpReadiness({
        probe,
        isProcessAlive: () => false,
        timeoutMs: 5_000,
        pollIntervalMs: 500,
      }),
    ).resolves.toBe(false);

    expect(probe).not.toHaveBeenCalled();
  });

  it("returns false at the bounded deadline", async () => {
    const time = clock();

    await expect(
      waitForGatewayHttpReadiness({
        probe: vi.fn().mockResolvedValue(false),
        isProcessAlive: () => true,
        timeoutMs: 1_200,
        pollIntervalMs: 500,
        ...time,
      }),
    ).resolves.toBe(false);
  });
});
