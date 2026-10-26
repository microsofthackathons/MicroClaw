import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error External ESM adapter executes in the supported Gateway runtime.
import { publishLlamaRuntime } from "./openclaw-local-model-compat.mjs";

const mocks = vi.hoisted(() => ({
  process: { platform: "win32", env: {} },
  delay: vi.fn(),
}));
vi.mock("node:process", () => ({ default: mocks.process }));
vi.mock("node:timers/promises", () => ({ setTimeout: mocks.delay }));
const from = join(tmpdir(), "runtime-fixture", ".extract-test", "server");
const to = join(tmpdir(), "runtime-fixture", "b10809", "win32-x64");
function directory(ino: bigint) {
  return { dev: 1n, ino, isDirectory: () => true, isSymbolicLink: () => false };
}
function fixture() {
  const source = directory(10n);
  const parent = directory(20n);
  let destinationExists = false;
  const fs = {
    lstat: vi.fn(async (file: string) => {
      if (file === from) return source;
      if (file === dirname(to)) return parent;
      if (file === to && destinationExists) return directory(30n);
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    }),
    rename: vi.fn(async () => {}),
  };
  return {
    fs,
    source,
    parent,
    createDestination: () => {
      destinationExists = true;
    },
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.process.platform = "win32";
  mocks.delay.mockResolvedValue(undefined);
});
describe("validated llama.cpp runtime publication", () => {
  it("publishes directly when Windows releases the validated executable normally", async () => {
    const { fs } = fixture();
    await publishLlamaRuntime(fs, from, to);
    expect(fs.rename).toHaveBeenCalledExactlyOnceWith(from, to);
    expect(mocks.delay).not.toHaveBeenCalled();
  });
  it.each(["EPERM", "EACCES", "EBUSY"])(
    "retries a transient %s without skipping post-install validation",
    async (code) => {
      const { fs } = fixture();
      fs.rename.mockRejectedValueOnce(Object.assign(new Error("locked"), { code }));
      await publishLlamaRuntime(fs, from, to);
      expect(fs.rename).toHaveBeenCalledTimes(2);
      expect(mocks.delay).toHaveBeenCalledExactlyOnceWith(100, undefined, { signal: undefined });
      expect(fs.lstat).toHaveBeenCalledWith(from, { bigint: true });
    },
  );
  it("surfaces a persistent lock after a bounded number of attempts", async () => {
    const { fs } = fixture();
    const error = Object.assign(new Error("persistent permission denial"), { code: "EPERM" });
    fs.rename.mockRejectedValue(error);
    await expect(publishLlamaRuntime(fs, from, to)).rejects.toBe(error);
    expect(fs.rename).toHaveBeenCalledTimes(6);
    expect(mocks.delay).toHaveBeenCalledTimes(5);
  });
  it("never retries unrelated filesystem errors", async () => {
    const { fs } = fixture();
    const error = Object.assign(new Error("missing source"), { code: "ENOENT" });
    fs.rename.mockRejectedValue(error);
    await expect(publishLlamaRuntime(fs, from, to)).rejects.toBe(error);
    expect(fs.rename).toHaveBeenCalledOnce();
    expect(mocks.delay).not.toHaveBeenCalled();
  });
  it("does not delete or overwrite a target created while waiting", async () => {
    const f = fixture();
    f.fs.rename.mockRejectedValueOnce(Object.assign(new Error("locked"), { code: "EPERM" }));
    mocks.delay.mockImplementation(async () => f.createDestination());
    await expect(publishLlamaRuntime(f.fs, from, to)).rejects.toThrow("destination appeared");
    expect(f.fs.rename).toHaveBeenCalledOnce();
  });
  it.each(["source", "parent"] as const)(
    "rejects a replaced %s directory before retrying",
    async (target) => {
      const f = fixture();
      f.fs.rename.mockRejectedValueOnce(Object.assign(new Error("locked"), { code: "EPERM" }));
      mocks.delay.mockImplementation(async () => {
        f[target].ino += 1n;
      });
      // Return distinct stat snapshots, as Node's lstat does.
      const implementation = f.fs.lstat.getMockImplementation()!;
      f.fs.lstat.mockImplementation(async (file) => ({ ...(await implementation(file)) }));
      await expect(publishLlamaRuntime(f.fs, from, to)).rejects.toThrow("paths changed");
      expect(f.fs.rename).toHaveBeenCalledOnce();
    },
  );
  it("honors cancellation before retrying and before first publication", async () => {
    const { fs } = fixture();
    const controller = new AbortController();
    fs.rename.mockRejectedValueOnce(Object.assign(new Error("locked"), { code: "EPERM" }));
    mocks.delay.mockImplementation(async () => controller.abort(new Error("cancelled")));
    await expect(publishLlamaRuntime(fs, from, to, controller.signal)).rejects.toThrow("cancelled");
    expect(fs.rename).toHaveBeenCalledOnce();
    await expect(publishLlamaRuntime(fs, from, to, controller.signal)).rejects.toThrow("cancelled");
    expect(fs.rename).toHaveBeenCalledOnce();
  });
  it("does not apply Windows retries on other platforms", async () => {
    const { fs } = fixture();
    mocks.process.platform = "linux";
    fs.rename.mockRejectedValue(Object.assign(new Error("denied"), { code: "EPERM" }));
    await expect(publishLlamaRuntime(fs, from, to)).rejects.toThrow("denied");
    expect(fs.rename).toHaveBeenCalledOnce();
    expect(fs.lstat).not.toHaveBeenCalled();
  });
  it("rejects redirected or unidentified runtime directories", async () => {
    const { fs, source } = fixture();
    source.isSymbolicLink = () => true;
    await expect(publishLlamaRuntime(fs, from, to)).rejects.toThrow("identifiable directories");
    expect(fs.rename).not.toHaveBeenCalled();
    source.isSymbolicLink = () => false;
    source.ino = 0n;
    await expect(publishLlamaRuntime(fs, from, to)).rejects.toThrow("identifiable directories");
  });
});
