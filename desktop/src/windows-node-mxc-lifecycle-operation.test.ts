import { describe, expect, it, vi } from "vitest";
import { WindowsNodeMxcLifecycleOperationCoordinator } from "./windows-node-mxc-lifecycle-operation";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

describe("Windows Node MXC lifecycle operation coordinator", () => {
  it("joins a duplicate set-enabled IPC request for the same requested mode", async () => {
    const coordinator = new WindowsNodeMxcLifecycleOperationCoordinator();
    const pending = deferred<string>();
    const operation = vi.fn(() => pending.promise);
    const beforeStart = vi.fn();
    const afterSettled = vi.fn();

    const first = coordinator.run(
      { kind: "set-enabled", requestedMode: "limited-dacl" },
      operation,
      { beforeStart, afterSettled },
    );
    const retry = coordinator.run(
      { kind: "set-enabled", requestedMode: "limited-dacl" },
      operation,
      { beforeStart, afterSettled },
    );

    expect(retry).toBe(first);
    expect(operation).toHaveBeenCalledTimes(0);
    await Promise.resolve();
    expect(operation).toHaveBeenCalledTimes(1);
    expect(beforeStart).toHaveBeenCalledTimes(1);

    pending.resolve("active");
    await expect(first).resolves.toBe("active");
    await expect(retry).resolves.toBe("active");
    expect(afterSettled).toHaveBeenCalledTimes(1);
    expect(coordinator.active).toBe(false);
  });

  it("blocks a genuinely concurrent mode change", async () => {
    const coordinator = new WindowsNodeMxcLifecycleOperationCoordinator();
    const pending = deferred<void>();
    const first = coordinator.run(
      { kind: "set-enabled", requestedMode: "limited-dacl" },
      () => pending.promise,
      { beforeStart: vi.fn(), afterSettled: vi.fn() },
    );

    expect(() =>
      coordinator.run({ kind: "set-enabled", requestedMode: "off" }, async () => undefined, {
        beforeStart: vi.fn(),
        afterSettled: vi.fn(),
      }),
    ).toThrow("Another Windows Node + MXC lifecycle operation is already in progress");

    pending.resolve();
    await first;
  });

  it("continues to a terminal state after the IPC caller drops its promise", async () => {
    const coordinator = new WindowsNodeMxcLifecycleOperationCoordinator();
    const pending = deferred<string>();
    const afterSettled = vi.fn();

    void coordinator.run({ kind: "apply-folder-policy" }, () => pending.promise, {
      beforeStart: vi.fn(),
      afterSettled,
    });
    await Promise.resolve();
    expect(coordinator.active).toBe(true);

    pending.resolve("active");
    await vi.waitFor(() => expect(coordinator.active).toBe(false));
    expect(afterSettled).toHaveBeenCalledOnce();
  });

  it.each(["timeout", "cancellation", "failure"])(
    "releases the guard after %s rejection so a safe retry can start",
    async (reason) => {
      const coordinator = new WindowsNodeMxcLifecycleOperationCoordinator();
      const afterSettled = vi.fn();

      await expect(
        coordinator.run(
          { kind: "set-enabled", requestedMode: "full" },
          async () => {
            throw new Error(reason);
          },
          { beforeStart: vi.fn(), afterSettled },
        ),
      ).rejects.toThrow(reason);

      expect(afterSettled).toHaveBeenCalledTimes(1);
      expect(coordinator.active).toBe(false);
      await expect(
        coordinator.run({ kind: "set-enabled", requestedMode: "full" }, async () => "retried", {
          beforeStart: vi.fn(),
          afterSettled: vi.fn(),
        }),
      ).resolves.toBe("retried");
    },
  );
});
