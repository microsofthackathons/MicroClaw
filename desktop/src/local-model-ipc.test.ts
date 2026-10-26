import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import { registerLocalModelHandlers } from "./local-model-ipc";
import { LocalModelService } from "./local-model-service";

describe("local model IPC", () => {
  it("exposes only bounded business operations with explicit error results", async () => {
    const handlers = new Map<string, (input?: unknown) => unknown>();
    const ipc: Pick<IpcMain, "handle"> = {
      handle: (channel, handler) => {
        handlers.set(channel, (input) => handler({} as IpcMainInvokeEvent, input));
      },
    };
    const service = new LocalModelService({
      gateway: () => null,
      identity: () => "test",
      assertMutable: () => {},
      readConfig: () => ({}),
      readReceipt: () => undefined,
      saveReceipt: () => {},
      restartGateway: async () => {},
      onChange: () => {},
    });
    registerLocalModelHandlers(ipc, service);
    await expect(handlers.get("model:local:get-snapshot")!()).resolves.toEqual({
      ok: true,
      value: { models: [], catalog: expect.any(Array) },
    });
    expect(handlers.has("gateway:request")).toBe(false);
    expect(handlers.has("model:local:run-command")).toBe(false);
    await expect(handlers.get("model:local:get-operation")!()).resolves.toEqual({
      ok: true,
      value: null,
    });
    await expect(handlers.get("model:local:get-capabilities")!()).resolves.toMatchObject({
      ok: true,
      value: { supported: false, mutable: false },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await expect(
        handlers.get("model:local:prepare")!({ authChoice: "arbitrary-plugin" }),
      ).resolves.toEqual({ ok: false, error: "Unsupported local model setup choice" });
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      warn.mockRestore();
    }
  });
});
