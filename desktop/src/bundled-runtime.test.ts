import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createPackage } from "@electron/asar";
import { afterEach, describe, expect, it } from "vitest";
import { materializeRuntimeArchive, runtimeArchiveCacheVersion } from "./bundled-runtime";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("materializeRuntimeArchive", () => {
  it("extracts once per desktop version and replaces stale runtimes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "microclaw-runtime-"));
    roots.push(root);
    const runtimeRoot = path.join(root, "runtime");
    let extractions = 0;
    const extract = (_archive: string, destination: string) => {
      extractions += 1;
      const packageRoot = path.join(destination, "node_modules", "openclaw");
      fs.mkdirSync(packageRoot, { recursive: true });
      fs.writeFileSync(path.join(packageRoot, "openclaw.mjs"), `version-${extractions}`);
    };

    expect(materializeRuntimeArchive("openclaw.asar", runtimeRoot, "1.0.0", extract)).toBe(
      runtimeRoot,
    );
    materializeRuntimeArchive("openclaw.asar", runtimeRoot, "1.0.0", extract);
    expect(extractions).toBe(1);

    materializeRuntimeArchive("openclaw.asar", runtimeRoot, "1.0.1", extract);
    expect(extractions).toBe(2);
    expect(
      fs.readFileSync(path.join(runtimeRoot, "node_modules", "openclaw", "openclaw.mjs"), "utf8"),
    ).toBe("version-2");
  });

  it("replaces a legacy cache and a changed SDK even when the desktop version is unchanged", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "microclaw-runtime-"));
    roots.push(root);
    const runtimeRoot = path.join(root, "runtime");
    let extractions = 0;
    const extract = (_archive: string, destination: string) => {
      extractions += 1;
      fs.mkdirSync(path.join(destination, "node_modules", "openclaw"), { recursive: true });
      fs.writeFileSync(path.join(destination, "node_modules", "openclaw", "openclaw.mjs"), "");
    };
    const cacheVersion = (version: string) =>
      runtimeArchiveCacheVersion("openclaw.asar", "1.0.0", (_archive, filename) => {
        expect(filename).toBe(path.join("node_modules", "openclaw", "package.json"));
        return Buffer.from(JSON.stringify({ name: "openclaw", version }));
      });

    materializeRuntimeArchive("openclaw.asar", runtimeRoot, "1.0.0", extract);
    materializeRuntimeArchive("openclaw.asar", runtimeRoot, cacheVersion("2026.10.2"), extract);
    materializeRuntimeArchive("openclaw.asar", runtimeRoot, cacheVersion("2026.10.5"), extract);
    materializeRuntimeArchive("openclaw.asar", runtimeRoot, cacheVersion("2026.10.5"), extract);
    expect(extractions).toBe(3);
  });

  it.each([null, {}, { name: "other", version: "2026.10.5" }, { name: "openclaw", version: "" }])(
    "rejects invalid bundled package identity %j",
    (metadata) => {
      expect(() =>
        runtimeArchiveCacheVersion("openclaw.asar", "1.0.0", () =>
          Buffer.from(JSON.stringify(metadata)),
        ),
      ).toThrow("invalid package metadata");
    },
  );
  it("reads and materializes a real archive using platform-native entry paths", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "microclaw-runtime-"));
    roots.push(root);
    const source = path.join(root, "source");
    const packageRoot = path.join(source, "node_modules", "openclaw");
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.10.5" }),
    );
    fs.writeFileSync(path.join(packageRoot, "openclaw.mjs"), "export {};");
    const archive = path.join(root, "openclaw.asar");
    await createPackage(source, archive);
    const version = runtimeArchiveCacheVersion(archive, "1.0.0");
    expect(version).toBe("1.0.0:openclaw@2026.10.5");
    const runtime = materializeRuntimeArchive(archive, path.join(root, "runtime"), version);
    expect(
      fs.readFileSync(path.join(runtime, "node_modules", "openclaw", "openclaw.mjs"), "utf8"),
    ).toBe("export {};");
  });
});
