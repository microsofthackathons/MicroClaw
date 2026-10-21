import { describe, expect, it } from "vitest";
import { assertModelProviderSupported, isModelProviderSupported } from "./model-provider-policy";

describe("supported model providers", () => {
  it("permanently rejects Copilot, including saved model references", () => {
    expect(isModelProviderSupported("github-copilot")).toBe(false);
    for (const ref of ["github-copilot/gpt-5", " github-copilot/claude "]) {
      expect(() => assertModelProviderSupported(ref)).toThrow("GitHub Copilot is not supported");
    }
  });

  it.each(["qwen", "minimax", "llama-cpp", "custom"])("preserves %s", (provider) => {
    expect(isModelProviderSupported(provider)).toBe(true);
    expect(() => assertModelProviderSupported(`${provider}/model`)).not.toThrow();
  });

  it.each([undefined, null, ""])("allows an unset model reference: %j", (ref) => {
    expect(() => assertModelProviderSupported(ref)).not.toThrow();
  });
});
