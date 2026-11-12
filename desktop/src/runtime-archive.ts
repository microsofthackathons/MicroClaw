import { extractAll, extractFile, getRawHeader } from "@electron/asar";
import { createHash } from "node:crypto";
import * as fs from "fs";
import * as path from "path";
import { Worker } from "node:worker_threads";
import { extractRuntimeArchiveParallel } from "./runtime-archive-extract";
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
  readHeader: (archive: string) => string = (archive) => getRawHeader(archive).headerString,
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
  // The header contains each archived file's integrity hash, including dependencies.
  // Repacking the same version must not silently reuse a different dependency tree.
  const identity = createHash("sha256").update(readHeader(archivePath)).digest("hex");
  return `${desktopVersion}:openclaw@${metadata.version}:${identity}`;
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

function prepareRuntimeStaging(
  runtimeRoot: string,
  version: string,
  timing?: RuntimePreparationTiming,
): string | null {
  const previousRoot = `${runtimeRoot}.previous`;
  // Recover a publication interrupted after moving the old tree aside.
  if (!fs.existsSync(runtimeRoot) && fs.existsSync(previousRoot)) {
    fs.renameSync(previousRoot, runtimeRoot);
  }
  const current = measureRuntimePhase(
    timing,
    "cache-check",
    () => isRuntimeArchiveCurrent(runtimeRoot, version),
    (hit) => ({ cache: hit ? "hit" : "miss" }),
  );
  if (current) return null;

  const stagingRoot = `${runtimeRoot}.staging-${process.pid}`;
  measureRuntimePhase(timing, "staging-cleanup", () =>
    fs.rmSync(stagingRoot, { recursive: true, force: true }),
  );
  measureRuntimePhase(timing, "staging-parent-create", () =>
    fs.mkdirSync(path.dirname(runtimeRoot), { recursive: true }),
  );
  return stagingRoot;
}

function publishPreparedRuntime(
  stagingRoot: string,
  runtimeRoot: string,
  version: string,
  timing: RuntimePreparationTiming | undefined,
  publish: typeof commitRuntimeArchive,
): void {
  const previousRoot = `${runtimeRoot}.previous`;
  measureRuntimePhase(timing, "entry-validation", () => {
    if (!fs.existsSync(path.join(stagingRoot, RUNTIME_ENTRY))) {
      throw new Error("Bundled OpenClaw archive is missing openclaw.mjs");
    }
  });
  measureRuntimePhase(timing, "version-marker-write", () =>
    fs.writeFileSync(path.join(stagingRoot, VERSION_MARKER), `${version}\n`, "utf8"),
  );
  if (fs.existsSync(previousRoot)) {
    throw new Error("An earlier runtime replacement still requires installer recovery");
  }
  const hadPrevious = fs.existsSync(runtimeRoot);
  if (hadPrevious)
    measureRuntimePhase(timing, "previous-runtime-retain", () =>
      fs.renameSync(runtimeRoot, previousRoot),
    );
  try {
    measureRuntimePhase(timing, "runtime-publish", () =>
      publish(stagingRoot, runtimeRoot, undefined, undefined, timing),
    );
  } catch (error) {
    if (hadPrevious && !fs.existsSync(runtimeRoot))
      measureRuntimePhase(timing, "previous-runtime-restore", () =>
        fs.renameSync(previousRoot, runtimeRoot),
      );
    throw error;
  }
  // Keep the previous runtime until the installer has validated the upgrade.
}

function discardRuntimeStaging(
  stagingRoot: string,
  error: unknown,
  timing?: RuntimePreparationTiming,
): never {
  measureRuntimePhase(timing, "failed-staging-cleanup", () =>
    fs.rmSync(stagingRoot, { recursive: true, force: true }),
  );
  throw new Error("Failed to prepare the bundled OpenClaw runtime", { cause: error });
}

export function materializeRuntimeArchive(
  archivePath: string,
  runtimeRoot: string,
  version: string,
  extractArchive: (archive: string, destination: string) => void = extractAll,
  timing?: RuntimePreparationTiming,
  publish: typeof commitRuntimeArchive = commitRuntimeArchive,
): string {
  const stagingRoot = prepareRuntimeStaging(runtimeRoot, version, timing);
  if (stagingRoot === null) return runtimeRoot;
  try {
    measureRuntimePhase(timing, "archive-extract", () => extractArchive(archivePath, stagingRoot));
    publishPreparedRuntime(stagingRoot, runtimeRoot, version, timing, publish);
  } catch (error) {
    discardRuntimeStaging(stagingRoot, error, timing);
  }
  return runtimeRoot;
}

/** Worker preparation awaits every write before marking or publishing the runtime. */
export async function materializeRuntimeArchiveParallel(
  archivePath: string,
  runtimeRoot: string,
  version: string,
  extractArchive: typeof extractRuntimeArchiveParallel = extractRuntimeArchiveParallel,
  timing?: RuntimePreparationTiming,
  publish: typeof commitRuntimeArchive = commitRuntimeArchive,
): Promise<string> {
  const stagingRoot = prepareRuntimeStaging(runtimeRoot, version, timing);
  if (stagingRoot === null) return runtimeRoot;
  const finish = timing?.start("archive-extract");
  try {
    await extractArchive(archivePath, stagingRoot, timing);
    finish?.("success");
    publishPreparedRuntime(stagingRoot, runtimeRoot, version, timing, publish);
  } catch (error) {
    finish?.("failed");
    discardRuntimeStaging(stagingRoot, error, timing);
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
  startWorker: (request: RuntimeArchiveRequest) => Pick<Worker, "once" | "on"> = (workerData) =>
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
    let worker: Pick<Worker, "once" | "on">;
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
    worker.on("message", (message) => {
      if (message?.type === "runtime-preparation-ready") finishStartup?.("success");
      if (message?.type === "runtime-preparation-timing") timing?.forward(message.message);
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
