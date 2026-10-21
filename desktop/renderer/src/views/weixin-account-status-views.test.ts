import { createPinia } from "pinia";
import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ElMessageBox } from "element-plus";

import { createBrowserOpenClawMock } from "@/browser-openclaw";
import { setLocale } from "@/i18n";
import ChannelsView from "./ChannelsView.vue";
import PluginsView from "./PluginsView.vue";

vi.mock("vue-router", () => ({
  useRouter: () => ({ push: vi.fn(), back: vi.fn() }),
}));
vi.mock("qrcode", () => ({
  default: { toCanvas: vi.fn().mockResolvedValue(undefined) },
}));

const buttonStub = {
  props: ["loading", "disabled", "type", "text", "size"],
  emits: ["click"],
  template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot/></button>',
};

const switchStub = {
  props: ["modelValue", "loading"],
  emits: ["change", "update:modelValue"],
  template: "<input type='checkbox' />",
};

type WeixinStatus = Awaited<ReturnType<typeof window.openclaw.plugin.weixin.getStatus>>;

const loggedOutStatus = (): WeixinStatus => ({
  enabled: true,
  requestedEnabled: true,
  effectiveEnabled: true,
  pausedByMxc: false,
  installed: true,
  loggedIn: false,
  accountCount: 0,
  invariantState: "none",
  currentAccount: null,
  loginInProgress: false,
});

const loggedInStatus = (
  accountId = "current-im-bot",
  userId = "current@im.wechat",
): WeixinStatus => ({
  ...loggedOutStatus(),
  loggedIn: true,
  accountCount: 1,
  invariantState: "single",
  currentAccount: { accountId, userId },
});

const views = [
  ["ChannelsView", ChannelsView],
  ["PluginsView", PluginsView],
] as const;

describe.each(views)("%s WeChat account status", (_name, component) => {
  const getStatus = vi.fn();
  const loginQrStart = vi.fn();
  const login = vi.fn();
  let loginDone: ((result: { code: number | null }) => void) | null;

  function mountView() {
    return mount(component, {
      global: {
        plugins: [createPinia()],
        stubs: {
          "el-button": buttonStub,
          "el-switch": switchStub,
          "el-alert": true,
        },
      },
    });
  }

  beforeEach(() => {
    setLocale("en-US");
    loginDone = null;
    getStatus.mockReset().mockResolvedValue(loggedOutStatus());
    loginQrStart.mockReset().mockResolvedValue({
      ok: false,
      message: "fast path unavailable",
      error: "fast path unavailable",
    });
    login.mockReset().mockResolvedValue({ ok: true });
    const openclaw = createBrowserOpenClawMock();
    window.openclaw = {
      ...openclaw,
      plugin: {
        weixin: {
          ...openclaw.plugin.weixin,
          getStatus,
          loginQrStart,
          login,
          onLoginDone(callback) {
            loginDone = callback;
            return () => {
              loginDone = null;
            };
          },
        },
      },
    };
    vi.spyOn(ElMessageBox, "confirm").mockResolvedValue({ action: "confirm" } as never);
  });

  it("shows explicit logged-out status", async () => {
    const wrapper = mountView();
    await flushPromises();

    expect(wrapper.find('[data-testid="weixin-account-status"]').text()).toContain("Not logged in");
    expect(wrapper.text()).toContain("Log in to WeChat");
  });

  it("shows the safe logged-in identity and replacement action", async () => {
    getStatus.mockResolvedValue(loggedInStatus());
    const wrapper = mountView();
    await flushPromises();

    const status = wrapper.find('[data-testid="weixin-account-status"]').text();
    expect(status).toContain("Logged in");
    expect(status).toContain("current-im-bot");
    expect(status).toContain("current@im.wechat");
    expect(wrapper.text()).toContain("Replace WeChat account");
  });

  it("preserves the current identity when replacement fails", async () => {
    getStatus.mockResolvedValue(loggedInStatus());
    login.mockResolvedValue({ ok: false, error: "replacement failed" });
    const wrapper = mountView();
    await flushPromises();

    const replaceButton = wrapper
      .findAll("button")
      .find((button) => button.text().includes("Replace WeChat account"));
    await replaceButton!.trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-testid="weixin-account-status"]').text()).toContain(
      "current-im-bot",
    );
    expect(wrapper.find('[data-testid="weixin-account-status"]').text()).toContain("Logged in");
  });

  it("refreshes safe status to the replacement identity after successful fallback login", async () => {
    getStatus
      .mockResolvedValueOnce(loggedInStatus())
      .mockResolvedValue(loggedInStatus("replacement-im-bot", "replacement@im.wechat"));
    const wrapper = mountView();
    await flushPromises();

    const replaceButton = wrapper
      .findAll("button")
      .find((button) => button.text().includes("Replace WeChat account"));
    await replaceButton!.trigger("click");
    await flushPromises();
    await loginDone!({ code: 0 });
    await flushPromises();

    const status = wrapper.find('[data-testid="weixin-account-status"]').text();
    expect(status).toContain("replacement-im-bot");
    expect(status).toContain("replacement@im.wechat");
    expect(status).not.toContain("current-im-bot");
  });
});
