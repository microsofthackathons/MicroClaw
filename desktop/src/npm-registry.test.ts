import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { spawnSync } from "node:child_process";
import { microClawNpmEnvironment, normalizeNpmRegistry, resolveMicroClawNpmRegistry } from "./npm-registry";

const roots: string[] = [];
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "microclaw-npm-registry-"));
  roots.push(root);
  const resourcesDir = path.join(root, "resources");
  const installDir = path.join(root, "app");
  fs.mkdirSync(resourcesDir);
  fs.mkdirSync(path.join(installDir, "install-state"), { recursive: true });
  const defaultConfigPath = path.join(root, "default.json");
  fs.writeFileSync(defaultConfigPath, JSON.stringify({ schema: 1, registry: "https://default.invalid/npm/" }));
  const save = (name: string, value: unknown) => fs.writeFileSync(name, JSON.stringify(value));
  return { root, locations: { resourcesDir, installDir, defaultConfigPath }, save,
    dedicated: path.join(installDir, "install-state", "npm-registry.json"),
    legacy: path.join(installDir, "install-state", "install-manifest.json") };
}
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

describe("MicroClaw-owned npm source", () => {
  it("uses the shared cross-language URL contract", () => {
    const cases = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../tests/fixtures/npm-registry-contract.json"), "utf8"));
    for (const [value, expected] of cases.valid) expect(normalizeNpmRegistry(value)).toBe(expected);
    for (const value of cases.invalid) {
      expect(() => normalizeNpmRegistry(value)).toThrow("absolute HTTP(S)");
      try { normalizeNpmRegistry(value); } catch (error) { expect(String(error)).not.toContain(value); }
    }
  });

  it("selects environment, application config, legacy manifest, bundle, then default", () => {
    const f = fixture();
    expect(resolveMicroClawNpmRegistry({ NPM_CONFIG_REGISTRY: "https://ambient.invalid" }, f.locations)).toBe("https://default.invalid/npm");
    f.save(path.join(f.locations.resourcesDir, "npm-registry.json"), { schema: 1, registry: "https://bundle.invalid/" });
    expect(resolveMicroClawNpmRegistry({}, f.locations)).toBe("https://bundle.invalid");
    f.save(f.legacy, { schema: 2, npmRegistry: "https://legacy.invalid/Feed/" });
    expect(resolveMicroClawNpmRegistry({}, f.locations)).toBe("https://legacy.invalid/Feed");
    f.save(f.dedicated, { schema: 1, registry: "https://application.invalid/Team/npm/" });
    expect(resolveMicroClawNpmRegistry({}, f.locations)).toBe("https://application.invalid/Team/npm");
    expect(resolveMicroClawNpmRegistry({ MICROCLAW_NPM_REGISTRY: "https://deployment.invalid/" }, f.locations)).toBe("https://deployment.invalid");
  });

  it("refuses an invalid saved source instead of silently switching to a public default", () => {
    const f = fixture();
    f.save(f.dedicated, { schema: 1, registry: "https://user:private-password@invalid.example" });
    expect(() => resolveMicroClawNpmRegistry({}, f.locations)).toThrow("without credentials");
    expect(resolveMicroClawNpmRegistry({ MICROCLAW_NPM_REGISTRY: "https://repair.invalid/" }, f.locations)).toBe("https://repair.invalid");
  });

  it("rejects malformed configuration without exposing its contents or falling back", () => {
    const f = fixture();
    fs.writeFileSync(f.dedicated, '{"registry":"https://invalid.example/?token=private-token"');
    expect(() => resolveMicroClawNpmRegistry({}, f.locations)).toThrow("invalid JSON");
    try { resolveMicroClawNpmRegistry({}, f.locations); } catch (error) {
      expect(String(error)).not.toContain("private-token");
    }
  });

  it("pins npm child settings while retaining enterprise auth, certificates and proxy settings", () => {
    const f = fixture();
    const original = { ...process.env, MICROCLAW_NPM_REGISTRY: "https://enterprise.invalid/Feed/",
      NPM_CONFIG_REGISTRY: "https://ambient.invalid", npm_config_registry: "https://other.invalid",
      NPM_CONFIG_REPLACE_REGISTRY_HOST: "never", HTTPS_PROXY: "http://proxy.invalid:8080",
      NPM_CONFIG_CAFILE: "corporate-ca.pem", NPM_TOKEN: "synthetic-token" };
    const before = { ...original };
    const env = microClawNpmEnvironment(original, f.locations);
    expect(original).toEqual(before);
    expect(env.NPM_CONFIG_REGISTRY).toBeUndefined();
    expect(env.npm_config_registry).toBe("https://enterprise.invalid/Feed");
    expect(env.npm_config_replace_registry_host).toBe("npmjs");
    for (const key of ["HTTPS_PROXY", "NPM_CONFIG_CAFILE", "NPM_TOKEN"]) expect(env[key]).toBe(original[key as keyof typeof original]);
    const child = spawnSync(process.execPath, ["-e", "process.stdout.write(process.env.npm_config_registry)"], { env, encoding: "utf8" });
    expect(child.status).toBe(0);
    expect(child.stdout).toBe("https://enterprise.invalid/Feed");
    expect(fs.readdirSync(path.join(f.locations.installDir, "install-state"))).toEqual([]);
  });
});
