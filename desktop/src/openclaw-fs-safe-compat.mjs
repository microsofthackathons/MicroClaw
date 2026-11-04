// Windows move fix from openclaw/fs-safe@6ae2e2e5086f2c48b813f78cb65fd787c9879a3f.
// Includes MicroClaw's digest-bound Windows cleanup extension.
// Copyright (c) 2026 openclaw. MIT; see NOTICE. Applied in memory, never to installed files.
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { constants, lstatSync, readFileSync, realpathSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { dirname, isAbsolute, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const PINNED_FS_SAFE_VERSION = "0.8.5";
export const PINNED_FS_SAFE_MOVE_SHA256 =
  "ccee1830461fd468c8ab3d4af05f3ed3a0c9e8a8862e002b8a06f4066a705855";
export const PINNED_FS_SAFE_CLEANUP_SHA256 =
  "a786867581d72079c90226d07cdfa6bab423e8b6e762e1aeca6291dce8067d9e";

const IDENTITY_FIELDS = ["dev", "ino", "mode", "nlink", "size", "mtimeMs", "ctimeMs"];
function copyIdentity(stat) {
  return Object.fromEntries(IDENTITY_FIELDS.map((field) => [field, stat[field]]));
}
function matchesIdentity(expected, observed) {
  return IDENTITY_FIELDS.every((field) => expected[field] === observed[field]);
}
function permitsWindowsCtimeAdvance(expected, observed) {
  return (
    process.platform === "win32" &&
    expected.nlink === 1 &&
    Number.isSafeInteger(expected.dev) &&
    Number.isSafeInteger(expected.ino) &&
    expected.ino > 0 &&
    IDENTITY_FIELDS.every((field) => field === "ctimeMs" || expected[field] === observed[field]) &&
    observed.ctimeMs >= expected.ctimeMs
  );
}

/** A changed cleanup fingerprint is accepted only after verifying the copied bytes again. */
export async function verifyWindowsCopiedFile(sourcePath, expected, digest) {
  if (process.platform !== "win32" || !/^[a-f0-9]{64}$/.test(digest ?? "")) return undefined;
  let handle;
  let verified;
  try {
    const before = await fs.lstat(sourcePath);
    if (!before.isFile() || !permitsWindowsCtimeAdvance(expected, before)) return undefined;
    handle = await fs.open(sourcePath, constants.O_RDONLY);
    const opened = await handle.stat();
    if (!opened.isFile() || !permitsWindowsCtimeAdvance(before, opened)) return undefined;
    const identity = copyIdentity(opened);
    if (!matchesIdentity(identity, lstatSync(sourcePath))) return undefined;
    const hash = createHash("sha256");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (total > identity.size) return undefined;
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (
      total !== identity.size ||
      hash.digest("hex") !== digest ||
      !matchesIdentity(identity, await handle.stat()) ||
      !matchesIdentity(identity, lstatSync(sourcePath))
    )
      return undefined;
    verified = identity;
  } catch (error) {
    if (!["ENOENT", "ENOTDIR", "ELOOP"].includes(error?.code)) throw error;
  } finally {
    await handle?.close();
  }
  if (!verified) return undefined;
  try {
    return matchesIdentity(verified, lstatSync(sourcePath)) ? verified : undefined;
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "ELOOP"].includes(error?.code)) return undefined;
    throw error;
  }
}

export const WINDOWS_MOVE_PATCHES = [
  [
    'import { randomUUID } from "node:crypto";',
    `import { randomUUID, createHash as microclawCreateHash } from "node:crypto";\nimport { verifyWindowsCopiedFile } from ${JSON.stringify(import.meta.url)};`,
  ],
  [
    "    let destinationCreated = false;\n    let sourceHandle;",
    "    let destinationCreated = false;\n    let openedIdentity;\n    let copiedHash;\n    let sourceHandle;",
  ],
  [
    "        const openedStat = await sourceHandle.stat();",
    "        const openedStat = await sourceHandle.stat();\n        openedIdentity = entryIdentity(openedStat);",
  ],
  [
    `        if (!openedStat.isFile() || !sameIdentity(params.identity, entryIdentity(openedStat))) {
            throw sourceChangedError(params.from);
        }`,
    `        const openAdvancedWindowsCtime =
            process.platform === "win32" &&
            params.identity.dev === openedIdentity.dev &&
            params.identity.ino === openedIdentity.ino &&
            params.identity.mode === openedIdentity.mode &&
            params.identity.nlink === openedIdentity.nlink &&
            params.identity.size === openedIdentity.size &&
            params.identity.mtimeMs === openedIdentity.mtimeMs &&
            openedIdentity.ctimeMs >= params.identity.ctimeMs;
        if (!openedStat.isFile() ||
            (!sameIdentity(params.identity, openedIdentity) && !openAdvancedWindowsCtime)) {
            throw sourceChangedError(params.from);
        }
        await assertSourceStillMatches(params.from, openedIdentity);
        if (process.platform === "win32" && openedIdentity.nlink === 1) {
            copiedHash = microclawCreateHash("sha256");
        }`,
  ],
  [
    "                await writeAll(destinationHandle, scratch, bytesRead);",
    "                copiedHash?.update(scratch.subarray(0, bytesRead));\n                await writeAll(destinationHandle, scratch, bytesRead);",
  ],
  [
    "        if (!sameIdentity(params.identity, entryIdentity(finalSourceStat))) {",
    "        if (!sameIdentity(openedIdentity, entryIdentity(finalSourceStat))) {",
  ],
  [
    "        await sourceHandle.close();\n    }\n}\nasync function copyEntryWithManifest",
    `        await sourceHandle.close();
    }
    if (copiedHash) {
        const digest = copiedHash.digest("hex");
        const closedIdentity = entryIdentity(await fs.lstat(params.from));
        const copiedIdentity = sameIdentity(openedIdentity, closedIdentity)
            ? openedIdentity
            : await verifyWindowsCopiedFile(params.from, openedIdentity, digest);
        if (!copiedIdentity) throw sourceChangedError(params.from);
        return { ...copiedIdentity, microclawCopySha256: digest };
    }
    return openedIdentity;
}
async function copyEntryWithManifest`,
  ],
  ["    await copyRegularFilePinned({", "    const copiedIdentity = await copyRegularFilePinned({"],
  [
    '    return { ...identity, kind: "leaf" };\n}\nfunction assertSynchronousResult',
    '    return { ...copiedIdentity, kind: "leaf" };\n}\nfunction assertSynchronousResult',
  ],
];

export const WINDOWS_CLEANUP_PATCHES = [
  [
    'import fs from "node:fs/promises";',
    `import fs from "node:fs/promises";\nimport { lstatSync as microclawLstatSync } from "node:fs";\nimport { verifyWindowsCopiedFile } from ${JSON.stringify(import.meta.url)};`,
  ],
  [
    `    const expected = aliasGroup?.expected ?? manifest;
    if (!sameIdentity(expected, entryIdentity(currentStat))) {
        return aliasGroup ? poisonAliasGroup(aliasGroup) : "stale";
    }
    assertBeforeMutation();
    await fs.unlink(sourcePath);`,
    `    let expected = aliasGroup?.expected ?? manifest;
    let admitted = false;
    for (let observation = 0; observation < 2; observation++) {
        if (!sameIdentity(expected, entryIdentity(currentStat))) {
            const verified = !aliasGroup && currentStat.isFile() && manifest.microclawCopySha256
                ? await verifyWindowsCopiedFile(sourcePath, expected, manifest.microclawCopySha256)
                : undefined;
            if (!verified) return aliasGroup ? poisonAliasGroup(aliasGroup) : "stale";
            expected = verified;
        }
        assertBeforeMutation();
        try {
            currentStat = microclawLstatSync(sourcePath);
        } catch (error) {
            if (error?.code === "ENOENT" || error?.code === "ENOTDIR" || error?.code === "ELOOP") {
                return aliasGroup ? poisonAliasGroup(aliasGroup) : "stale";
            }
            throw error;
        }
        if (sameIdentity(expected, entryIdentity(currentStat))) {
            admitted = true;
            break;
        }
        if (process.platform !== "win32" || !manifest.microclawCopySha256) {
            return aliasGroup ? poisonAliasGroup(aliasGroup) : "stale";
        }
    }
    if (!admitted) return aliasGroup ? poisonAliasGroup(aliasGroup) : "stale";
    await fs.unlink(sourcePath);`,
  ],
];

function applyExactPatches(source, patches) {
  let patched = source;
  for (const [before, after] of patches) {
    const index = patched.indexOf(before);
    if (index < 0 || patched.indexOf(before, index + before.length) >= 0) {
      throw new Error("Pinned fs-safe Windows move patch did not match exactly once");
    }
    patched = patched.slice(0, index) + after + patched.slice(index + before.length);
  }
  return patched;
}

export function patchPinnedFsSafeMove(source) {
  return applyExactPatches(source, WINDOWS_MOVE_PATCHES);
}

export function patchPinnedFsSafeCleanup(source) {
  return applyExactPatches(source, WINDOWS_CLEANUP_PATCHES);
}

export function validateFsSafeMovePackage(openclawPackageDir) {
  if (!openclawPackageDir || !isAbsolute(openclawPackageDir)) {
    throw new Error("The fs-safe compatibility preload requires an absolute OpenClaw package path");
  }
  const require = createRequire(join(openclawPackageDir, "package.json"));
  const distDir = dirname(require.resolve("@openclaw/fs-safe/advanced"));
  const metadata = JSON.parse(readFileSync(join(distDir, "..", "package.json"), "utf8"));
  if (metadata.name !== "@openclaw/fs-safe") throw new Error("Unexpected fs-safe package identity");
  if (metadata.version !== PINNED_FS_SAFE_VERSION) return null;
  const file = realpathSync(join(distDir, "move-path.js"));
  const source = readFileSync(file);
  if (createHash("sha256").update(source).digest("hex") !== PINNED_FS_SAFE_MOVE_SHA256) {
    throw new Error(
      "The fs-safe 0.8.5 module differs from the pinned Windows compatibility source",
    );
  }
  patchPinnedFsSafeMove(source.toString("utf8"));
  const cleanupFile = realpathSync(join(distDir, "move-path-cleanup.js"));
  const cleanupSource = readFileSync(cleanupFile);
  if (createHash("sha256").update(cleanupSource).digest("hex") !== PINNED_FS_SAFE_CLEANUP_SHA256) {
    throw new Error(
      "The fs-safe 0.8.5 cleanup module differs from the pinned compatibility source",
    );
  }
  patchPinnedFsSafeCleanup(cleanupSource.toString("utf8"));
  return { file, source, cleanupFile, cleanupSource };
}

export function initializeFsSafeCompatibility(openclawPackageDir) {
  const target = validateFsSafeMovePackage(openclawPackageDir);
  if (!target) return false;
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (!url.startsWith("file:") || !/move-path(?:-cleanup)?\.js/.test(url)) return result;
      const file = realpathSync(fileURLToPath(url));
      if (file !== target.file && file !== target.cleanupFile) return result;
      if (result.source === undefined || result.source === null) {
        throw new Error("The pinned fs-safe module source is unavailable");
      }
      const source = typeof result.source === "string" ? result.source : Buffer.from(result.source);
      const expectedHash =
        file === target.file ? PINNED_FS_SAFE_MOVE_SHA256 : PINNED_FS_SAFE_CLEANUP_SHA256;
      if (createHash("sha256").update(source).digest("hex") !== expectedHash) {
        throw new Error(
          "The fs-safe module changed before the compatibility preload could load it",
        );
      }
      return {
        ...result,
        source: (file === target.file ? patchPinnedFsSafeMove : patchPinnedFsSafeCleanup)(
          source.toString(),
        ),
      };
    },
  });
  globalThis.console.log(
    "[microclaw-fs-safe-compat] Applied the upstream Windows move fix and digest-bound cleanup for fs-safe 0.8.5",
  );
  return true;
}

if (process.platform === "win32" && process.env.MICROCLAW_FS_SAFE_COMPAT === "1") {
  initializeFsSafeCompatibility(process.env.MICROCLAW_OPENCLAW_PACKAGE_DIR);
}
