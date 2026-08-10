import { execFile } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export type PrerequisiteStatus = "ready" | "missing" | "not-ready" | "unsupported" | "error";

export type DockerPrerequisiteReason =
  | "ready"
  | "windows-required"
  | "windows-version-unsupported"
  | "wsl-command-missing"
  | "wsl-feature-disabled"
  | "wsl-no-distribution"
  | "wsl2-distribution-missing"
  | "wsl-kernel-update-required"
  | "wsl-reboot-required"
  | "wsl-check-timeout"
  | "wsl-check-failed"
  | "docker-cli-missing"
  | "docker-daemon-unavailable"
  | "docker-desktop-required"
  | "docker-linux-containers-required"
  | "docker-check-timeout"
  | "docker-check-failed";

export interface PrerequisiteState {
  status: PrerequisiteStatus;
  reason: DockerPrerequisiteReason;
  detail?: string;
}

export interface DockerPrerequisites {
  checkedAt: string;
  ready: boolean;
  reasons: DockerPrerequisiteReason[];
  windows: PrerequisiteState;
  wslCommand: PrerequisiteState;
  wsl2: PrerequisiteState;
  dockerCli: PrerequisiteState;
  dockerDaemon: PrerequisiteState;
  linuxContainers: PrerequisiteState;
}

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  executable: string,
  args: readonly string[],
  timeoutMs: number,
) => Promise<CommandResult>;

const COMMAND_TIMEOUT_MS = 5_000;
const MIN_WINDOWS_BUILD = 19041;

function decodeOutput(value: string | Buffer): string {
  if (typeof value === "string") return value.trim();
  const hasUtf16Nulls =
    value.length > 1 && value.subarray(1).filter((byte) => byte === 0).length > 2;
  return value
    .toString(hasUtf16Nulls ? "utf16le" : "utf8")
    .replace(/\0/g, "")
    .trim();
}

export const runCommand: CommandRunner = (executable, args, timeoutMs) =>
  new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      { windowsHide: true, timeout: timeoutMs, maxBuffer: 1024 * 1024, encoding: "buffer" },
      (error, stdout, stderr) => {
        const execError = error as { code?: string | number; killed?: boolean } | null;
        const result = {
          exitCode: typeof execError?.code === "number" ? execError.code : error ? 1 : 0,
          stdout: decodeOutput(stdout),
          stderr: decodeOutput(stderr),
        };
        if (execError?.code === "ENOENT") {
          reject(Object.assign(new Error(`${executable} was not found`), { code: "ENOENT" }));
          return;
        }
        if (execError?.killed || execError?.code === "ETIMEDOUT") {
          reject(Object.assign(new Error(`${executable} timed out`), { code: "ETIMEDOUT" }));
          return;
        }
        resolve(result);
      },
    );
  });

function state(
  status: PrerequisiteStatus,
  reason: DockerPrerequisiteReason,
  detail?: string,
): PrerequisiteState {
  return { status, reason, ...(detail ? { detail } : {}) };
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function combinedOutput(result: CommandResult): string {
  return `${result.stdout}\n${result.stderr}`.trim();
}

export function parseWslState(
  statusResult: CommandResult,
  distributionsResult: CommandResult,
): PrerequisiteState {
  const output = `${combinedOutput(statusResult)}\n${combinedOutput(distributionsResult)}`;
  const normalized = output.toLowerCase();
  if (/restart|reboot|重新启动|重启/.test(normalized)) {
    return state("not-ready", "wsl-reboot-required", output);
  }
  if (/kernel.*(update|required|missing|not found)|更新.*内核|内核.*更新/.test(normalized)) {
    return state("not-ready", "wsl-kernel-update-required", output);
  }
  if (
    /optional component|feature.*(disabled|not enabled)|0x80370102|虚拟机平台|可选组件/.test(
      normalized,
    )
  ) {
    return state("not-ready", "wsl-feature-disabled", output);
  }
  if (statusResult.exitCode !== 0 && distributionsResult.exitCode !== 0) {
    return state("error", "wsl-check-failed", output);
  }

  const distributionLines = distributionsResult.stdout
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\*\s*/, "").trim())
    .filter(
      (line) =>
        line &&
        !/^(name|名称)\s+(state|状态)\s+(version|版本)/i.test(line) &&
        !/^(windows subsystem|适用于 linux)/i.test(line),
    );
  if (
    distributionLines.length === 0 ||
    /no installed distributions|no distributions|未安装.*分发|没有.*分发/.test(normalized)
  ) {
    return state("not-ready", "wsl-no-distribution", output);
  }
  if (!distributionLines.some((line) => /\s2\s*$/.test(line))) {
    return state("not-ready", "wsl2-distribution-missing", distributionsResult.stdout);
  }
  return state("ready", "ready");
}

export function parseDockerInfo(result: CommandResult): {
  daemon: PrerequisiteState;
  linuxContainers: PrerequisiteState;
} {
  const output = combinedOutput(result);
  if (result.exitCode !== 0) {
    return {
      daemon: state("not-ready", "docker-daemon-unavailable", output),
      linuxContainers: state("not-ready", "docker-daemon-unavailable"),
    };
  }
  try {
    const info = JSON.parse(result.stdout) as { OSType?: unknown; OperatingSystem?: unknown };
    if (typeof info.OSType !== "string" || typeof info.OperatingSystem !== "string") {
      throw new Error("Docker info did not include OSType and OperatingSystem");
    }
    if (!info.OperatingSystem.toLowerCase().includes("docker desktop")) {
      return {
        daemon: state("unsupported", "docker-desktop-required", info.OperatingSystem),
        linuxContainers:
          info.OSType.toLowerCase() === "linux"
            ? state("ready", "ready")
            : state("unsupported", "docker-linux-containers-required", info.OSType),
      };
    }
    return {
      daemon: state("ready", "ready"),
      linuxContainers:
        info.OSType.toLowerCase() === "linux"
          ? state("ready", "ready")
          : state("unsupported", "docker-linux-containers-required", info.OSType),
    };
  } catch (error) {
    return {
      daemon: state("error", "docker-check-failed", String(error)),
      linuxContainers: state("error", "docker-check-failed"),
    };
  }
}

export function resolveDockerExecutable(
  environment: NodeJS.ProcessEnv = process.env,
  exists: (filePath: fs.PathLike) => boolean = fs.existsSync,
): string {
  const candidates = [
    environment.ProgramFiles
      ? path.join(environment.ProgramFiles, "Docker", "Docker", "resources", "bin", "docker.exe")
      : "",
    environment.LOCALAPPDATA
      ? path.join(
          environment.LOCALAPPDATA,
          "Programs",
          "Docker",
          "Docker",
          "resources",
          "bin",
          "docker.exe",
        )
      : "",
  ];
  return candidates.find((candidate) => candidate && exists(candidate)) || "docker.exe";
}

export async function checkDockerPrerequisites(
  runner: CommandRunner = runCommand,
  options: {
    platform?: NodeJS.Platform;
    osRelease?: string;
    dockerExecutable?: string;
    timeoutMs?: number;
  } = {},
): Promise<DockerPrerequisites> {
  const platform = options.platform ?? process.platform;
  const windowsBuild = Number.parseInt(
    (options.osRelease ?? os.release()).split(".")[2] ?? "0",
    10,
  );
  const windows =
    platform !== "win32"
      ? state("unsupported", "windows-required")
      : windowsBuild < MIN_WINDOWS_BUILD
        ? state("unsupported", "windows-version-unsupported", String(windowsBuild))
        : state("ready", "ready");

  let wslCommand = state("missing", "wsl-command-missing");
  let wsl2 = state("not-ready", "wsl-command-missing");
  if (platform === "win32") {
    const [statusResult, distributionsResult] = await Promise.allSettled([
      runner("wsl.exe", ["--status"], options.timeoutMs ?? COMMAND_TIMEOUT_MS),
      runner("wsl.exe", ["--list", "--verbose"], options.timeoutMs ?? COMMAND_TIMEOUT_MS),
    ]);
    const failures = [statusResult, distributionsResult].filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.some((failure) => errorCode(failure.reason) === "ENOENT")) {
      wslCommand = state("missing", "wsl-command-missing");
      wsl2 = state("missing", "wsl-command-missing");
    } else {
      wslCommand = state("ready", "ready");
      if (failures.some((failure) => errorCode(failure.reason) === "ETIMEDOUT")) {
        wsl2 = state("error", "wsl-check-timeout");
      } else if (failures.length > 0) {
        wsl2 = state("error", "wsl-check-failed", String(failures[0].reason));
      } else if (
        statusResult.status === "fulfilled" &&
        distributionsResult.status === "fulfilled"
      ) {
        wsl2 = parseWslState(statusResult.value, distributionsResult.value);
      }
    }
  }

  const dockerExecutable = options.dockerExecutable ?? resolveDockerExecutable();
  let dockerCli = state("missing", "docker-cli-missing");
  let dockerDaemon = state("not-ready", "docker-cli-missing");
  let linuxContainers = state("not-ready", "docker-cli-missing");
  try {
    const cliResult = await runner(
      dockerExecutable,
      ["--version"],
      options.timeoutMs ?? COMMAND_TIMEOUT_MS,
    );
    if (cliResult.exitCode !== 0) {
      dockerCli = state("error", "docker-check-failed", combinedOutput(cliResult));
    } else {
      dockerCli = state("ready", "ready", cliResult.stdout);
      const info = await runner(
        dockerExecutable,
        ["info", "--format", "{{json .}}"],
        options.timeoutMs ?? COMMAND_TIMEOUT_MS,
      );
      ({ daemon: dockerDaemon, linuxContainers } = parseDockerInfo(info));
    }
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") {
      dockerCli = state("missing", "docker-cli-missing");
      dockerDaemon = state("not-ready", "docker-cli-missing");
      linuxContainers = state("not-ready", "docker-cli-missing");
    } else {
      const reason = code === "ETIMEDOUT" ? "docker-check-timeout" : "docker-check-failed";
      const target = state("error", reason, String(error));
      if (dockerCli.status === "ready") {
        dockerDaemon = target;
        linuxContainers = state("error", reason);
      } else {
        dockerCli = target;
        dockerDaemon = state("not-ready", reason);
        linuxContainers = state("not-ready", reason);
      }
    }
  }

  const checks = [windows, wslCommand, wsl2, dockerCli, dockerDaemon, linuxContainers];
  const reasons = [
    ...new Set(checks.filter((check) => check.reason !== "ready").map((check) => check.reason)),
  ];
  return {
    checkedAt: new Date().toISOString(),
    ready: checks.every((check) => check.status === "ready"),
    reasons,
    windows,
    wslCommand,
    wsl2,
    dockerCli,
    dockerDaemon,
    linuxContainers,
  };
}
