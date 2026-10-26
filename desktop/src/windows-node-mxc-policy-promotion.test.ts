import { describe, expect, it, vi } from "vitest";
import { applyWindowsNodeMxcGatewayPolicy } from "./windows-node-mxc";
import {
  promoteWindowsNodeMxcPolicy,
  waitForWindowsNodeMxcAgentReadiness,
} from "./windows-node-mxc-policy-promotion";

const nodeId = "a".repeat(64);
const generation = "generation-1";
const readinessOptions = {
  agentReadinessTimeoutMs: 5_000,
  agentReadinessPollIntervalMs: 250,
};

function config(state: "locked" | "active") {
  const baseline = {
    agents: {
      ownership: "explicit",
      entries: {
        main: {
          tools: {
            allow: ["read"],
            deny: [],
          },
        },
      },
    },
    gateway: {},
    channels: {},
    cron: { enabled: true },
    hooks: { enabled: true, internal: { enabled: true } },
    plugins: { enabled: true, entries: {}, slots: {} },
  };
  return applyWindowsNodeMxcGatewayPolicy(baseline, nodeId, {}, state).config;
}

function snapshot(state: "locked" | "active", hash: string) {
  return {
    config: config(state),
    hash,
    configRevisionHash: `${hash}-applied`,
    appliedConfigHash: `${hash}-applied`,
  };
}

function legacyConfig(state: "locked" | "active") {
  const base = config(state);
  return {
    ...base,
    agents: {
      list: [
        {
          id: "main",
          tools: (
            (base.agents as { entries: Record<string, { tools: unknown }> }).entries.main
          ).tools,
        },
      ],
    },
  };
}

function patchAck(hash: string) {
  return {
    ok: true,
    hash,
    changedPaths: ["agents.entries.main.tools.allow", "agents.entries.main.tools.deny"],
    sentinel: { payload: { stats: { requiresRestart: false } } },
  };
}

describe("MXC in-process policy promotion", () => {
  it("waits in the locked generation until every agent database is admitted", async () => {
    let now = 0;
    const calls: Array<[string, unknown?]> = [];
    const request = async <T = unknown>(method: string, params?: unknown): Promise<T> => {
      calls.push([method, params]);
      if (method === "config.get") return snapshot("locked", "locked-hash") as T;
      const agentId = (params as { agentId?: string } | undefined)?.agentId;
      if (
        agentId === "main" &&
        calls.filter(([name]) => name === "sessions.list").length < 3
      ) {
        throw Object.assign(new Error("agent database inspection pending"), {
          code: "UNAVAILABLE",
          details: { code: "agent-database-inspection-pending", agentId: "main" },
        });
      }
      return { sessions: [] } as T;
    };

    await expect(
      waitForWindowsNodeMxcAgentReadiness({
        gateway: { request },
        nodeId,
        expectedGeneration: generation,
        currentGeneration: () => generation,
        isCurrent: () => true,
        requestTimeoutMs: 5_000,
        timeoutMs: 5_000,
        pollIntervalMs: 250,
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
      }),
    ).resolves.toBeUndefined();

    expect(calls.map(([method]) => method)).toEqual([
      "config.get",
      "sessions.list",
      "sessions.list",
      "sessions.list",
    ]);
  });

  it("fails immediately when an agent database has a non-retryable admission failure", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(snapshot("locked", "locked-hash"))
      .mockRejectedValueOnce(
        Object.assign(new Error("sensitive database path"), {
          code: "UNAVAILABLE",
          details: { code: "agent-database-inspection-failed", agentId: "main" },
        }),
      );

    let failure: unknown;
    try {
      await waitForWindowsNodeMxcAgentReadiness({
        gateway: { request },
        nodeId,
        expectedGeneration: generation,
        currentGeneration: () => generation,
        isCurrent: () => true,
        requestTimeoutMs: 5_000,
        timeoutMs: 5_000,
        pollIntervalMs: 250,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      'Gateway agent database readiness failed for agent "main": agent-database-inspection-failed',
    );
    expect((failure as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(String(failure)).not.toContain("sensitive database path");
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("does not expose raw config snapshot Gateway failures", async () => {
    const request = vi.fn().mockRejectedValueOnce(
      Object.assign(new Error("sensitive database path"), {
        code: "MALFORMED_SECRET_CODE",
        details: { path: "C:\\sensitive" },
      }),
    );

    let failure: unknown;
    try {
      await waitForWindowsNodeMxcAgentReadiness({
        gateway: { request },
        nodeId,
        expectedGeneration: generation,
        currentGeneration: () => generation,
        isCurrent: () => true,
        requestTimeoutMs: 5_000,
        timeoutMs: 5_000,
        pollIntervalMs: 250,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Gateway config snapshot request failed");
    expect((failure as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(String(failure)).not.toContain("sensitive");
  });

  it("uses the canonical keyed roster when both agent schemas are present", async () => {
    const locked = snapshot("locked", "locked-hash");
    const agents = (locked.config.agents as Record<string, unknown>) ?? {};
    agents.list = [{ id: "decoy", tools: { allow: [], deny: [] } }];
    const request = vi
      .fn()
      .mockResolvedValueOnce(locked)
      .mockResolvedValueOnce({ sessions: [] });

    await waitForWindowsNodeMxcAgentReadiness({
      gateway: { request },
      nodeId,
      expectedGeneration: generation,
      currentGeneration: () => generation,
      isCurrent: () => true,
      requestTimeoutMs: 5_000,
      timeoutMs: 5_000,
      pollIntervalMs: 250,
    });

    expect(request.mock.calls[1][1]).toMatchObject({ agentId: "main" });
  });

  it("times out without promoting while an agent database remains pending", async () => {
    let now = 0;
    const request = vi
      .fn()
      .mockResolvedValueOnce(snapshot("locked", "locked-hash"))
      .mockRejectedValue(
        Object.assign(new Error("agent database inspection pending"), {
          code: "UNAVAILABLE",
          details: { code: "agent-database-inspection-pending", agentId: "main" },
        }),
      );

    await expect(
      waitForWindowsNodeMxcAgentReadiness({
        gateway: { request },
        nodeId,
        expectedGeneration: generation,
        currentGeneration: () => generation,
        isCurrent: () => true,
        requestTimeoutMs: 5_000,
        timeoutMs: 500,
        pollIntervalMs: 250,
        now: () => now,
        sleep: async (milliseconds) => {
          now += milliseconds;
        },
      }),
    ).rejects.toThrow(/timed out after 500ms/);
    expect(request.mock.calls.every(([method]) => method !== "config.patch")).toBe(true);
  });

  it("stops waiting when the managed Gateway generation changes", async () => {
    let currentGeneration = generation;
    const request = vi
      .fn()
      .mockResolvedValueOnce(snapshot("locked", "locked-hash"))
      .mockRejectedValueOnce(
        Object.assign(new Error("agent database inspection pending"), {
          code: "UNAVAILABLE",
          details: { code: "agent-database-inspection-pending", agentId: "main" },
        }),
      );

    await expect(
      waitForWindowsNodeMxcAgentReadiness({
        gateway: { request },
        nodeId,
        expectedGeneration: generation,
        currentGeneration: () => currentGeneration,
        isCurrent: () => true,
        requestTimeoutMs: 5_000,
        timeoutMs: 5_000,
        pollIntervalMs: 250,
        sleep: async () => {
          currentGeneration = "generation-2";
        },
      }),
    ).rejects.toThrow(/generation changed/);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("CAS-patches only agents and verifies the exact applied active revision", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(snapshot("locked", "locked-hash"))
      .mockResolvedValueOnce({ sessions: [] })
      .mockResolvedValueOnce(snapshot("locked", "locked-hash"))
      .mockResolvedValueOnce(patchAck("active-hash"))
      .mockResolvedValueOnce(snapshot("active", "active-hash"));

    await expect(
      promoteWindowsNodeMxcPolicy({
        gateway: { request },
        nodeId,
        backups: {},
        expectedGeneration: generation,
        currentGeneration: () => generation,
        isCurrent: () => true,
        requestTimeoutMs: 5_000,
        ...readinessOptions,
      }),
    ).resolves.toMatchObject({ appliedHash: "active-hash-applied" });

    expect(request).toHaveBeenCalledTimes(5);
    expect(request.mock.calls[3][0]).toBe("config.patch");
    expect(JSON.parse(request.mock.calls[3][1].raw)).toEqual({
      agents: config("active").agents,
    });
    expect(request.mock.calls[3][1].replacePaths).toEqual([
      "agents.entries.main.tools.allow",
      "agents.entries.main.tools.deny",
    ]);
  });

  it("uses an explicit whole-array replacement for a legacy agent roster", async () => {
    const lockedConfig = legacyConfig("locked");
    const activeConfig = legacyConfig("active");
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        config: lockedConfig,
        hash: "locked-hash",
        configRevisionHash: "locked-applied",
        appliedConfigHash: "locked-applied",
      })
      .mockResolvedValueOnce({ sessions: [] })
      .mockResolvedValueOnce({
        config: lockedConfig,
        hash: "locked-hash",
        configRevisionHash: "locked-applied",
        appliedConfigHash: "locked-applied",
      })
      .mockResolvedValueOnce({
        ...patchAck("active-hash"),
        changedPaths: ["agents.list"],
      })
      .mockResolvedValueOnce({
        config: activeConfig,
        hash: "active-hash",
        configRevisionHash: "active-applied",
        appliedConfigHash: "active-applied",
      });

    await promoteWindowsNodeMxcPolicy({
      gateway: { request },
      nodeId,
      backups: {},
      expectedGeneration: generation,
      currentGeneration: () => generation,
      isCurrent: () => true,
      requestTimeoutMs: 5_000,
      ...readinessOptions,
    });

    expect(request.mock.calls[3][1].replacePaths).toEqual(["agents.list"]);
  });

  it("does not promote when the locked revision changes after readiness", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(snapshot("locked", "locked-hash"))
      .mockResolvedValueOnce({ sessions: [] })
      .mockResolvedValueOnce(snapshot("locked", "changed-locked-hash"));

    await expect(
      promoteWindowsNodeMxcPolicy({
        gateway: { request },
        nodeId,
        backups: {},
        expectedGeneration: generation,
        currentGeneration: () => generation,
        isCurrent: () => true,
        requestTimeoutMs: 5_000,
        ...readinessOptions,
      }),
    ).rejects.toThrow(/locked policy changed while agent databases were preparing/);

    expect(request.mock.calls.every(([method]) => method !== "config.patch")).toBe(true);
  });

  it("does not expose raw config patch Gateway failures", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(snapshot("locked", "locked-hash"))
      .mockResolvedValueOnce({ sessions: [] })
      .mockResolvedValueOnce(snapshot("locked", "locked-hash"))
      .mockRejectedValueOnce(
        Object.assign(new Error("sensitive patch detail"), {
          code: "UNAVAILABLE",
          details: { secret: "value" },
        }),
      )
      .mockResolvedValueOnce(snapshot("locked", "locked-hash"))
      .mockResolvedValueOnce(snapshot("locked", "locked-hash"));

    let failure: unknown;
    try {
      await promoteWindowsNodeMxcPolicy({
        gateway: { request },
        nodeId,
        backups: {},
        expectedGeneration: generation,
        currentGeneration: () => generation,
        isCurrent: () => true,
        requestTimeoutMs: 5_000,
        ...readinessOptions,
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe(
      "Gateway MXC policy patch request failed: UNAVAILABLE",
    );
    expect((failure as Error & { cause?: unknown }).cause).toBeUndefined();
    expect(String(failure)).not.toContain("sensitive");
  });

  it("rolls back to the locked policy when active read-back drifts", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(snapshot("locked", "locked-hash"))
      .mockResolvedValueOnce({ sessions: [] })
      .mockResolvedValueOnce(snapshot("locked", "locked-hash"))
      .mockResolvedValueOnce(patchAck("active-hash"))
      .mockResolvedValueOnce({
        ...snapshot("active", "active-hash"),
        appliedConfigHash: "stale-runtime-hash",
      })
      .mockResolvedValueOnce(snapshot("active", "active-hash"))
      .mockResolvedValueOnce(patchAck("rollback-hash"))
      .mockResolvedValueOnce(snapshot("locked", "rollback-hash"));

    await expect(
      promoteWindowsNodeMxcPolicy({
        gateway: { request },
        nodeId,
        backups: {},
        expectedGeneration: generation,
        currentGeneration: () => generation,
        isCurrent: () => true,
        requestTimeoutMs: 5_000,
        ...readinessOptions,
      }),
    ).rejects.toThrow(/has not been applied/);

    expect(JSON.parse(request.mock.calls[6][1].raw)).toEqual({
      agents: config("locked").agents,
    });
  });

  it("fails closed when rollback cannot be proven", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(snapshot("locked", "locked-hash"))
      .mockResolvedValueOnce({ sessions: [] })
      .mockResolvedValueOnce(snapshot("locked", "locked-hash"))
      .mockRejectedValueOnce(new Error("promotion failed"))
      .mockRejectedValueOnce(new Error("rollback snapshot unavailable"));

    await expect(
      promoteWindowsNodeMxcPolicy({
        gateway: { request },
        nodeId,
        backups: {},
        expectedGeneration: generation,
        currentGeneration: () => generation,
        isCurrent: () => true,
        requestTimeoutMs: 5_000,
        ...readinessOptions,
      }),
    ).rejects.toThrow(/rollback also failed/);
  });

  it("rejects a stale generation before issuing config.patch", async () => {
    let currentGeneration = generation;
    let requestCount = 0;
    const request = async <T = unknown>() => {
      requestCount += 1;
      currentGeneration = "generation-2";
      return snapshot("locked", "locked-hash") as T;
    };

    await expect(
      promoteWindowsNodeMxcPolicy({
        gateway: { request },
        nodeId,
        backups: {},
        expectedGeneration: generation,
        currentGeneration: () => currentGeneration,
        isCurrent: () => true,
        requestTimeoutMs: 5_000,
        ...readinessOptions,
      }),
    ).rejects.toThrow(/generation changed/);
    expect(requestCount).toBe(1);
  });
});
