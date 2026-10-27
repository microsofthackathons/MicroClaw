import type { IpcMain, IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import { registerLocalModelHandlers } from "./local-model-ipc";
import { LocalModelProviderReviewRequiredError, LocalModelService } from "./local-model-service";
import { readLocalModelHardware } from "./local-model-hardware";

vi.mock("./local-model-hardware", () => ({ readLocalModelHardware: vi.fn() }));

describe("local model IPC", () => {
  it("exposes a fixed read-only hardware query without starting model or plugin operations", async () => {
    const handlers = new Map<string, (input?: unknown) => unknown>();
    const ipc: Pick<IpcMain, "handle"> = {
      handle: (channel, handler) => {
        handlers.set(channel, (input) => handler({} as IpcMainInvokeEvent, input));
      },
    };
    const value = {
      cpu: "Example",
      totalMemoryBytes: 32 * 1024 ** 3,
      availableMemoryBytes: 16 * 1024 ** 3,
      accelerator: "cpu" as const,
      gpus: [],
    };
    vi.mocked(readLocalModelHardware).mockResolvedValueOnce(value);
    const service = { prepare: vi.fn(), installProvider: vi.fn(), readConfig: vi.fn() };
    registerLocalModelHandlers(ipc, service as unknown as LocalModelService);
    await expect(handlers.get("model:local:get-hardware")!()).resolves.toEqual({ ok: true, value });
    expect(readLocalModelHardware).toHaveBeenCalledWith();
    expect(service.prepare).not.toHaveBeenCalled();
    expect(service.installProvider).not.toHaveBeenCalled();
    expect(service.readConfig).not.toHaveBeenCalled();
  });
  it.each([
    [
      new LocalModelProviderReviewRequiredError("Review needed"),
      "PLUGIN_CAPABILITY_CONSENT_REQUIRED",
    ],
    [new Error("Plugin capability review is required"), undefined],
  ])(
    "preserves structured permission requests without classifying error text: %s",
    async (error, code) => {
      const handlers = new Map<string, (input?: unknown) => unknown>();
      const ipc: Pick<IpcMain, "handle"> = {
        handle: (channel, handler) => {
          handlers.set(channel, (input) => handler({} as IpcMainInvokeEvent, input));
        },
      };
      const service = {
        installProvider: vi.fn().mockRejectedValue(error),
        errorMessage: (cause: Error) => cause.message,
      } as unknown as LocalModelService;
      registerLocalModelHandlers(ipc, service);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await expect(
          handlers.get("model:local:install-provider")!({ confirmed: true }),
        ).resolves.toEqual({
          ok: false,
          error: error.message,
          ...(code ? { code } : {}),
        });
      } finally {
        warn.mockRestore();
      }
    },
  );

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
