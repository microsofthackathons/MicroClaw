import { describe, expect, it, vi } from "vitest";
import { checkWindowsNodeMxcHealth } from "./windows-node-mxc-health-check";
import {
  WindowsNodeMxcLifecycleOperationCoordinator,
  type WindowsNodeMxcLifecycleOperationDescriptor,
} from "./windows-node-mxc-lifecycle-operation";
import type { WindowsNodeMxcRuntimeStatus } from "./windows-node-mxc-service";

type HealthStatus = Pick<
  WindowsNodeMxcRuntimeStatus,
  "effectiveEnabled" | "effectiveToolsState" | "gatewayPolicyState" | "blockers"
>;

function status(effectiveEnabled = true): HealthStatus {
  return {
    effectiveEnabled,
    effectiveToolsState: "verified",
    gatewayPolicyState: "active",
    blockers: effectiveEnabled ? [] : ["The bundled node does not hold an active activation lease"],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture() {
  const coordinator = new WindowsNodeMxcLifecycleOperationCoordinator();
  const hooks = {
    isCurrent: coordinator.captureIdleCheckpoint(),
    inspect: vi.fn(async () => status()),
    renewLease: vi.fn(async () => undefined),
    failClosed: vi.fn(async (_reason: string) => undefined),
  };
  const transition = (kind: WindowsNodeMxcLifecycleOperationDescriptor) =>
    coordinator.acquire<void>(kind, { beforeStart: vi.fn(), afterSettled: vi.fn() });
  return { coordinator, hooks, transition };
}

describe("MXC health checks across live transitions", () => {
  it.each<WindowsNodeMxcLifecycleOperationDescriptor>([
    { kind: "update-model" },
    { kind: "apply-folder-policy" },
    { kind: "update-command-consent" },
    { kind: "set-enabled", requestedMode: "full" },
  ])("ignores an intentionally revoked lease observed during $kind", async (descriptor) => {
    const f = fixture();
    const pending = deferred<HealthStatus>();
    f.hooks.inspect.mockReturnValue(pending.promise);
    const check = checkWindowsNodeMxcHealth(f.hooks);
    const transition = f.transition(descriptor);
    pending.resolve(status(false));
    await expect(check).resolves.toBe(false);
    expect(f.hooks.failClosed).not.toHaveBeenCalled();
    expect(f.hooks.renewLease).not.toHaveBeenCalled();
    if (!transition.joined) transition.succeed();
    await transition.promise;
  });

  it.each([true, false])(
    "discards stale effective=%s after a transition already finished",
    async (effective) => {
      const f = fixture();
      const pending = deferred<HealthStatus>();
      f.hooks.inspect.mockReturnValue(pending.promise);
      const check = checkWindowsNodeMxcHealth(f.hooks);
      const transition = f.transition({ kind: "update-model" });
      if (!transition.joined) transition.succeed();
      await transition.promise;
      expect(f.coordinator.active).toBe(false);
      pending.resolve(status(effective));
      await expect(check).resolves.toBe(false);
      expect(f.hooks.failClosed).not.toHaveBeenCalled();
      expect(f.hooks.renewLease).not.toHaveBeenCalled();
      await expect(
        checkWindowsNodeMxcHealth({
          ...f.hooks,
          isCurrent: f.coordinator.captureIdleCheckpoint(),
          inspect: async () => status(),
        }),
      ).resolves.toBe(true);
      expect(f.hooks.renewLease).toHaveBeenCalledOnce();
    },
  );

  it("does not renew from a successful observation superseded by a transition", async () => {
    const f = fixture();
    const pending = deferred<HealthStatus>();
    f.hooks.inspect.mockReturnValue(pending.promise);
    const check = checkWindowsNodeMxcHealth(f.hooks);
    const transition = f.transition({ kind: "apply-folder-policy" });
    pending.resolve(status());
    await expect(check).resolves.toBe(false);
    expect(f.hooks.renewLease).not.toHaveBeenCalled();
    expect(f.hooks.failClosed).not.toHaveBeenCalled();
    if (!transition.joined) transition.succeed();
  });

  it("does not relock on an inspection error from a superseded generation", async () => {
    const f = fixture();
    const pending = deferred<HealthStatus>();
    f.hooks.inspect.mockReturnValue(pending.promise);
    const check = checkWindowsNodeMxcHealth(f.hooks);
    const transition = f.transition({ kind: "update-model" });
    if (!transition.joined) transition.succeed();
    pending.reject(new Error("old connection closed"));
    await expect(check).resolves.toBe(false);
    expect(f.hooks.failClosed).not.toHaveBeenCalled();
  });

  it.each(["resolve", "reject"] as const)(
    "discards a lease renewal that transitions before it can %s",
    async (outcome) => {
      const f = fixture();
      const pending = deferred<undefined>();
      const renewalStarted = deferred<void>();
      f.hooks.renewLease.mockImplementation(() => {
        renewalStarted.resolve();
        return pending.promise;
      });
      const check = checkWindowsNodeMxcHealth(f.hooks);
      await renewalStarted.promise;
      const transition = f.transition({ kind: "update-model" });
      if (!transition.joined) transition.succeed();
      if (outcome === "reject")
        pending.reject(new Error("activation generation changed before lease update"));
      else pending.resolve(undefined);
      await expect(check).resolves.toBe(false);
      expect(f.hooks.failClosed).not.toHaveBeenCalled();
    },
  );

  it("skips a check captured while a transition is active even after that transition settles", async () => {
    const f = fixture();
    const transition = f.transition({ kind: "update-model" });
    const isCurrent = f.coordinator.captureIdleCheckpoint();
    if (!transition.joined) transition.succeed();
    await expect(checkWindowsNodeMxcHealth({ ...f.hooks, isCurrent })).resolves.toBe(false);
    expect(f.hooks.inspect).not.toHaveBeenCalled();
  });

  it("still fails closed for genuine active-generation readiness drift", async () => {
    const f = fixture();
    f.hooks.inspect.mockResolvedValue(status(false));
    await expect(checkWindowsNodeMxcHealth(f.hooks)).resolves.toBe(false);
    expect(f.hooks.failClosed).toHaveBeenCalledExactlyOnceWith(
      "Readiness drifted: The bundled node does not hold an active activation lease",
    );
    expect(f.hooks.renewLease).not.toHaveBeenCalled();
  });

  it.each(["inspect", "renewLease"] as const)(
    "still fails closed for a current %s error",
    async (stage) => {
      const f = fixture();
      f.hooks[stage].mockRejectedValue(new Error("genuine failure"));
      await expect(checkWindowsNodeMxcHealth(f.hooks)).resolves.toBe(false);
      expect(f.hooks.failClosed).toHaveBeenCalledOnce();
    },
  );

  it("surfaces recovery failure without attempting a second fail-closed operation", async () => {
    const f = fixture();
    f.hooks.inspect.mockResolvedValue(status(false));
    f.hooks.failClosed.mockRejectedValue(new Error("recovery failed"));
    await expect(checkWindowsNodeMxcHealth(f.hooks)).rejects.toThrow("recovery failed");
    expect(f.hooks.failClosed).toHaveBeenCalledOnce();
  });
});
