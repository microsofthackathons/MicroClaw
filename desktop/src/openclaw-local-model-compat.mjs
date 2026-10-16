import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

export const PINNED_LOCAL_PLUGIN_VERSION = "2026.9.3";
export const PINNED_LOCAL_PLUGIN_SHA256 =
  "0092cdf1656a013d6028f5e238eaf21fb41b1459facde3a3ea563a7567a846aa";
export const EXACT_MODEL_SELECTION_PROMPT = "MicroClaw: select the exact local model";
export const EXACT_MODEL_DOWNLOAD_PROMPT = "MicroClaw: confirm the exact local model download";

// Official artifact verification and persistence remain owned by OpenClaw.
// The adapter adds exact model selection and bounded Windows runtime publication retries.
export async function publishLlamaRuntime(fs, sourcePath, targetPath, signal) {
  signal?.throwIfAborted();
  if (process.platform !== "win32") return fs.rename(sourcePath, targetPath);
  if (
    !isAbsolute(sourcePath) ||
    !isAbsolute(targetPath) ||
    resolve(sourcePath) === resolve(targetPath)
  ) {
    throw new Error("Runtime publication requires distinct absolute paths");
  }
  const source = await fs.lstat(sourcePath, { bigint: true });
  const parentPath = dirname(targetPath);
  const parent = await fs.lstat(parentPath, { bigint: true });
  if (
    !source.isDirectory() ||
    source.isSymbolicLink() ||
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    source.ino === 0n ||
    parent.ino === 0n
  ) {
    throw new Error("The validated runtime paths must be identifiable directories");
  }
  const retryDelays = [100, 200, 400, 800, 1600];
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const current = await fs.lstat(sourcePath, { bigint: true });
    const currentParent = await fs.lstat(parentPath, { bigint: true });
    if (
      !current.isDirectory() ||
      current.isSymbolicLink() ||
      current.dev !== source.dev ||
      current.ino !== source.ino ||
      !currentParent.isDirectory() ||
      currentParent.isSymbolicLink() ||
      currentParent.dev !== parent.dev ||
      currentParent.ino !== parent.ino
    ) {
      throw new Error("Runtime publication paths changed; refusing to retry");
    }
    try {
      await fs.lstat(targetPath, { bigint: true });
      throw new Error("Runtime destination appeared during publication; refusing to replace it");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    signal?.throwIfAborted();
    try {
      await fs.rename(sourcePath, targetPath);
      return;
    } catch (error) {
      if (!["EPERM", "EACCES", "EBUSY"].includes(error?.code) || attempt >= retryDelays.length) {
        throw error;
      }
      globalThis.console.warn(
        `[microclaw-local-model] Runtime directory is temporarily locked (${error.code}); retrying publication ${attempt + 1}/${retryDelays.length}`,
      );
      await delay(retryDelays[attempt], undefined, { signal });
    }
  }
}

export const EXACT_SETUP_PLAN = `async function resolveSetupPlan(ctx, candidates, embeddingModelIsDefault, localMemoryIntent, hardware, asset, runtimeNote) {
  const presets = ["qwen3.5-4b-q4_k_m", "qwen3.5-9b-q4_k_m"].map(id => {
    const recipe = LLAMA_CPP_MODEL_RECIPES.find(item => item.model.id === id);
    if (!recipe) throw new Error("The pinned local model catalog is unavailable.");
    return recipe;
  });
  const selected = await ctx.prompter.select({
    message: ${JSON.stringify(EXACT_MODEL_SELECTION_PROMPT)},
    options: presets.map(recipe => ({ value: "llama-cpp/" + recipe.model.id, label: recipe.model.name })),
    initialValue: "llama-cpp/qwen3.5-4b-q4_k_m"
  });
  const recipe = presets.find(item => "llama-cpp/" + item.model.id === selected);
  if (!recipe) throw new Error("Choose one of the supported local models.");
  if (!resolveLlamaCppModelCandidates(hardware, asset.backend).recipes.some(item => item.model.id === recipe.model.id)) {
    throw new Error(recipe.model.name + " does not fit the currently available memory. Free memory or choose the smaller model; no other model was selected.");
  }
  const existing = ctx.config.models?.providers?.[LLAMA_CPP_PROVIDER_ID];
  if (existing && !existing.localService && existing.models?.length) {
    throw new Error("An external llama.cpp connection already exists. Remove it explicitly before preparing managed models.");
  }
  const provider = buildLlamaCppProviderConfig({
    existing,
    modelInventory: [recipe.model, ...(existing?.models ?? []).filter(model => model.id !== recipe.model.id)]
  });
  const cacheDir = resolveLlamaCppModelCacheDir(provider);
  const cachedPath = await resolveCachedArtifact(resolveLlamaCppModelSource(recipe.model), cacheDir, ctx.signal);
  const cachedEmbedding = Boolean(await resolveCachedArtifact(resolveEmbeddingSetup(ctx.config, cacheDir).model.source, cacheDir, ctx.signal));
  const runtimeCached = await isFile(resolveManagedLlamaServerPaths(asset).command);
  if (hardware.availableDiskBytes === undefined || hardware.availableRuntimeDiskBytes === undefined) {
    throw new Error("Cannot measure free disk space. Check permissions before downloading.");
  }
  const runtimeBytes = runtimeCached ? 0 : (asset.backend === "cuda" ? 3 : 2) * GIB;
  const modelBytes = (cachedPath ? 0 : recipe.sizeBytes) + (cachedEmbedding ? 0 : DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_SIZE_BYTES);
  const modelBudget = hardware.sharedDisk
    ? Math.min(hardware.availableDiskBytes, hardware.availableRuntimeDiskBytes) - runtimeBytes
    : hardware.availableDiskBytes;
  if (modelBudget < modelBytes || (!hardware.sharedDisk && hardware.availableRuntimeDiskBytes < runtimeBytes)) {
    throw new Error("Not enough free disk space for the selected model and required runtime.");
  }
  if (!embeddingModelIsDefault && !cachedEmbedding) {
    throw new Error("Prepare the custom embedding model separately before downloading a MicroClaw preset.");
  }
  const summary = {
    modelRef: selected,
    modelName: recipe.model.name,
    modelBytes: cachedPath ? 0 : recipe.sizeBytes,
    embeddingBytes: cachedEmbedding ? 0 : DEFAULT_LLAMA_CPP_EMBEDDING_MODEL_SIZE_BYTES,
    runtimeDiskBytes: runtimeBytes,
    backend: asset.backend,
    runtimeNote: runtimeNote ?? ""
  };
  const confirmed = await ctx.prompter.confirm({
    message: ${JSON.stringify(EXACT_MODEL_DOWNLOAD_PROMPT)} + "\\n" + JSON.stringify(summary),
    initialValue: false
  });
  if (!confirmed) throw new Error("Local model preparation was declined; model selection was not changed.");
  return { kind: "chat", candidate: {model: recipe.model, provider}, cachedPath };
}
`;

function replaceExactly(source, before, after) {
  const index = source.indexOf(before);
  if (index < 0 || source.indexOf(before, index + before.length) >= 0) {
    throw new Error("The pinned local model adapter did not match exactly once");
  }
  return source.slice(0, index) + after + source.slice(index + before.length);
}

export function patchLocalModelPlugin(source) {
  if (createHash("sha256").update(source).digest("hex") !== PINNED_LOCAL_PLUGIN_SHA256) {
    throw new Error("The llama.cpp provider differs from the pinned exact-model setup source");
  }
  const start = source.indexOf("async function resolveSetupPlan(");
  const end = source.indexOf("async function runLlamaCppSetup(ctx) {", start);
  if (start < 0 || end < 0) throw new Error("The pinned model selection function is unavailable");
  let patched = source.slice(0, start) + EXACT_SETUP_PLAN + source.slice(end);
  patched = `import { setTimeout as microclawRuntimeDelay } from "node:timers/promises";
const publishLlamaRuntime = (({ isAbsolute, resolve, dirname }, delay) =>
  (${publishLlamaRuntime.toString()}))(path, microclawRuntimeDelay);
${patched}`;
  patched = replaceExactly(
    patched,
    "\t\tawait fs.rename(extractedRoot, installDir);",
    "\t\tawait publishLlamaRuntime(fs, extractedRoot, installDir, options.signal);",
  );
  patched = replaceExactly(
    patched,
    "\t\t\t...buildLlamaCppAuthProfileRemovalPatch(params.config),",
    `\t\t\t...buildLlamaCppAuthProfileRemovalPatch(params.config),
\t\t\t...(params.model && params.config.agents?.defaults?.models &&
\t\t\t    !params.config.agents.defaults.modelPolicy &&
\t\t\t    params.config.meta?.migrations?.modelPolicyAllowlist !== true &&
\t\t\t    Object.keys(params.config.agents.defaults.models).length > 0 ? {
\t\t\t    agents: { defaults: { models: {
\t\t\t      ["llama-cpp/" + params.model.id]: params.config.agents.defaults.models["llama-cpp/" + params.model.id] ?? {}
\t\t\t    } } }
\t\t\t} : {}),`,
  );
  patched = replaceExactly(
    patched,
    `\tconst presetPath = params.isolated ? path.join(path.dirname(defaultPreset), \`models-\${randomUUID()}.ini\`) : defaultPreset;\n\tawait updatePreset(presetPath, {`,
    `\tconst presetPath = params.isolated ? path.join(path.dirname(defaultPreset), \`models-\${randomUUID()}.ini\`) : defaultPreset;
\tif (params.isolated && params.seedPreset) await fs.copyFile(params.seedPreset, presetPath, constants.COPYFILE_EXCL);
\tawait updatePreset(presetPath, {`,
  );
  patched = replaceExactly(
    patched,
    `\t\tconst managed = await prepareManagedLlamaServer({\n\t\t\tchatModel,`,
    `\t\tconst seedPreset = existing?.localService?.args?.find((_, index, args) => args[index - 1] === "--models-preset");
\t\tif (seedPreset && (!path.isAbsolute(seedPreset) || !await isFile(seedPreset))) throw new Error("The existing managed preset is unavailable; no model configuration was replaced.");
\t\tconst managed = await prepareManagedLlamaServer({
\t\t\tseedPreset,
\t\t\tchatModel,`,
  );
  return patched;
}

export function createLocalModelCompatibilityLoadHook(
  pluginDir,
  stateDir = process.env.OPENCLAW_STATE_DIR || undefined,
) {
  if (!pluginDir || !isAbsolute(pluginDir))
    throw new Error("An absolute local provider directory is required");
  const providerStateDir = stateDir ?? dirname(dirname(pluginDir));
  if (!providerStateDir || !isAbsolute(providerStateDir))
    throw new Error("An absolute OpenClaw state directory is required");
  const target = join(pluginDir, "dist", "index.js");
  const captureRoot = join(providerStateDir, "tmp", "plugin-captures");
  return function load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    if (!url.startsWith("file:")) return result;
    const filename = fileURLToPath(url);
    const candidateRoot = dirname(dirname(filename));
    const capturedPath = relative(captureRoot, filename);
    const captured =
      capturedPath !== "" &&
      !capturedPath.startsWith("..") &&
      !isAbsolute(capturedPath) &&
      basename(filename) === "index.js" &&
      basename(dirname(filename)) === "dist" &&
      basename(candidateRoot) === basename(pluginDir) &&
      basename(dirname(candidateRoot)) === "node_modules";
    if (filename !== target && !captured) return result;

    for (const root of new Set([pluginDir, candidateRoot])) {
      const metadata = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
      if (
        metadata.name !== "@openclaw/llama-cpp-provider" ||
        metadata.version !== PINNED_LOCAL_PLUGIN_VERSION
      ) {
        throw new Error("Exact model setup requires the pinned official llama.cpp provider");
      }
      const entry = join(root, "dist", "index.js");
      if (realpathSync(entry) !== entry)
        throw new Error("The local provider entry must not be redirected");
    }
    const source =
      typeof result.source === "string"
        ? result.source
        : Buffer.from(result.source ?? "").toString();
    if (captured && source !== readFileSync(target, "utf8"))
      throw new Error("The captured local provider differs from its installed source");
    return { ...result, source: patchLocalModelPlugin(source) };
  };
}

export function initializeLocalModelCompatibility(pluginDir) {
  return registerHooks({ load: createLocalModelCompatibilityLoadHook(pluginDir) });
}

if (process.env.MICROCLAW_EXACT_LOCAL_MODELS === "1") {
  initializeLocalModelCompatibility(process.env.MICROCLAW_LOCAL_MODEL_PLUGIN_DIR);
}
