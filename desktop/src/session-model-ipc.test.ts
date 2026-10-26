import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { expect, it, vi } from "vitest";
import { registerSessionModelHandlers } from "./session-model-ipc";
import { SessionModelService } from "./session-model-service";

it("exposes narrow session selection/recovery handlers and logs rejected requests", async () => {
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
    runtime: () => null,
    restartGateway: async () => {},
    onRecoveryChanged: () => {},
  });
  const state = { sessionKey: "agent:main:chat", modelRef: "cloud/a", overridden: true };
  const get = vi.spyOn(service, "get").mockResolvedValueOnce(state);
  const select = vi.spyOn(service, "select").mockResolvedValueOnce(state);
  const recover = vi.spyOn(service, "recover").mockResolvedValueOnce();
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    registerSessionModelHandlers(ipc, service);
    expect([...handlers.keys()]).toEqual([
      "model:session:get",
      "model:session:select",
      "model:session:get-recovery",
      "model:session:recover",
    ]);
    await expect(handlers.get("model:session:get")!("chat")).resolves.toEqual(state);
    expect(get).toHaveBeenCalledWith("chat");
    await expect(
      handlers.get("model:session:select")!({ sessionKey: "chat", modelRef: "cloud/a" }),
    ).resolves.toEqual(state);
    expect(select).toHaveBeenCalledWith({ sessionKey: "chat", modelRef: "cloud/a" });
    await expect(handlers.get("model:session:get-recovery")!()).resolves.toBeNull();
    const recovery = { recoveryId: "uncertain", confirmed: true, restart: true };
    await expect(handlers.get("model:session:recover")!(recovery)).resolves.toBeUndefined();
    expect(recover).toHaveBeenCalledWith(recovery);
    await expect(handlers.get("model:session:get")!("chat")).rejects.toThrow(
      "Gateway is not connected",
    );
    expect(warn).toHaveBeenCalledWith("[model:session:get] Gateway is not connected");
  } finally {
    vi.restoreAllMocks();
  }
});
