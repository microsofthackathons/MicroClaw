import { ChildProcess, spawn } from "child_process";
import { EventEmitter } from "events";
import * as path from "path";
import * as net from "net";
import * as http from "http";
import * as fs from "fs";
import { loadStateDirEnv, resolveNodePath, resolveOpenClawEntry } from "./path-resolver";
import {
  CREATE_NO_WINDOW,
  COMPILE_CACHE_SUBDIR,
  DEFAULT_PORT,
  PORT_WAIT_TIMEOUT_MS,
  HEALTH_CHECK_HTTP_TIMEOUT_MS,
  GATEWAY_READY_TIMEOUT_MS,
} from "./constants";

export class GatewayManager extends EventEmitter {
  private process: ChildProcess | null = null;
  private port: number = DEFAULT_PORT;
  private stateDir: string;
  private restartCount: number = 0;
  private maxRestarts: number = 3;
  private stopping: boolean = false;

  constructor(stateDir: string, port?: number) {
    super();
    this.stateDir = stateDir;
    if (port) this.port = port;
  }

  /** Wait until the port is available (not held by another process) */
  private async waitForPortAvailable(timeoutMs: number = PORT_WAIT_TIMEOUT_MS): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const inUse = await new Promise<boolean>((resolve) => {
        const server = net.createServer();
        server.once("error", () => resolve(true));
        server.listen(this.port, "127.0.0.1", () => {
          server.close(() => resolve(false));
        });
      });
      if (!inUse) return;
      this.emit("log", `Port ${this.port} in use, waiting...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
    this.emit(
      "log",
      `Port ${this.port} still in use after ${timeoutMs / 1000}s, starting anyway with --force`,
    );
  }

  /** Check if gateway is ready */
  private checkHealth(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(
        `http://127.0.0.1:${this.port}/health`,
        { timeout: HEALTH_CHECK_HTTP_TIMEOUT_MS },
        (res) => {
          resolve(res.statusCode === 200);
        },
      );
      req.on("error", () => resolve(false));
      req.on("timeout", () => {
        req.destroy();
        resolve(false);
      });
    });
  }

  /** Wait for gateway to become ready */
  private async waitForReady(timeoutMs: number = GATEWAY_READY_TIMEOUT_MS): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.checkHealth()) return true;
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  /** Remove stale gateway lock files from %LOCALAPPDATA%/Temp/openclaw/ */
  private cleanStaleLockFiles(): void {
    try {
      const lockDir = path.join(process.env.LOCALAPPDATA || "", "Temp", "openclaw");
      if (!fs.existsSync(lockDir)) return;
      for (const f of fs.readdirSync(lockDir)) {
        if (f.startsWith("gateway.") && f.endsWith(".lock")) {
          fs.unlinkSync(path.join(lockDir, f));
          this.emit("log", `Removed stale lock: ${f}`);
        }
      }
    } catch {}
  }

  /** Start the gateway process */
  async start(): Promise<number> {
    this.stopping = false;
    this.emit("status", "starting");

    await this.waitForPortAvailable();
    this.cleanStaleLockFiles();

    const nodePath = resolveNodePath();
    const entryPath = resolveOpenClawEntry();

    // Log resolved paths for diagnostics
    const nodeExists = fs.existsSync(nodePath);
    const entryExists = fs.existsSync(entryPath);
    this.emit("log", `Node: ${nodePath} (exists: ${nodeExists})`);
    this.emit("log", `Entry: ${entryPath} (exists: ${entryExists})`);
    this.emit("log", `State dir: ${this.stateDir}`);
    this.emit("log", `Port: ${this.port}`);

    if (!nodeExists) {
      this.emit("log", `ERROR: node.exe not found at ${nodePath}`);
      this.emit("status", "failed");
      return this.port;
    }
    if (!entryExists) {
      this.emit("log", `ERROR: openclaw entry not found at ${entryPath}`);
      this.emit("status", "failed");
      return this.port;
    }

    const args = [
      entryPath,
      "gateway",
      "run",
      "--port",
      String(this.port),
      "--bind",
      "loopback",
      "--force",
      "--allow-unconfigured",
    ];

    // Ensure compile cache directory exists for Node 22+ V8 bytecode caching
    const compileCacheDir = path.join(this.stateDir, COMPILE_CACHE_SUBDIR);
    if (!fs.existsSync(compileCacheDir)) {
      fs.mkdirSync(compileCacheDir, { recursive: true });
    }

    const spawnOpts: any = {
      cwd: path.dirname(entryPath),
      env: {
        ...process.env,
        ...loadStateDirEnv(this.stateDir),
        OPENCLAW_STATE_DIR: this.stateDir,
        NODE_ENV: "production",
        NODE_COMPILE_CACHE: compileCacheDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    };

    // On Windows, use CREATE_NO_WINDOW to prevent console window
    if (process.platform === "win32") {
      spawnOpts.creationFlags = CREATE_NO_WINDOW;
    }

    this.emit("log", `Spawning: ${nodePath} ${args.join(" ")}`);
    let stderrBuffer = "";

    this.process = spawn(nodePath, args, spawnOpts);

    this.process.on("error", (err: Error) => {
      this.emit("log", `Gateway spawn error: ${err.message}`);
      this.process = null;
      this.emit("status", "failed");
    });

    this.process.stdout?.on("data", (data: Buffer) => {
      const msg = data.toString("utf-8").trim();
      if (msg) this.emit("log", msg);
    });

    this.process.stderr?.on("data", (data: Buffer) => {
      const msg = data.toString("utf-8").trim();
      if (msg) {
        stderrBuffer += msg + "\n";
        this.emit("log", `[stderr] ${msg}`);
      }
    });

    this.process.on("exit", (code, signal) => {
      this.emit("log", `Gateway exited: code=${code} signal=${signal}`);
      if (stderrBuffer) {
        this.emit("log", `Last stderr output:\n${stderrBuffer.slice(-1000)}`);
      }
      stderrBuffer = "";
      this.process = null;

      if (!this.stopping && this.restartCount < this.maxRestarts) {
        this.restartCount++;
        this.emit("status", "restarting");
        this.emit("log", `Restarting gateway (attempt ${this.restartCount}/${this.maxRestarts})`);
        setTimeout(() => this.start(), 2000);
      } else if (!this.stopping) {
        this.emit("status", "failed");
      }
    });

    const ready = await this.waitForReady();
    if (ready) {
      this.restartCount = 0;
      this.emit("status", "running");
    } else {
      this.emit("status", "timeout");
    }

    return this.port;
  }

  /** Stop the gateway */
  stop(): void {
    this.stopping = true;
    if (this.process) {
      this.emit("status", "stopping");
      if (process.platform === "win32" && this.process.pid) {
        try {
          spawn("taskkill", ["/pid", String(this.process.pid), "/T", "/F"], {
            windowsHide: true,
            ...(process.platform === "win32" ? { creationFlags: CREATE_NO_WINDOW } : {}),
          } as any);
        } catch {
          this.process.kill("SIGKILL");
        }
      } else {
        this.process.kill("SIGTERM");
        setTimeout(() => {
          if (this.process) this.process.kill("SIGKILL");
        }, 5000);
      }
      this.process = null;
      this.emit("status", "stopped");
    }
  }

  /** Restart the gateway */
  async restart(): Promise<number> {
    this.restartCount = 0;
    this.stop();
    await new Promise((r) => setTimeout(r, 1000));
    return this.start();
  }

  getPort(): number {
    return this.port;
  }

  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }
}
