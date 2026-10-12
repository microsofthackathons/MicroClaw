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
                  pausedByMxc: true,
                  schedule: { kind: "cron", expr: "0 9 * * *" },
                },
              ],
            }),
          },
        },
      },
    });
  });

  it("preserves requested enablement while surfacing MXC pause state", async () => {
    const store = useTaskStore();

    await store.fetchTasks();

    expect(store.tasks).toEqual([
      expect.objectContaining({
        id: "daily",
        enabled: true,
        pausedByMxc: true,
        cron: "0 9 * * *",
      }),
    ]);
  });
});
