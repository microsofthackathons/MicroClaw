import { app } from "electron";
import * as fs from "fs";
import * as path from "path";
import {
  materializeRuntimeArchive,
  materializeRuntimeArchiveAsync,
  runtimeArchiveCacheVersion,
} from "./runtime-archive";

export { materializeRuntimeArchive, runtimeArchiveCacheVersion } from "./runtime-archive";

function bundledRuntimeLocation() {
  if (!app.isPackaged) return null;
  const archivePath = path.join(process.resourcesPath, "openclaw.asar");
  if (!fs.existsSync(archivePath)) return null;
  return {
    archivePath,
    runtimeRoot: path.join(app.getPath("userData"), "runtime", "openclaw"),
    version: runtimeArchiveCacheVersion(archivePath, app.getVersion()),
  };
}

export async function prepareBundledOpenClawDir(): Promise<string | null> {
  const location = bundledRuntimeLocation();
  if (!location) return null;
  return materializeRuntimeArchiveAsync(
    location.archivePath,
    location.runtimeRoot,
    location.version,
  );
}

export function resolveBundledOpenClawDir(): string | null {
  const location = bundledRuntimeLocation();
  if (!location) return null;
  return materializeRuntimeArchive(location.archivePath, location.runtimeRoot, location.version);
}
