import { describe, expect, it, vi } from "vitest";
import { applyLiveSandboxMode, type LiveSandboxModeHooks } from "./windows-node-mxc-live-mode";

function hooks() {
  const calls: string[] = [];
  const step = (name: string) =>
    vi.fn(async () => {
      calls.push(name);
    });
  const status = { active: true };
  const operations: LiveSandboxModeHooks<typeof status> = {
    preflight: step("preflight"),
    lock: step("lock"),
    persist: step("persist"),
    publish: step("publish"),
    verify: vi.fn(async () => {
      calls.push("verify");
      return status;
    }),
    release: vi.fn(async () => {
      calls.push("release");
    }),
    failClosed: vi.fn(async () => {
      calls.push("failClosed");
    }),
  };
  return { calls, operations, status };
}

describe("live sandbox mode transaction", () => {
  it("locks before persisting, publishes and verifies before releasing", async () => {
    const { calls, operations, status } = hooks();
    await expect(applyLiveSandboxMode(operations)).resolves.toBe(status);
    expect(calls).toEqual(["preflight", "lock", "persist", "publish", "verify", "release"]);
    expect(operations.release).toHaveBeenCalledWith(status);
  });

  it("does not mutate or relock when preflight fails", async () => {
    const { calls, operations } = hooks();
    const error = new Error("unsupported");
    vi.mocked(operations.preflight).mockRejectedValue(error);
    await expect(applyLiveSandboxMode(operations)).rejects.toBe(error);
    expect(calls).toEqual([]);
    expect(operations.failClosed).not.toHaveBeenCalled();
  });

  it.each(["lock", "persist", "publish", "verify", "release"] as const)(
    "fails closed if %s fails",
    async (stage) => {
      const { calls, operations } = hooks();
      const error = new Error(`${stage} failed`);
      vi.mocked(operations[stage]).mockRejectedValue(error);
      await expect(applyLiveSandboxMode(operations)).rejects.toBe(error);
      expect(calls.at(-1)).toBe("failClosed");
      expect(operations.failClosed).toHaveBeenCalledWith(error);
      if (stage !== "release") expect(operations.release).not.toHaveBeenCalled();
    },
  );

  it("reports both the transition and recovery failure", async () => {
    const { operations } = hooks();
    const transitionError = new Error("publish failed");
    const recoveryError = new Error("lock failed");
    vi.mocked(operations.publish).mockRejectedValue(transitionError);
    vi.mocked(operations.failClosed).mockRejectedValue(recoveryError);
    await expect(applyLiveSandboxMode(operations)).rejects.toMatchObject({
      errors: [transitionError, recoveryError],
      cause: recoveryError,
    });
  });
});
