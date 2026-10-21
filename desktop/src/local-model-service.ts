import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { MODEL_APPLY_SETTLE_TIMEOUT_MS } from "./constants";
import { waitForDefaultModelApplied } from "./model-setup";
import { isLoopbackAddress } from "./model-connection";
import { inspectLocalModelFiles, inspectManagedLocalModelCache } from "./local-model-files";
import {
  isManagedLocalModel,
  LOCAL_MODEL_PRESETS,
  LOCAL_MODEL_SELECTION_PROMPT,
  LOCAL_MODEL_DOWNLOAD_PROMPT,
} from "./local-model-catalog";
import type {
  LocalModelCapabilities,
  LocalModelCandidate,
  LocalModelChoice,
  LocalModelDetection,
  LocalModelInstallReview,
  LocalModelOperation,
  LocalModelReceipt,
  LocalModelStep,
  LocalModelSnapshot,
} from "./local-model-types";

type JsonObject = Record<string, unknown>;

export interface LocalModelGateway {
  connected: boolean;
  serverVersion: string | null;
  connectionGeneration?: number;
  methods: readonly string[];
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number | null): Promise<T>;
}

interface LocalModelDependencies {
  gateway(): LocalModelGateway | null;
  identity(): string;
  assertMutable(): void;
  readConfig(): unknown;
  stateDir?(): string;
  readReceipt(): LocalModelReceipt | undefined;
  saveReceipt(receipt: LocalModelReceipt | null): void;
  restartGateway(): Promise<void>;
  onChange(operation: LocalModelOperation): void;
}

const PROVIDER = "llama-cpp";
const PREFIX = `${PROVIDER}/`;
export const LOCAL_MODEL_PLUGIN_PACKAGE = "@openclaw/llama-cpp-provider";
export const LOCAL_MODEL_PLUGIN_VERSION = "2026.9.3";
const METHODS = [
  "plugins.list",
  "plugins.inspect",
  "agents.list",
  "openclaw.setup.detect",
  "openclaw.setup.prepare.start",
  "config.get",
  "config.patch",
  "wizard.next",
  "wizard.cancel",
];
const NEXT_TIMEOUT_MS = 180_000;
const START_NOTICE_MS = 30_000;
export const LOCAL_MODEL_APPLY_SETTLE_TIMEOUT_MS = MODEL_APPLY_SETTLE_TIMEOUT_MS;
export const LOCAL_MODEL_DETECTION_TTL_MS = 60_000;

class ModelApplicationPendingError extends Error {}

interface DetectionContext {
  gateway: LocalModelGateway;
  key: string;
}

function record(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid response from the local model provider");
  }
  return value as JsonObject;
}

function optionalRecord(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? record(value) : {};
}

function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 16_384) {
    throw new Error("Missing or invalid local model identifier");
  }
  return value;
}

function rows(value: unknown): JsonObject[] {
  if (!Array.isArray(value)) throw new Error("Invalid local model catalog");
  return value.map(record);
}

function choice(value: unknown): LocalModelChoice {
  if (value === PROVIDER || value === "llama-cpp-existing-server") return value;
  throw new Error("Unsupported local model setup choice");
}

function localProvider(config: unknown): JsonObject {
  return optionalRecord(
    optionalRecord(optionalRecord(optionalRecord(config).models).providers)[PROVIDER],
  );
}

function configuredPrimary(config: unknown): string | undefined {
  const agents = optionalRecord(optionalRecord(config).agents);
  const entries = optionalRecord(agents.entries);
  const roster =
    Object.keys(entries).length > 0
      ? Object.values(entries)
      : Array.isArray(agents.list)
        ? agents.list
        : [];
  const owner = roster.find((entry) => optionalRecord(entry).default === true) ?? roster[0];
  const model = optionalRecord(owner).model ?? optionalRecord(agents.defaults).model;
  const primary = typeof model === "string" ? model : optionalRecord(model).primary;
  return typeof primary === "string" && primary.trim() ? primary : undefined;
}

export function hasLocalModelPrimary(config: unknown): boolean {
  return configuredPrimary(config)?.startsWith(PREFIX) === true;
}

function selectedDefault(config: unknown): string | undefined {
  const value = optionalRecord(optionalRecord(optionalRecord(config).agents).defaults).model;
  const primary = typeof value === "string" ? value : optionalRecord(value).primary;
  return typeof primary === "string" ? primary : undefined;
}

export function buildLocalModelSelectionPatch(config: unknown, modelRef: string): JsonObject {
  const provider = localProvider(config);
  const models = Array.isArray(provider.models) ? rows(provider.models) : [];
  if (
    !modelRef.startsWith(PREFIX) ||
    !models.some((model) => `${PREFIX}${model.id}` === modelRef)
  ) {
    throw new Error("The selected local model is not configured; prepare it first");
  }
  validateLocalModelUrl(provider.baseUrl);
  const defaults = optionalRecord(optionalRecord(optionalRecord(config).agents).defaults);
  const allowed = optionalRecord(defaults.models);
  return {
    agents: {
      defaults: {
        model: { primary: modelRef },
        ...(Object.keys(allowed).length > 0 && !Object.hasOwn(allowed, modelRef)
          ? { models: { [modelRef]: {} } }
          : {}),
      },
    },
  };
}

export function validateLocalModelUrl(value: unknown): string {
  const url = new URL(text(value).trim());
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username ||
    url.password ||
    (url.hostname !== "localhost" && !isLoopbackAddress(url.hostname))
  ) {
    throw new Error("Local model setup only accepts http(s) endpoints on localhost or loopback");
  }
  return url.toString();
}

export function supportsLocalModelVersion(version: string | null, minimumPatch = 3): boolean {
  const match = /^2026\.9\.(\d+)(?:\+[a-zA-Z0-9.-]+)?$/.exec(version ?? "");
  return Boolean(match && Number(match[1]) >= minimumPatch);
}

export function supportsLocalModelGatewayVersion(version: string | null): boolean {
  return (
    supportsLocalModelVersion(version) ||
    /^2026\.10\.(?:2|3)(?:\+[a-zA-Z0-9.-]+)?$/.test(version ?? "")
  );
}

export class LocalModelService {
  private operation: LocalModelOperation | null = null;
  private receipt: LocalModelReceipt | null = null;
  private driving = false;
  private driveGeneration = 0;
  private awaitingStart = false;
  private mutationPending = false;
  private secrets = new Set<string>();
  private reviewedToken: string | undefined;
  private pendingReview: LocalModelInstallReview | undefined;
  private installRequest: JsonObject | undefined;
  private externalEndpointPending = false;
  private detectionRevision = 0;
  private detectionCache?: DetectionContext & { expiresAt: number; value: LocalModelDetection };
  private detectionRequest?: DetectionContext & { promise: Promise<LocalModelDetection> };

  constructor(private readonly deps: LocalModelDependencies) {
    const receipt = deps.readReceipt();
    if (receipt) {
      this.receipt = receipt;
      this.operation = {
        id: receipt.id,
        kind: receipt.kind,
        agentId: receipt.agentId,
        authChoice: receipt.authChoice,
        modelRef: receipt.modelRef,
        phase: "interrupted",
        cancellationPending: false,
        busy: true,
      };
      this.externalEndpointPending =
        receipt.authChoice === "llama-cpp-existing-server" && !receipt.approvedEndpoint;
    }
  }

  get busy(): boolean {
    return this.driving || this.mutationPending || Boolean(this.operation?.busy);
  }

  get blocksChat(): boolean {
    return (
      this.mutationPending || Boolean(this.operation?.busy && this.operation.kind === "activate")
    );
  }

  assertChatAllowed(): void {
    if (this.blocksChat) throw new Error("A model change is being applied; wait for it to finish");
  }

  assertIdle(): void {
    if (this.busy) throw new Error("A local model setup operation is still active");
  }

  getOperation(): LocalModelOperation | null {
    return this.operation ? structuredClone(this.operation) : null;
  }

  getSnapshot(): LocalModelSnapshot {
    const config = this.deps.readConfig();
    const provider = localProvider(config);
    const models = Array.isArray(provider.models) ? rows(provider.models) : [];
    const configuredModel = configuredPrimary(config);
    const files = inspectLocalModelFiles(provider);
    const cache = this.deps.stateDir
      ? inspectManagedLocalModelCache(provider, this.deps.stateDir())
      : undefined;
    return {
      models: models
        .filter((model) => typeof model.id === "string" && model.id.trim())
        .map((model) => ({
          modelRef: `${PREFIX}${text(model.id)}`,
          name: typeof model.name === "string" && model.name.trim() ? model.name : text(model.id),
          fileStatus: files.get(text(model.id)) ?? "unknown",
        })),
      ...(configuredModel ? { configuredModel } : {}),
      catalog: LOCAL_MODEL_PRESETS.map((preset) => {
        const id = preset.modelRef.slice(PREFIX.length);
        const configured = models.some((model) => model.id === id);
        const status = configured ? (files.get(id) ?? "unknown") : "not-downloaded";
        return {
          modelRef: preset.modelRef,
          name: preset.name,
          downloadBytes: preset.downloadBytes,
          preferred: preset.preferred,
          configured,
          fileStatus:
            status === "present" || status === "external"
              ? status
              : cache?.get(preset.modelRef) === "present"
                ? "present"
                : cache?.get(preset.modelRef) === "unknown"
                  ? "unknown"
                  : status,
        };
      }),
    };
  }

  errorMessage(error: unknown): string {
    let message = error instanceof Error ? error.message : String(error);
    for (const secret of this.secrets) message = message.split(secret).join("[redacted]");
    return message.slice(0, 16_384);
  }

  private gateway(): LocalModelGateway {
    const gateway = this.deps.gateway();
    if (!gateway?.connected) throw new Error("Gateway is not connected");
    return gateway;
  }

  private publish(update: Partial<LocalModelOperation>): void {
    if (!this.operation) return;
    Object.assign(this.operation, update);
    this.deps.onChange(structuredClone(this.operation));
  }

  private finish(update: Partial<LocalModelOperation>): void {
    this.invalidateDetection();
    this.deps.saveReceipt(null);
    this.receipt = null;
    this.publish({
      step: undefined,
      busy: false,
      cancellationPending: false,
      error: undefined,
      ...update,
    });
  }

  private checkEndpoint(): void {
    const provider = localProvider(this.deps.readConfig());
    if (provider.baseUrl) validateLocalModelUrl(provider.baseUrl);
  }

  private async defaultAgent(gateway = this.gateway()): Promise<string> {
    return text(record(await gateway.request("agents.list", {})).defaultId);
  }

  private async setupAgent(requested: unknown): Promise<string> {
    const config = optionalRecord(this.deps.readConfig());
    const agents = optionalRecord(config.agents);
    const entries = optionalRecord(agents.entries);
    let roster: Array<{ id: string; default?: unknown }> = Object.keys(entries).map((id) => ({
      ...optionalRecord(entries[id]),
      id,
    }));
    if (!roster.length && Array.isArray(agents.list))
      roster = rows(agents.list).map((agent) => ({ ...agent, id: text(agent.id) }));
    if (!roster.length) {
      const result = record(await this.gateway().request("agents.list", {}));
      roster = rows(result.agents).map((agent) => ({ ...agent, id: text(agent.id) }));
    }
    const configuredOwner = optionalRecord(optionalRecord(agents.defaults).systemAgent).agentId;
    const defaults = roster.filter((agent) => agent.default === true);
    const id =
      requested !== undefined
        ? text(requested)
        : typeof configuredOwner === "string"
          ? configuredOwner
          : defaults.length === 1
            ? defaults[0].id
            : roster.length === 1
              ? roster[0].id
              : undefined;
    if (!id || !roster.some((agent) => agent.id === id)) {
      throw new Error(
        "Select a configured agent explicitly before preparing a local model; the operation has no unambiguous owner.",
      );
    }
    return id;
  }

  async getCapabilities(resolveInstallSource = false): Promise<LocalModelCapabilities> {
    const gateway = this.deps.gateway();
    const blockers: string[] = [];
    let mutable = true;
    try {
      this.deps.assertMutable();
    } catch (error) {
      mutable = false;
      blockers.push(this.errorMessage(error));
    }
    if (!gateway?.connected) {
      return {
        gatewayVersion: null,
        supported: false,
        mutable: false,
        blockers: [...blockers, "Gateway is not connected"],
        plugin: { installed: false, enabled: false, canInstall: false },
      };
    }
    const versionSupported = supportsLocalModelGatewayVersion(gateway.serverVersion);
    if (!versionSupported) {
      blockers.push(
        "Local setup requires OpenClaw 2026.10.2, 2026.10.3 or a supported 2026.9.3+ (2026.9.x) Gateway",
      );
    }
    const missing = METHODS.filter((method) => !gateway.methods.includes(method));
    if (missing.length)
      blockers.push(`Gateway is missing local setup methods: ${missing.join(", ")}`);
    let plugin = {
      installed: false,
      enabled: false,
      canInstall: false,
      version: undefined as string | undefined,
    };
    let pluginError = false;
    this.installRequest = undefined;
    if (gateway.methods.includes("plugins.list")) {
      const catalog = record(await gateway.request("plugins.list", {}));
      const entry = rows(catalog.plugins).find((entry) => entry.id === PROVIDER);
      if (catalog.mutationAllowed === false) {
        mutable = false;
        blockers.push("The Gateway does not allow plugin or model configuration changes");
      }
      if (entry) {
        const install = optionalRecord(entry.install);
        plugin = {
          installed: entry.installed === true,
          enabled: entry.enabled === true,
          version: typeof entry.version === "string" ? entry.version : undefined,
          canInstall:
            mutable &&
            gateway.methods.includes("plugins.install") &&
            install.source === "official" &&
            install.pluginId === PROVIDER,
        };
        if (plugin.canInstall) this.installRequest = { source: "official", pluginId: PROVIDER };
        if (plugin.installed && !supportsLocalModelVersion(plugin.version ?? null)) {
          blockers.push(
            "The installed llama.cpp provider version is not supported (requires 2026.9.3+ in 2026.9.x)",
          );
        }
        pluginError = entry.state === "error" || entry.origin === "workspace";
        if (pluginError) blockers.push("The llama.cpp provider reported an error");
      }
    }
    if (
      !plugin.installed &&
      !plugin.canInstall &&
      mutable &&
      resolveInstallSource &&
      gateway.methods.includes("plugins.search") &&
      gateway.methods.includes("plugins.install")
    ) {
      const search = record(
        await gateway.request("plugins.search", { query: LOCAL_MODEL_PLUGIN_PACKAGE, limit: 5 }),
      );
      const official = rows(search.results).some((entry) => {
        const pkg = record(entry.package);
        return (
          pkg.name === LOCAL_MODEL_PLUGIN_PACKAGE &&
          pkg.runtimeId === PROVIDER &&
          pkg.isOfficial === true &&
          pkg.channel === "official" &&
          pkg.family === "code-plugin"
        );
      });
      if (official) {
        this.installRequest = {
          source: "clawhub",
          packageName: LOCAL_MODEL_PLUGIN_PACKAGE,
          version: LOCAL_MODEL_PLUGIN_VERSION,
        };
        plugin = { ...plugin, canInstall: true, version: LOCAL_MODEL_PLUGIN_VERSION };
      }
    }
    if (!resolveInstallSource && !plugin.installed && !plugin.canInstall) {
      plugin.canInstall =
        mutable &&
        gateway.methods.includes("plugins.search") &&
        gateway.methods.includes("plugins.install");
    }
    if (!plugin.installed && !plugin.canInstall) {
      blockers.push(
        "The official llama.cpp provider is not installed and no official installation source is available",
      );
    }
    return {
      gatewayVersion: gateway.serverVersion,
      supported:
        versionSupported &&
        missing.length === 0 &&
        !pluginError &&
        (!plugin.installed || supportsLocalModelVersion(plugin.version ?? null)),
      mutable,
      blockers,
      plugin,
    };
  }

  private async requireReady(): Promise<LocalModelGateway> {
    this.deps.assertMutable();
    const capabilities = await this.getCapabilities();
    if (!capabilities.supported || !capabilities.mutable) {
      throw new Error(capabilities.blockers.join("\n") || "Local model setup is unavailable");
    }
    if (!capabilities.plugin.installed || !capabilities.plugin.enabled) {
      throw new Error("Install and enable the official llama.cpp provider first");
    }
    this.checkEndpoint();
    return this.gateway();
  }

  private detectionContext(): DetectionContext {
    const gateway = this.gateway();
    const key = createHash("sha256")
      .update(
        JSON.stringify({
          identity: this.deps.identity(),
          version: gateway.serverVersion,
          generation: gateway.connectionGeneration ?? 0,
          methods: gateway.methods,
          config: this.deps.readConfig(),
          revision: this.detectionRevision,
        }),
      )
      .digest("hex");
    return { gateway, key };
  }

  private assertDetectionCurrent(context: DetectionContext): void {
    const current = this.detectionContext();
    if (current.gateway !== context.gateway || current.key !== context.key) {
      throw new Error("Model configuration changed during discovery; refresh and try again");
    }
  }

  private invalidateDetection(): void {
    this.detectionRevision++;
    this.detectionCache = undefined;
    this.detectionRequest = undefined;
  }

  async detect(options?: { refresh?: boolean }): Promise<LocalModelDetection> {
    this.checkEndpoint();
    if (options?.refresh) this.detectionCache = undefined;
    const context = this.detectionContext();
    const cached = this.detectionCache;
    if (
      !options?.refresh &&
      cached?.gateway === context.gateway &&
      cached.key === context.key &&
      cached.expiresAt > Date.now()
    ) {
      return structuredClone(cached.value);
    }
    const inFlight = this.detectionRequest;
    if (inFlight?.gateway === context.gateway && inFlight.key === context.key) {
      return structuredClone(await inFlight.promise);
    }
    const promise = this.discover(context).then((value) => {
      this.assertDetectionCurrent(context);
      this.detectionCache = {
        ...context,
        value,
        expiresAt: Date.now() + LOCAL_MODEL_DETECTION_TTL_MS,
      };
      return value;
    });
    const request = { ...context, promise };
    this.detectionRequest = request;
    try {
      return structuredClone(await promise);
    } finally {
      if (this.detectionRequest === request) this.detectionRequest = undefined;
    }
  }

  private async discover(context: DetectionContext): Promise<LocalModelDetection> {
    const { gateway } = context;
    const agentId = await this.defaultAgent(gateway);
    this.assertDetectionCurrent(context);
    const result = record(
      await gateway.request("openclaw.setup.detect", { agentId }, NEXT_TIMEOUT_MS),
    );
    const options = Array.isArray(result.prepareOptions) ? rows(result.prepareOptions) : [];
    const candidates: LocalModelCandidate[] = rows(result.candidates)
      .filter(
        (candidate) =>
          typeof candidate.modelRef === "string" &&
          candidate.modelRef.startsWith(PREFIX) &&
          (candidate.kind === "provider-auto:llama-cpp" ||
            candidate.kind === "provider-auto:llama-cpp-existing-server" ||
            candidate.kind === "existing-model"),
      )
      .map((candidate) => ({
        kind: text(candidate.kind),
        modelRef: text(candidate.modelRef),
        label: text(candidate.label),
        detail: typeof candidate.detail === "string" ? candidate.detail : "",
        recommended: candidate.recommended === true,
      }));
    return {
      agentId,
      choices: options
        .filter((option) => option.id === PROVIDER || option.id === "llama-cpp-existing-server")
        .map((option) => ({
          id: choice(option.id),
          label: text(option.label),
          ...(typeof option.hint === "string" ? { hint: option.hint } : {}),
        })),
      candidates,
      ...(typeof result.configuredModel === "string"
        ? { configuredModel: result.configuredModel }
        : {}),
    };
  }

  async inspectProvider(): Promise<LocalModelInstallReview> {
    if (this.pendingReview) {
      this.reviewedToken = this.pendingReview.reviewToken;
      return structuredClone(this.pendingReview);
    }
    const status = await this.getCapabilities(true);
    if (!status.plugin.installed && this.installRequest?.source === "clawhub") {
      this.reviewedToken = undefined;
      return {
        pluginId: PROVIDER,
        version: LOCAL_MODEL_PLUGIN_VERSION,
        source: `ClawHub official: ${LOCAL_MODEL_PLUGIN_PACKAGE}@${LOCAL_MODEL_PLUGIN_VERSION}`,
        capabilities: {},
      };
    }
    const result = record(await this.gateway().request("plugins.inspect", { pluginId: PROVIDER }));
    const plugin = record(result.plugin);
    if (plugin.id !== PROVIDER) throw new Error("Unexpected plugin identity");
    const source = optionalRecord(result.source);
    const declared = record(result.declared);
    const capabilities = Object.fromEntries(
      Object.entries(declared).map(([key, value]) => {
        if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
          throw new Error("Invalid plugin capability review");
        }
        return [key, value as string[]];
      }),
    );
    this.reviewedToken = typeof result.reviewToken === "string" ? result.reviewToken : undefined;
    return {
      pluginId: PROVIDER,
      version: typeof plugin.version === "string" ? plugin.version : undefined,
      source: typeof source.kind === "string" ? source.kind : "official",
      capabilities,
      reviewToken: this.reviewedToken,
    };
  }

  async installProvider(input: unknown): Promise<LocalModelCapabilities> {
    const params = record(input);
    if (params.confirmed !== true)
      throw new Error("Explicit plugin installation consent is required");
    if (params.reviewToken !== undefined && params.reviewToken !== this.reviewedToken) {
      throw new Error("The plugin capability review has changed; review it again");
    }
    this.assertIdle();
    this.deps.assertMutable();
    this.mutationPending = true;
    this.invalidateDetection();
    try {
      const capabilities = await this.getCapabilities(true);
      if (!capabilities.supported || !capabilities.mutable) {
        throw new Error(capabilities.blockers.join("\n"));
      }
      const gateway = this.gateway();
      if (!capabilities.plugin.installed && !capabilities.plugin.canInstall) {
        throw new Error("No compatible official llama.cpp install is offered by this Gateway");
      }
      if (capabilities.plugin.installed && capabilities.plugin.enabled) return capabilities;
      const acknowledgeCapabilities =
        params.reviewToken !== undefined
          ? { acknowledgeCapabilities: { reviewToken: text(params.reviewToken) } }
          : {};
      const result = record(
        await gateway.request(
          capabilities.plugin.installed ? "plugins.setEnabled" : "plugins.install",
          capabilities.plugin.installed
            ? { pluginId: PROVIDER, enabled: true, ...acknowledgeCapabilities }
            : { ...this.installRequest, ...acknowledgeCapabilities },
          300_000,
        ),
      );
      if (result.ok !== true)
        throw new Error("The official plugin could not be installed or enabled");
      if (result.restartRequired === true) await this.deps.restartGateway();
      this.reviewedToken = undefined;
      this.pendingReview = undefined;
      return await this.getCapabilities();
    } catch (error) {
      const details = optionalRecord(optionalRecord(error).details);
      if (
        details.capabilityConsentCode === "PLUGIN_CAPABILITY_CONSENT_REQUIRED" &&
        details.pluginId === PROVIDER &&
        typeof details.reviewToken === "string"
      ) {
        const widened = optionalRecord(details.widened);
        this.pendingReview = {
          pluginId: PROVIDER,
          version: LOCAL_MODEL_PLUGIN_VERSION,
          source: "Official llama.cpp provider (staged capability review)",
          capabilities: Object.fromEntries(
            Object.entries(widened).map(([key, value]) => [
              key,
              Array.isArray(value)
                ? value.filter((entry): entry is string => typeof entry === "string")
                : [],
            ]),
          ),
          reviewToken: details.reviewToken,
        };
        throw new Error(
          "Plugin capability review is required. Review the provider again before confirming installation.",
          { cause: error },
        );
      }
      throw error;
    } finally {
      this.invalidateDetection();
      this.mutationPending = false;
    }
  }

  async prepare(input: unknown): Promise<LocalModelOperation> {
    const params = record(input);
    const authChoice = choice(params.authChoice);
    const modelRef =
      authChoice === PROVIDER
        ? params.modelRef === undefined
          ? LOCAL_MODEL_PRESETS[0].modelRef
          : text(params.modelRef)
        : undefined;
    if (modelRef && !isManagedLocalModel(modelRef))
      throw new Error("Only the managed Qwen3.5 4B and 9B presets can be prepared");
    this.assertIdle();
    this.mutationPending = true;
    try {
      await this.requireReady();
      const agentId = await this.setupAgent(params.agentId);
      if (modelRef) {
        const provider = localProvider(this.deps.readConfig());
        if (!provider.localService && Array.isArray(provider.models) && provider.models.length) {
          throw new Error(
            "Remove the existing external llama.cpp connection before preparing managed models",
          );
        }
      }
      this.deps.assertMutable();
      this.externalEndpointPending = authChoice === "llama-cpp-existing-server";
      return this.start(
        { kind: "prepare", agentId, authChoice, ...(modelRef ? { modelRef } : {}) },
        "openclaw.setup.prepare.start",
        { authChoice, agentId },
      );
    } finally {
      this.mutationPending = false;
    }
  }

  async activate(input: unknown): Promise<LocalModelOperation> {
    const params = record(input);
    const modelRef = text(params.modelRef);
    const kind = text(params.kind);
    if (!modelRef.startsWith(PREFIX))
      throw new Error("Only llama.cpp model selection is allowed here");
    if (
      kind !== "existing-model" &&
      kind !== "provider-auto:llama-cpp" &&
      kind !== "provider-auto:llama-cpp-existing-server"
    ) {
      throw new Error("Unsupported local model selection route");
    }
    this.assertIdle();
    this.mutationPending = true;
    try {
      await this.requireReady();
      const context = this.detectionContext();
      const agentId = await this.defaultAgent(context.gateway);
      const snapshot = record(await context.gateway.request("config.get", {}));
      if (snapshot.valid !== true) throw new Error("The Gateway configuration is invalid");
      const patch = buildLocalModelSelectionPatch(snapshot.config, modelRef);
      this.assertModelFilesPresent(snapshot.config, modelRef);
      const baseHash = text(snapshot.hash);
      this.assertDetectionCurrent(context);
      this.deps.assertMutable();
      const receipt: LocalModelReceipt = {
        id: randomUUID(),
        kind: "activate",
        agentId,
        modelRef,
        gatewayIdentity: this.deps.identity(),
        configSelection: true,
      };
      this.deps.saveReceipt(receipt);
      this.receipt = receipt;
      this.invalidateDetection();
      this.operation = {
        id: receipt.id,
        kind: "activate",
        agentId,
        modelRef,
        phase: "applying",
        busy: true,
        cancellationPending: false,
      };
      this.publish({});
      this.drive(async (gateway) => {
        this.deps.assertMutable();
        this.assertModelFilesPresent(this.deps.readConfig(), modelRef);
        const result = record(
          await gateway.request(
            "config.patch",
            {
              raw: JSON.stringify(patch),
              baseHash,
            },
            NEXT_TIMEOUT_MS,
          ),
        );
        if (result.ok !== true) throw new Error("The model selection could not be saved");
        if (selectedDefault(result.config) !== modelRef) {
          throw new Error("The saved model does not match the selected model");
        }
        const stats = optionalRecord(optionalRecord(optionalRecord(result.sentinel).payload).stats);
        if (stats.requiresRestart === true) await this.deps.restartGateway();
        await this.waitForSelectionApplied(modelRef);
        this.finish({ phase: "ready", modelRef });
      });
      return this.getOperation()!;
    } finally {
      this.mutationPending = false;
    }
  }

  private assertModelFilesPresent(config: unknown, modelRef: string): void {
    const files = inspectLocalModelFiles(localProvider(config));
    if (files.get(modelRef.slice(PREFIX.length)) === "missing") {
      throw new Error(
        "The local model files are missing. Download the model again before using it.",
      );
    }
  }

  private start(
    target: Pick<LocalModelReceipt, "kind" | "agentId" | "authChoice" | "modelRef">,
    method: string,
    params: JsonObject,
  ): LocalModelOperation {
    this.invalidateDetection();
    const receipt: LocalModelReceipt = {
      ...target,
      id: randomUUID(),
      gatewayIdentity: this.deps.identity(),
    };
    this.deps.saveReceipt(receipt);
    this.receipt = receipt;
    this.operation = {
      ...target,
      id: receipt.id,
      phase: target.kind === "prepare" ? "starting" : "activating",
      busy: true,
      cancellationPending: false,
    };
    this.secrets.clear();
    this.publish({});
    // Preparation names its owner explicitly; default selection remains a separate operation.
    this.drive(async (gateway, isCurrent) => {
      this.awaitingStart = true;
      const notice = setTimeout(() => {
        if (isCurrent())
          this.publish({
            phase: "interrupted",
            error:
              "Still waiting for setup admission; resume or cancel this operation instead of starting another",
          });
      }, START_NOTICE_MS);
      try {
        const result = await gateway.request(method, { sessionId: receipt.id, ...params }, null);
        clearTimeout(notice);
        if (!isCurrent()) {
          if (
            record(result).done === false &&
            (this.operation?.id !== receipt.id || !this.operation.busy)
          ) {
            await gateway.request("wizard.cancel", { sessionId: receipt.id });
          }
          return;
        }
        this.awaitingStart = false;
        await this.consume(result, gateway, isCurrent);
      } finally {
        clearTimeout(notice);
      }
    });
    return this.getOperation()!;
  }

  private drive(
    run: (gateway: LocalModelGateway, isCurrent: () => boolean) => Promise<void>,
  ): void {
    if (this.driving) throw new Error("A wizard request is already in progress");
    const generation = ++this.driveGeneration;
    const isCurrent = () => generation === this.driveGeneration;
    this.driving = true;
    void Promise.resolve()
      .then(() => {
        if (this.receipt?.gatewayIdentity !== this.deps.identity()) {
          throw new Error("The Gateway identity changed; review the model configuration");
        }
        return run(this.gateway(), isCurrent);
      })
      .catch((error: unknown) => {
        if (!isCurrent()) {
          console.warn(`[local-model] Retired request cleanup: ${this.errorMessage(error)}`);
          return;
        }
        if (!this.operation?.busy) return;
        const message = this.errorMessage(error);
        if (
          error instanceof ModelApplicationPendingError ||
          (this.receipt?.configSelection && optionalRecord(error).code === "UNAVAILABLE")
        ) {
          this.publish({ phase: "interrupted", step: undefined, error: message });
          return;
        }
        const disconnected =
          !this.deps.gateway()?.connected ||
          /disconnect|timed out|not connected|client stopped/i.test(message);
        if (disconnected) {
          this.publish({ phase: "interrupted", step: undefined, error: message });
        } else {
          this.finish({
            phase: "error",
            error: `${message}\nReview the saved model configuration before retrying; preparation may have persisted changes.`,
          });
        }
      })
      .finally(() => {
        if (isCurrent()) {
          this.driving = false;
          this.awaitingStart = false;
        }
      });
  }

  private async consume(
    initial: unknown,
    gateway: LocalModelGateway,
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    let raw = initial;
    while (isCurrent() && this.operation?.busy && this.receipt) {
      const result = record(raw);
      if (result.done === true) {
        if (result.status === "cancelled") {
          this.finish({ phase: "cancelled" });
        } else if (result.status === "error") {
          const rejected =
            optionalRecord(result.activationRejection).disposition === "rejected-before-promotion";
          this.finish({
            phase: "error",
            rejectedBeforePromotion: rejected,
            error:
              this.errorMessage(result.error ?? "Local model setup failed") +
              (rejected
                ? ""
                : "\nChanges may already be saved; review the current model before retrying."),
          });
        } else if (result.status === "done") {
          if (this.operation.kind === "prepare") {
            const preparedModelRef =
              typeof result.preparedModelRef === "string" ? result.preparedModelRef : undefined;
            if (preparedModelRef && !preparedModelRef.startsWith(PREFIX)) {
              throw new Error("The provider prepared an unexpected model");
            }
            if (
              this.receipt.modelRef &&
              (!this.receipt.exactModelSelected || preparedModelRef !== this.receipt.modelRef)
            ) {
              throw new Error(
                "Preparation did not return the exact selected model; no model selection was changed",
              );
            }
            this.finish({ phase: "prepared", preparedModelRef });
          } else {
            const activation = record(result.modelActivation);
            if (activation.modelRef !== this.operation.modelRef) {
              throw new Error("The verified model does not match the selected model");
            }
            if (
              activation.gatewayRestartRequired !== undefined &&
              typeof activation.gatewayRestartRequired !== "boolean"
            ) {
              throw new Error("Invalid Gateway restart requirement in the activation receipt");
            }
            // Resume a legacy receipt without starting another inference check.
            if (activation.gatewayRestartRequired === true) {
              this.publish({ phase: "applying", step: undefined });
              await this.deps.restartGateway();
            }
            await this.waitForSelectionApplied(text(activation.modelRef));
            this.finish({ phase: "ready", modelRef: text(activation.modelRef) });
          }
        } else {
          throw new Error("Unknown terminal local setup status");
        }
        return;
      }
      if (result.done !== false) throw new Error("Invalid local setup wizard response");
      if (this.operation.cancellationPending) {
        const cancellation = record(
          await gateway.request("wizard.cancel", { sessionId: this.receipt.id }),
        );
        if (cancellation.status === "cancelled") {
          this.finish({ phase: "cancelled" });
          return;
        }
      }
      if (result.step !== undefined) {
        const step = this.parseStep(result.step);
        if (
          this.operation.kind === "prepare" &&
          this.receipt.authChoice === PROVIDER &&
          this.receipt.modelRef
        ) {
          if (step.type === "select" && step.message === LOCAL_MODEL_SELECTION_PROMPT) {
            if (
              step.options?.length !== LOCAL_MODEL_PRESETS.length ||
              !LOCAL_MODEL_PRESETS.every((preset) =>
                step.options?.some((option) => option.value === preset.modelRef),
              )
            ) {
              await gateway.request("wizard.cancel", { sessionId: this.receipt.id });
              throw new Error("The provider's exact-model selection options changed");
            }
            this.receipt.exactModelSelected = true;
            this.deps.saveReceipt(this.receipt);
            raw = await gateway.request(
              "wizard.next",
              {
                sessionId: this.receipt.id,
                answer: { stepId: step.id, value: this.receipt.modelRef },
              },
              NEXT_TIMEOUT_MS,
            );
            continue;
          }
          if (step.type === "confirm") {
            if (
              !this.receipt.exactModelSelected ||
              !step.message?.startsWith(`${LOCAL_MODEL_DOWNLOAD_PROMPT}\n`)
            ) {
              await gateway.request("wizard.cancel", { sessionId: this.receipt.id });
              throw new Error(
                "The provider cannot confirm the exact selected model. Update MicroClaw and the official provider before downloading.",
              );
            }
            try {
              const summary = record(
                JSON.parse(step.message.slice(LOCAL_MODEL_DOWNLOAD_PROMPT.length + 1)),
              );
              const preset = LOCAL_MODEL_PRESETS.find(
                (item) => item.modelRef === this.receipt!.modelRef,
              )!;
              if (
                summary.modelRef !== preset.modelRef ||
                typeof summary.modelName !== "string" ||
                typeof summary.modelBytes !== "number" ||
                typeof summary.embeddingBytes !== "number" ||
                typeof summary.runtimeDiskBytes !== "number" ||
                ![0, preset.downloadBytes].includes(Number(summary.modelBytes)) ||
                ![0, 328577056].includes(Number(summary.embeddingBytes)) ||
                ![0, 2 * 1024 ** 3, 3 * 1024 ** 3].includes(Number(summary.runtimeDiskBytes)) ||
                (summary.backend !== "cpu" &&
                  summary.backend !== "cuda" &&
                  summary.backend !== "metal") ||
                typeof summary.runtimeNote !== "string"
              )
                throw new Error("The exact-model download receipt is invalid");
              this.publish({
                download: {
                  modelRef: preset.modelRef,
                  modelName: summary.modelName,
                  modelBytes: Number(summary.modelBytes),
                  embeddingBytes: Number(summary.embeddingBytes),
                  runtimeDiskBytes: Number(summary.runtimeDiskBytes),
                  backend: summary.backend,
                  runtimeNote: summary.runtimeNote,
                },
              });
            } catch (cause) {
              await gateway.request("wizard.cancel", { sessionId: this.receipt.id });
              throw cause;
            }
          }
        }
        this.publish({
          phase: "step",
          step,
          error: typeof result.error === "string" ? this.errorMessage(result.error) : undefined,
        });
        if (step.executor !== "gateway" && step.type !== "progress") return;
      }
      raw = await gateway.request("wizard.next", { sessionId: this.receipt.id }, NEXT_TIMEOUT_MS);
    }
  }

  private async waitForSelectionApplied(modelRef: string): Promise<void> {
    this.publish({ phase: "applying", step: undefined, error: undefined });
    const applied = await waitForDefaultModelApplied(modelRef, () => {
      if (this.receipt?.gatewayIdentity !== this.deps.identity()) {
        throw new Error("The Gateway identity changed; reconnect to the original Gateway");
      }
      return this.gateway().request("config.get", {});
    });
    if (!applied) {
      throw new ModelApplicationPendingError(
        "The model settings are saved, but the Gateway is still applying them. Resume to check again; do not repeat model setup.",
      );
    }
  }

  private parseStep(value: unknown): LocalModelStep {
    const step = record(value);
    const type = step.type;
    if (
      type !== "note" &&
      type !== "select" &&
      type !== "text" &&
      type !== "confirm" &&
      type !== "multiselect" &&
      type !== "progress" &&
      type !== "action"
    ) {
      throw new Error("Unsupported local setup step; update MicroClaw before continuing");
    }
    return {
      id: text(step.id),
      type,
      ...(typeof step.title === "string" ? { title: this.errorMessage(step.title) } : {}),
      ...(typeof step.message === "string" ? { message: this.errorMessage(step.message) } : {}),
      ...(typeof step.placeholder === "string" ? { placeholder: step.placeholder } : {}),
      ...(step.sensitive === true ? { sensitive: true } : { initialValue: step.initialValue }),
      ...(step.executor === "gateway" || step.executor === "client"
        ? { executor: step.executor }
        : {}),
      ...(Array.isArray(step.options)
        ? {
            options: rows(step.options).map((option) => ({
              value: option.value,
              label: this.errorMessage(text(option.label)),
              ...(typeof option.hint === "string" ? { hint: this.errorMessage(option.hint) } : {}),
            })),
          }
        : {}),
    };
  }

  async answer(input: unknown): Promise<LocalModelOperation> {
    this.deps.assertMutable();
    const params = record(input);
    const operation = this.operation;
    const step = operation?.step;
    if (
      !operation?.busy ||
      operation.phase !== "step" ||
      !step ||
      params.operationId !== operation.id ||
      params.stepId !== step.id ||
      this.driving
    ) {
      throw new Error("This local setup step is no longer awaiting an answer");
    }
    if (step.type === "confirm" && typeof params.value !== "boolean") {
      throw new Error("A confirmation must be explicitly accepted or declined");
    }
    if (step.type === "text") {
      if (typeof params.value !== "string" || params.value.length > 16_384) {
        throw new Error("Invalid text answer");
      }
      if (this.externalEndpointPending) {
        if (step.sensitive)
          throw new Error("The endpoint must be confirmed before entering credentials");
        const approvedEndpoint = validateLocalModelUrl(params.value);
        if (!this.receipt) throw new Error("The setup operation is no longer active");
        this.receipt = { ...this.receipt, approvedEndpoint };
        this.deps.saveReceipt(this.receipt);
        this.externalEndpointPending = false;
      } else if (!step.sensitive && /^[a-z][a-z0-9+.-]*:\/\//i.test(params.value)) {
        validateLocalModelUrl(params.value);
      }
      if (step.sensitive && params.value) this.secrets.add(params.value);
    }
    if (
      step.type === "select" &&
      !step.options?.some((option) => isDeepStrictEqual(option.value, params.value))
    ) {
      throw new Error("Choose one of the offered local setup options");
    }
    if (
      step.type === "multiselect" &&
      (!Array.isArray(params.value) ||
        !params.value.every((value) =>
          step.options?.some((option) => isDeepStrictEqual(option.value, value)),
        ))
    ) {
      throw new Error("Choose only the offered local setup options");
    }
    if (step.type === "progress" || step.executor === "gateway") {
      throw new Error("This step is owned by the Gateway");
    }
    const answer = {
      stepId: step.id,
      ...(params.value !== undefined ? { value: params.value } : {}),
    };
    if (step.type === "confirm" && operation.download && params.value === false) {
      return this.cancel(operation.id);
    }
    this.publish({
      phase: operation.kind === "prepare" ? "starting" : "activating",
      step: undefined,
      error: undefined,
    });
    this.drive(async (gateway) => {
      const response = await gateway.request(
        "wizard.next",
        {
          sessionId: operation.id,
          answer,
        },
        NEXT_TIMEOUT_MS,
      );
      await this.consume(response, gateway);
    });
    return this.getOperation()!;
  }

  async cancel(operationId: unknown): Promise<LocalModelOperation> {
    const operation = this.operation;
    if (!operation?.busy || operationId !== operation.id) {
      throw new Error("The local setup operation is no longer active");
    }
    if (this.receipt?.gatewayIdentity !== this.deps.identity()) {
      throw new Error("The Gateway identity changed; reconnect to the original Gateway");
    }
    if (this.receipt.configSelection) {
      if (this.driving) {
        this.publish({
          error: "The model selection is being applied; it cannot be cancelled after submission",
        });
        return this.getOperation()!;
      }
      this.finish({
        phase: "cancelled",
        error: "Stopped waiting for model selection. Saved configuration was not rolled back.",
      });
      return this.getOperation()!;
    }
    this.publish({ cancellationPending: true });
    try {
      const result = record(
        await this.gateway().request("wizard.cancel", { sessionId: operation.id }),
      );
      if (!this.operation?.busy) return this.getOperation()!;
      if (result.status === "cancelled") this.finish({ phase: "cancelled" });
      else if (result.status === "running") {
        this.publish({
          error: "The Gateway is completing a protected step; cancellation has not finished",
        });
      } else if (!this.driving) {
        return await this.resume();
      }
    } catch (error) {
      const details = optionalRecord(optionalRecord(error).details);
      if (details.code === "WIZARD_NOT_FOUND" && !this.driving) {
        this.finish({
          phase: "error",
          error:
            "The local setup session has already ended. Saved configuration was not rolled back.",
        });
      } else {
        this.publish({ phase: "interrupted", error: this.errorMessage(error) });
      }
    }
    return this.getOperation()!;
  }

  async resume(): Promise<LocalModelOperation> {
    if (!this.operation || !this.receipt) throw new Error("No local setup operation to resume");
    if (this.driving) {
      if (!this.awaitingStart || this.operation.phase !== "interrupted")
        return this.getOperation()!;
      this.driveGeneration += 1;
      this.driving = false;
      this.awaitingStart = false;
    }
    if (this.receipt.gatewayIdentity !== this.deps.identity()) {
      throw new Error("The Gateway identity changed; reconnect to the original Gateway");
    }
    this.publish({ phase: "starting", step: undefined, error: undefined });
    this.drive(async (gateway) => {
      if (this.receipt?.configSelection) {
        await this.waitForSelectionApplied(text(this.receipt.modelRef));
        this.finish({ phase: "ready" });
        return;
      }
      try {
        await this.consume(
          await gateway.request("wizard.next", { sessionId: this.receipt!.id }, NEXT_TIMEOUT_MS),
          gateway,
        );
      } catch (error) {
        const details = optionalRecord(optionalRecord(error).details);
        if (details.code !== "WIZARD_NOT_FOUND") throw error;
        const snapshot = this.getSnapshot();
        if (
          this.operation?.kind === "activate" &&
          snapshot.configuredModel === this.operation.modelRef
        ) {
          await this.waitForSelectionApplied(text(this.operation.modelRef));
          this.finish({ phase: "ready" });
          return;
        }
        this.finish({
          phase: "error",
          error:
            "The Gateway setup session has expired. Current configuration was rechecked; review it before starting a new operation.",
        });
      }
    });
    return this.getOperation()!;
  }
}
