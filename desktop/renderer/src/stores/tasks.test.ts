import { createPinia, setActivePinia } from "pinia";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useTaskStore } from "./tasks";

describe("useTaskStore", () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        openclaw: {
          chat: { isConnected: vi.fn().mockResolvedValue(true) },
          cron: {
            list: vi.fn().mockResolvedValue({
              jobs: [
                {
                  id: "daily",
                  name: "Daily report",
                  enabled: true,
                  schedule: { kind: "cron", expr: "0 9 * * *" },
                },
                {
                  id: "disabled",
                  name: "Disabled report",
                  enabled: false,
                  schedule: { kind: "cron", expr: "0 10 * * *" },
                },
              ],
            }),
          },
        },
      },
    });
  });

  it("shows each scheduled task's actual enabled state", async () => {
    const store = useTaskStore();

    await store.fetchTasks();

    expect(store.tasks).toEqual([
      expect.objectContaining({
        id: "daily",
        enabled: true,
        cron: "0 9 * * *",
      }),
      expect.objectContaining({
        id: "disabled",
        enabled: false,
        cron: "0 10 * * *",
      }),
    ]);
  });
});
