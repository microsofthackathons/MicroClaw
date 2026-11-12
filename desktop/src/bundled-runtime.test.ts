import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createPackage } from "@electron/asar";
import { afterEach, describe, expect, it } from "vitest";
import { materializeRuntimeArchive, runtimeArchiveCacheVersion } from "./bundled-runtime";
import {
  RUNTIME_PREPARATION_TIMING_PREFIX,
  RuntimePreparationTiming,
  type RuntimePreparationTimingEvent,
} from "./runtime-preparation-timing";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("materializeRuntimeArchive", () => {
  it("reports rebuild stages and skips them on a cache hit", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "microclaw-runtime-timing-"));
    roots.push(root);
    const runtimeRoot = path.join(root, "runtime");
    const events: RuntimePreparationTimingEvent[] = [];
    const timing = new RuntimePreparationTiming("worker", (message) => {
      events.push(JSON.parse(message.slice(RUNTIME_PREPARATION_TIMING_PREFIX.length)));
    });
    const extract = (_archive: string, destination: string) => {
      const packageRoot = path.join(destination, "node_modules", "openclaw");
      fs.mkdirSync(packageRoot, { recursive: true });
      fs.writeFileSync(path.join(packageRoot, "openclaw.mjs"), "export {};");
    };
    materializeRuntimeArchive("archive", runtimeRoot, "current", extract, timing);
    expect(
      events.filter((event) => event.status === "success").map((event) => event.phase),
    ).toEqual([
      "cache-check",
      "staging-cleanup",
      "staging-parent-create",
      "archive-extract",
      "entry-validation",
      "version-marker-write",
      "runtime-publish",
    ]);
    expect(events[1]).toMatchObject({ cache: "miss" });
    events.length = 0;
    materializeRuntimeArchive(
      "archive",
      runtimeRoot,
      "current",
      () => {
        throw new Error("A current runtime must not be extracted again");
      },
      timing,
    );
    expect(events).toHaveLength(2);
    expect(events.at(-1)).toMatchObject({ phase: "cache-check", cache: "hit" });
  });

  it("reports extraction failure and cleanup without replacing the old runtime", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "microclaw-runtime-timing-"));
    roots.push(root);
    const runtimeRoot = path.join(root, "runtime");
    fs.mkdirSync(runtimeRoot);
    fs.writeFileSync(path.join(runtimeRoot, "previous"), "preserved");
    const events: RuntimePreparationTimingEvent[] = [];
    const timing = new RuntimePreparationTiming("worker", (message) => {
      events.push(JSON.parse(message.slice(RUNTIME_PREPARATION_TIMING_PREFIX.length)));
    });
    expect(() =>
      materializeRuntimeArchive(
        "archive",
        runtimeRoot,
        "current",
        (_archive, stagingRoot) => {
          fs.mkdirSync(stagingRoot);
          throw new Error("disk full");
        },
        timing,
      ),
    ).toThrow("Failed to prepare");
    expect(events).toContainEqual(
      expect.objectContaining({ phase: "archive-extract", status: "failed" }),
    );
    expect(events.at(-1)).toMatchObject({ phase: "failed-staging-cleanup", status: "success" });
    expect(fs.readFileSync(path.join(runtimeRoot, "previous"), "utf8")).toBe("preserved");
    expect(fs.existsSync(`${runtimeRoot}.staging-${process.pid}`)).toBe(false);
    expect(events.some((event) => event.phase === "old-runtime-remove")).toBe(false);
  });

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
      runtimeArchiveCacheVersion(
        "openclaw.asar",
        "1.0.0",
        (_archive, filename) => {
          expect(filename).toBe(path.join("node_modules", "openclaw", "package.json"));
          return Buffer.from(JSON.stringify({ name: "openclaw", version }));
        },
        () => "test-header",
      );

    materializeRuntimeArchive("openclaw.asar", runtimeRoot, "1.0.0", extract);
    materializeRuntimeArchive("openclaw.asar", runtimeRoot, cacheVersion("2026.10.2"), extract);
    expect(fs.existsSync(`${runtimeRoot}.previous`)).toBe(true);
    // The installer retires the previous generation only after validation.
    fs.rmSync(`${runtimeRoot}.previous`, { recursive: true });
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
    expect(version).toMatch(/^1\.0\.0:openclaw@2026\.10\.5:[a-f0-9]{64}$/);
    const runtime = materializeRuntimeArchive(archive, path.join(root, "runtime"), version);
    expect(
      fs.readFileSync(path.join(runtime, "node_modules", "openclaw", "openclaw.mjs"), "utf8"),
    ).toBe("export {};");
  });

  it("invalidates a same-version cache when archive contents change", () => {
    const metadata = () => Buffer.from(JSON.stringify({ name: "openclaw", version: "2026.10.10" }));
    expect(runtimeArchiveCacheVersion("archive", "1.0", metadata, () => "old header")).not.toBe(
      runtimeArchiveCacheVersion("archive", "1.0", metadata, () => "new header"),
    );
  });

  it("restores the previous runtime when publishing the staged generation fails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "microclaw-runtime-rollback-"));
    roots.push(root);
    const runtime = path.join(root, "openclaw");
    const extract = (_archive: string, destination: string) => {
      fs.mkdirSync(path.join(destination, "node_modules", "openclaw"), { recursive: true });
      fs.writeFileSync(path.join(destination, "node_modules", "openclaw", "openclaw.mjs"), "entry");
    };
    materializeRuntimeArchive("archive", runtime, "old", extract);
    expect(() =>
      materializeRuntimeArchive("archive", runtime, "new", extract, undefined, () => {
        throw new Error("publication failed");
      }),
    ).toThrow("Failed to prepare");
    expect(fs.readFileSync(path.join(runtime, ".microclaw-version"), "utf8").trim()).toBe("old");
    expect(fs.existsSync(`${runtime}.previous`)).toBe(false);
  });
});
