import { extractAll, extractFile } from "@electron/asar";
import * as fs from "fs";
import * as path from "path";
import { Worker } from "node:worker_threads";
import { measureRuntimePhase, type RuntimePreparationTiming } from "./runtime-preparation-timing";

const RUNTIME_ENTRY = path.join("node_modules", "openclaw", "openclaw.mjs");
const VERSION_MARKER = ".microclaw-version";

export function commitRuntimeArchive(
  stagingRoot: string,
  runtimeRoot: string,
  renameDirectory: typeof fs.renameSync = fs.renameSync,
  wait: (milliseconds: number) => void = (milliseconds) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  },
  timing?: RuntimePreparationTiming,
): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameDirectory(stagingRoot, runtimeRoot);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 10 || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw error;
      measureRuntimePhase(
        timing,
        "publish-retry-wait",
        () => wait(100 * (attempt + 1)),
        () => ({ attempt: attempt + 1, errorCode: code }),
      );
    }
  }
}

export function runtimeArchiveCacheVersion(
  archivePath: string,
  desktopVersion: string,
  readArchiveFile: (archive: string, filename: string) => Buffer = extractFile,
): string {
  const metadata: unknown = JSON.parse(
    readArchiveFile(archivePath, path.join("node_modules", "openclaw", "package.json")).toString(
      "utf8",
    ),
  );
  if (
    !metadata ||
    typeof metadata !== "object" ||
    !("name" in metadata) ||
    metadata.name !== "openclaw" ||
    !("version" in metadata) ||
    typeof metadata.version !== "string" ||
    !metadata.version.trim()
  ) {
    throw new Error("Bundled OpenClaw archive has invalid package metadata");
  }
  return `${desktopVersion}:openclaw@${metadata.version}`;
}

export function isRuntimeArchiveCurrent(runtimeRoot: string, version: string): boolean {
  const entryPath = path.join(runtimeRoot, RUNTIME_ENTRY);
  const markerPath = path.join(runtimeRoot, VERSION_MARKER);
  return (
    fs.existsSync(entryPath) &&
    fs.existsSync(markerPath) &&
    fs.readFileSync(markerPath, "utf8").trim() === version
  );
}

export function materializeRuntimeArchive(
  archivePath: string,
  runtimeRoot: string,
  version: string,
  extractArchive: (archive: string, destination: string) => void = extractAll,
  timing?: RuntimePreparationTiming,
): string {
  const current = measureRuntimePhase(
    timing,
    "cache-check",
    () => isRuntimeArchiveCurrent(runtimeRoot, version),
    (hit) => ({ cache: hit ? "hit" : "miss" }),
  );
  if (current) return runtimeRoot;

  const stagingRoot = `${runtimeRoot}.staging-${process.pid}`;
  measureRuntimePhase(timing, "staging-cleanup", () =>
    fs.rmSync(stagingRoot, { recursive: true, force: true }),
  );
  measureRuntimePhase(timing, "staging-parent-create", () =>
    fs.mkdirSync(path.dirname(runtimeRoot), { recursive: true }),
  );
  try {
    measureRuntimePhase(timing, "archive-extract", () => extractArchive(archivePath, stagingRoot));
    measureRuntimePhase(timing, "entry-validation", () => {
      if (!fs.existsSync(path.join(stagingRoot, RUNTIME_ENTRY))) {
        throw new Error("Bundled OpenClaw archive is missing openclaw.mjs");
      }
    });
    measureRuntimePhase(timing, "version-marker-write", () =>
      fs.writeFileSync(path.join(stagingRoot, VERSION_MARKER), `${version}\n`, "utf8"),
    );
    measureRuntimePhase(timing, "old-runtime-remove", () =>
      fs.rmSync(runtimeRoot, { recursive: true, force: true }),
    );
    measureRuntimePhase(timing, "runtime-publish", () =>
      commitRuntimeArchive(stagingRoot, runtimeRoot, undefined, undefined, timing),
    );
  } catch (error) {
    measureRuntimePhase(timing, "failed-staging-cleanup", () =>
      fs.rmSync(stagingRoot, { recursive: true, force: true }),
    );
    throw new Error("Failed to prepare the bundled OpenClaw runtime", { cause: error });
  }
  return runtimeRoot;
}

export interface RuntimeArchiveRequest {
  archivePath: string;
  runtimeRoot: string;
  version: string;
  timing?: boolean;
}

export async function materializeRuntimeArchiveAsync(
  archivePath: string,
  runtimeRoot: string,
  version: string,
  startWorker: (request: RuntimeArchiveRequest) => Pick<Worker, "once"> = (workerData) =>
    new Worker(path.join(__dirname, "runtime-archive-worker.js"), { workerData }),
  timing?: RuntimePreparationTiming,
): Promise<string> {
  const current = measureRuntimePhase(
    timing,
    "cache-check",
    () => isRuntimeArchiveCurrent(runtimeRoot, version),
    (hit) => ({ cache: hit ? "hit" : "miss" }),
  );
  if (current) return runtimeRoot;
  const finishWorker = timing?.start("worker-total", "summary");
  const finishStartup = timing?.start("worker-startup");
  return new Promise((resolve, reject) => {
    let worker: Pick<Worker, "once">;
    try {
      worker = startWorker({
        archivePath,
        runtimeRoot,
        version,
        ...(timing ? { timing: true } : {}),
      });
    } catch (error) {
      finishStartup?.("failed");
      finishWorker?.("failed");
      reject(error);
      return;
    }
    worker.once("message", (message) => {
      if (message?.type === "runtime-preparation-ready") finishStartup?.("success");
    });
    worker.once("error", (error) => {
      finishStartup?.("failed");
      finishWorker?.("failed");
      reject(error);
    });
    worker.once("exit", (code) => {
      try {
        if (code !== 0) {
          finishStartup?.("failed");
          throw new Error(`Bundled OpenClaw preparation worker exited with code ${code}`);
        }
        measureRuntimePhase(timing, "worker-result-validation", () => {
          if (!isRuntimeArchiveCurrent(runtimeRoot, version)) {
            throw new Error("Bundled OpenClaw preparation worker did not produce a valid runtime");
          }
        });
        finishWorker?.("success");
        resolve(runtimeRoot);
      } catch (error) {
        finishWorker?.("failed");
        reject(error);
      }
    });
  });
}
