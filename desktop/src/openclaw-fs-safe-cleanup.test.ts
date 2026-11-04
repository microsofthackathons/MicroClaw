import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
// @ts-expect-error The Gateway compatibility preload is external ESM.
import { verifyWindowsCopiedFile, WINDOWS_CLEANUP_PATCHES } from "./openclaw-fs-safe-compat.mjs";

const mocks = vi.hoisted(() => ({
  lstat: vi.fn(),
  lstatSync: vi.fn(),
  open: vi.fn(),
  process: { platform: "win32", env: {} },
}));
vi.mock("node:process", () => ({ default: mocks.process }));
vi.mock("node:fs", async (original) => ({
  ...(await original<typeof import("node:fs")>()),
  lstatSync: mocks.lstatSync,
}));
vi.mock("node:fs/promises", () => ({ default: { lstat: mocks.lstat, open: mocks.open } }));

const identity = {
  dev: 1,
  ino: 100,
  mode: 33206,
  nlink: 1,
  size: 7,
  mtimeMs: 50,
  ctimeMs: 50,
};
function stat(patch: Partial<typeof identity> = {}, isFile = true) {
  return { ...identity, ...patch, isFile: () => isFile };
}
const body = Buffer.from("payload");
const digest = createHash("sha256").update(body).digest("hex");
const sourcePath = "C:\\fixture\\plugin.js";
let offset: number;
let handle: {
  stat: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.process.platform = "win32";
  offset = 0;
  handle = {
    stat: vi.fn(async () => stat({ ctimeMs: 60 })),
    read: vi.fn(async (buffer: Buffer) => {
      const bytesRead = body.copy(buffer, 0, offset);
      offset += bytesRead;
      return { bytesRead };
    }),
    close: vi.fn(async () => {}),
  };
  mocks.lstat.mockResolvedValue(stat({ ctimeMs: 60 }));
  mocks.lstatSync.mockImplementation(() => stat({ ctimeMs: 60 }));
  mocks.open.mockResolvedValue(handle);
});

describe("digest-bound Windows copied-file verification", () => {
  it("renews only a ctime-only fingerprint after re-reading exactly the bytes that were copied", async () => {
    expect(await verifyWindowsCopiedFile(sourcePath, identity, digest)).toEqual({
      ...identity,
      ctimeMs: 60,
    });
    expect(handle.read).toHaveBeenCalledTimes(2);
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it("accepts a further Windows read-open ctime advance only with matching content and final identity", async () => {
    handle.stat.mockResolvedValue(stat({ ctimeMs: 61 }));
    mocks.lstatSync.mockReturnValue(stat({ ctimeMs: 61 }));
    expect(await verifyWindowsCopiedFile(sourcePath, identity, digest)).toEqual({
      ...identity,
      ctimeMs: 61,
    });
  });

  it.each(["dev", "ino", "mode", "nlink", "size", "mtimeMs"] as const)(
    "rejects changed %s rather than renewing its fingerprint",
    async (field) => {
      mocks.lstat.mockResolvedValue(stat({ ctimeMs: 60, [field]: identity[field] + 1 }));
      expect(await verifyWindowsCopiedFile(sourcePath, identity, digest)).toBeUndefined();
      expect(mocks.open).not.toHaveBeenCalled();
    },
  );

  it("does not accept content changes even when length and mtime were restored", async () => {
    handle.read.mockImplementationOnce(async (buffer: Buffer) => {
      Buffer.from("changed").copy(buffer);
      offset = 7;
      return { bytesRead: 7 };
    });
    expect(await verifyWindowsCopiedFile(sourcePath, identity, digest)).toBeUndefined();
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it("bounds verification by the copied byte count", async () => {
    handle.read.mockImplementation(async (buffer: Buffer) => {
      buffer.fill(1);
      return { bytesRead: buffer.length };
    });
    expect(await verifyWindowsCopiedFile(sourcePath, identity, digest)).toBeUndefined();
    expect(handle.read).toHaveBeenCalledOnce();
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it("rejects symlinks and a file substituted between lstat and open", async () => {
    mocks.lstat.mockResolvedValueOnce(stat({ ctimeMs: 60 }, false));
    expect(await verifyWindowsCopiedFile(sourcePath, identity, digest)).toBeUndefined();
    expect(mocks.open).not.toHaveBeenCalled();
    handle.stat.mockResolvedValue(stat({ ino: 101, ctimeMs: 60 }));
    expect(await verifyWindowsCopiedFile(sourcePath, identity, digest)).toBeUndefined();
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it("rejects a path replacement while the verified descriptor remains unchanged", async () => {
    mocks.lstatSync.mockReturnValueOnce(stat({ ino: 101, ctimeMs: 60 }));
    expect(await verifyWindowsCopiedFile(sourcePath, identity, digest)).toBeUndefined();
    expect(handle.read).not.toHaveBeenCalled();
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it("rejects mutation during the verification read", async () => {
    handle.stat
      .mockResolvedValueOnce(stat({ ctimeMs: 60 }))
      .mockResolvedValueOnce(stat({ ctimeMs: 61 }));
    expect(await verifyWindowsCopiedFile(sourcePath, identity, digest)).toBeUndefined();
    expect(handle.close).toHaveBeenCalledOnce();
  });

  it("does not trust another ctime change after the verification handle closes", async () => {
    handle.close.mockImplementation(async () =>
      mocks.lstatSync.mockReturnValue(stat({ ctimeMs: 61 })),
    );
    expect(await verifyWindowsCopiedFile(sourcePath, identity, digest)).toBeUndefined();
  });

  it("rejects backwards ctime, hardlinks and imprecise identities", async () => {
    mocks.lstat.mockResolvedValueOnce(stat({ ctimeMs: 49 }));
    expect(await verifyWindowsCopiedFile(sourcePath, identity, digest)).toBeUndefined();
    expect(
      await verifyWindowsCopiedFile(sourcePath, { ...identity, nlink: 2 }, digest),
    ).toBeUndefined();
    expect(
      await verifyWindowsCopiedFile(sourcePath, { ...identity, ino: 2 ** 54 }, digest),
    ).toBeUndefined();
    expect(mocks.open).not.toHaveBeenCalled();
  });

  it("never enables timestamp renewal on other platforms or without a copy digest", async () => {
    mocks.process.platform = "linux";
    expect(await verifyWindowsCopiedFile(sourcePath, identity, digest)).toBeUndefined();
    mocks.process.platform = "win32";
    expect(await verifyWindowsCopiedFile(sourcePath, identity, undefined)).toBeUndefined();
    expect(mocks.lstat).not.toHaveBeenCalled();
  });

  it("treats a vanished source as stale but surfaces access and I/O errors", async () => {
    mocks.open.mockRejectedValueOnce(Object.assign(new Error("missing"), { code: "ENOENT" }));
    expect(await verifyWindowsCopiedFile(sourcePath, identity, digest)).toBeUndefined();
    mocks.open.mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));
    await expect(verifyWindowsCopiedFile(sourcePath, identity, digest)).rejects.toThrow("denied");
  });
});

describe("patched copied-source cleanup", () => {
  function cleanupHarness(onMutation = () => {}) {
    const unlink = vi.fn(async () => {});
    const same = (a: typeof identity, b: typeof identity) =>
      Object.keys(identity).every(
        (key) => a[key as keyof typeof identity] === b[key as keyof typeof identity],
      );
    const snippet = WINDOWS_CLEANUP_PATCHES[1][1];
    const cleanup = new Function(
      "fs",
      "microclawLstatSync",
      "verifyWindowsCopiedFile",
      "sameIdentity",
      "entryIdentity",
      "assertBeforeMutation",
      "poisonAliasGroup",
      "process",
      `return async function(sourcePath, manifest, currentStat, aliasGroup) { ${snippet}\nreturn "removed"; }`,
    )(
      { unlink },
      mocks.lstatSync,
      verifyWindowsCopiedFile,
      same,
      (value: unknown) => value,
      onMutation,
      () => "stale",
      mocks.process,
    );
    return { cleanup, unlink };
  }

  it("revalidates exactly after caller authorization before deleting a verified source", async () => {
    const { cleanup, unlink } = cleanupHarness();
    expect(
      await cleanup(
        sourcePath,
        { ...identity, microclawCopySha256: digest },
        stat({ ctimeMs: 60 }),
      ),
    ).toBe("removed");
    expect(unlink).toHaveBeenCalledWith(sourcePath);
  });

  it("handles a timestamp advancing between the first cleanup observation and deletion admission", async () => {
    const { cleanup, unlink } = cleanupHarness();
    expect(await cleanup(sourcePath, { ...identity, microclawCopySha256: digest }, stat())).toBe(
      "removed",
    );
    expect(mocks.open).toHaveBeenCalledOnce();
    expect(unlink).toHaveBeenCalledWith(sourcePath);
  });

  it("preserves a source changed by the mutation callback after digest verification", async () => {
    const { cleanup, unlink } = cleanupHarness(() =>
      mocks.lstatSync.mockReturnValue(stat({ ctimeMs: 61 })),
    );
    expect(
      await cleanup(
        sourcePath,
        { ...identity, microclawCopySha256: digest },
        stat({ ctimeMs: 60 }),
      ),
    ).toBe("stale");
    expect(unlink).not.toHaveBeenCalled();
  });

  it("re-reads and rejects changed contents after caller authorization", async () => {
    const { cleanup, unlink } = cleanupHarness(() => {
      mocks.lstatSync.mockReturnValue(stat({ ctimeMs: 61 }));
      mocks.lstat.mockResolvedValue(stat({ ctimeMs: 61 }));
      handle.stat.mockResolvedValue(stat({ ctimeMs: 61 }));
      handle.read
        .mockImplementationOnce(async (buffer: Buffer) => {
          Buffer.from("changed").copy(buffer);
          return { bytesRead: 7 };
        })
        .mockResolvedValue({ bytesRead: 0 });
    });
    expect(
      await cleanup(
        sourcePath,
        { ...identity, microclawCopySha256: digest },
        stat({ ctimeMs: 60 }),
      ),
    ).toBe("stale");
    expect(unlink).not.toHaveBeenCalled();
  });

  it("leaves changed hardlink aliases and files without digests stale", async () => {
    const { cleanup, unlink } = cleanupHarness();
    expect(await cleanup(sourcePath, identity, stat({ ctimeMs: 60 }))).toBe("stale");
    expect(
      await cleanup(
        sourcePath,
        { ...identity, microclawCopySha256: digest },
        stat({ ctimeMs: 60 }),
        { expected: identity },
      ),
    ).toBe("stale");
    expect(mocks.open).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
  });
});
