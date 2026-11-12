type JsonObject = Record<string, unknown>;

export interface SearchProviderGateway {
  connected: boolean;
  serverVersion: string | null;
  connectionGeneration: number;
  methods: readonly string[];
  request(method: string, params: JsonObject, timeoutMs?: number): Promise<unknown>;
}

const providers = {
  "parallel-free": { id: "parallel", package: "@openclaw/parallel-plugin" },
  brave: { id: "brave", package: "@openclaw/brave-plugin" },
  tavily: { id: "tavily", package: "@openclaw/tavily-plugin" },
} as const;

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

export function searchProviderPlugin(provider: unknown): { id: string; package: string } {
  if (typeof provider !== "string" || !Object.hasOwn(providers, provider)) {
    throw new Error("Unsupported web search provider");
  }
  return providers[provider as keyof typeof providers];
}

function pluginVersion(gateway: SearchProviderGateway): string {
  const version = gateway.serverVersion?.split("+", 1)[0];
  if (!version || !/^\d{4}\.\d{1,2}\.\d+(?:-[\w.-]+)?$/.test(version))
    throw new Error("Cannot resolve a compatible web search plugin version");
  return version;
}

function assertLifecycleApplication(application: JsonObject, pluginId: string): void {
  const runtime = object(application.runtime);
  if (
    application.ok !== true ||
    application.restartRequired === true ||
    !Number.isInteger(runtime.generation) ||
    !Array.isArray(runtime.pluginIds) ||
    !runtime.pluginIds.includes(pluginId)
  )
    throw new Error("Web search plugin hot-load was not confirmed; no restart attempted");
}

async function verifiedRuntimeState(
  gateway: SearchProviderGateway,
  pluginId: string,
  version: string,
  assertCurrent: () => void,
): Promise<"active" | "unloaded"> {
  const inspected = object(await gateway.request("plugins.inspect", { pluginId }));
  assertCurrent();
  const installed = object(inspected.plugin);
  if (
    inspected.ok !== true ||
    installed.id !== pluginId ||
    installed.installed !== true ||
    installed.enabled !== true ||
    installed.version !== version
  )
    throw new Error("Web search plugin identity or version could not be confirmed");
  const catalog = object(await gateway.request("plugins.list", {}));
  assertCurrent();
  const entry = Array.isArray(catalog.plugins)
    ? catalog.plugins.map(object).find((candidate) => candidate.id === pluginId)
    : undefined;
  const runtime = object(entry?.runtime);
  if (
    !entry ||
    entry.installed !== true ||
    entry.enabled !== true ||
    entry.version !== version ||
    runtime.error ||
    (runtime.state !== "active" && runtime.state !== "unloaded")
  ) {
    const reason = !entry
      ? "missing from the runtime catalog"
      : entry.installed !== true
        ? "not installed"
        : entry.enabled !== true
          ? "disabled"
          : entry.version !== version
            ? "version mismatch"
            : runtime.error
              ? "runtime error"
              : `runtime state: ${["disabled", "service-failed"].includes(String(runtime.state)) ? runtime.state : "unknown"}`;
    throw new Error(`Web search plugin is not active (${reason})`);
  }
  return runtime.state;
}

export async function ensureSearchProviderPlugin(
  gateway: SearchProviderGateway,
  provider: unknown,
  assertCurrent: () => void,
  onInstall?: () => void,
): Promise<string> {
  const plugin = searchProviderPlugin(provider);
  if (
    ![
      "plugins.list",
      "plugins.inspect",
      "plugins.install",
      "plugins.setEnabled",
      "plugins.reload",
    ].every((method) => gateway.methods.includes(method))
  )
    throw new Error("Gateway does not support web search plugin hot-loading");
  const version = pluginVersion(gateway);
  const catalog = object(await gateway.request("plugins.list", {}));
  assertCurrent();
  if (!Array.isArray(catalog.plugins) || catalog.mutationAllowed === false)
    throw new Error("Gateway plugin installation is unavailable");
  const current = catalog.plugins.map(object).find((entry) => entry.id === plugin.id) ?? {};
  let application: JsonObject | undefined;
  if (current.installed !== true || current.version !== version || current.state === "error") {
    onInstall?.();
    application = object(
      await gateway.request(
        "plugins.install",
        { source: "npm", spec: `${plugin.package}@${version}`, expectedPluginId: plugin.id },
        300_000,
      ),
    );
  } else if (current.enabled !== true) {
    application = object(
      await gateway.request("plugins.setEnabled", { pluginId: plugin.id, enabled: true }, 300_000),
    );
  } else if (
    !["active", "unloaded"].includes(String(object(current.runtime).state)) ||
    object(current.runtime).error
  ) {
    application = object(
      await gateway.request(
        "plugins.reload",
        { plugins: [{ pluginId: plugin.id }], waitForDrain: true },
        300_000,
      ),
    );
  }
  assertCurrent();
  if (application) assertLifecycleApplication(application, plugin.id);
  await verifiedRuntimeState(gateway, plugin.id, version, assertCurrent);
  return plugin.id;
}

export async function assertSearchProviderPluginActive(
  gateway: SearchProviderGateway,
  provider: unknown,
  assertCurrent: () => void,
): Promise<void> {
  const plugin = searchProviderPlugin(provider);
  const version = pluginVersion(gateway);
  let state = await verifiedRuntimeState(gateway, plugin.id, version, assertCurrent);
  if (state === "unloaded") {
    const application = object(
      await gateway.request(
        "plugins.reload",
        { plugins: [{ pluginId: plugin.id }], waitForDrain: true },
        300_000,
      ),
    );
    assertCurrent();
    assertLifecycleApplication(application, plugin.id);
    state = await verifiedRuntimeState(gateway, plugin.id, version, assertCurrent);
  }
  if (state !== "active")
    throw new Error("Web search plugin is not active (runtime state: unloaded)");
}
