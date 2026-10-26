import { beforeEach, describe, expect, it, vi } from "vitest";
import { inspectManagedLocalModelCache } from "./local-model-files";
import { LOCAL_MODEL_PRESETS } from "./local-model-catalog";
import { tmpdir } from "node:os";
import { join } from "node:path";
const stateDir = join(tmpdir(), "microclaw-cache-fixture");
const mocks = vi.hoisted(() => ({ stat: vi.fn(), open: vi.fn() }));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  statSync: mocks.stat,
  openSync: mocks.open,
}));
beforeEach(() => {
  vi.resetAllMocks();
});
describe("fixed local model cache metadata", () => {
  it("checks only pinned file names and exact sizes without reading weights", () => {
    mocks.stat.mockImplementation((file: string) => {
      const preset = LOCAL_MODEL_PRESETS.find((model) => file.endsWith(model.cacheFile))!;
      return { isFile: () => true, size: preset.downloadBytes };
    });
    const result = inspectManagedLocalModelCache({}, stateDir);
    expect([...result.values()]).toEqual(LOCAL_MODEL_PRESETS.map(() => "present"));
    expect(mocks.stat).toHaveBeenCalledTimes(LOCAL_MODEL_PRESETS.length);
    expect(mocks.open).not.toHaveBeenCalled();
  });
  it("does not present a partial file as downloaded", () => {
    mocks.stat.mockReturnValue({ isFile: () => true, size: 12 });
    expect([...inspectManagedLocalModelCache({}, stateDir).values()]).toEqual(
      LOCAL_MODEL_PRESETS.map(() => "missing"),
    );
  });
  it("does not traverse unknown relative or network cache paths", () => {
    expect([
      ...inspectManagedLocalModelCache(
        { params: { modelCacheDir: "relative" } },
        "C:\\state",
      ).values(),
    ]).toEqual(LOCAL_MODEL_PRESETS.map(() => "unknown"));
    expect([
      ...inspectManagedLocalModelCache(
        { params: { modelCacheDir: "\\\\server\\share" } },
        "C:\\state",
      ).values(),
    ]).toEqual(LOCAL_MODEL_PRESETS.map(() => "unknown"));
    expect(mocks.stat).not.toHaveBeenCalled();
  });
});
