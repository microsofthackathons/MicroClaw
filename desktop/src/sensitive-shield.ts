/**
 * sensitive-shield.ts — Shield orchestration for sensitive paths.
 *
 * Standalone module. Does NOT import or depend on tool-sandbox.ts.
 * Communicates with AppContainerLauncher.exe via CLI commands.
 */
import * as path from "path";
import { execFile } from "child_process";

/** Default sensitive subdirectories (relative to user home). */
export const DEFAULT_SENSITIVE_DIRS = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  path.join(".config", "gcloud"),
];

/**
 * Determine if a granted directory could contain sensitive paths
 * that need shielding. Returns true when granting home dir or
 * any ancestor of home.
 */
export function shouldShield(dir: string): boolean {
  const home = (process.env.USERPROFILE || "").toLowerCase();
  if (!home) return false;
  const norm = path
    .resolve(dir)
    .toLowerCase()
    .replace(/[\\/]+$/, "");
  const homeNorm = home.replace(/[\\/]+$/, "");
  return norm === homeNorm || homeNorm.startsWith(norm + path.sep);
}

/**
 * Run shield on a directory after grant. Calls
 * `AppContainerLauncher.exe shield --name <name> --dir <dir>`.
 * Returns the list of shielded paths.
 */
export function shieldIfNeeded(
  launcherPath: string,
  containerName: string,
  dir: string,
): Promise<string[]> {
  if (!shouldShield(dir)) return Promise.resolve([]);
  return new Promise<string[]>((resolve) => {
    execFile(
      launcherPath,
      ["shield", "--name", containerName, "--dir", dir],
      { windowsHide: true, timeout: 10000 },
      (err, _stdout, stderr) => {
        if (err) {
          console.error(`[sensitive-shield] shield failed for ${dir}:`, err.message);
          resolve([]);
          return;
        }
        // Parse shielded paths from stderr output
        const shielded: string[] = [];
        for (const line of (stderr || "").split("\n")) {
          const m = line.match(/Shielded sensitive dir: (.+)/);
          if (m) shielded.push(m[1].trim());
        }
        resolve(shielded);
      },
    );
  });
}

/**
 * Run unshield on known sensitive subdirectories before revoke.
 */
export function unshieldIfNeeded(
  launcherPath: string,
  containerName: string,
  dir: string,
): Promise<void> {
  if (!shouldShield(dir)) return Promise.resolve();
  const home = process.env.USERPROFILE || "";
  const promises = DEFAULT_SENSITIVE_DIRS.map(
    (rel) =>
      new Promise<void>((resolve) => {
        const fullPath = path.join(home, rel);
        execFile(
          launcherPath,
          ["unshield", "--name", containerName, "--dir", fullPath],
          { windowsHide: true, timeout: 10000 },
          () => resolve(), // non-fatal: dir may not exist
        );
      }),
  );
  return Promise.all(promises).then(() => {});
}

/**
 * Shield all known sensitive paths. Call during app startup
 * (after provisioning) to ensure protection is in place.
 */
export function shieldAll(launcherPath: string, containerName: string): Promise<string[]> {
  const home = process.env.USERPROFILE;
  if (!home) return Promise.resolve([]);
  return shieldIfNeeded(launcherPath, containerName, home);
}
