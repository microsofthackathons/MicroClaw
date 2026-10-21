import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/core";

import { resolveStateDir } from "../storage/state-dir.js";
import { resolveFrameworkAllowFromPath } from "./pairing.js";
import { logger } from "../util/logger.js";

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

// ---------------------------------------------------------------------------
// Account ID compatibility (legacy raw ID → normalized ID)
// ---------------------------------------------------------------------------

/**
 * Pattern-based reverse of normalizeWeixinAccountId for known weixin ID suffixes.
 * Used only as a compatibility fallback when loading accounts / sync bufs stored
 * under the old raw ID.
 * e.g. "b0f5860fdecb-im-bot" → "b0f5860fdecb@im.bot"
 */
export function deriveRawAccountId(normalizedId: string): string | undefined {
  if (normalizedId.endsWith("-im-bot")) {
    return `${normalizedId.slice(0, -7)}@im.bot`;
  }
  if (normalizedId.endsWith("-im-wechat")) {
    return `${normalizedId.slice(0, -10)}@im.wechat`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Account index (persistent list of registered account IDs)
// ---------------------------------------------------------------------------

function resolveWeixinStateDir(): string {
  return path.join(resolveStateDir(), "openclaw-weixin");
}

function resolveAccountIndexPath(): string {
  return path.join(resolveWeixinStateDir(), "accounts.json");
}

/** Returns all accountIds registered via QR login. */
export function listIndexedWeixinAccountIds(): string[] {
  const filePath = resolveAccountIndexPath();
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id.trim() !== "");
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Account store (per-account credential files)
// ---------------------------------------------------------------------------

/** Unified per-account data: token + baseUrl in one file. */
export type WeixinAccountData = {
  token?: string;
  savedAt?: string;
  baseUrl?: string;
  /** Last linked Weixin user id from QR login (optional). */
  userId?: string;
};

function resolveAccountsDir(): string {
  return path.join(resolveWeixinStateDir(), "accounts");
}

function resolveAccountPath(accountId: string): string {
  return path.join(resolveAccountsDir(), `${accountId}.json`);
}

function atomicWriteFile(filePath: string, data: string | Buffer): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tempPath = path.join(dir, `.${path.basename(filePath)}.${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(tempPath, data);
    fs.renameSync(tempPath, filePath);
  } finally {
    try {
      fs.unlinkSync(tempPath);
    } catch {
      // Already promoted or never created.
    }
  }
}

/**
 * Legacy single-file token: `credentials/openclaw-weixin/credentials.json` (pre per-account files).
 */
function loadLegacyToken(): string | undefined {
  const legacyPath = path.join(
    resolveStateDir(),
    "credentials",
    "openclaw-weixin",
    "credentials.json",
  );
  try {
    if (!fs.existsSync(legacyPath)) return undefined;
    const raw = fs.readFileSync(legacyPath, "utf-8");
    const parsed = JSON.parse(raw) as { token?: string };
    return typeof parsed.token === "string" ? parsed.token : undefined;
  } catch {
    return undefined;
  }
}

function readAccountFile(filePath: string): WeixinAccountData | null {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8")) as WeixinAccountData;
    }
  } catch {
    // ignore
  }
  return null;
}

function loadStoredWeixinAccountFile(accountId: string): WeixinAccountData | null {
  const primary = readAccountFile(resolveAccountPath(accountId));
  if (primary) return primary;
  const rawId = deriveRawAccountId(accountId);
  return rawId ? readAccountFile(resolveAccountPath(rawId)) : null;
}

/** Load account data by ID, with compatibility fallbacks. */
export function loadWeixinAccount(accountId: string): WeixinAccountData | null {
  const stored = loadStoredWeixinAccountFile(accountId);
  if (stored) return stored;

  // Legacy fallback: read token from old single-account credentials file.
  const token = loadLegacyToken();
  if (token) return { token };

  return null;
}

/**
 * Persist account data after QR login (merges into existing file).
 * - token: overwritten when provided.
 * - baseUrl: stored when non-empty; resolveWeixinAccount falls back to DEFAULT_BASE_URL.
 * - userId: set when `update.userId` is provided; omitted from file when cleared to empty.
 */
export function saveWeixinAccount(
  accountId: string,
  update: { token?: string; baseUrl?: string; userId?: string },
): void {
  const dir = resolveAccountsDir();
  fs.mkdirSync(dir, { recursive: true });

  const existing = loadWeixinAccount(accountId) ?? {};

  const token = update.token?.trim() || existing.token;
  const baseUrl = update.baseUrl?.trim() || existing.baseUrl;
  const userId =
    update.userId !== undefined
      ? update.userId.trim() || undefined
      : existing.userId?.trim() || undefined;

  const data: WeixinAccountData = {
    ...(token ? { token, savedAt: new Date().toISOString() } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(userId ? { userId } : {}),
  };

  const filePath = resolveAccountPath(accountId);
  atomicWriteFile(filePath, JSON.stringify(data, null, 2));
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort
  }
}

export interface ReplaceWeixinAccountResult {
  accountId: string;
  userId: string;
  replacedAccounts: Array<{ accountId: string; userId?: string }>;
}

const accountChangeListeners = new Set<() => void>();

export function onWeixinAccountChanged(listener: () => void): () => void {
  accountChangeListeners.add(listener);
  return () => accountChangeListeners.delete(listener);
}

export function watchWeixinAccountState(listener: () => void): () => void {
  const watchers: Array<ReturnType<typeof fs.watch>> = [];
  for (const directory of [resolveWeixinStateDir(), resolveAccountsDir()]) {
    try {
      fs.mkdirSync(directory, { recursive: true });
      watchers.push(
        fs.watch(directory, { persistent: false }, () => {
          listener();
        }),
      );
    } catch (error) {
      logger.warn(`watchWeixinAccountState: failed to watch ${directory}: ${String(error)}`);
    }
  }
  return () => {
    for (const watcher of watchers) watcher.close();
  };
}

interface FileSnapshot {
  path: string;
  contents: Buffer | null;
}

function snapshotFile(filePath: string): FileSnapshot {
  return {
    path: filePath,
    contents: fs.existsSync(filePath) ? fs.readFileSync(filePath) : null,
  };
}

function restoreSnapshots(snapshots: FileSnapshot[]): void {
  for (const snapshot of snapshots) {
    if (snapshot.contents === null) {
      try {
        fs.unlinkSync(snapshot.path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      continue;
    }
    atomicWriteFile(snapshot.path, snapshot.contents);
  }
}

function accountArtifactPaths(accountId: string): string[] {
  const dir = resolveAccountsDir();
  return [
    path.join(dir, `${accountId}.json`),
    path.join(dir, `${accountId}.sync.json`),
    path.join(dir, `${accountId}.context-tokens.json`),
    resolveFrameworkAllowFromPath(accountId),
  ];
}

function ensureFrameworkAllowFromContains(accountId: string, userId: string): void {
  const filePath = resolveFrameworkAllowFromPath(accountId);
  let allowFrom: string[] = [];
  if (fs.existsSync(filePath)) {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as {
      version?: unknown;
      allowFrom?: unknown;
    };
    if (
      parsed.version !== 1 ||
      !Array.isArray(parsed.allowFrom) ||
      parsed.allowFrom.some((value) => typeof value !== "string" || !value.trim())
    ) {
      throw new Error(`WeChat allowFrom state is invalid for account ${accountId}`);
    }
    allowFrom = parsed.allowFrom.map((value) => value.trim());
  }
  if (!allowFrom.includes(userId)) allowFrom.push(userId);
  atomicWriteFile(filePath, JSON.stringify({ version: 1, allowFrom }, null, 2));
}

function readStrictAccountIndex(): string[] {
  const filePath = resolveAccountIndexPath();
  if (!fs.existsSync(filePath)) return [];
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
  if (
    !Array.isArray(parsed) ||
    parsed.some(
      (id) =>
        typeof id !== "string" ||
        id.trim() !== id ||
        id.length === 0 ||
        id.includes("..") ||
        !/^[A-Za-z0-9._@-]{1,160}$/.test(id),
    )
  ) {
    throw new Error("WeChat account index is invalid");
  }
  return [...new Set(parsed)];
}

/** Fail closed when a running provider no longer owns the sole authenticated account. */
export function isActiveWeixinAccount(accountId: string, expectedToken?: string): boolean {
  try {
    const normalizedId = normalizeAccountId(accountId);
    const indexedIds = readStrictAccountIndex();
    if (indexedIds.length !== 1 || normalizeAccountId(indexedIds[0]) !== normalizedId) {
      return false;
    }
    const account = loadStoredWeixinAccountFile(indexedIds[0]);
    const token = account?.token?.trim();
    return Boolean(
      token &&
        account.userId?.trim() &&
        (expectedToken === undefined || token === expectedToken.trim()),
    );
  } catch {
    return false;
  }
}

/**
 * Commit one authenticated WeChat identity and remove every other indexed account.
 * The previous index and account artifacts are restored if any write or cleanup fails.
 */
export function replaceWeixinAccount(
  input: {
    accountId: string;
    token: string;
    baseUrl?: string;
    userId: string;
  },
  onClearContextTokens?: (accountId: string) => void,
): ReplaceWeixinAccountResult {
  const accountId = normalizeAccountId(input.accountId);
  const token = input.token.trim();
  const userId = input.userId.trim();
  if (!accountId || !token || !userId) {
    throw new Error("A complete WeChat account ID, token, and user ID are required");
  }

  const existingIds = readStrictAccountIndex();
  const cleanupIds = existingIds.filter((id) => id !== accountId);
  const aliasIds = cleanupIds.filter((id) => normalizeAccountId(id) === accountId);
  const removedIds = cleanupIds.filter((id) => normalizeAccountId(id) !== accountId);
  const replacedAccounts = removedIds.map((id) => ({
    accountId: id,
    ...(loadWeixinAccount(id)?.userId?.trim()
      ? { userId: loadWeixinAccount(id)!.userId!.trim() }
      : {}),
  }));
  const indexPath = resolveAccountIndexPath();
  const snapshots = [
    snapshotFile(indexPath),
    ...accountArtifactPaths(accountId).map(snapshotFile),
    ...cleanupIds.flatMap((id) => accountArtifactPaths(id).map(snapshotFile)),
  ];

  try {
    saveWeixinAccount(accountId, {
      token,
      baseUrl: input.baseUrl,
      userId,
    });
    const targetPaths = accountArtifactPaths(accountId);
    for (const aliasId of aliasIds) {
      const aliasPaths = accountArtifactPaths(aliasId);
      for (let index = 1; index < aliasPaths.length; index += 1) {
        if (fs.existsSync(aliasPaths[index]) && !fs.existsSync(targetPaths[index])) {
          atomicWriteFile(targetPaths[index], fs.readFileSync(aliasPaths[index]));
        }
      }
    }
    ensureFrameworkAllowFromContains(accountId, userId);
    for (const cleanupId of cleanupIds) {
      clearWeixinAccount(cleanupId, { strict: true });
    }
    atomicWriteFile(indexPath, JSON.stringify([accountId], null, 2));
  } catch (error) {
    try {
      restoreSnapshots(snapshots);
    } catch (rollbackError) {
      throw new Error(
        `WeChat account replacement failed and rollback was incomplete: ${String(error)}; rollback: ${String(rollbackError)}`,
        { cause: rollbackError },
      );
    }
    throw error;
  }

  for (const cleanupId of cleanupIds) {
    try {
      onClearContextTokens?.(cleanupId);
    } catch (error) {
      logger.warn(
        `replaceWeixinAccount: in-memory context cleanup failed account=${cleanupId}: ${String(error)}`,
      );
    }
  }
  logger.info(`replaceWeixinAccount: active=${accountId} replaced=${removedIds.length}`);
  for (const listener of [...accountChangeListeners]) {
    try {
      listener();
    } catch (error) {
      logger.warn(`replaceWeixinAccount: account-change listener failed: ${String(error)}`);
    }
  }
  return { accountId, userId, replacedAccounts };
}

/**
 * Remove all files associated with an account:
 *   - accounts/{accountId}.json                  (credentials)
 *   - accounts/{accountId}.sync.json             (getUpdates sync buf)
 *   - accounts/{accountId}.context-tokens.json   (context tokens on disk)
 *   - credentials/openclaw-weixin-{accountId}-allowFrom.json (authorized users)
 */
export function clearWeixinAccount(accountId: string, options: { strict?: boolean } = {}): void {
  for (const filePath of accountArtifactPaths(accountId)) {
    try {
      fs.unlinkSync(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      if (options.strict) throw error;
      logger.warn(`clearWeixinAccount: failed to remove ${filePath}: ${String(error)}`);
    }
  }
}

/**
 * Resolve the openclaw.json config file path.
 * Checks OPENCLAW_CONFIG env var, then state dir.
 */
function resolveConfigPath(): string {
  const envPath = process.env.OPENCLAW_CONFIG?.trim();
  if (envPath) return envPath;
  return path.join(resolveStateDir(), "openclaw.json");
}

/**
 * Read `routeTag` from openclaw.json (for callers without an `OpenClawConfig` object).
 * Checks per-account `channels.<id>.accounts[accountId].routeTag` first, then section-level
 * `channels.<id>.routeTag`. Matches `feat_weixin_extension` behavior; channel key is `"openclaw-weixin"`.
 *
 * The config is cached after the first read since routeTag does not change at runtime.
 */
let cachedRouteTagSection: Record<string, unknown> | null | undefined;

function loadRouteTagSection(): Record<string, unknown> | null {
  if (cachedRouteTagSection !== undefined) return cachedRouteTagSection;
  try {
    const configPath = resolveConfigPath();
    if (!fs.existsSync(configPath)) {
      cachedRouteTagSection = null;
      return null;
    }
    const raw = fs.readFileSync(configPath, "utf-8");
    const cfg = JSON.parse(raw) as Record<string, unknown>;
    const channels = cfg.channels as Record<string, unknown> | undefined;
    const section = (channels?.["openclaw-weixin"] as Record<string, unknown>) ?? null;
    cachedRouteTagSection = section;
    return section;
  } catch {
    cachedRouteTagSection = null;
    return null;
  }
}

export function loadConfigRouteTag(accountId?: string): string | undefined {
  const section = loadRouteTagSection();
  if (!section) return undefined;
  if (accountId) {
    const accounts = section.accounts as Record<string, Record<string, unknown>> | undefined;
    const tag = accounts?.[accountId]?.routeTag;
    if (typeof tag === "number") return String(tag);
    if (typeof tag === "string" && tag.trim()) return tag.trim();
  }
  if (typeof section.routeTag === "number") return String(section.routeTag);
  return typeof section.routeTag === "string" && section.routeTag.trim()
    ? section.routeTag.trim()
    : undefined;
}

/**
 * Read `botAgent` from `channels.openclaw-weixin.botAgent` in openclaw.json.
 * Returns the raw configured string (caller is responsible for sanitization)
 * or undefined when not set. Reuses the cached channel section.
 */
export function loadConfigBotAgent(): string | undefined {
  const section = loadRouteTagSection();
  if (!section) return undefined;
  const value = section.botAgent;
  return typeof value === "string" && value.trim() ? value : undefined;
}

/**
 * Bump `channels.openclaw-weixin.channelConfigUpdatedAt` in openclaw.json on each successful login
 * so the gateway reloads config from disk (no empty `accounts: {}` placeholder).
 */
export async function triggerWeixinChannelReload(): Promise<boolean> {
  try {
    const { mutateConfigFile } = await import("openclaw/plugin-sdk/config-mutation");
    await mutateConfigFile({
      mutate(cfg) {
        const channels = (cfg.channels ?? {}) as Record<string, unknown>;
        const existing = (channels["openclaw-weixin"] as Record<string, unknown> | undefined) ?? {};
        cfg.channels = {
          ...channels,
          "openclaw-weixin": {
            ...existing,
            channelConfigUpdatedAt: new Date().toISOString(),
          },
        };
      },
    });
    logger.info("triggerWeixinChannelReload: wrote channel config to openclaw.json");
    return true;
  } catch (err) {
    logger.warn(`triggerWeixinChannelReload: failed to update config: ${String(err)}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Account resolution (merge config + stored credentials)
// ---------------------------------------------------------------------------

export type ResolvedWeixinAccount = {
  accountId: string;
  baseUrl: string;
  cdnBaseUrl: string;
  token?: string;
  enabled: boolean;
  /** true when a token has been obtained via QR login. */
  configured: boolean;
  name?: string;
};

type WeixinAccountConfig = {
  name?: string;
  enabled?: boolean;
  cdnBaseUrl?: string;
  /** Optional SKRouteTag source; read from openclaw.json when `accountId` is passed to `loadConfigRouteTag`. */
  routeTag?: number | string;
};

type WeixinSectionConfig = WeixinAccountConfig & {
  accounts?: Record<string, WeixinAccountConfig>;
  /** Written on each successful login; see triggerWeixinChannelReload. */
  channelConfigUpdatedAt?: string;
};

/** List accountIds from the index file (written at QR login). */
export function listWeixinAccountIds(_cfg: OpenClawConfig): string[] {
  return listIndexedWeixinAccountIds();
}

/** Resolve a weixin account by ID, merging config and stored credentials. */
export function resolveWeixinAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedWeixinAccount {
  const raw = accountId?.trim();
  if (!raw) {
    throw new Error("weixin: accountId is required (no default account)");
  }
  const id = normalizeAccountId(raw);
  const section = cfg.channels?.["openclaw-weixin"] as WeixinSectionConfig | undefined;
  const accountCfg: WeixinAccountConfig = section?.accounts?.[id] ?? section ?? {};

  const accountData = loadWeixinAccount(id);
  const token = accountData?.token?.trim() || undefined;
  const stateBaseUrl = accountData?.baseUrl?.trim() || "";

  return {
    accountId: id,
    baseUrl: stateBaseUrl || DEFAULT_BASE_URL,
    cdnBaseUrl: accountCfg.cdnBaseUrl?.trim() || CDN_BASE_URL,
    token,
    enabled: accountCfg.enabled !== false,
    configured: Boolean(token),
    name: accountCfg.name?.trim() || undefined,
  };
}
