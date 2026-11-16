import { pathToFileURL } from "node:url";
import * as path from "node:path";
import * as fs from "node:fs";
import { channel } from "node:diagnostics_channel";
import { performance } from "node:perf_hooks";

const MESSAGE_PREFIX = "MICROCLAW_COPILOT_AUTH:";
const GITHUB_DEVICE_URL = "https://github.com/login/device";
// This worker is packaged as a standalone extraResource, so it cannot import app.asar modules.
export const GITHUB_COPILOT_AUTH_AGENT_ID = "main";

const TIMING_PHASES = [
  "worker-ready",
  "sdk-import",
  "config-read",
  "provider-prepare",
  "auth-flow",
  "device-code-http",
  "device-code-ready",
  "authorization-and-model-check",
  "credential-save-and-refresh",
] as const;
type TimingPhase = (typeof TIMING_PHASES)[number];
type TimingStatus = "started" | "success" | "error" | "cancelled";
export interface GitHubCopilotWorkerTiming {
  type: "timing";
  phase: TimingPhase;
  status: TimingStatus;
  elapsedMs: number;
  durationMs?: number;
  attempt?: number;
  httpStatus?: number;
}

/** Timing frames accept only known labels and numbers, never SDK text or credentials. */
export function parseGitHubCopilotWorkerTiming(
  value: Record<string, unknown>,
): GitHubCopilotWorkerTiming | undefined {
  if (
    !TIMING_PHASES.includes(value.phase as TimingPhase) ||
    typeof value.status !== "string" ||
    !["started", "success", "error", "cancelled"].includes(value.status)
  )
    return;
  const result: GitHubCopilotWorkerTiming = {
    type: "timing",
    phase: value.phase as TimingPhase,
    status: value.status as TimingStatus,
    elapsedMs: 0,
  };
  for (const key of ["elapsedMs", "durationMs", "attempt", "httpStatus"] as const) {
    const number = value[key];
    if (number === undefined && key !== "elapsedMs") continue;
    if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) return;
    result[key] = number;
  }
  return result;
}

export class GitHubCopilotLoginTiming {
  private readonly startedAt: number;
  private readonly pending = new Set<(status: TimingStatus) => void>();
  constructor(
    private readonly emit: (timing: GitHubCopilotWorkerTiming) => void,
    private readonly now = () => performance.now(),
  ) {
    this.startedAt = now();
  }

  private report(event: Omit<GitHubCopilotWorkerTiming, "type" | "elapsedMs">): void {
    try {
      this.emit({
        type: "timing",
        ...event,
        elapsedMs: Math.max(0, Math.round(this.now() - this.startedAt)),
      });
    } catch {
      /* Diagnostics must not change authentication outcomes. */
    }
  }

  mark(phase: TimingPhase): void {
    this.report({ phase, status: "success", durationMs: 0 });
  }

  begin(phase: TimingPhase, attempt?: number) {
    const startedAt = this.now();
    let finished = false;
    const finish = (status: TimingStatus = "success", httpStatus?: number) => {
      if (finished) return;
      finished = true;
      this.pending.delete(finish);
      this.report({
        phase,
        status,
        durationMs: Math.max(0, Math.round(this.now() - startedAt)),
        ...(attempt === undefined ? {} : { attempt }),
        ...(httpStatus === undefined ? {} : { httpStatus }),
      });
    };
    this.pending.add(finish);
    this.report({ phase, status: "started", ...(attempt === undefined ? {} : { attempt }) });
    return finish;
  }

  finish(status: TimingStatus): void {
    for (const finish of [...this.pending]) finish(status);
  }
}

/** Observe transport boundaries without replacing fetch or reading request/response bodies. */
export function observeGitHubDeviceCodeRequests(timing: GitHubCopilotLoginTiming): () => void {
  type Request = { origin?: unknown; path?: unknown };
  type Payload = { request?: Request; response?: { statusCode?: number } };
  const requests = new WeakMap<
    Request,
    { finish: ReturnType<GitHubCopilotLoginTiming["begin"]>; status?: number }
  >();
  let attempts = 0;
  const handlers: Record<string, (payload: Payload) => void> = {
    "undici:request:create": ({ request }) => {
      if (request?.origin !== "https://github.com" || request.path !== "/login/device/code") return;
      requests.set(request, { finish: timing.begin("device-code-http", ++attempts) });
    },
    "undici:request:headers": ({ request, response }) => {
      const active = request && requests.get(request);
      if (active && Number.isInteger(response?.statusCode)) active.status = response!.statusCode;
    },
    "undici:request:trailers": ({ request }) => {
      const active = request && requests.get(request);
      if (active)
        active.finish(
          active.status !== undefined && active.status >= 400 ? "error" : "success",
          active.status,
        );
    },
    "undici:request:error": ({ request }) => {
      if (request) requests.get(request)?.finish("error");
    },
  };
  const subscriptions = Object.entries(handlers).map(([name, handler]) => {
    const listener = (payload: unknown) => {
      try {
        handler(payload as Payload);
      } catch {
        /* Observation must not affect HTTP. */
      }
    };
    const target = channel(name);
    target.subscribe(listener);
    return () => target.unsubscribe(listener);
  });
  return () => subscriptions.forEach((unsubscribe) => unsubscribe());
}

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
  loadConfig?: (options?: Record<string, unknown>) => Record<string, unknown>;
  getRuntimeConfig?: (options?: Record<string, unknown>) => Record<string, unknown>;
}

export function resolveGitHubCopilotConfigRuntimePath(
  runtimeDirectory: string,
  exists: (filename: string) => boolean = fs.existsSync,
): string {
  const legacyPath = path.join(runtimeDirectory, "config-runtime.js");
  return exists(legacyPath)
    ? legacyPath
    : path.join(runtimeDirectory, "runtime-config-snapshot.js");
}

export function readGitHubCopilotRuntimeConfig(
  runtime: ConfigRuntimeModule,
): Record<string, unknown> {
  const loadConfig = runtime.loadConfig ?? runtime.getRuntimeConfig;
  if (typeof loadConfig !== "function") {
    throw new Error("OpenClaw configuration runtime is incompatible");
  }
  return loadConfig({ skipPluginValidation: true });
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

export function extractDevicePrompt(message: string): {
  verificationUrl: string;
  userCode: string;
  expiresInMs: number;
} | null {
  const url = message.match(/URL:\s*<?(https:\/\/github\.com\/login\/device)>?(?=\s|$)/i)?.[1];
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
  signal?: AbortSignal;
  beforePersistentEffect?: () => void;
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
    ...(params.beforePersistentEffect
      ? { beforePersistentEffect: params.beforePersistentEffect }
      : {}),
    ...(params.signal
      ? {
          signal: params.signal,
          assertCurrent: () => params.signal!.throwIfAborted(),
        }
      : {}),
  };
}

async function main(signal: AbortSignal, timing: GitHubCopilotLoginTiming): Promise<void> {
  const runtimePath = process.argv[2];
  const operation = process.argv[3] ?? "login";
  if (!runtimePath) throw new Error("OpenClaw provider authentication runtime was not provided");
  if (operation !== "login") {
    throw new Error("Unsupported GitHub Copilot worker operation");
  }

  const dynamicImport = new Function("specifier", "return import(specifier)") as <T>(
    specifier: string,
  ) => Promise<T>;
  const providerCatalogPath = path.join(path.dirname(runtimePath), "provider-catalog-runtime.js");
  const configRuntimePath = resolveGitHubCopilotConfigRuntimePath(path.dirname(runtimePath));
  const imported = timing.begin("sdk-import");
  const [authRuntime, providerCatalogRuntime, configRuntime] = await Promise.all([
    dynamicImport<AuthRuntimeModule>(pathToFileURL(runtimePath).href),
    dynamicImport<ProviderCatalogRuntimeModule>(pathToFileURL(providerCatalogPath).href),
    dynamicImport<ConfigRuntimeModule>(pathToFileURL(configRuntimePath).href),
  ]);
  imported();
  signal.throwIfAborted();
  if (typeof authRuntime.runModelsAuthLoginFlow !== "function") {
    throw new Error("OpenClaw provider authentication runtime is incompatible");
  }
  if (typeof providerCatalogRuntime.resolvePluginProviders !== "function") {
    throw new Error("OpenClaw provider catalog runtime is incompatible");
  }

  const configured = timing.begin("config-read");
  const config = enableGitHubCopilotPlugin(readGitHubCopilotRuntimeConfig(configRuntime));
  configured();
  const prepared = timing.begin("provider-prepare");
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
  prepared();

  const unsupportedPrompt = async (): Promise<never> => {
    throw new Error("GitHub Copilot requested an unsupported interactive prompt");
  };
  let emptyProfileOutcome: "cancelled" | "expired" | null = null;
  let awaitingAuthorization: ReturnType<GitHubCopilotLoginTiming["begin"]> | undefined;
  let persisted: ReturnType<GitHubCopilotLoginTiming["begin"]> | undefined;
  const prompter = {
    intro: async () => {},
    outro: async () => {},
    note: async (message: string) => {
      const prompt = extractDevicePrompt(message);
      if (prompt) {
        if (!awaitingAuthorization) {
          timing.mark("device-code-ready");
          awaitingAuthorization = timing.begin("authorization-and-model-check");
        }
        send({ type: "device-code", ...prompt });
      }
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

  const authenticated = timing.begin("auth-flow");
  const result = await authRuntime.runModelsAuthLoginFlow(
    buildGitHubCopilotLoginOptions({
      signal,
      config,
      prompter,
      beforePersistentEffect: () => {
        awaitingAuthorization?.();
        persisted ??= timing.begin("credential-save-and-refresh");
      },
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
    timing.finish("cancelled");
    send({ type: "cancelled" });
    return;
  }
  if (profileCount === 0 && emptyProfileOutcome === "expired") {
    throw new Error("The GitHub device code expired");
  }
  if (profileCount < 1)
    throw new Error("GitHub Copilot authentication did not create a credential profile");
  persisted?.();
  authenticated();
  timing.finish("success");
  send({
    type: "complete",
    profileCount,
    defaultModel: typeof result.defaultModel === "string" ? result.defaultModel : undefined,
  });
}

if (require.main === module) {
  const timing = new GitHubCopilotLoginTiming((event) => send({ ...event }));
  timing.mark("worker-ready");
  const stopObserving = observeGitHubDeviceCodeRequests(timing);
  const cancellation = new AbortController();
  const cancel = () => cancellation.abort(new Error("GitHub Copilot sign-in was cancelled"));
  const onMessage = (message: unknown) => {
    if (
      message &&
      typeof message === "object" &&
      (message as { type?: unknown }).type === "microclaw-copilot-cancel"
    )
      cancel();
  };
  process.on("message", onMessage);
  process.once("disconnect", cancel);
  void main(cancellation.signal, timing)
    .catch((error) => {
      if (
        cancellation.signal.aborted &&
        (error === cancellation.signal.reason ||
          (error instanceof Error && error.name === "AbortError"))
      ) {
        timing.finish("cancelled");
        send({ type: "cancelled" });
      } else {
        timing.finish("error");
        process.stderr.write(`[github-copilot-auth] ${safeErrorMessage(error)}\n`);
        send({ type: "failure", message: safeErrorMessage(error) });
        process.exitCode = 1;
      }
    })
    .finally(() => {
      stopObserving();
      process.off("message", onMessage);
      process.off("disconnect", cancel);
      if (process.connected) process.disconnect?.();
      // The SDK flow has committed or unwound and released its credential locks.
      // Flush the terminal reply before exiting any remaining idle SDK workers.
      process.stdout.write("", () => process.exit(process.exitCode ?? 0));
    });
}
