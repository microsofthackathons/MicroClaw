import { spawnSync } from "node:child_process";
import {
  cpSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import {
  LOCAL_MODEL_PRESETS,
  LOCAL_MODEL_DOWNLOAD_PROMPT,
  LOCAL_MODEL_SELECTION_PROMPT,
} from "./local-model-catalog";
// @ts-expect-error External ESM preload runs in the supported Gateway runtime.
import * as compatibility from "./openclaw-local-model-compat.mjs";
const {
  EXACT_SETUP_PLAN,
  EXACT_MODEL_SELECTION_PROMPT,
  PINNED_LOCAL_CONFIG_FILE,
  PINNED_LOCAL_PLUGIN_VERSION,
  patchLocalModelPlugin,
  createLocalModelCompatibilityLoadHook,
  initializeLocalModelCompatibility,
} = compatibility;

function withProviderFiles(
  run: (paths: { root: string; plugin: string; captured: string; entry: string }) => void,
  source = "unverified provider source",
) {
  const root = mkdtempSync(join(tmpdir(), "microclaw-provider-load-"));
  const plugin = join(root, "extensions", "llama-cpp");
  const captured = join(
    root,
    "tmp",
    "plugin-captures",
    "generation",
    "captures",
    "openclaw-plugin-build-test",
    "package-0",
    "node_modules",
    "llama-cpp",
  );
  try {
    for (const directory of [plugin, captured]) {
      mkdirSync(join(directory, "dist"), { recursive: true });
      writeFileSync(join(directory, "dist", "index.js"), source);
      writeFileSync(
        join(directory, "package.json"),
        JSON.stringify({
          name: "@openclaw/llama-cpp-provider",
          version: PINNED_LOCAL_PLUGIN_VERSION,
          type: "module",
        }),
      );
    }
    run({ root, plugin, captured, entry: join(captured, "dist", "index.js") });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function expectLateProviderLoad(
  paths: { root: string; plugin: string; captured: string; entry: string },
  verified: boolean,
) {
  expect(paths.plugin).toBe(join(paths.root, "extensions", "llama-cpp"));
  rmSync(paths.plugin, { recursive: true });
  const child = spawnSync(
    process.execPath,
    [
      "--import",
      pathToFileURL(join(__dirname, "openclaw-local-model-compat.mjs")).href,
      "--input-type=module",
      "--eval",
      `
import assert from "node:assert/strict";
import { cpSync, existsSync, readFileSync } from "node:fs";
import { registerHooks } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const fixture = JSON.parse(process.argv[1]);
assert.equal(existsSync(fixture.plugin), false);
await import("node:os");
cpSync(fixture.captured, fixture.plugin, { recursive: true });
const entryUrl = pathToFileURL(fixture.entry).href;
if (fixture.verified) {
  const expected = new Map([
    [entryUrl, ${JSON.stringify(EXACT_MODEL_SELECTION_PROMPT)}],
    [pathToFileURL(join(dirname(fixture.entry), ${JSON.stringify(PINNED_LOCAL_CONFIG_FILE)})).href, "modelscope.cn"],
  ]);
  registerHooks({
    load(url, context, nextLoad) {
      const result = nextLoad(url, context);
      if (!expected.has(url)) return result;
      assert.ok(String(result.source).includes(expected.get(url)));
      return { ...result, format: "module", source: "export default true;" };
    },
  });
  for (const url of expected.keys()) assert.equal((await import(url)).default, true);
} else {
  await assert.rejects(import(entryUrl), /differs from its pinned release/);
}
assert.equal(
  readFileSync(join(fixture.plugin, "dist", "index.js"), "utf8"),
  readFileSync(join(fixture.captured, "dist", "index.js"), "utf8"),
);
`,
      JSON.stringify({ ...paths, verified }),
    ],
    {
      env: {
        ...process.env,
        OPENCLAW_STATE_DIR: paths.root,
        MICROCLAW_EXACT_LOCAL_MODELS: "1",
        MICROCLAW_LOCAL_MODEL_PLUGIN_DIR: paths.plugin,
      },
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    },
  );
  expect(child.error).toBeUndefined();
  expect(child.status, `${child.stderr}\n${child.stdout}`).toBe(0);
}

describe("local provider compatibility initialization", () => {
  it("registers before first installation and verifies provider bytes when they are later loaded", () => {
    withProviderFiles(({ plugin, captured, entry }) => {
      rmSync(plugin, { recursive: true });
      const handle = { deregister: vi.fn() };
      const register = vi.fn().mockReturnValue(handle);
      expect(initializeLocalModelCompatibility(plugin, register)).toBe(handle);
      expect(register).toHaveBeenCalledExactlyOnceWith({ load: expect.any(Function) });
      const load = register.mock.calls[0][0].load;
      const unrelated = { format: "module", source: "unrelated" };
      expect(load("node:fs", {}, () => unrelated)).toBe(unrelated);

      cpSync(captured, plugin, { recursive: true });
      for (const filename of [join(plugin, "dist", "index.js"), entry]) {
        expect(() =>
          load(pathToFileURL(filename).href, {}, () => ({
            format: "module",
            source: "unverified provider source",
          })),
        ).toThrow("source differs from its pinned release");
      }
    });
  });

  it("rejects a redirected provider installed after hook registration", () => {
    withProviderFiles(({ plugin, captured }) => {
      rmSync(plugin, { recursive: true });
      const register = vi.fn();
      initializeLocalModelCompatibility(plugin, register);
      const load = register.mock.calls[0][0].load;
      symlinkSync(captured, plugin, "junction");
      expect(() =>
        load(pathToFileURL(join(plugin, "dist", "index.js")).href, {}, () => ({
          format: "module",
          source: "unverified provider source",
        })),
      ).toThrow("must not be redirected");
    });
  });

  it("intercepts first-install imports through the real Node loading hook", () => {
    withProviderFiles(({ root, plugin, captured }) => {
      rmSync(plugin, { recursive: true });
      const compatibilityUrl = pathToFileURL(
        join(__dirname, "openclaw-local-model-compat.mjs"),
      ).href;
      const entryUrl = pathToFileURL(join(plugin, "dist", "index.js")).href;
      const child = spawnSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `import { cpSync } from "node:fs";
           import { initializeLocalModelCompatibility } from ${JSON.stringify(compatibilityUrl)};
           initializeLocalModelCompatibility(${JSON.stringify(plugin)});
           cpSync(${JSON.stringify(captured)}, ${JSON.stringify(plugin)}, { recursive: true });
           await import(${JSON.stringify(entryUrl)});`,
        ],
        {
          cwd: root,
          encoding: "utf8",
          env: {
            ...process.env,
            OPENCLAW_STATE_DIR: root,
            MICROCLAW_EXACT_LOCAL_MODELS: "0",
          },
          timeout: 10_000,
          windowsHide: true,
        },
      );
      expect(child.error).toBeUndefined();
      expect(child.status).toBe(1);
      expect(child.stderr).toContain("The local provider source differs from its pinned release");
    });
  });

  it("keeps unrelated loads unchanged while the provider remains absent", () => {
    withProviderFiles(({ root }) => {
      const register = vi.fn();
      initializeLocalModelCompatibility(join(root, "missing-provider"), register);
      const load = register.mock.calls[0][0].load;
      const result = { format: "module", source: "unrelated" };
      expect(load("node:fs", {}, () => result)).toBe(result);
    });
  });

  it.each(["installed", "captured"])(
    "rejects unverified %s modules installed after the Gateway preload ran",
    (location) => {
      withProviderFiles((paths) => {
        expectLateProviderLoad(
          {
            ...paths,
            entry: location === "installed" ? join(paths.plugin, "dist", "index.js") : paths.entry,
          },
          false,
        );
      }, 'export default "unverified provider";');
    },
  );

  it("registers the verified load hook when the provider directory exists", () => {
    withProviderFiles(({ plugin }) => {
      const handle = { deregister: vi.fn() };
      const register = vi.fn().mockReturnValue(handle);
      expect(initializeLocalModelCompatibility(plugin, register)).toBe(handle);
      expect(register).toHaveBeenCalledExactlyOnceWith({ load: expect.any(Function) });
    });
  });

  it("rejects relative provider paths even when the provider is absent", () => {
    const register = vi.fn();
    expect(() => initializeLocalModelCompatibility("missing-provider", register)).toThrow(
      "absolute local provider directory",
    );
    expect(register).not.toHaveBeenCalled();
  });

  it("does not hide an invalid provider directory as an absent provider", () => {
    withProviderFiles(({ plugin }) => {
      const register = vi.fn();
      expect(() =>
        initializeLocalModelCompatibility(join(plugin, "package.json"), register),
      ).toThrow("unredirected directory");
      expect(register).not.toHaveBeenCalled();
    });
  });
});

describe("local provider capture loading", () => {
  it("leaves unrelated modules and lookalike capture roots unchanged", () => {
    withProviderFiles(({ root, plugin }) => {
      const load = createLocalModelCompatibilityLoadHook(plugin, root);
      const result = { format: "module", source: "unrelated" };
      const next = vi.fn().mockReturnValue(result);
      for (const url of [
        "node:fs",
        pathToFileURL(join(root, "other", "node_modules", "llama-cpp", "dist", "index.js")).href,
        pathToFileURL(
          join(
            root,
            "tmp",
            "plugin-captures-other",
            "node_modules",
            "llama-cpp",
            "dist",
            "index.js",
          ),
        ).href,
      ]) {
        expect(load(url, {}, next)).toBe(result);
      }
    });
  });

  it("recognizes capture entries but refuses unverified plugin bytes", () => {
    withProviderFiles(({ root, plugin, entry }) => {
      const load = createLocalModelCompatibilityLoadHook(plugin, root);
      expect(() =>
        load(pathToFileURL(entry).href, {}, () => ({
          format: "module",
          source: "unverified provider source",
        })),
      ).toThrow("pinned");
    });
  });

  it("rejects snapshots that differ from their original installed source", () => {
    withProviderFiles(({ root, plugin, entry }) => {
      const load = createLocalModelCompatibilityLoadHook(plugin, root);
      expect(() =>
        load(pathToFileURL(entry).href, {}, () => ({
          format: "module",
          source: "different snapshot",
        })),
      ).toThrow("differs from its installed source");
    });
  });

  it("rejects a capture whose provider identity changed", () => {
    withProviderFiles(({ root, plugin, captured, entry }) => {
      writeFileSync(
        join(captured, "package.json"),
        JSON.stringify({
          name: "@openclaw/llama-cpp-provider",
          version: "2026.10.3",
        }),
      );
      const load = createLocalModelCompatibilityLoadHook(plugin, root);
      expect(() =>
        load(pathToFileURL(entry).href, {}, () => ({
          format: "module",
          source: "unverified provider source",
        })),
      ).toThrow("pinned official");
    });
  });

  it("rejects redirected captured provider directories", () => {
    withProviderFiles(({ root, plugin, captured, entry }) => {
      rmSync(captured, { recursive: true });
      symlinkSync(plugin, captured, "junction");
      const load = createLocalModelCompatibilityLoadHook(plugin, root);
      expect(() =>
        load(pathToFileURL(entry).href, {}, () => ({
          format: "module",
          source: "unverified provider source",
        })),
      ).toThrow("must not be redirected");
    });
  });

  it("requires absolute configured paths", () => {
    expect(() => createLocalModelCompatibilityLoadHook(undefined)).toThrow("absolute");
    expect(() => createLocalModelCompatibilityLoadHook("relative")).toThrow("absolute");
  });
});

function fixture(selected = LOCAL_MODEL_PRESETS[0].modelRef as string, cached = false) {
  const recipes = [...LOCAL_MODEL_PRESETS].reverse().map((model) => ({
    model: { id: model.modelRef.slice("llama-cpp/".length), name: model.name },
    sizeBytes: model.downloadBytes,
  }));
  const ctx = {
    config: { agents: { defaults: { model: { primary: "cloud/keep" } } } },
    signal: undefined,
    prompter: {
      select: vi.fn().mockResolvedValue(selected),
      confirm: vi.fn().mockResolvedValue(true),
    },
  };
  const candidates = { recipes };
  const cachedArtifact = vi.fn().mockResolvedValue(cached ? "C:\\models\\cached.gguf" : undefined);
  const hardware = {
    availableDiskBytes: 100 * 1024 ** 3,
    availableRuntimeDiskBytes: 100 * 1024 ** 3,
    sharedDisk: true,
  };
  const plan = new Function(
    "LLAMA_CPP_MODEL_RECIPES",
    "resolveLlamaCppModelCandidates",
    "LLAMA_CPP_PROVIDER_ID",
    "buildLlamaCppProviderConfig",
    "resolveLlamaCppModelCacheDir",
    "resolveCachedArtifact",
    "resolveLlamaCppModelSource",
    "resolveEmbeddingSetup",
    "isFile",
    "resolveManagedLlamaServerPaths",
    "DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_SIZE_BYTES",
    "GIB",
    `${EXACT_SETUP_PLAN}; return resolveSetupPlan;`,
  )(
    recipes,
    () => candidates,
    "llama-cpp",
    (value: unknown) => value,
    () => "C:\\cache",
    cachedArtifact,
    (model: { id: string }) => model.id,
    () => ({ model: { source: "embedding" } }),
    async () => cached,
    () => ({ command: "runtime" }),
    328577056,
    1024 ** 3,
  );
  return {
    ctx,
    recipes,
    candidates,
    hardware,
    run: () => plan(ctx, [], true, false, hardware, { backend: "cpu" }, undefined),
  };
}

describe("pinned exact local model chooser", () => {
  it("selects 4B exactly even when upstream priority lists 9B first", async () => {
    const f = fixture();
    const before = structuredClone(f.ctx.config);
    const plan = await f.run();
    expect(plan.candidate.model.id).toBe("qwen3.5-4b-q4_k_m");
    expect(f.ctx.config).toEqual(before);
    expect(f.ctx.prompter.select).toHaveBeenCalledWith(
      expect.objectContaining({ message: LOCAL_MODEL_SELECTION_PROMPT }),
    );
    const message = f.ctx.prompter.confirm.mock.calls[0][0].message as string;
    expect(message.startsWith(`${LOCAL_MODEL_DOWNLOAD_PROMPT}\n`)).toBe(true);
    expect(JSON.parse(message.split("\n")[1])).toMatchObject({
      modelRef: LOCAL_MODEL_PRESETS[0].modelRef,
      modelBytes: 2740937888,
      backend: "cpu",
    });
  });
  it("prepares 9B only when the user selected 9B", async () => {
    const f = fixture(LOCAL_MODEL_PRESETS[1].modelRef);
    expect((await f.run()).candidate.model.id).toBe("qwen3.5-9b-q4_k_m");
  });
  it.each(LOCAL_MODEL_PRESETS.slice(2))(
    "prepares $name only after exact selection and consent",
    async (model) => {
      const f = fixture(model.modelRef);
      const before = structuredClone(f.ctx.config);
      expect((await f.run()).candidate.model.id).toBe(model.modelRef.slice("llama-cpp/".length));
      const summary = JSON.parse(f.ctx.prompter.confirm.mock.calls[0][0].message.split("\n")[1]);
      expect(summary).toMatchObject({ modelRef: model.modelRef, modelBytes: model.downloadBytes });
      expect(f.ctx.config).toEqual(before);
      f.candidates.recipes = [];
      await expect(f.run()).rejects.toThrow("does not fit");
    },
  );
  it("rejects unsupported selections rather than using a fallback recommendation", async () => {
    const f = fixture("llama-cpp/another");
    await expect(f.run()).rejects.toThrow("supported local models");
    expect(f.ctx.prompter.confirm).not.toHaveBeenCalled();
  });
  it("does not substitute 4B if the chosen 9B does not fit memory", async () => {
    const f = fixture(LOCAL_MODEL_PRESETS[1].modelRef);
    f.candidates.recipes = f.recipes.filter((recipe) => recipe.model.id.includes("4b-"));
    await expect(f.run()).rejects.toThrow("no other model was selected");
    expect(f.ctx.prompter.confirm).not.toHaveBeenCalled();
  });
  it("fails before consent if disk space is insufficient", async () => {
    const f = fixture();
    f.hardware.availableDiskBytes = 1;
    await expect(f.run()).rejects.toThrow("Not enough free disk");
    expect(f.ctx.prompter.confirm).not.toHaveBeenCalled();
  });
  it("keeps cached preparation explicit without requesting the same bytes again", async () => {
    const f = fixture(LOCAL_MODEL_PRESETS[0].modelRef, true);
    expect((await f.run()).cachedPath).toBe("C:\\models\\cached.gguf");
    const summary = JSON.parse(f.ctx.prompter.confirm.mock.calls[0][0].message.split("\n")[1]);
    expect(summary).toMatchObject({ modelBytes: 0, embeddingBytes: 0, runtimeDiskBytes: 0 });
  });
  it("does not return a preparation plan after declining consent", async () => {
    const f = fixture();
    f.ctx.prompter.confirm.mockResolvedValue(false);
    await expect(f.run()).rejects.toThrow("declined");
  });
  it("fails closed for unknown plugin source and shares stable selection markers", () => {
    expect(EXACT_MODEL_SELECTION_PROMPT).toBe(LOCAL_MODEL_SELECTION_PROMPT);
    expect(() => patchLocalModelPlugin("unknown plugin")).toThrow("pinned");
  });
  const directory = process.env.MICROCLAW_TEST_LOCAL_PLUGIN_DIR;
  it.skipIf(!directory).each(["installed", "captured"])(
    "adapts verified %s modules on first installation without restarting the Gateway runtime",
    (location) => {
      const source = readFileSync(join(directory!, "dist", "index.js"), "utf8");
      withProviderFiles((paths) => {
        mkdirSync(join(paths.captured, "dist", ".setup"), { recursive: true });
        copyFileSync(
          join(directory!, "dist", PINNED_LOCAL_CONFIG_FILE),
          join(paths.captured, "dist", PINNED_LOCAL_CONFIG_FILE),
        );
        expectLateProviderLoad(
          {
            ...paths,
            entry: location === "installed" ? join(paths.plugin, "dist", "index.js") : paths.entry,
          },
          true,
        );
      }, source);
    },
  );

  it.skipIf(!directory)(
    "adapts the real pinned source and preserves the official runtime/download paths",
    () => {
      const source = readFileSync(join(directory!, "dist", "index.js"), "utf8");
      const patched = patchLocalModelPlugin(source);
      expect(patched).toContain("await ensureLlamaCppModel({");
      expect(patched).toContain(
        "await fs.copyFile(params.seedPreset, presetPath, constants.COPYFILE_EXCL)",
      );
      expect(patched).toContain(
        "await publishLlamaRuntime(fs, extractedRoot, installDir, options.signal)",
      );
      expect(patched).toContain("await validateInstalledServer(command, asset, options.signal)");
      expect(patched).not.toContain("await fs.rename(extractedRoot, installDir)");
      expect(patched).toContain('["llama-cpp/" + params.model.id]');
      expect(patched).not.toContain(
        "const recommendation = recommendLlamaCppModel(hardware, asset.backend",
      );
      expect(patched).not.toContain("import { publishLlamaRuntime } from");
      withProviderFiles(({ root, plugin, entry }) => {
        const result = createLocalModelCompatibilityLoadHook(plugin, root)(
          pathToFileURL(entry).href,
          {},
          () => ({ format: "module", source: Buffer.from(source) }),
        );
        expect(result.source).toContain(EXACT_MODEL_SELECTION_PROMPT);
        expect(result.source).toContain("await publishLlamaRuntime");
      }, source);
      expect(readFileSync(join(directory!, "dist", "index.js"), "utf8")).toBe(source);
    },
  );
});
