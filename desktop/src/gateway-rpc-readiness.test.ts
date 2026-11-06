import { describe, expect, it, vi } from "vitest";
import {
  GatewayRpcReadinessCancelledError,
  startAfterGatewayRpcReady,
  waitForGatewayRpcReadiness,
} from "./gateway-rpc-readiness";

function clock() {
  let value = 0;
  return {
    now: () => value,
    sleep: vi.fn(async (milliseconds: number) => {
      value += milliseconds;
    }),
  };
}

describe("Gateway authenticated RPC readiness", () => {
  it("retries HTTP-ready but RPC-delayed generations before succeeding", async () => {
    const time = clock();
    const probe = vi
      .fn<(timeoutMs: number) => Promise<void>>()
      .mockRejectedValueOnce(new Error("dispatcher busy"))
      .mockRejectedValueOnce(new Error("compatibility modules loading"))
      .mockResolvedValue(undefined);

    await expect(
      waitForGatewayRpcReadiness({
        probe,
        isCurrent: () => true,
        timeoutMs: 10_000,
        attemptTimeoutMs: 2_000,
        initialBackoffMs: 250,
        maxBackoffMs: 1_000,
        ...time,
      }),
    ).resolves.toEqual({ attempts: 3, elapsedMs: 750 });

    expect(probe).toHaveBeenCalledTimes(3);
  });

  it("never starts the bundled node until authenticated RPC responds", async () => {
    let releaseProbe!: () => void;
    const probe = new Promise<void>((resolve) => {
      releaseProbe = resolve;
    });
    const start = vi.fn().mockResolvedValue(undefined);
    const startup = startAfterGatewayRpcReady({
      probe: () => probe,
      start,
      isCurrent: () => true,
      timeoutMs: 10_000,
      attemptTimeoutMs: 5_000,
      initialBackoffMs: 250,
      maxBackoffMs: 1_000,
    });

    await Promise.resolve();
    expect(start).not.toHaveBeenCalled();
    releaseProbe();
    await startup;
    expect(start).toHaveBeenCalledOnce();
  });

  it("times out without starting the bundled node", async () => {
    const time = clock();
    const start = vi.fn();

    await expect(
      startAfterGatewayRpcReady({
        probe: vi.fn(async () => {
          await time.sleep(1_000);
          throw new Error("RPC unavailable");
        }),
        start,
        isCurrent: () => true,
        timeoutMs: 2_500,
        attemptTimeoutMs: 1_000,
        initialBackoffMs: 250,
        maxBackoffMs: 500,
        ...time,
      }),
    ).rejects.toThrow(/authenticated RPC readiness timed out/);
    expect(start).not.toHaveBeenCalled();
  });

  it("cancels stale generations before node launch", async () => {
    let current = true;
    const start = vi.fn();

    await expect(
      startAfterGatewayRpcReady({
        probe: async () => {
          current = false;
        },
        start,
        isCurrent: () => current,
        timeoutMs: 10_000,
        attemptTimeoutMs: 5_000,
        initialBackoffMs: 250,
        maxBackoffMs: 1_000,
      }),
    ).rejects.toBeInstanceOf(GatewayRpcReadinessCancelledError);
    expect(start).not.toHaveBeenCalled();
  });
});
