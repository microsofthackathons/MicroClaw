import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { LOCAL_MODEL_PRESETS } from "./local-model-catalog";
// @ts-expect-error External ESM preload runs in the supported Gateway runtime.
import * as compatibility from "./openclaw-local-model-compat.mjs";
const {
  MICROCLAW_LOCAL_MODEL_SOURCES,
  PINNED_LOCAL_CONFIG_FILE,
  MODEL_SCOPE_RECIPES,
  modelScopeModelUrl,
  modelScopeArtifact,
  resolveModelScopeSource,
  modelScopeDownloadPolicy,
  patchLocalModelPlugin,
  patchLocalModelConfig,
  createLocalModelCompatibilityLoadHook,
} = compatibility;
const embedding = MICROCLAW_LOCAL_MODEL_SOURCES.embedding;
const directory = process.env.MICROCLAW_TEST_LOCAL_PLUGIN_DIR;
const runtimeDirectory = process.env.MICROCLAW_TEST_OPENCLAW_DIR;

function section(source: string, start: string, end: string): string {
  const first = source.indexOf(start);
  const last = source.indexOf(end, first + start.length);
  expect(first).toBeGreaterThanOrEqual(0);
  expect(last).toBeGreaterThan(first);
  return source.slice(first, last);
}

describe("pinned ModelScope-only model sources", () => {
  it("shares the four exact models, pinned identities and a single lightweight default", () => {
    expect(LOCAL_MODEL_PRESETS.map((entry) => entry.modelRef)).toEqual([
      "llama-cpp/qwen3.5-4b-q4_k_m",
      "llama-cpp/qwen3.5-9b-q4_k_m",
      "llama-cpp/qwen3.5-35b-a3b-q4_k_m",
      "llama-cpp/qwen3.8-27b-ud-q4_k_m",
    ]);
    expect(LOCAL_MODEL_PRESETS.filter((entry) => entry.preferred)).toEqual([
      LOCAL_MODEL_PRESETS[0],
    ]);
    for (const model of [...LOCAL_MODEL_PRESETS, embedding]) {
      const url = new URL(modelScopeModelUrl(model));
      expect(url.origin).toBe("https://modelscope.cn");
      expect(url.pathname).toBe(`/api/v1/models/${model.repository}/repo`);
      expect(url.searchParams.get("Revision")).toMatch(/^[a-f0-9]{40}$/);
      expect(url.searchParams.get("FilePath")).toBe(model.file);
      expect(model.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(model.downloadBytes).toBeGreaterThan(0);
      expect(modelScopeArtifact(url.href)).toEqual({
        url: url.href,
        fileName: model.cacheFile,
        expectedSize: model.downloadBytes,
        expectedSha256: model.sha256,
      });
    }
  });

  it("maps known old configuration references to ModelScope without changing cache identities", () => {
    for (const model of [...LOCAL_MODEL_PRESETS, embedding]) {
      for (const legacy of model.legacySources) {
        expect(resolveModelScopeSource(legacy)).toBe(modelScopeModelUrl(model));
        expect(modelScopeArtifact(legacy)).toEqual(modelScopeArtifact(modelScopeModelUrl(model)));
      }
    }
    expect(LOCAL_MODEL_PRESETS[0].cacheFile).toMatch(/^hf_unsloth_Qwen3.5-4B/);
    expect(resolveModelScopeSource("C:\\models\\own.gguf")).toBe("C:\\models\\own.gguf");
  });

  it.each([
    "hf:other/repo/model.gguf",
    "huggingface:other/repo/model.gguf",
    "https://huggingface.co/other/repo/resolve/main/model.gguf",
    "https://hf-mirror.com/model.gguf",
    "https://modelscope.cn/api/v1/models/other/repo/repo?Revision=master&FilePath=model.gguf",
    "https://example.com/model.gguf",
    "http://modelscope.cn/model.gguf",
  ])("refuses an unpinned remote source: %s", (source) => {
    expect(modelScopeArtifact(source)).toBeUndefined();
    expect(() => resolveModelScopeSource(source)).toThrow("no fallback");
  });

  it("restricts weight redirects while preserving the runtime download policy", () => {
    const policy = { allowedHostnames: ["modelscope.cn"], hostnameAllowlist: ["modelscope.cn"] };
    expect(modelScopeDownloadPolicy(modelScopeModelUrl(embedding), policy)).toEqual({
      ...policy,
      hostnameAllowlist: ["modelscope.cn", "*.modelscope.cn"],
    });
    const runtimePolicy = { hostnameAllowlist: ["github.com", "*.githubusercontent.com"] };
    expect(
      modelScopeDownloadPolicy(
        "https://github.com/ggml-org/llama.cpp/releases/runtime.zip",
        runtimePolicy,
      ),
    ).toBe(runtimePolicy);
  });

  it("rejects unknown companion module bytes", () => {
    expect(() => patchLocalModelConfig("unverified configuration")).toThrow("pinned");
  });

  it("retains conservative hardware budgets for the larger models", () => {
    const recipes = new Function(
      "MICROCLAW_LOCAL_MODEL_SOURCES",
      "modelScopeModelUrl",
      "modelScopeArtifact",
      "DEFAULT_LLAMA_CPP_CONTEXT_SIZE",
      "GIB",
      `${MODEL_SCOPE_RECIPES}; return LLAMA_CPP_MODEL_RECIPES;`,
    )(MICROCLAW_LOCAL_MODEL_SOURCES, modelScopeModelUrl, modelScopeArtifact, 65536, 1024 ** 3);
    expect(recipes[2]).toMatchObject({
      memoryBytes: 28 * 1024 ** 3,
      minimumSystemMemoryBytes: 48 * 1024 ** 3,
    });
    expect(recipes[3]).toMatchObject({
      memoryBytes: 22 * 1024 ** 3,
      minimumSystemMemoryBytes: 32 * 1024 ** 3,
      requiresAcceleration: true,
    });
    expect(recipes.map((recipe: { artifact: { url: string } }) => recipe.artifact.url)).toEqual(
      LOCAL_MODEL_PRESETS.map(modelScopeModelUrl),
    );
  });
});

describe.skipIf(!directory)("real pinned provider ModelScope adapter", () => {
  function sources() {
    return {
      entry: patchLocalModelPlugin(readFileSync(path.join(directory!, "dist", "index.js"), "utf8")),
      config: patchLocalModelConfig(
        readFileSync(path.join(directory!, "dist", PINNED_LOCAL_CONFIG_FILE), "utf8"),
      ),
    };
  }

  it("removes HF resolvers, keeps runtime verification and produces valid JavaScript", () => {
    const { entry, config } = sources();
    for (const source of [entry, config]) {
      expect(source).not.toMatch(/https:\/\/huggingface\.co\//);
      expect(source).not.toContain("resolveHuggingFaceArtifact");
      expect(source).not.toContain("parseHuggingFaceSource");
      const result = spawnSync(process.execPath, ["--input-type=module", "--check"], {
        input: source,
        encoding: "utf8",
      });
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
    }
    expect(entry).toContain("download SHA-256 mismatch");
    expect(entry).toContain("download size mismatch");
    expect(entry).toContain("modelScopeDownloadPolicy(params.url");
    expect(entry).toContain("await validateInstalledServer");
  });

  it("resolves existing chat and embedding settings to ModelScope and preserves local files", () => {
    const { config } = sources();
    const executable = config.replace(/^import .+;$/gm, "").replace(/^export \{.+\};$/gm, "");
    const api = new Function(
      "path",
      "os",
      "resolveStateDir",
      "normalizeOptionalString",
      `${executable}; return { resolveLlamaCppModelSource, resolveCachedLlamaCppModelPath, resolveLlamaCppEmbeddingModel, buildDefaultLlamaCppModel };`,
    )(
      path,
      { homedir: () => path.join(tmpdir(), "modelscope-home") },
      () => tmpdir(),
      (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined),
    );
    for (const model of LOCAL_MODEL_PRESETS.filter((entry) => entry.legacySources.length)) {
      const configured = {
        id: model.modelRef.slice("llama-cpp/".length),
        params: { modelPath: model.legacySources[0] },
      };
      expect(api.resolveLlamaCppModelSource(configured)).toBe(modelScopeModelUrl(model));
      expect(api.resolveCachedLlamaCppModelPath({ model: configured })).toBe(
        path.join(tmpdir(), "models", "llama.cpp", model.cacheFile),
      );
    }
    expect(
      api.resolveLlamaCppEmbeddingModel({ modelPath: embedding.legacySources[0] }),
    ).toMatchObject({ source: modelScopeModelUrl(embedding), isDefault: true });
    expect(api.resolveLlamaCppEmbeddingModel()).toMatchObject({
      source: modelScopeModelUrl(embedding),
      isDefault: true,
    });
    const local = path.join(tmpdir(), "my-embedding.gguf");
    expect(api.resolveLlamaCppEmbeddingModel({ modelPath: local })).toMatchObject({
      source: local,
      isDefault: false,
    });
    expect(api.buildDefaultLlamaCppModel()).toMatchObject({
      id: "qwen3.5-4b-q4_k_m",
      params: { modelPath: modelScopeModelUrl(LOCAL_MODEL_PRESETS[0]) },
    });
    expect(() =>
      api.resolveLlamaCppEmbeddingModel({ modelPath: "hf:unknown/embedding.gguf" }),
    ).toThrow("no fallback");
  });

  it("reuses legacy-named caches only after hash verification without any network request", async () => {
    const { entry } = sources();
    const root = mkdtempSync(path.join(tmpdir(), "microclaw-modelscope-cache-"));
    const model = LOCAL_MODEL_PRESETS[0];
    const bytes = Buffer.from("GGUFcached-model-fixture");
    const artifact = {
      ...modelScopeArtifact(modelScopeModelUrl(model)),
      expectedSha256: createHash("sha256").update(bytes).digest("hex"),
      expectedSize: bytes.length,
    };
    const destination = path.join(root, model.cacheFile);
    const download = vi.fn();
    const verify = vi.fn(async (file: string) =>
      createHash("sha256")
        .update(await fs.readFile(file))
        .digest("hex"),
    );
    const ensure = new Function(
      "fs",
      "path",
      "resolveHomePath",
      "resolveModelScopeSource",
      "resolvedModelArtifacts",
      "resolveModelArtifact",
      "modelPromises",
      "sha256File",
      "assertGguf",
      "downloadVerifiedFile",
      `${section(entry, "async function ensureLlamaCppModel(", "async function writePreset(")}; return ensureLlamaCppModel;`,
    )(
      fs,
      path,
      (value: string) => value,
      resolveModelScopeSource,
      new Map(),
      async () => artifact,
      new Map(),
      verify,
      vi.fn(),
      download,
    );
    try {
      writeFileSync(destination, bytes);
      expect(await ensure({ source: model.legacySources[0], cacheDir: root, download: true })).toBe(
        destination,
      );
      expect(verify).toHaveBeenCalledOnce();
      expect(download).not.toHaveBeenCalled();
      writeFileSync(destination, "GGUFchanged");
      await expect(
        ensure({ source: model.legacySources[0], cacheDir: root, download: false }),
      ).rejects.toThrow("not cached");
      await expect(
        ensure({ source: "hf:unknown/model.gguf", cacheDir: root, download: true }),
      ).rejects.toThrow("no fallback");
      expect(download).not.toHaveBeenCalled();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("patches only verified original and captured companion modules without writing them", () => {
    const root = mkdtempSync(path.join(tmpdir(), "microclaw-modelscope-capture-"));
    const plugin = path.join(root, "extensions", "llama-cpp");
    const captured = path.join(
      root,
      "tmp",
      "plugin-captures",
      "generation",
      "node_modules",
      "llama-cpp",
    );
    const original = readFileSync(path.join(directory!, "dist", PINNED_LOCAL_CONFIG_FILE), "utf8");
    try {
      for (const folder of [plugin, captured]) {
        mkdirSync(path.join(folder, "dist"), { recursive: true });
        writeFileSync(
          path.join(folder, "package.json"),
          JSON.stringify({ name: "@openclaw/llama-cpp-provider", version: "2026.9.3" }),
        );
        writeFileSync(path.join(folder, "dist", PINNED_LOCAL_CONFIG_FILE), original);
      }
      const hook = createLocalModelCompatibilityLoadHook(plugin, root);
      for (const folder of [plugin, captured]) {
        const file = path.join(folder, "dist", PINNED_LOCAL_CONFIG_FILE);
        expect(hook(pathToFileURL(file).href, {}, () => ({ source: original })).source).toContain(
          "modelScopeArtifact",
        );
        expect(readFileSync(file, "utf8")).toBe(original);
      }
      const file = path.join(captured, "dist", PINNED_LOCAL_CONFIG_FILE);
      expect(() => hook(pathToFileURL(file).href, {}, () => ({ source: original + "\n" }))).toThrow(
        "differs from its installed source",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each(["valid", "wrong-hash", "wrong-size", "cancelled", "server-error", "network-error"])(
    "preserves verified streaming downloads and partial cleanup: %s",
    async (mode) => {
      const { entry } = sources();
      const root = mkdtempSync(path.join(tmpdir(), "microclaw-modelscope-download-"));
      const bytes = Buffer.from("GGUFtiny-model-fixture");
      const release = vi.fn().mockResolvedValue(undefined);
      const fetchWithSsrFGuard = vi.fn().mockResolvedValue({
        response: new Response(bytes, { status: mode === "server-error" ? 503 : 200 }),
        release,
      });
      if (mode === "network-error")
        fetchWithSsrFGuard.mockRejectedValue(new Error("ModelScope unreachable"));
      const functionSource = section(
        entry,
        "async function downloadVerifiedFile(",
        "async function runServerCommand(",
      ).replace('await import("openclaw/plugin-sdk/ssrf-runtime")', "ssrfRuntime");
      const download = new Function(
        "fs",
        "path",
        "randomUUID",
        "createHash",
        "rememberVerifiedFile",
        "modelScopeDownloadPolicy",
        "ssrfRuntime",
        "DOWNLOAD_TIMEOUT_MS",
        `${functionSource}; return downloadVerifiedFile;`,
      )(
        fs,
        path,
        randomUUID,
        createHash,
        vi.fn(),
        modelScopeDownloadPolicy,
        { fetchWithSsrFGuard, ssrfPolicyFromHttpBaseUrlAllowedOrigin: () => ({}) },
        1000,
      );
      const controller = new AbortController();
      const destination = path.join(root, "model.gguf");
      try {
        const operation = download({
          url: modelScopeModelUrl(embedding),
          destination,
          expectedSha256:
            mode === "wrong-hash"
              ? "0".repeat(64)
              : createHash("sha256").update(bytes).digest("hex"),
          expectedSize: bytes.length + (mode === "wrong-size" ? 1 : 0),
          signal: controller.signal,
          onProgress: () => {
            if (mode === "cancelled") controller.abort();
          },
        });
        if (mode === "valid") {
          await operation;
          expect(readFileSync(destination)).toEqual(bytes);
        } else {
          await expect(operation).rejects.toThrow(
            mode === "wrong-hash"
              ? "SHA-256 mismatch"
              : mode === "wrong-size"
                ? "size mismatch"
                : mode === "server-error"
                  ? "HTTP 503"
                  : mode === "network-error"
                    ? "ModelScope unreachable"
                    : /abort/i,
          );
          expect(existsSync(destination)).toBe(false);
        }
        expect(readdirSync(root).filter((file) => file.includes(".partial-"))).toEqual([]);
        expect(fetchWithSsrFGuard).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            url: modelScopeModelUrl(embedding),
            requireHttps: true,
            policy: { hostnameAllowlist: ["modelscope.cn", "*.modelscope.cn"] },
          }),
        );
        expect(release).toHaveBeenCalledTimes(mode === "network-error" ? 0 : 1);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );
});

describe.skipIf(!runtimeDirectory)("installed OpenClaw redirect guard", () => {
  it.each([
    "huggingface.co",
    "hf-mirror.com",
    "modelscope.cn.evil.example",
    "cdn-lfs-cn-1.modelscope.cn",
  ])("checks each redirect before requesting %s", async (host) => {
    const moduleUrl = pathToFileURL(
      path.join(runtimeDirectory!, "dist", "fetch-guard-DL1_8oHh.mjs"),
    ).href;
    const { i: guardedFetch } = await import(moduleUrl);
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, { status: 302, headers: { location: `https://${host}/model.gguf` } }),
      )
      .mockResolvedValueOnce(new Response("GGUFfixture"));
    const request = guardedFetch({
      url: modelScopeModelUrl(embedding),
      fetchImpl,
      capture: false,
      lookupFn: async () => [{ address: "93.184.216.34", family: 4 }],
      pinDns: false,
      requireHttps: true,
      policy: modelScopeDownloadPolicy(modelScopeModelUrl(embedding), {}),
    });
    if (host === "cdn-lfs-cn-1.modelscope.cn") {
      const result = await request;
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      await result.release();
    } else {
      await expect(request).rejects.toThrow(/allowlist/i);
      expect(fetchImpl).toHaveBeenCalledOnce();
    }
  });
});
