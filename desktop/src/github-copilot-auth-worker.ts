import { pathToFileURL } from "node:url";
import * as path from "node:path";

const MESSAGE_PREFIX = "MICROCLAW_COPILOT_AUTH:";
const GITHUB_DEVICE_URL = "https://github.com/login/device";
// This worker is packaged as a standalone extraResource, so it cannot import app.asar modules.
export const GITHUB_COPILOT_AUTH_AGENT_ID = "main";

interface AuthRuntimeModule {
  runModelsAuthLoginFlow(options: Record<string, unknown>): Promise<{
    profiles?: Array<{ profileId?: string }>;
    defaultModel?: string;
  }>;
}

interface ProviderCatalogRuntimeModule {
  resolvePluginProviders(options: Record<string, unknown>): Array<{ id?: string }>;
}

interface ConfigRuntimeModule {
  loadConfig(options?: Record<string, unknown>): Record<string, unknown>;
}

interface ModelsProviderRuntimeModule {
  buildModelsProviderData(
    config: Record<string, unknown>,
    agentId?: string,
    options?: Record<string, unknown>,
  ): Promise<{
    byProvider: Map<string, Set<string>>;
    modelNames: Map<string, string>;
  }>;
}

function enableGitHubCopilotPlugin(config: Record<string, unknown>): Record<string, unknown> {
  const plugins =
    config.plugins && typeof config.plugins === "object"
      ? (config.plugins as Record<string, unknown>)
      : {};
  const entries =
    plugins.entries && typeof plugins.entries === "object"
      ? (plugins.entries as Record<string, unknown>)
      : {};
  const existingEntry =
    entries["github-copilot"] && typeof entries["github-copilot"] === "object"
      ? (entries["github-copilot"] as Record<string, unknown>)
      : {};
  const allow = Array.isArray(plugins.allow)
    ? plugins.allow.filter((value): value is string => typeof value === "string")
    : [];
  const deny = Array.isArray(plugins.deny)
    ? plugins.deny.filter(
        (value): value is string => typeof value === "string" && value !== "github-copilot",
      )
    : undefined;
  return {
    ...config,
    plugins: {
      ...plugins,
      entries: {
        ...entries,
        "github-copilot": { ...existingEntry, enabled: true },
      },
      allow: allow.includes("github-copilot") ? allow : [...allow, "github-copilot"],
      ...(deny ? { deny } : {}),
    },
  };
}

function send(payload: Record<string, unknown>): void {
  process.stdout.write(`${MESSAGE_PREFIX}${JSON.stringify(payload)}\n`);
}

function extractDevicePrompt(message: string): {
  verificationUrl: string;
  userCode: string;
  expiresInMs: number;
} | null {
  const url = message.match(/URL:\s*(https:\/\/github\.com\/login\/device)\b/i)?.[1];
  const code = message.match(/Code:\s*([A-Z0-9-]{4,20})\b/i)?.[1];
  const expiresInMinutes = Number(message.match(/expires in\s+(\d+)\s+minutes?/i)?.[1] ?? 0);
  if (!url || !code || !Number.isFinite(expiresInMinutes) || expiresInMinutes <= 0) return null;
  return {
    verificationUrl: GITHUB_DEVICE_URL,
    userCode: code.toUpperCase(),
    expiresInMs: expiresInMinutes * 60_000,
  };
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\b(?:gh[opsu]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, "[redacted]")
    .slice(0, 500);
}

export function buildGitHubCopilotLoginOptions(params: {
  config: Record<string, unknown>;
  prompter: Record<string, unknown>;
  openUrl: (url: string) => Promise<void>;
  runtime: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    config: params.config,
    agent: GITHUB_COPILOT_AUTH_AGENT_ID,
    provider: "github-copilot",
    method: "device",
    setDefault: false,
    prompter: params.prompter,
    openUrl: params.openUrl,
    runtime: params.runtime,
  };
}

async function main(): Promise<void> {
  const runtimePath = process.argv[2];
  const operation = process.argv[3] ?? "login";
  if (!runtimePath) throw new Error("OpenClaw provider authentication runtime was not provided");
  if (operation !== "login" && operation !== "list-models") {
    throw new Error("Unsupported GitHub Copilot worker operation");
  }

  const dynamicImport = new Function("specifier", "return import(specifier)") as <T>(
    specifier: string,
  ) => Promise<T>;
  const providerCatalogPath = path.join(path.dirname(runtimePath), "provider-catalog-runtime.js");
  const configRuntimePath = path.join(path.dirname(runtimePath), "config-runtime.js");
  const modelsProviderRuntimePath = path.join(
    path.dirname(runtimePath),
    "models-provider-runtime.js",
  );
  const [authRuntime, providerCatalogRuntime, configRuntime, modelsProviderRuntime] =
    await Promise.all([
      dynamicImport<AuthRuntimeModule>(pathToFileURL(runtimePath).href),
      dynamicImport<ProviderCatalogRuntimeModule>(pathToFileURL(providerCatalogPath).href),
      dynamicImport<ConfigRuntimeModule>(pathToFileURL(configRuntimePath).href),
      dynamicImport<ModelsProviderRuntimeModule>(pathToFileURL(modelsProviderRuntimePath).href),
    ]);
  if (typeof authRuntime.runModelsAuthLoginFlow !== "function") {
    throw new Error("OpenClaw provider authentication runtime is incompatible");
  }
  if (typeof providerCatalogRuntime.resolvePluginProviders !== "function") {
    throw new Error("OpenClaw provider catalog runtime is incompatible");
  }
  if (typeof configRuntime.loadConfig !== "function") {
    throw new Error("OpenClaw configuration runtime is incompatible");
  }
  if (typeof modelsProviderRuntime.buildModelsProviderData !== "function") {
    throw new Error("OpenClaw models provider runtime is incompatible");
  }

  const config = enableGitHubCopilotPlugin(
    configRuntime.loadConfig({ skipPluginValidation: true }),
  );
  const providers = providerCatalogRuntime.resolvePluginProviders({
    config,
    mode: "setup",
    onlyPluginIds: ["github-copilot"],
    providerRefs: ["github-copilot"],
    activate: true,
    cache: true,
    includeUntrustedWorkspacePlugins: false,
  });
  if (!providers.some((provider) => provider.id === "github-copilot")) {
    throw new Error("The bundled GitHub Copilot provider is unavailable");
  }

  if (operation === "list-models") {
    const catalog = await modelsProviderRuntime.buildModelsProviderData(
      config,
      GITHUB_COPILOT_AUTH_AGENT_ID,
      {
        view: "all",
      },
    );
    const modelIds = [...(catalog.byProvider.get("github-copilot") ?? [])];
    send({
      type: "models",
      models: modelIds.map((modelId) => {
        const id = `github-copilot/${modelId}`;
        return { id, name: catalog.modelNames.get(id) ?? modelId };
      }),
    });
    return;
  }

  const unsupportedPrompt = async (): Promise<never> => {
    throw new Error("GitHub Copilot requested an unsupported interactive prompt");
  };
  let emptyProfileOutcome: "cancelled" | "expired" | null = null;
  const prompter = {
    intro: async () => {},
    outro: async () => {},
    note: async (message: string) => {
      const prompt = extractDevicePrompt(message);
      if (prompt) send({ type: "device-code", ...prompt });
      if (message.includes("login was cancelled")) emptyProfileOutcome = "cancelled";
      if (message.includes("device code expired")) emptyProfileOutcome = "expired";
    },
    select: unsupportedPrompt,
    multiselect: unsupportedPrompt,
    text: unsupportedPrompt,
    confirm: async () => true,
    progress: () => ({
      update: () => {},
      stop: () => {},
    }),
  };

  const result = await authRuntime.runModelsAuthLoginFlow(
    buildGitHubCopilotLoginOptions({
      config,
      prompter,
      openUrl: async (url: string) => send({ type: "open-url", url }),
      runtime: {
        log: () => {},
        error: (message: string) => process.stderr.write(`${message}\n`),
        exit: (code: number): never => {
          throw new Error(`OpenClaw authentication exited unexpectedly (${code})`);
        },
      },
    }),
  );

  const profileCount = Array.isArray(result.profiles) ? result.profiles.length : 0;
  if (profileCount === 0 && emptyProfileOutcome === "cancelled") {
    send({ type: "cancelled" });
    return;
  }
  if (profileCount === 0 && emptyProfileOutcome === "expired") {
    throw new Error("The GitHub device code expired");
  }
  send({
    type: "complete",
    profileCount,
    defaultModel: typeof result.defaultModel === "string" ? result.defaultModel : undefined,
  });
}

if (require.main === module) {
  void main().catch((error) => {
    process.stderr.write(`[github-copilot-auth] ${safeErrorMessage(error)}\n`);
    send({ type: "failure", message: safeErrorMessage(error) });
    process.exitCode = 1;
  });
}
