import { extractAll, extractFile } from "@electron/asar";
import * as fs from "fs";
import * as path from "path";
import { Worker } from "node:worker_threads";

const RUNTIME_ENTRY = path.join("node_modules", "openclaw", "openclaw.mjs");
const VERSION_MARKER = ".microclaw-version";

export function commitRuntimeArchive(
  stagingRoot: string,
  runtimeRoot: string,
  renameDirectory: typeof fs.renameSync = fs.renameSync,
  wait: (milliseconds: number) => void = (milliseconds) => {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
  },
): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameDirectory(stagingRoot, runtimeRoot);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 10 || !["EPERM", "EACCES", "EBUSY"].includes(code ?? "")) throw error;
      wait(100 * (attempt + 1));
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
): string {
  if (isRuntimeArchiveCurrent(runtimeRoot, version)) return runtimeRoot;

  const stagingRoot = `${runtimeRoot}.staging-${process.pid}`;
  fs.rmSync(stagingRoot, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(runtimeRoot), { recursive: true });
  try {
    extractArchive(archivePath, stagingRoot);
    if (!fs.existsSync(path.join(stagingRoot, RUNTIME_ENTRY))) {
      throw new Error("Bundled OpenClaw archive is missing openclaw.mjs");
    }
    fs.writeFileSync(path.join(stagingRoot, VERSION_MARKER), `${version}\n`, "utf8");
    fs.rmSync(runtimeRoot, { recursive: true, force: true });
    commitRuntimeArchive(stagingRoot, runtimeRoot);
  } catch (error) {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    throw new Error("Failed to prepare the bundled OpenClaw runtime", { cause: error });
  }
  return runtimeRoot;
}

export interface RuntimeArchiveRequest {
  archivePath: string;
  runtimeRoot: string;
  version: string;
}

export async function materializeRuntimeArchiveAsync(
  archivePath: string,
  runtimeRoot: string,
  version: string,
  startWorker: (request: RuntimeArchiveRequest) => Pick<Worker, "once"> = (workerData) =>
    new Worker(path.join(__dirname, "runtime-archive-worker.js"), { workerData }),
): Promise<string> {
  if (isRuntimeArchiveCurrent(runtimeRoot, version)) return runtimeRoot;
  return new Promise((resolve, reject) => {
    const worker = startWorker({ archivePath, runtimeRoot, version });
    worker.once("error", reject);
    worker.once("exit", (code) => {
      try {
        if (code !== 0) {
          throw new Error(`Bundled OpenClaw preparation worker exited with code ${code}`);
        }
        if (!isRuntimeArchiveCurrent(runtimeRoot, version)) {
          throw new Error("Bundled OpenClaw preparation worker did not produce a valid runtime");
        }
        resolve(runtimeRoot);
      } catch (error) {
        reject(error);
      }
    });
  });
}
