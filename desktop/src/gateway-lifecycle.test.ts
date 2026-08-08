import { describe, expect, it, vi } from "vitest";
import {
  applyAgentRosterReload,
  hardRestartGateway,
  requiresExternalGatewayStop,
  waitForAgentRosterReload,
} from "./gateway-lifecycle";

describe("requiresExternalGatewayStop", () => {
  it("protects an unowned listener when the roster must be reloaded", () => {
    expect(requiresExternalGatewayStop(true, true, false, false)).toBe(true);
  });

  it("allows a managed Gateway to restart for a roster change", () => {
    expect(requiresExternalGatewayStop(true, true, true, true)).toBe(false);
  });

  it("allows an unchanged external Gateway to be reused", () => {
    expect(requiresExternalGatewayStop(true, false, false, false)).toBe(false);
  });
});

describe("hardRestartGateway", () => {
  it("stops the client and process, waits for the port, then starts", async () => {
    const order: string[] = [];
    const occupied = [true, true, false];

    await hardRestartGateway({
      stopClient: () => order.push("client"),
      stopProcess: () => order.push("process"),
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
