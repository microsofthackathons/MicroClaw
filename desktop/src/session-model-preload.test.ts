import { expect, it, vi } from "vitest";
import type { SessionModelAPI } from "./session-model-types";

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
}));
vi.mock("electron", () => electron);

it("exposes the agreed narrow session model API without a generic Gateway bridge", async () => {
  await import("./preload");
  const api = electron.contextBridge.exposeInMainWorld.mock.calls[0][1] as {
    model: {
      session: SessionModelAPI;
      selectDefault(
        params: import("./default-model-selection").DefaultModelSelection,
      ): Promise<{ modelRef: string }>;
    };
  };
  expect(Object.keys(api.model.session)).toEqual(["get", "select"]);
  const state = { sessionKey: "agent:main:chat", modelRef: "cloud/a", overridden: false };
  electron.ipcRenderer.invoke.mockResolvedValueOnce(state).mockResolvedValueOnce(state);
  await expect(api.model.session.get("chat")).resolves.toEqual(state);
  await expect(api.model.session.select({ sessionKey: "chat", modelRef: null })).resolves.toEqual(
    state,
  );
  expect(electron.ipcRenderer.invoke.mock.calls).toEqual([
    ["model:session:get", "chat"],
    ["model:session:select", { sessionKey: "chat", modelRef: null }],
  ]);
  electron.ipcRenderer.invoke.mockRejectedValueOnce(new Error("Gateway is not connected"));
  await expect(api.model.session.get("chat")).rejects.toThrow("Gateway is not connected");
  const params = {
    modelRef: "github-copilot/gpt-6-sol",
    expectedConfig: { agents: { defaults: {} } },
  };
  electron.ipcRenderer.invoke.mockResolvedValueOnce({ modelRef: params.modelRef });
  await expect(api.model.selectDefault(params)).resolves.toEqual({ modelRef: params.modelRef });
  expect(electron.ipcRenderer.invoke).toHaveBeenLastCalledWith("model:select-default", params);
});
