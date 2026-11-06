import { mkdtempSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectLocalModelFiles, parseManagedModelPaths } from "./local-model-files";

const directories: string[] = [];
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "microclaw-model-files-"));
  directories.push(root);
  const model = path.join(root, "model.gguf");
  const preset = path.join(root, "models.ini");
  writeFileSync(model, "GGUF");
  writeFileSync(preset, `version = 1\n\n[local-model]\nmodel = ${model}\nctx-size = 65536\n`);
  return {
    root,
    model,
    preset,
    provider: {
      localService: {
        command: path.join(root, "llama-server.exe"),
        args: ["--models-preset", preset],
      },
      models: [{ id: "local-model", params: { modelPath: "hf:repo/model.gguf" } }],
    },
  };
}
afterEach(() => {
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("managed local model file metadata", () => {
  it("detects deletion and restoration without caching or reading model contents", () => {
    const f = fixture();
    expect(inspectLocalModelFiles(f.provider).get("local-model")).toBe("present");
    unlinkSync(f.model);
    expect(inspectLocalModelFiles(f.provider).get("local-model")).toBe("missing");
    writeFileSync(f.model, "GGUF");
    expect(inspectLocalModelFiles(f.provider).get("local-model")).toBe("present");
  });

  it("supports quoted paths, aliases and comments without applying wildcard model paths", () => {
    const f = fixture();
    const ini = `version = 1\r\n[*]\nmodel = ignored\n[local-model] # owned\nm = "${f.model}" ; note\n[another]\nLLAMA_ARG_MODEL = ${path.join(f.root, "absent.gguf")}\n`;
    const paths = parseManagedModelPaths(ini);
    expect(paths.get("local-model")).toBe(f.model);
    expect(paths.has("*")).toBe(false);
    writeFileSync(f.preset, ini);
    const states = inspectLocalModelFiles({
      ...f.provider,
      models: [{ id: "local-model" }, { id: "another" }],
    });
    expect(states.get("local-model")).toBe("present");
    expect(states.get("another")).toBe("missing");
  });

  it("checks an explicit absolute managed model path when no router preset is used", () => {
    const f = fixture();
    expect(
      inspectLocalModelFiles({
        localService: { command: "managed-server" },
        models: [{ id: "custom", params: { modelPath: f.model } }],
      }).get("custom"),
    ).toBe("present");
  });

  it("does not guess HF cache filenames or inspect external servers and network shares", () => {
    const f = fixture();
    expect(
      inspectLocalModelFiles({
        models: f.provider.models,
        baseUrl: "http://localhost:8080",
      }).get("local-model"),
    ).toBe("external");
    expect(
      inspectLocalModelFiles({
        localService: { command: "server" },
        models: f.provider.models,
      }).get("local-model"),
    ).toBe("unknown");
    expect(
      inspectLocalModelFiles({
        localService: { args: ["--models-preset", "\\\\server\\share\\models.ini"] },
        models: f.provider.models,
      }).get("local-model"),
    ).toBe("unknown");
  });

  it("reports a missing preset and non-file/empty model paths as missing local files", () => {
    const f = fixture();
    writeFileSync(f.model, "");
    expect(inspectLocalModelFiles(f.provider).get("local-model")).toBe("missing");
    unlinkSync(f.model);
    mkdirSync(f.model);
    expect(inspectLocalModelFiles(f.provider).get("local-model")).toBe("missing");
    unlinkSync(f.preset);
    expect(inspectLocalModelFiles(f.provider).get("local-model")).toBe("missing");
  });

  it("logs unsupported or unreadable preset metadata rather than pretending files exist", () => {
    const f = fixture();
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeFileSync(f.preset, Buffer.alloc(128 * 1024 + 1));
    expect(inspectLocalModelFiles(f.provider).get("local-model")).toBe("unknown");
    expect(warning).toHaveBeenCalledOnce();
    unlinkSync(f.preset);
    mkdirSync(f.preset);
    expect(inspectLocalModelFiles(f.provider).get("local-model")).toBe("unknown");
    expect(warning).toHaveBeenCalledTimes(2);
  });
});
