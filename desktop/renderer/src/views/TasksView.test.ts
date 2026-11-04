import { createPinia, setActivePinia } from "pinia";
import { flushPromises, shallowMount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/i18n";
import TasksView from "./TasksView.vue";

describe("TasksView MXC pause status", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        openclaw: {
          chat: { isConnected: vi.fn().mockResolvedValue(true) },
          cron: {
            list: vi.fn().mockResolvedValue({
              jobs: [],
              pausedByMxc: true,
              requestedMode: "full",
            }),
          },
        },
      },
    });
  });

  it.each([
    ["en-US", "Scheduled tasks paused by MXC", "without catch-up"],
    ["zh-CN", "MXC 已暂停定时任务", "不会补跑"],
  ] as const)("shows the persistent pause banner in %s", async (locale, title, detail) => {
    setLocale(locale);
    const pinia = createPinia();
    setActivePinia(pinia);
    const wrapper = shallowMount(TasksView, {
      global: {
        plugins: [pinia],
        stubs: {
          ElButton: true,
          ElAlert: {
            props: ["title", "description"],
            template:
              '<div data-test="mxc-pause-alert"><span>{{ title }}</span><span>{{ description }}</span></div>',
          },
          ElTable: true,
          ElTableColumn: true,
          ElTag: true,
        },
      },
    });

    await flushPromises();

    const alert = wrapper.find('[data-test="mxc-pause-alert"]');
    expect(alert.exists()).toBe(true);
    expect(alert.text()).toContain(title);
    expect(alert.text()).toContain(detail);
  });
});
