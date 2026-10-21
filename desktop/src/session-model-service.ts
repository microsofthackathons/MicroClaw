import { isDeepStrictEqual } from "node:util";
import { randomUUID } from "node:crypto";
import { inspectLocalModelFiles } from "./local-model-files";
import { GatewayRequestError } from "./gateway-client";
import { assertChatModelSupported } from "./provider-model-capabilities";
import { assertModelProviderSupported } from "./model-provider-policy";
import { supportsLocalModelGatewayVersion, validateLocalModelUrl } from "./local-model-service";
import type { LocalModelGateway } from "./local-model-service";
import type { SessionModelRecovery, SessionModelState } from "./session-model-types";

type JsonObject = Record<string, unknown>;

interface SessionModelGateway extends LocalModelGateway {
  mainSessionKey?: string | null;
}

interface Dependencies {
  gateway(): SessionModelGateway | null;
  readConfig(): unknown;
  /** Must synchronously reject active chats, other model operations and locked configurations. */
  assertMutable(): void;
  runtime(): SessionModelRuntime | null;
  restartGateway(): Promise<void>;
  onRecoveryChanged(): void;
  prepareModel?(modelRef: string): Promise<void>;
}

export interface SessionModelRuntime {
  identity: string;
  generation: string;
  /** Bound to the captured child process, not a reused PID or a WebSocket reconnect. */
  isStopped(): boolean;
}

interface Context {
  gateway: SessionModelGateway;
  generation: number | undefined;
  localConfig: unknown;
  runtime: SessionModelRuntime | null;
}

interface SelectionState {
  state: SessionModelState;
  agentId: string;
  row: JsonObject | null;
}

function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function response(value: unknown): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Invalid session model response from Gateway");
  }
  return value as JsonObject;
}

function identifier(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 4096 ||
    Array.from(value.trim()).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 32 || code === 127;
    })
  ) {
    throw new Error(`Invalid ${label}`);
  }
  return value.trim();
}

function sessionKey(value: unknown): string {
  const key = identifier(value, "session key");
  if (
    key.toLowerCase() === "unknown" ||
    (/^agent:/i.test(key) && !/^agent:[a-z0-9][a-z0-9_-]{0,63}:.+$/i.test(key))
  ) {
    throw new Error("Invalid session key");
  }
  return key;
}

function modelReference(value: unknown): string {
  const ref = identifier(value, "model reference");
  if (!/^[^/:@\\]+\/[^@\s\\]+$/.test(ref) || ref.includes("*")) {
    throw new Error("Choose an exact provider/model reference");
  }
  return ref;
}

function projectedModel(row: JsonObject): string | null {
  if (row.model == null && row.modelProvider == null) return null;
  const provider = identifier(row.modelProvider, "Gateway model provider");
  const model = identifier(row.model, "Gateway model");
  return modelReference(`${provider}/${model}`);
}

function agentEntries(config: JsonObject): [string, JsonObject][] {
  const agents = object(config.agents);
  if (agents.entries && typeof agents.entries === "object") {
    return Object.entries(object(agents.entries)).map(([id, value]) => [
      id.toLowerCase(),
      object(value),
    ]);
  }
  if (Array.isArray(agents.list)) {
    return agents.list.map((value) => {
      const entry = object(value);
      return [identifier(entry.id, "agent id").toLowerCase(), entry];
    });
  }
  return [["main", {}]];
}

// OpenClaw 2026.9.3 session-key.ts preserves Signal group ids and Matrix room/thread
// ids; lowercasing an entire opaque key would address a different conversation.
function normalizeKey(key: string): string {
  const spans: { start: number; end: number }[] = [];
  for (const match of key.matchAll(/(^|:)signal:group:([^:]+)/gi)) {
    spans.push({
      start: match.index! + match[0].length - match[2].length,
      end: match.index! + match[0].length,
    });
  }
  const matrix = /^(?:(?:agent:[^:]*:)+:*)?matrix:(?:channel|group):/i.exec(key);
  if (matrix) {
    const tail = key.slice(matrix[0].length);
    const thread = tail.toLowerCase().lastIndexOf(":thread:");
    spans.push({
      start: matrix[0].length,
      end: thread < 0 ? key.length : matrix[0].length + thread,
    });
    if (thread >= 0) spans.push({ start: matrix[0].length + thread + 8, end: key.length });
  }
  let result = "";
  let offset = 0;
  for (const span of spans.sort((a, b) => a.start - b.start)) {
    if (span.start < offset) continue;
    result += key.slice(offset, span.start).toLowerCase() + key.slice(span.start, span.end);
    offset = span.end;
  }
  return result + key.slice(offset).toLowerCase();
}

function missingTarget(config: JsonObject, raw: string, mainKey?: string | null) {
  const key = normalizeKey(raw);
  const entries = agentEntries(config);
  const configuredMain =
    String(object(config.session).mainKey ?? "main")
      .trim()
      .toLowerCase() || "main";
  const explicit = /^agent:([^:]+):(.+)$/.exec(key);
  const defaults = entries.filter(([, entry]) => entry.default === true);
  const owner =
    entries.length === 1
      ? entries[0][0]
      : object(config.agents).ownership !== "explicit" && defaults.length === 1
        ? defaults[0][0]
        : /^agent:([^:]+):/.exec(mainKey ?? "")?.[1];
  const mainAlias = (rest: string) => rest === "main" || rest === configuredMain;
  let agentId = explicit?.[1] ?? owner;
  if (
    explicit?.[1] === "main" &&
    mainAlias(explicit[2]) &&
    !entries.some(([id]) => id === "main")
  ) {
    agentId = owner;
  }
  if (!agentId || !entries.some(([id]) => id === agentId)) {
    throw new Error("Choose a configured agent using an explicit agent session key");
  }
  const rest = explicit?.[2] ?? key;
  const canonical =
    key === "global" || (mainAlias(rest) && object(config.session).scope === "global")
      ? "global"
      : `agent:${agentId}:${mainAlias(rest) ? configuredMain : rest}`;
  return { key: canonical, agentId };
}

/** Canonical routing identity for the main process's in-flight chat guard. */
export function sessionModelChatKey(config: unknown, key: string, mainKey?: string | null): string {
  try {
    return missingTarget(object(config), sessionKey(key), mainKey).key;
  } catch {
    return key;
  }
}

function assertAllowlist(
  config: JsonObject,
  agentId: string,
  ref: string,
  inheritedModelRef: string | null,
): void {
  const defaults = object(object(config.agents).defaults);
  const agent = agentEntries(config).find(([id]) => id === agentId)?.[1] ?? {};
  const agentPolicy = object(agent.modelPolicy);
  const defaultPolicy = object(defaults.modelPolicy);
  const migrated = object(object(config.meta).migrations).modelPolicyAllowlist === true;
  const agentOwnsPolicy = Object.hasOwn(agentPolicy, "allow");
  const refs = agentOwnsPolicy
    ? agentPolicy.allow
    : Object.hasOwn(defaultPolicy, "allow")
      ? defaultPolicy.allow
      : !migrated && defaults.modelPolicy === undefined
        ? Object.keys(object(defaults.models))
        : [];
  if (!Array.isArray(refs)) throw new Error("Invalid configured model allowlist");
  // OpenClaw's buildAllowedModelSetFromPrepared retains the effective primary for
  // exact-only restrictions, but deliberately not for wildcard/mixed policies.
  const entries = refs.filter((raw): raw is string => typeof raw === "string" && !!raw.trim());
  if (
    ref === inheritedModelRef &&
    entries.length > 0 &&
    !entries.some((raw) => raw.trim().endsWith("/*"))
  ) {
    return;
  }
  const aliases = {
    ...object(defaults.models),
    ...(agentOwnsPolicy ? object(agent.models) : {}),
  };
  const allowed = refs.some((raw) => {
    if (typeof raw !== "string") return false;
    const key = raw.trim();
    if (key === ref || (key.endsWith("/*") && ref.startsWith(key.slice(0, -1)))) return true;
    return Object.entries(aliases).some(
      ([candidate, value]) =>
        candidate === ref &&
        typeof object(value).alias === "string" &&
        String(object(value).alias).toLowerCase() === key.toLowerCase(),
    );
  });
  if (refs.length > 0 && !allowed) {
    throw new Error("The selected model is not allowed by this agent's model allowlist");
  }
}

function assertSessionOnly(config: JsonObject): void {
  const scope = object(object(config.agents).defaults).modelSelectionScope;
  if (scope !== undefined && scope !== "session") {
    throw new Error(
      "Session model selection requires modelSelectionScope=session; defaults were not changed",
    );
  }
}

export class SessionModelService {
  private selecting = false;
  private recovering = false;
  // An uncertain write must be reconciled by a fresh read, never retried automatically.
  private uncertain: {
    id: string;
    sessionKey: string;
    agentId: string;
    runtime: SessionModelRuntime;
    requestSettled: boolean;
  } | null = null;

  constructor(private readonly deps: Dependencies) {}

  get busy(): boolean {
    return this.selecting || this.recovering || this.uncertain !== null;
  }

  assertIdle(): void {
    if (this.selecting || this.recovering) throw new Error("A session model change is in progress");
    if (this.uncertain)
      throw new Error(
        "Session model change outcome is unknown; use model selection recovery before continuing",
      );
  }

  assertChatAllowed(): void {
    this.assertIdle();
  }

  private context(): Context {
    const gateway = this.deps.gateway();
    if (!gateway?.connected) throw new Error("Gateway is not connected");
    if (!supportsLocalModelGatewayVersion(gateway.serverVersion)) {
      throw new Error("Session model selection requires a supported OpenClaw Gateway");
    }
    for (const method of ["sessions.describe", "sessions.list", "sessions.patch", "config.get"]) {
      if (!gateway.methods.includes(method)) throw new Error(`Gateway does not support ${method}`);
    }
    return {
      gateway,
      generation: gateway.connectionGeneration,
      localConfig: structuredClone(this.deps.readConfig()),
      runtime: this.deps.runtime(),
    };
  }

  private assertCurrent(ctx: Context): void {
    if (
      this.deps.gateway() !== ctx.gateway ||
      !ctx.gateway.connected ||
      ctx.gateway.connectionGeneration !== ctx.generation
    ) {
      throw new Error("Gateway connection changed; reload the session model");
    }
    if (!isDeepStrictEqual(ctx.localConfig, this.deps.readConfig())) {
      throw new Error("Model configuration changed; reload the session model");
    }
  }

  private async request(ctx: Context, method: string, params: JsonObject): Promise<JsonObject> {
    this.assertCurrent(ctx);
    const result = response(await ctx.gateway.request(method, params));
    this.assertCurrent(ctx);
    return result;
  }

  private async config(ctx: Context): Promise<JsonObject> {
    const snapshot = await this.request(ctx, "config.get", {});
    if (snapshot.valid !== true || !snapshot.hash || !snapshot.config) {
      throw new Error("The Gateway configuration is unavailable or invalid");
    }
    return snapshot;
  }

  private async read(ctx: Context, key: string, config?: JsonObject): Promise<SelectionState> {
    const result = await this.request(ctx, "sessions.describe", {
      key,
      includeDerivedTitles: false,
      includeLastMessage: false,
    });
    if (result.session !== null) {
      const row = response(result.session);
      const canonical = sessionKey(row.key);
      const agentId =
        typeof row.agentId === "string" ? row.agentId : /^agent:([^:]+):/.exec(canonical)?.[1];
      if (!agentId) throw new Error("Gateway did not identify the session's agent");
      return {
        state: {
          sessionKey: canonical,
          modelRef: projectedModel(row),
          overridden: row.modelOverrideSource != null,
        },
        agentId,
        row,
      };
    }
    const cfg = config ?? response((await this.config(ctx)).config);
    const target = missingTarget(cfg, key, ctx.gateway.mainSessionKey);
    // Agent-scoped, bounded session listing supplies the official inherited default.
    // It uses prepared catalog facts, not discovery, and does not create a session.
    const listed = await this.request(ctx, "sessions.list", {
      agentId: target.agentId,
      search: target.key,
      limit: 1,
      includeDerivedTitles: false,
      includeLastMessage: false,
    });
    return {
      state: {
        sessionKey: target.key,
        modelRef: projectedModel(response(listed.defaults)),
        overridden: false,
      },
      agentId: target.agentId,
      row: null,
    };
  }

  async get(input: unknown): Promise<SessionModelState> {
    const key = sessionKey(input);
    if (this.selecting || this.recovering) throw new Error("A session model change is in progress");
    const ctx = this.context();
    const result = await this.read(ctx, key);
    if (this.uncertain?.sessionKey === result.state.sessionKey && this.canReconcile(ctx.runtime)) {
      this.uncertain = null;
      this.deps.onRecoveryChanged();
    }
    return result.state;
  }

  private canReconcile(runtime = this.deps.runtime()): boolean {
    const pending = this.uncertain;
    return Boolean(
      pending &&
      runtime &&
      !runtime.isStopped() &&
      runtime.identity === pending.runtime.identity &&
      (pending.requestSettled ||
        (runtime.generation !== pending.runtime.generation && pending.runtime.isStopped())),
    );
  }

  getRecovery(): SessionModelRecovery | null {
    const pending = this.uncertain;
    if (!pending) return null;
    let blockedReason: string | undefined;
    try {
      if (this.selecting || this.recovering)
        throw new Error("Session model recovery is in progress");
      this.deps.assertMutable();
      const runtime = this.deps.runtime();
      if (!this.deps.gateway()?.connected || !runtime || runtime.isStopped())
        throw new Error("Reconnect to MicroClaw's managed Gateway before recovering");
      if (runtime.identity !== pending.runtime.identity)
        throw new Error("Return to the original Gateway configuration before recovering");
    } catch (cause) {
      blockedReason = cause instanceof Error ? cause.message : String(cause);
    }
    return {
      id: pending.id,
      requiresRestart: !this.canReconcile(),
      recovering: this.recovering,
      canRecover: blockedReason === undefined,
      ...(blockedReason ? { blockedReason } : {}),
    };
  }

  async recover(input: unknown): Promise<void> {
    const params = response(input);
    if (
      Object.keys(params).some((key) => !["recoveryId", "confirmed", "restart"].includes(key)) ||
      params.confirmed !== true ||
      typeof params.restart !== "boolean"
    )
      throw new Error("Confirm session model recovery explicitly before continuing");
    const pending = this.uncertain;
    if (!pending || params.recoveryId !== pending.id)
      throw new Error("The pending model selection changed; refresh before recovering");
    const recovery = this.getRecovery()!;
    if (!recovery.canRecover) throw new Error(recovery.blockedReason);
    if (recovery.requiresRestart && params.restart !== true)
      throw new Error(
        "Stopping the previous request requires an explicitly confirmed Gateway restart",
      );
    this.recovering = true;
    this.deps.onRecoveryChanged();
    try {
      if (recovery.requiresRestart) await this.deps.restartGateway();
      const ctx = this.context();
      if (!this.canReconcile(ctx.runtime))
        throw new Error(
          "The previous Gateway request has not been proven stopped; recovery remains blocked",
        );
      const cfg = response((await this.config(ctx)).config);
      // A removed owner cannot receive a late patch after its Gateway has stopped.
      // Otherwise read its actual saved state; never replay the requested model.
      if (agentEntries(cfg).some(([id]) => id === pending.agentId))
        await this.read(ctx, pending.sessionKey, cfg);
      this.assertCurrent(ctx);
      this.uncertain = null;
    } finally {
      this.recovering = false;
      this.deps.onRecoveryChanged();
    }
  }

  private assertLocalFiles(config: JsonObject, ref: string): void {
    if (!ref.startsWith("llama-cpp/")) return;
    const provider = object(object(object(config.models).providers)["llama-cpp"]);
    validateLocalModelUrl(provider.baseUrl);
    if (inspectLocalModelFiles(provider).get(ref.slice("llama-cpp/".length)) === "missing") {
      throw new Error(
        "The local model files are missing; open local model management to prepare them",
      );
    }
  }

  private async validateModel(
    config: JsonObject,
    agentId: string,
    ref: string,
    inheritedModelRef: string | null,
  ): Promise<void> {
    assertAllowlist(config, agentId, ref, inheritedModelRef);
    const slash = ref.indexOf("/");
    const providerId = ref.slice(0, slash);
    const modelId = ref.slice(slash + 1);
    const provider = object(object(object(config.models).providers)[providerId]);
    if (
      !Array.isArray(provider.models) ||
      !provider.models.some((value) => object(value).id === modelId)
    ) {
      throw new Error("The selected model is not configured");
    }
    this.assertLocalFiles(config, ref);
  }

  async select(input: unknown): Promise<SessionModelState> {
    const params = response(input);
    if (Object.keys(params).some((key) => key !== "sessionKey" && key !== "modelRef")) {
      throw new Error("Invalid session model selection");
    }
    const key = sessionKey(params.sessionKey);
    const ref = params.modelRef === null ? null : modelReference(params.modelRef);
    assertModelProviderSupported(ref);
    if (ref !== null) assertChatModelSupported(ref);
    this.assertIdle();
    this.deps.assertMutable();
    if (ref !== null && this.deps.prepareModel) {
      await this.deps.prepareModel(ref);
      this.assertIdle();
      this.deps.assertMutable();
    }
    const ctx = this.context();
    const runtime = ctx.runtime;
    if (!runtime || runtime.isStopped())
      throw new Error("Session model selection requires a running managed Gateway");
    this.selecting = true;
    let submitted = false;
    let acknowledged = false;
    let targetKey = key;
    let targetAgent = "";
    try {
      const snapshot = await this.config(ctx);
      const cfg = response(snapshot.config);
      assertSessionOnly(cfg);
      const before = await this.read(ctx, key, cfg);
      targetKey = before.state.sessionKey;
      targetAgent = before.agentId;
      if (before.row?.modelSelectionLocked === true)
        throw new Error("This session's model selection is locked");
      if (
        before.row?.hasActiveRun === true ||
        ["running", "queued"].includes(String(before.row?.status))
      ) {
        throw new Error("Wait for the active chat response before changing the model");
      }
      const inheritedModelRef = before.row
        ? projectedModel(
            response(
              (
                await this.request(ctx, "sessions.list", {
                  agentId: before.agentId,
                  search: before.state.sessionKey,
                  limit: 1,
                  includeDerivedTitles: false,
                  includeLastMessage: false,
                })
              ).defaults,
            ),
          )
        : before.state.modelRef;
      const selected = ref ?? inheritedModelRef;
      assertModelProviderSupported(selected);
      if (ref !== null) await this.validateModel(cfg, before.agentId, ref, inheritedModelRef);
      const latest = await this.config(ctx);
      if (latest.hash !== snapshot.hash)
        throw new Error("Gateway configuration changed; reload the session model");
      this.assertCurrent(ctx);
      this.deps.assertMutable();
      if (selected) this.assertLocalFiles(cfg, selected);
      const patch: JsonObject = {
        key: before.state.sessionKey,
        agentId: before.agentId,
        model: ref,
      };
      if (before.row?.sessionId) patch.expectedSessionId = before.row.sessionId;
      if (before.row?.lifecycleRevision)
        patch.expectedLifecycleRevision = before.row.lifecycleRevision;
      submitted = true;
      const raw = await ctx.gateway.request("sessions.patch", patch);
      acknowledged = true;
      this.assertCurrent(ctx);
      const applied = response(raw);
      if (applied.ok !== true || applied.key !== before.state.sessionKey) {
        throw new Error("Gateway did not confirm the session model selection");
      }
      const appliedModel = projectedModel(response(applied.resolved));
      if (ref !== null && appliedModel !== ref)
        throw new Error("Gateway selected a different model");
      const entry = response(applied.entry);
      if (ref === null && (entry.modelOverride || entry.providerOverride)) {
        throw new Error("Gateway did not clear the session model override");
      }
      const after = await this.read(ctx, before.state.sessionKey, cfg);
      if (
        after.state.modelRef !== appliedModel ||
        after.state.overridden !== Boolean(entry.modelOverride)
      ) {
        throw new Error("Session model readback did not match the applied selection");
      }
      this.assertCurrent(ctx);
      return after.state;
    } catch (error) {
      if (
        error instanceof GatewayRequestError &&
        !acknowledged &&
        (error.code === "INVALID_REQUEST" || error.code === "FORBIDDEN")
      ) {
        throw error;
      }
      if (submitted) {
        this.uncertain = {
          id: randomUUID(),
          sessionKey: targetKey,
          agentId: targetAgent,
          runtime,
          requestSettled: acknowledged || error instanceof GatewayRequestError,
        };
        throw new Error(
          "Session model change could not be confirmed. It may have been saved; open the model picker to recover before continuing. No rollback or retry was attempted.",
          { cause: error },
        );
      }
      throw error;
    } finally {
      this.selecting = false;
      if (this.uncertain) this.deps.onRecoveryChanged();
    }
  }
}
