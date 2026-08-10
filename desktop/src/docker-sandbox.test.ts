import { describe, expect, it, vi } from "vitest";
import {
  OPENCLAW_SANDBOX_IMAGE,
  REQUIRED_DOCKER_SANDBOX,
  REQUIRED_SANDBOX_TOOLS,
  applyRequiredDockerSandboxConfig,
  canExecuteWithDockerSandbox,
  checkDockerSandboxReadiness,
  parseDockerInfo,
  parseWslState,
  type CommandRunner,
  type DockerSandboxReadiness,
} from "./docker-sandbox";

const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });

describe("Docker sandbox configuration", () => {
  it("enforces Docker-only fail-closed policy and removes per-agent overrides", () => {
    const result = applyRequiredDockerSandboxConfig({
      agents: {
        defaults: { model: "provider/model", sandbox: { mode: "off" } },
        list: [
          {
            id: "main",
            sandbox: { mode: "off" },
            runtime: { type: "acp" },
            tools: { sandbox: { tools: { allow: [] } } },
          },
        ],
      },
      tools: {
        elevated: { enabled: true },
        exec: { host: "gateway" },
        sandbox: { tools: { allow: ["gateway"] } },
      },
      acp: { enabled: true, dispatch: { enabled: true } },
    }).config as {
      agents: {
        defaults: { sandbox: unknown };
        list: Array<{ sandbox?: unknown; runtime?: unknown; tools?: unknown }>;
      };
      tools: {
        elevated: { enabled: boolean };
        exec: { host: string };
        sandbox: { tools: { allow: string[] } };
      };
      acp: { enabled: boolean; dispatch: { enabled: boolean } };
    };
    expect(result.agents.defaults.sandbox).toEqual(REQUIRED_DOCKER_SANDBOX);
    expect(result.agents.list[0].sandbox).toBeUndefined();
    expect(result.agents.list[0].runtime).toBeUndefined();
    expect(result.agents.list[0].tools).toBeUndefined();
    expect(result.tools.elevated.enabled).toBe(false);
    expect(result.tools.exec.host).toBe("sandbox");
    expect(result.tools.sandbox.tools.allow).toEqual(REQUIRED_SANDBOX_TOOLS);
    expect(result.acp).toMatchObject({ enabled: false, dispatch: { enabled: false } });
  });

  it("preserves unrelated model, agent, and tool configuration", () => {
    const result = applyRequiredDockerSandboxConfig({
      agents: { defaults: { model: "provider/model" }, list: [{ id: "main", name: "Assistant" }] },
      tools: { profile: "coding" },
      gateway: { port: 18789 },
    }).config as {
      agents: { defaults: { model: string }; list: Array<{ id: string; name: string }> };
      tools: { profile: string };
      gateway: { port: number };
    };
    expect(result.agents.defaults.model).toBe("provider/model");
    expect(result.agents.list[0]).toMatchObject({ id: "main", name: "Assistant" });
    expect(result.tools.profile).toBe("coding");
    expect(result.gateway.port).toBe(18789);
  });

  it("never permits execution when readiness or mandatory configuration is missing", () => {
    const ready: DockerSandboxReadiness = {
      checkedAt: new Date().toISOString(),
      ready: true,
      reasons: [],
      windows: { status: "ready", reason: "ready" },
      wslCommand: { status: "ready", reason: "ready" },
      wsl2: { status: "ready", reason: "ready" },
      dockerCli: { status: "ready", reason: "ready" },
      dockerDaemon: { status: "ready", reason: "ready" },
      linuxContainers: { status: "ready", reason: "ready" },
      image: { status: "ready", reason: "ready" },
    };
    const enforced = applyRequiredDockerSandboxConfig({}).config;
    expect(canExecuteWithDockerSandbox(ready, enforced)).toBe(true);
    expect(canExecuteWithDockerSandbox({ ...ready, ready: false }, enforced)).toBe(false);
    expect(canExecuteWithDockerSandbox(ready, {})).toBe(false);
  });
});

describe("Docker readiness", () => {
  it("requires an installed WSL2 distribution", () => {
    expect(parseWslState(ok("Default Version: 2"), ok("NAME STATE VERSION"))).toMatchObject({
      reason: "wsl-no-distribution",
    });
    expect(parseWslState(ok(), ok("Ubuntu Stopped 1"))).toMatchObject({
      reason: "wsl2-distribution-missing",
    });
    expect(parseWslState(ok(), ok("* Ubuntu Running 2"))).toMatchObject({ status: "ready" });
  });

  it("distinguishes Docker Desktop from remote and Windows engines", () => {
    expect(
      parseDockerInfo(ok('{"OSType":"linux","OperatingSystem":"Ubuntu 24.04"}')).daemon,
    ).toMatchObject({ reason: "docker-desktop-required" });
    expect(
      parseDockerInfo(ok('{"OSType":"windows","OperatingSystem":"Docker Desktop"}'))
        .linuxContainers,
    ).toMatchObject({ reason: "docker-linux-containers-required" });
  });

  it("requires the pinned sandbox image", async () => {
    const runner = vi.fn<CommandRunner>(async (executable, args) => {
      if (executable === "wsl.exe" && args[0] === "--status") return ok("Default Version: 2");
      if (executable === "wsl.exe") return ok("* Ubuntu Running 2");
      if (args[0] === "--version") return ok("Docker version 27.0.0");
      if (args[0] === "info") {
        return ok('{"OSType":"linux","OperatingSystem":"Docker Desktop"}');
      }
      if (args[0] === "image") return { exitCode: 1, stdout: "", stderr: "No such image" };
      throw new Error(`Unexpected command: ${executable} ${args.join(" ")}`);
    });
    const result = await checkDockerSandboxReadiness(runner, {
      platform: "win32",
      osRelease: "10.0.22631",
      dockerExecutable: "docker.exe",
    });
    expect(result.image).toMatchObject({ status: "missing", reason: "sandbox-image-missing" });
    expect(result.ready).toBe(false);
    expect(runner).toHaveBeenCalledWith(
      "docker.exe",
      ["image", "inspect", OPENCLAW_SANDBOX_IMAGE],
      5_000,
    );
  });

  it("reports WSL and Docker timeouts without fallback", async () => {
    const runner: CommandRunner = async (executable, args) => {
      if (executable === "wsl.exe" && args[0] === "--status") return ok("Default Version: 2");
      if (executable === "wsl.exe") {
        throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    };
    const result = await checkDockerSandboxReadiness(runner, {
      platform: "win32",
      osRelease: "10.0.22631",
      dockerExecutable: "docker.exe",
    });
    expect(result.wslCommand.status).toBe("ready");
    expect(result.wsl2.reason).toBe("wsl-check-timeout");
    expect(result.dockerCli.reason).toBe("docker-cli-missing");
    expect(result.ready).toBe(false);
  });
});
