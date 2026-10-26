import { describe, expect, it } from "vitest";
import type { LocalModelStep } from "../../../src/local-model-types";
import { summarizeManagedDownload } from "./local-model-presentation";

const prompt = [
  "Runs on Gateway host desktop-host (win32/x64), using the CPU.",
  "64 GiB RAM; 1721.3 GiB free disk.",
  "Qwen3.5 9B (Q4_K_M) fits the 39.2 GiB CPU memory budget with a 64K context. Runtime verification checks the actual model before activation.",
  "OpenClaw will check a real tool call before making this your default model.",
  "",
  "Download Qwen3.5 9B (Q4_K_M) (5.7 GB), the local embedding model (about 0.3 GB), and the verified CPU runtime, then use this model?",
].join("\n");
const step: LocalModelStep = {
  id: "download",
  type: "confirm",
  executor: "client",
  message: prompt,
};

describe("managed download presentation", () => {
  it("summarizes model files separately from the additional runtime download", () => {
    expect(summarizeManagedDownload(step, true)).toEqual({
      modelName: "Qwen3.5 9B",
      downloadGB: 6,
      backend: "cpu",
    });
    expect(step.message).toBe(prompt);
  });

  it("supports declared GPU backends and separate runtime volumes", () => {
    const message = prompt
      .replace("the CPU.", "NVIDIA CUDA.")
      .replace("CPU memory budget", "GPU memory budget")
      .replace("verified CPU runtime", "verified CUDA runtime")
      .replace(
        "1721.3 GiB free disk.",
        "1721.3 GiB free disk.\n40 GiB free on the runtime volume.",
      );
    expect(summarizeManagedDownload({ ...step, message }, true)?.backend).toBe("gpu");
  });

  it.each([
    prompt + "\nAccept additional license terms.",
    prompt.replace(
      "OpenClaw will check",
      "Additional permissions are required.\nOpenClaw will check",
    ),
    prompt.replace("5.7 GB", "5700 MB"),
    prompt.replace("verified CPU runtime", "verified CUDA runtime"),
    prompt.replace("0.3 GB", "0 GB"),
    prompt.replace("Qwen3.5 9B (Q4_K_M) fits", "A different model fits"),
    "Download a model and allow access to all files?",
  ])("keeps unfamiliar or extended consent messages unabridged", (message) => {
    expect(summarizeManagedDownload({ ...step, message }, true)).toBeNull();
  });

  it("does not summarize other flows, sensitive steps, or gateway-owned work", () => {
    expect(summarizeManagedDownload(step, false)).toBeNull();
    expect(summarizeManagedDownload({ ...step, type: "note" }, true)).toBeNull();
    expect(summarizeManagedDownload({ ...step, sensitive: true }, true)).toBeNull();
    expect(
      summarizeManagedDownload({ ...step, title: "Additional permission review" }, true),
    ).toBeNull();
    expect(
      summarizeManagedDownload(
        { ...step, options: [{ label: "Extra permission", value: true }] },
        true,
      ),
    ).toBeNull();
    expect(summarizeManagedDownload({ ...step, executor: "gateway" }, true)).toBeNull();
    expect(summarizeManagedDownload(undefined, true)).toBeNull();
  });
});
