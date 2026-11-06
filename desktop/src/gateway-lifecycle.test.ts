import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import {
  applyAgentRosterReload,
  getGatewayProcessStdio,
  getGatewayStartupFailure,
  hardRestartGateway,
  isApplicationServiceReadyState,
  isGatewayServiceReady,
  requiresExternalGatewayStop,
  shouldRetryGatewayStartup,
  waitForAgentRosterReload,
} from "./gateway-lifecycle";

function rosterReloadClock() {
  let elapsedMs = 0;
  return {
    now: () => elapsedMs,
    advance: (milliseconds: number) => {
      elapsedMs += milliseconds;
    },
    sleep: vi.fn(async (milliseconds: number) => {
      elapsedMs += milliseconds;
    }),
  };
}

describe("Gateway startup convergence", () => {
  it("reports rejected configuration as failure rather than a health-check timeout", () => {
    expect(getGatewayStartupFailure(18789, 78, null)).toEqual({
      status: "failed",
      message: "Gateway rejected its configuration (exit 78); see the Gateway log",
    });
  });

  it("distinguishes process exits, termination signals, spawn errors and actual timeouts", () => {
    expect(getGatewayStartupFailure(18789, 1, null)).toMatchObject({ status: "failed" });
    expect(getGatewayStartupFailure(18789, 0, null)).toMatchObject({ status: "failed" });
    expect(getGatewayStartupFailure(18789, null, "SIGTERM")).toEqual({
      status: "failed",
      message: "Gateway exited during startup (signal SIGTERM)",
    });
    expect(getGatewayStartupFailure(18789, null, null, new Error("ENOENT"))).toEqual({
      status: "failed",
      message: "Gateway spawn failed: ENOENT",
    });
    expect(getGatewayStartupFailure(18789, null, null)).toEqual({
      status: "timeout",
      message: "Gateway health check timed out on port 18789",
    });
  });

  it("keeps terminal startup failure separate from the timeout recovery connection", () => {
    const main = readFileSync(path.join(__dirname, "main.ts"), "utf8");
    expect(main).toContain("getGatewayStartupFailure(");
    expect(main).toContain("setGatewayStatus(failure.status)");
    expect(main).toContain('if (failure.status === "failed") return;');
  });

  it.each<NodeJS.Platform>(["win32", "linux", "darwin"])(
    "preserves the stdin lifeline with platform-compatible handles on %s",
    (platform) => {
      expect(getGatewayProcessStdio(platform)).toEqual([
        platform === "win32" ? "overlapped" : "pipe",
        "pipe",
        "pipe",
        "ipc",
      ]);
    },
  );

  it("uses the native host lifeline for owned Gateway processes", () => {
    const main = readFileSync(path.join(__dirname, "main.ts"), "utf8");
    expect(main).toContain('OPENCLAW_GATEWAY_HOST_LIFELINE: "stdin"');
    expect(main).toContain("stdio: getGatewayProcessStdio()");
    const gracefulStop = main.slice(
      main.indexOf("async function stopGatewayProcessGracefully("),
      main.indexOf("function getGatewayListenerPids("),
    );
    expect(gracefulStop).toContain("timeoutMs: GATEWAY_GRACEFUL_STOP_TIMEOUT_MS");
    expect(gracefulStop).not.toContain("timeoutMs: 10_000,\n      forceTimeoutMs:");
    const restart = main.slice(
      main.indexOf("async function restartManagedGateway("),
      main.indexOf("function isManagedGatewayProcessAlive("),
    );
    expect(restart).toContain("() => stopGatewayProcessGracefully(reason)");
    const securityStop = main.slice(
      main.indexOf("async function stopGatewayForSecurityTransition("),
      main.indexOf("async function failClosedWindowsNodeMxc("),
    );
    expect(securityStop).toContain("terminateGatewayProcessTree(managedPid)");
    expect(securityStop).not.toContain("stopGatewayProcessGracefully");
  });

  it("does not restart or gate chat for a pending optional channel", () => {
    const main = readFileSync(path.join(__dirname, "main.ts"), "utf8");
    const channelCheck = main.slice(
      main.indexOf("async function completePostSpawnChannelStartup("),
      main.indexOf("function connectGatewayWs("),
    );
    expect(channelCheck).not.toContain("restartManagedGateway");
    expect(main).not.toContain("postSpawnRestartDone");
    expect(main).not.toContain("postSpawnRestartScheduled");
    const connection = main.slice(
      main.indexOf("function connectGatewayWs("),
      main.indexOf("onDisconnected: (reason) =>", main.indexOf("function connectGatewayWs(")),
    );
    expect(connection.indexOf("notifyRendererApplicationReady()")).toBeLessThan(
      connection.indexOf("void completePostSpawnChannelStartup("),
    );
  });

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
      main.indexOf("function isManagedGatewayProcessAlive("),
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
    const time = rosterReloadClock();
    const listAgentIds = vi
      .fn()
      .mockRejectedValueOnce(new Error("reload in progress"))
      .mockResolvedValueOnce(new Set(["main"]))
      .mockResolvedValueOnce(new Set(["main", "code-geek"]));
    await expect(
      waitForAgentRosterReload({
        ...time,
        listAgentIds,
        isApplied: (agentIds) => agentIds.has("code-geek"),
        timeoutMs: 300,
        pollMs: 100,
      }),
    ).resolves.toBe(true);

    expect(listAgentIds).toHaveBeenCalledTimes(3);
    expect(time.sleep).toHaveBeenCalledTimes(2);
  });

  it("returns false when the roster condition is not applied before timeout", async () => {
    const time = rosterReloadClock();
    const listAgentIds = vi.fn().mockResolvedValue(new Set(["main"]));

    await expect(
      waitForAgentRosterReload({
        ...time,
        listAgentIds,
        isApplied: (agentIds) => agentIds.has("code-geek"),
        timeoutMs: 300,
        pollMs: 100,
      }),
    ).resolves.toBe(false);

    expect(listAgentIds).toHaveBeenCalledTimes(3);
    expect(time.now()).toBe(300);
  });

  it("includes slow roster reads in the deadline and caps the final sleep", async () => {
    const time = rosterReloadClock();
    const listAgentIds = vi.fn(async () => {
      time.advance(220);
      return new Set(["main"]);
    });

    await expect(
      waitForAgentRosterReload({
        ...time,
        listAgentIds,
        isApplied: (agentIds) => agentIds.has("code-geek"),
        timeoutMs: 300,
        pollMs: 100,
      }),
    ).resolves.toBe(false);

    expect(listAgentIds).toHaveBeenCalledExactlyOnceWith(300);
    expect(time.sleep).toHaveBeenCalledExactlyOnceWith(80);
    expect(time.now()).toBe(300);
  });

  it("passes the remaining budget to each roster read and rejects late success", async () => {
    const time = rosterReloadClock();
    const listAgentIds = vi
      .fn()
      .mockImplementationOnce(async () => {
        time.advance(120);
        return new Set(["main"]);
      })
      .mockImplementationOnce(async () => {
        time.advance(80);
        return new Set(["main", "code-geek"]);
      });

    await expect(
      waitForAgentRosterReload({
        ...time,
        listAgentIds,
        isApplied: (agentIds) => agentIds.has("code-geek"),
        timeoutMs: 300,
        pollMs: 100,
      }),
    ).resolves.toBe(false);

    expect(listAgentIds.mock.calls).toEqual([[300], [80]]);
    expect(time.sleep).toHaveBeenCalledExactlyOnceWith(100);
    expect(time.now()).toBe(300);
  });

  it("bounds a hanging read and safely consumes a rejection after timeout", async () => {
    vi.useFakeTimers();
    try {
      let rejectRead!: (error: Error) => void;
      const listAgentIds = vi.fn(
        () =>
          new Promise<ReadonlySet<string>>((_resolve, reject) => {
            rejectRead = reject;
          }),
      );
      const sleep = vi.fn();
      const response = waitForAgentRosterReload({
        listAgentIds,
        isApplied: (agentIds) => agentIds.has("code-geek"),
        sleep,
        now: Date.now,
        timeoutMs: 300,
        pollMs: 100,
      });
      const settled = expect(response).resolves.toBe(false);

      await vi.advanceTimersByTimeAsync(300);
      await settled;
      rejectRead(new Error("late roster failure"));
      await Promise.resolve();
      expect(listAgentIds).toHaveBeenCalledExactlyOnceWith(300);
      expect(sleep).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not start a roster read when the budget is zero", async () => {
    const listAgentIds = vi.fn();
    await expect(
      waitForAgentRosterReload({
        ...rosterReloadClock(),
        listAgentIds,
        isApplied: () => true,
        timeoutMs: 0,
        pollMs: 100,
      }),
    ).resolves.toBe(false);
    expect(listAgentIds).not.toHaveBeenCalled();
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid timeout budget %s",
    async (timeoutMs) => {
      await expect(
        waitForAgentRosterReload({
          ...rosterReloadClock(),
          listAgentIds: vi.fn(),
          isApplied: () => false,
          timeoutMs,
          pollMs: 100,
        }),
      ).rejects.toThrow("agent roster reload timeout must be finite and non-negative");
    },
  );

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects an invalid polling interval %s",
    async (pollMs) => {
      await expect(
        waitForAgentRosterReload({
          ...rosterReloadClock(),
          listAgentIds: vi.fn(),
          isApplied: () => false,
          timeoutMs: 300,
          pollMs,
        }),
      ).rejects.toThrow("agent roster reload poll interval must be positive");
    },
  );
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
    const time = rosterReloadClock();
    const restartGateway = vi.fn().mockResolvedValue(undefined);

    await expect(
      applyAgentRosterReload({
        ...time,
        listAgentIds: async () => new Set(["main"]),
        isApplied: (agentIds) => agentIds.has("code-geek"),
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
        ...rosterReloadClock(),
        listAgentIds: async () => new Set(["main"]),
        isApplied: (agentIds) => agentIds.has("code-geek"),
        timeoutMs: 300,
        pollMs: 100,
      }),
    ).resolves.toBe("timed-out");
  });

  it("restarts only once at the deadline even if a roster read never settles", async () => {
    vi.useFakeTimers();
    try {
      const restartGateway = vi.fn().mockResolvedValue(undefined);
      const listAgentIds = vi.fn(() => new Promise<ReadonlySet<string>>(() => {}));
      const response = applyAgentRosterReload({
        listAgentIds,
        isApplied: () => false,
        sleep: vi.fn(),
        now: Date.now,
        timeoutMs: 300,
        pollMs: 100,
        restartGateway,
      });
      const settled = expect(response).resolves.toBe("restarted");

      await vi.advanceTimersByTimeAsync(299);
      expect(restartGateway).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await settled;
      expect(restartGateway).toHaveBeenCalledOnce();
      expect(listAgentIds).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
