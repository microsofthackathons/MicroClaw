import { createPinia } from "pinia";
import { reactive, ref, type Ref } from "vue";
import { flushPromises, mount, type VueWrapper } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElMessageBox } from "element-plus";
import { createBrowserOpenClawMock } from "@/browser-openclaw";
import { setLocale, t } from "@/i18n";
import {
  windowsNodeMxcLifecycleStateKey,
  type WindowsNodeMxcLifecycleState,
} from "@/windows-node-mxc-lifecycle";
import WeixinConnectionShortcut from "./WeixinConnectionShortcut.vue";
import { useChatStore } from "@/stores/chat";
import { useSessionStore } from "@/stores/sessions";

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
  let mxcLifecycleState: Ref<WindowsNodeMxcLifecycleState | null>;
  let mutationLock: Parameters<OpenClawAPI["plugin"]["weixin"]["onMutationLock"]>[0];
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
    mxcLifecycleState = ref(null);
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
    Object.assign(api.plugin.weixin, {
      getStatus,
      loginQrStart,
      cancelLogin,
      disconnect,
      onMutationLock: (callback: typeof mutationLock) => {
        mutationLock = callback;
        return vi.fn();
      },
    });
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
        provide: { [windowsNodeMxcLifecycleStateKey as symbol]: mxcLifecycleState },
        stubs: {
          ElPopover: {
            name: "ElPopover",
            props: ["visible"],
            emits: ["update:visible"],
            template:
              '<div><slot name="reference"/><div v-show="visible" role="dialog"><slot/></div></div>',
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

  it.each(["en-US", "zh-CN"] as const)(
    "shows only a device icon with an accessible phone label in %s",
    (locale) => {
      setLocale(locale);
      mountShortcut();
      const shortcut = wrapper!.get('[data-testid="weixin-shortcut"]');
      expect(shortcut.text()).toBe("");
      expect(shortcut.find("img").exists()).toBe(false);
      expect(shortcut.get("svg").attributes("aria-hidden")).toBe("true");
      expect(shortcut.get("svg").attributes("width")).toBe("16");
      expect(shortcut.get("svg").attributes("height")).toBe("16");
      expect(shortcut.attributes("title")).toBe(t("sidebar.phone"));
      expect(shortcut.attributes("aria-label")).toBe(t("sidebar.phone"));
      expect(shortcut.attributes("aria-haspopup")).toBe("dialog");
    },
  );

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

  it.each([false, true])("uses the same QR presentation with MXC enabled=%s", async (mxc) => {
    currentStatus = {
      ...loggedOutStatus(),
      mutationLocked: mxc,
      loginLocked: false,
    };
    loginQrStart.mockImplementationOnce(async () => {
      currentStatus = {
        ...currentStatus,
        loginInProgress: true,
        pausedByMxc: mxc,
        ready: !mxc,
        loginLocked: mxc,
        mutationLockRevision: 1,
        qrSession: { state: "waiting", qrDataUrl: "https://example.test/qr", message: "Scan QR" },
      };
      return { ok: true, qrDataUrl: "https://example.test/qr", message: "Scan QR" };
    });
    mountShortcut();
    await openShortcut();
    await vi.advanceTimersByTimeAsync(800);
    expect(loginQrStart).toHaveBeenCalledExactlyOnceWith({ force: false });
    expect(ElMessageBox.confirm).not.toHaveBeenCalled();
    expect(wrapper!.find("canvas").exists()).toBe(true);
    expect(wrapper!.get(".qr-content").text()).toBe("Scan QR");
    expect(wrapper!.find(".weixin-body").exists()).toBe(false);
    expect(wrapper!.find('[role="alert"]').exists()).toBe(false);
    expect(push).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "opens existing WeChat main history rather than an empty alias with MXC enabled=%s",
    async (mxc) => {
      currentStatus = { ...loggedInStatus(), mutationLocked: mxc, loginLocked: false };
      const history = vi.spyOn(window.openclaw.chat, "loadHistory").mockResolvedValue({
        sessionKey: "main",
        messages: [{ role: "user", content: "Existing WeChat message" }],
        sessionInfo: {
          key: "agent:main:main",
          isMain: true,
          hasActiveRun: false,
          activeRunIds: [],
        },
      });
      mountShortcut();
      const chat = useChatStore();
      const sessions = useSessionStore();
      sessions.clearAll();
      await openShortcut();
      await button("plugins.viewWeixinMessages").trigger("click");
      await flushPromises();
      expect(history).toHaveBeenCalledExactlyOnceWith("main");
      expect(chat.sessionKey).toBe("agent:main:main");
      expect(chat.messages).toEqual([{ role: "user", content: "Existing WeChat message" }]);
      expect(chat.lastError).toBeNull();
      expect(sessions.sessions.map((session) => session.key)).toEqual(["agent:main:main"]);
      expect(push).toHaveBeenCalledExactlyOnceWith("/chat");
      expect(wrapper!.get('[data-testid="weixin-shortcut"]').attributes("aria-expanded")).toBe(
        "false",
      );
      expect(loginQrStart).not.toHaveBeenCalled();
      expect(cancelLogin).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "can disconnect a connected account and reopen the same QR flow with MXC enabled=%s",
    async (mxc) => {
      currentStatus = { ...loggedInStatus(), mutationLocked: mxc, loginLocked: false };
      disconnect.mockImplementationOnce(async () => {
        currentStatus = { ...loggedOutStatus(), mutationLocked: mxc, loginLocked: false };
        return { ok: true };
      });
      mountShortcut();
      await openShortcut();
      expect(wrapper!.get('[data-testid="weixin-account-status"]').text()).toBe(
        t("channels.connected"),
      );
      expect(wrapper!.find(".weixin-body").exists()).toBe(false);
      expect(wrapper!.find("canvas").exists()).toBe(false);
      expect(button("plugins.disconnect").attributes("disabled")).toBeUndefined();
      expect(loginQrStart).not.toHaveBeenCalled();
      await button("plugins.disconnect").trigger("click");
      await flushPromises();
      expect(disconnect).toHaveBeenCalledExactlyOnceWith({ accountId: "current-im-bot" });
      expect(ElMessageBox.confirm).toHaveBeenCalledOnce();
      expect(wrapper!.get('[data-testid="weixin-shortcut"]').attributes("aria-expanded")).toBe(
        "false",
      );
      await openShortcut();
      expect(loginQrStart).toHaveBeenCalledExactlyOnceWith({ force: false });
      expect(wrapper!.find("canvas").exists()).toBe(true);
      expect(ElMessageBox.confirm).toHaveBeenCalledOnce();
    },
  );

  it.each([false, true])(
    "starts account replacement directly without confirmation with MXC enabled=%s",
    async (mxc) => {
      currentStatus = {
        ...loggedInStatus(),
        connected: false,
        mutationLocked: mxc,
        loginLocked: false,
        qrSession: { state: "idle", message: "" },
      };
      mountShortcut();
      await openShortcut();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(wrapper!.get('[data-testid="weixin-shortcut"]').attributes("aria-expanded")).toBe(
        "true",
      );
      expect(ElMessageBox.confirm).not.toHaveBeenCalled();
      expect(loginQrStart).toHaveBeenCalledExactlyOnceWith({ force: true });
      expect(wrapper!.find("canvas").exists()).toBe(true);
      expect(cancelLogin).not.toHaveBeenCalled();
      document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
      await flushPromises();
      expect(wrapper!.get('[data-testid="weixin-shortcut"]').attributes("aria-expanded")).toBe(
        "false",
      );
      expect(cancelLogin).toHaveBeenCalledOnce();
    },
  );

  it("keeps a disconnect failure visible after accepting the confirmation", async () => {
    currentStatus = loggedInStatus();
    disconnect.mockResolvedValueOnce({ ok: false, error: "Disconnect failed" });
    let confirm!: (value: Awaited<ReturnType<typeof ElMessageBox.confirm>>) => void;
    vi.mocked(ElMessageBox.confirm).mockReturnValueOnce(
      new Promise((resolve) => {
        confirm = resolve;
      }),
    );
    mountShortcut();
    await openShortcut();
    await button("plugins.disconnect").trigger("click");
    document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    confirm("confirm" as never);
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(wrapper!.get('[data-testid="weixin-shortcut"]').attributes("aria-expanded")).toBe(
      "true",
    );
    expect(wrapper!.text()).toContain("Disconnect failed");
    expect(disconnect).toHaveBeenCalledOnce();
    expect(cancelLogin).not.toHaveBeenCalled();
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

  it.each(["connecting-weixin", "disconnecting-weixin"] as const)(
    "shows the normal QR loader while %s finishes and starts immediately after unlock",
    async (phase) => {
      currentStatus = {
        ...loggedOutStatus(),
        effectiveEnabled: false,
        pausedByMxc: true,
        ready: false,
        mutationLocked: true,
        loginLocked: true,
        mutationLockRevision: 1,
      };
      mxcLifecycleState.value = { phase, detail: null, updatedAt: new Date().toISOString() };
      mountShortcut();
      await openShortcut();
      expect(wrapper!.get(".qr-content").text()).toBe(t("plugins.weixinPreparingQr"));
      expect(wrapper!.text()).not.toContain(t("plugins.weixinLoginLocked"));
      expect(wrapper!.text()).not.toContain(t("plugins.weixinPreparing"));
      expect(loginQrStart).not.toHaveBeenCalled();

      mxcLifecycleState.value = {
        phase: "active",
        detail: null,
        updatedAt: new Date().toISOString(),
      };
      currentStatus = {
        ...loggedOutStatus(),
        mutationLocked: true,
        loginLocked: false,
        mutationLockRevision: 2,
      };
      mutationLock({ locked: true, loginLocked: false, revision: 2 });
      await flushPromises();
      expect(loginQrStart).toHaveBeenCalledExactlyOnceWith({ force: false });
      expect(wrapper!.find("canvas").exists()).toBe(true);
    },
  );

  it("keeps an unrelated containment lock visible rather than starting login", async () => {
    currentStatus = {
      ...loggedOutStatus(),
      effectiveEnabled: false,
      pausedByMxc: true,
      ready: false,
      mutationLocked: true,
      loginLocked: true,
      mutationLockRevision: 1,
    };
    mxcLifecycleState.value = {
      phase: "updating-folders",
      detail: null,
      updatedAt: new Date().toISOString(),
    };
    mountShortcut();
    await openShortcut();
    expect(wrapper!.text()).toContain(t("plugins.weixinLoginLocked"));
    expect(wrapper!.find(".qr-content").exists()).toBe(false);
    expect(loginQrStart).not.toHaveBeenCalled();
  });

  it("shows the QR already being prepared by another MXC connection surface", async () => {
    currentStatus = {
      ...loggedOutStatus(),
      effectiveEnabled: false,
      pausedByMxc: true,
      ready: false,
      loginInProgress: true,
      mutationLocked: true,
      loginLocked: true,
      mutationLockRevision: 1,
      qrSession: { state: "starting", message: "" },
    };
    mxcLifecycleState.value = {
      phase: "connecting-weixin",
      detail: null,
      updatedAt: new Date().toISOString(),
    };
    mountShortcut();
    await openShortcut();
    expect(wrapper!.get(".qr-content").text()).toBe(t("plugins.weixinPreparingQr"));
    currentStatus.qrSession = {
      state: "waiting",
      qrDataUrl: "https://example.test/shared-qr",
      message: "Scan QR",
    };
    await vi.advanceTimersByTimeAsync(5_000);
    expect(wrapper!.find("canvas").exists()).toBe(true);
    expect(wrapper!.get(".qr-content").text()).toBe("Scan QR");
    expect(loginQrStart).not.toHaveBeenCalled();
    await wrapper!.get(".connection-close").trigger("click");
    await flushPromises();
    expect(cancelLogin).not.toHaveBeenCalled();
  });

  it("keeps a shared expired QR visible until the user explicitly refreshes it", async () => {
    currentStatus = {
      ...loggedOutStatus(),
      effectiveEnabled: false,
      pausedByMxc: true,
      ready: false,
      loginInProgress: true,
      mutationLocked: true,
      loginLocked: true,
      mutationLockRevision: 1,
      qrSession: {
        state: "waiting",
        qrDataUrl: "https://example.test/shared-qr",
        message: "Scan QR",
      },
    };
    mxcLifecycleState.value = {
      phase: "connecting-weixin",
      detail: null,
      updatedAt: new Date().toISOString(),
    };
    mountShortcut();
    await openShortcut();
    currentStatus = {
      ...loggedOutStatus(),
      mutationLocked: true,
      loginLocked: false,
      mutationLockRevision: 2,
      qrSession: {
        state: "expired",
        qrDataUrl: "https://example.test/shared-qr",
        message: "Expired",
      },
    };
    mxcLifecycleState.value = {
      phase: "active",
      detail: null,
      updatedAt: new Date().toISOString(),
    };
    mutationLock({ locked: true, loginLocked: false, revision: 2 });
    await flushPromises();
    expect(wrapper!.get(".qr-frame").classes()).toContain("expired");
    expect(loginQrStart).not.toHaveBeenCalled();
    await wrapper!.get('[data-testid="weixin-qr-refresh"]').trigger("click");
    await flushPromises();
    expect(loginQrStart).toHaveBeenCalledOnce();
  });

  it("surfaces a cancellation failure instead of leaving the QR loader running", async () => {
    let rejectCancellation!: (reason: Error) => void;
    cancelLogin.mockReturnValueOnce(
      new Promise<void>((_resolve, reject) => {
        rejectCancellation = reject;
      }),
    );
    mountShortcut();
    await openShortcut();
    await wrapper!.get(".connection-close").trigger("click");
    currentStatus = {
      ...loggedOutStatus(),
      effectiveEnabled: false,
      pausedByMxc: true,
      ready: false,
      loginInProgress: true,
      mutationLocked: true,
      loginLocked: true,
      mutationLockRevision: 1,
      qrSession: {
        state: "waiting",
        qrDataUrl: "https://example.test/cancelled-qr",
        message: "Old QR",
      },
    };
    mutationLock({ locked: true, loginLocked: true, revision: 1 });
    await openShortcut();
    expect(wrapper!.get(".qr-content").text()).toBe(t("plugins.weixinPreparingQr"));
    expect(wrapper!.find("canvas").exists()).toBe(false);
    expect(loginQrStart).toHaveBeenCalledOnce();
    rejectCancellation(new Error("Cancellation failed"));
    await flushPromises();
    expect(wrapper!.text()).toContain("Cancellation failed");
    expect(loginQrStart).toHaveBeenCalledOnce();
  });

  it("respects the MXC mutation lock", async () => {
    currentStatus.mutationLocked = true;
    mountShortcut();
    await openShortcut();
    expect(loginQrStart).not.toHaveBeenCalled();
    expect(wrapper!.text()).toContain(t("plugins.weixinLoginLocked"));
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
      else document.body.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true }));
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
