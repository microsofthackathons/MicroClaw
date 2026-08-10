// ---------------------------------------------------------------------------
// Shared constants for the MicroClaw Desktop main process.
// Centralises magic numbers and flags that were previously scattered across
// main.ts, gateway-manager.ts, and gateway-client.ts.
// ---------------------------------------------------------------------------

/** Default gateway port when none is configured in openclaw.json. */
export const DEFAULT_PORT = 18789;

/** Windows process-creation flag: suppress the console window. */
export const CREATE_NO_WINDOW = 0x08000000;

/** Sub-directory under the state dir used for Node 22+ V8 bytecode caching. */
export const COMPILE_CACHE_SUBDIR = "compile-cache";

// ── Window sizes ───────────────────────────────────────────────────────

/** Loading-phase window dimensions (fixed, non-resizable). */
export const LOADING_WINDOW_WIDTH = 700;
export const LOADING_WINDOW_HEIGHT = 540;

/** Setup wizard window dimensions. */
export const SETUP_WINDOW_WIDTH = 500;
export const SETUP_WINDOW_HEIGHT = 820;

/** Default full window dimensions when no saved bounds exist. */
export const DEFAULT_WINDOW_WIDTH = 1200;
export const DEFAULT_WINDOW_HEIGHT = 800;

/** Minimum window dimensions after expanding to full size. */
export const MIN_WINDOW_WIDTH = 800;
export const MIN_WINDOW_HEIGHT = 600;

// ── Timeouts & intervals ────────────────────────────────────────────────

/** How often the health monitor pings the gateway (ms). */
export const HEALTH_CHECK_INTERVAL_MS = 30_000;

/** HTTP timeout for a single health-check request (ms). */
export const HEALTH_CHECK_HTTP_TIMEOUT_MS = 10_000;

/** Number of consecutive health-check failures before triggering a restart.
 *  Tolerates transient slowness on low-CPU machines (e.g. 2-core VMs) where
 *  the gateway event loop can stall for several seconds during plugin work. */
export const HEALTH_CHECK_FAILURE_THRESHOLD = 3;

/** Grace period before restarting an unresponsive but still-running gateway.
 *  Long synchronous agent turns can block the event loop on loaded machines
 *  even though the gateway process is alive and making progress. */
export const HEALTH_CHECK_BUSY_GRACE_MS = 240_000;

/** Max time to wait for the gateway to become ready after spawn (ms). */
export const GATEWAY_READY_TIMEOUT_MS = 120_000;

/** Max time to wait for the gateway port to become free (ms). */
export const PORT_WAIT_TIMEOUT_MS = 30_000;

/** Max time to wait for a model provider connection test (ms). */
export const MODEL_CONNECTION_TEST_TIMEOUT_MS = 15_000;

/** Delay before the post-spawn restart that activates plugin channels (ms). */
export const POST_SPAWN_RESTART_DELAY_MS = 5_000;

/** Timeout for sandbox permission requests — file, shell, and app approval (ms).
 *  Shared by sandbox-preload.js (via env var) and main.ts (remote approval).
 *  After this timeout, pending prompts auto-deny to prevent consent fatigue. */
export const SANDBOX_PERMISSION_TIMEOUT_MS = 60_000;

/** Timeout for the WeChat login flow (ms). */
export const WEIXIN_LOGIN_TIMEOUT_MS = 180_000;

/** Timeout for each OpenClaw `skills` diagnostics CLI invocation (ms). The CLI is
 *  spawned cold and can take ~60–90s to emit its JSON on slower machines, so this
 *  is generous headroom to avoid killing the child before it produces output. */
export const SKILLS_STATUS_TIMEOUT_MS = 120_000;

/** Number of days of usage data to query from the gateway. */
export const USAGE_QUERY_DAYS = 30;

/**
 * Free, no-API-key FX endpoint (ECB data via Frankfurter) used to convert the
 * USD spend figures relayed from the OpenClaw gateway into CNY for display.
 */
export const EXCHANGE_RATE_API_URL = "https://api.frankfurter.app/latest?from=USD&to=CNY";

/** How long a fetched USD→CNY rate stays cached in memory before we refetch. */
export const EXCHANGE_RATE_CACHE_TTL_MS = 12 * 60 * 60 * 1_000;

/**
 * Fallback USD→CNY rate used when the FX endpoint is unreachable (offline / API
 * down) so the usage UI never breaks. Approximate mid-market rate as of 2026 —
 * this is only a safety net; the live rate is preferred whenever available.
 */
export const USD_TO_CNY_FALLBACK_RATE = 7.2;

/** Public manifest used by the P0 manual update checker. */
export const UPDATE_MANIFEST_URL = "https://microclaw.microsoftol.com/releases/latest.json";

// ── WebSocket reconnect back-off ────────────────────────────────────────

/** Initial delay before the first reconnect attempt (ms). */
export const WS_RECONNECT_INITIAL_MS = 800;

/** Maximum delay between reconnect attempts (ms). */
export const WS_RECONNECT_MAX_MS = 15_000;

/** Multiplier applied to the back-off delay on each retry. */
export const WS_RECONNECT_MULTIPLIER = 1.7;

/** Per-request timeout for gateway WS RPC calls (ms). */
export const WS_REQUEST_TIMEOUT_MS = 30_000;

/** Reserved throwaway session used to pre-warm the main agent. */
export const AGENT_WARMUP_SESSION_KEY = "agent:main:__microclaw_warmup__";

/** Minimal prompt for the throwaway warm-up turn. */
export const AGENT_WARMUP_PROMPT = "ping";

/** Hard cap for startup agent warm-up before the app fails open (ms). */
export const AGENT_WARMUP_TIMEOUT_MS = 30_000;

// ── Chat attachments ────────────────────────────────────────────────────

/** Maximum decoded size of one chat attachment (20 MiB, matching the gateway). */
export const CHAT_ATTACHMENT_MAX_FILE_BYTES = 20 * 1024 * 1024;

/** Maximum decoded size of all attachments selected for one message (50 MiB). */
export const CHAT_ATTACHMENT_MAX_TOTAL_BYTES = 50 * 1024 * 1024;

// ── Gateway status ──────────────────────────────────────────────────────

export type GatewayStatus =
  | "stopped"
  | "starting"
  | "running"
  | "restarting"
  | "failed"
  | "stopping"
  | "timeout";
