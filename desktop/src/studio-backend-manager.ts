import { ChildProcess, spawn } from "child_process";
import { EventEmitter } from "events";
import * as path from "path";
import * as net from "net";
import * as http from "http";
import * as fs from "fs";
import { resolveNodePath } from "./path-resolver";
import {
  CREATE_NO_WINDOW,
  STUDIO_DEFAULT_PORT,
  STUDIO_READY_TIMEOUT_MS,
  STUDIO_HEALTH_POLL_MS,
  STUDIO_HEALTH_HTTP_TIMEOUT_MS,
  STUDIO_MAX_RESTARTS,
  STUDIO_DATA_SUBDIR,
  type StudioBackendStatus,
} from "./constants";

export class StudioBackendManager extends EventEmitter {
  private process: ChildProcess | null = null;
  private port: number = STUDIO_DEFAULT_PORT;
  private stateDir: string;
  private restartCount: number = 0;
  private stopping: boolean = false;

  constructor(stateDir: string, port?: number) {
    super();
    this.stateDir = stateDir;
    if (port) this.port = port;
  }

  /** Find an available port starting from the default. */
  private async findAvailablePort(): Promise<number> {
    let port = this.port;
    for (let attempt = 0; attempt < 10; attempt++) {
      const inUse = await new Promise<boolean>((resolve) => {
        const server = net.createServer();
        server.once("error", () => resolve(true));
        server.listen(port, "127.0.0.1", () => {
          server.close(() => resolve(false));
        });
      });
      if (!inUse) return port;
      port++;
    }
    return port;
  }

  /** Check if the studio backend is ready. */
  private checkHealth(): Promise<boolean> {
    return new Promise((resolve) => {
      const req = http.get(
        `http://127.0.0.1:${this.port}/health`,
        { timeout: STUDIO_HEALTH_HTTP_TIMEOUT_MS },
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

  /** Wait for the studio backend to become ready. */
  private async waitForReady(timeoutMs: number = STUDIO_READY_TIMEOUT_MS): Promise<boolean> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (await this.checkHealth()) return true;
      await new Promise((r) => setTimeout(r, STUDIO_HEALTH_POLL_MS));
    }
    return false;
  }

  /** Ensure the studio data directory exists. */
  private ensureDataDir(): string {
    const dataDir = path.join(this.stateDir, STUDIO_DATA_SUBDIR);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    return dataDir;
  }

  /** Resolve the path to desktop/studio-backend/src/server.js. */
  private resolveServerEntry(): string {
    // In production: resources/studio-backend/src/server.js
    // In dev: ../studio-backend/src/server.js (relative to desktop/dist/)
    const candidates = [
      // Production (packaged)
      path.join(process.resourcesPath || "", "studio-backend", "src", "server.js"),
      // Development (desktop package root)
      path.join(__dirname, "..", "studio-backend", "src", "server.js"),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
    return candidates[1]; // Return dev path as default (will fail with clear error)
  }

  /** Start the studio backend process. */
  async start(): Promise<number> {
    this.stopping = false;
    this.emit("status", "starting" as StudioBackendStatus);

    this.port = await this.findAvailablePort();
    const dataDir = this.ensureDataDir();
    const nodePath = resolveNodePath();
    const serverEntry = this.resolveServerEntry();

    if (!fs.existsSync(nodePath)) {
      this.emit("status", "failed" as StudioBackendStatus);
      return this.port;
    }
    if (!fs.existsSync(serverEntry)) {
      this.emit("status", "failed" as StudioBackendStatus);
      return this.port;
    }

    const spawnOpts: any = {
      cwd: path.dirname(serverEntry),
      env: {
        ...process.env,
        STUDIO_DATA_DIR: dataDir,
        PORT: String(this.port),
        HOST: "127.0.0.1",
        NODE_ENV: "production",
      },
      stdio: ["ignore", "ignore", "ignore"],
      windowsHide: true,
    };

    if (process.platform === "win32") {
      spawnOpts.creationFlags = CREATE_NO_WINDOW;
    }

    this.process = spawn(nodePath, [serverEntry], spawnOpts);

    this.process.on("error", (err: Error) => {
      console.warn("[studio] Backend spawn error:", err.message);
      this.process = null;
      this.emit("status", "failed" as StudioBackendStatus);
    });

    this.process.on("exit", (_code, _signal) => {
      this.process = null;

      if (!this.stopping && this.restartCount < STUDIO_MAX_RESTARTS) {
        this.restartCount++;
        this.emit("status", "restarting" as StudioBackendStatus);
        setTimeout(() => this.start(), 2000);
      } else if (!this.stopping) {
        this.emit("status", "failed" as StudioBackendStatus);
      }
    });

    const ready = await this.waitForReady();
    if (ready) {
      this.restartCount = 0;
      this.emit("status", "running" as StudioBackendStatus);
    } else {
      this.emit("status", "failed" as StudioBackendStatus);
    }

    return this.port;
  }

  /** Stop the studio backend. */
  stop(): void {
    this.stopping = true;
    if (this.process) {
      this.emit("status", "stopping" as StudioBackendStatus);
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
      this.emit("status", "stopped" as StudioBackendStatus);
    }
  }

  getPort(): number {
    return this.port;
  }

  isRunning(): boolean {
    return this.process !== null && !this.process.killed;
  }
}
