import { describe, expect, it, vi } from "vitest";
import { WindowsNodeMxcStatusCache } from "./windows-node-mxc-status-cache";

function fixture() {
  let key = "generation-policy-lease-1";
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
      key = "changed";
    },
    age: () => {
      now += 11_000;
    },
  };
}

describe("MXC display snapshots and shared inspections", () => {
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
