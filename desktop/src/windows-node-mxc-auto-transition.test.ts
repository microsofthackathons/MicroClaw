import { describe, expect, it, vi } from "vitest";
import { runWindowsNodeMxcAutomaticTransition } from "./windows-node-mxc-auto-transition";

describe("automatic Windows Node + MXC transition", () => {
  it("keeps one generation locked until its policy is promoted and verified", async () => {
    const calls: string[] = [];
    const status = await runWindowsNodeMxcAutomaticTransition({
      setPhase: (phase) => calls.push(`phase:${phase}`),
      closeIngress: async () => {
        calls.push("close");
      },
      startLockedGeneration: async () => {
        calls.push("start-locked");
        return "locked";
      },
      smokeLockedGeneration: async () => {
        calls.push("smoke-locked");
      },
      promoteActivePolicy: async () => {
        calls.push("promote-active");
        return "active";
      },
      smokeActivePolicy: async () => {
        calls.push("smoke-active");
      },
      mintActivationLease: async () => {
        calls.push("lease");
      },
      verifyActiveGeneration: async () => {
        calls.push("verify");
        return "verified";
      },
      releaseIngress: async () => {
        calls.push("release");
      },
      lockAfterFailure: vi.fn(),
    });

    expect(status).toBe("verified");
    expect(calls).toEqual([
      "close",
      "phase:starting-locked",
      "start-locked",
      "phase:smoking-locked",
      "smoke-locked",
      "phase:promoting-active",
      "promote-active",
      "phase:smoking-active",
      "smoke-active",
      "lease",
      "phase:verifying-active",
      "verify",
      "release",
      "phase:active",
    ]);
  });

  it.each(["start-locked", "smoke-locked", "promote-active", "smoke-active", "lease", "verify"])(
    "fails locked without releasing ingress when %s fails",
    async (failure) => {
      const releaseIngress = vi.fn();
      const lockAfterFailure = vi.fn();
      const phases: Array<{ phase: string; detail?: string | null }> = [];
      const fail = (step: string) => {
        if (failure === step) throw new Error(`${step} failed`);
      };

      await expect(
        runWindowsNodeMxcAutomaticTransition({
          setPhase: (phase, detail) => phases.push({ phase, detail }),
          closeIngress: vi.fn(),
          startLockedGeneration: async () => {
            fail("start-locked");
            return "locked";
          },
          smokeLockedGeneration: async () => fail("smoke-locked"),
          promoteActivePolicy: async () => {
            fail("promote-active");
            return "active";
          },
          smokeActivePolicy: async () => fail("smoke-active"),
          mintActivationLease: async () => fail("lease"),
          verifyActiveGeneration: async () => {
            fail("verify");
            return "verified";
          },
          releaseIngress,
          lockAfterFailure,
        }),
      ).rejects.toThrow(`${failure} failed`);

      expect(releaseIngress).not.toHaveBeenCalled();
      expect(phases.at(-1)).toEqual({ phase: "locked", detail: `${failure} failed` });
      expect(lockAfterFailure).toHaveBeenCalledTimes(1);
    },
  );
});
