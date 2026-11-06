import { describe, expect, it, vi } from "vitest";
import { WindowsNodeMxcStatusCache } from "./windows-node-mxc-status-cache";

function fixture() {
  let key = "generation-policy-lease-1";
  let generation = 1;
  let now = 100;
  const inspect = vi.fn(async () => ({ effective: true }));
  const publish = vi.fn();
  const cache = new WindowsNodeMxcStatusCache({
    key: () => key,
    now: () => now,
    inspect,
    publish,
  });
  return {
    cache,
    inspect,
    publish,
    change: () => {
      key = `changed-${generation++}`;
    },
    age: () => {
      now += 11_000;
    },
  };
}

describe("MXC display snapshots and shared inspections", () => {
  it("publishes the start of an inspection to existing subscribers without another display read", async () => {
    const f = fixture();
    const result = f.cache.fresh();
    expect(f.publish).toHaveBeenCalledExactlyOnceWith({
      status: null,
      verifiedAt: null,
      refreshing: true,
      error: null,
    });
    expect(f.cache.fresh()).toBe(result);
    expect(f.publish).toHaveBeenCalledOnce();
    await result;
    expect(f.publish).toHaveBeenLastCalledWith({
      status: { effective: true },
      verifiedAt: 100,
      refreshing: false,
      error: null,
    });
  });

  it("publishes a refresh alongside the last verified snapshot", async () => {
    const f = fixture();
    await f.cache.fresh();
    f.publish.mockClear();
    f.age();
    const result = f.cache.fresh();
    expect(f.publish).toHaveBeenCalledExactlyOnceWith({
      status: { effective: true },
      verifiedAt: 100,
      refreshing: true,
      error: null,
    });
    await result;
    expect(f.publish).toHaveBeenLastCalledWith({
      status: { effective: true },
      verifiedAt: 11_100,
      refreshing: false,
      error: null,
    });
  });

  it("keeps the current refresh visible when an obsolete inspection finishes", async () => {
    const f = fixture();
    let finishOld!: (value: { effective: boolean }) => void;
    let finishCurrent!: (value: { effective: boolean }) => void;
    f.inspect.mockReturnValueOnce(
      new Promise((resolve) => {
        finishOld = resolve;
      }),
    );
    const old = f.cache.fresh();
    await Promise.resolve();
    f.change();
    f.inspect.mockReturnValueOnce(
      new Promise((resolve) => {
        finishCurrent = resolve;
      }),
    );
    const current = f.cache.fresh();
    expect(f.publish).toHaveBeenLastCalledWith({
      status: null,
      verifiedAt: null,
      refreshing: true,
      error: null,
    });
    finishOld({ effective: true });
    await expect(old).rejects.toThrow("status changed");
    expect(f.publish).toHaveBeenLastCalledWith({
      status: null,
      verifiedAt: null,
      refreshing: true,
      error: null,
    });
    finishCurrent({ effective: true });
    await current;
    expect(f.publish).toHaveBeenLastCalledWith({
      status: { effective: true },
      verifiedAt: 100,
      refreshing: false,
      error: null,
    });
  });

  it("returns a recent display snapshot without another scan but never caches enforcement results", async () => {
    const f = fixture();
    await f.cache.fresh();
    expect(f.cache.display()).toMatchObject({
      status: { effective: true },
      verifiedAt: 100,
      refreshing: false,
    });
    expect(f.inspect).toHaveBeenCalledOnce();
    await f.cache.fresh();
    expect(f.inspect).toHaveBeenCalledTimes(2);
  });
  it("coalesces concurrent fresh checks only within the exact runtime context", async () => {
    const f = fixture();
    const first = f.cache.fresh();
    expect(f.cache.fresh()).toBe(first);
    await first;
    expect(f.inspect).toHaveBeenCalledOnce();
  });
  it("returns old display data immediately while refreshing in the background", async () => {
    const f = fixture();
    await f.cache.fresh();
    f.age();
    expect(f.cache.display()).toMatchObject({ status: { effective: true }, refreshing: true });
    await f.cache.fresh();
    expect(f.cache.snapshot().verifiedAt).toBe(11_100);
  });
  it("invalidates snapshots immediately when generation, policy or lease changes", async () => {
    const f = fixture();
    await f.cache.fresh();
    f.change();
    expect(f.cache.snapshot()).toMatchObject({ status: null, verifiedAt: null });
  });
  it("does not publish an in-flight result from an obsolete runtime", async () => {
    const f = fixture();
    let finish!: (value: { effective: boolean }) => void;
    f.inspect.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const result = f.cache.fresh();
    await Promise.resolve();
    f.change();
    finish({ effective: true });
    await expect(result).rejects.toThrow("status changed");
    expect(f.cache.snapshot().status).toBeNull();
    expect(f.publish).toHaveBeenLastCalledWith({
      status: null,
      verifiedAt: null,
      refreshing: false,
      error: null,
    });
  });

  it("retries an obsolete display inspection for the settled runtime", async () => {
    const f = fixture();
    let finish!: (value: { effective: boolean }) => void;
    f.inspect.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    f.inspect.mockResolvedValueOnce({ effective: false });
    expect(f.cache.display()).toMatchObject({ status: null, refreshing: true });
    await Promise.resolve();
    f.change();
    finish({ effective: true });
    await vi.waitFor(() =>
      expect(f.cache.snapshot()).toMatchObject({
        status: { effective: false },
        refreshing: false,
        error: null,
      }),
    );
    expect(f.inspect).toHaveBeenCalledTimes(2);
  });

  it("retries when the display context returns to an earlier key", async () => {
    let key = "a";
    const inspect = vi.fn(async () => {
      if (inspect.mock.calls.length === 1) key = "b";
      else if (inspect.mock.calls.length === 2) key = "a";
      return { effective: inspect.mock.calls.length === 3 };
    });
    const cache = new WindowsNodeMxcStatusCache({ key: () => key, inspect, publish: vi.fn() });
    cache.display();
    await vi.waitFor(() =>
      expect(cache.snapshot()).toMatchObject({
        status: { effective: true },
        refreshing: false,
        error: null,
      }),
    );
    expect(inspect).toHaveBeenCalledTimes(3);
  });

  it("bounds repeated invalidation and publishes an error instead of a stale status", async () => {
    const f = fixture();
    f.inspect.mockImplementation(async () => {
      f.change();
      return { effective: true };
    });
    f.cache.display();
    await vi.waitFor(() =>
      expect(f.cache.snapshot()).toMatchObject({
        status: null,
        refreshing: false,
        error: "MXC status changed repeatedly during inspection; refresh the current state",
      }),
    );
    expect(f.inspect).toHaveBeenCalledTimes(3);
  });

  it("does not extend the retry limit for a concurrent enforcement inspection", async () => {
    const f = fixture();
    let finishCurrent!: (value: { effective: boolean }) => void;
    let current!: Promise<{ effective: boolean }>;
    f.inspect.mockImplementation(async () => {
      if (f.inspect.mock.calls.length < 3) {
        f.change();
        return { effective: true };
      }
      if (f.inspect.mock.calls.length === 3) {
        f.change();
        current = f.cache.fresh();
        return { effective: true };
      }
      return new Promise((resolve) => {
        finishCurrent = resolve;
      });
    });
    f.cache.display();
    await vi.waitFor(() =>
      expect(f.cache.snapshot()).toMatchObject({
        status: null,
        refreshing: true,
        error: "MXC status changed repeatedly during inspection; refresh the current state",
      }),
    );
    expect(f.inspect).toHaveBeenCalledTimes(4);
    finishCurrent({ effective: false });
    await current;
    expect(f.cache.snapshot()).toMatchObject({
      status: { effective: false },
      refreshing: false,
      error: null,
    });
  });

  it("publishes real display inspection failures without automatically retrying them", async () => {
    const f = fixture();
    f.inspect.mockRejectedValue(new Error("inspection failed"));
    f.cache.display();
    await vi.waitFor(() =>
      expect(f.cache.snapshot()).toMatchObject({
        status: null,
        refreshing: false,
        error: "inspection failed",
      }),
    );
    expect(f.inspect).toHaveBeenCalledOnce();
  });

  it("publishes a failure if the runtime context becomes unreadable during a refresh", async () => {
    let keyAvailable = true;
    let finish!: (value: { effective: boolean }) => void;
    const publish = vi.fn();
    const cache = new WindowsNodeMxcStatusCache({
      key: () => {
        if (!keyAvailable) throw new Error("Status context unavailable");
        return "generation";
      },
      inspect: () =>
        new Promise<{ effective: boolean }>((resolve) => {
          finish = resolve;
        }),
      publish,
    });
    cache.display();
    await Promise.resolve();
    keyAvailable = false;
    finish({ effective: true });
    await vi.waitFor(() =>
      expect(publish).toHaveBeenLastCalledWith({
        status: null,
        verifiedAt: null,
        refreshing: false,
        error: "Status context unavailable",
      }),
    );
  });

  it("surfaces a synchronous publication error without leaving the inspection untracked", async () => {
    const publish = vi.fn().mockImplementationOnce(() => {
      throw new Error("Status publication failed");
    });
    const cache = new WindowsNodeMxcStatusCache({
      key: () => "generation",
      inspect: async () => ({ effective: false }),
      publish,
    });
    expect(() => cache.display()).toThrow("Status publication failed");
    await vi.waitFor(() =>
      expect(cache.snapshot()).toMatchObject({
        status: { effective: false },
        refreshing: false,
        error: null,
      }),
    );
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("reports an asynchronous publication failure to display subscribers", async () => {
    const publish = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("Status publication failed");
      });
    const cache = new WindowsNodeMxcStatusCache({
      key: () => "generation",
      inspect: async () => ({ effective: false }),
      publish,
    });
    cache.display();
    await vi.waitFor(() =>
      expect(publish).toHaveBeenLastCalledWith({
        status: null,
        verifiedAt: null,
        refreshing: false,
        error: "Status publication failed",
      }),
    );
  });
  it("clears last-known success and exposes refresh failures", async () => {
    const f = fixture();
    await f.cache.fresh();
    f.inspect.mockRejectedValue(new Error("inspection failed"));
    await expect(f.cache.fresh()).rejects.toThrow("inspection failed");
    expect(f.cache.snapshot()).toMatchObject({ status: null, error: "inspection failed" });
  });
  it("does not let an obsolete completion clear a newer verified snapshot", async () => {
    const f = fixture();
    let finish!: (value: { effective: boolean }) => void;
    f.inspect.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const old = f.cache.fresh();
    await Promise.resolve();
    f.change();
    await f.cache.fresh();
    finish({ effective: false });
    await expect(old).rejects.toThrow("status changed");
    expect(f.cache.snapshot()).toMatchObject({ status: { effective: true }, error: null });
  });
});
