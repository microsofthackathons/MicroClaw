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
import { createHash } from "node:crypto";
import path from "node:path";

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
const expectedWxcExecSha256 = {
  x64: "db0a3422be9e1b396cc1b2547c70ff16b27412438a31c10a45abf370cac86ae2",
  arm64: "e430d0e4f44f616e91db684f8d825a6dc93e06a1262b8d00bcaac7522a317aab",
};
const expectedWindowsNodeRevision = "fc9add75eda78daf548d80a55ffb64e63b159961";
const rid = ridByArch[targetArch];

if (process.platform !== "win32" || !rid) {
  throw new Error(
    `Windows Node resources support x64/arm64 Windows only (got ${process.platform}/${targetArch})`,
  );
}

const packageDir = path.join(desktopDir, "node_modules", "@microsoft", "mxc-sdk");
const packageJsonPath = path.join(packageDir, "package.json");
if (!existsSync(packageJsonPath)) {
  throw new Error("@microsoft/mxc-sdk@0.7.0 is not installed; run npm install in desktop/");
}
const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
if (packageJson.version !== "0.7.0") {
  throw new Error(`Expected @microsoft/mxc-sdk 0.7.0, found ${packageJson.version}`);
}

const sourceMxcDir = path.join(packageDir, "bin", targetArch);
const sourceWxcExec = path.join(sourceMxcDir, "wxc-exec.exe");
const actualWxcExecHash = createHash("sha256").update(readFileSync(sourceWxcExec)).digest("hex");
if (actualWxcExecHash !== expectedWxcExecSha256[targetArch]) {
  throw new Error(`MXC 0.7.0 ${targetArch} wxc-exec.exe hash mismatch: ${actualWxcExecHash}`);
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

const resourceRoot = path.join(desktopDir, "resources", "windows-node");
const hostOutput = path.join(resourceRoot, "host");
const mxcOutput = path.join(resourceRoot, "mxc");
rmSync(resourceRoot, { recursive: true, force: true });
mkdirSync(resourceRoot, { recursive: true });

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
  ],
  { stdio: "inherit" },
);
if (publish.error) throw publish.error;
if (publish.status !== 0) process.exit(publish.status ?? 1);

cpSync(sourceMxcDir, mxcOutput, { recursive: true });
copyFileSync(path.join(packageDir, "LICENSE.md"), path.join(resourceRoot, "MXC-LICENSE.md"));
copyFileSync(
  path.join(repositoryDir, "third_party", "openclaw-windows-node", "LICENSE"),
  path.join(resourceRoot, "WINDOWS-NODE-LICENSE"),
);
copyFileSync(
  path.join(repositoryDir, "third_party", "openclaw-windows-node", "PROVENANCE.json"),
  path.join(resourceRoot, "PROVENANCE.json"),
);
writeFileSync(
  path.join(resourceRoot, "RUNTIME.json"),
  JSON.stringify(
    {
      architecture: targetArch,
      runtimeIdentifier: rid,
      mxcVersion: packageJson.version,
      wxcExecSha256: actualWxcExecHash,
      windowsNodeRevision: expectedWindowsNodeRevision,
    },
    null,
    2,
  ),
);

const hostExe = path.join(hostOutput, "microclaw-windows-node-host.exe");
if (!existsSync(hostExe)) throw new Error(`Host publish did not produce ${hostExe}`);
for (const entry of readdirSync(hostOutput)) {
  if (entry !== path.basename(hostExe)) {
    rmSync(path.join(hostOutput, entry), { recursive: true, force: true });
  }
}
console.log(
  `[windows-node] staged ${rid}, MXC ${packageJson.version}, wxc-exec sha256=${actualWxcExecHash}`,
);
