import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export function updateSignedWindowsNodeManifest(resourceRoot) {
  const manifestPath = path.join(resourceRoot, "RUNTIME.json");
  const hostPath = path.join(resourceRoot, "host", "microclaw-windows-node-host.exe");
  if (!existsSync(manifestPath) || !existsSync(hostPath)) {
    throw new Error(`Packaged Windows Node resources are incomplete under ${resourceRoot}`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.contract !== "microclaw.windows-node-exec.v2") {
    throw new Error("Packaged Windows Node runtime contract is unsupported");
  }
  verifyPackagedFileWorker(path.join(resourceRoot, "host"), manifest.runtimeIdentifier);
  manifest.hostSha256 = sha256File(hostPath);
  manifest.packagedHashStage = "electron-builder-after-sign";

  const temporaryPath = `${manifestPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(temporaryPath, manifestPath);
}

function verifyPackagedFileWorker(hostRoot, rid) {
  if (!/^win-(x64|arm64)$/.test(rid)) {
    throw new Error(`Invalid fixed-worker runtime identifier: ${rid}`);
  }
  const workerRoot = path.join(hostRoot, "Workers", "FileWorker", rid);
  const slots = readdirSync(workerRoot, { withFileTypes: true });
  if (slots.length !== 1 || !slots[0].isDirectory()) {
    throw new Error("Expected one manifest-addressed fixed-worker payload");
  }
  const slot = path.join(workerRoot, slots[0].name);
  const manifestBytes = readFileSync(path.join(slot, "payload-manifest.json"));
  if (sha256(manifestBytes).slice(0, 32) !== slots[0].name) {
    throw new Error("Fixed-worker manifest does not match its payload directory");
  }
  const payload = JSON.parse(manifestBytes.toString("utf8"));
  const files =
    payload.files && typeof payload.files === "object" && !Array.isArray(payload.files)
      ? Object.entries(payload.files)
      : [];
  if (
    payload.version !== 1 ||
    payload.rid !== rid ||
    files.length === 0 ||
    files.length > 512 ||
    !Object.hasOwn(payload.files, "OpenClaw.FileWorker.exe") ||
    !Object.hasOwn(payload.files, "coreclr.dll")
  ) {
    throw new Error("Invalid fixed-worker payload manifest");
  }
  const names = new Set(files.map(([name]) => name));
  const actual = readdirSync(slot, { withFileTypes: true });
  if (
    actual.length !== files.length + 1 ||
    actual.some(
      (entry) =>
        !entry.isFile() || (entry.name !== "payload-manifest.json" && !names.has(entry.name)),
    )
  ) {
    throw new Error("Fixed-worker payload inventory changed after publication");
  }
  for (const [name, digest] of files) {
    if (
      path.basename(name) !== name ||
      name.includes(":") ||
      typeof digest !== "string" ||
      !/^[a-f0-9]{64}$/.test(digest) ||
      sha256File(path.join(slot, name)) !== digest
    ) {
      throw new Error(`Fixed-worker payload changed after publication: ${name}`);
    }
  }
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sha256File(filePath) {
  return sha256(readFileSync(filePath));
}

export default async function afterSign(context) {
  updateSignedWindowsNodeManifest(path.join(context.appOutDir, "resources", "windows-node"));
}
