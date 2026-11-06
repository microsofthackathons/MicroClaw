import type { WindowsNodeMxcRequestedMode } from "./windows-node-mxc-modes";

export type WindowsNodeMxcLifecycleOperationDescriptor =
  | { kind: "startup" }
  | {
      kind: "set-enabled";
      requestedMode: WindowsNodeMxcRequestedMode | "auto";
    }
  | { kind: "apply-folder-policy" }
  | { kind: "login-weixin" }
  | { kind: "disconnect-weixin" }
  | { kind: "update-command-consent" }
  | { kind: "update-model" };

interface TrackedWindowsNodeMxcLifecycleOperation {
  descriptor: WindowsNodeMxcLifecycleOperationDescriptor;
  promise: Promise<unknown>;
}

export type WindowsNodeMxcLifecycleOperationLease<T> =
  | { joined: true; promise: Promise<T> }
  | {
      joined: false;
      promise: Promise<T>;
      readonly settled: boolean;
      succeed(value: T): void;
      fail(error: unknown): void;
    };

export interface WindowsNodeMxcLifecycleOperationHooks {
  beforeStart(): void;
  afterSettled(): void;
}

function canJoinWindowsNodeMxcLifecycleOperation(
  current: WindowsNodeMxcLifecycleOperationDescriptor,
  next: WindowsNodeMxcLifecycleOperationDescriptor,
): boolean {
  return (
    current.kind === "set-enabled" &&
    next.kind === "set-enabled" &&
    current.requestedMode === next.requestedMode
  );
}

export class WindowsNodeMxcLifecycleOperationCoordinator {
  private current: TrackedWindowsNodeMxcLifecycleOperation | null = null;
  private revision = 0;
  get generation(): number {
    return this.revision;
  }

  captureIdleCheckpoint(): () => boolean {
    const revision = this.revision;
    const idle = this.current === null;
    // A transition that has already finished still invalidates an older observation.
    return () => idle && this.current === null && this.revision === revision;
  }

  acquire<T>(
    descriptor: WindowsNodeMxcLifecycleOperationDescriptor,
    hooks: WindowsNodeMxcLifecycleOperationHooks,
  ): WindowsNodeMxcLifecycleOperationLease<T> {
    if (this.current) {
      if (canJoinWindowsNodeMxcLifecycleOperation(this.current.descriptor, descriptor)) {
        return { joined: true, promise: this.current.promise as Promise<T> };
      }
      throw new Error("Another Windows Node + MXC lifecycle operation is already in progress");
    }

    hooks.beforeStart();
    this.revision++;
    let settle!: (outcome: { ok: true; value: T } | { ok: false; error: unknown }) => void;
    const completion = new Promise<{ ok: true; value: T } | { ok: false; error: unknown }>(
      (resolve) => {
        settle = resolve;
      },
    );
    const promise = completion.then((outcome) => {
      if (outcome.ok) return outcome.value;
      throw outcome.error;
    });
    void promise.catch(() => undefined);
    this.current = { descriptor, promise };

    let settled = false;
    const finish = (outcome: { ok: true; value: T } | { ok: false; error: unknown }) => {
      if (settled) return;
      settled = true;
      try {
        hooks.afterSettled();
      } finally {
        if (this.current?.promise === promise) {
          this.current = null;
        }
        settle(outcome);
      }
    };

    return {
      joined: false,
      promise,
      get settled() {
        return settled;
      },
      succeed: (value) => finish({ ok: true, value }),
      fail: (error) => finish({ ok: false, error }),
    };
  }

  run<T>(
    descriptor: WindowsNodeMxcLifecycleOperationDescriptor,
    operation: () => Promise<T>,
    hooks: WindowsNodeMxcLifecycleOperationHooks,
  ): Promise<T> {
    const lease = this.acquire<T>(descriptor, hooks);
    if (lease.joined) return lease.promise;
    void Promise.resolve()
      .then(operation)
      .then(
        (value) => {
          lease.succeed(value);
        },
        (error) => {
          lease.fail(error);
        },
      );
    return lease.promise;
  }

  get active(): boolean {
    return this.current !== null;
  }
}
