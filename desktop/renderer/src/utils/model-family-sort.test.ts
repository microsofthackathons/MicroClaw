import { describe, expect, it } from "vitest";
import type { ConfiguredModel } from "./configured-models";
import { sortModelsByFamily } from "./model-family-sort";

function model(id: string, name = id): ConfiguredModel {
  return { providerKey: "qwen", id, name, source: "managed" };
}

describe("sortModelsByFamily", () => {
  it("keeps families adjacent despite vendor namespaces and serving prefixes", () => {
    const models = [
      model("kimi/kimi-k3.1-pro-highspeed"),
      model("qwen3.8-27b"),
      model("MiniMax/MiniMax-M3.1-Flash"),
      model("vanchin/deepseek-v4.1-flash"),
      model("ZHIPU/GLM-5.3-FlashX"),
      model("kimi/kimi-k3.1-pro"),
      model("cmaas-qwen3.8-flash"),
      model("deepseek-v4.1-flash-1017"),
      model("glm-5.3-prime"),
    ];

    expect(sortModelsByFamily(models).map((entry) => entry.id)).toEqual([
      "vanchin/deepseek-v4.1-flash",
      "deepseek-v4.1-flash-1017",
      "ZHIPU/GLM-5.3-FlashX",
      "glm-5.3-prime",
      "kimi/kimi-k3.1-pro",
      "kimi/kimi-k3.1-pro-highspeed",
      "MiniMax/MiniMax-M3.1-Flash",
      "qwen3.8-27b",
      "cmaas-qwen3.8-flash",
    ]);
  });

  it("uses natural version ordering and model IDs rather than editable display names", () => {
    expect(
      sortModelsByFamily([
        model("Qwen3.10-27b", "First alias"),
        model("qwen3.9-27b", "Last alias"),
        model("qwen3.8-27b", "Middle alias"),
      ]).map((entry) => entry.id),
    ).toEqual(["qwen3.8-27b", "qwen3.9-27b", "Qwen3.10-27b"]);
  });

  it("retains every model and its metadata without mutating the source array", () => {
    const models = Object.freeze([
      model("qwen3.8-omni-flash-realtime"),
      model("unknown/custom-model"),
      model("qwen-image-2.1-pro"),
      model("vendor-a/qwen3.8-27b"),
      model("vendor-b/qwen3.8-27b"),
    ]);
    const original = [...models];
    const sorted = sortModelsByFamily(models);

    expect(models).toEqual(original);
    expect(sorted).toHaveLength(models.length);
    expect(new Set(sorted)).toEqual(new Set(models));
    expect(sortModelsByFamily([...models].reverse())).toEqual(sorted);
    expect(sortModelsByFamily([])).toEqual([]);
  });

  it("supports descending natural versions while keeping families and aliases together", () => {
    const models = Object.freeze([
      model("qwen3.8-27b"),
      model("Qwen/Qwen3.10-plus"),
      model("qwen3.5-plus"),
      model("cmaas-qwen3.8-flash"),
      model("qwen3.9-plus"),
      model("kimi/kimi-k3.1-pro"),
    ]);
    const original = [...models];

    expect(sortModelsByFamily(models, "desc").map((entry) => entry.id)).toEqual([
      "kimi/kimi-k3.1-pro",
      "Qwen/Qwen3.10-plus",
      "qwen3.9-plus",
      "cmaas-qwen3.8-flash",
      "qwen3.8-27b",
      "qwen3.5-plus",
    ]);
    expect(models).toEqual(original);
  });
});
