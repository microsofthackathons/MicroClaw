import { describe, expect, it, vi } from "vitest";
import {
  checkDockerPrerequisites,
  parseDockerInfo,
  parseWslState,
  resolveDockerExecutable,
  type CommandRunner,
} from "./docker-prerequisites";

const ok = (stdout = "") => ({ exitCode: 0, stdout, stderr: "" });

describe("parseWslState", () => {
  it("requires an installed WSL2 distribution", () => {
    expect(parseWslState(ok("Default Version: 2"), ok("NAME STATE VERSION"))).toMatchObject({
      reason: "wsl-no-distribution",
    });
    expect(parseWslState(ok(), ok("Ubuntu Stopped 1"))).toMatchObject({
      reason: "wsl2-distribution-missing",
    });
    expect(parseWslState(ok(), ok("* Ubuntu Running 2"))).toMatchObject({
      status: "ready",
    });
  });

  it("normalizes kernel and reboot guidance", () => {
    expect(parseWslState(ok("Kernel update required"), ok())).toMatchObject({
      reason: "wsl-kernel-update-required",
    });
    expect(parseWslState(ok("Restart required"), ok())).toMatchObject({
      reason: "wsl-reboot-required",
    });
  });
});

describe("parseDockerInfo", () => {
  it("detects unavailable daemon and Windows container mode", () => {
    expect(
      parseDockerInfo({ exitCode: 1, stdout: "", stderr: "cannot connect" }).daemon,
    ).toMatchObject({ reason: "docker-daemon-unavailable" });
    expect(
      parseDockerInfo(ok('{"OSType":"windows","OperatingSystem":"Docker Desktop"}'))
        .linuxContainers,
    ).toMatchObject({ reason: "docker-linux-containers-required" });
    expect(
      parseDockerInfo(ok('{"OSType":"linux","OperatingSystem":"Docker Desktop"}')).linuxContainers
        .status,
    ).toBe("ready");
  });

  it("does not treat a remote Linux engine as Docker Desktop", () => {
    expect(
      parseDockerInfo(ok('{"OSType":"linux","OperatingSystem":"Ubuntu 24.04 LTS"}')).daemon,
    ).toMatchObject({ status: "unsupported", reason: "docker-desktop-required" });
  });
});

describe("checkDockerPrerequisites", () => {
  it("reports complete readiness without mutating commands", async () => {
    const runner = vi.fn<CommandRunner>(async (executable, args) => {
      if (executable === "wsl.exe" && args[0] === "--status") return ok("Default Version: 2");
      if (executable === "wsl.exe") return ok("* Ubuntu Running 2");
      if (args[0] === "--version") return ok("Docker version 27.0.0");
      return ok('{"OSType":"linux","OperatingSystem":"Docker Desktop"}');
    });
    const result = await checkDockerPrerequisites(runner, {
      platform: "win32",
      osRelease: "10.0.22631",
      dockerExecutable: "docker.exe",
    });
    expect(result.ready).toBe(true);
    expect(runner.mock.calls.map((call) => call[1])).toEqual(
      expect.arrayContaining([
        ["--status"],
        ["--list", "--verbose"],
        ["--version"],
        ["info", "--format", "{{json .}}"],
      ]),
    );
  });

  it("reports missing executables and bounded timeouts independently", async () => {
    const runner: CommandRunner = async (executable, args) => {
      if (executable === "wsl.exe") {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      if (args[0] === "--version") return ok("Docker version 27.0.0");
      throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
    };
    const result = await checkDockerPrerequisites(runner, {
      platform: "win32",
      osRelease: "10.0.22631",
      dockerExecutable: "docker.exe",
    });
    expect(result.wslCommand.reason).toBe("wsl-command-missing");
    expect(result.dockerCli.status).toBe("ready");
    expect(result.dockerDaemon.reason).toBe("docker-check-timeout");
    expect(result.ready).toBe(false);
  });

  it("keeps WSL command availability independent from a WSL2 query timeout", async () => {
    const runner: CommandRunner = async (executable, args) => {
      if (executable === "wsl.exe" && args[0] === "--status") return ok("Default Version: 2");
      if (executable === "wsl.exe") {
        throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    };
    const result = await checkDockerPrerequisites(runner, {
      platform: "win32",
      osRelease: "10.0.22631",
      dockerExecutable: "docker.exe",
    });
    expect(result.wslCommand).toMatchObject({ status: "ready", reason: "ready" });
    expect(result.wsl2).toMatchObject({ status: "error", reason: "wsl-check-timeout" });
  });
});

describe("resolveDockerExecutable", () => {
  it("checks Docker Desktop's common install path before PATH", () => {
    const expected = "C:\\Program Files\\Docker\\Docker\\resources\\bin\\docker.exe";
    expect(
      resolveDockerExecutable(
        { ProgramFiles: "C:\\Program Files" },
        (candidate) => candidate === expected,
      ),
    ).toBe(expected);
  });
});
