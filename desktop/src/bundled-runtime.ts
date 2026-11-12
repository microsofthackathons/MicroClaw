import { app } from "electron";
import * as fs from "fs";
import * as path from "path";
import {
  materializeRuntimeArchive,
  materializeRuntimeArchiveAsync,
  runtimeArchiveCacheVersion,
} from "./runtime-archive";
import { measureRuntimePhase, type RuntimePreparationTiming } from "./runtime-preparation-timing";
import {
  assertBundledUpgradeComplete,
  assertRuntimeReplacementAllowed,
} from "./bundled-upgrade-guard";

export { materializeRuntimeArchive, runtimeArchiveCacheVersion } from "./runtime-archive";

/** Development uses the installer's prepared core without extracting or replacing it. */
function resolvePreparedDevelopmentRuntime(timing?: RuntimePreparationTiming): string | null {
  if (app.isPackaged) return null;
  const userData = app.getPath("userData");
  if (!userData) return null;
  const runtimeRoot = path.join(userData, "runtime", "openclaw");
  const packageRoot = path.join(runtimeRoot, "node_modules", "openclaw");
  const marker = path.join(runtimeRoot, ".microclaw-version");
  const metadataPath = path.join(packageRoot, "package.json");
  const present = measureRuntimePhase(
    timing,
    "cache-check",
    () =>
      fs.existsSync(marker) &&
      fs.existsSync(metadataPath) &&
      fs.existsSync(path.join(packageRoot, "openclaw.mjs")),
    (hit) => ({ cache: hit ? "hit" : "miss" }),
  );
  if (!present) return null;
  assertBundledUpgradeComplete(path.join(app.getPath("home"), ".microclaw"));
  try {
    const metadata = JSON.parse(fs.readFileSync(metadataPath, "utf8"));
    const version = fs.readFileSync(marker, "utf8").trim();
    if (
      metadata?.name !== "openclaw" ||
      typeof metadata.version !== "string" ||
      !metadata.version.trim() ||
      !(
        version.endsWith(`:openclaw@${metadata.version}`) ||
        version.includes(`:openclaw@${metadata.version}:`)
      )
    )
      throw new Error("Installed OpenClaw metadata and preparation marker do not match");
  } catch (error) {
    throw new Error(
      "The installed OpenClaw runtime is incomplete. Run the MicroClaw installer again.",
      {
        cause: error,
      },
    );
  }
  return runtimeRoot;
}

function bundledRuntimeLocation(timing?: RuntimePreparationTiming) {
  if (!app.isPackaged) return null;
  const archivePath = path.join(process.resourcesPath, "openclaw.asar");
  if (!fs.existsSync(archivePath)) return null;
  const location = {
    archivePath,
    runtimeRoot: path.join(app.getPath("userData"), "runtime", "openclaw"),
    version: measureRuntimePhase(timing, "archive-metadata", () =>
      runtimeArchiveCacheVersion(archivePath, app.getVersion()),
    ),
  };
  const targetVersion = location.version.split(":openclaw@")[1]?.split(":")[0];
  assertRuntimeReplacementAllowed(
    location.runtimeRoot,
    targetVersion,
    path.join(app.getPath("home"), ".microclaw"),
    process.argv.includes("--prepare-installer-runtime"),
  );
  return location;
}

export async function prepareBundledOpenClawDir(
  timing?: RuntimePreparationTiming,
): Promise<string | null> {
  const location = bundledRuntimeLocation(timing);
  if (!location) return resolvePreparedDevelopmentRuntime(timing);
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
  if (!location) return resolvePreparedDevelopmentRuntime();
  return materializeRuntimeArchive(location.archivePath, location.runtimeRoot, location.version);
}
