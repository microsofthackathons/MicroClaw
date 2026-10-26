import { describe, expect, it, vi } from "vitest";
import { spawn } from "child_process";
import { GatewayManager } from "./gateway-manager";
import { resolveNodePath } from "./path-resolver";

vi.mock("child_process", () => ({ spawn: vi.fn() }));
vi.mock("./path-resolver", () => ({
  resolveNodePath: vi.fn(),
  resolveOpenClawEntry: vi.fn(),
  loadStateDirEnv: vi.fn(),
}));

describe("GatewayManager runtime validation", () => {
  it("reports an unsupported runtime without spawning a Gateway or leaving starting status", async () => {
    const manager = new GatewayManager("C:\\MicroClaw\\state", 18789);
    Object.assign(manager, {
      waitForPortAvailable: vi.fn().mockResolvedValue(undefined),
      cleanStaleLockFiles: vi.fn(),
    });
    const statuses = vi.fn();
    const logs = vi.fn();
    manager.on("status", statuses);
    manager.on("log", logs);
    vi.mocked(resolveNodePath).mockImplementation(() => {
      throw new Error("OpenClaw 2026.9.3 requires Node.js >=24.16.0 <25 || >=26.1.0");
    });

    await expect(manager.start()).resolves.toBe(18789);
    expect(statuses.mock.calls).toEqual([["starting"], ["failed"]]);
    expect(logs).toHaveBeenCalledWith(expect.stringContaining(">=24.16.0 <25 || >=26.1.0"));
    expect(spawn).not.toHaveBeenCalled();
  });
});
