import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { CREATE_NO_WINDOW } from "./constants";

const MESSAGE_PREFIX = "MICROCLAW_COPILOT_AUTH:";
const GITHUB_DEVICE_URL = "https://github.com/login/device";
const AUTH_TIMEOUT_MS = 20 * 60_000;
const CLI_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const AUTH_STATUS_CACHE_MS = 30_000;
const MAX_GATEWAY_MODELS = 5_000;
// OpenClaw uses agents/main/agent as the inherited auth root, independent of the routed default.
export const GITHUB_COPILOT_AUTH_AGENT_ID = "main";

let authStatusCache: { value: { authenticated: boolean }; expiresAt: number } | null = null;
let authStatusInFlight: Promise<{ authenticated: boolean }> | null = null;
let modelCatalogCache: GitHubCopilotModel[] | null = null;
let modelCatalogInFlight: Promise<GitHubCopilotModel[]> | null = null;

export interface GitHubCopilotAuthRuntime {
  nodePath: string;
  entryPath: string;
  workerPath: string;
  openClawPackageDir: string;
  stateDir: string;
  compileCacheDir: string;
}

export interface GitHubCopilotModel {
  id: string;
  name: string;
}

export interface GitHubCopilotDisconnectResult {
  disconnected: true;
  removedProfiles: number;
}

export type GitHubCopilotAuthEvent =
  | {
      sessionId: string;
      status: "code";
      verificationUrl: string;
      userCode: string;
      expiresInMs: number;
    }
  | { sessionId: string; status: "success"; defaultModel?: string }
  | { sessionId: string; status: "cancelled" }
  | { sessionId: string; status: "error"; message: string };

type WorkerMessage =
  | {
      type: "device-code";
      verificationUrl: string;
      userCode: string;
      expiresInMs: number;
    }
  | { type: "open-url"; url: string }
  | { type: "cancelled" }
  | { type: "models"; models: GitHubCopilotModel[] }
  | { type: "complete"; profileCount: number; defaultModel?: string }
  | { type: "failure"; message: string };

interface ActiveLogin {
  sessionId: string;
  child: ChildProcess;
  timeout: ReturnType<typeof setTimeout>;
  terminal: boolean;
  stdoutBuffer: string;
}

function isSafeNodePath(nodePath: string): boolean {
  return !path.isAbsolute(nodePath) || fs.existsSync(nodePath);
}

function buildSpawnEnvironment(runtime: GitHubCopilotAuthRuntime): NodeJS.ProcessEnv {
  return {
    ...process.env,
    OPENCLAW_STATE_DIR: runtime.stateDir,
    NODE_COMPILE_CACHE: runtime.compileCacheDir,
    OPENCLAW_NO_RESPAWN: "1",
  };
}

function spawnOptions(runtime: GitHubCopilotAuthRuntime) {
  return {
    cwd: runtime.openClawPackageDir,
    env: buildSpawnEnvironment(runtime),
    stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
    windowsHide: true,
    ...(process.platform === "win32" ? { creationFlags: CREATE_NO_WINDOW } : {}),
  };
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`Invalid GitHub Copilot authentication message: ${field}`);
  }
  return value;
}

export function parseGitHubCopilotWorkerLine(line: string): WorkerMessage | undefined {
  if (!line.startsWith(MESSAGE_PREFIX)) return undefined;

  let payload: unknown;
  try {
    payload = JSON.parse(line.slice(MESSAGE_PREFIX.length));
  } catch {
    throw new Error("Invalid GitHub Copilot authentication message");
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid GitHub Copilot authentication message");
  }

  const value = payload as Record<string, unknown>;
  if (value.type === "device-code") {
    if (value.verificationUrl !== GITHUB_DEVICE_URL) {
      throw new Error("GitHub Copilot returned an unexpected verification URL");
    }
    const userCode = requireString(value.userCode, "userCode").toUpperCase();
    const expiresInMs = Number(value.expiresInMs);
    if (!/^[A-Z0-9-]{4,20}$/.test(userCode) || !Number.isFinite(expiresInMs) || expiresInMs <= 0) {
      throw new Error("Invalid GitHub Copilot device code");
    }
    return {
      type: "device-code",
      verificationUrl: GITHUB_DEVICE_URL,
      userCode,
      expiresInMs,
    };
  }
  if (value.type === "open-url") {
    if (value.url !== GITHUB_DEVICE_URL) {
      throw new Error("GitHub Copilot returned an unexpected verification URL");
    }
    return { type: "open-url", url: GITHUB_DEVICE_URL };
  }
  if (value.type === "complete") {
    const profileCount = Number(value.profileCount);
    if (!Number.isInteger(profileCount) || profileCount < 1) {
      throw new Error("GitHub Copilot authentication did not create a credential profile");
    }
    return {
      type: "complete",
      profileCount,
      defaultModel: typeof value.defaultModel === "string" ? value.defaultModel : undefined,
    };
  }
  if (value.type === "cancelled") return { type: "cancelled" };
  if (value.type === "models") {
    if (!Array.isArray(value.models) || value.models.length > 500) {
      throw new Error("Invalid GitHub Copilot model catalog");
    }
    const models = value.models.map((model): GitHubCopilotModel => {
      if (!model || typeof model !== "object") {
        throw new Error("Invalid GitHub Copilot model catalog");
      }
      const item = model as Record<string, unknown>;
      const id = requireString(item.id, "model.id");
      const name = requireString(item.name, "model.name");
      if (!id.startsWith("github-copilot/")) {
        throw new Error("Invalid GitHub Copilot model reference");
      }
      return { id, name };
    });
    return {
      type: "models",
      models: [...new Map(models.map((model) => [model.id, model])).values()].sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
    };
  }
  if (value.type === "failure") {
    return { type: "failure", message: requireString(value.message, "message").slice(0, 500) };
  }
  throw new Error("Unknown GitHub Copilot authentication message");
}

export function parseGitHubCopilotAuthStatus(output: string): boolean {
  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch {
    throw new Error("Invalid GitHub Copilot authentication status");
  }
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid GitHub Copilot authentication status");
  }

  const parsed = payload as {
    auth?: { oauth?: { providers?: unknown } };
  };
  const providers = parsed.auth?.oauth?.providers;
  if (!Array.isArray(providers)) {
    throw new Error("Invalid GitHub Copilot authentication status");
  }

  const provider = providers.find(
    (entry) =>
      entry &&
      typeof entry === "object" &&
      (entry as { provider?: unknown }).provider === "github-copilot",
  ) as { status?: unknown; profiles?: unknown } | undefined;
  if (!provider) return false;

  const isUsableStatus = (status: unknown) =>
    status === "ok" || status === "static" || status === "expiring";
  if (Array.isArray(provider.profiles)) {
    const hasUsableProfile = provider.profiles.some(
      (profile) =>
        profile &&
        typeof profile === "object" &&
        isUsableStatus((profile as { status?: unknown }).status),
    );
    if (hasUsableProfile) return true;
  }
  return isUsableStatus(provider.status);
}

export function parseGitHubCopilotDisconnectResult(
  output: string,
): GitHubCopilotDisconnectResult {
  let payload: unknown;
  try {
    payload = JSON.parse(output);
  } catch {
    throw new Error("Invalid GitHub Copilot disconnect response");
  }

  return parseGitHubCopilotDisconnectPayload(payload);
}

function parseGitHubCopilotDisconnectPayload(payload: unknown): GitHubCopilotDisconnectResult {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid GitHub Copilot disconnect response");
  }

  const result = payload as { provider?: unknown; removedProfiles?: unknown };
  if (result.provider !== "github-copilot" || !Array.isArray(result.removedProfiles)) {
    throw new Error("Invalid GitHub Copilot disconnect response");
  }
  if (
    result.removedProfiles.length > 100 ||
    result.removedProfiles.some(
      (profileId) =>
        typeof profileId !== "string" || !profileId.trim() || profileId.length > 500,
    )
  ) {
    throw new Error("Invalid GitHub Copilot disconnect response");
  }

  return { disconnected: true, removedProfiles: result.removedProfiles.length };
}

export function parseGitHubCopilotGatewayModels(payload: unknown): GitHubCopilotModel[] {
  if (!payload || typeof payload !== "object") {
    throw new Error("Invalid GitHub Copilot Gateway model list");
  }
  const entries = (payload as { models?: unknown }).models;
  if (!Array.isArray(entries) || entries.length > MAX_GATEWAY_MODELS) {
    throw new Error("Invalid GitHub Copilot Gateway model list");
  }

  const models = new Map<string, GitHubCopilotModel>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue;
    const value = entry as Record<string, unknown>;
    if (value.provider !== "github-copilot" || typeof value.id !== "string") continue;
    const rawId = value.id.trim();
    const modelId = rawId.startsWith("github-copilot/")
      ? rawId.slice("github-copilot/".length)
      : rawId;
    if (!modelId || modelId.length > 500 || modelId.includes("/")) continue;
    const rawName = typeof value.name === "string" ? value.name.trim() : "";
    const name = rawName && rawName.length <= 500 ? rawName : modelId;
    const id = `github-copilot/${modelId}`;
    models.set(id, { id, name });
  }
  return [...models.values()].sort(
    (left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id),
  );
}

export function invalidateGitHubCopilotAuthStatusCache(): void {
  authStatusCache = null;
  modelCatalogCache = null;
}

export function buildGitHubCopilotAuthStatusArgs(): string[] {
  return [
    "models",
    "status",
    "--agent",
    GITHUB_COPILOT_AUTH_AGENT_ID,
    "--json",
  ];
}

export function buildGitHubCopilotLogoutArgs(): string[] {
  return [
    "infer",
    "model",
    "auth",
    "logout",
    "--provider",
    "github-copilot",
    "--agent",
    GITHUB_COPILOT_AUTH_AGENT_ID,
    "--json",
  ];
}

async function runOpenClawJson(runtime: GitHubCopilotAuthRuntime, args: string[]): Promise<string> {
  if (!isSafeNodePath(runtime.nodePath) || !fs.existsSync(runtime.entryPath)) {
    throw new Error("OpenClaw CLI was not found");
  }

  return new Promise<string>((resolve, reject) => {
    const child = spawn(runtime.nodePath, [runtime.entryPath, ...args], spawnOptions(runtime));
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(stdout);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error("OpenClaw model query timed out"));
    }, CLI_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
        child.kill();
        finish(new Error("OpenClaw model query returned too much data"));
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_192);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code === 0) finish();
      else finish(new Error(stderr.trim() || `OpenClaw model query exited with code ${code}`));
    });
  });
}

export async function getGitHubCopilotAuthStatus(
  runtime: GitHubCopilotAuthRuntime,
): Promise<{ authenticated: boolean }> {
  if (authStatusCache && authStatusCache.expiresAt > Date.now()) return authStatusCache.value;
  if (authStatusInFlight) return authStatusInFlight;

  authStatusInFlight = runOpenClawJson(runtime, buildGitHubCopilotAuthStatusArgs())
    .then((output) => {
      const value = { authenticated: parseGitHubCopilotAuthStatus(output) };
      authStatusCache = { value, expiresAt: Date.now() + AUTH_STATUS_CACHE_MS };
      return value;
    })
    .finally(() => {
      authStatusInFlight = null;
    });
  return authStatusInFlight;
}

export async function disconnectGitHubCopilot(
  runtime: GitHubCopilotAuthRuntime,
): Promise<GitHubCopilotDisconnectResult> {
  try {
    const output = await runOpenClawJson(runtime, buildGitHubCopilotLogoutArgs());
    return parseGitHubCopilotDisconnectResult(output);
  } finally {
    invalidateGitHubCopilotAuthStatusCache();
  }
}

export async function listGitHubCopilotModels(
  runtime: GitHubCopilotAuthRuntime,
): Promise<GitHubCopilotModel[]> {
  if (modelCatalogCache) return modelCatalogCache;
  if (modelCatalogInFlight) return modelCatalogInFlight;

  const authRuntimePath = path.join(
    runtime.openClawPackageDir,
    "dist",
    "plugin-sdk",
    "provider-auth-login-flow-runtime.js",
  );
  if (
    !isSafeNodePath(runtime.nodePath) ||
    !fs.existsSync(runtime.workerPath) ||
    !fs.existsSync(authRuntimePath)
  ) {
    throw new Error("GitHub Copilot model catalog components were not found");
  }

  const request = new Promise<GitHubCopilotModel[]>((resolve, reject) => {
    const child = spawn(
      runtime.nodePath,
      [runtime.workerPath, authRuntimePath, "list-models"],
      spawnOptions(runtime),
    );
    let stdoutBuffer = "";
    let stderr = "";
    let models: GitHubCopilotModel[] | undefined;
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(models ?? []);
    };
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error("GitHub Copilot model catalog timed out"));
    }, CLI_TIMEOUT_MS);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdoutBuffer += chunk.toString("utf8");
      if (Buffer.byteLength(stdoutBuffer) > MAX_OUTPUT_BYTES) {
        child.kill();
        finish(new Error("GitHub Copilot model catalog returned too much data"));
        return;
      }
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (!line) continue;
        try {
          const message = parseGitHubCopilotWorkerLine(line);
          if (message?.type === "models") models = message.models;
          if (message?.type === "failure") finish(new Error(message.message));
        } catch (error) {
          child.kill();
          finish(error instanceof Error ? error : new Error(String(error)));
        }
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8_192);
    });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code === 0 && models) finish();
      else {
        finish(
          new Error(
            stderr.trim() || `GitHub Copilot model catalog exited with code ${code ?? "unknown"}`,
          ),
        );
      }
    });
  });
  modelCatalogInFlight = request
    .then((models) => {
      modelCatalogCache = models;
      return models;
    })
    .finally(() => {
      modelCatalogInFlight = null;
    });
  return modelCatalogInFlight;
}

export class GitHubCopilotAuthManager {
  private active: ActiveLogin | null = null;

  constructor(
    private readonly emit: (event: GitHubCopilotAuthEvent) => void,
    private readonly openExternal: (url: string) => Promise<void>,
  ) {}

  start(runtime: GitHubCopilotAuthRuntime): string {
    if (this.active) throw new Error("GitHub Copilot sign-in is already in progress");
    const authRuntimePath = path.join(
      runtime.openClawPackageDir,
      "dist",
      "plugin-sdk",
      "provider-auth-login-flow-runtime.js",
    );
    const providerCatalogRuntimePath = path.join(
      runtime.openClawPackageDir,
      "dist",
      "plugin-sdk",
      "provider-catalog-runtime.js",
    );
    const configRuntimePath = path.join(
      runtime.openClawPackageDir,
      "dist",
      "plugin-sdk",
      "config-runtime.js",
    );
    const modelsProviderRuntimePath = path.join(
      runtime.openClawPackageDir,
      "dist",
      "plugin-sdk",
      "models-provider-runtime.js",
    );
    if (
      !isSafeNodePath(runtime.nodePath) ||
      !fs.existsSync(runtime.workerPath) ||
      !fs.existsSync(authRuntimePath) ||
      !fs.existsSync(providerCatalogRuntimePath) ||
      !fs.existsSync(configRuntimePath) ||
      !fs.existsSync(modelsProviderRuntimePath)
    ) {
      throw new Error("GitHub Copilot sign-in components were not found");
    }

    fs.mkdirSync(runtime.compileCacheDir, { recursive: true });
    const sessionId = randomUUID();
    const child = spawn(
      runtime.nodePath,
      [runtime.workerPath, authRuntimePath],
      spawnOptions(runtime),
    );
    const active: ActiveLogin = {
      sessionId,
      child,
      terminal: false,
      stdoutBuffer: "",
      timeout: setTimeout(() => {
        this.fail(active, "GitHub Copilot sign-in timed out");
      }, AUTH_TIMEOUT_MS),
    };
    active.timeout.unref?.();
    this.active = active;

    child.stdout?.on("data", (chunk: Buffer) => this.handleOutput(active, chunk));
    child.stderr?.on("data", (chunk: Buffer) => {
      const message = chunk.toString("utf8").trim();
      if (message) console.warn(`[github-copilot-auth] ${message}`);
    });
    child.on("error", (error) => this.fail(active, error.message));
    child.on("close", (code) => {
      if (this.active === active && !active.terminal) {
        this.fail(
          active,
          `GitHub Copilot sign-in exited unexpectedly (${code ?? "unknown"})`,
          false,
        );
      }
    });
    return sessionId;
  }

  cancel(sessionId?: string): boolean {
    const active = this.active;
    if (!active || (sessionId && active.sessionId !== sessionId)) return false;
    active.terminal = true;
    clearTimeout(active.timeout);
    active.child.kill();
    this.active = null;
    this.emit({ sessionId: active.sessionId, status: "cancelled" });
    return true;
  }

  stop(): void {
    const active = this.active;
    if (!active) return;
    active.terminal = true;
    clearTimeout(active.timeout);
    active.child.kill();
    this.active = null;
  }

  private handleOutput(active: ActiveLogin, chunk: Buffer): void {
    if (this.active !== active || active.terminal) return;
    active.stdoutBuffer += chunk.toString("utf8");
    if (Buffer.byteLength(active.stdoutBuffer) > 64 * 1024) {
      this.fail(active, "GitHub Copilot sign-in returned invalid output");
      return;
    }

    const lines = active.stdoutBuffer.split(/\r?\n/);
    active.stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      try {
        const message = parseGitHubCopilotWorkerLine(line);
        if (message) this.handleMessage(active, message);
      } catch (error) {
        this.fail(active, error instanceof Error ? error.message : String(error));
        return;
      }
    }
  }

  private handleMessage(active: ActiveLogin, message: WorkerMessage): void {
    if (this.active !== active || active.terminal) return;
    if (message.type === "device-code") {
      this.emit({
        sessionId: active.sessionId,
        status: "code",
        verificationUrl: message.verificationUrl,
        userCode: message.userCode,
        expiresInMs: message.expiresInMs,
      });
      return;
    }
    if (message.type === "open-url") {
      void this.openExternal(message.url).catch((error) => {
        console.warn("[github-copilot-auth] Could not open verification URL:", error);
      });
      return;
    }
    if (message.type === "failure") {
      this.fail(active, message.message);
      return;
    }
    if (message.type === "cancelled") {
      active.terminal = true;
      clearTimeout(active.timeout);
      this.active = null;
      this.emit({ sessionId: active.sessionId, status: "cancelled" });
      return;
    }
    if (message.type === "models") {
      this.fail(active, "GitHub Copilot sign-in returned an unexpected model catalog");
      return;
    }

    active.terminal = true;
    clearTimeout(active.timeout);
    this.active = null;
    invalidateGitHubCopilotAuthStatusCache();
    this.emit({
      sessionId: active.sessionId,
      status: "success",
      defaultModel: message.defaultModel,
    });
  }

  private fail(active: ActiveLogin, message: string, kill = true): void {
    if (this.active !== active || active.terminal) return;
    active.terminal = true;
    clearTimeout(active.timeout);
    if (kill) active.child.kill();
    this.active = null;
    this.emit({ sessionId: active.sessionId, status: "error", message: message.slice(0, 500) });
  }
}
