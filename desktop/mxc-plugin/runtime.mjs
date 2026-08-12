import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

const SDK_VERSION = "0.7.0";
const POLICY_VERSION = "0.7.0-alpha";
const PLUGIN_ROOT = path.dirname(fileURLToPath(import.meta.url));
const EXPECTED_HASHES = {
  x64: "2wo0Ir6eGzlswbJUfHD/FrJ0EkOKMcEKRavzcMrIauI=",
  arm64: "5DDQ5PRPYW6R22hPjYJabck+BqEmK40AvKrHUioxeqs=",
};
const MAX_OUTPUT_BYTES = 1024 * 1024;

// The executable is resolved only from application-owned package resources.
// Do not let the SDK's debugging override redirect either probes or launches.
delete process.env.MXC_BIN_DIR;

function resolveSdkRoot() {
  const candidates = [
    path.join(PLUGIN_ROOT, "node_modules", "@microsoft", "mxc-sdk"),
    path.join(PLUGIN_ROOT, "..", "node_modules", "@microsoft", "mxc-sdk"),
  ];
  const sdkRoot = candidates.find((candidate) => existsSync(path.join(candidate, "package.json")));
  if (!sdkRoot) {
    throw new Error(
      "Pinned @microsoft/mxc-sdk@0.7.0 is missing from the packaged MXC plugin resources.",
    );
  }
  return sdkRoot;
}

function resolveRuntimePaths() {
  const sdkRoot = resolveSdkRoot();
  const architecture = process.arch === "arm64" ? "arm64" : "x64";
  const wxcPath = path.join(sdkRoot, "bin", architecture, "wxc-exec.exe");
  const workerPath = path.join(PLUGIN_ROOT, "worker.mjs");
  const packageJson = JSON.parse(readFileSync(path.join(sdkRoot, "package.json"), "utf8"));
  if (packageJson.version !== SDK_VERSION) {
    throw new Error(`Expected @microsoft/mxc-sdk ${SDK_VERSION}, found ${packageJson.version}.`);
  }
  if (!existsSync(wxcPath) || !statSync(wxcPath).isFile()) {
    throw new Error(`Packaged wxc-exec is missing for ${architecture}.`);
  }
  const binaryHash = createHash("sha256").update(readFileSync(wxcPath)).digest("base64");
  if (binaryHash !== EXPECTED_HASHES[architecture]) {
    throw new Error("Packaged wxc-exec failed the pinned SHA-256 check.");
  }
  return { sdkRoot, architecture, wxcPath, workerPath, binaryHash };
}

function runProbe(wxcPath) {
  return new Promise((resolve, reject) => {
    execFile(
      wxcPath,
      ["--probe"],
      { windowsHide: true, timeout: 5000, maxBuffer: 256 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(`wxc-exec --probe failed: ${stderr || error.message}`));
          return;
        }
        try {
          resolve(JSON.parse(stdout));
        } catch {
          reject(new Error("wxc-exec --probe returned malformed JSON."));
        }
      },
    );
  });
}

function parseProbe(value) {
  const tiers = new Set(["base-container", "appcontainer-bfs", "appcontainer-dacl"]);
  return {
    tier: tiers.has(value?.tier) ? value.tier : undefined,
    warnings: Array.isArray(value?.warnings)
      ? value.warnings.filter((warning) => typeof warning === "string")
      : [],
    uiCapabilities:
      value?.probes?.uiCapabilities && typeof value.probes.uiCapabilities === "object"
        ? value.probes.uiCapabilities
        : undefined,
  };
}

function stripWorkerEnvironment(workspace, nodeExecutable) {
  const systemRoot = process.env.SystemRoot || process.env.WINDIR || "C:\\Windows";
  const temp = path.join(workspace, ".mxc-tmp");
  return {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    ComSpec: path.join(systemRoot, "System32", "cmd.exe"),
    COMSPEC: path.join(systemRoot, "System32", "cmd.exe"),
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    PATH: `${path.dirname(nodeExecutable)};${path.join(systemRoot, "System32")}`,
    TEMP: temp,
    TMP: temp,
    HOME: workspace,
    USERPROFILE: workspace,
  };
}

function quoteWindowsArgument(value) {
  return `"${String(value).replaceAll('"', '\\"')}"`;
}

async function loadSdk(sdkRoot) {
  return import(pathToFileURL(path.join(sdkRoot, "dist", "index.js")).href);
}

export async function probeMxcRuntime() {
  if (process.platform !== "win32") {
    throw new Error("The MicroClaw MXC POC currently supports Windows only.");
  }
  const paths = resolveRuntimePaths();
  const probe = parseProbe(await runProbe(paths.wxcPath));
  return {
    packageVersion: SDK_VERSION,
    binaryHash: paths.binaryHash,
    platform: process.platform,
    architecture: paths.architecture,
    probe,
  };
}

export async function runMxcWorker(policy, request, options = {}) {
  const paths = resolveRuntimePaths();
  const sdk = await loadSdk(paths.sdkRoot);
  const nodeExecutable = options.nodeExecutable || process.execPath;
  if (
    path.basename(nodeExecutable).toLowerCase() !== "node.exe" ||
    !existsSync(nodeExecutable) ||
    !statSync(nodeExecutable).isFile()
  ) {
    return { ok: false, error: "The trusted packaged Node runtime is unavailable." };
  }
  const timeoutMs = Math.min(Math.max(Number(options.timeoutMs) || 30000, 1000), 30000);
  const filesystem = {
    readonlyPaths: [
      path.dirname(nodeExecutable),
      PLUGIN_ROOT,
      ...(Array.isArray(policy.readonlyPaths) ? policy.readonlyPaths : []),
    ],
    readwritePaths: [
      policy.workspace,
      ...(Array.isArray(policy.readwritePaths) ? policy.readwritePaths : []),
    ],
    deniedPaths: Array.isArray(policy.deniedPaths) ? policy.deniedPaths : [],
    clearPolicyOnExit: true,
  };
  const config = sdk.createConfigFromPolicy(
    {
      version: POLICY_VERSION,
      filesystem,
      network: { allowOutbound: false, allowLocalNetwork: false },
      ui: { allowWindows: false, clipboard: "none", allowInputInjection: false },
      timeoutMs,
    },
    "process",
  );
  config.fallback = { allowDaclMutation: false };
  config.processContainer.leastPrivilege = true;
  config.process.commandLine = `${quoteWindowsArgument(nodeExecutable)} ${quoteWindowsArgument(
    paths.workerPath,
  )}`;
  config.process.cwd = policy.workspace;
  config.process.env = Object.entries(stripWorkerEnvironment(policy.workspace, nodeExecutable)).map(
    ([key, value]) => `${key}=${value}`,
  );

  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let child;
    try {
      child = sdk.spawnSandboxFromConfig(
        config,
        { usePty: false, executablePath: paths.wxcPath },
        policy.workspace,
      );
    } catch (error) {
      resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    child.stdout?.on("data", (chunk) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString();
    });
    child.on("error", (error) => finish({ ok: false, error: error.message }));
    child.on("close", (code) => {
      if (code !== 0) {
        finish({ ok: false, error: stderr.trim() || `MXC worker exited with code ${code}.` });
        return;
      }
      try {
        finish(JSON.parse(stdout.trim()));
      } catch {
        finish({ ok: false, error: "MXC worker returned malformed output." });
      }
    });
    child.stdin?.end(
      JSON.stringify({
        request,
        policy: {
          workspace: policy.workspace,
          readonlyPaths: policy.readonlyPaths,
          readwritePaths: policy.readwritePaths,
        },
      }),
    );
  });
}
