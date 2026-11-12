import { createPinia, setActivePinia } from "pinia";
import { flushPromises, shallowMount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/i18n";
import TasksView from "./TasksView.vue";

describe("TasksView", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        openclaw: {
          chat: { isConnected: vi.fn().mockResolvedValue(true) },
          cron: {
            list: vi.fn().mockResolvedValue({
              jobs: [{ id: "daily", enabled: true }],
            }),
          },
        },
      },
    });
  });

  it.each(["en-US", "zh-CN"] as const)(
    "shows scheduled tasks without an MXC pause in %s",
    async (locale) => {
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

      expect(wrapper.find('[data-test="mxc-pause-alert"]').exists()).toBe(false);
      expect(window.openclaw.cron.list).toHaveBeenCalled();
    },
  );
});
