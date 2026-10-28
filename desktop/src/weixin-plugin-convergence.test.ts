import { createHash } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  convergeWeixinPluginRuntime,
  resolveBundledWeixinPluginRoot,
} from "./weixin-plugin-convergence";

const roots: string[] = [];

function createRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "microclaw-weixin-convergence-"));
  roots.push(root);
  return root;
}

function sha256(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function createHost(root: string, version = "2026.10.5", includeExport = true): string {
  const host = path.join(root, "host");
  writeJson(path.join(host, "package.json"), {
    name: "openclaw",
    version,
    exports: includeExport ? { "./plugin-sdk/runtime": "./dist/runtime.js" } : {},
  });
  return host;
}

function createBundle(root: string, options: { nestedCore?: boolean } = {}): string {
  const bundle = path.join(root, "bundle");
  writeJson(path.join(bundle, "package.json"), {
    name: "@tencent-weixin/openclaw-weixin",
    version: "2.4.6",
    openclaw: { runtimeExtensions: ["./dist/index.js"] },
    microclaw: { sdkCompatibility: "2026.10.5" },
  });
  fs.mkdirSync(path.join(bundle, "dist"), { recursive: true });
  fs.writeFileSync(
    path.join(bundle, "dist", "index.js"),
    'import "openclaw/plugin-sdk/runtime";\nexport const ready = true;\n',
    "utf8",
  );
  if (options.nestedCore) {
    writeJson(path.join(bundle, "node_modules", "openclaw", "package.json"), {
      name: "openclaw",
      version: "2026.7.1-1",
    });
  }
  const files: Array<{ path: string; size: number; sha256: string }> = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(bundle, absolute).replaceAll("\\", "/");
      if (entry.isDirectory()) visit(absolute);
      else if (relative !== "microclaw-runtime.json") {
        files.push({
          path: relative,
          size: fs.statSync(absolute).size,
          sha256: sha256(absolute),
        });
      }
    }
  };
  visit(bundle);
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  writeJson(path.join(bundle, "microclaw-runtime.json"), {
    contract: "microclaw.weixin-runtime.v1",
    packageName: "@tencent-weixin/openclaw-weixin",
    packageVersion: "2.4.6",
    sdkCompatibility: "2026.10.5",
    requiredOpenClawExports: ["./plugin-sdk/runtime"],
    treeSha256: createHash("sha256")
      .update(files.map((file) => `${file.path}|${file.size}|${file.sha256}`).join("\n"))
      .digest("hex"),
    files,
  });
  return bundle;
}

function installedRoot(stateDir: string): string {
  return path.join(stateDir, "extensions", "openclaw-weixin");
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("Weixin plugin runtime convergence", () => {
  it("atomically replaces stale same-version content and preserves account state", () => {
    const root = createRoot();
    const stateDir = path.join(root, "state");
    const bundle = createBundle(root);
    const host = createHost(root);
    const installed = installedRoot(stateDir);
    writeJson(path.join(installed, "package.json"), {
      name: "@tencent-weixin/openclaw-weixin",
      version: "2.4.6",
      openclaw: { runtimeExtensions: ["./dist/index.js"] },
    });
    fs.mkdirSync(path.join(installed, "dist"), { recursive: true });
    fs.writeFileSync(
      path.join(installed, "dist", "index.js"),
      'import "openclaw/plugin-sdk/infra-runtime";\n',
      "utf8",
    );
    const accountState = path.join(stateDir, "openclaw-weixin", "accounts.json");
    fs.mkdirSync(path.dirname(accountState), { recursive: true });
    fs.writeFileSync(accountState, "sensitive-account-state", "utf8");

    const result = convergeWeixinPluginRuntime({
      bundledPluginRoot: bundle,
      stateDir,
      hostPackageDir: host,
    });

    expect(result).toMatchObject({ changed: true, packageVersion: "2.4.6" });
    expect(fs.readFileSync(path.join(installed, "dist", "index.js"), "utf8")).not.toContain(
      "infra-runtime",
    );
    expect(fs.realpathSync.native(path.join(installed, "node_modules", "openclaw"))).toBe(
      fs.realpathSync.native(host),
    );
    expect(fs.readFileSync(accountState, "utf8")).toBe("sensitive-account-state");
    expect(
      fs
        .readdirSync(path.join(stateDir, "extensions"))
        .filter((entry) => entry.startsWith(".openclaw-weixin-")),
    ).toEqual([]);
  });

  it("is a no-op when the exact pinned runtime and host peer link are already installed", () => {
    const root = createRoot();
    const stateDir = path.join(root, "state");
    const bundle = createBundle(root);
    const host = createHost(root);
    expect(
      convergeWeixinPluginRuntime({
        bundledPluginRoot: bundle,
        stateDir,
        hostPackageDir: host,
      }).changed,
    ).toBe(true);

    expect(
      convergeWeixinPluginRuntime({
        bundledPluginRoot: bundle,
        stateDir,
        hostPackageDir: host,
      }).changed,
    ).toBe(false);
  });

  it("does not hash the bundled runtime again when the installed runtime is valid", () => {
    const root = createRoot();
    const options = {
      bundledPluginRoot: createBundle(root),
      stateDir: path.join(root, "state"),
      hostPackageDir: createHost(root),
    };
    convergeWeixinPluginRuntime(options);
    const readFile = vi.spyOn(fs, "readFileSync");

    expect(convergeWeixinPluginRuntime(options).changed).toBe(false);

    const bundledEntry = path.join(options.bundledPluginRoot, "dist", "index.js");
    const installedEntry = path.join(installedRoot(options.stateDir), "dist", "index.js");
    expect(readFile.mock.calls.some(([filePath]) => String(filePath) === bundledEntry)).toBe(false);
    expect(readFile.mock.calls.some(([filePath]) => String(filePath) === installedEntry)).toBe(
      true,
    );
  });

  it("still hashes installed files and repairs same-size content changes on every convergence", () => {
    const root = createRoot();
    const options = {
      bundledPluginRoot: createBundle(root),
      stateDir: path.join(root, "state"),
      hostPackageDir: createHost(root),
    };
    convergeWeixinPluginRuntime(options);
    const entry = path.join(installedRoot(options.stateDir), "dist", "index.js");
    const original = fs.readFileSync(entry, "utf8");
    const modified = original.replace("ready = true", "ready = null");
    expect(modified).not.toBe(original);
    expect(Buffer.byteLength(modified)).toBe(Buffer.byteLength(original));
    fs.writeFileSync(entry, modified, "utf8");

    expect(convergeWeixinPluginRuntime(options).changed).toBe(true);
    expect(fs.readFileSync(entry, "utf8")).toBe(original);
  });

  it("validates the bundled tree before replacing an invalid installation", () => {
    const root = createRoot();
    const options = {
      bundledPluginRoot: createBundle(root),
      stateDir: path.join(root, "state"),
      hostPackageDir: createHost(root),
    };
    convergeWeixinPluginRuntime(options);
    const entry = path.join(installedRoot(options.stateDir), "dist", "index.js");
    fs.writeFileSync(entry, "invalid-installed-runtime", "utf8");
    fs.writeFileSync(
      path.join(options.bundledPluginRoot, "dist", "index.js"),
      "invalid-bundled-runtime",
      "utf8",
    );

    expect(() => convergeWeixinPluginRuntime(options)).toThrow(/provenance validation/);
    expect(fs.readFileSync(entry, "utf8")).toBe("invalid-installed-runtime");
  });

  it("fails closed before mutation for an incompatible host version or missing SDK export", () => {
    for (const host of [
      createHost(createRoot(), "2026.7.1-1"),
      createHost(createRoot(), "2026.10.2"),
      createHost(createRoot(), "2026.10.5", false),
    ]) {
      const root = createRoot();
      const stateDir = path.join(root, "state");
      const bundle = createBundle(root);
      expect(() =>
        convergeWeixinPluginRuntime({
          bundledPluginRoot: bundle,
          stateDir,
          hostPackageDir: host,
        }),
      ).toThrow(/requires OpenClaw 2026\.10\.5|missing required Weixin SDK exports/);
      expect(fs.existsSync(installedRoot(stateDir))).toBe(false);
    }
  });

  it("rejects a bundled physical OpenClaw core copy", () => {
    const root = createRoot();
    expect(() =>
      convergeWeixinPluginRuntime({
        bundledPluginRoot: createBundle(root, { nestedCore: true }),
        stateDir: path.join(root, "state"),
        hostPackageDir: createHost(root),
      }),
    ).toThrow(/must not contain an OpenClaw core copy or link/);
  });

  it("rolls back the previous plugin when post-rename validation fails", () => {
    const root = createRoot();
    const stateDir = path.join(root, "state");
    const installed = installedRoot(stateDir);
    fs.mkdirSync(path.join(installed, "dist"), { recursive: true });
    fs.writeFileSync(path.join(installed, "dist", "index.js"), "previous-runtime", "utf8");
    fs.writeFileSync(path.join(installed, "keep.txt"), "preserve-me", "utf8");

    expect(() =>
      convergeWeixinPluginRuntime({
        bundledPluginRoot: createBundle(root),
        stateDir,
        hostPackageDir: createHost(root),
        hooks: {
          afterInstalledRename: () => {
            throw new Error("injected post-rename failure");
          },
        },
      }),
    ).toThrow(/injected post-rename failure/);

    expect(fs.readFileSync(path.join(installed, "dist", "index.js"), "utf8")).toBe(
      "previous-runtime",
    );
    expect(fs.readFileSync(path.join(installed, "keep.txt"), "utf8")).toBe("preserve-me");
    expect(
      fs
        .readdirSync(path.join(stateDir, "extensions"))
        .filter((entry) => entry.startsWith(".openclaw-weixin-")),
    ).toEqual([]);
  });

  it("resolves packaged and development resource roots deterministically", () => {
    expect(resolveBundledWeixinPluginRoot(true, "C:\\package\\resources", "C:\\app\\dist")).toBe(
      path.join("C:\\package\\resources", "openclaw-weixin"),
    );
    expect(resolveBundledWeixinPluginRoot(false, "ignored", "C:\\app\\dist")).toBe(
      path.resolve("C:\\app\\dist", "..", "resources", "openclaw-weixin"),
    );
  });
});
