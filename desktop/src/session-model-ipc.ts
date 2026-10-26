import type { IpcMain } from "electron";
import type { SessionModelService } from "./session-model-service";

export function registerSessionModelHandlers(
  ipc: Pick<IpcMain, "handle">,
  service: SessionModelService,
): void {
  const handlers = {
    "model:session:get": (input: unknown) => service.get(input),
    "model:session:select": (input: unknown) => service.select(input),
    "model:session:get-recovery": () => service.getRecovery(),
    "model:session:recover": (input: unknown) => service.recover(input),
  };
  for (const [channel, handler] of Object.entries(handlers)) {
    ipc.handle(channel, async (_event, input: unknown) => {
      try {
        return await handler(input);
      } catch (error) {
        // Do not log raw RPC payloads/configuration or nested Gateway errors.
        const message = error instanceof Error ? error.message : "Session model request failed";
        console.warn(`[${channel}] ${message}`);
        throw new Error(message, { cause: error });
      }
    });
  }
}
