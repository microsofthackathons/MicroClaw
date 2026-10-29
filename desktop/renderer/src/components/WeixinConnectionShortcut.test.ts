import { createPinia } from "pinia";
import { reactive } from "vue";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElMessageBox } from "element-plus";
import { createBrowserOpenClawMock } from "@/browser-openclaw";
import { setLocale, t } from "@/i18n";
import WeixinConnectionShortcut from "./WeixinConnectionShortcut.vue";

const route = reactive({ fullPath: "/chat/main" });
const push = vi.fn();
vi.mock("vue-router", () => ({ useRoute: () => route, useRouter: () => ({ push }) }));
vi.mock("qrcode", () => ({ default: { toCanvas: vi.fn().mockResolvedValue(undefined) } }));

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
  mutationLocked: false,
  mutationLockRevision: 0,
  runtimeKnown: true,
  ready: true,
  connected: false,
  connecting: false,
  qrSession: { state: "idle", message: "" },
});
const loggedInStatus = (): WeixinStatus => ({
  ...loggedOutStatus(),
  loggedIn: true,
  accountCount: 1,
  invariantState: "single",
  currentAccount: { accountId: "current-im-bot" },
  connected: true,
  qrSession: { state: "connected", message: "Connected" },
});

describe("WeChat sidebar shortcut", () => {
  let wrapper: VueWrapper | undefined;
  let currentStatus: WeixinStatus;
  const getStatus = vi.fn();
  const loginQrStart = vi.fn();
  const cancelLogin = vi.fn();
  const disconnect = vi.fn();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    setLocale("en-US");
    route.fullPath = "/chat/main";
    currentStatus = loggedOutStatus();
    getStatus.mockReset().mockImplementation(async () => structuredClone(currentStatus));
    loginQrStart.mockReset().mockImplementation(async () => {
      currentStatus = {
        ...currentStatus,
        loginInProgress: true,
        qrSession: { state: "waiting", qrDataUrl: "https://example.test/qr", message: "Scan QR" },
      };
      return {
        ok: true,
        qrDataUrl: "https://example.test/qr",
        sessionKey: "one",
        message: "Scan QR",
      };
    });
    cancelLogin.mockReset().mockImplementation(async () => {
      currentStatus = loggedOutStatus();
    });
    disconnect.mockReset().mockImplementation(async () => {
      currentStatus = loggedOutStatus();
      return { ok: true };
    });
    vi.spyOn(ElMessageBox, "confirm").mockResolvedValue("confirm" as never);
    const api = createBrowserOpenClawMock();
    Object.assign(api.plugin.weixin, { getStatus, loginQrStart, cancelLogin, disconnect });
    window.openclaw = api;
  });

  afterEach(async () => {
    wrapper?.unmount();
    wrapper = undefined;
    await flushPromises();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function mountShortcut() {
    wrapper = mount(WeixinConnectionShortcut, {
      global: {
        plugins: [createPinia()],
        stubs: {
          ElPopover: {
            name: "ElPopover",
            props: ["visible"],
            emits: ["update:visible"],
            template:
              '<div><div @click="$emit(\'update:visible\', !visible)"><slot name="reference"/></div><div v-show="visible" role="dialog"><slot/></div></div>',
          },
          ElButton: {
            props: ["disabled", "loading"],
            emits: ["click"],
            template:
              '<button :disabled="disabled || loading" @click="$emit(\'click\')"><slot/></button>',
          },
          ElAlert: { props: ["title"], template: '<div role="alert">{{ title }}</div>' },
          ElDialog: true,
        },
      },
    });
    return wrapper;
  }

  async function openShortcut() {
    await wrapper!.get('[data-testid="weixin-shortcut"]').trigger("click");
    await vi.dynamicImportSettled();
    await flushPromises();
  }

  function button(key: string) {
    return wrapper!.findAll("button").find((candidate) => candidate.text() === t(key))!;
  }

  it("does not load the connection surface or start login on mount or hover", async () => {
    mountShortcut();
    await wrapper!.get('[data-testid="weixin-shortcut"]').trigger("mouseenter");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(wrapper!.find(".weixin-card").exists()).toBe(false);
    expect(getStatus).not.toHaveBeenCalled();
    expect(loginQrStart).not.toHaveBeenCalled();
    expect(wrapper!.get('[data-testid="weixin-shortcut"]').attributes("aria-expanded")).toBe(
      "false",
    );
  });

  it("shows a QR in the anchored popover with one click and no navigation", async () => {
    mountShortcut();
    await openShortcut();
    expect(loginQrStart).toHaveBeenCalledOnce();
    expect(wrapper!.find("canvas").exists()).toBe(true);
    expect(wrapper!.find(".weixin-inline").exists()).toBe(true);
    expect(wrapper!.get('[data-testid="weixin-shortcut"]').attributes("aria-expanded")).toBe(
      "true",
    );
    expect(push).not.toHaveBeenCalled();
  });

  it("closes immediately and serializes a quick reopen behind pending cancellation", async () => {
    let finishCancel!: () => void;
    cancelLogin.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishCancel = () => {
            currentStatus = loggedOutStatus();
            resolve();
          };
        }),
    );
    mountShortcut();
    await openShortcut();
    await wrapper!.get(".connection-close").trigger("click");
    await flushPromises();
    expect(wrapper!.find("canvas").exists()).toBe(false);
    expect(wrapper!.get('[data-testid="weixin-shortcut"]').attributes("aria-expanded")).toBe(
      "false",
    );
    expect(cancelLogin).toHaveBeenCalledOnce();
    await openShortcut();
    expect(loginQrStart).toHaveBeenCalledOnce();
    finishCancel();
    await flushPromises();
    expect(loginQrStart).toHaveBeenCalledTimes(2);
    expect(wrapper!.find("canvas").exists()).toBe(true);
  });

  it("keeps expired QR codes visible and refreshes only when clicked", async () => {
    mountShortcut();
    await openShortcut();
    currentStatus = {
      ...loggedOutStatus(),
      qrSession: { state: "expired", qrDataUrl: "https://example.test/qr", message: "Expired" },
    };
    await vi.advanceTimersByTimeAsync(60_000);
    expect(wrapper!.get(".qr-frame").classes()).toContain("expired");
    expect(loginQrStart).toHaveBeenCalledOnce();
    await wrapper!.get('[data-testid="weixin-qr-refresh"]').trigger("click");
    await flushPromises();
    expect(loginQrStart).toHaveBeenCalledTimes(2);
    expect(wrapper!.find('[data-testid="weixin-qr-refresh"]').exists()).toBe(false);
  });

  it("shows an existing connection without starting login and can disconnect", async () => {
    currentStatus = loggedInStatus();
    mountShortcut();
    await openShortcut();
    expect(loginQrStart).not.toHaveBeenCalled();
    expect(wrapper!.get('[data-testid="weixin-account-status"]').text()).toBe(
      t("channels.connected"),
    );
    expect(wrapper!.find("canvas").exists()).toBe(false);
    await button("plugins.disconnect").trigger("click");
    await flushPromises();
    expect(disconnect).toHaveBeenCalledWith({ accountId: "current-im-bot" });
    expect(wrapper!.get('[data-testid="weixin-shortcut"]').attributes("aria-expanded")).toBe(
      "false",
    );
    expect(loginQrStart).not.toHaveBeenCalled();
  });

  it("replaces a successful QR with the connected state without cancelling it", async () => {
    mountShortcut();
    await openShortcut();
    currentStatus = loggedInStatus();
    await vi.advanceTimersByTimeAsync(800);
    expect(wrapper!.find("canvas").exists()).toBe(false);
    expect(wrapper!.get('[data-testid="weixin-account-status"]').text()).toBe(
      t("channels.connected"),
    );
    expect(cancelLogin).not.toHaveBeenCalled();
  });

  it("respects the MXC mutation lock", async () => {
    currentStatus.mutationLocked = true;
    mountShortcut();
    await openShortcut();
    expect(loginQrStart).not.toHaveBeenCalled();
    expect(wrapper!.text()).toContain(t("plugins.weixinMutationLocked"));
  });

  it("does not retry a failed login automatically", async () => {
    loginQrStart.mockResolvedValueOnce({ ok: false, message: "Login failed" });
    mountShortcut();
    await openShortcut();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(loginQrStart).toHaveBeenCalledOnce();
    expect(wrapper!.text()).toContain("Login failed");
    await button("plugins.connectWeixin").trigger("click");
    await flushPromises();
    expect(loginQrStart).toHaveBeenCalledTimes(2);
  });

  it.each(["escape", "outside", "navigation", "trigger"])(
    "closes on %s and stops polling while hidden",
    async (action) => {
      mountShortcut();
      await openShortcut();
      if (action === "escape")
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
      else if (action === "navigation") route.fullPath = "/settings";
      else if (action === "trigger")
        await wrapper!.get('[data-testid="weixin-shortcut"]').trigger("click");
      else wrapper!.findComponent({ name: "ElPopover" }).vm.$emit("update:visible", false);
      await flushPromises();
      const statusCalls = getStatus.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(wrapper!.get('[data-testid="weixin-shortcut"]').attributes("aria-expanded")).toBe(
        "false",
      );
      expect(cancelLogin).toHaveBeenCalledOnce();
      expect(loginQrStart).toHaveBeenCalledOnce();
      expect(getStatus).toHaveBeenCalledTimes(statusCalls);
    },
  );
});
