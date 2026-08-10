import { execFile, spawn } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { app } from "electron";

export const OPENCLAW_SANDBOX_IMAGE = "microclaw-openclaw-sandbox:2026.7.1-1";
export const DOCKER_CHECK_TIMEOUT_MS = 5_000;
export const DOCKER_BUILD_TIMEOUT_MS = 20 * 60_000;

export type DockerSandboxReason =
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
  | "docker-check-failed"
  | "sandbox-image-missing";

export type DockerSandboxStateStatus = "ready" | "missing" | "not-ready" | "unsupported" | "error";

export interface DockerSandboxState {
  status: DockerSandboxStateStatus;
  reason: DockerSandboxReason;
  detail?: string;
}

export interface DockerSandboxReadiness {
  checkedAt: string;
  ready: boolean;
  reasons: DockerSandboxReason[];
  windows: DockerSandboxState;
  wslCommand: DockerSandboxState;
  wsl2: DockerSandboxState;
  dockerCli: DockerSandboxState;
  dockerDaemon: DockerSandboxState;
  linuxContainers: DockerSandboxState;
  image: DockerSandboxState;
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

const MIN_WINDOWS_BUILD = 19041;

function state(
  status: DockerSandboxStateStatus,
  reason: DockerSandboxReason,
  detail?: string,
): DockerSandboxState {
  return { status, reason, ...(detail ? { detail } : {}) };
}

function decodeOutput(value: string | Buffer): string {
  if (typeof value === "string") return value.trim();
  const oddNulls = value.length > 1 && value.subarray(1).filter((byte) => byte === 0).length > 2;
  return value
    .toString(oddNulls ? "utf16le" : "utf8")
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
        if (execError?.code === "ENOENT") {
          reject(Object.assign(new Error(`${executable} was not found`), { code: "ENOENT" }));
          return;
        }
        if (execError?.killed || execError?.code === "ETIMEDOUT") {
          reject(Object.assign(new Error(`${executable} timed out`), { code: "ETIMEDOUT" }));
          return;
        }
        resolve({
          exitCode: typeof execError?.code === "number" ? execError.code : error ? 1 : 0,
          stdout: decodeOutput(stdout),
          stderr: decodeOutput(stderr),
        });
      },
    );
  });

function errorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function output(result: CommandResult): string {
  return `${result.stdout}\n${result.stderr}`.trim();
}

export function parseWslState(
  statusResult: CommandResult,
  distributionsResult: CommandResult,
): DockerSandboxState {
  const combined = `${output(statusResult)}\n${output(distributionsResult)}`;
  const normalized = combined.toLowerCase();
  if (/restart|reboot|重新启动|重启/.test(normalized)) {
    return state("not-ready", "wsl-reboot-required", combined);
  }
  if (/kernel.*(update|required|missing|not found)|更新.*内核|内核.*更新/.test(normalized)) {
    return state("not-ready", "wsl-kernel-update-required", combined);
  }
  if (
    /optional component|feature.*(disabled|not enabled)|0x80370102|虚拟机平台|可选组件/.test(
      normalized,
    )
  ) {
    return state("not-ready", "wsl-feature-disabled", combined);
  }
  if (statusResult.exitCode !== 0 && distributionsResult.exitCode !== 0) {
    return state("error", "wsl-check-failed", combined);
  }
  const distributions = distributionsResult.stdout
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*\*\s*/, "").trim())
    .filter(
      (line) =>
        line &&
        !/^(name|名称)\s+(state|状态)\s+(version|版本)/i.test(line) &&
        !/^(windows subsystem|适用于 linux)/i.test(line),
    );
  if (
    distributions.length === 0 ||
    /no installed distributions|no distributions|未安装.*分发|没有.*分发/.test(normalized)
  ) {
    return state("not-ready", "wsl-no-distribution", combined);
  }
  if (!distributions.some((line) => /\s2\s*$/.test(line))) {
    return state("not-ready", "wsl2-distribution-missing", distributionsResult.stdout);
  }
  return state("ready", "ready");
}

export function parseDockerInfo(result: CommandResult): {
  daemon: DockerSandboxState;
  linuxContainers: DockerSandboxState;
} {
  const combined = output(result);
  if (result.exitCode !== 0) {
    return {
      daemon: state("not-ready", "docker-daemon-unavailable", combined),
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
          "DockerDesktop",
          "resources",
          "bin",
          "docker.exe",
        )
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

export async function checkDockerSandboxReadiness(
  runner: CommandRunner = runCommand,
  options: {
    platform?: NodeJS.Platform;
    osRelease?: string;
    dockerExecutable?: string;
    timeoutMs?: number;
  } = {},
): Promise<DockerSandboxReadiness> {
  const timeoutMs = options.timeoutMs ?? DOCKER_CHECK_TIMEOUT_MS;
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
      runner("wsl.exe", ["--status"], timeoutMs),
      runner("wsl.exe", ["--list", "--verbose"], timeoutMs),
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
  let image = state("not-ready", "docker-cli-missing");
  try {
    const cliResult = await runner(dockerExecutable, ["--version"], timeoutMs);
    if (cliResult.exitCode !== 0) {
      dockerCli = state("error", "docker-check-failed", output(cliResult));
    } else {
      dockerCli = state("ready", "ready", cliResult.stdout);
      const info = await runner(dockerExecutable, ["info", "--format", "{{json .}}"], timeoutMs);
      ({ daemon: dockerDaemon, linuxContainers } = parseDockerInfo(info));
      if (dockerDaemon.status === "ready" && linuxContainers.status === "ready") {
        const inspect = await runner(
          dockerExecutable,
          ["image", "inspect", OPENCLAW_SANDBOX_IMAGE],
          timeoutMs,
        );
        image =
          inspect.exitCode === 0
            ? state("ready", "ready")
            : state("missing", "sandbox-image-missing", output(inspect));
      } else {
        image = state("not-ready", dockerDaemon.reason);
      }
    }
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") {
      dockerCli = state("missing", "docker-cli-missing");
      dockerDaemon = state("not-ready", "docker-cli-missing");
      linuxContainers = state("not-ready", "docker-cli-missing");
      image = state("not-ready", "docker-cli-missing");
    } else {
      const reason = code === "ETIMEDOUT" ? "docker-check-timeout" : "docker-check-failed";
      const target = state("error", reason, String(error));
      if (dockerCli.status === "ready") {
        dockerDaemon = target;
        linuxContainers = state("error", reason);
        image = state("error", reason);
      } else {
        dockerCli = target;
        dockerDaemon = state("not-ready", reason);
        linuxContainers = state("not-ready", reason);
        image = state("not-ready", reason);
      }
    }
  }

  const checks = [windows, wslCommand, wsl2, dockerCli, dockerDaemon, linuxContainers, image];
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
    image,
  };
}

export function resolveSandboxDockerfile(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, "docker-sandbox", "Dockerfile")
    : path.resolve(__dirname, "..", "..", "docker-sandbox", "Dockerfile");
}

export async function buildDockerSandboxImage(
  onProgress: (line: string) => void,
  options: {
    dockerExecutable?: string;
    dockerfile?: string;
    timeoutMs?: number;
  } = {},
): Promise<void> {
  const executable = options.dockerExecutable ?? resolveDockerExecutable();
  const dockerfile = options.dockerfile ?? resolveSandboxDockerfile();
  if (!fs.existsSync(dockerfile)) throw new Error(`Sandbox Dockerfile not found: ${dockerfile}`);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      executable,
      [
        "build",
        "--progress",
        "plain",
        "--tag",
        OPENCLAW_SANDBOX_IMAGE,
        "--file",
        dockerfile,
        path.dirname(dockerfile),
      ],
      {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...process.env,
          PATH: `${path.dirname(executable)}${path.delimiter}${process.env.PATH ?? ""}`,
        },
      },
    );
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("Docker image build timed out"));
    }, options.timeoutMs ?? DOCKER_BUILD_TIMEOUT_MS);
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const emit = (chunk: Buffer) => {
      for (const line of chunk.toString("utf8").split(/\r?\n/)) {
        if (line.trim()) onProgress(line);
      }
    };
    child.stdout?.on("data", emit);
    child.stderr?.on("data", emit);
    child.once("error", finish);
    child.once("exit", (code) =>
      code === 0 ? finish() : finish(new Error(`Docker image build exited with code ${code ?? 1}`)),
    );
  });
}

export const REQUIRED_DOCKER_SANDBOX = {
  mode: "all",
  backend: "docker",
  scope: "session",
  workspaceAccess: "none",
  docker: {
    image: OPENCLAW_SANDBOX_IMAGE,
    readOnlyRoot: true,
    tmpfs: ["/tmp", "/var/tmp", "/run"],
    network: "none",
    user: "1000:1000",
    capDrop: ["ALL"],
    pidsLimit: 256,
    memory: "1g",
    memorySwap: "1g",
    cpus: 1,
    ulimits: {
      nofile: { soft: 1024, hard: 2048 },
      nproc: 256,
    },
  },
  browser: {
    enabled: false,
    allowHostControl: false,
  },
} as const;

export const REQUIRED_SANDBOX_TOOLS = [
  "exec",
  "process",
  "read",
  "write",
  "edit",
  "apply_patch",
  "memory_search",
  "memory_get",
  "sessions_list",
  "sessions_history",
  "sessions_send",
  "sessions_spawn",
  "session_status",
] as const;

export type JsonObject = Record<string, unknown>;

function objectValue(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as JsonObject) : {};
}

export function applyRequiredDockerSandboxConfig(input: JsonObject): {
  config: JsonObject;
  changed: boolean;
} {
  const before = JSON.stringify(input);
  const config = structuredClone(input);
  const agents = objectValue(config.agents);
  config.agents = agents;
  const defaults = objectValue(agents.defaults);
  agents.defaults = defaults;
  defaults.sandbox = structuredClone(REQUIRED_DOCKER_SANDBOX);
  if (Array.isArray(agents.list)) {
    for (const agent of agents.list) {
      if (agent && typeof agent === "object" && !Array.isArray(agent)) {
        const agentConfig = agent as JsonObject;
        delete agentConfig.sandbox;
        delete agentConfig.tools;
        const runtime = objectValue(agentConfig.runtime);
        if (runtime.type === "acp") delete agentConfig.runtime;
      }
    }
  }
  const tools = objectValue(config.tools);
  config.tools = tools;
  tools.elevated = { ...objectValue(tools.elevated), enabled: false };
  tools.exec = { ...objectValue(tools.exec), host: "sandbox" };
  tools.sandbox = {
    ...objectValue(tools.sandbox),
    tools: { allow: [...REQUIRED_SANDBOX_TOOLS] },
  };
  const acp = objectValue(config.acp);
  config.acp = acp;
  acp.enabled = false;
  acp.dispatch = { ...objectValue(acp.dispatch), enabled: false };
  return { config, changed: JSON.stringify(config) !== before };
}

export function isRequiredDockerSandboxConfig(config: JsonObject): boolean {
  const applied = applyRequiredDockerSandboxConfig(config);
  return !applied.changed;
}

export function canExecuteWithDockerSandbox(
  readiness: DockerSandboxReadiness,
  config: JsonObject,
): boolean {
  return readiness.ready && isRequiredDockerSandboxConfig(config);
}
