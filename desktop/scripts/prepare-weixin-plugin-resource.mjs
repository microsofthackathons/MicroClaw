import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stageWeixinRuntime } from "./stage-weixin-runtime.mjs";

export const WEIXIN_RUNTIME_MANIFEST_CONTRACT = "microclaw.weixin-runtime.v1";
export const WEIXIN_VENDOR_ARCHIVE_SHA256 =
  "ef1c3600ca2fc0ee9076c1327af1e0d5d2e8e19fbb61e9f56c961fcde0bd07f6";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(scriptDir, "..");
const repositoryDir = path.resolve(desktopDir, "..");
const sourceDir = path.join(repositoryDir, "plugins", "openclaw-weixin");
const vendorArchive = path.join(
  sourceDir,
  "vendor",
  "tencent-weixin-openclaw-weixin-2.4.6.tgz",
);
const resourcesDir = path.join(desktopDir, "resources");
const resourceDir = path.join(resourcesDir, "openclaw-weixin");

function sha256File(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function listRegularFiles(root) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replaceAll("\\", "/");
      if (relative === "microclaw-runtime.json") continue;
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile()) files.push(relative);
      else throw new Error(`Weixin resource contains an unsupported filesystem entry: ${relative}`);
    }
  };
  visit(root);
  return files.sort();
}

function readRequiredOpenClawExports(root) {
  const imports = new Set();
  const distRoot = path.join(root, "dist");
  for (const relative of listRegularFiles(distRoot)) {
    if (!relative.endsWith(".js")) continue;
    const source = fs.readFileSync(path.join(distRoot, relative), "utf8");
    for (const match of source.matchAll(/["']openclaw\/([^"']+)["']/g)) {
      imports.add(`./${match[1]}`);
    }
  }
  return [...imports].sort();
}

export function writeWeixinRuntimeManifest(root) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const files = listRegularFiles(root).map((relativePath) => {
    const absolute = path.join(root, relativePath);
    return {
      path: relativePath,
      size: fs.statSync(absolute).size,
      sha256: sha256File(absolute),
    };
  });
  const treeSha256 = createHash("sha256")
    .update(
      files
        .map((file) => `${file.path}|${file.size}|${file.sha256}`)
        .join("\n"),
      "utf8",
    )
    .digest("hex");
  const manifest = {
    contract: WEIXIN_RUNTIME_MANIFEST_CONTRACT,
    packageName: packageJson.name,
    packageVersion: packageJson.version,
    sdkCompatibility: packageJson.microclaw?.sdkCompatibility,
    requiredOpenClawExports: readRequiredOpenClawExports(root),
    treeSha256,
    files,
  };
  fs.writeFileSync(
    path.join(root, "microclaw-runtime.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    "utf8",
  );
  return manifest;
}

export function prepareWeixinPluginResource({
  source = sourceDir,
  archive = vendorArchive,
  destination = resourceDir,
} = {}) {
  if (sha256File(archive) !== WEIXIN_VENDOR_ARCHIVE_SHA256) {
    throw new Error("The vendored Weixin archive hash does not match the pinned artifact");
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  const staging = path.join(
    path.dirname(destination),
    `.openclaw-weixin-stage-${process.pid}-${randomUUID()}`,
  );
  fs.mkdirSync(staging);
  try {
    const extraction = spawnSync(
      "tar",
      ["-xzf", archive, "-C", staging, "--strip-components=1"],
      { encoding: "utf8" },
    );
    if (extraction.error) throw extraction.error;
    if (extraction.status !== 0) {
      throw new Error(
        `Could not extract the pinned Weixin artifact: ${extraction.stderr || extraction.stdout}`,
      );
    }
    stageWeixinRuntime(source, staging);
    fs.rmSync(path.join(staging, "node_modules", "openclaw"), {
      recursive: true,
      force: true,
    });
    const manifest = writeWeixinRuntimeManifest(staging);
    if (
      manifest.sdkCompatibility !== "2026.10.2" ||
      !fs.existsSync(path.join(staging, "dist", "index.js"))
    ) {
      throw new Error("The staged Weixin runtime is not compatible with OpenClaw 2026.10.2");
    }
    fs.rmSync(destination, { recursive: true, force: true });
    fs.renameSync(staging, destination);
    return manifest;
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const manifest = prepareWeixinPluginResource();
  console.log(
    `Prepared Weixin ${manifest.packageVersion} for OpenClaw ${manifest.sdkCompatibility} (${manifest.treeSha256}).`,
  );
}
