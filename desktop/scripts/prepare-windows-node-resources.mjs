import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  cpSync,
  existsSync,
  readdirSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { publishPreparedResource } from "./publish-prepared-resource.mjs";

const desktopDir = path.resolve(import.meta.dirname, "..");
const repositoryDir = path.resolve(desktopDir, "..");
const archArguments = process.argv.slice(2).filter((argument) => argument.startsWith("--arch="));
if (archArguments.length !== 1 || process.argv.length !== 3) {
  throw new Error(
    "Specify exactly one Windows package architecture with --arch=x64 or --arch=arm64",
  );
}
const targetArch = archArguments[0].slice("--arch=".length);
if (process.env.MICROCLAW_WINDOWS_ARCH && process.env.MICROCLAW_WINDOWS_ARCH !== targetArch) {
  throw new Error(
    `Architecture mismatch: argument=${targetArch}, environment=${process.env.MICROCLAW_WINDOWS_ARCH}`,
  );
}
const ridByArch = { x64: "win-x64", arm64: "win-arm64" };
const expectedSdkHashes = {
  managed: "59761d9a868cde01ef05139775ad6d072f9425b5b73b911bdf465b29b4bf20a6",
  x64: {
    "mxc_ffi.dll": "bd45522f06dc9cc8001dcd5d7320bc2bf303fb08a39bf10f3404bd9a8001812c",
    "plm.exe": "beffc9c9ab974ca9e7455089fd8ecb36eb8c92811ddd1705db91370a689692c3",
    "wslcsdk.dll": "8d4d55d4283fb32a5909b57e78b576d01363d7b28bb9b2595115e80faf61db5b",
    "wxc-wslc-daemon.exe": "84f61c1bc13abde8da1c3f2ff100e6d59368ecaabdbfeca939e6fdb696202d0c",
  },
  arm64: {
    "mxc_ffi.dll": "1becaf695ad9ab6f6fe21ca4ad2e838d9218996a5d42cb82e609df1eb4d3db6b",
    "plm.exe": "8818982c6b91c78d9198dc03d5efc8a9a34a1075afb4a6a3e9f1a750c5462532",
    "wslcsdk.dll": "ad440e116a64af004fe021b95914163021c2e8f40b0f8b6d8ece210ee5cae3d4",
    "wxc-wslc-daemon.exe": "ad9a7a42a607c2670e493b9f4d5eb4f2cd959c9d05b8882df42f9d8ecc1f6fef",
  },
};
const expectedWindowsNodeRevision = "f0592215f27100d9ecece33d3069daac76a4125c";
const sdkVersion = "1.0.1";
const rid = ridByArch[targetArch];

if (process.platform !== "win32" || !rid) {
  throw new Error(
    `Windows Node resources support x64/arm64 Windows only (got ${process.platform}/${targetArch})`,
  );
}

const upstreamDir = path.join(repositoryDir, "third_party", "openclaw-windows-node", "source");
const sharedProject = path.join(upstreamDir, "src", "OpenClaw.Shared", "OpenClaw.Shared.csproj");
if (!existsSync(sharedProject)) {
  throw new Error(
    "Pinned OpenClaw Windows Node source is missing; initialize the repository submodules",
  );
}
const upstreamRevision = spawnSync("git", ["-C", upstreamDir, "rev-parse", "HEAD"], {
  encoding: "utf8",
});
if (upstreamRevision.error) throw upstreamRevision.error;
if (upstreamRevision.status !== 0) {
  throw new Error("Unable to verify the OpenClaw Windows Node source revision");
}
if (upstreamRevision.stdout.trim() !== expectedWindowsNodeRevision) {
  throw new Error(
    `Expected OpenClaw Windows Node ${expectedWindowsNodeRevision}, found ${upstreamRevision.stdout.trim()}`,
  );
}

const destination = process.env.MICROCLAW_WINDOWS_NODE_OUTPUT
  ? path.resolve(process.env.MICROCLAW_WINDOWS_NODE_OUTPUT)
  : path.resolve(desktopDir, "resources", "windows-node");
const resourceRoot = `${destination}.staging-${randomUUID()}`;
const hostOutput = path.join(resourceRoot, "host");
const fileWorkerOutput = path.join(resourceRoot, "file-worker-payload");
mkdirSync(resourceRoot, { recursive: true });
process.on("exit", () => rmSync(resourceRoot, { recursive: true, force: true }));

const workerPublish = spawnSync(
  "dotnet",
  [
    "publish",
    path.join(upstreamDir, "src", "OpenClaw.FileWorker", "OpenClaw.FileWorker.csproj"),
    "--configuration",
    "Release",
    "--runtime",
    rid,
    "--self-contained",
    "true",
    "--output",
    fileWorkerOutput,
    "-p:DebugType=None",
    "-p:ImportDirectoryBuildProps=false",
    "-p:ImportDirectoryBuildTargets=false",
    "-p:DisableGitVersionTask=true",
    "-m:1",
  ],
  { stdio: "inherit" },
);
if (workerPublish.error) throw workerPublish.error;
if (workerPublish.status !== 0) process.exit(workerPublish.status ?? 1);
const fileWorkerManifest = path.join(fileWorkerOutput, "payload-manifest.json");
const workerManifest = spawnSync(
  path.join(
    process.env.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  ),
  [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    path.join(upstreamDir, "scripts", "Write-FileWorkerManifest.ps1"),
    "-PayloadDirectory",
    fileWorkerOutput,
    "-RuntimeIdentifier",
    rid,
    "-ProductVersion",
    JSON.parse(readFileSync(path.join(desktopDir, "package.json"), "utf8")).version,
  ],
  { stdio: "inherit" },
);
if (workerManifest.error) throw workerManifest.error;
if (workerManifest.status !== 0) process.exit(workerManifest.status ?? 1);
const fileWorkerPayloadId = createHash("sha256")
  .update(readFileSync(fileWorkerManifest))
  .digest("hex")
  .slice(0, 32);

const publish = spawnSync(
  "dotnet",
  [
    "publish",
    path.join(repositoryDir, "windows-node-host", "MicroClaw.WindowsNodeHost.csproj"),
    "--configuration",
    "Release",
    "--runtime",
    rid,
    "--self-contained",
    "true",
    "--output",
    hostOutput,
    "-p:PublishSingleFile=true",
    "-p:DebugType=None",
    "-p:ImportDirectoryBuildProps=false",
    "-p:ImportDirectoryBuildTargets=false",
    "-p:DisableGitVersionTask=true",
    `-p:MicroClawFileWorkerManifest=${fileWorkerManifest}`,
    "-m:1",
  ],
  { stdio: "inherit" },
);
if (publish.error) throw publish.error;
if (publish.status !== 0) process.exit(publish.status ?? 1);

const assets = JSON.parse(
  readFileSync(path.join(repositoryDir, "windows-node-host", "obj", "project.assets.json"), "utf8"),
);
if (!assets.libraries?.[`Microsoft.Mxc.Sdk/${sdkVersion}`]) {
  throw new Error(`The Windows node did not restore Microsoft.Mxc.Sdk ${sdkVersion}`);
}
const packageDir = Object.keys(assets.packageFolders ?? {})
  .map((folder) => path.join(folder, "microsoft.mxc.sdk", sdkVersion))
  .find((folder) => existsSync(folder));
if (!packageDir) throw new Error(`The restored Microsoft.Mxc.Sdk ${sdkVersion} package is missing`);
const assertSdkHash = (filePath, expected) => {
  const actual = createHash("sha256").update(readFileSync(filePath)).digest("hex");
  if (actual !== expected)
    throw new Error(`MXC SDK asset hash mismatch for ${filePath}: ${actual}`);
};
assertSdkHash(
  path.join(packageDir, "lib", "net8.0", "Microsoft.Mxc.Sdk.dll"),
  expectedSdkHashes.managed,
);
for (const [fileName, hash] of Object.entries(expectedSdkHashes[targetArch])) {
  assertSdkHash(path.join(packageDir, "runtimes", rid, "native", fileName), hash);
}
copyFileSync(path.join(packageDir, "LICENSE.md"), path.join(resourceRoot, "MXC-LICENSE.md"));
copyFileSync(
  path.join(repositoryDir, "third_party", "openclaw-windows-node", "LICENSE"),
  path.join(resourceRoot, "WINDOWS-NODE-LICENSE"),
);
copyFileSync(
  path.join(repositoryDir, "third_party", "openclaw-windows-node", "PROVENANCE.json"),
  path.join(resourceRoot, "PROVENANCE.json"),
);

const hostExe = path.join(hostOutput, "microclaw-windows-node-host.exe");
if (!existsSync(hostExe)) throw new Error(`Host publish did not produce ${hostExe}`);
for (const entry of readdirSync(hostOutput)) {
  if (entry !== path.basename(hostExe)) {
    rmSync(path.join(hostOutput, entry), { recursive: true, force: true });
  }
}
const installedFileWorker = path.join(
  hostOutput,
  "Workers",
  "FileWorker",
  rid,
  fileWorkerPayloadId,
);
mkdirSync(path.dirname(installedFileWorker), { recursive: true });
cpSync(fileWorkerOutput, installedFileWorker, { recursive: true, errorOnExist: true });
rmSync(fileWorkerOutput, { recursive: true, force: true });
const hostHash = createHash("sha256").update(readFileSync(hostExe)).digest("hex");
writeFileSync(
  path.join(resourceRoot, "RUNTIME.json"),
  JSON.stringify(
    {
      architecture: targetArch,
      runtimeIdentifier: rid,
      mxcVersion: sdkVersion,
      mxcManagedSha256: expectedSdkHashes.managed,
      mxcNativeSha256: expectedSdkHashes[targetArch],
      windowsNodeRevision: expectedWindowsNodeRevision,
      hostSha256: hostHash,
      contract: "microclaw.windows-node-exec.v2",
    },
    null,
    2,
  ),
);
const publication = publishPreparedResource(resourceRoot, destination);
console.log(`[windows-node] Resources ${publication}`);
console.log(`[windows-node] staged ${rid}, MXC ${sdkVersion}, ` + `host sha256=${hostHash}`);
