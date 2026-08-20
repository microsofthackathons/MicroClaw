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
});
