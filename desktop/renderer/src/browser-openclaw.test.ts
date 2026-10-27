import { describe, expect, it, vi } from "vitest";
import { createBrowserOpenClawMock } from "./browser-openclaw";
import { getModelRef, readConfiguredModels } from "./utils/configured-models";

describe("createBrowserOpenClawMock", () => {
  it("keeps configured model preview data opt-in and isolated", async () => {
    const api = createBrowserOpenClawMock({ configuredModels: true });
    const config = await api.config.read();
    const { models, primary } = readConfiguredModels(config);
    expect(primary).toBe("qwen/qwen3.7-plus");
    expect(new Set(models.map((model) => model.providerKey))).toEqual(
      new Set(["qwen", "minimax", "openai", "anthropic"]),
    );
    expect(models).toHaveLength(11);
    expect(models.every((model) => model.apiKey === "sk-browser-preview-not-a-real-key")).toBe(
      true,
    );
    await expect(createBrowserOpenClawMock().config.read()).resolves.toEqual({});
    await api.config.write({});
    await expect(api.config.read()).resolves.toEqual({});
    expect(readConfiguredModels(config).models).toHaveLength(11);
    expect(
      readConfiguredModels(
        await createBrowserOpenClawMock({ configuredModels: true }).config.read(),
      ).models,
    ).toHaveLength(11);
  });

  it("supports changing the preview default and rejects unknown models", async () => {
    const api = createBrowserOpenClawMock({ configuredModels: true });
    await expect(
      api.model.selectDefault({
        modelRef: "openai/gpt-5.4",
        expectedConfig: await api.config.read(),
      }),
    ).resolves.toEqual({
      modelRef: "openai/gpt-5.4",
    });
    expect(readConfiguredModels(await api.config.read()).primary).toBe("openai/gpt-5.4");
    await expect(
      api.model.selectDefault({
        modelRef: "unknown/model",
        expectedConfig: await api.config.read(),
      }),
    ).rejects.toThrow("Unknown browser preview model");
    expect(readConfiguredModels(await api.config.read()).primary).toBe("openai/gpt-5.4");
  });

  it("loads preview catalogs without network or local runtime errors", async () => {
    const api = createBrowserOpenClawMock({ configuredModels: true });
    const { models } = readConfiguredModels(await api.config.read());
    const qwen = models.find((model) => getModelRef(model) === "qwen/qwen3.7-plus")!;
    await expect(
      api.model.discoverModels({ baseUrl: qwen.baseUrl!, apiKey: qwen.apiKey! }),
    ).resolves.toMatchObject({
      ok: true,
      models: expect.arrayContaining(["qwen3.7-plus"]),
    });
    await expect(api.model.local.getCapabilities()).resolves.toMatchObject({
      ok: true,
      value: { supported: false, mutable: false },
    });
    await expect(api.model.local.prepare({ authChoice: "llama-cpp" })).resolves.toMatchObject({
      ok: false,
    });
  });

  it("provides the startup and subscription APIs used by browser previews", async () => {
    const api = createBrowserOpenClawMock();

    await expect(api.gateway.getStatus()).resolves.toBe("running");
    await expect(api.chat.isConnected()).resolves.toBe(true);
    await expect(api.settings.get()).resolves.toMatchObject({ minimizeToTray: false });
    await expect(api.plugin.weixin.getStatus()).resolves.toMatchObject({ loggedIn: false });
    await expect(api.model.local.getHardware()).resolves.toMatchObject({ ok: false });

    expect(api).not.toHaveProperty("sandbox");
    expect(api.windowsNodeMxc.onApprovalRequest(vi.fn())).toBeTypeOf("function");
    expect(api.plugin.weixin.onLoginOutput(vi.fn())).toBeTypeOf("function");
    expect(api.plugin.weixin.onLoginDone(vi.fn())).toBeTypeOf("function");
    expect(api.window.onMaximizeChange(vi.fn())).toBeTypeOf("function");
  });

  it("keeps Agent add and remove operations stateful", async () => {
    const api = createBrowserOpenClawMock();

    const added = await api.agents.add("code-geek");
    expect(added.agents.map((agent) => agent.id)).toContain("code-geek");

    const removed = await api.agents.remove("code-geek");
    expect(removed.agents.map((agent) => agent.id)).not.toContain("code-geek");
  });

  it("keeps local mutations unavailable without inventing a pending operation", async () => {
    const api = createBrowserOpenClawMock();
    for (const result of await Promise.all([
      api.model.local.getCapabilities(),
      api.model.local.detect(),
      api.model.local.inspectProvider(),
      api.model.local.installProvider({ confirmed: true }),
      api.model.local.prepare({ authChoice: "llama-cpp" }),
      api.model.local.activate({ kind: "existing-model", modelRef: "llama-cpp/model" }),
      api.model.local.answer({ operationId: "operation", stepId: "step", value: true }),
      api.model.local.cancel("operation"),
      api.model.local.resume(),
    ])) {
      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("unavailable in browser development"),
      });
    }
    await expect(api.model.local.getOperation()).resolves.toEqual({ ok: true, value: null });
    await expect(api.model.local.getSnapshot()).resolves.toEqual({
      ok: true,
      value: { models: [] },
    });
    expect(api.model.local.onEvent(vi.fn())).toBeTypeOf("function");
  });
});
