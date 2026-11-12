import * as fs from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  assertSearchProviderPluginActive,
  ensureSearchProviderPlugin,
  searchProviderPlugin,
  type SearchProviderGateway,
} from "./search-provider-plugin";

export const SEARCH_SETUP_FILENAME = "microclaw-search-setup.json";
type JsonObject = Record<string, unknown>;

interface Dependencies {
  stateDir(): string;
  gateway(): SearchProviderGateway | null;
  ready(): boolean;
  log(message: string): void;
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function requiredObject(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Unrecognized pending web search setup");
  return value as JsonObject;
}

function searchConfig(config: JsonObject): JsonObject {
  return object(object(object(config.tools).web).search);
}

function assertPluginNotDisabled(config: JsonObject, pluginId: string): void {
  const plugins = object(config.plugins);
  const entry = object(object(plugins.entries)[pluginId]);
  if (
    plugins.enabled === false ||
    entry.enabled === false ||
    (Array.isArray(plugins.deny) && plugins.deny.includes(pluginId))
  )
    throw new Error("The selected web search plugin is disabled in Gateway settings");
}

function mergePluginEntry(saved: JsonObject, current: JsonObject): JsonObject {
  const merged: JsonObject = { ...saved, ...current, enabled: true };
  if (!Object.hasOwn(saved, "config") && !Object.hasOwn(current, "config")) return merged;
  for (const value of [saved.config, current.config]) {
    if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value)))
      throw new Error("The web search plugin configuration is invalid");
  }
  const savedConfig = object(saved.config);
  const currentConfig = object(current.config);
  const config: JsonObject = { ...savedConfig, ...currentConfig };
  if (Object.hasOwn(savedConfig, "webSearch") || Object.hasOwn(currentConfig, "webSearch")) {
    for (const value of [savedConfig.webSearch, currentConfig.webSearch]) {
      if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value)))
        throw new Error("The web search provider configuration is invalid");
    }
    config.webSearch = { ...object(savedConfig.webSearch), ...object(currentConfig.webSearch) };
  }
  merged.config = config;
  return merged;
}

export function searchSetupUpgradeCommitted(root: string, transactionId?: string): boolean {
  if (!transactionId) return true;
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(root, "upgrade", "openclaw-upgrade.json"), "utf-8"),
    );
    return manifest.transaction_id === transactionId && manifest.phase === "committed";
  } catch {
    return false;
  }
}

export class BackgroundSearchProvider {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private attempted = false;
  private stopped = false;

  constructor(private readonly deps: Dependencies) {}

  start(): void {
    if (this.stopped || this.attempted || this.timer) return;
    if (!fs.existsSync(path.join(this.deps.stateDir(), SEARCH_SETUP_FILENAME))) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      if (this.stopped) return;
      if (!this.deps.ready()) {
        this.start();
        return;
      }
      this.attempted = true;
      void this.install().catch((error: unknown) => {
        if (!this.stopped)
          this.deps.log(
            `Web search setup deferred until next launch: ${error instanceof Error ? error.message : String(error)}`,
          );
      });
    }, 5_000);
    this.timer.unref();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private async install(): Promise<void> {
    const pendingPath = path.join(this.deps.stateDir(), SEARCH_SETUP_FILENAME);
    const pendingText = fs.readFileSync(pendingPath, "utf-8");
    const pending = requiredObject(JSON.parse(pendingText));
    const search = requiredObject(pending.search);
    const pluginEntry = requiredObject(pending.pluginEntry);
    const expectedSuspended: JsonObject = { ...search, enabled: false };
    delete expectedSuspended.provider;
    if (
      pending.schemaVersion !== 1 ||
      search.enabled === false ||
      Object.hasOwn(search, "apiKey") ||
      pluginEntry.enabled === false ||
      !isDeepStrictEqual(pending.suspendedSearch, expectedSuspended)
    )
      throw new Error("Unrecognized pending web search setup");
    const provider = search.provider;
    const plugin = searchProviderPlugin(provider);
    const gateway = this.deps.gateway();
    if (!gateway?.connected) throw new Error("Gateway is not ready");
    if (
      ![
        "plugins.list",
        "plugins.inspect",
        "plugins.install",
        "plugins.setEnabled",
        "plugins.reload",
        "config.get",
        "config.apply",
      ].every((method) => gateway.methods.includes(method))
    )
      throw new Error("Gateway does not support background plugin hot-loading");
    const generation = gateway.connectionGeneration;
    const assertCurrent = () => {
      if (
        this.stopped ||
        this.deps.gateway() !== gateway ||
        !gateway.connected ||
        gateway.connectionGeneration !== generation ||
        fs.readFileSync(pendingPath, "utf-8") !== pendingText
      )
        throw new Error("Background web search setup context changed");
    };
    const readSnapshot = async () => {
      const snapshot = object(await gateway.request("config.get", {}));
      assertCurrent();
      if (snapshot.valid !== true || typeof snapshot.hash !== "string" || !snapshot.hash)
        throw new Error("Gateway configuration is unavailable");
      return snapshot;
    };
    const matches = (snapshot: JsonObject) =>
      [pending.suspendedSearch, pending.search].some((search) =>
        isDeepStrictEqual(searchConfig(object(snapshot.config)), search),
      );
    let snapshot = await readSnapshot();
    if (!matches(snapshot)) {
      fs.unlinkSync(pendingPath);
      this.deps.log("Cancelled pending web search setup: search settings changed");
      return;
    }
    assertPluginNotDisabled(object(snapshot.config), plugin.id);
    const reloadMode = object(object(object(snapshot.config).gateway).reload).mode;
    if (reloadMode === "off" || reloadMode === "restart")
      throw new Error("Web search setup requires configuration hot reload; no restart attempted");
    await ensureSearchProviderPlugin(gateway, provider, assertCurrent, () =>
      this.deps.log("Installing web search plugin in the background"),
    );
    snapshot = await readSnapshot();
    if (!matches(snapshot)) {
      fs.unlinkSync(pendingPath);
      this.deps.log("Search settings changed during setup; keeping the user's selection");
      return;
    }
    const config = object(snapshot.config);
    assertPluginNotDisabled(config, plugin.id);
    const tools = object(config.tools);
    const plugins = object(config.plugins);
    const entries = object(plugins.entries);
    const target = {
      ...config,
      tools: { ...tools, web: { ...object(tools.web), search: pending.search } },
      plugins: {
        ...plugins,
        entries: {
          ...entries,
          [plugin.id]: mergePluginEntry(pluginEntry, object(entries[plugin.id])),
        },
      },
    };
    const result = object(
      await gateway.request(
        "config.apply",
        {
          baseHash: snapshot.hash,
          raw: JSON.stringify(target),
          note: "Background web search setup",
        },
        30_000,
      ),
    );
    assertCurrent();
    if (
      result.ok !== true ||
      typeof result.hash !== "string" ||
      object(object(object(result.sentinel).payload).stats).requiresRestart === true
    )
      throw new Error("Web search configuration hot-apply was not confirmed; no restart attempted");
    const deadline = Date.now() + 30_000;
    while (true) {
      const applied = await readSnapshot();
      if (applied.hash !== result.hash || !matches(applied))
        throw new Error("Search settings changed while being applied");
      if (
        typeof applied.configRevisionHash === "string" &&
        applied.configRevisionHash &&
        applied.appliedConfigHash === applied.configRevisionHash &&
        isDeepStrictEqual(searchConfig(object(applied.config)), pending.search)
      )
        break;
      if (Date.now() >= deadline)
        throw new Error("Web search configuration is still being applied");
      await new Promise((resolve) => setTimeout(resolve, 500));
      assertCurrent();
    }
    if (object(pending.search).enabled !== false)
      await assertSearchProviderPluginActive(gateway, provider, assertCurrent);
    const confirmed = await readSnapshot();
    if (
      confirmed.hash !== result.hash ||
      !isDeepStrictEqual(searchConfig(object(confirmed.config)), pending.search)
    )
      throw new Error("Search settings changed while the provider was being activated");
    fs.unlinkSync(pendingPath);
    this.deps.log("Web search is ready; Gateway was not restarted");
  }
}
