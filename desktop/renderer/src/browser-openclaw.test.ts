import { describe, expect, it, vi } from "vitest";
import { createBrowserOpenClawMock } from "./browser-openclaw";

describe("createBrowserOpenClawMock", () => {
  it("provides the startup and subscription APIs used by browser previews", async () => {
    const api = createBrowserOpenClawMock();

    await expect(api.gateway.getStatus()).resolves.toBe("running");
    await expect(api.chat.isConnected()).resolves.toBe(true);
    await expect(api.plugin.weixin.getStatus()).resolves.toMatchObject({ loggedIn: false });

    expect(api.sandbox.onPermissionRequest(vi.fn())).toBeTypeOf("function");
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
});