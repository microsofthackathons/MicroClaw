import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
// @ts-expect-error This preload is external ESM executed by the supported Gateway Node runtime.
import * as compatibility from "./openclaw-fs-safe-compat.mjs";

const {
  patchPinnedFsSafeMove,
  patchPinnedFsSafeCleanup,
  validateFsSafeMovePackage,
  WINDOWS_MOVE_PATCHES,
  WINDOWS_CLEANUP_PATCHES,
} = compatibility;
const source = WINDOWS_MOVE_PATCHES.map(([before]: [string, string]) => before).join("\n");
const roots: string[] = [];

function createPackage(version: string) {
  const root = mkdtempSync(join(tmpdir(), "microclaw-fs-safe-compat-"));
  roots.push(root);
  const fsSafe = join(root, "node_modules", "@openclaw", "fs-safe");
  mkdirSync(join(fsSafe, "dist"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "openclaw" }));
  writeFileSync(
    join(fsSafe, "package.json"),
    JSON.stringify({
      name: "@openclaw/fs-safe",
      version,
      exports: { "./advanced": "./dist/advanced.js" },
    }),
  );
  writeFileSync(join(fsSafe, "dist", "advanced.js"), "");
  writeFileSync(join(fsSafe, "dist", "move-path.js"), source);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("pinned upstream Windows move compatibility", () => {
  it("retains path revalidation and uses the opened identity for copying and cleanup", () => {
    const patched = patchPinnedFsSafeMove(source);
    expect(patched).toContain("await assertSourceStillMatches(params.from, openedIdentity)");
    expect(patched).toContain("sameIdentity(openedIdentity, entryIdentity(finalSourceStat))");
    expect(patched).toContain("return openedIdentity");
    expect(patched).toContain('return { ...copiedIdentity, kind: "leaf" }');
    expect(patched).toContain("copiedHash?.update(scratch.subarray(0, bytesRead))");
    expect(patched).toContain("microclawCopySha256: digest");
    const cleanup = patchPinnedFsSafeCleanup(
      WINDOWS_CLEANUP_PATCHES.map(([before]: [string, string]) => before).join("\n"),
    );
    expect(cleanup).toContain(
      "await verifyWindowsCopiedFile(sourcePath, expected, manifest.microclawCopySha256)",
    );
    expect(cleanup.indexOf("assertBeforeMutation()")).toBeLessThan(
      cleanup.indexOf("currentStat = microclawLstatSync(sourcePath)"),
    );
  });

  it("accepts only Windows read-open ctime advancement, with all other identity fields unchanged", () => {
    const patched: string = patchPinnedFsSafeMove(source);
    const predicate = patched.match(/const openAdvancedWindowsCtime =([\s\S]+?);/)?.[1];
    expect(predicate).toBeDefined();
    const accepts = new Function("params", "openedIdentity", "process", `return (${predicate});`);
    const identity = { dev: 1, ino: 2, mode: 3, nlink: 1, size: 8, mtimeMs: 50, ctimeMs: 50 };
    expect(accepts({ identity }, { ...identity, ctimeMs: 51 }, { platform: "win32" })).toBe(true);
    expect(accepts({ identity }, { ...identity, ctimeMs: 51 }, { platform: "linux" })).toBe(false);
    expect(accepts({ identity }, { ...identity, ctimeMs: 49 }, { platform: "win32" })).toBe(false);
    for (const field of ["dev", "ino", "mode", "nlink", "size", "mtimeMs"] as const) {
      expect(
        accepts(
          { identity },
          { ...identity, [field]: identity[field] + 1, ctimeMs: 51 },
          { platform: "win32" },
        ),
        field,
      ).toBe(false);
    }
  });

  it("rejects missing, duplicate, modified and unpinned source instead of weakening checks", () => {
    expect(() => patchPinnedFsSafeMove("different module")).toThrow("exactly once");
    expect(() => patchPinnedFsSafeMove(source + "\n" + source)).toThrow("exactly once");
    expect(() => patchPinnedFsSafeCleanup("different cleanup module")).toThrow("exactly once");
    expect(() => validateFsSafeMovePackage("relative")).toThrow("absolute");
    expect(() => validateFsSafeMovePackage(createPackage("0.8.5"))).toThrow("differs");
  });

  it("leaves other versions to their own implementation", () => {
    expect(validateFsSafeMovePackage(createPackage("0.10.0"))).toBeNull();
  });

  const packageDir = process.env.MICROCLAW_OPENCLAW_TEST_PACKAGE_DIR;
  it.skipIf(!packageDir)(
    "loads the real pinned module in memory without modifying installed bytes",
    () => {
      const require = createRequire(join(packageDir!, "package.json"));
      const file = join(dirname(require.resolve("@openclaw/fs-safe/advanced")), "move-path.js");
      const before = createHash("sha256").update(readFileSync(file)).digest("hex");
      const target = validateFsSafeMovePackage(packageDir);
      const parsed = spawnSync(process.execPath, ["--check", "--input-type=module"], {
        input: patchPinnedFsSafeMove(target.source.toString("utf8")),
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(parsed.status, parsed.stderr).toBe(0);
      const cleanupBefore = createHash("sha256")
        .update(readFileSync(target.cleanupFile))
        .digest("hex");
      const parsedCleanup = spawnSync(process.execPath, ["--check", "--input-type=module"], {
        input: patchPinnedFsSafeCleanup(target.cleanupSource.toString("utf8")),
        encoding: "utf8",
        timeout: 10_000,
      });
      expect(parsedCleanup.status, parsedCleanup.stderr).toBe(0);
      const initialized = spawnSync(
        process.execPath,
        [
          "--import",
          pathToFileURL(resolve(__dirname, "openclaw-fs-safe-compat.mjs")).href,
          "--input-type=module",
          "-e",
          `await import(${JSON.stringify(pathToFileURL(file).href)});`,
        ],
        {
          env: {
            ...process.env,
            MICROCLAW_FS_SAFE_COMPAT: "1",
            MICROCLAW_OPENCLAW_PACKAGE_DIR: packageDir,
          },
          encoding: "utf8",
          timeout: 20_000,
        },
      );
      expect(initialized.status, initialized.stderr).toBe(0);
      expect(initialized.stdout).toContain("Applied the upstream Windows move fix");
      expect(createHash("sha256").update(readFileSync(file)).digest("hex")).toBe(before);
      expect(createHash("sha256").update(readFileSync(target.cleanupFile)).digest("hex")).toBe(
        cleanupBefore,
      );
      const altered = createPackage("0.8.5");
      const alteredDist = join(altered, "node_modules", "@openclaw", "fs-safe", "dist");
      writeFileSync(join(alteredDist, "move-path.js"), target.source);
      writeFileSync(join(alteredDist, "move-path-cleanup.js"), "modified cleanup");
      expect(() => validateFsSafeMovePackage(altered)).toThrow("cleanup module differs");
    },
  );

  const pluginFixture = process.env.MICROCLAW_TEST_LOCAL_PLUGIN_DIR;
  it.skipIf(!packageDir || !pluginFixture)(
    "repeatedly moves the real plugin offline and cleans every source without changing installed files",
    () => {
      const runner = `
        import fs from "node:fs/promises";
        import fsSync from "node:fs";
        import { createHash } from "node:crypto";
        import { createRequire } from "node:module";
        import { tmpdir } from "node:os";
        import path from "node:path";
        import { pathToFileURL } from "node:url";
        import assert from "node:assert/strict";
        const require = createRequire(path.join(process.env.MICROCLAW_OPENCLAW_PACKAGE_DIR, "package.json"));
        const {movePathWithCopyFallback} = await import(pathToFileURL(path.join(path.dirname(require.resolve("@openclaw/fs-safe/advanced")), "move-path.js")));
        const root = await fs.mkdtemp(path.join(tmpdir(), "microclaw-plugin-move-"));
        const fixture = process.env.MICROCLAW_TEST_LOCAL_PLUGIN_DIR;
        const expected = new Map();
        async function collect(dir, relative = "") {
          for (const item of await fs.readdir(dir, {withFileTypes:true})) {
            const name = path.join(relative, item.name);
            if (item.isDirectory()) await collect(path.join(dir,item.name),name);
            else if (item.isFile()) expected.set(name, createHash("sha256").update(await fs.readFile(path.join(dir,item.name))).digest("hex"));
          }
        }
        await collect(fixture);
        try {
          for (let attempt=0;attempt<100;attempt++) {
            const from=path.join(root,"source-"+attempt);
            const to=path.join(root,"destination-"+attempt);
            await fs.cp(fixture,from,{recursive:true,verbatimSymlinks:true});
            await movePathWithCopyFallback({from,to,sourceHardlinks:"reject"});
            assert.equal(await fs.lstat(from).then(()=>true,error=>{if(error.code==="ENOENT")return false;throw error;}),false);
            for (const [name,hash] of expected) {
              assert.equal(createHash("sha256").update(await fs.readFile(path.join(to,name))).digest("hex"),hash);
            }
          }
          assert.equal((await fs.readdir(root)).filter(name=>name.startsWith(".fs-safe-move-")).length,0);
          const from=path.join(root,"raced-source"),to=path.join(root,"raced-destination");
          await fs.cp(fixture,from,{recursive:true,verbatimSymlinks:true});
          const racedFile=path.join(from,"dist","index.js");
          let published=false,mutated=false;
          await assert.rejects(movePathWithCopyFallback({
            from,to,sourceHardlinks:"reject",
            onDestinationPublished:()=>{published=true;},
            assertBeforeMutation:()=>{
              if(!published||mutated)return;
              mutated=true;
              const before=fsSync.statSync(racedFile);
              const contents=fsSync.readFileSync(racedFile);
              contents[0]^=1;
              fsSync.writeFileSync(racedFile,contents);
              fsSync.utimesSync(racedFile,before.atime,before.mtime);
            },
          }),error=>error.code==="ESTALE");
          assert.equal(mutated,true);
          assert.notEqual(createHash("sha256").update(await fs.readFile(racedFile)).digest("hex"),expected.get(path.join("dist","index.js")));
          assert.equal(createHash("sha256").update(await fs.readFile(path.join(to,"dist","index.js"))).digest("hex"),expected.get(path.join("dist","index.js")));
          console.log("100 plugin moves passed; sources cleaned; payload hashes unchanged");
        } finally {
          await fs.rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:200});
        }
      `;
      const child = spawnSync(
        process.execPath,
        [
          "--import",
          pathToFileURL(resolve(__dirname, "openclaw-fs-safe-compat.mjs")).href,
          "--input-type=module",
        ],
        {
          input: runner,
          env: {
            ...process.env,
            MICROCLAW_FS_SAFE_COMPAT: "1",
            MICROCLAW_OPENCLAW_PACKAGE_DIR: packageDir,
            MICROCLAW_TEST_LOCAL_PLUGIN_DIR: pluginFixture,
          },
          encoding: "utf8",
          timeout: 90_000,
        },
      );
      expect(child.status, child.stderr).toBe(0);
      expect(child.stdout).toContain("100 plugin moves passed");
    },
    100_000,
  );
});
