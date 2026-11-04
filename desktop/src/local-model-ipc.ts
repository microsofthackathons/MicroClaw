import type { IpcMain } from "electron";
import {
  LocalModelProviderReviewRequiredError,
  type LocalModelService,
} from "./local-model-service";
import type { LocalModelResult } from "./local-model-types";
import { readLocalModelHardware } from "./local-model-hardware";

export function registerLocalModelHandlers(
  ipc: Pick<IpcMain, "handle">,
  service: LocalModelService,
): void {
  const handlers: Record<string, (input: unknown) => unknown | Promise<unknown>> = {
    "model:local:get-snapshot": () => service.getSnapshot(),
    "model:local:get-hardware": () => readLocalModelHardware(),
    "model:local:get-capabilities": () => service.getCapabilities(),
    "model:local:detect": (input) => {
      if (
        input !== undefined &&
        (!input ||
          typeof input !== "object" ||
          Array.isArray(input) ||
          Object.keys(input).some((key) => key !== "refresh") ||
          ("refresh" in input && typeof input.refresh !== "boolean"))
      )
        throw new Error("Invalid model discovery options");
      return service.detect(input);
    },
    "model:local:inspect-provider": () => service.inspectProvider(),
    "model:local:install-provider": (input) => service.installProvider(input),
    "model:local:prepare": (input) => service.prepare(input),
    "model:local:activate": (input) => service.activate(input),
    "model:local:answer": (input) => service.answer(input),
    "model:local:cancel": (input) => service.cancel(input),
    "model:local:get-operation": () => service.getOperation(),
    "model:local:resume": () =>
      service.getOperation()?.busy ? service.resume() : service.getOperation(),
  };
  for (const [channel, handler] of Object.entries(handlers)) {
    ipc.handle(channel, async (_event, input: unknown): Promise<LocalModelResult<unknown>> => {
      try {
        return { ok: true, value: await handler(input) };
      } catch (error) {
        const message = service.errorMessage(error);
        console.warn(`[${channel}] ${message}`);
        return {
          ok: false,
          error: message,
          ...(error instanceof LocalModelProviderReviewRequiredError
            ? { code: "PLUGIN_CAPABILITY_CONSENT_REQUIRED" as const }
            : {}),
        };
      }
    });
  }
}
