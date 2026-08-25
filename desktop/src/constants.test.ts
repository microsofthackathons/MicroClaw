import { describe, it, expect } from "vitest";
import {
  DEFAULT_PORT,
  CREATE_NO_WINDOW,
  COMPILE_CACHE_SUBDIR,
  HEALTH_CHECK_INTERVAL_MS,
  HEALTH_CHECK_HTTP_TIMEOUT_MS,
  HEALTH_CHECK_BUSY_GRACE_MS,
  GATEWAY_READY_TIMEOUT_MS,
  PORT_WAIT_TIMEOUT_MS,
  MODEL_CONNECTION_TEST_TIMEOUT_MS,
  POST_SPAWN_RESTART_DELAY_MS,
  WEIXIN_LOGIN_TIMEOUT_MS,
  USAGE_QUERY_DAYS,
  WS_RECONNECT_INITIAL_MS,
  WS_RECONNECT_MAX_MS,
  WS_RECONNECT_MULTIPLIER,
  WS_REQUEST_TIMEOUT_MS,
  SANDBOX_PERMISSION_TIMEOUT_MS,
  AGENT_WARMUP_PROMPT,
  AGENT_WARMUP_SESSION_KEY,
  AGENT_WARMUP_TIMEOUT_MS,
} from "./constants";
import type { GatewayStatus } from "./constants";

describe("constants", () => {
  it("DEFAULT_PORT is a valid port number", () => {
    expect(DEFAULT_PORT).toBe(18789);
    expect(DEFAULT_PORT).toBeGreaterThan(0);
    expect(DEFAULT_PORT).toBeLessThan(65536);
  });

  it("CREATE_NO_WINDOW is the correct Windows flag", () => {
    expect(CREATE_NO_WINDOW).toBe(0x08000000);
  });

  it("COMPILE_CACHE_SUBDIR is a non-empty string", () => {
    expect(COMPILE_CACHE_SUBDIR).toBe("compile-cache");
  });

  describe("timeouts are positive and in sensible ranges", () => {
    it("health check interval > 1s", () => {
      expect(HEALTH_CHECK_INTERVAL_MS).toBeGreaterThanOrEqual(1_000);
    });

    it("HTTP timeout < health check interval", () => {
      expect(HEALTH_CHECK_HTTP_TIMEOUT_MS).toBeLessThan(HEALTH_CHECK_INTERVAL_MS);
    });

    it("busy gateway grace >= health check interval", () => {
      expect(HEALTH_CHECK_BUSY_GRACE_MS).toBe(240_000);
      expect(HEALTH_CHECK_BUSY_GRACE_MS).toBeGreaterThanOrEqual(HEALTH_CHECK_INTERVAL_MS);
    });

    it("gateway ready timeout covers cold compatibility-preload startup", () => {
      expect(GATEWAY_READY_TIMEOUT_MS).toBe(300_000);
      expect(GATEWAY_READY_TIMEOUT_MS).toBeGreaterThanOrEqual(PORT_WAIT_TIMEOUT_MS);
      expect(GATEWAY_READY_TIMEOUT_MS).toBeGreaterThanOrEqual(HEALTH_CHECK_BUSY_GRACE_MS);
    });

    it("model connection test has a finite timeout", () => {
      expect(MODEL_CONNECTION_TEST_TIMEOUT_MS).toBeGreaterThan(0);
      expect(MODEL_CONNECTION_TEST_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
    });

    it("weixin login timeout > 60s", () => {
      expect(WEIXIN_LOGIN_TIMEOUT_MS).toBeGreaterThan(60_000);
    });

    it("post-spawn restart delay > 1s", () => {
      expect(POST_SPAWN_RESTART_DELAY_MS).toBeGreaterThan(1_000);
    });

    it("usage query days is reasonable", () => {
      expect(USAGE_QUERY_DAYS).toBeGreaterThan(0);
      expect(USAGE_QUERY_DAYS).toBeLessThanOrEqual(365);
    });
  });

  describe("WS reconnect backoff", () => {
    it("initial delay < max delay", () => {
      expect(WS_RECONNECT_INITIAL_MS).toBeLessThan(WS_RECONNECT_MAX_MS);
    });

    it("multiplier > 1 (exponential growth)", () => {
      expect(WS_RECONNECT_MULTIPLIER).toBeGreaterThan(1);
    });

    it("request timeout > initial reconnect delay", () => {
      expect(WS_REQUEST_TIMEOUT_MS).toBeGreaterThan(WS_RECONNECT_INITIAL_MS);
    });

    it("agent warm-up has a finite 30-second safety cap", () => {
      expect(AGENT_WARMUP_TIMEOUT_MS).toBe(30_000);
    });

    it("backoff reaches max within reasonable retries", () => {
      let delay = WS_RECONNECT_INITIAL_MS;
      let retries = 0;
      while (delay < WS_RECONNECT_MAX_MS && retries < 100) {
        delay = Math.min(delay * WS_RECONNECT_MULTIPLIER, WS_RECONNECT_MAX_MS);
        retries++;
      }
      expect(retries).toBeLessThan(50);
    });

    describe("agent warm-up", () => {
      it("uses a reserved non-main session and minimal prompt", () => {
        expect(AGENT_WARMUP_SESSION_KEY).toBe("agent:main:__microclaw_warmup__");
        expect(AGENT_WARMUP_SESSION_KEY).not.toBe("agent:main:main");
        expect(AGENT_WARMUP_PROMPT).toBe("ping");
      });
    });
  });

  describe("GatewayStatus type", () => {
    it("accepts all valid status values", () => {
      const statuses: GatewayStatus[] = [
        "stopped",
        "starting",
        "running",
        "restarting",
        "failed",
        "stopping",
        "timeout",
      ];
      expect(statuses).toHaveLength(7);
    });
  });

  describe("sandbox permission timeout", () => {
    it("SANDBOX_PERMISSION_TIMEOUT_MS is 60s", () => {
      expect(SANDBOX_PERMISSION_TIMEOUT_MS).toBe(60_000);
    });

    it("SANDBOX_PERMISSION_TIMEOUT_MS > 0 (not infinite)", () => {
      expect(SANDBOX_PERMISSION_TIMEOUT_MS).toBeGreaterThan(0);
    });
  });
});
