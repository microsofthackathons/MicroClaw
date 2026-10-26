import { describe, expect, it } from "vitest";
import { MANAGED_MODEL_PROVIDERS } from "./managed-model-providers";

describe("MANAGED_MODEL_PROVIDERS", () => {
  it("uses the Qwen campaign link for API key signup", () => {
    const provider = MANAGED_MODEL_PROVIDERS.find((entry) => entry.id === "qwen");
    expect(provider?.signupUrl).toBe("https://click.qianwenai.com/m/20000000741/");
  });

  it("keeps MiniMax campaign signup separate from its API endpoint", () => {
    const provider = MANAGED_MODEL_PROVIDERS.find((entry) => entry.id === "minimax");
    expect(provider?.signupUrl).toBe("https://platform.minimaxi.com/byok-trial?source=microclaw");
    expect(provider?.baseUrl).toBe("https://api.minimax.cn/v1");
  });

  it("contains valid, unique provider and model definitions", () => {
    const providerIds = new Set<string>();
    const modelRefs = new Set<string>();

    for (const provider of MANAGED_MODEL_PROVIDERS) {
      expect(providerIds.has(provider.id)).toBe(false);
      providerIds.add(provider.id);
      expect(() => new URL(provider.baseUrl)).not.toThrow();
      expect(() => new URL(provider.signupUrl)).not.toThrow();
      expect(provider.models.some((model) => model.id === provider.defaultModel)).toBe(true);

      for (const model of provider.models) {
        const modelRef = `${provider.id}/${model.id}`;
        expect(modelRefs.has(modelRef)).toBe(false);
        modelRefs.add(modelRef);
        expect(model.input.length).toBeGreaterThan(0);
      }
    }
  });
});
