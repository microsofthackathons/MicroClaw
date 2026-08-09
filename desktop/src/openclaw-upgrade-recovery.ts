import fs from "fs";
import path from "path";
import { randomUUID } from "crypto";

type UpgradePhase =
  | "backing-up"
  | "installing"
  | "verifying"
  | "committed"
  | "rolling-back"
  | "rolled-back"
  | "rollback-failed";

type UpgradeManifest = {
  schema_version: number;
  transaction_id: string;
  owner_pid: number;
  source_version: string | null;
  target_version: string;
  prefix: string;
  package_dir: string;
  state_dir: string;
  backup_dir: string;
  shim_paths: string[];
  package_existed: boolean;
  state_existed: boolean;
  phase: UpgradePhase;
  created_at: string;
  updated_at: string;
  validation_results: Record<string, boolean>;
};

type ClaimedLock = {
  complete(success: boolean): void;
};

export type UpgradeRecoveryResult =
  | { status: "none" | "committed" | "rolled-back" }
  | { status: "upgrade-in-progress" };

export type UpgradeRecoveryOptions = {
  expectedStateDir?: string;
  trustedPrefixes?: string[];
  processIsAlive?: (pid: number) => boolean;
  claimLock?: (lockPath: string, processIsAlive: (pid: number) => boolean) => ClaimedLock;
};

export type InstallerOwnedUpgradeOptions = Pick<
  UpgradeRecoveryOptions,
  "expectedStateDir" | "trustedPrefixes" | "processIsAlive"
>;

export class UpgradeInProgressError extends Error {}

function canonicalPath(value: string): string {
  let existing = path.resolve(value);
  const missingSegments: string[] = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    missingSegments.unshift(path.basename(existing));
    existing = parent;
  }
  const canonicalExisting = fs.realpathSync.native(existing);
  return path.join(canonicalExisting, ...missingSegments);
}

function normalized(value: string): string {
  const canonical = canonicalPath(value);
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function samePath(left: string, right: string): boolean {
  return normalized(left) === normalized(right);
}

function strictChildOf(candidate: string, root: string): boolean {
  const relative = path.relative(normalized(root), normalized(candidate));
  return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function processIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (["EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) return true;
    return false;
  }
}

function defaultTrustedPrefixes(): string[] {
  const home = process.env.USERPROFILE || "";
  const appData = process.env.APPDATA || "";
  const localAppData = process.env.LOCALAPPDATA || "";
  const programFiles = process.env.ProgramFiles || "";
  const override = process.env.OPENCLAW_NODE_DIR || "";
  return [
    home ? path.join(home, ".openclaw-node") : "",
    appData ? path.join(appData, "npm") : "",
    programFiles ? path.join(programFiles, "nodejs") : "",
    localAppData ? path.join(localAppData, "Programs", "nodejs") : "",
    path.isAbsolute(override) ? override : "",
  ].filter(Boolean);
}

function atomicJsonWrite(filePath: string, value: UpgradeManifest): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${randomUUID()}.tmp`,
  );
  const descriptor = fs.openSync(temporary, "w");
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf-8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  fs.renameSync(temporary, filePath);
}

function fsyncFile(filePath: string): void {
  const originalMode = fs.statSync(filePath).mode;
  let changedMode = false;
  let descriptor: number | null = null;
  try {
    try {
      descriptor = fs.openSync(filePath, "r+");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EACCES" && code !== "EPERM") throw error;
      fs.chmodSync(filePath, originalMode | 0o200);
      changedMode = true;
      descriptor = fs.openSync(filePath, "r+");
    }
    fs.fsyncSync(descriptor);
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
    if (changedMode) fs.chmodSync(filePath, originalMode);
  }
}

function fsyncTree(root: string): void {
  if (!fs.existsSync(root)) return;
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      fsyncTree(entryPath);
    } else if (entry.isFile()) {
      fsyncFile(entryPath);
    }
  }
}

function removePath(target: string): void {
  fs.rmSync(target, { recursive: true, force: true });
}

function quarantine(live: string, failed: string): void {
  if (!fs.existsSync(live)) return;
  if (fs.existsSync(failed)) {
    removePath(live);
    return;
  }
  fs.mkdirSync(path.dirname(failed), { recursive: true });
  try {
    fs.renameSync(live, failed);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    fs.cpSync(live, failed, { recursive: true });
    fsyncTree(failed);
    removePath(live);
  }
}

function restoreTree(backup: string, live: string, failed: string, existed: boolean): void {
  let staging: string | null = null;
  if (existed) {
    if (!fs.existsSync(backup)) {
      throw new Error(`upgrade backup is missing: ${backup}`);
    }
    fs.mkdirSync(path.dirname(live), { recursive: true });
    staging = path.join(path.dirname(live), `.${path.basename(live)}.${randomUUID()}.restore`);
    fs.cpSync(backup, staging, { recursive: true });
    fsyncTree(staging);
  }
  quarantine(live, failed);
  if (staging) fs.renameSync(staging, live);
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function readLockObject(lockPath: string): Record<string, unknown> | null {
  let descriptor: number | null = null;
  try {
    descriptor = fs.openSync(lockPath, "r");
    const buffer = Buffer.alloc(1024);
    const length = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    const value: unknown = JSON.parse(buffer.subarray(0, length).toString("utf-8").trim());
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  } finally {
    if (descriptor !== null) fs.closeSync(descriptor);
  }
}

function defaultClaimLock(lockPath: string, isProcessAlive: (pid: number) => boolean): ClaimedLock {
  if (process.platform !== "win32") {
    throw new UpgradeInProgressError("automatic upgrade recovery is only supported on Windows");
  }
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  if (fs.existsSync(lockPath)) {
    const payload = readLockObject(lockPath);
    const ownerPid = payload?.owner_pid;
    if (typeof ownerPid === "number" && isProcessAlive(ownerPid)) {
      throw new UpgradeInProgressError(`installer process ${ownerPid} is still upgrading OpenClaw`);
    }
  } else {
    const descriptor = fs.openSync(lockPath, "wx");
    fs.closeSync(descriptor);
  }

  const claimPath = `${lockPath}.electron-${process.pid}-${randomUUID()}`;
  try {
    fs.renameSync(lockPath, claimPath);
  } catch (error) {
    throw new UpgradeInProgressError(
      `another process owns the OpenClaw upgrade lock: ${(error as Error).message}`,
    );
  }
  let completed = false;
  return {
    complete(success: boolean) {
      if (completed) return;
      completed = true;
      if (success) {
        fs.rmSync(claimPath, { force: true });
      } else if (!fs.existsSync(lockPath)) {
        fs.renameSync(claimPath, lockPath);
      } else {
        fs.rmSync(claimPath, { force: true });
      }
    },
  };
}

function parseManifest(filePath: string): UpgradeManifest {
  const value: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("upgrade manifest must be an object");
  }
  return value as UpgradeManifest;
}

function validateManifest(
  manifest: UpgradeManifest,
  microclawRoot: string,
  expectedStateDir: string,
  trustedPrefixes: string[],
): void {
  if (manifest.schema_version !== 1) {
    throw new Error("unsupported upgrade manifest schema");
  }
  if (!/^\d{8}T\d{6}Z-[0-9a-f]{8}$/.test(manifest.transaction_id)) {
    throw new Error("invalid upgrade transaction ID");
  }
  if (!trustedPrefixes.some((prefix) => samePath(prefix, manifest.prefix))) {
    throw new Error("manifest prefix is not a trusted OpenClaw prefix");
  }
  const allowedPackages = [
    path.join(manifest.prefix, "node_modules", "openclaw"),
    path.join(manifest.prefix, "lib", "node_modules", "openclaw"),
  ];
  if (!allowedPackages.some((candidate) => samePath(candidate, manifest.package_dir))) {
    throw new Error("manifest package directory is invalid");
  }
  const shimNames = new Set(["openclaw", "openclaw.cmd", "openclaw.ps1"]);
  for (const shim of manifest.shim_paths) {
    if (
      !samePath(path.dirname(shim), manifest.prefix) ||
      !shimNames.has(path.basename(shim).toLowerCase())
    ) {
      throw new Error("manifest shim path is invalid");
    }
  }
  if (!samePath(manifest.state_dir, expectedStateDir)) {
    throw new Error("manifest state directory is invalid");
  }
  const backupRoot = path.join(microclawRoot, "backups", "openclaw");
  if (
    !strictChildOf(manifest.backup_dir, backupRoot) ||
    path.basename(manifest.backup_dir) !== manifest.transaction_id
  ) {
    throw new Error("manifest backup directory is invalid");
  }
}

function persistManifest(manifestPath: string, manifest: UpgradeManifest): void {
  manifest.updated_at = new Date().toISOString();
  const backupManifest = path.join(manifest.backup_dir, "transaction.json");
  if (fs.existsSync(manifest.backup_dir)) {
    atomicJsonWrite(backupManifest, manifest);
  }
  atomicJsonWrite(manifestPath, manifest);
}

export function validateInstallerOwnedUpgrade(
  microclawRoot: string,
  transactionId: string,
  options: InstallerOwnedUpgradeOptions = {},
): boolean {
  const manifestPath = path.join(microclawRoot, "upgrade", "openclaw-upgrade.json");
  const lockPath = path.join(microclawRoot, "upgrade", "openclaw-upgrade.lock");
  if (!fs.existsSync(manifestPath) || !fs.existsSync(lockPath)) return false;

  try {
    const manifest = parseManifest(manifestPath);
    const expectedStateDir =
      options.expectedStateDir ?? path.join(process.env.USERPROFILE || "", ".openclaw");
    validateManifest(
      manifest,
      microclawRoot,
      expectedStateDir,
      options.trustedPrefixes ?? defaultTrustedPrefixes(),
    );
    const lock = readLockObject(lockPath);
    const processAlive = options.processIsAlive ?? processIsAlive;
    if (manifest.phase !== "verifying") {
      throw new Error(`transaction phase is ${manifest.phase}, expected verifying`);
    }
    if (manifest.transaction_id !== transactionId) {
      throw new Error("manifest transaction ID does not match launch argument");
    }
    if (lock?.transaction_id !== transactionId) {
      throw new Error("lock transaction ID does not match launch argument");
    }
    if (lock?.owner_pid !== manifest.owner_pid) {
      throw new Error("lock owner PID does not match manifest owner");
    }
    if (!processAlive(manifest.owner_pid)) {
      throw new Error(`installer process ${manifest.owner_pid} is not observable`);
    }
    return true;
  } catch (error) {
    console.error(
      `[upgrade] Installer handoff rejected: ${error instanceof Error ? error.message : error}`,
    );
    return false;
  }
}

export function recoverInterruptedOpenClawUpgrade(
  microclawRoot: string,
  options: UpgradeRecoveryOptions = {},
): UpgradeRecoveryResult {
  const manifestPath = path.join(microclawRoot, "upgrade", "openclaw-upgrade.json");
  if (!fs.existsSync(manifestPath)) return { status: "none" };
  const manifest = parseManifest(manifestPath);
  if (manifest.phase === "committed") return { status: "committed" };
  if (manifest.phase === "rolled-back") return { status: "rolled-back" };

  const expectedStateDir =
    options.expectedStateDir ?? path.join(process.env.USERPROFILE || "", ".openclaw");
  const trustedPrefixes = options.trustedPrefixes ?? defaultTrustedPrefixes();
  const claimLock = options.claimLock ?? defaultClaimLock;
  const claim = claimLock(
    path.join(microclawRoot, "upgrade", "openclaw-upgrade.lock"),
    options.processIsAlive ?? processIsAlive,
  );
  try {
    validateManifest(manifest, microclawRoot, expectedStateDir, trustedPrefixes);
    if (manifest.phase === "backing-up") {
      manifest.phase = "rolled-back";
      persistManifest(manifestPath, manifest);
      claim.complete(true);
      return { status: "rolled-back" };
    }
    if (!["installing", "verifying", "rolling-back", "rollback-failed"].includes(manifest.phase)) {
      throw new Error(`cannot recover upgrade phase: ${manifest.phase}`);
    }

    manifest.phase = "rolling-back";
    persistManifest(manifestPath, manifest);
    const failedRoot = path.join(manifest.backup_dir, "failed");
    fs.mkdirSync(failedRoot, { recursive: true });
    restoreTree(
      path.join(manifest.backup_dir, "package"),
      manifest.package_dir,
      path.join(failedRoot, "package"),
      manifest.package_existed,
    );
    for (const shim of manifest.shim_paths) {
      const backupShim = path.join(manifest.backup_dir, "shims", path.basename(shim));
      if (fs.existsSync(backupShim)) {
        const staging = path.join(
          path.dirname(shim),
          `.${path.basename(shim)}.${randomUUID()}.restore`,
        );
        fs.copyFileSync(backupShim, staging);
        fsyncFile(staging);
        fs.renameSync(staging, shim);
      } else {
        removePath(shim);
      }
    }
    restoreTree(
      path.join(manifest.backup_dir, "state"),
      manifest.state_dir,
      path.join(failedRoot, "state"),
      manifest.state_existed,
    );
    manifest.phase = "rolled-back";
    persistManifest(manifestPath, manifest);
    claim.complete(true);
    return { status: "rolled-back" };
  } catch (error) {
    manifest.phase = "rollback-failed";
    try {
      persistManifest(manifestPath, manifest);
    } finally {
      claim.complete(false);
    }
    throw error;
  }
}
