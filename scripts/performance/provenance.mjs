import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export async function inspectFile(filename, marker) {
  const hash = createHash("sha256");
  let tail = Buffer.alloc(0);
  let containsMarker = false;
  for await (const chunk of createReadStream(filename)) {
    hash.update(chunk);
    if (marker && !containsMarker) {
      const buffer = Buffer.concat([tail, chunk]);
      containsMarker = buffer.includes(marker);
      tail = buffer.subarray(Math.max(0, buffer.length - marker.length));
    }
  }
  return { sha256: hash.digest("hex"), containsMarker };
}

export async function collectSource(root) {
  const git = async (...args) =>
    (await execute("git", args, { cwd: root, windowsHide: true, maxBuffer: 32 * 1024 * 1024 }))
      .stdout;
  try {
    const revision = (await git("rev-parse", "HEAD")).trim();
    const status = await git("status", "--porcelain=v1", "-z", "--ignore-submodules=all");
    const filenames = (await git("ls-files", "--cached", "--others", "--exclude-standard", "-z"))
      .split("\0")
      .filter(Boolean);
    const files = [];
    for (const filename of [...new Set(filenames)].sort()) {
      if (
        !/^(desktop\/|deployer\/|installer\/|scripts\/|plugins\/|\.agents\/skills\/test-performance\/|deploy\.py$|package(-lock)?\.json$|requirements\.txt$|pyproject\.toml$)/.test(
          filename,
        )
      )
        continue;
      if (
        !/\.(?:[cm]?js|tsx?|vue|json|py|ps1|bat|txt|toml|md)$/.test(filename) ||
        /(^|\/)(node_modules|dist|release|resources|\.env)(\/|$)/.test(filename)
      )
        continue;
      try {
        const absolute = path.join(root, filename);
        const info = await lstat(absolute);
        if (info.isFile() && !info.isSymbolicLink())
          files.push({ path: filename, sha256: (await inspectFile(absolute)).sha256 });
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        files.push({ path: filename, sha256: null });
      }
    }
    return {
      revision,
      dirty: Boolean(status),
      dirtySourceFingerprint: createHash("sha256").update(JSON.stringify(files)).digest("hex"),
      files,
    };
  } catch {
    return {
      revision: null,
      dirty: null,
      dirtySourceFingerprint: null,
      files: [],
      provenanceIssue: "Git source identity could not be collected",
    };
  }
}

export async function collectArtifact(app) {
  if (!app)
    return {
      available: false,
      sourceAssociation: "unknown",
      reason: "No packaged --app executable supplied",
    };
  const executable = await inspectFile(app);
  const archive = path.join(path.dirname(app), "resources", "app.asar");
  try {
    const application = await inspectFile(archive, Buffer.from("microclaw.performance.fixture.v1"));
    let runtime = null;
    try {
      runtime = (await inspectFile(path.join(path.dirname(app), "resources", "openclaw.asar")))
        .sha256;
    } catch {}
    return {
      available: application.containsMarker,
      executableSha256: executable.sha256,
      applicationSha256: application.sha256,
      openclawRuntimeSha256: runtime,
      sourceAssociation: "unknown: binary hashes do not establish which checkout built them",
      reason: application.containsMarker
        ? null
        : "Packaged application lacks the isolation contract; rebuild before measuring. It was not launched.",
    };
  } catch {
    return {
      available: false,
      executableSha256: executable.sha256,
      sourceAssociation: "unknown",
      reason:
        "A packaged resources/app.asar with the performance isolation contract is required. Application was not launched.",
    };
  }
}

export async function collectEnvironment() {
  let playwright = null;
  try {
    playwright = JSON.parse(
      await readFile(
        new URL("../../node_modules/playwright/package.json", import.meta.url),
        "utf8",
      ),
    ).version;
  } catch {}
  return {
    machineId: createHash("sha256").update(os.hostname()).digest("hex").slice(0, 16),
    platform: process.platform,
    osRelease: os.release(),
    arch: process.arch,
    cpu: os.cpus()[0]?.model ?? null,
    cpuCount: os.cpus().length,
    ramBytes: os.totalmem(),
    gpu: null,
    node: process.version,
    playwright,
  };
}
