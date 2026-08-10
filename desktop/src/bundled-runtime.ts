import { extractAll } from "@electron/asar";
import { app } from "electron";
import * as fs from "fs";
import * as path from "path";

const RUNTIME_ENTRY = path.join("node_modules", "openclaw", "openclaw.mjs");
const VERSION_MARKER = ".microclaw-version";

export function materializeRuntimeArchive(
  archivePath: string,
  runtimeRoot: string,
  version: string,
  extractArchive: (archive: string, destination: string) => void = extractAll,
): string {
  const entryPath = path.join(runtimeRoot, RUNTIME_ENTRY);
  const markerPath = path.join(runtimeRoot, VERSION_MARKER);
  if (
    fs.existsSync(entryPath) &&
    fs.existsSync(markerPath) &&
    fs.readFileSync(markerPath, "utf8").trim() === version
  ) {
    return runtimeRoot;
  }

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
    fs.renameSync(stagingRoot, runtimeRoot);
  } catch (error) {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
    throw new Error("Failed to prepare the bundled OpenClaw runtime", { cause: error });
  }
  return runtimeRoot;
}

export function resolveBundledOpenClawDir(): string | null {
  if (!app.isPackaged) return null;
  const archivePath = path.join(process.resourcesPath, "openclaw.asar");
  if (!fs.existsSync(archivePath)) return null;
  const runtimeRoot = path.join(app.getPath("userData"), "runtime", "openclaw");
  return materializeRuntimeArchive(archivePath, runtimeRoot, app.getVersion());
}
