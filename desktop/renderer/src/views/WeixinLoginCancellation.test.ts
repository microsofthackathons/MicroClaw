import { createPinia } from "pinia";
import { flushPromises, shallowMount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElMessageBox } from "element-plus";
import QRCode from "qrcode";
import { createBrowserOpenClawMock } from "@/browser-openclaw";
import { setLocale, t } from "@/i18n";
import ChannelsView from "./ChannelsView.vue";
import PluginsView from "./PluginsView.vue";

vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock("qrcode", () => ({ default: { toCanvas: vi.fn().mockResolvedValue(undefined) } }));

describe.each([
  ["Channels", ChannelsView],
  ["Plugins", PluginsView],
])("%s WeChat login cancellation", (_name, component) => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    setLocale("en-US");
    vi.spyOn(ElMessageBox, "confirm").mockResolvedValue(
      Object.assign("confirm" as const, { value: "", action: "confirm" as const }),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it.each([false, true])(
    "does not resume a cancelled QR start or launch CLI when a late response has QR=%s",
    async (hasQr) => {
      const api = createBrowserOpenClawMock();
      const status = await api.plugin.weixin.getStatus();
      vi.spyOn(api.plugin.weixin, "getStatus").mockResolvedValue({
        ...status,
        installed: true,
        enabled: true,
        requestedEnabled: true,
        effectiveEnabled: true,
        accountCount: 1,
        mutationLocked: false,
        mutationLockRevision: 1,
      });
      type QrResult = Awaited<ReturnType<typeof api.plugin.weixin.loginQrStart>>;
      let finishQr!: (result: QrResult) => void;
      let finishCancel!: () => void;
      const start = vi.spyOn(api.plugin.weixin, "loginQrStart").mockImplementation(
        () =>
          new Promise<QrResult>((resolve) => {
            finishQr = resolve;
          }),
      );
      const cancel = vi.spyOn(api.plugin.weixin, "cancelLogin").mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishCancel = resolve;
          }),
      );
      const cli = vi.spyOn(api.plugin.weixin, "login");
      const poll = vi
        .spyOn(api.plugin.weixin, "loginQrWait")
        .mockImplementation(() => new Promise(() => {}));
      window.openclaw = api;
      const wrapper = shallowMount(component, {
        global: {
          plugins: [createPinia()],
          stubs: {
            ElSwitch: true,
            ElAlert: true,
            ElButton: {
              props: ["disabled", "loading"],
              emits: ["click"],
              template:
                '<button :disabled="disabled || loading" @click="$emit(\'click\')"><slot /></button>',
            },
          },
        },
      });
      try {
        await flushPromises();
        const replace = wrapper.findAll("button").find((button) => {
          return button.text() === t("plugins.replaceWeixin");
        });
        if (!replace) throw new Error("Replace WeChat button not found");
        await replace.trigger("click");
        await flushPromises();
        expect(start).toHaveBeenCalledOnce();

        const cancelButton = wrapper.findAll("button").find((button) => {
          return button.text() === t("plugins.cancel");
        });
        if (!cancelButton) throw new Error("Cancel login button not found");
        await cancelButton.trigger("click");
        expect(cancel).toHaveBeenCalledOnce();
        finishQr({
          ok: true,
          message: "Late QR response",
          ...(hasQr ? { qrDataUrl: "test-qr", sessionKey: "default" } : {}),
        });
        await flushPromises();
        await vi.advanceTimersByTimeAsync(1);
        finishCancel();
        await flushPromises();

        expect(cli).not.toHaveBeenCalled();
        expect(poll).not.toHaveBeenCalled();
        expect(QRCode.toCanvas).not.toHaveBeenCalled();
        const retry = wrapper.findAll("button").find((button) => {
          return button.text() === t("plugins.replaceWeixin");
        });
        if (!retry) throw new Error("Replace WeChat button was not restored");
        expect(retry.attributes("disabled")).toBeUndefined();
        expect(wrapper.find(".login-qr-area").exists()).toBe(false);
      } finally {
        wrapper.unmount();
      }
    },
  );
});
