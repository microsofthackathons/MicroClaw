import { describe, expect, it, vi } from "vitest";
import { watchStartupServiceReadiness } from "./startup-service-readiness";

describe("watchStartupServiceReadiness", () => {
  it("completes startup when services are ready even if chat ingress remains locked", async () => {
    const completeStartup = vi.fn();

    watchStartupServiceReadiness({
      isServiceReady: vi.fn().mockResolvedValue(true),
      onServiceReady: vi.fn(() => vi.fn()),
      completeStartup,
    });
    await vi.waitFor(() => expect(completeStartup).toHaveBeenCalledOnce());
  });

  it("waits for the service-ready event when the initial query is false", async () => {
    let serviceReady: (() => void) | undefined;
    const completeStartup = vi.fn();

    watchStartupServiceReadiness({
      isServiceReady: vi.fn().mockResolvedValue(false),
      onServiceReady: vi.fn((callback) => {
        serviceReady = callback;
        return vi.fn();
      }),
      completeStartup,
    });
    await Promise.resolve();
    expect(completeStartup).not.toHaveBeenCalled();

    serviceReady?.();
    expect(completeStartup).toHaveBeenCalledOnce();
  });

  it("deduplicates the initial query and service-ready event", async () => {
    let serviceReady: (() => void) | undefined;
    const completeStartup = vi.fn();

    watchStartupServiceReadiness({
      isServiceReady: vi.fn().mockResolvedValue(true),
      onServiceReady: vi.fn((callback) => {
        serviceReady = callback;
        return vi.fn();
      }),
      completeStartup,
    });
    serviceReady?.();
    await Promise.resolve();

    expect(completeStartup).toHaveBeenCalledOnce();
  });

  it("completes again after an actual lifecycle resets the readiness epoch", async () => {
    let serviceReady: (() => void) | undefined;
    let epoch = 0;
    const completeStartup = vi.fn();
    watchStartupServiceReadiness({
      readinessEpoch: () => epoch,
      isServiceReady: vi.fn().mockResolvedValue(true),
      onServiceReady: (callback) => {
        serviceReady = callback;
        return vi.fn();
      },
      completeStartup,
    });
    await Promise.resolve();
    serviceReady?.();
    expect(completeStartup).toHaveBeenCalledTimes(1);
    epoch += 1;
    serviceReady?.();
    serviceReady?.();
    expect(completeStartup).toHaveBeenCalledTimes(2);
  });

  it("ignores an initial readiness reply from before the transition gate reset", async () => {
    let serviceReady: (() => void) | undefined;
    let resolveReady!: (ready: boolean) => void;
    let epoch = 0;
    const completeStartup = vi.fn();
    watchStartupServiceReadiness({
      readinessEpoch: () => epoch,
      isServiceReady: () =>
        new Promise((resolve) => {
          resolveReady = resolve;
        }),
      onServiceReady: (callback) => {
        serviceReady = callback;
        return vi.fn();
      },
      completeStartup,
    });
    epoch += 1;
    resolveReady(true);
    await Promise.resolve();
    expect(completeStartup).not.toHaveBeenCalled();
    serviceReady?.();
    expect(completeStartup).toHaveBeenCalledOnce();
  });
});
