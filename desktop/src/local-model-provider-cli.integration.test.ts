import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";

const entry = process.env.MICROCLAW_TEST_OPENCLAW_ENTRY;
it.skipIf(!entry || process.env.MICROCLAW_TEST_INSTALL_LOCAL_PROVIDER !== "1")(
  "uses the installer CLI commands to prepare only the pinned provider without changing the default",
  () => {
    const root = mkdtempSync(path.join(tmpdir(), "microclaw-local-provider-cli-"));
    const configPath = path.join(root, "openclaw.json");
    const before = {
      gateway: { mode: "local", bind: "loopback" },
      agents: { defaults: { model: { primary: "cloud/keep" } } },
      plugins: { allow: ["parallel"] },
    };
    writeFileSync(configPath, JSON.stringify(before));
    try {
      for (const args of [
        [
          "plugins",
          "install",
          "clawhub:@openclaw/llama-cpp-provider@2026.10.5",
          "--accept-capabilities",
        ],
        ["plugins", "enable", "llama-cpp", "--accept-capabilities"],
      ]) {
        const child = spawnSync(
          process.execPath,
          [
            "--import",
            pathToFileURL(path.join(__dirname, "openclaw-fs-safe-compat.mjs")).href,
            entry!,
            ...args,
          ],
          {
            env: {
              ...process.env,
              OPENCLAW_STATE_DIR: root,
              OPENCLAW_CONFIG_PATH: configPath,
              MICROCLAW_FS_SAFE_COMPAT: "1",
              MICROCLAW_OPENCLAW_PACKAGE_DIR: path.dirname(entry!),
              OPENCLAW_NO_RESPAWN: "1",
            },
            encoding: "utf8",
            timeout: 240_000,
            windowsHide: true,
          },
        );
        expect(child.status, `${child.stderr}\n${child.stdout}`.slice(-5000)).toBe(0);
      }
      const after = JSON.parse(readFileSync(configPath, "utf8"));
      expect(after.agents).toEqual(before.agents);
      expect(after.models).toBeUndefined();
      expect(after.plugins.entries["llama-cpp"].enabled).toBe(true);
      expect(after.plugins.allow).toContain("llama-cpp");
      expect(after.plugins.allow).toContain("parallel");
      const pkg = JSON.parse(
        readFileSync(path.join(root, "extensions", "llama-cpp", "package.json"), "utf8"),
      );
      expect(pkg.name).toBe("@openclaw/llama-cpp-provider");
      expect(pkg.version).toBe("2026.10.5");
      expect(readdirSync(root).includes("models")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  },
  500_000,
);
