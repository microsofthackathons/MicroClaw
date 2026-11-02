import { createPackage } from "@electron/asar";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

const preload = join(__dirname, "openclaw-archive-loader.mjs");
const { openRuntimeModuleArchive, initializeRuntimeModuleArchive } =
  createRequire(__filename)(preload);

async function withArchive(
  run: (paths: { root: string; runtime: string; archive: string; entry: string }) => void,
) {
  const root = mkdtempSync(join(tmpdir(), "microclaw-module-archive-"));
  const runtime = join(root, "runtime");
  const archive = join(root, "openclaw.asar");
  const entry = join(runtime, "module.mjs");
  try {
    mkdirSync(runtime);
    writeFileSync(entry, 'export const value = "ARCHIVED_MODULE";\n');
    await createPackage(runtime, archive);
    run({ root, runtime, archive, entry });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("bundled runtime module archive", () => {
  it("reads unchanged module bytes from a single archive", async () => {
    await withArchive(({ runtime, archive, entry }) => {
      const reader = openRuntimeModuleArchive(archive, runtime);
      try {
        expect(reader.source(pathToFileURL(entry).href)).toEqual(readFileSync(entry));
        expect(reader.source(pathToFileURL(entry).href)).toEqual(readFileSync(entry));
      } finally {
        reader.close();
        reader.close();
      }
    });
  });

  it("does not provide bytes for modules outside the bundled runtime", async () => {
    await withArchive(({ root, runtime, archive }) => {
      const reader = openRuntimeModuleArchive(archive, runtime);
      try {
        expect(reader.source("node:fs")).toBeUndefined();
        expect(reader.source(pathToFileURL(join(root, "module.mjs")).href)).toBeUndefined();
        expect(
          reader.source(pathToFileURL(join(root, "runtime-other", "module.mjs")).href),
        ).toBeUndefined();
        expect(reader.source(pathToFileURL(join(runtime, "missing.mjs")).href)).toBeUndefined();
      } finally {
        reader.close();
      }
    });
  });

  it("rejects corrupted archived module bytes", async () => {
    await withArchive(({ runtime, archive, entry }) => {
      const bytes = readFileSync(archive);
      bytes[bytes.length - 1] ^= 1;
      writeFileSync(archive, bytes);
      const reader = openRuntimeModuleArchive(archive, runtime);
      try {
        expect(() => reader.source(pathToFileURL(entry).href)).toThrow("integrity mismatch");
      } finally {
        reader.close();
      }
    });
  });

  it("rejects malformed or truncated archive headers", async () => {
    await withArchive(({ runtime, archive }) => {
      for (const bytes of [
        Buffer.alloc(3),
        Buffer.alloc(8),
        Buffer.from([4, 0, 0, 0, 255, 255, 255, 127]),
      ]) {
        writeFileSync(archive, bytes);
        expect(() => openRuntimeModuleArchive(archive, runtime)).toThrow();
      }
    });
  });

  it("preserves loader chaining and existing source overrides", async () => {
    await withArchive(({ runtime, archive, entry }) => {
      const handle = { deregister: vi.fn() };
      const register = vi.fn().mockReturnValue(handle);
      const loader = initializeRuntimeModuleArchive(archive, runtime, register);
      try {
        const { load } = register.mock.calls[0][0];
        const next = vi.fn().mockReturnValue({ format: "module", source: "verified" });
        const context = { format: "module", importAttributes: {} };
        const url = pathToFileURL(entry).href;
        expect(load(url, context, next)).toEqual({ format: "module", source: "verified" });
        expect(next).toHaveBeenLastCalledWith(url, { ...context, source: readFileSync(entry) });
        const override = { ...context, source: "already transformed" };
        load(url, override, next);
        expect(next).toHaveBeenLastCalledWith(url, override);
        const commonjs = { format: "commonjs" };
        load(url, commonjs, next);
        expect(next).toHaveBeenLastCalledWith(url, commonjs);
      } finally {
        loader.close();
      }
      expect(handle.deregister).toHaveBeenCalledOnce();
    });
  });

  it("loads archived ESM through Node while retaining normal resolution", async () => {
    await withArchive(({ runtime, archive, entry }) => {
      writeFileSync(entry, 'throw new Error("must not read the extracted source");');
      const driver = join(runtime, "driver.mjs");
      writeFileSync(driver, 'console.log((await import("./module.mjs")).value);');
      const result = spawnSync(
        process.execPath,
        ["--import", pathToFileURL(preload).href, driver],
        {
          encoding: "utf8",
          timeout: 15_000,
          windowsHide: true,
          env: {
            ...process.env,
            MICROCLAW_OPENCLAW_ARCHIVE: archive,
            MICROCLAW_OPENCLAW_RUNTIME_ROOT: runtime,
          },
        },
      );
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("ARCHIVED_MODULE");
    });
  });

  it("retains archive loading in owned Workers with an explicit empty execArgv", async () => {
    await withArchive(({ runtime, archive, entry }) => {
      writeFileSync(entry, 'throw new Error("must not read the extracted source");');
      const workerPath = join(runtime, "worker.mjs");
      writeFileSync(
        workerPath,
        'import { parentPort } from "node:worker_threads"; import { value } from "./module.mjs"; parentPort.postMessage(value);',
      );
      const script = `import { Worker } from "node:worker_threads"; const worker = new Worker(new URL(${JSON.stringify(pathToFileURL(workerPath).href)}), { execArgv: [] }); worker.once("message", console.log);`;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
        timeout: 15_000,
        windowsHide: true,
        env: {
          ...process.env,
          NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`,
          MICROCLAW_OPENCLAW_ARCHIVE: archive,
          MICROCLAW_OPENCLAW_RUNTIME_ROOT: runtime,
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("ARCHIVED_MODULE");
    });
  });

  it("retains archive loading in forked inspectors with an explicit empty execArgv", async () => {
    await withArchive(({ runtime, archive, entry }) => {
      writeFileSync(entry, 'throw new Error("must not read the extracted source");');
      const inspector = join(runtime, "inspector.mjs");
      writeFileSync(inspector, 'import { value } from "./module.mjs"; process.send(value);');
      const script = `import { fork } from "node:child_process"; const child = fork(${JSON.stringify(inspector)}, [], { execArgv: [] }); child.once("message", (message) => console.log(message));`;
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
        encoding: "utf8",
        timeout: 15_000,
        windowsHide: true,
        env: {
          ...process.env,
          NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`,
          MICROCLAW_OPENCLAW_ARCHIVE: archive,
          MICROCLAW_OPENCLAW_RUNTIME_ROOT: runtime,
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("ARCHIVED_MODULE");
    });
  });

  it("does not open the archive in unrelated Node tool processes", async () => {
    await withArchive(({ root, runtime }) => {
      const tool = join(root, "tool.mjs");
      writeFileSync(tool, 'console.log("UNRELATED_TOOL");');
      const result = spawnSync(process.execPath, [tool], {
        encoding: "utf8",
        timeout: 15_000,
        windowsHide: true,
        env: {
          ...process.env,
          NODE_OPTIONS: `--import ${pathToFileURL(preload).href}`,
          MICROCLAW_OPENCLAW_ARCHIVE: join(root, "missing.asar"),
          MICROCLAW_OPENCLAW_RUNTIME_ROOT: runtime,
        },
      });
      expect(result.error).toBeUndefined();
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe("UNRELATED_TOOL");
    });
  });
});
