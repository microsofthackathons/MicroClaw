import { spawnSync } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";

const defaults = {
  MSIX_IDENTITY_NAME: "MicroClaw.Test",
  MSIX_PUBLISHER: "CN=MicroClaw Test",
  MSIX_PUBLISHER_DISPLAY_NAME: "MicroClaw",
  MSIX_APPLICATION_ID: "MicroClaw",
};

for (const [name, value] of Object.entries(defaults)) {
  if (!process.env[name]) {
    process.env[name] = value;
    console.warn(`[msix] ${name} is unset; using validation identity "${value}".`);
  }
}

if (!/^[A-Za-z0-9.-]{3,50}$/.test(process.env.MSIX_IDENTITY_NAME)) {
  throw new Error(
    "MSIX_IDENTITY_NAME must be 3-50 characters using letters, numbers, periods, or hyphens",
  );
}
if (!/^[A-Za-z][A-Za-z0-9.]*$/.test(process.env.MSIX_APPLICATION_ID)) {
  throw new Error(
    "MSIX_APPLICATION_ID must contain alphanumeric dot-separated fields beginning with a letter",
  );
}
if (!/^CN=.+/.test(process.env.MSIX_PUBLISHER)) {
  throw new Error("MSIX_PUBLISHER must be an X.500 distinguished name beginning with CN=");
}

const packageJson = JSON.parse(
  readFileSync(path.resolve(import.meta.dirname, "..", "package.json"), "utf8"),
);
const version = (process.env.MSIX_VERSION || packageJson.version).replace(/^v/, "");
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  throw new Error("MSIX_VERSION must be a three-part numeric version, for example 1.2.3");
}

const builderCli = path.resolve(
  import.meta.dirname,
  "..",
  "node_modules",
  "electron-builder",
  "out",
  "cli",
  "cli.js",
);
const overrides = [
  `--config.appx.identityName=${process.env.MSIX_IDENTITY_NAME}`,
  `--config.appx.publisher=${process.env.MSIX_PUBLISHER}`,
  `--config.appx.publisherDisplayName=${process.env.MSIX_PUBLISHER_DISPLAY_NAME}`,
  `--config.appx.applicationId=${process.env.MSIX_APPLICATION_ID}`,
  `--config.extraMetadata.version=${version}`,
];
let result;
try {
  result = spawnSync(process.execPath, [builderCli, "--win", "appx", "--x64", ...overrides], {
    cwd: path.resolve(import.meta.dirname, ".."),
    env: process.env,
    stdio: "inherit",
  });
} finally {
  rmSync(path.resolve(import.meta.dirname, "..", "resources"), { recursive: true, force: true });
}

if (!result) throw new Error("electron-builder did not start");
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
