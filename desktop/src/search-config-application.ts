import { isDeepStrictEqual } from "node:util";
import { MODEL_APPLY_SETTLE_TIMEOUT_MS } from "./constants";
import { assertModelConfigUnchanged } from "./model-setup";
import {
  assertSearchProviderPluginActive,
  ensureSearchProviderPlugin,
  searchProviderPlugin,
  type SearchProviderGateway,
} from "./search-provider-plugin";
import { validateWindowsNodeMxcGatewayPolicy } from "./windows-node-mxc";

type JsonObject = Record<string, unknown>;

interface Dependencies {
  gateway(): SearchProviderGateway | null;
  readConfig(): unknown;
  assertCurrent(): void;
  assertMxcReady(): Promise<void>;
  nodeId(): string;
  wait?(milliseconds: number): Promise<void>;
}

function object(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Gateway configuration is unavailable");
  return value as JsonObject;
}

function optionalObject(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

function objectOrEmpty(value: unknown): JsonObject {
  return value === undefined ? {} : object(value);
}

function searchConfig(value: unknown): JsonObject {
  return object(optionalObject(optionalObject(object(value).tools).web).search);
}

function searchKey(value: unknown, pluginId: string): unknown {
  const plugins = optionalObject(object(value).plugins);
  const entry = optionalObject(optionalObject(plugins.entries)[pluginId]);
  return optionalObject(optionalObject(entry.config).webSearch).apiKey;
}

function withoutTargetPluginChanges(
  value: unknown,
  expected: JsonObject,
  pluginId: string,
): JsonObject {
  const config = structuredClone(object(value));
  if (Object.hasOwn(config, "meta")) {
    const meta = object(config.meta);
    delete meta.lastTouchedVersion;
    if (Object.hasOwn(meta, "migrations")) {
      const migrations = object(meta.migrations);
      const expectedMigrations = optionalObject(optionalObject(expected.meta).migrations);
      for (const marker of ["modelPolicyAllowlist", "utilityModelSeparation"]) {
        if (!Object.hasOwn(expectedMigrations, marker) && migrations[marker] === true)
          delete migrations[marker];
      }
      if (
        !Object.hasOwn(optionalObject(expected.meta), "migrations") &&
        !Object.keys(migrations).length
      )
        delete meta.migrations;
    }
    if (!Object.hasOwn(expected, "meta") && Object.keys(meta).length === 0) delete config.meta;
  }
  if (!Object.hasOwn(config, "plugins")) return config;
  const plugins = object(config.plugins);
  const expectedPlugins = optionalObject(expected.plugins);
  for (const field of ["entries", "installs"]) {
    if (!Object.hasOwn(plugins, field)) continue;
    const records = object(plugins[field]);
    if (field === "installs") {
      delete records[pluginId];
    } else if (Object.hasOwn(records, pluginId)) {
      const entry = object(records[pluginId]);
      delete entry.enabled;
      if (Object.keys(entry).length === 0) delete records[pluginId];
    }
    if (!Object.hasOwn(expectedPlugins, field) && Object.keys(records).length === 0)
      delete plugins[field];
  }
  for (const field of ["allow", "deny"]) {
    if (!Object.hasOwn(plugins, field)) continue;
    if (!Array.isArray(plugins[field])) throw new Error("Gateway plugin policy is invalid");
    const remaining = plugins[field].filter((entry) => entry !== pluginId);
    if (!Object.hasOwn(expectedPlugins, field) && remaining.length === 0) delete plugins[field];
    else plugins[field] = remaining;
  }
  if (!Object.hasOwn(expected, "plugins") && Object.keys(plugins).length === 0)
    delete config.plugins;
  return config;
}

export async function applySearchConfig(
  deps: Dependencies,
  requested: unknown,
  expectedConfig: unknown,
): Promise<void> {
  const expected = object(expectedConfig);
  const search = structuredClone(searchConfig(requested));
  const plugin = searchProviderPlugin(search.provider);
  const keyProvided = Object.hasOwn(search, "apiKey");
  const apiKey = search.apiKey;
  if (
    keyProvided &&
    (search.provider === "parallel-free" || typeof apiKey !== "string" || !apiKey.trim())
  )
    throw new Error("The web search provider API key is invalid");
  delete search.apiKey;
  const matchesRequestedSearch = (config: unknown) =>
    isDeepStrictEqual(searchConfig(config), search) &&
    (!keyProvided || isDeepStrictEqual(searchKey(config, plugin.id), apiKey));
  const gateway = deps.gateway();
  if (
    !gateway?.connected ||
    !["config.get", "config.apply"].every((method) => gateway.methods.includes(method))
  )
    throw new Error("Applying web search settings requires a connected, supported Gateway");
  const generation = gateway.connectionGeneration;
  const assertCurrent = () => {
    deps.assertCurrent();
    if (
      deps.gateway() !== gateway ||
      !gateway.connected ||
      gateway.connectionGeneration !== generation
    )
      throw new Error("Gateway connection changed; reload search settings before retrying");
  };
  const snapshot = async () => {
    const value = object(await gateway.request("config.get", {}));
    assertCurrent();
    if (value.valid !== true || typeof value.hash !== "string" || !value.hash)
      throw new Error("The Gateway configuration is unavailable or invalid");
    return value;
  };

  assertCurrent();
  assertModelConfigUnchanged(expected, deps.readConfig());
  const before = await snapshot();
  assertModelConfigUnchanged(expected, deps.readConfig());
  const reload = optionalObject(optionalObject(optionalObject(before.config).gateway).reload).mode;
  if (reload === "off" || reload === "restart")
    throw new Error("Web search settings require configuration hot reload; no restart attempted");

  await ensureSearchProviderPlugin(gateway, search.provider, assertCurrent);
  const current = object(deps.readConfig());
  if (
    !isDeepStrictEqual(
      withoutTargetPluginChanges(current, expected, plugin.id),
      withoutTargetPluginChanges(expected, expected, plugin.id),
    )
  )
    throw new Error("Gateway configuration changed during plugin setup; reload search settings");
  const policy = validateWindowsNodeMxcGatewayPolicy(current, deps.nodeId(), "active");
  if (!policy.ready)
    throw new Error(`Gateway command routing is not ready: ${policy.blockers.join("; ")}`);
  const currentSnapshot = await snapshot();
  assertModelConfigUnchanged(current, deps.readConfig());
  const tools = optionalObject(current.tools);
  const requestedWeb = optionalObject(optionalObject(object(requested).tools).web);
  const web: JsonObject = { ...optionalObject(tools.web), search };
  if (Object.hasOwn(requestedWeb, "searchProviders"))
    web.searchProviders = structuredClone(requestedWeb.searchProviders);
  else delete web.searchProviders;
  const target: JsonObject = {
    ...current,
    tools: { ...tools, web },
  };
  if (keyProvided) {
    const plugins = objectOrEmpty(current.plugins);
    const entries = objectOrEmpty(plugins.entries);
    const entry = objectOrEmpty(entries[plugin.id]);
    const pluginConfig = objectOrEmpty(entry.config);
    const webSearch = objectOrEmpty(pluginConfig.webSearch);
    target.plugins = {
      ...plugins,
      entries: {
        ...entries,
        [plugin.id]: {
          ...entry,
          config: { ...pluginConfig, webSearch: { ...webSearch, apiKey } },
        },
      },
    };
  }
  let result: JsonObject;
  try {
    result = object(
      await gateway.request(
        "config.apply",
        {
          baseHash: currentSnapshot.hash,
          raw: JSON.stringify(target),
          note: "Web search settings",
        },
        MODEL_APPLY_SETTLE_TIMEOUT_MS,
      ),
    );
    assertCurrent();
    if (result.ok !== true || typeof result.hash !== "string" || !result.hash)
      throw new Error("Saved web search settings could not be confirmed");
    if (
      optionalObject(optionalObject(optionalObject(result.sentinel).payload).stats)
        .requiresRestart === true
    )
      throw new Error("The Gateway reported that web search settings require a restart");
    const deadline = Date.now() + MODEL_APPLY_SETTLE_TIMEOUT_MS;
    while (true) {
      const applied = await snapshot();
      if (applied.hash !== result.hash)
        throw new Error("Web search settings changed while being applied");
      if (
        typeof applied.configRevisionHash === "string" &&
        applied.configRevisionHash &&
        applied.appliedConfigHash === applied.configRevisionHash &&
        matchesRequestedSearch(deps.readConfig())
      )
        break;
      if (Date.now() >= deadline) throw new Error("Web search settings are still being applied");
      await (deps.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms))))(500);
      assertCurrent();
    }
    if (search.enabled !== false)
      await assertSearchProviderPluginActive(gateway, search.provider, assertCurrent);
    await deps.assertMxcReady();
    const confirmed = await snapshot();
    if (confirmed.hash !== result.hash || !matchesRequestedSearch(deps.readConfig()))
      throw new Error("Web search settings changed while the provider was being activated");
  } catch (cause) {
    throw new Error(
      "Web search settings could not be confirmed. They may have been saved; reload settings before retrying.",
      { cause },
    );
  }
}
