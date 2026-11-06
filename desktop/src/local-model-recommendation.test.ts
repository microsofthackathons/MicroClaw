import { describe, expect, it } from "vitest";
import { LOCAL_MODEL_PRESETS, type LocalModelCatalogEntry } from "./local-model-catalog";
import { recommendLocalModel } from "./local-model-recommendation";
import type { LocalModelHardware } from "./local-model-types";

const GIB = 1024 ** 3;
const catalog: LocalModelCatalogEntry[] = LOCAL_MODEL_PRESETS.map((preset) => ({
  ...preset,
  configured: false,
  fileStatus: "not-downloaded",
}));
const hardware = (patch: Partial<LocalModelHardware> = {}): LocalModelHardware => ({
  cpu: "Example CPU",
  totalMemoryBytes: 64 * GIB,
  availableMemoryBytes: 48 * GIB,
  accelerator: "cpu",
  gpus: [],
  ...patch,
});
const gpu = (total: number, available = total) => ({
  name: "Example GPU",
  totalMemoryBytes: total * GIB,
  availableMemoryBytes: available * GIB,
});

describe("local model recommendation", () => {
  it("prefers a lightweight starting point for CPU use even with ample system RAM", () => {
    expect(recommendLocalModel(catalog, hardware())).toMatchObject({
      modelRef: LOCAL_MODEL_PRESETS[0].modelRef,
      reason: "cpu",
      fit: { [LOCAL_MODEL_PRESETS[3].modelRef]: "acceleration" },
    });
  });
  it("uses available VRAM, not only installed RAM, for a dedicated GPU", () => {
    const result = recommendLocalModel(
      catalog,
      hardware({ accelerator: "cuda", gpus: [gpu(16, 12)] }),
    );
    expect(result.modelRef).toBe(LOCAL_MODEL_PRESETS[1].modelRef);
    expect(result.fit[LOCAL_MODEL_PRESETS[2].modelRef]).toBe("gpu-memory");
  });
  it("preserves GPU headroom rather than treating all advertised VRAM as available", () => {
    expect(
      recommendLocalModel(catalog, hardware({ accelerator: "cuda", gpus: [gpu(24)] })).modelRef,
    ).toBe(LOCAL_MODEL_PRESETS[1].modelRef);
  });
  it("offers a larger model only when its conservative catalog budgets fit", () => {
    expect(
      recommendLocalModel(catalog, hardware({ accelerator: "cuda", gpus: [gpu(32)] })).modelRef,
    ).toBe(LOCAL_MODEL_PRESETS[2].modelRef);
  });
  it("never adds VRAM from separate GPUs", () => {
    expect(
      recommendLocalModel(catalog, hardware({ accelerator: "cuda", gpus: [gpu(8), gpu(8)] }))
        .modelRef,
    ).toBe(LOCAL_MODEL_PRESETS[0].modelRef);
  });
  it("does not recommend a model when other applications have exhausted available memory", () => {
    const result = recommendLocalModel(catalog, hardware({ availableMemoryBytes: 4 * GIB }));
    expect(result.reason).toBe("limited");
    expect(result.modelRef).toBeUndefined();
  });
  it("reserves system memory and respects minimum installed memory", () => {
    const result = recommendLocalModel(
      catalog,
      hardware({ totalMemoryBytes: 8 * GIB, availableMemoryBytes: 8 * GIB }),
    );
    expect(result.modelRef).toBe(LOCAL_MODEL_PRESETS[0].modelRef);
    expect(result.fit[LOCAL_MODEL_PRESETS[1].modelRef]).toBe("memory");
  });
  it.each([
    null,
    hardware({ totalMemoryBytes: NaN }),
    hardware({ availableMemoryBytes: 65 * GIB }),
  ])("does not invent a recommendation for missing or invalid hardware", (value) => {
    expect(recommendLocalModel(catalog, value)).toEqual({ reason: "unknown", fit: {} });
  });
  it("does not invent usable CUDA memory when no valid device was reported", () => {
    expect(
      recommendLocalModel(catalog, hardware({ accelerator: "cuda", gpus: [gpu(8, 9)] })).reason,
    ).toBe("limited");
  });
  it("recommends only models in the displayed catalog", () => {
    const result = recommendLocalModel(catalog.slice(1, 2), hardware());
    expect(result.modelRef).toBe(LOCAL_MODEL_PRESETS[1].modelRef);
  });
  it("does not claim compatibility for an unknown catalog model", () => {
    const result = recommendLocalModel(
      [{ ...catalog[0], modelRef: "llama-cpp/unknown" }],
      hardware(),
    );
    expect(result.modelRef).toBeUndefined();
    expect(result.fit["llama-cpp/unknown"]).toBe("unknown");
  });
  it("uses shared system memory for Metal without adding imaginary dedicated VRAM", () => {
    expect(recommendLocalModel(catalog, hardware({ accelerator: "metal" })).modelRef).toBe(
      LOCAL_MODEL_PRESETS[2].modelRef,
    );
  });
});
