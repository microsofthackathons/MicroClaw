import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { expect, it, vi } from "vitest";
import { registerSessionModelHandlers } from "./session-model-ipc";
import { SessionModelService } from "./session-model-service";

it("exposes only session get/select and logs rejected requests at the IPC boundary", async () => {
  const handlers = new Map<string, (input?: unknown) => unknown>();
  const ipc: Pick<IpcMain, "handle"> = {
    handle: (channel, handler) => {
      handlers.set(channel, (input) => handler({} as IpcMainInvokeEvent, input));
    },
  };
  const service = new SessionModelService({
    gateway: () => null,
    readConfig: () => ({}),
    assertMutable: () => {},
  });
  const state = { sessionKey: "agent:main:chat", modelRef: "cloud/a", overridden: true };
  const get = vi.spyOn(service, "get").mockResolvedValueOnce(state);
  const select = vi.spyOn(service, "select").mockResolvedValueOnce(state);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    registerSessionModelHandlers(ipc, service);
    expect([...handlers.keys()]).toEqual(["model:session:get", "model:session:select"]);
    await expect(handlers.get("model:session:get")!("chat")).resolves.toEqual(state);
    expect(get).toHaveBeenCalledWith("chat");
    await expect(
      handlers.get("model:session:select")!({ sessionKey: "chat", modelRef: "cloud/a" }),
    ).resolves.toEqual(state);
    expect(select).toHaveBeenCalledWith({ sessionKey: "chat", modelRef: "cloud/a" });
    await expect(handlers.get("model:session:get")!("chat")).rejects.toThrow(
      "Gateway is not connected",
    );
    expect(warn).toHaveBeenCalledWith("[model:session:get] Gateway is not connected");
  } finally {
    vi.restoreAllMocks();
  }
});
