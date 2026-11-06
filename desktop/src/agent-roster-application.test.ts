import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AgentRosterRollbackError,
  applyAgentRosterConfig,
  assertAgentRosterHotReloadAvailable,
  waitForAgentRuntimeApplied,
} from "./agent-roster-application";

const stateDir = path.resolve("test-agent-state");
const original = {
  agents: { entries: { main: { skills: [] } } },
  skills: { entries: { "rednote-publisher": { enabled: false } } },
};
const added = {
  agents: {
    entries: {
      main: { skills: [] },
      "creative-muse": {
        skills: ["Rednote Publisher"],
        workspace: path.join(stateDir, "workspace-creative-muse"),
      },
    },
  },
  skills: { entries: { "rednote-publisher": { enabled: true } } },
};
const installedSkill = {
  name: "Rednote Publisher",
  skillKey: "rednote-publisher",
  disabled: false,
  eligible: false,
  filePath: path.join(stateDir, "skills", "rednote-publisher", "SKILL.md"),
};

function fixture(config: typeof added | typeof original = added) {
  const snapshot = {
    config,
    valid: true,
    configRevisionHash: "revision-1",
    appliedConfigHash: "revision-1",
  };
  const report: { skills: unknown[] } = { skills: [installedSkill] };
  const roster: { agents: unknown[] } = {
    agents: Object.keys(config.agents.entries).map((id) => ({ id })),
  };
  const gateway = {
    connected: true,
    connectionGeneration: 1,
    methods: ["config.get", "agents.list", "skills.status"],
    request: vi.fn(async (method: string, _params?: unknown, _timeoutMs?: number) => {
      if (method === "config.get") return snapshot;
      if (method === "agents.list") return roster;
      if (method === "skills.status") return report;
      throw new Error(`Unexpected method ${method}`);
    }),
  };
  const isCurrent = vi.fn(() => true);
  const wait = (verifyOwnedSkills = true) =>
    waitForAgentRuntimeApplied({
      gateway,
      isCurrent,
      config,
      agentId: "creative-muse",
      stateDir,
      verifyOwnedSkills,
      timeoutMs: 300,
      now: Date.now,
    });
  return { gateway, snapshot, report, roster, isCurrent, wait };
}

describe("agent hot update prerequisites", () => {
  it.each([undefined, "hot", "hybrid"])("accepts hot reload mode %s", (mode) => {
    expect(() =>
      assertAgentRosterHotReloadAvailable({ gateway: { reload: { mode } } }, fixture().gateway),
    ).not.toThrow();
  });

  it.each(["off", "restart"])("rejects mode %s before changing configuration", (mode) => {
    expect(() =>
      assertAgentRosterHotReloadAvailable({ gateway: { reload: { mode } } }, fixture().gateway),
    ).toThrow("Enable Gateway hot reload");
  });

  it("rejects disconnected or unsupported Gateways", () => {
    expect(() => assertAgentRosterHotReloadAvailable({}, null)).toThrow("not connected");
    const { gateway } = fixture();
    gateway.methods = ["agents.list"];
    expect(() => assertAgentRosterHotReloadAvailable({}, gateway)).toThrow(
      "verified agent hot updates",
    );
  });

  it("requires a watcher for file-only changes but not for skill configuration changes", () => {
    const { gateway } = fixture();
    const config = { skills: { load: { watch: false } } };
    expect(() => assertAgentRosterHotReloadAvailable(config, gateway)).not.toThrow();
    expect(() => assertAgentRosterHotReloadAvailable(config, gateway, true)).toThrow(
      "skills.load.watch",
    );
  });
});

describe("agent runtime verification", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("confirms the applied revision, roster and enabled managed skill even with missing dependencies", async () => {
    const { gateway, wait } = fixture();
    await expect(wait()).resolves.toBe(true);
    expect(gateway.request.mock.calls.map(([method]) => method)).toEqual([
      "config.get",
      "agents.list",
      "skills.status",
      "config.get",
    ]);
    expect(gateway.request).toHaveBeenCalledWith(
      "skills.status",
      { agentId: "creative-muse" },
      expect.any(Number),
    );
    for (const [, , timeoutMs] of gateway.request.mock.calls) {
      expect(timeoutMs).toBeGreaterThan(0);
      expect(timeoutMs).toBeLessThanOrEqual(300);
    }
  });

  it("verifies removals without querying a deleted agent or deleting skill files", async () => {
    const { gateway, wait } = fixture(original);
    await expect(wait()).resolves.toBe(true);
    expect(gateway.request.mock.calls.map(([method]) => method)).toEqual([
      "config.get",
      "agents.list",
      "config.get",
    ]);
  });

  it("can verify rollback to an existing agent whose skill was already disabled", async () => {
    const config = { ...added, skills: original.skills };
    const { gateway, report, wait } = fixture(config);
    report.skills = [{ ...installedSkill, disabled: true }];
    await expect(wait(false)).resolves.toBe(true);
    expect(gateway.request.mock.calls.some(([method]) => method === "skills.status")).toBe(false);
  });

  it.each(["unapplied", "invalid", "wrong roster", "wrong skill config"])(
    "does not accept an agent list while its config is %s",
    async (problem) => {
      const { snapshot, gateway, wait } = fixture();
      if (problem === "unapplied") snapshot.appliedConfigHash = "old-revision";
      if (problem === "invalid") snapshot.valid = false;
      if (problem === "wrong roster") snapshot.config = original;
      if (problem === "wrong skill config") snapshot.config = { ...added, skills: original.skills };
      const result = wait();
      await vi.advanceTimersByTimeAsync(300);
      await expect(result).resolves.toBe(false);
      expect(gateway.request.mock.calls.every(([method]) => method === "config.get")).toBe(true);
    },
  );

  it.each([
    { skills: [] },
    { skills: [{ ...installedSkill, disabled: true }] },
    { skills: [{ ...installedSkill, blockedByAllowlist: true }] },
    { skills: [{ ...installedSkill, blockedByAgentFilter: true }] },
    {
      skills: [
        { ...installedSkill, filePath: path.join(stateDir, "workspace", "skills", "SKILL.md") },
      ],
    },
  ])("rejects absent, disabled or shadowed owned skills: %j", async ({ skills }) => {
    const { report, wait } = fixture();
    report.skills = skills;
    const result = wait();
    await vi.advanceTimersByTimeAsync(300);
    await expect(result).resolves.toBe(false);
  });

  it("waits through transient config reads until the revision and roster agree", async () => {
    const { gateway, wait } = fixture();
    gateway.request.mockRejectedValueOnce(new Error("config swap"));
    const result = wait();
    await vi.advanceTimersByTimeAsync(100);
    await expect(result).resolves.toBe(true);
  });

  it("rejects a runtime roster that drops another agent", async () => {
    const { roster, wait } = fixture();
    roster.agents = [{ id: "creative-muse" }];
    const result = wait();
    await vi.advanceTimersByTimeAsync(300);
    await expect(result).resolves.toBe(false);
  });

  it("does not report success across a reconnect", async () => {
    const { gateway, wait } = fixture();
    gateway.request.mockImplementationOnce(async () => {
      gateway.connectionGeneration++;
      return fixture().snapshot;
    });
    const result = wait();
    await vi.advanceTimersByTimeAsync(300);
    await expect(result).resolves.toBe(false);
  });

  it("bounds a hanging RPC by the remaining application deadline", async () => {
    const { gateway, wait } = fixture();
    gateway.request.mockImplementation(() => new Promise(() => {}));
    const result = wait();
    await vi.advanceTimersByTimeAsync(300);
    await expect(result).resolves.toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("agent config transactions", () => {
  function transaction() {
    const originalText = JSON.stringify(original);
    let text = originalText;
    const writeText = vi.fn((value: string) => {
      text = value;
    });
    const waitForApplied = vi.fn(async (_config: unknown) => true);
    const options = {
      originalText,
      config: added,
      readText: () => text,
      writeText,
      waitForApplied,
    };
    return {
      options,
      writeText,
      waitForApplied,
      changeText: (value: string) => {
        text = value;
      },
    };
  }

  it("commits an agent update without any restart operation", async () => {
    const { options, writeText, waitForApplied } = transaction();
    await applyAgentRosterConfig(options);
    expect(writeText).toHaveBeenCalledExactlyOnceWith(JSON.stringify(added, null, 2));
    expect(waitForApplied).toHaveBeenCalledExactlyOnceWith(added);
  });

  it("hot-rolls back a timeout and confirms the previous runtime config", async () => {
    const { options, writeText, waitForApplied } = transaction();
    waitForApplied.mockResolvedValueOnce(false);
    await expect(applyAgentRosterConfig(options)).rejects.toThrow("no restart was attempted");
    expect(writeText.mock.calls.map(([value]) => value)).toEqual([
      JSON.stringify(added, null, 2),
      options.originalText,
    ]);
    expect(waitForApplied).toHaveBeenLastCalledWith(original);
    expect(options.readText()).toBe(options.originalText);
  });

  it("restores config after a verification error", async () => {
    const { options, waitForApplied } = transaction();
    waitForApplied.mockRejectedValueOnce(new Error("invalid runtime"));
    await expect(applyAgentRosterConfig(options)).rejects.toThrow("invalid runtime");
    expect(options.readText()).toBe(options.originalText);
    expect(waitForApplied).toHaveBeenLastCalledWith(original);
  });

  it("refuses an outdated edit without writing anything", async () => {
    const { options, writeText, changeText } = transaction();
    changeText("concurrent edit");
    await expect(applyAgentRosterConfig(options)).rejects.toThrow("configuration changed");
    expect(writeText).not.toHaveBeenCalled();
  });

  it("does not overwrite a concurrent edit during rollback", async () => {
    const { options, writeText, waitForApplied, changeText } = transaction();
    waitForApplied.mockImplementationOnce(async () => {
      changeText("concurrent edit");
      return false;
    });
    await expect(applyAgentRosterConfig(options)).rejects.toBeInstanceOf(AgentRosterRollbackError);
    expect(options.readText()).toBe("concurrent edit");
    expect(writeText).toHaveBeenCalledOnce();
  });

  it("reports an unconfirmed rollback rather than restarting or claiming restoration", async () => {
    const { options, waitForApplied } = transaction();
    waitForApplied.mockResolvedValue(false);
    await expect(applyAgentRosterConfig(options)).rejects.toBeInstanceOf(AgentRosterRollbackError);
    expect(waitForApplied).toHaveBeenCalledTimes(2);
  });

  it("keeps catalog wiring free of process restarts and immediate skill removal", () => {
    const main = fs.readFileSync(path.join(__dirname, "main.ts"), "utf8");
    const catalog = main.slice(
      main.indexOf("async function applyGatewayAgentRoster("),
      main.indexOf("// Renderer URL"),
    );
    expect(catalog).toContain("applyAgentRosterConfig(");
    expect(catalog).toContain("waitForAgentRuntimeApplied(");
    expect(catalog).not.toContain("restartManagedGateway");
    expect(catalog).not.toContain("prepareUnusedAgentOwnedSkillRemoval");
    expect(catalog).not.toContain("commitAgentOwnedSkillRemovals");
    expect(catalog).toContain("error instanceof AgentRosterRollbackError");
    expect(main).toContain("{ deferRemovals: alreadyRunning }");
  });
});
