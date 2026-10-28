import { createPinia } from "pinia";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElMessageBox } from "element-plus";
import { createBrowserOpenClawMock } from "@/browser-openclaw";
import { setLocale, t } from "@/i18n";
import ChannelsView from "./ChannelsView.vue";
import PluginsView from "./PluginsView.vue";

vi.mock("vue-router", () => ({ useRouter: () => ({ push: vi.fn(), back: vi.fn() }) }));
vi.mock("qrcode", () => ({ default: { toCanvas: vi.fn().mockResolvedValue(undefined) } }));

const buttonStub = {
  props: ["loading", "disabled", "type", "text", "size"],
  emits: ["click"],
  template: '<button :disabled="disabled || loading" @click="$emit(\'click\')"><slot/></button>',
};
const dialogStub = {
  props: ["modelValue", "title"],
  emits: ["update:modelValue"],
  template:
    '<div v-if="modelValue" role="dialog"><button data-testid="dialog-x" @click="$emit(\'update:modelValue\', false)">X</button><slot/><slot name="footer"/></div>',
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
  currentAccount: { accountId: "current-im-bot", userId: "current@im.wechat" },
  connected: true,
});

describe.each([
  ["ChannelsView", ChannelsView],
  ["PluginsView", PluginsView],
] as const)("%s WeChat connection", (_name, component) => {
  let currentStatus: WeixinStatus;
  let wrapper: VueWrapper | undefined;
  let mutationLock: (status: { locked: boolean; revision: number }) => void;
  const getStatus = vi.fn();
  const loginQrStart = vi.fn();
  const cancelLogin = vi.fn();
  const setEnabled = vi.fn();
  const disconnect = vi.fn();
  const restart = vi.fn();

  function mountView() {
    wrapper = mount(component, {
      global: {
        plugins: [createPinia()],
        stubs: {
          "el-button": buttonStub,
          "el-dialog": dialogStub,
          "el-alert": { props: ["title"], template: '<div role="alert">{{ title }}<slot/></div>' },
        },
      },
    });
    return wrapper;
  }
  function button(key: string) {
    return wrapper!.findAll("button").find((candidate) => candidate.text() === t(key))!;
  }
  function pendingStatus(): void {
    currentStatus = {
      ...currentStatus,
      loginInProgress: true,
      qrSession: { state: "waiting", qrDataUrl: "https://example.test/qr", message: "Scan QR" },
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    setLocale("en-US");
    currentStatus = loggedOutStatus();
    getStatus.mockReset().mockImplementation(async () => structuredClone(currentStatus));
    loginQrStart.mockReset().mockImplementation(async () => {
      pendingStatus();
      return {
        ok: true,
        qrDataUrl: currentStatus.qrSession!.qrDataUrl,
        sessionKey: "session-one",
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
    Object.assign(api.plugin.weixin, {
      getStatus,
      loginQrStart,
      cancelLogin,
      setEnabled,
      disconnect,
      onMutationLock: (callback: typeof mutationLock) => {
        mutationLock = callback;
        return vi.fn();
      },
    });
    api.gateway.restart = restart;
    window.openclaw = api;
  });

  afterEach(() => {
    wrapper?.unmount();
    wrapper = undefined;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("shows a connect button without a plugin switch or hot activation", async () => {
    setLocale("zh-CN");
    mountView();
    await flushPromises();
    expect(button("plugins.connectWeixin").attributes("disabled")).toBeUndefined();
    expect(button("plugins.connectWeixin").text()).toBe("连接");
    const header = wrapper!.get(".weixin-header");
    expect(header.find('[data-testid="weixin-account-status"]').exists()).toBe(false);
    expect(header.get(".connection-actions").text()).toContain(t("plugins.connectWeixin"));
    expect(wrapper!.find(".weixin-body").exists()).toBe(false);
    expect(wrapper!.find("input[type=checkbox]").exists()).toBe(false);
    expect(setEnabled).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
    expect(loginQrStart).not.toHaveBeenCalled();
  });

  it("never starts login or shows an old QR failure before connect is clicked", async () => {
    currentStatus.qrSession = { state: "error", message: "Old QR expired repeatedly" };
    mountView();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(wrapper!.text()).not.toContain("Old QR expired repeatedly");
    expect(wrapper!.find('[role="dialog"]').exists()).toBe(false);
    expect(loginQrStart).not.toHaveBeenCalled();
    expect(cancelLogin).not.toHaveBeenCalled();
  });

  it("does not claim connection from stored credentials alone", async () => {
    currentStatus = { ...loggedInStatus(), connected: false, connecting: false };
    mountView();
    await flushPromises();
    expect(wrapper!.find('[data-testid="weixin-account-status"]').exists()).toBe(false);
    expect(button("plugins.connectWeixin")).toBeDefined();
    expect(wrapper!.text()).not.toContain("current@im.wechat");
  });

  it("shows connected status and disconnect for a live account", async () => {
    currentStatus = loggedInStatus();
    mountView();
    await flushPromises();
    expect(wrapper!.get('[data-testid="weixin-account-status"]').text()).toContain(
      t("channels.connected"),
    );
    expect(button("plugins.disconnect")).toBeDefined();
    expect(button("plugins.connectWeixin")).toBeUndefined();
  });

  it("waits for runtime readiness instead of triggering a plugin reload", async () => {
    currentStatus = { ...loggedOutStatus(), ready: false, runtimeKnown: false };
    mountView();
    await flushPromises();
    expect(button("plugins.connectWeixin").attributes("disabled")).toBeDefined();
    expect(wrapper!.text()).toContain(t("plugins.weixinPreparing"));
    expect(wrapper!.get('[data-testid="weixin-account-status"]').text()).toBe(
      t("plugins.checkingWeixinConnection"),
    );
    expect(setEnabled).not.toHaveBeenCalled();
  });

  it("closes immediately while QR creation is unresolved and stays closed after it completes", async () => {
    let resolve!: (value: unknown) => void;
    loginQrStart.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      }),
    );
    mountView();
    await flushPromises();
    await button("plugins.connectWeixin").trigger("click");
    expect(wrapper!.find('[role="dialog"]').exists()).toBe(true);
    await button("plugins.closeQr").trigger("click");
    expect(wrapper!.find('[role="dialog"]').exists()).toBe(false);
    expect(cancelLogin).toHaveBeenCalledTimes(1);
    pendingStatus();
    resolve({ ok: true, qrDataUrl: "qr", sessionKey: "session-one", message: "Scan QR" });
    await flushPromises();
    expect(wrapper!.find('[role="dialog"]').exists()).toBe(false);
  });

  it("closes immediately, cancels its QR and creates a new QR only after another click", async () => {
    mountView();
    await flushPromises();
    await button("plugins.connectWeixin").trigger("click");
    await flushPromises();
    await wrapper!.get('[data-testid="dialog-x"]').trigger("click");
    await flushPromises();
    expect(wrapper!.find('[role="dialog"]').exists()).toBe(false);
    expect(cancelLogin).toHaveBeenCalledTimes(1);
    expect(loginQrStart).toHaveBeenCalledTimes(1);
    expect(button("plugins.connectWeixin").attributes("disabled")).toBeUndefined();
    await button("plugins.connectWeixin").trigger("click");
    await flushPromises();
    expect(wrapper!.find('[role="dialog"]').exists()).toBe(true);
    expect(loginQrStart).toHaveBeenCalledTimes(2);
  });

  it("does not show a late QR failure after the dialog is closed", async () => {
    mountView();
    await flushPromises();
    await button("plugins.connectWeixin").trigger("click");
    await flushPromises();
    await button("plugins.closeQr").trigger("click");
    currentStatus = {
      ...loggedOutStatus(),
      qrSession: { state: "error", message: "Old QR expired repeatedly" },
    };
    await vi.advanceTimersByTimeAsync(5_000);
    await flushPromises();
    expect(wrapper!.text()).not.toContain("Old QR expired repeatedly");
    expect(wrapper!.find('[role="dialog"]').exists()).toBe(false);
    expect(loginQrStart).toHaveBeenCalledTimes(1);
    expect(restart).not.toHaveBeenCalled();
  });

  it("cancels when navigating away and waits for a new click after returning", async () => {
    mountView();
    await flushPromises();
    await button("plugins.connectWeixin").trigger("click");
    await flushPromises();
    wrapper!.unmount();
    await flushPromises();
    expect(cancelLogin).toHaveBeenCalledTimes(1);
    mountView();
    await flushPromises();
    expect(loginQrStart).toHaveBeenCalledTimes(1);
    await button("plugins.connectWeixin").trigger("click");
    await flushPromises();
    expect(loginQrStart).toHaveBeenCalledTimes(2);
    expect(wrapper!.find("canvas").exists()).toBe(true);
  });

  it("keeps an expired QR visible with a manual refresh overlay and never refreshes itself", async () => {
    mountView();
    await flushPromises();
    await button("plugins.connectWeixin").trigger("click");
    await flushPromises();
    currentStatus = {
      ...loggedOutStatus(),
      qrSession: { state: "expired", qrDataUrl: "https://example.test/qr", message: "Expired" },
    };
    await vi.advanceTimersByTimeAsync(60_000);
    await flushPromises();
    expect(wrapper!.get(".qr-frame").classes()).toContain("expired");
    expect(wrapper!.find("canvas").exists()).toBe(true);
    expect(wrapper!.get('[data-testid="weixin-qr-refresh"]').text()).toContain(
      t("plugins.qrExpired"),
    );
    expect(loginQrStart).toHaveBeenCalledTimes(1);
    await wrapper!.get('[data-testid="weixin-qr-refresh"]').trigger("click");
    await flushPromises();
    expect(loginQrStart).toHaveBeenCalledTimes(2);
    expect(wrapper!.find('[data-testid="weixin-qr-refresh"]').exists()).toBe(false);
    expect(restart).not.toHaveBeenCalled();
  });

  it("can close and reopen immediately while cancellation drains without creating a second writer", async () => {
    let finish!: () => void;
    cancelLogin.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    mountView();
    await flushPromises();
    await button("plugins.connectWeixin").trigger("click");
    await flushPromises();
    await button("plugins.closeQr").trigger("click");
    expect(wrapper!.find('[role="dialog"]').exists()).toBe(false);
    await button("plugins.connectWeixin").trigger("click");
    expect(wrapper!.find('[role="dialog"]').exists()).toBe(true);
    expect(loginQrStart).toHaveBeenCalledTimes(1);
    finish();
    await flushPromises();
    expect(loginQrStart).toHaveBeenCalledTimes(2);
  });

  it("closes a successful connection without cancelling the connected account", async () => {
    mountView();
    await flushPromises();
    await button("plugins.connectWeixin").trigger("click");
    await flushPromises();
    currentStatus = {
      ...loggedInStatus(),
      qrSession: { state: "connected", message: "Connected" },
    };
    await vi.advanceTimersByTimeAsync(800);
    expect(wrapper!.find('[role="dialog"]').exists()).toBe(false);
    expect(button("plugins.disconnect")).toBeDefined();
    expect(cancelLogin).not.toHaveBeenCalled();
  });

  it("disconnects the current account without disabling the plugin or restarting Gateway", async () => {
    currentStatus = loggedInStatus();
    mountView();
    await flushPromises();
    await button("plugins.disconnect").trigger("click");
    await flushPromises();
    expect(disconnect).toHaveBeenCalledExactlyOnceWith({ accountId: "current-im-bot" });
    expect(button("plugins.connectWeixin")).toBeDefined();
    expect(setEnabled).not.toHaveBeenCalled();
    expect(restart).not.toHaveBeenCalled();
  });

  it("keeps an unknown login outcome fenced without automatic recovery", async () => {
    currentStatus = { ...loggedOutStatus(), loginRequiresRestart: true };
    mountView();
    await flushPromises();
    expect(button("plugins.connectWeixin").attributes("disabled")).toBeDefined();
    expect(wrapper!.text()).toContain(t("plugins.loginRecoveryRequired"));
    expect(restart).not.toHaveBeenCalled();
  });

  it("ignores stale unlocked revisions and blocks QR creation under MXC", async () => {
    mountView();
    await flushPromises();
    mutationLock({ locked: true, revision: 3 });
    mutationLock({ locked: false, revision: 2 });
    await flushPromises();
    expect(button("plugins.connectWeixin").attributes("disabled")).toBeDefined();
    expect(loginQrStart).not.toHaveBeenCalled();
  });

  it("rechecks the mutation lock after a disconnect confirmation", async () => {
    let confirm!: (value: Awaited<ReturnType<typeof ElMessageBox.confirm>>) => void;
    vi.mocked(ElMessageBox.confirm).mockReturnValueOnce(
      new Promise((done) => {
        confirm = done;
      }),
    );
    currentStatus = loggedInStatus();
    mountView();
    await flushPromises();
    await button("plugins.disconnect").trigger("click");
    mutationLock({ locked: true, revision: 1 });
    confirm("confirm" as never);
    await flushPromises();
    expect(disconnect).not.toHaveBeenCalled();
  });

  it("fails closed when the status read fails", async () => {
    getStatus.mockRejectedValueOnce(new Error("IPC unavailable"));
    mountView();
    await flushPromises();
    expect(button("plugins.connectWeixin").attributes("disabled")).toBeDefined();
    expect(wrapper!.text()).toContain("IPC unavailable");
  });

  it("reports invalid account state without showing a connected account", async () => {
    currentStatus = {
      ...loggedOutStatus(),
      accountCount: 2,
      invariantState: "multiple",
      connected: true,
    };
    mountView();
    await flushPromises();
    expect(wrapper!.text()).toContain(t("plugins.multipleAccountsInvalid"));
    expect(wrapper!.find('[data-testid="weixin-account-status"]').exists()).toBe(false);
  });
});
