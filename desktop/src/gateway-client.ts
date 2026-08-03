/**
 * WebSocket gateway client for OpenClaw — mirrors the webchat protocol.
 *
 * Protocol overview (JSON over WS):
 *   → { type: "req", id, method: "connect", params }   (handshake)
 *   ← { type: "res", id, ok: true, payload: hello }
 *   → { type: "req", id, method: "chat.send",  params: { sessionKey, message } }
 *   ← { type: "res", id, ok: true }
 *   ← { type: "event", event: "chat", payload: { state: "delta"|"final"|"aborted"|"error", ... } }
 */

import WebSocket from "ws";
import { randomUUID } from "crypto";
import {
  loadOrCreateDeviceIdentity,
  signDevicePayload,
  buildDeviceAuthPayload,
  type DeviceIdentity,
} from "./device-identity.js";
import {
  AGENT_WARMUP_PROMPT,
  AGENT_WARMUP_SESSION_KEY,
  AGENT_WARMUP_TIMEOUT_MS,
  WS_RECONNECT_INITIAL_MS,
  WS_RECONNECT_MAX_MS,
  WS_RECONNECT_MULTIPLIER,
  WS_REQUEST_TIMEOUT_MS,
} from "./constants";
import { buildGatewayConnectParams } from "./gateway-protocol";

// ── Types ───────────────────────────────────────────────────────────────

export type GatewayEventFrame = {
  type: "event";
  event: string;
  payload?: unknown;
  seq?: number;
};

export type GatewayResponseFrame = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: { code: string; message: string };
};

export type ChatEventPayload = {
  runId: string;
  sessionKey: string;
  state: "delta" | "final" | "aborted" | "error";
  message?: unknown;
  deltaText?: string;
  replace?: boolean;
  errorMessage?: string;
};

export type AgentWarmupResult = {
  outcome: "skipped" | "delta" | "terminal" | "timeout" | "error" | "disconnected";
  transcriptDeleted: boolean;
};

type AgentWarmupSignal = "delta" | "terminal" | "disconnected";

export function isAgentWarmupEvent(evt: GatewayEventFrame): boolean {
  if (!evt.payload || typeof evt.payload !== "object" || Array.isArray(evt.payload)) return false;
  return (evt.payload as Record<string, unknown>).sessionKey === AGENT_WARMUP_SESSION_KEY;
}

export type ListedGatewayChannel = {
  id: string;
  name: string;
  icon: string;
  type: string;
  connected: boolean;
};

type GatewayChannelState = {
  connected?: boolean;
  running?: boolean;
  linked?: boolean;
};

type GatewayChannelsStatusPayload = {
  channels?: Record<string, GatewayChannelState>;
  channelAccounts?: Record<string, GatewayChannelState[]>;
  channelOrder?: string[];
  channelLabels?: Record<string, string>;
  channelMeta?: Array<{
    id: string;
    label?: string;
    systemImage?: string;
  }>;
};

function isConnected(state: GatewayChannelState | undefined): boolean {
  return state?.connected === true || state?.running === true || state?.linked === true;
}

export function normalizeGatewayChannelsStatus(
  payload: GatewayChannelsStatusPayload,
): ListedGatewayChannel[] {
  const summaries = payload.channels ?? {};
  const metadata = new Map((payload.channelMeta ?? []).map((entry) => [entry.id, entry]));
  const orderedIds = Array.from(
    new Set([...(payload.channelOrder ?? []), ...Object.keys(summaries)]),
  ).filter((id) => Object.hasOwn(summaries, id));

  return orderedIds.map((id) => {
    const meta = metadata.get(id);
    const accountConnected = (payload.channelAccounts?.[id] ?? []).some(isConnected);
    return {
      id,
      name: payload.channelLabels?.[id] ?? meta?.label ?? id,
      icon: meta?.systemImage ?? "",
      type: id,
      connected: isConnected(summaries[id]) || accountConnected,
    };
  });
}

type Pending = {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
};

export type GatewayClientOptions = {
  port: number;
  token: string;
  onEvent?: (evt: GatewayEventFrame) => void;
  onConnected?: (hello: Record<string, unknown>) => void;
  onDisconnected?: (reason: string) => void;
  /** Called when the connect handshake fails due to an auth/token error. */
  onAuthError?: (message: string) => void;
};

export function extractMainSessionKey(hello: Record<string, unknown>): string | null {
  const snapshot = hello.snapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const sessionDefaults = (snapshot as Record<string, unknown>).sessionDefaults;
  if (!sessionDefaults || typeof sessionDefaults !== "object" || Array.isArray(sessionDefaults)) {
    return null;
  }
  const key = (sessionDefaults as Record<string, unknown>).mainSessionKey;
  return typeof key === "string" && key.length > 0 ? key : null;
}

// ── Client ──────────────────────────────────────────────────────────────

export class GatewayClient {
  private ws: WebSocket | null = null;
  private pending = new Map<string, Pending>();
  private closed = false;
  private backoffMs = WS_RECONNECT_INITIAL_MS;
  private _connected = false;
  private connectNonce: string | null = null;
  private connectSent = false;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private deviceIdentity: DeviceIdentity;
  private _mainSessionKey: string | null = null;
  private agentWarmupPromise: Promise<AgentWarmupResult> | null = null;
  private agentWarmupWaiter: ((signal: AgentWarmupSignal) => void) | null = null;
  private agentWarmupAbortPromise: Promise<void> | null = null;

  constructor(private opts: GatewayClientOptions) {
    this.deviceIdentity = loadOrCreateDeviceIdentity();
  }

  get connected() {
    return this._connected;
  }

  get mainSessionKey() {
    return this._mainSessionKey;
  }

  start() {
    this.closed = false;
    this.connect();
  }

  stop() {
    this.closed = true;
    this._connected = false;
    if (this.connectTimer) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.agentWarmupWaiter?.("disconnected");
    this.flushPending("client stopped");
  }

  // ── Public API ──

  async request<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("gateway not connected");
    }
    const id = randomUUID();
    const frame = { type: "req", id, method, params };
    return new Promise<T>((resolve, reject) => {
      // Auto-reject after timeout to prevent hung promises
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`request '${method}' timed out after ${WS_REQUEST_TIMEOUT_MS}ms`));
        }
      }, WS_REQUEST_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.ws!.send(JSON.stringify(frame));
    });
  }

  /** Send a chat message (server maintains history). */
  sendChat(sessionKey: string, message: string): Promise<unknown> {
    return this.request("chat.send", {
      sessionKey,
      message,
      deliver: false,
      idempotencyKey: randomUUID(),
    });
  }

  /**
   * Warm the main agent on an internal throwaway session.
   *
   * All events for the reserved session are consumed in handleMessage(), so
   * neither the main process nor renderer can add them to visible chat state.
   */
  warmUpAgent(timeoutMs = AGENT_WARMUP_TIMEOUT_MS): Promise<AgentWarmupResult> {
    if (this.agentWarmupPromise) return this.agentWarmupPromise;

    const operation = this.runAgentWarmup(timeoutMs);
    this.agentWarmupPromise = operation;
    void operation.finally(() => {
      if (this.agentWarmupPromise === operation) this.agentWarmupPromise = null;
    });
    return operation;
  }

  /** Load chat history for a session. */
  loadHistory(sessionKey: string): Promise<{ messages?: unknown[]; thinkingLevel?: string }> {
    return this.request("chat.history", { sessionKey, limit: 200 });
  }

  /** Abort the current chat run. */
  abortChat(sessionKey: string): Promise<unknown> {
    return this.request("chat.abort", { sessionKey });
  }

  /**
   * Delete one persisted session and its transcript.
   *
   * OpenClaw does not allow deleting the configured main session, so reset
   * that exact canonical key instead. Other sessions, including a non-default
   * agent's `main`-named session, are deleted normally.
   */
  async deleteSession(sessionKey: string): Promise<void> {
    if (sessionKey === this._mainSessionKey) {
      await this.request("sessions.reset", { key: sessionKey, reason: "reset" });
      return;
    }
    await this.request("sessions.delete", { key: sessionKey, deleteTranscript: true });
  }

  private async runAgentWarmup(timeoutMs: number): Promise<AgentWarmupResult> {
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<"timeout">((resolve) => {
      timeoutHandle = setTimeout(() => resolve("timeout"), timeoutMs);
    });

    try {
      const signal = new Promise<AgentWarmupSignal>((resolve) => {
        this.agentWarmupWaiter = resolve;
      });

      const sendFailure = this.sendChat(AGENT_WARMUP_SESSION_KEY, AGENT_WARMUP_PROMPT).then(
        () => new Promise<never>(() => undefined),
        (error) => Promise.reject(error),
      );
      const outcome = await Promise.race([signal, sendFailure, timeout]);
      if (outcome === "timeout") {
        this.requestAgentWarmupAbort();
        return { outcome, transcriptDeleted: false };
      }

      if (outcome === "disconnected") {
        this.requestAgentWarmupAbort();
        return { outcome, transcriptDeleted: false };
      }

      this.requestAgentWarmupAbort();
      return { outcome, transcriptDeleted: false };
    } catch (error) {
      console.warn("[gateway-client] agent warm-up failed:", error);
      this.requestAgentWarmupAbort();
      return { outcome: "error", transcriptDeleted: false };
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      this.agentWarmupWaiter = null;
    }
  }

  private requestAgentWarmupAbort(): void {
    if (this.agentWarmupAbortPromise) return;
    const abort = this.abortChat(AGENT_WARMUP_SESSION_KEY).then(
      () => undefined,
      (error) => {
        console.warn("[gateway-client] could not abort agent warm-up:", error);
      },
    );
    this.agentWarmupAbortPromise = abort;
    void abort.finally(() => {
      if (this.agentWarmupAbortPromise === abort) this.agentWarmupAbortPromise = null;
    });
  }

  /**
   * Clear ALL persisted chat history on the gateway.
   *
   * Enumerates every session via `sessions.list`, then wipes each one:
   *   - non-main sessions are removed entirely via `sessions.delete`
   *     (which also archives/clears their transcript), and
   *   - the main session (which the gateway refuses to delete) is cleared
   *     via `sessions.reset`, giving it a fresh, empty transcript.
   *
   * Individual failures are swallowed so one bad session can't abort the
   * whole sweep. Returns the number of sessions successfully cleared.
   */
  async clearAllHistory(): Promise<{ cleared: number }> {
    const list = await this.request<{ sessions?: Array<{ key?: string }> }>("sessions.list", {});
    const keys = (list?.sessions ?? [])
      .map((s) => (typeof s?.key === "string" ? s.key : ""))
      .filter(Boolean);
    let cleared = 0;
    for (const key of keys) {
      try {
        await this.request("sessions.delete", { key, deleteTranscript: true });
        cleared++;
      } catch {
        // The main session can't be deleted — reset clears its transcript.
        try {
          await this.request("sessions.reset", { key, reason: "reset" });
          cleared++;
        } catch {
          // Ignore individual session failures and continue the sweep.
        }
      }
    }
    return { cleared };
  }

  /** List all cron jobs. */
  listCronJobs(): Promise<{ jobs?: unknown[] }> {
    return this.request("cron.list");
  }

  /** List available agents. */
  listAgents(): Promise<{ agents?: unknown[] }> {
    return this.request("agents.list");
  }

  /** List IM channels from the OpenClaw 7.1 status snapshot. */
  async listChannels(): Promise<{ channels: ListedGatewayChannel[] }> {
    const status = await this.request<GatewayChannelsStatusPayload>("channels.status", {
      probe: false,
    });
    return { channels: normalizeGatewayChannelsStatus(status) };
  }

  /** Start WeChat QR login — returns QR data URL and session key. */
  weixinLoginQrStart(params?: {
    accountId?: string;
    force?: boolean;
    timeoutMs?: number;
  }): Promise<{ qrDataUrl?: string; message: string; sessionKey?: string }> {
    return this.request("web.login.start", params);
  }

  /** Wait for WeChat QR scan result (long-poll). */
  weixinLoginQrWait(params: {
    sessionKey?: string;
    accountId?: string;
    timeoutMs?: number;
  }): Promise<{ connected: boolean; message: string; accountId?: string }> {
    return this.request("web.login.wait", params);
  }

  // ── Internal ──

  private connect() {
    if (this.closed) return;

    const url = `ws://127.0.0.1:${this.opts.port}/`;
    this.ws = new WebSocket(url);
    this.connectNonce = null;
    this.connectSent = false;

    this.ws.on("open", () => {
      // Queue connect with a delay — gateway may send connect.challenge first
      this.queueConnect();
    });

    this.ws.on("message", (data) => {
      this.handleMessage(String(data));
    });

    this.ws.on("close", (_code, reason) => {
      this._connected = false;
      this.ws = null;
      this.agentWarmupWaiter?.("disconnected");
      this.flushPending("disconnected");
      this.opts.onDisconnected?.(String(reason || "closed"));
      this.scheduleReconnect();
    });

    this.ws.on("error", () => {
      // close handler will fire; nothing extra needed
    });
  }

  private queueConnect() {
    this.connectSent = false;
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
    }
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      this.sendConnect();
    }, 750);
  }

  private sendConnect() {
    if (this.connectSent) return;
    this.connectSent = true;
    if (this.connectTimer !== null) {
      clearTimeout(this.connectTimer);
      this.connectTimer = null;
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const role = "operator";
    const scopes = ["operator.admin", "operator.read", "operator.write"];
    const clientId = "gateway-client";
    const clientMode = "backend";
    const nonce = this.connectNonce ?? "";
    const signedAtMs = Date.now();

    const payload = buildDeviceAuthPayload({
      deviceId: this.deviceIdentity.deviceId,
      clientId,
      clientMode,
      role,
      scopes,
      signedAtMs,
      token: this.opts.token || null,
      nonce,
    });
    const signature = signDevicePayload(this.deviceIdentity.privateKey, payload);

    const params = buildGatewayConnectParams({
      token: this.opts.token,
      platform: process.platform,
      deviceId: this.deviceIdentity.deviceId,
      publicKey: this.deviceIdentity.publicKey,
      signature,
      signedAt: signedAtMs,
      nonce,
    });

    this.request<Record<string, unknown>>("connect", params)
      .then((hello) => {
        this._connected = true;
        this.backoffMs = WS_RECONNECT_INITIAL_MS;
        this._mainSessionKey = extractMainSessionKey(hello);
        this.opts.onConnected?.(hello ?? {});
      })
      .catch((err) => {
        console.error("[gateway-client] connect handshake failed:", err.message);
        // Don't reconnect for auth errors — they won't resolve on retry.
        // Instead, notify the caller so it can kill the stale gateway and restart.
        const isAuthError = /unauthorized|token.*mismatch|rate.limited/i.test(err.message);
        if (isAuthError) {
          this.closed = true; // prevent auto-reconnect
          this.opts.onAuthError?.(err.message);
        }
        this.ws?.close();
      });
  }

  private scheduleReconnect() {
    if (this.closed) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * WS_RECONNECT_MULTIPLIER, WS_RECONNECT_MAX_MS);
    setTimeout(() => this.connect(), delay);
  }

  private flushPending(reason: string) {
    for (const [, p] of this.pending) {
      p.reject(new Error(reason));
    }
    this.pending.clear();
  }

  private handleMessage(raw: string) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }

    const frame = parsed as { type?: string };

    if (frame.type === "event") {
      const evt = parsed as GatewayEventFrame;
      // Handle connect.challenge — gateway may require a nonce handshake
      if (evt.event === "connect.challenge") {
        const payload = evt.payload as { nonce?: string } | undefined;
        if (payload?.nonce) {
          this.connectNonce = payload.nonce;
          // Challenge arrived — reset sent flag and send immediately
          this.connectSent = false;
          this.sendConnect();
        }
        return;
      }
      if (isAgentWarmupEvent(evt)) {
        if (evt.event === "chat") {
          const payload = evt.payload as Partial<ChatEventPayload>;
          if (payload.state === "delta") {
            this.agentWarmupWaiter?.("delta");
          } else if (
            payload.state === "final" ||
            payload.state === "aborted" ||
            payload.state === "error"
          ) {
            this.agentWarmupWaiter?.("terminal");
          }
        }
        return;
      }
      this.opts.onEvent?.(evt);
      return;
    }

    if (frame.type === "res") {
      const res = parsed as GatewayResponseFrame;
      const p = this.pending.get(res.id);
      if (!p) return;
      this.pending.delete(res.id);
      if (res.ok) {
        p.resolve(res.payload);
      } else {
        p.reject(new Error(res.error?.message ?? "request failed"));
      }
    }
  }
}
