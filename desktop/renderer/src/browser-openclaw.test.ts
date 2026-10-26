import { describe, expect, it, vi } from "vitest";
import { createBrowserOpenClawMock } from "./browser-openclaw";

describe("createBrowserOpenClawMock", () => {
  it("provides the startup and subscription APIs used by browser previews", async () => {
    const api = createBrowserOpenClawMock();

    await expect(api.gateway.getStatus()).resolves.toBe("running");
    await expect(api.chat.isConnected()).resolves.toBe(true);
    await expect(api.settings.get()).resolves.toMatchObject({ minimizeToTray: false });
    await expect(api.plugin.weixin.getStatus()).resolves.toMatchObject({ loggedIn: false });

    await expect(api.mxc.getStatus()).resolves.toMatchObject({ ready: false });
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
