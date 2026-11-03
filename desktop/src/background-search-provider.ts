import * as fs from "node:fs";
import * as path from "node:path";
import { isDeepStrictEqual } from "node:util";

export const SEARCH_SETUP_FILENAME = "microclaw-search-setup.json";
const PROVIDER = "parallel-free";
const PLUGIN_ID = "parallel";
const PACKAGE = "@openclaw/parallel-plugin";
type JsonObject = Record<string, unknown>;

interface SearchGateway {
  connected: boolean;
  serverVersion: string | null;
  connectionGeneration: number;
  methods: readonly string[];
  request(method: string, params: JsonObject, timeoutMs?: number): Promise<unknown>;
}

interface Dependencies {
  stateDir(): string;
  gateway(): SearchGateway | null;
  ready(): boolean;
  log(message: string): void;
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function searchConfig(config: JsonObject): JsonObject {
  return object(object(object(config.tools).web).search);
}

function runtimeApplied(value: JsonObject): boolean {
  const runtime = object(value.runtime);
  return (
    value.ok === true &&
    value.restartRequired !== true &&
    Number.isInteger(runtime.generation) &&
    Array.isArray(runtime.pluginIds) &&
    runtime.pluginIds.includes(PLUGIN_ID)
  );
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
    const pending = object(JSON.parse(pendingText));
    if (
      pending.schemaVersion !== 1 ||
      object(pending.search).provider !== PROVIDER ||
      object(pending.suspendedSearch).enabled !== false ||
      object(pending.suspendedSearch).provider !== undefined
    )
      throw new Error("Unrecognized pending web search setup");
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
    const reloadMode = object(object(object(snapshot.config).gateway).reload).mode;
    if (reloadMode === "off" || reloadMode === "restart")
      throw new Error("Web search setup requires configuration hot reload; no restart attempted");
    const catalog = object(await gateway.request("plugins.list", {}));
    assertCurrent();
    if (!Array.isArray(catalog.plugins) || catalog.mutationAllowed === false)
      throw new Error("Gateway plugin installation is unavailable");
    const plugin = catalog.plugins.map(object).find((entry) => entry.id === PLUGIN_ID) ?? {};
    const version = gateway.serverVersion?.split("+", 1)[0];
    if (!version || !/^\d{4}\.\d{1,2}\.\d+(?:-[\w.-]+)?$/.test(version))
      throw new Error("Cannot resolve a compatible web search plugin version");
    let application: JsonObject | undefined;
    if (plugin.installed !== true || plugin.version !== version || plugin.state === "error") {
      this.deps.log("Installing web search plugin in the background");
      application = object(
        await gateway.request(
          "plugins.install",
          { source: "npm", spec: `${PACKAGE}@${version}`, expectedPluginId: PLUGIN_ID },
          300_000,
        ),
      );
    } else if (plugin.enabled !== true) {
      application = object(
        await gateway.request(
          "plugins.setEnabled",
          { pluginId: PLUGIN_ID, enabled: true },
          300_000,
        ),
      );
    } else if (object(plugin.runtime).state !== "active" || object(plugin.runtime).error) {
      application = object(
        await gateway.request(
          "plugins.reload",
          { plugins: [{ pluginId: PLUGIN_ID }], waitForDrain: true },
          300_000,
        ),
      );
    }
    assertCurrent();
    if (application && !runtimeApplied(application))
      throw new Error("Web search plugin hot-load was not confirmed; no restart attempted");
    const inspected = object(await gateway.request("plugins.inspect", { pluginId: PLUGIN_ID }));
    assertCurrent();
    const installed = object(inspected.plugin);
    if (
      installed.id !== PLUGIN_ID ||
      installed.installed !== true ||
      installed.enabled !== true ||
      installed.version !== version ||
      object(installed.runtime).state !== "active" ||
      object(installed.runtime).error
    )
      throw new Error("Web search plugin is not active; search remains disabled");
    snapshot = await readSnapshot();
    if (!matches(snapshot)) {
      fs.unlinkSync(pendingPath);
      this.deps.log("Search settings changed during setup; keeping the user's selection");
      return;
    }
    const config = object(snapshot.config);
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
          [PLUGIN_ID]: {
            ...object(pending.pluginEntry),
            ...object(entries[PLUGIN_ID]),
            enabled: true,
          },
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
    fs.unlinkSync(pendingPath);
    this.deps.log("Web search is ready; Gateway was not restarted");
  }
}
