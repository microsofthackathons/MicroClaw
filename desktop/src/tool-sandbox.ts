/**
 * Tool Execution Sandbox — runs AI agent tool commands inside Windows AppContainer.
 *
 * Architecture:
 *   Gateway (outside AC) → exec("command") → COMSPEC → AppContainerLauncher.exe → cmd.exe (inside AC)
 *
 * The sandbox is transparent to the gateway: by setting COMSPEC to AppContainerLauncher.exe,
 * all child_process.exec() calls are automatically routed through the AppContainer sandbox.
 * child_process.spawn() and execFile() are NOT affected (they bypass COMSPEC).
 *
 * Sandbox behaviour is configured via environment variables:
 *   OPENCLAW_SANDBOX_BYPASS=1       → disable sandbox (pass through to real cmd.exe)
 *   OPENCLAW_SANDBOX_NAME           → AppContainer profile name (default: MicroClaw)
 *   OPENCLAW_SANDBOX_CAPS           → comma-separated capabilities
 *   OPENCLAW_SANDBOX_DIRS_RW        → comma-separated dirs with read-write access
 *   OPENCLAW_SANDBOX_DIRS_RO        → comma-separated dirs with read-only access
 */

import { spawn, execFile, execFileSync } from "child_process";
import * as path from "path";
import * as fs from "fs";
import { app } from "electron";
import { SANDBOX_PERMISSION_TIMEOUT_MS } from "./constants";
import { shieldAll } from "./sensitive-shield";

const CONTAINER_NAME = "MicroClaw";
// No default capabilities — settings store is the single source of truth.
// main.ts calls setCapabilities() with values from settings on startup.
const DEFAULT_CAPABILITIES: string[] = [];
const CREATE_NO_WINDOW = 0x08000000;

export interface SandboxExecOptions {
  /** Working directory for the command. */
  cwd?: string;
  /** Additional environment variables. */
  env?: Record<string, string>;
  /** Timeout in milliseconds (0 = no timeout). */
  timeout?: number;
  /** AppContainer capabilities to grant. */
  capabilities?: string[];
  /** Skip traverse/loopback/cleanup setup for faster cold start. */
  skipSetup?: boolean;
}

export interface SandboxExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface SandboxStatus {
  available: boolean;
  enabled: boolean;
  launcherPath: string | null;
  containerName: string;
  capabilities: string[];
  sandboxDirsRW: string[];
  sandboxDirsRO: string[];
  externalApps: string[];
}

export class ToolSandbox {
  private launcherPath: string | null;
  private nodePath: string;
  private enabled: boolean = true;
  private capabilities: string[] = [...DEFAULT_CAPABILITIES];
  private sandboxDirsRW: string[] = [];
  private sandboxDirsRO: string[] = [];
  /** Apps that bypass AppContainer (e.g. "outlook", "chrome", "excel"). */
  private externalApps: string[] = [];

  constructor(launcherPath: string | null, nodePath: string) {
    this.launcherPath = launcherPath;
    this.nodePath = nodePath;

    // Set up default sandbox directories — this is the single source of truth
    // for system dirs. ACL verify and Settings UI both read from getStatus().
    const home = process.env.USERPROFILE || "";
    if (home) {
      // OpenClaw state dir (read-write)
      this.sandboxDirsRW.push(path.join(home, ".openclaw"));
      // Sandbox workspace for tool output
      const sandboxWorkDir = path.join(home, ".openclaw", "sandbox");
      if (!fs.existsSync(sandboxWorkDir)) {
        fs.mkdirSync(sandboxWorkDir, { recursive: true });
      }
      // Node.js runtime (read-only)
      this.sandboxDirsRO.push(path.join(home, ".openclaw-node"));
      // Temp dir for scratch files
      const tempDir = process.env.TEMP || process.env.TMP || "";
      if (tempDir) this.sandboxDirsRW.push(tempDir);
    }
    // Gateway log directory — must be writable inside AppContainer
    const systemDrive = process.env.SystemDrive || "C:";
    const logDir = path.join(systemDrive + path.sep, "tmp", "openclaw");
    if (!fs.existsSync(logDir)) {
      try {
        fs.mkdirSync(logDir, { recursive: true });
      } catch {}
    }
    this.sandboxDirsRW.push(logDir);
    // Electron app data — sandbox-preload.js needs to READ
    // sandbox-external-apps.json from here, but must NOT be able to write
    // anything in this directory. The Electron settings file (config.json)
    // lives here and controls sandbox enablement, dir whitelists, capability
    // grants and external-app bypasses; if it were writable from inside the
    // AppContainer a sandboxed tool could disable the sandbox or whitelist
    // arbitrary paths and have it take effect on next launch (sandbox escape).
    // Granting read-only is sufficient for sandbox-preload's needs; the
    // Electron main process itself is not in the AppContainer and retains
    // full RW via the inherited user ACL.
    const appData = process.env.APPDATA || "";
    if (appData) {
      this.sandboxDirsRO.push(path.join(appData, "microclaw"));
    }
  }

  /** Check if AppContainerLauncher.exe is found and usable. */
  isAvailable(): boolean {
    return (
      process.platform === "win32" && this.launcherPath !== null && fs.existsSync(this.launcherPath)
    );
  }

  /** Check if sandbox is both available and enabled. */
  isActive(): boolean {
    return this.isAvailable() && this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  setCapabilities(caps: string[]): void {
    this.capabilities = [...caps];
  }

  addDirRW(dir: string): void {
    const norm = dir.toLowerCase();
    if (!this.sandboxDirsRW.some((d) => d.toLowerCase() === norm)) this.sandboxDirsRW.push(dir);
  }

  addDirRO(dir: string): void {
    const norm = dir.toLowerCase();
    if (!this.sandboxDirsRO.some((d) => d.toLowerCase() === norm)) this.sandboxDirsRO.push(dir);
  }

  removeDirRW(dir: string): void {
    const norm = dir.toLowerCase();
    this.sandboxDirsRW = this.sandboxDirsRW.filter((d) => d.toLowerCase() !== norm);
  }

  removeDirRO(dir: string): void {
    const norm = dir.toLowerCase();
    this.sandboxDirsRO = this.sandboxDirsRO.filter((d) => d.toLowerCase() !== norm);
  }

  setSandboxDirsRW(dirs: string[]): void {
    this.sandboxDirsRW = [...dirs];
  }

  setSandboxDirsRO(dirs: string[]): void {
    this.sandboxDirsRO = [...dirs];
  }

  /**
   * Set apps that should bypass AppContainer when launched from a sandboxed shell.
   * These are executable base names without .exe (e.g. "outlook", "chrome", "excel").
   * When a sandboxed PowerShell/cmd command references one of these apps,
   * the entire spawn call runs outside AppContainer.
   */
  /** Shell executables that must never bypass AppContainer. */
  private static readonly BLOCKED_EXTERNAL_APPS = new Set([
    "cmd",
    "powershell",
    "pwsh",
    "bash",
    "sh",
    "wsl",
    "python",
    "python3",
    "node",
    "cscript",
    "wscript",
    "mshta",
  ]);

  setExternalApps(apps: string[]): void {
    this.externalApps = apps
      .map((a) =>
        a
          .trim()
          .toLowerCase()
          .replace(/\.exe$/i, ""),
      )
      .filter((a) => !ToolSandbox.BLOCKED_EXTERNAL_APPS.has(a));
  }

  /**
   * Get environment variables to inject into the gateway process
   * for transparent COMSPEC-based sandboxing.
   *
   * When active, sets COMSPEC to AppContainerLauncher.exe so all
   * child_process.exec() calls are routed through the sandbox.
   *
   * The sandbox activates immediately on process start — there is no
   * bypass window. Safe diagnostic commands are handled by the preload's
   * isSafeDiagnosticCommand check; other startup commands route through
   * AppContainer.
   */
  getGatewayEnv(): Record<string, string> {
    if (!this.isActive() || !this.launcherPath) return {};

    const env: Record<string, string> = {
      COMSPEC: this.launcherPath,
      OPENCLAW_SANDBOX_NAME: CONTAINER_NAME,
      OPENCLAW_SANDBOX_CAPS: this.capabilities.join(","),
      // Keep the original COMSPEC so the preload and bypass can find real cmd.exe
      OPENCLAW_ORIGINAL_COMSPEC: process.env.COMSPEC || "cmd.exe",
    };

    if (this.sandboxDirsRW.length > 0) {
      env.OPENCLAW_SANDBOX_DIRS_RW = this.sandboxDirsRW.join(",");
    }
    if (this.sandboxDirsRO.length > 0) {
      env.OPENCLAW_SANDBOX_DIRS_RO = this.sandboxDirsRO.join(",");
    }

    if (this.externalApps.length > 0) {
      env.OPENCLAW_AC_EXTERNAL_APPS = this.externalApps.join(",");
    }

    env.OPENCLAW_SANDBOX_PERMISSION_TIMEOUT = String(SANDBOX_PERMISSION_TIMEOUT_MS);

    return env;
  }

  /**
   * Get the path to sandbox-preload.js, which should be loaded via
   * NODE_OPTIONS="--require <path>" to enable delayed sandbox activation.
   */
  getPreloadPath(): string | null {
    if (!this.isActive()) return null;

    const candidates = [
      // Packaged app
      app.isPackaged ? path.join(process.resourcesPath, "sandbox-preload.js") : "",
      // Development
      path.resolve(__dirname, "..", "..", "appcontainer", "sandbox-preload.js"),
    ];
    for (const p of candidates) {
      if (p && fs.existsSync(p)) return p;
    }
    return null;
  }

  /**
   * Provision the AppContainer profile and ACLs for tool execution.
   * Should be called once during setup.
   */
  provision(): boolean {
    if (!this.launcherPath || !fs.existsSync(this.launcherPath)) return false;

    try {
      // Create profile
      execFileSync(this.launcherPath, ["sid", "--name", CONTAINER_NAME], {
        windowsHide: true,
        timeout: 10000,
      });

      // Grant access to sandbox directories.
      // RO first, then RW — so child dirs with more permissive access get
      // their explicit ACE set last, taking precedence over inherited ACEs.
      const sortByDepth = (a: string, b: string) =>
        a.split(path.sep).length - b.split(path.sep).length;

      for (const dir of [...this.sandboxDirsRO].sort(sortByDepth)) {
        if (!fs.existsSync(dir)) continue;
        try {
          execFileSync(
            this.launcherPath,
            ["grant", "--name", CONTAINER_NAME, "--dir", dir, "--access", "r"],
            { windowsHide: true, timeout: 10000 },
          );
        } catch {}
      }
      for (const dir of [...this.sandboxDirsRW].sort(sortByDepth)) {
        if (!fs.existsSync(dir)) continue;
        try {
          execFileSync(
            this.launcherPath,
            ["grant", "--name", CONTAINER_NAME, "--dir", dir, "--access", "rw"],
            { windowsHide: true, timeout: 10000 },
          );
        } catch {
          /* directory may not exist yet */
        }
      }

      // Set loopback exemption (for outbound network from sandbox)
      try {
        execFileSync(this.launcherPath, ["loopback", "--name", CONTAINER_NAME], {
          windowsHide: true,
          timeout: 10000,
        });
      } catch {
        /* non-fatal */
      }

      return true;
    } catch (err: any) {
      console.error("[tool-sandbox] Provision failed:", err.message);
      return false;
    }
  }

  /**
   * Async version of provision() — does not block the main process.
   * Use this during startup and user-initiated changes.
   */
  async provisionAsync(): Promise<boolean> {
    if (!this.launcherPath || !fs.existsSync(this.launcherPath)) return false;

    const launcher = this.launcherPath;
    const run = (args: string[]): Promise<void> =>
      new Promise((resolve, reject) => {
        execFile(launcher, args, { windowsHide: true, timeout: 10000 }, (err) => {
          if (err) reject(err);
          else resolve();
        });
      });

    try {
      await run(["sid", "--name", CONTAINER_NAME]);

      // Grant RO dirs first, then RW dirs. This ensures that when a child dir
      // has a more permissive access level (RW) than its parent (RO), the child's
      // explicit ACE is set LAST and takes precedence over inherited ACEs.
      // Within each level, sort by path depth (shallowest first) so that parent
      // traverse ACEs are in place before granting children.
      const sortByDepth = (a: string, b: string) =>
        a.split(path.sep).length - b.split(path.sep).length;

      const roDirs = [...this.sandboxDirsRO].sort(sortByDepth);
      const rwDirs = [...this.sandboxDirsRW].sort(sortByDepth);

      for (const dir of roDirs) {
        if (!fs.existsSync(dir)) continue;
        try {
          await run(["grant", "--name", CONTAINER_NAME, "--dir", dir, "--access", "r"]);
        } catch {}
      }
      for (const dir of rwDirs) {
        if (!fs.existsSync(dir)) continue;
        try {
          await run(["grant", "--name", CONTAINER_NAME, "--dir", dir, "--access", "rw"]);
        } catch {
          /* directory may not exist yet */
        }
      }

      try {
        await run(["loopback", "--name", CONTAINER_NAME]);
      } catch {
        /* non-fatal */
      }

      // Shield sensitive paths after all grants complete
      if (this.launcherPath) {
        try {
          await shieldAll(this.launcherPath, CONTAINER_NAME);
        } catch {
          /* non-fatal */
        }
      }

      return true;
    } catch (err: any) {
      console.error("[tool-sandbox] provisionAsync failed:", err.message);
      return false;
    }
  }

  /**
   * Grant AppContainer access to a single directory asynchronously.
   * Use this for user-initiated changes to avoid blocking the UI.
   */
  async grantDirAsync(
    dir: string,
    access: "rw" | "r",
    children: boolean = false,
  ): Promise<boolean> {
    if (!this.launcherPath || !fs.existsSync(this.launcherPath) || !fs.existsSync(dir)) {
      return false;
    }
    const args = ["grant", "--name", CONTAINER_NAME, "--dir", dir, "--access", access];
    if (children) args.push("--children");
    return new Promise<boolean>((resolve) => {
      execFile(
        this.launcherPath!,
        args,
        { windowsHide: true, timeout: 10000 },
        (err, stdout, stderr) => {
          if (stderr)
            console.log(`[tool-sandbox] grantDirAsync stderr for ${dir}:\n${stderr.trimEnd()}`);
          if (err) {
            console.error(`[tool-sandbox] grantDirAsync failed for ${dir}:`, err.message);
            resolve(false);
          } else {
            resolve(true);
          }
        },
      );
    });
  }

  /**
   * Grant AppContainer access with UAC elevation (admin prompt).
   * Falls back to this when normal grant fails (e.g. protected system dirs like C:\).
   * Uses PowerShell Start-Process -Verb RunAs to trigger the UAC dialog.
   */
  async grantDirElevated(
    dir: string,
    access: "rw" | "r",
    children: boolean = false,
  ): Promise<boolean> {
    if (!this.launcherPath || !fs.existsSync(this.launcherPath)) {
      return false;
    }
    const launcherEscaped = this.launcherPath.replace(/'/g, "''");
    // Build ArgumentList as a PowerShell string array to avoid quoting issues
    // with paths containing spaces or special chars.
    const dirEscaped = dir.replace(/'/g, "''");
    const childrenArg = children ? ",'--children'" : "";
    const psCommand = `Start-Process -FilePath '${launcherEscaped}' -ArgumentList @('grant','--name','${CONTAINER_NAME}','--dir','${dirEscaped}','--access','${access}'${childrenArg}) -Verb RunAs -Wait -WindowStyle Hidden`;
    return new Promise<boolean>((resolve) => {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", psCommand],
        {
          windowsHide: true,
          timeout: 0, // no timeout — wait for user to click UAC
        },
        (err, stdout, stderr) => {
          if (stderr)
            console.log(`[tool-sandbox] grantDirElevated stderr for ${dir}:\n${stderr.trimEnd()}`);
          if (err) {
            console.error(`[tool-sandbox] grantDirElevated failed for ${dir}:`, err.message);
            resolve(false);
          } else {
            console.log(`[tool-sandbox] grantDirElevated succeeded for ${dir} (${access})`);
            resolve(true);
          }
        },
      );
    });
  }

  /**
   * Revoke AppContainer access to a single directory asynchronously.
   */
  async revokeDirAsync(dir: string): Promise<boolean> {
    if (!this.launcherPath || !fs.existsSync(this.launcherPath)) {
      return false;
    }
    const args = ["revoke", "--name", CONTAINER_NAME, "--dir", dir];
    return new Promise<boolean>((resolve) => {
      execFile(this.launcherPath!, args, { windowsHide: true, timeout: 10000 }, (err) => {
        if (err) {
          console.error(`[tool-sandbox] revokeDirAsync failed for ${dir}:`, err.message);
          resolve(false);
        } else {
          resolve(true);
        }
      });
    });
  }

  /**
   * Revoke AppContainer access with UAC elevation.
   * Falls back to this when normal revoke fails (e.g. protected system dirs).
   */
  async revokeDirElevated(dir: string): Promise<boolean> {
    if (!this.launcherPath || !fs.existsSync(this.launcherPath)) {
      return false;
    }
    const launcherEscaped = this.launcherPath.replace(/'/g, "''");
    const dirEscaped = dir.replace(/'/g, "''");
    const psCommand = `Start-Process -FilePath '${launcherEscaped}' -ArgumentList @('revoke','--name','${CONTAINER_NAME}','--dir','${dirEscaped}') -Verb RunAs -Wait -WindowStyle Hidden`;
    return new Promise<boolean>((resolve) => {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", psCommand],
        {
          windowsHide: true,
          timeout: 0, // no timeout — wait for user to click UAC
        },
        (err) => {
          if (err) {
            console.error(`[tool-sandbox] revokeDirElevated failed for ${dir}:`, err.message);
            resolve(false);
          } else {
            console.log(`[tool-sandbox] revokeDirElevated succeeded for ${dir}`);
            resolve(true);
          }
        },
      );
    });
  }

  /**
   * Execute a shell command inside AppContainer.
   * This is the direct API — for transparent sandboxing, use getGatewayEnv() instead.
   */
  async execShell(command: string, opts?: SandboxExecOptions): Promise<SandboxExecResult> {
    if (!this.launcherPath) {
      throw new Error("AppContainerLauncher not available");
    }

    const caps = opts?.capabilities || this.capabilities;
    const launcherArgs = [
      "run",
      "--name",
      CONTAINER_NAME,
      "--exe",
      path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe"),
      "--no-window",
    ];

    if (opts?.skipSetup) {
      launcherArgs.push("--skip-setup", "--quiet");
    }

    for (const cap of caps) {
      launcherArgs.push("--cap", cap);
    }

    if (opts?.cwd) {
      launcherArgs.push("--workdir", opts.cwd);
    }

    launcherArgs.push("--", "/d", "/s", "/c", command);

    return this.runLauncher(launcherArgs, opts);
  }

  /**
   * Execute a Node.js script or inline code inside AppContainer.
   */
  async execNode(scriptOrCode: string, opts?: SandboxExecOptions): Promise<SandboxExecResult> {
    if (!this.launcherPath) {
      throw new Error("AppContainerLauncher not available");
    }

    const isFile = fs.existsSync(scriptOrCode);
    const caps = opts?.capabilities || this.capabilities;
    const launcherArgs = ["run", "--name", CONTAINER_NAME, "--exe", this.nodePath, "--no-window"];

    for (const cap of caps) {
      launcherArgs.push("--cap", cap);
    }

    if (opts?.cwd) {
      launcherArgs.push("--workdir", opts.cwd);
    }

    launcherArgs.push("--");
    if (isFile) {
      launcherArgs.push(scriptOrCode);
    } else {
      launcherArgs.push("-e", scriptOrCode);
    }

    return this.runLauncher(launcherArgs, opts);
  }

  /**
   * Execute an arbitrary program inside AppContainer.
   */
  async exec(
    executable: string,
    args: string[],
    opts?: SandboxExecOptions,
  ): Promise<SandboxExecResult> {
    if (!this.launcherPath) {
      throw new Error("AppContainerLauncher not available");
    }

    const caps = opts?.capabilities || this.capabilities;
    const launcherArgs = ["run", "--name", CONTAINER_NAME, "--exe", executable, "--no-window"];

    for (const cap of caps) {
      launcherArgs.push("--cap", cap);
    }

    if (opts?.cwd) {
      launcherArgs.push("--workdir", opts.cwd);
    }

    launcherArgs.push("--", ...args);

    return this.runLauncher(launcherArgs, opts);
  }

  /** Get current sandbox status for UI display. */
  getStatus(): SandboxStatus {
    return {
      available: this.isAvailable(),
      enabled: this.enabled,
      launcherPath: this.launcherPath,
      containerName: CONTAINER_NAME,
      capabilities: [...this.capabilities],
      sandboxDirsRW: [...this.sandboxDirsRW],
      sandboxDirsRO: [...this.sandboxDirsRO],
      externalApps: [...this.externalApps],
    };
  }

  // ── Internal ──

  private runLauncher(
    launcherArgs: string[],
    opts?: SandboxExecOptions,
  ): Promise<SandboxExecResult> {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let timedOut = false;

      const child = spawn(this.launcherPath!, launcherArgs, {
        env: { ...process.env, ...(opts?.env || {}) },
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        ...(process.platform === "win32" ? { creationFlags: CREATE_NO_WINDOW } : {}),
      } as any);

      child.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString("utf-8");
      });
      child.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString("utf-8");
      });

      let timer: ReturnType<typeof setTimeout> | null = null;
      if (opts?.timeout && opts.timeout > 0) {
        timer = setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, opts.timeout);
      }

      child.on("exit", (code) => {
        if (timer) clearTimeout(timer);
        resolve({ exitCode: code ?? 1, stdout, stderr, timedOut });
      });

      child.on("error", (err: Error) => {
        if (timer) clearTimeout(timer);
        resolve({
          exitCode: 1,
          stdout,
          stderr: stderr + "\n" + err.message,
          timedOut,
        });
      });
    });
  }

  // ── ACL Verification ──

  /**
   * Check ACL status for a single directory.
   * Returns parsed JSON from the launcher's check-acl command.
   */
  async checkAcl(dir: string, access: "rw" | "r"): Promise<Record<string, unknown> | null> {
    if (!this.launcherPath || !fs.existsSync(this.launcherPath)) return null;
    const args = [
      "check-acl",
      "--name",
      CONTAINER_NAME,
      "--dir",
      dir,
      "--access",
      access === "rw" ? "rw" : "r",
    ];
    return new Promise((resolve) => {
      execFile(this.launcherPath!, args, { windowsHide: true, timeout: 10000 }, (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(stdout.trim()));
        } catch {
          resolve(null);
        }
      });
    });
  }

  /**
   * Scan all fixed drives for stale AppContainer ACLs (up to maxDepth).
   * knownDirs are normalized paths that should NOT be flagged as stale.
   * Returns an array of stale ACL entries.
   */
  async scanStaleAcls(
    knownDirs: string[],
    maxDepth: number = 2,
  ): Promise<Array<{ path: string; rights: string; inherited: boolean }>> {
    if (!this.launcherPath || !fs.existsSync(this.launcherPath)) return [];
    const args = ["scan-acl", "--name", CONTAINER_NAME, "--depth", String(maxDepth)];
    for (const d of knownDirs) {
      args.push("--known", d.replace(/[\\/]+$/, ""));
    }
    return new Promise((resolve) => {
      execFile(
        this.launcherPath!,
        args,
        { windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 },
        (err, stdout) => {
          if (err && !stdout) {
            resolve([]);
            return;
          }
          const results: Array<{ path: string; rights: string; inherited: boolean }> = [];
          for (const line of (stdout || "").split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              results.push(JSON.parse(trimmed));
            } catch {}
          }
          resolve(results);
        },
      );
    });
  }
}
