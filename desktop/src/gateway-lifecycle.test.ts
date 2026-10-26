import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
  applyAgentRosterReload,
  hardRestartGateway,
  isApplicationServiceReadyState,
  isGatewayServiceReady,
  requiresExternalGatewayStop,
  shouldRetryGatewayStartup,
  waitForAgentRosterReload,
} from "./gateway-lifecycle";

describe("Gateway startup convergence", () => {
  it("keeps runtime self-updating out of the Desktop-managed Gateway lifecycle", () => {
    const main = readFileSync(path.join(__dirname, "main.ts"), "utf8");
    expect(main).toContain('OPENCLAW_NO_AUTO_UPDATE: "1"');
    expect(main).toContain("return checkForUpdates({");
  });
  it("never provisions the retired AppContainer backend during Gateway startup", () => {
    const main = readFileSync(path.join(__dirname, "main.ts"), "utf8");
    const spawn = main.indexOf("const child = spawn(nodePath, gwArgs");
    expect(main).not.toContain("toolSandbox");
    expect(main).not.toContain("AppContainerLauncher");
    expect(spawn).toBeGreaterThan(0);
  });
  const refusal =
    "OpenClaw plugin migration inputs changed during startup convergence; refusing to report the gateway ready. " +
    "Restart OpenClaw so state migrations run against the final config and plugin inventory.";
  it("allows a bounded fresh startup only for the runtime's explicit convergence restart request", () => {
    expect(shouldRetryGatewayStartup(1, refusal, 1)).toBe(true);
    expect(shouldRetryGatewayStartup(1, refusal, 0)).toBe(false);
    expect(shouldRetryGatewayStartup(78, refusal, 1)).toBe(false);
    expect(shouldRetryGatewayStartup(1, "Invalid config", 1)).toBe(false);
    expect(shouldRetryGatewayStartup(null, refusal, 1)).toBe(false);
  });
});

describe("requiresExternalGatewayStop", () => {
  it("protects an unowned listener when the roster must be reloaded", () => {
    expect(requiresExternalGatewayStop(true, true, false, false)).toBe(true);
  });

  describe("isGatewayServiceReady", () => {
    it("reports general UI readiness independently from protected chat ingress", () => {
      expect(isGatewayServiceReady(true, true)).toBe(true);
      expect(isGatewayServiceReady(false, true)).toBe(false);
      expect(isGatewayServiceReady(true, false)).toBe(false);
    });

    describe("isApplicationServiceReadyState", () => {
      it("releases remembered OFF startup when the Gateway is connected", () => {
        expect(isApplicationServiceReadyState(true, true, false, true)).toBe(true);
      });

      it("keeps remembered ON startup and toggles gated until protected ingress releases", () => {
        expect(isApplicationServiceReadyState(true, true, true, false)).toBe(false);
        expect(isApplicationServiceReadyState(true, true, false, false)).toBe(false);
        expect(isApplicationServiceReadyState(true, true, false, true)).toBe(true);
      });
    });
  });

  it("allows a managed Gateway to restart for a roster change", () => {
    expect(requiresExternalGatewayStop(true, true, true, true)).toBe(false);
  });

  it("allows an unchanged external Gateway to be reused", () => {
    expect(requiresExternalGatewayStop(true, false, false, false)).toBe(false);
  });
});

describe("hardRestartGateway", () => {
  it("notifies the renderer of a managed disconnect before stopping the client", () => {
    const main = readFileSync(path.join(__dirname, "main.ts"), "utf8");
    const restart = main.slice(
      main.indexOf("async function restartManagedGateway("),
      main.indexOf("async function restartManagedGatewayAndRequireReady("),
    );
    const notification = restart.indexOf(
      'sendToWindow(mainWindow, "gateway:ws-disconnected", reason)',
    );
    const stopClient = restart.indexOf("stopClient: () => gwClient?.stop()");

    expect(notification).toBeGreaterThan(0);
    expect(stopClient).toBeGreaterThan(notification);
  });

  it("waits for verified asynchronous shutdown and does not start after a shutdown failure", async () => {
    let stopped!: () => void;
    const shutdown = new Promise<void>((resolve) => {
      stopped = resolve;
    });
    const startGateway = vi.fn(async () => {});
    const dependencies = {
      stopClient: vi.fn(),
      stopProcess: vi.fn(() => shutdown),
      isPortOccupied: vi.fn(async () => false),
      startGateway,
      sleep: vi.fn(async () => {}),
      timeoutMs: 1000,
      pollMs: 100,
    };
    const restart = hardRestartGateway(dependencies);
    await Promise.resolve();
    expect(startGateway).not.toHaveBeenCalled();
    stopped();
    await restart;
    expect(startGateway).toHaveBeenCalledOnce();
    startGateway.mockClear();
    dependencies.stopProcess.mockRejectedValueOnce(new Error("Old Gateway is still alive"));
    await expect(hardRestartGateway(dependencies)).rejects.toThrow("still alive");
    expect(startGateway).not.toHaveBeenCalled();
  });

  it("stops the client and process, waits for the port, then starts", async () => {
    const order: string[] = [];
    const occupied = [true, true, false];

    await hardRestartGateway({
      stopClient: () => order.push("client"),
      stopProcess: () => {
        order.push("process");
      },
      isPortOccupied: async () => occupied.shift() ?? false,
      startGateway: async () => {
        order.push("start");
      },
      sleep: async () => {
        order.push("sleep");
      },
      timeoutMs: 1_500,
      pollMs: 500,
    });

    expect(order).toEqual(["client", "process", "sleep", "sleep", "start"]);
  });

  it("does not start while the old port remains occupied", async () => {
    const startGateway = vi.fn();

    await expect(
      hardRestartGateway({
        stopClient: vi.fn(),
        stopProcess: vi.fn(),
        isPortOccupied: async () => true,
        startGateway,
        sleep: async () => {},
        timeoutMs: 1_000,
        pollMs: 500,
      }),
    ).rejects.toThrow(/port remained occupied/);
    expect(startGateway).not.toHaveBeenCalled();
  });

  it("checks at least once when the timeout is shorter than the poll interval", async () => {
    const isPortOccupied = vi.fn().mockResolvedValue(false);
    const startGateway = vi.fn().mockResolvedValue(undefined);

    await hardRestartGateway({
      stopClient: vi.fn(),
      stopProcess: vi.fn(),
      isPortOccupied,
      startGateway,
      sleep: vi.fn(),
      timeoutMs: 1,
      pollMs: 500,
    });

    expect(isPortOccupied).toHaveBeenCalledOnce();
    expect(startGateway).toHaveBeenCalledOnce();
  });
});

describe("waitForAgentRosterReload", () => {
  it("returns immediately when the roster condition is already applied", async () => {
    const listAgentIds = vi.fn().mockResolvedValue(new Set(["main", "code-geek"]));
    const sleep = vi.fn();

    await expect(
      waitForAgentRosterReload({
        listAgentIds,
        isApplied: (agentIds) => agentIds.has("code-geek"),
        sleep,
        timeoutMs: 3_000,
        pollMs: 100,
      }),
    ).resolves.toBe(true);

    expect(listAgentIds).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it("retries transient reads until the roster condition is applied", async () => {
    const listAgentIds = vi
      .fn()
      .mockRejectedValueOnce(new Error("reload in progress"))
      .mockResolvedValueOnce(new Set(["main"]))
      .mockResolvedValueOnce(new Set(["main", "code-geek"]));
    const sleep = vi.fn().mockResolvedValue(undefined);

    await expect(
      waitForAgentRosterReload({
        listAgentIds,
        isApplied: (agentIds) => agentIds.has("code-geek"),
        sleep,
        timeoutMs: 300,
        pollMs: 100,
      }),
    ).resolves.toBe(true);

    expect(listAgentIds).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("returns false when the roster condition is not applied before timeout", async () => {
    const listAgentIds = vi.fn().mockResolvedValue(new Set(["main"]));

    await expect(
      waitForAgentRosterReload({
        listAgentIds,
        isApplied: (agentIds) => agentIds.has("code-geek"),
        sleep: vi.fn().mockResolvedValue(undefined),
        timeoutMs: 300,
        pollMs: 100,
      }),
    ).resolves.toBe(false);

    expect(listAgentIds).toHaveBeenCalledTimes(3);
  });
});

describe("applyAgentRosterReload", () => {
  it("does not restart when OpenClaw hot-applies the roster", async () => {
    const restartGateway = vi.fn();

    await expect(
      applyAgentRosterReload({
        listAgentIds: async () => new Set(["main", "code-geek"]),
        isApplied: (agentIds) => agentIds.has("code-geek"),
        sleep: vi.fn(),
        timeoutMs: 300,
        pollMs: 100,
        restartGateway,
      }),
    ).resolves.toBe("hot-reloaded");

    expect(restartGateway).not.toHaveBeenCalled();
  });

  it("restarts a managed Gateway only after the hot-reload timeout", async () => {
    const restartGateway = vi.fn().mockResolvedValue(undefined);

    await expect(
      applyAgentRosterReload({
        listAgentIds: async () => new Set(["main"]),
        isApplied: (agentIds) => agentIds.has("code-geek"),
        sleep: vi.fn().mockResolvedValue(undefined),
        timeoutMs: 300,
        pollMs: 100,
        restartGateway,
      }),
    ).resolves.toBe("restarted");

    expect(restartGateway).toHaveBeenCalledOnce();
  });

  it("reports timeout without restarting an externally managed Gateway", async () => {
    await expect(
      applyAgentRosterReload({
        listAgentIds: async () => new Set(["main"]),
        isApplied: (agentIds) => agentIds.has("code-geek"),
        sleep: vi.fn().mockResolvedValue(undefined),
        timeoutMs: 300,
        pollMs: 100,
      }),
    ).resolves.toBe("timed-out");
  });
});
