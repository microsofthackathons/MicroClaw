import { describe, expect, it, vi } from "vitest";
import { runStartupWarmup } from "./startup-warmup";

function createOptions() {
  return {
    showSetup: false,
    needsSetup: vi.fn().mockResolvedValue(false),
    beginWarming: vi.fn(() => true),
    warmUpAgent: vi.fn().mockResolvedValue(undefined),
    finishWarming: vi.fn(),
    markConnected: vi.fn(),
    onError: vi.fn(),
  };
}

describe("runStartupWarmup", () => {
  it("skips warm-up while setup is active", async () => {
    const options = createOptions();
    options.showSetup = true;

    await expect(runStartupWarmup(options)).resolves.toBe("skipped");
    expect(options.needsSetup).not.toHaveBeenCalled();
    expect(options.warmUpAgent).not.toHaveBeenCalled();
    expect(options.markConnected).toHaveBeenCalledOnce();
  });

  it("skips warm-up when no model is configured", async () => {
    const options = createOptions();
    options.needsSetup.mockResolvedValue(true);

    await expect(runStartupWarmup(options)).resolves.toBe("skipped");
    expect(options.beginWarming).not.toHaveBeenCalled();
    expect(options.warmUpAgent).not.toHaveBeenCalled();
    expect(options.markConnected).toHaveBeenCalledOnce();
  });

  it("dismisses startup immediately when warm-up rejects", async () => {
    const options = createOptions();
    const error = new Error("provider unauthorized");
    options.warmUpAgent.mockRejectedValue(error);

    await expect(runStartupWarmup(options)).resolves.toBe("failed");
    expect(options.onError).toHaveBeenCalledWith(error);
    expect(options.finishWarming).toHaveBeenCalledOnce();
    expect(options.markConnected).toHaveBeenCalledOnce();
  });

  it("skips safely when model eligibility cannot be checked", async () => {
    const options = createOptions();
    options.needsSetup.mockRejectedValue(new Error("config unavailable"));

    await expect(runStartupWarmup(options)).resolves.toBe("skipped");
    expect(options.warmUpAgent).not.toHaveBeenCalled();
    expect(options.markConnected).toHaveBeenCalledOnce();
  });
});
