import { describe, expect, it, vi } from "vitest";
import {
  buildWindowsNodeMxcLockedToolPolicy,
  buildWindowsNodeMxcToolPolicy,
} from "./windows-node-mxc";
import { promoteWindowsNodeMxcPolicy } from "./windows-node-mxc-policy-promotion";

const nodeId = "a".repeat(64);
const generation = "generation-1";

function config(state: "locked" | "active") {
  return {
    agents: {
      ownership: "explicit",
      entries: {
        main: {
          tools:
            state === "locked"
              ? buildWindowsNodeMxcLockedToolPolicy(nodeId)
              : buildWindowsNodeMxcToolPolicy(nodeId),
        },
      },
    },
    gateway: {
      nodes: {
        commands: {
          allow: [
            "system.run",
            "system.run.readiness",
            "system.run.prepare",
            "system.which",
            "system.run.cwd-policy",
          ],
          deny: [],
        },
      },
    },
    channels: {},
    cron: { enabled: false },
    hooks: { enabled: false, internal: { enabled: false } },
    plugins: { enabled: false, entries: {} },
  };
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
          tools:
            state === "locked"
              ? buildWindowsNodeMxcLockedToolPolicy(nodeId)
              : buildWindowsNodeMxcToolPolicy(nodeId),
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
  it("CAS-patches only agents and verifies the exact applied active revision", async () => {
    const request = vi
      .fn()
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
      }),
    ).resolves.toMatchObject({ appliedHash: "active-hash-applied" });

    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[1][0]).toBe("config.patch");
    expect(JSON.parse(request.mock.calls[1][1].raw)).toEqual({
      agents: config("active").agents,
    });
    expect(request.mock.calls[1][1].replacePaths).toEqual([
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
    });

    expect(request.mock.calls[1][1].replacePaths).toEqual(["agents.list"]);
  });

  it("rolls back to the locked policy when active read-back drifts", async () => {
    const request = vi
      .fn()
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
      }),
    ).rejects.toThrow(/has not been applied/);

    expect(JSON.parse(request.mock.calls[4][1].raw)).toEqual({
      agents: config("locked").agents,
    });
  });

  it("fails closed when rollback cannot be proven", async () => {
    const request = vi
      .fn()
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
      }),
    ).rejects.toThrow(/generation changed/);
    expect(requestCount).toBe(1);
  });
});
