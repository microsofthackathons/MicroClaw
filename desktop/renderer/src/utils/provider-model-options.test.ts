import { describe, expect, it } from "vitest";
import {
  getProviderCatalogOptions,
  getProviderModelSections,
  isProviderModelVisible,
  isRecommendedProviderModel,
} from "./provider-model-options";

describe("Qwen model options", () => {
  it("only offers Qwen chat models, including namespaced and serving-prefixed aliases", () => {
    const models = [
      "MiniMax/MiniMax-M3.1-Flash",
      "qwen3.8-plus",
      "kimi/kimi-k3.1-pro",
      "qwen-image-2.1-pro",
      "qwen3.8-omni-flash-realtime",
      "deepseek-v4.1-flash-1017",
      "qwen3-embedding-8b",
      "qwen3-rerank-8b",
      "qwen3-tts-flash",
      "qwen3-asr-flash",
      "vendor/qwen-image-2.1-pro",
      "cmaas-qwen-image-2.1-pro",
      "Qwen/Qwen3.8-vl-plus",
      "cmaas-qwen3.8-flash",
      "qwen",
    ];
    const original = [...models];

    expect(getProviderCatalogOptions("qwen", models)).toEqual([
      "Qwen/Qwen3.8-vl-plus",
      "qwen3.8-plus",
      "cmaas-qwen3.8-flash",
      "qwen",
    ]);
    expect(models).toEqual(original);
  });

  it("puts newer numeric versions first rather than following provider response order", () => {
    expect(
      getProviderCatalogOptions("qwen", [
        "qwen3.10-plus",
        "qwen3.8-plus",
        "qwen3.5-plus",
        "cmaas-qwen3.8-flash",
        "vendor/qwen3.8-27b",
        "qwen3.9-plus",
      ]),
    ).toEqual([
      "qwen3.10-plus",
      "qwen3.9-plus",
      "qwen3.8-plus",
      "cmaas-qwen3.8-flash",
      "vendor/qwen3.8-27b",
      "qwen3.5-plus",
    ]);
  });

  it("preserves vision understanding models and rejects unrelated names containing Qwen", () => {
    expect(isProviderModelVisible("qwen", "qwen3-vl-plus")).toBe(true);
    expect(isProviderModelVisible("qwen", "qwen3.8-omni-flash")).toBe(true);
    expect(isProviderModelVisible("qwen", "not-qwen3.8-plus")).toBe(false);
    expect(isProviderModelVisible("qwen", "qwenish-model")).toBe(false);
    expect(getProviderCatalogOptions("qwen", [])).toEqual([]);
  });

  it("does not filter other providers or rewrite their catalog order", () => {
    const models = ["MiniMax-M3", "image-01", "qwen-image-2.1-pro", "private-model"];

    expect(getProviderCatalogOptions("minimax", models)).toEqual(models);
    expect(getProviderCatalogOptions("custom", models)).toEqual(models);
    expect(isProviderModelVisible("llama-cpp", "local-model")).toBe(true);
    expect(isProviderModelVisible("github-copilot", "gpt-5.5")).toBe(true);
  });

  it("features four available models, preferring canonical IDs over equivalent aliases", () => {
    const models = Object.freeze(
      [
        "qwen3.8-max-2026-10-01",
        "cmaas-qwen3.8-flash",
        "qwen3.5-plus",
        "qwen3.7-plus",
        "qwen3.8-max",
        "qwen3.8-flash",
        "qwen3.6-plus",
      ].map((id) => ({ id, name: `Alias for ${id}` })),
    );
    const original = [...models];
    const sections = getProviderModelSections("qwen", models);

    expect(sections.primary.map((model) => model.id)).toEqual([
      "qwen3.8-max",
      "qwen3.8-flash",
      "qwen3.7-plus",
      "qwen3.5-plus",
    ]);
    expect(sections.more.map((model) => model.id)).toEqual([
      "qwen3.8-max-2026-10-01",
      "cmaas-qwen3.8-flash",
      "qwen3.6-plus",
    ]);
    expect(models).toEqual(original);
    expect(new Set([...sections.primary, ...sections.more])).toEqual(new Set(models));
    const selectedAlias = getProviderModelSections("qwen", models, "cmaas-qwen3.8-flash");
    expect(selectedAlias.primary).toHaveLength(4);
    expect(selectedAlias.primary[1].id).toBe("cmaas-qwen3.8-flash");
    expect(selectedAlias.more.some((model) => model.id === "qwen3.8-flash")).toBe(true);
  });

  it("keeps the selected model visible and never invents missing featured models", () => {
    const models = [
      { id: "cmaas-qwen3.8-flash" },
      { id: "Qwen/Qwen3.5-plus" },
      { id: "qwen3.6-plus" },
      { id: "qwen3.7-plus-2026-10-01" },
    ];
    const sections = getProviderModelSections("qwen", models, "qwen3.6-plus");

    expect(sections.primary.map((model) => model.id)).toEqual([
      "qwen3.6-plus",
      "cmaas-qwen3.8-flash",
      "Qwen/Qwen3.5-plus",
    ]);
    expect(sections.more).toEqual([models[3]]);
    expect(getProviderModelSections("qwen", [], "missing")).toEqual({ primary: [], more: [] });
    expect(getProviderModelSections("minimax", models)).toEqual({ primary: models, more: [] });
    expect(isRecommendedProviderModel("qwen", "cmaas-qwen3.7-plus")).toBe(true);
    expect(isRecommendedProviderModel("qwen", models[3].id)).toBe(false);
    expect(isRecommendedProviderModel("custom", "qwen3.7-plus")).toBe(false);
  });
});
