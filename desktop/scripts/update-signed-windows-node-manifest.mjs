import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

export function updateSignedWindowsNodeManifest(resourceRoot) {
  const manifestPath = path.join(resourceRoot, "RUNTIME.json");
  const patchedHostPrepPath = path.join(resourceRoot, "host-prep", "microclaw-mxc-host-prep.exe");
  if (!existsSync(manifestPath) || !existsSync(patchedHostPrepPath)) {
    throw new Error(`Packaged Windows Node resources are incomplete under ${resourceRoot}`);
  }

  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.microclawHostPrepSha256 = createHash("sha256")
    .update(readFileSync(patchedHostPrepPath))
    .digest("hex");
  manifest.microclawHostPrepPackagedHashStage = "electron-builder-after-sign";

  const temporaryPath = `${manifestPath}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`);
  renameSync(temporaryPath, manifestPath);
}

export default async function afterSign(context) {
  updateSignedWindowsNodeManifest(path.join(context.appOutDir, "resources", "windows-node"));
}
