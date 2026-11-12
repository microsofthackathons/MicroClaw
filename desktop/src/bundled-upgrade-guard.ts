import fs from "node:fs";
import path from "node:path";

/** Recovery owns the state snapshot and old program trees; ordinary startup cannot bypass it. */
export function assertBundledUpgradeComplete(desktopRoot: string): void {
  const journal = path.join(desktopRoot, "upgrade", "bundled-upgrade.json");
  if (!fs.existsSync(journal)) return;
  let record;
  try {
    record = JSON.parse(fs.readFileSync(journal, "utf8"));
  } catch {
    throw new Error("MicroClaw upgrade record is unreadable. Run the installer again to recover.");
  }
  if (
    record?.schema !== 1 ||
    !["committed", "rolled-back"].includes(record.phase) ||
    path.resolve(record.desktop ?? "") !== path.resolve(desktopRoot)
  ) {
    throw new Error(
      "MicroClaw upgrade has not completed. Run the installer again before opening the app.",
    );
  }
}

export function assertRuntimeReplacementAllowed(
  runtimeRoot: string,
  targetVersion: string,
  desktopRoot: string,
  installerMode: boolean,
): void {
  const metadata = path.join(runtimeRoot, "node_modules", "openclaw", "package.json");
  if (!fs.existsSync(metadata)) return;
  const installed = JSON.parse(fs.readFileSync(metadata, "utf8"));
  if (installed.name !== "openclaw" || typeof installed.version !== "string") {
    throw new Error("Existing bundled runtime identity is invalid; run the installer to recover.");
  }
  if (installed.version === targetVersion) return;
  if (installerMode) {
    const record = JSON.parse(
      fs.readFileSync(path.join(desktopRoot, "upgrade", "bundled-upgrade.json"), "utf8"),
    );
    const normalize = (value: string) =>
      process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
    if (
      record.schema === 1 &&
      record.phase === "installing" &&
      record.targetVersion === targetVersion &&
      normalize(record.runtime) === normalize(runtimeRoot) &&
      normalize(record.desktop) === normalize(desktopRoot) &&
      typeof record.archiveSha256 === "string" &&
      /^[a-f0-9]{64}$/.test(record.archiveSha256)
    )
      return;
  }
  throw new Error(
    "Changing OpenClaw versions requires the installer and a verified state recovery point.",
  );
}
