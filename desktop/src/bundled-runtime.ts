import { app } from "electron";
import * as fs from "fs";
import * as path from "path";
import {
  materializeRuntimeArchive,
  materializeRuntimeArchiveAsync,
  runtimeArchiveCacheVersion,
} from "./runtime-archive";
import { measureRuntimePhase, type RuntimePreparationTiming } from "./runtime-preparation-timing";

export { materializeRuntimeArchive, runtimeArchiveCacheVersion } from "./runtime-archive";

function bundledRuntimeLocation(timing?: RuntimePreparationTiming) {
  if (!app.isPackaged) return null;
  const archivePath = path.join(process.resourcesPath, "openclaw.asar");
  if (!fs.existsSync(archivePath)) return null;
  return {
    archivePath,
    runtimeRoot: path.join(app.getPath("userData"), "runtime", "openclaw"),
    version: measureRuntimePhase(timing, "archive-metadata", () =>
      runtimeArchiveCacheVersion(archivePath, app.getVersion()),
    ),
  };
}

export async function prepareBundledOpenClawDir(
  timing?: RuntimePreparationTiming,
): Promise<string | null> {
  const location = bundledRuntimeLocation(timing);
  if (!location) return null;
  return materializeRuntimeArchiveAsync(
    location.archivePath,
    location.runtimeRoot,
    location.version,
    undefined,
    timing,
  );
}

export function resolveBundledOpenClawDir(): string | null {
  const location = bundledRuntimeLocation();
  if (!location) return null;
  return materializeRuntimeArchive(location.archivePath, location.runtimeRoot, location.version);
}
