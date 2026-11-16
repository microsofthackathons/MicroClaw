import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { normalizeNpmRegistry, npmRegistryEnvironment, resolveBuildNpmRegistry, writeBundledNpmRegistry } from "./npm-registry.mjs";

test("build source honors only explicit product overrides before the shared default", () => {
  const defaultValue = JSON.parse(fs.readFileSync(new URL("../../deployer/assets/npm-registry.json", import.meta.url), "utf8"));
  assert.equal(resolveBuildNpmRegistry({ NPM_CONFIG_REGISTRY: "https://ambient.invalid/" }), normalizeNpmRegistry(defaultValue.registry));
  assert.equal(resolveBuildNpmRegistry({ MICROCLAW_NPM_REGISTRY: "https://product.invalid/Feed/", MSIX_NPM_REGISTRY: "https://legacy.invalid/" }), "https://product.invalid/Feed");
  assert.equal(resolveBuildNpmRegistry({ MSIX_NPM_REGISTRY: "https://legacy.invalid/" }), "https://legacy.invalid");
});

test("build adapter follows the shared validation contract", () => {
  const cases = JSON.parse(fs.readFileSync(new URL("../../tests/fixtures/npm-registry-contract.json", import.meta.url), "utf8"));
  for (const [value, expected] of cases.valid) assert.equal(normalizeNpmRegistry(value), expected);
  for (const value of cases.invalid) assert.throws(() => normalizeNpmRegistry(value));
});

test("bundled metadata carries the selected source without mutating ambient configuration", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "microclaw-npm-build-"));
  try {
    const env = { NPM_CONFIG_REGISTRY: "https://ambient.invalid/", NPM_CONFIG_CAFILE: "corporate.pem" };
    const result = npmRegistryEnvironment(env, "https://deployment.invalid/Feed/");
    assert.deepEqual(env, { NPM_CONFIG_REGISTRY: "https://ambient.invalid/", NPM_CONFIG_CAFILE: "corporate.pem" });
    assert.equal(result.NPM_CONFIG_REGISTRY, undefined);
    assert.equal(result.npm_config_registry, "https://deployment.invalid/Feed");
    assert.equal(result.NPM_CONFIG_CAFILE, "corporate.pem");
    writeBundledNpmRegistry(root, result.npm_config_registry);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "npm-registry.json"), "utf8")), { schema: 1, registry: "https://deployment.invalid/Feed" });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
