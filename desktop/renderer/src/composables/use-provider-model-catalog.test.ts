import { beforeEach, describe, expect, it, vi } from "vitest";
import { isProxy, ref } from "vue";
import { createBrowserOpenClawMock } from "@/browser-openclaw";
import { readConfiguredModels } from "@/utils/configured-models";
import { readConfiguredCatalogs, useProviderModelCatalog } from "./use-provider-model-catalog";

const config = {
  models: {
    providers: {
      qwen: {
        baseUrl: "https://provider.example/v1",
        apiKey: "saved-key",
        models: [{ id: "old", name: "Saved alias", input: ["text", "image"] }],
      },
      custom: { models: [{ id: "private", name: "Private" }] },
    },
  },
};

beforeEach(() => {
  window.openclaw = createBrowserOpenClawMock();
  window.openclaw.model.discoverModels = vi
    .fn()
    .mockResolvedValue({ ok: true, models: ["old", "new", "latest"] });
});

describe("shared provider catalogs", () => {
  it.each(["load", "loadConfigured"] as const)(
    "passes cloneable requests from reactive provider configuration through %s",
    async (method) => {
      const shared = useProviderModelCatalog();
      const inputs = ref(readConfiguredCatalogs(config));
      expect(isProxy(inputs.value.qwen)).toBe(true);
      vi.mocked(window.openclaw.model.discoverModels).mockImplementation((input) => {
        structuredClone(input);
        return Promise.resolve({ ok: true, models: ["old", "new", "latest"] });
      });

      if (method === "load") {
        await shared.load(inputs.value.qwen);
      } else {
        await shared.loadConfigured(inputs.value);
      }

      expect(window.openclaw.model.discoverModels).toHaveBeenCalledOnce();
      const [request] = vi.mocked(window.openclaw.model.discoverModels).mock.calls[0];
      expect(isProxy(request)).toBe(false);
      expect(request).not.toBe(inputs.value.qwen);
      expect(request).toEqual({
        baseUrl: config.models.providers.qwen.baseUrl,
        apiKey: config.models.providers.qwen.apiKey,
      });
      expect(shared.errors(inputs.value)).toBe("");
      expect(
        shared
          .merge(readConfiguredModels(config).models, inputs.value)
          .filter((model) => model.providerKey === "qwen")
          .map((model) => model.id),
      ).toEqual(["old", "new", "latest"]);
    },
  );

  it("shares the full live list between form, default and conversation consumers without writes", async () => {
    const form = useProviderModelCatalog();
    const defaults = useProviderModelCatalog();
    const chat = useProviderModelCatalog();
    const inputs = readConfiguredCatalogs(config);
    await Promise.all([
      form.load(inputs.qwen),
      defaults.loadConfigured(inputs),
      chat.loadConfigured(inputs),
    ]);
    expect(window.openclaw.model.discoverModels).toHaveBeenCalledOnce();
    const saved = readConfiguredModels(config).models;
    for (const consumer of [defaults, chat]) {
      const merged = consumer.merge(saved, inputs);
      expect(
        merged.filter((model) => model.providerKey === "qwen").map((model) => model.id),
      ).toEqual(["old", "new", "latest"]);
      expect(merged.find((model) => model.id === "old")?.input).toEqual(["text", "image"]);
      expect(merged.find((model) => model.id === "new")?.input).toEqual(["text"]);
      expect(merged.some((model) => model.id === "private")).toBe(true);
    }
    expect(config.models.providers.qwen.models).toHaveLength(1);
  });

  it("isolates draft credentials and replaces the published list on refresh", async () => {
    const shared = useProviderModelCatalog();
    const inputs = readConfiguredCatalogs(config);
    const models = readConfiguredModels(config).models;
    await shared.loadConfigured(inputs);
    vi.mocked(window.openclaw.model.discoverModels).mockResolvedValue({
      ok: true,
      models: ["different-account"],
    });
    await shared.load({ ...inputs.qwen, apiKey: "draft-key" });
    expect(shared.merge(models, inputs).some((model) => model.id === "latest")).toBe(true);
    expect(shared.merge(models, inputs).some((model) => model.id === "different-account")).toBe(
      false,
    );
    vi.mocked(window.openclaw.model.discoverModels).mockResolvedValue({
      ok: true,
      models: ["refreshed"],
    });
    await shared.load(inputs.qwen);
    expect(
      shared
        .merge(models, inputs)
        .filter((model) => model.providerKey === "qwen")
        .map((model) => model.id),
    ).toEqual(["refreshed"]);
  });

  it("reports failed catalogs instead of claiming a saved subset is the full live list", async () => {
    const shared = useProviderModelCatalog();
    const inputs = readConfiguredCatalogs(config);
    vi.mocked(window.openclaw.model.discoverModels).mockResolvedValue({
      ok: false,
      error: "authentication",
    });
    await shared.loadConfigured(inputs);
    expect(shared.errors(inputs)).not.toBe("");
    expect(
      shared
        .merge(readConfiguredModels(config).models, inputs)
        .filter((model) => model.providerKey === "qwen"),
    ).toHaveLength(1);
  });
});
