import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { materializeRuntimeArchive } from "./bundled-runtime";

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
});
