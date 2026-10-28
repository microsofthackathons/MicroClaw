import { createHash, randomUUID } from "crypto";
import fs from "fs";
import path from "path";

const RUNTIME_MANIFEST = "microclaw-runtime.json";
const RUNTIME_MANIFEST_CONTRACT = "microclaw.weixin-runtime.v1";
const WEIXIN_EXTENSION_DIRECTORY = "openclaw-weixin";
const WEIXIN_PACKAGE_NAME = "@tencent-weixin/openclaw-weixin";
const WEIXIN_PACKAGE_VERSION = "2.4.6";
const OPENCLAW_SDK_VERSION = "2026.10.5";

interface RuntimeManifestFile {
  path: string;
  size: number;
  sha256: string;
}

interface RuntimeManifest {
  contract: typeof RUNTIME_MANIFEST_CONTRACT;
  packageName: string;
  packageVersion: string;
  sdkCompatibility: string;
  requiredOpenClawExports: string[];
  treeSha256: string;
  files: RuntimeManifestFile[];
}

export interface WeixinPluginConvergenceResult {
  changed: boolean;
  packageVersion: string;
  treeSha256: string;
}

interface ConvergenceHooks {
  afterInstalledRename?: () => void;
}

function sha256File(filePath: string): string {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
}

function normalizeRelativePath(value: string): string {
  if (
    value.length === 0 ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    value.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Invalid Weixin runtime manifest path: ${value}`);
  }
  return value;
}

function parseRuntimeManifest(root: string): RuntimeManifest {
  const manifestPath = path.join(root, RUNTIME_MANIFEST);
  const parsed: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("The bundled Weixin runtime manifest is invalid");
  }
  const value = parsed as Record<string, unknown>;
  if (
    value.contract !== RUNTIME_MANIFEST_CONTRACT ||
    value.packageName !== WEIXIN_PACKAGE_NAME ||
    value.packageVersion !== WEIXIN_PACKAGE_VERSION ||
    value.sdkCompatibility !== OPENCLAW_SDK_VERSION ||
    typeof value.treeSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.treeSha256) ||
    !Array.isArray(value.requiredOpenClawExports) ||
    !Array.isArray(value.files)
  ) {
    throw new Error("The bundled Weixin runtime manifest does not satisfy its contract");
  }
  const requiredOpenClawExports = value.requiredOpenClawExports.map((entry) => {
    if (typeof entry !== "string" || !entry.startsWith("./plugin-sdk/")) {
      throw new Error("The bundled Weixin runtime declares an invalid OpenClaw SDK export");
    }
    return entry;
  });
  if (new Set(requiredOpenClawExports).size !== requiredOpenClawExports.length) {
    throw new Error("The bundled Weixin runtime declares duplicate OpenClaw SDK exports");
  }
  const files = value.files.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("The bundled Weixin runtime manifest contains an invalid file");
    }
    const file = entry as Record<string, unknown>;
    if (
      typeof file.path !== "string" ||
      typeof file.size !== "number" ||
      !Number.isSafeInteger(file.size) ||
      file.size < 0 ||
      typeof file.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/.test(file.sha256)
    ) {
      throw new Error("The bundled Weixin runtime manifest contains invalid file metadata");
    }
    return {
      path: normalizeRelativePath(file.path),
      size: file.size,
      sha256: file.sha256,
    };
  });
  if (new Set(files.map((file) => file.path)).size !== files.length) {
    throw new Error("The bundled Weixin runtime manifest contains duplicate file paths");
  }
  return {
    contract: RUNTIME_MANIFEST_CONTRACT,
    packageName: value.packageName,
    packageVersion: value.packageVersion,
    sdkCompatibility: value.sdkCompatibility,
    requiredOpenClawExports,
    treeSha256: value.treeSha256,
    files,
  };
}

function validateRuntimeTree(
  root: string,
  manifest: RuntimeManifest,
  expectedManifestText: string,
  hostPackageDir?: string,
): void {
  if (fs.readFileSync(path.join(root, RUNTIME_MANIFEST), "utf8") !== expectedManifestText) {
    throw new Error("The installed Weixin runtime provenance manifest does not match the package");
  }
  const actualFiles: string[] = [];
  const links: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replaceAll("\\", "/");
      if (relative === RUNTIME_MANIFEST) continue;
      if (entry.isSymbolicLink()) {
        links.push(relative);
      } else if (entry.isDirectory()) {
        visit(absolute);
      } else if (entry.isFile()) {
        actualFiles.push(relative);
      } else {
        throw new Error(`The Weixin runtime contains an unsupported filesystem entry: ${relative}`);
      }
    }
  };
  visit(root);
  const expectedFiles = manifest.files.map((file) => file.path).sort();
  actualFiles.sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error("The Weixin runtime file tree does not match its pinned provenance manifest");
  }
  for (const file of manifest.files) {
    const absolute = path.join(root, file.path);
    const stat = fs.statSync(absolute);
    if (stat.size !== file.size || sha256File(absolute) !== file.sha256) {
      throw new Error(`The Weixin runtime file failed provenance validation: ${file.path}`);
    }
  }
  const treeSha256 = createHash("sha256")
    .update(
      manifest.files.map((file) => `${file.path}|${file.size}|${file.sha256}`).join("\n"),
      "utf8",
    )
    .digest("hex");
  if (treeSha256 !== manifest.treeSha256) {
    throw new Error("The Weixin runtime tree hash does not match its provenance manifest");
  }
  if (hostPackageDir === undefined) {
    if (links.length > 0 || fs.existsSync(path.join(root, "node_modules", "openclaw"))) {
      throw new Error("The bundled Weixin runtime must not contain an OpenClaw core copy or link");
    }
    return;
  }
  if (
    links.length !== 1 ||
    links[0] !== "node_modules/openclaw" ||
    !fs.lstatSync(path.join(root, "node_modules", "openclaw")).isSymbolicLink()
  ) {
    throw new Error("The installed Weixin runtime has an invalid OpenClaw peer link");
  }
  const expectedHost = fs.realpathSync.native(hostPackageDir);
  const actualHost = fs.realpathSync.native(path.join(root, "node_modules", "openclaw"));
  if (path.resolve(actualHost).toLowerCase() !== path.resolve(expectedHost).toLowerCase()) {
    throw new Error("The installed Weixin runtime is linked to a different OpenClaw host");
  }
}

function validateHostOpenClaw(hostPackageDir: string, manifest: RuntimeManifest): void {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(hostPackageDir, "package.json"), "utf8"),
  ) as {
    version?: unknown;
    exports?: unknown;
  };
  if (packageJson.version !== manifest.sdkCompatibility) {
    throw new Error(
      `Weixin ${manifest.packageVersion} requires OpenClaw ${manifest.sdkCompatibility}; found ${String(packageJson.version)}`,
    );
  }
  if (
    !packageJson.exports ||
    typeof packageJson.exports !== "object" ||
    Array.isArray(packageJson.exports)
  ) {
    throw new Error("The OpenClaw host does not declare plugin SDK exports");
  }
  const exports = packageJson.exports as Record<string, unknown>;
  const missing = manifest.requiredOpenClawExports.filter(
    (requiredExport) => !Object.prototype.hasOwnProperty.call(exports, requiredExport),
  );
  if (missing.length > 0) {
    throw new Error(
      `The OpenClaw host is missing required Weixin SDK exports: ${missing.join(", ")}`,
    );
  }
}

function validatePackageIdentity(root: string, manifest: RuntimeManifest): void {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as {
    name?: unknown;
    version?: unknown;
    openclaw?: { runtimeExtensions?: unknown };
    microclaw?: { sdkCompatibility?: unknown };
  };
  if (
    packageJson.name !== manifest.packageName ||
    packageJson.version !== manifest.packageVersion ||
    packageJson.microclaw?.sdkCompatibility !== manifest.sdkCompatibility ||
    !Array.isArray(packageJson.openclaw?.runtimeExtensions) ||
    !packageJson.openclaw.runtimeExtensions.includes("./dist/index.js") ||
    !fs.existsSync(path.join(root, "dist", "index.js"))
  ) {
    throw new Error("The Weixin runtime package identity does not match its provenance manifest");
  }
}

function removeDirectory(directory: string): void {
  fs.rmSync(directory, { recursive: true, force: true });
}

export function resolveBundledWeixinPluginRoot(
  packaged: boolean,
  resourcesPath: string,
  compiledDirectory = __dirname,
): string {
  return packaged
    ? path.join(resourcesPath, WEIXIN_EXTENSION_DIRECTORY)
    : path.resolve(compiledDirectory, "..", "resources", WEIXIN_EXTENSION_DIRECTORY);
}

export function convergeWeixinPluginRuntime({
  bundledPluginRoot,
  stateDir,
  hostPackageDir,
  hooks,
}: {
  bundledPluginRoot: string;
  stateDir: string;
  hostPackageDir: string;
  hooks?: ConvergenceHooks;
}): WeixinPluginConvergenceResult {
  const extensionsRoot = path.join(path.resolve(stateDir), "extensions");
  const installedRoot = path.join(extensionsRoot, WEIXIN_EXTENSION_DIRECTORY);
  if (path.dirname(installedRoot) !== extensionsRoot) {
    throw new Error("The Weixin extension destination is outside the OpenClaw extensions root");
  }
  const manifest = parseRuntimeManifest(bundledPluginRoot);
  const expectedManifestText = fs.readFileSync(
    path.join(bundledPluginRoot, RUNTIME_MANIFEST),
    "utf8",
  );
  validatePackageIdentity(bundledPluginRoot, manifest);
  validateHostOpenClaw(hostPackageDir, manifest);

  if (fs.existsSync(installedRoot)) {
    try {
      validatePackageIdentity(installedRoot, manifest);
      validateRuntimeTree(installedRoot, manifest, expectedManifestText, hostPackageDir);
      return {
        changed: false,
        packageVersion: manifest.packageVersion,
        treeSha256: manifest.treeSha256,
      };
    } catch {
      // Replace stale, same-version, or otherwise untrusted plugin content below.
    }
  }

  validateRuntimeTree(bundledPluginRoot, manifest, expectedManifestText);
  fs.mkdirSync(extensionsRoot, { recursive: true });
  const transactionId = randomUUID();
  const stagingRoot = path.join(extensionsRoot, `.openclaw-weixin-stage-${transactionId}`);
  const backupRoot = path.join(extensionsRoot, `.openclaw-weixin-backup-${transactionId}`);
  let backupCreated = false;
  let installedCreated = false;
  try {
    fs.cpSync(bundledPluginRoot, stagingRoot, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    fs.mkdirSync(path.join(stagingRoot, "node_modules"), { recursive: true });
    fs.symlinkSync(hostPackageDir, path.join(stagingRoot, "node_modules", "openclaw"), "junction");
    validatePackageIdentity(stagingRoot, manifest);
    validateRuntimeTree(stagingRoot, manifest, expectedManifestText, hostPackageDir);
    if (fs.existsSync(installedRoot)) {
      fs.renameSync(installedRoot, backupRoot);
      backupCreated = true;
    }
    fs.renameSync(stagingRoot, installedRoot);
    installedCreated = true;
    hooks?.afterInstalledRename?.();
    validatePackageIdentity(installedRoot, manifest);
    validateRuntimeTree(installedRoot, manifest, expectedManifestText, hostPackageDir);
    if (backupCreated) removeDirectory(backupRoot);
    return {
      changed: true,
      packageVersion: manifest.packageVersion,
      treeSha256: manifest.treeSha256,
    };
  } catch (error) {
    const rollbackErrors: unknown[] = [];
    if (installedCreated) {
      try {
        removeDirectory(installedRoot);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    if (backupCreated) {
      try {
        fs.renameSync(backupRoot, installedRoot);
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError);
      }
    }
    try {
      removeDirectory(stagingRoot);
    } catch (rollbackError) {
      rollbackErrors.push(rollbackError);
    }
    if (rollbackErrors.length > 0) {
      throw new AggregateError(
        [error, ...rollbackErrors],
        "Weixin plugin convergence failed and rollback was incomplete",
        { cause: error },
      );
    }
    throw error;
  }
}
