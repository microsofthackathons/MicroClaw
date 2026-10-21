import { createPinia } from "pinia";
import { flushPromises, shallowMount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { isProxy } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElMessage } from "element-plus";
import App from "./App.vue";
import SettingsView from "@/views/SettingsView.vue";
import GatewayLoading from "@/components/GatewayLoading.vue";
import MxcCapabilityConsentDialog from "@/components/MxcCapabilityConsentDialog.vue";
import { createBrowserOpenClawMock } from "@/browser-openclaw";
import { useGatewayStore } from "@/stores/gateway";
import { useChatStore } from "@/stores/chat";
import { planWeixinRemoteApprovalNativeTransition } from "../../src/windows-node-mxc-weixin-remote-approval-consent";
import {
  planWeixinRemoteApprovalTransition,
  type WeixinRemoteApprovalActivationOptions,
} from "../../src/windows-node-mxc-weixin-remote-approval-activation";

type MxcStatus = Awaited<ReturnType<OpenClawAPI["windowsNodeMxc"]["getStatus"]>>;
type LifecycleState = MxcStatus["lifecycleState"];

describe("App MXC loading gate with the real Gateway store", () => {
  let lifecycle: (state: LifecycleState) => void;
  let serviceReady: () => void;
  let status: MxcStatus;
  let sequence: number;
  let wrapper: ReturnType<typeof shallowMount>;
  let nativeOptions: WeixinRemoteApprovalActivationOptions;
  const nativeDialog = vi.fn();
  const persist = vi.fn();

  beforeEach(async () => {
    vi.useFakeTimers();
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    window.openclaw = createBrowserOpenClawMock();
    status = await window.openclaw.windowsNodeMxc.getStatus();
    status.fullAvailability = {
      available: true,
      summary: "Available",
      blockers: [],
      remediation: [],
    };
    sequence = 0;
    vi.spyOn(window.openclaw.windowsNodeMxc, "getStatus").mockImplementation(async () => status);
    vi.spyOn(window.openclaw.windowsNodeMxc, "onLifecycleState").mockImplementation((callback) => {
      lifecycle = callback;
      return vi.fn();
    });
    vi.spyOn(window.openclaw.gateway, "onServiceReady").mockImplementation((callback) => {
      serviceReady = callback;
      return vi.fn();
    });
    vi.spyOn(window.openclaw.settings, "get").mockResolvedValue({
      ...(await window.openclaw.settings.get()),
      language: "en-US",
    });
    nativeOptions = {
      weixinEnabled: true,
      linkedAccountCount: 1,
      authenticatedAccountCount: 1,
      invariantState: "single",
      account: { accountId: "exact-bot", userId: "exact-user@im.wechat" },
      enableAvailable: true,
      unavailableReason: null,
    };
    nativeDialog.mockReset().mockResolvedValue({ response: 0 });
    persist.mockReset();
  });

  afterEach(() => {
    wrapper?.unmount();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function mountReadyApp() {
    const pinia = createPinia();
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: "/settings/:section", name: "settings", component: SettingsView }],
    });
    await router.push("/settings/security");
    wrapper = shallowMount(App, {
      global: {
        plugins: [pinia, router],
        stubs: {
          RouterView: false,
          SettingsView: false,
          GatewayLoading: false,
          ElSwitch: true,
          ElRadio: true,
          ElRadioGroup: true,
          ElButton: {
            props: ["disabled", "loading"],
            emits: ["click"],
            template: '<button :disabled="disabled" @click="$emit(\'click\')"><slot/></button>',
          },
          ElOption: true,
          ElSelect: true,
          ElInput: true,
          ElDialog: {
            props: ["modelValue"],
            template: '<div v-if="modelValue"><slot/><slot name="footer"/></div>',
          },
        },
      },
    });
    await flushPromises();
    await vi.advanceTimersByTimeAsync(650);
    await flushPromises();
    const gateway = useGatewayStore(pinia);
    const chat = useChatStore(pinia);
    chat.wsConnected = true;
    expect(gateway.ready).toBe(true);
    expect(wrapper.find(".app-layout").exists()).toBe(true);
    return { gateway, chat };
  }

  async function requestFullActivation() {
    const settings = wrapper.findComponent(SettingsView);
    await settings.find('[data-testid="mxc-select-full"]').trigger("click");
    settings.findComponent(MxcCapabilityConsentDialog).vm.$emit("accept");
    await flushPromises();
    expect(settings.text()).not.toContain("Remote command approval");
  }

  function useNativeMainBridge() {
    return vi
      .spyOn(window.openclaw.windowsNodeMxc, "setEnabled")
      .mockImplementation(async (params) => {
        expect(isProxy(params)).toBe(false);
        const request = structuredClone(params);
        const requestedMode = request.requestedMode;
        if (!requestedMode) throw new Error("A mode is required");
        const { selection } = await planWeixinRemoteApprovalNativeTransition({
          request,
          currentMode: status.requestedMode,
          requestedMode,
          currentConfiguration: { enabled: false, owner: null },
          readOptions: () => nativeOptions,
          showDialog: nativeDialog,
          locale: "en-US",
        });
        persist(
          planWeixinRemoteApprovalTransition({
            currentMode: status.requestedMode,
            requestedMode,
            selection,
            options: nativeOptions,
          }),
        );
        return status;
      });
  }

  function emitPhase(phase: LifecycleState["phase"], detail: string | null = null) {
    status = {
      ...status,
      lifecycleState: { phase, detail, updatedAt: new Date(++sequence * 1000).toISOString() },
    };
    lifecycle(status.lifecycleState);
  }

  it.each([
    "Wait for the managed Gateway startup or restart to finish",
    "Another Windows Node + MXC lifecycle operation is already in progress",
  ])(
    "keeps the live ordinary route ready on pending native consent then early rejection: %s",
    async (reason) => {
      let reject!: (error: Error) => void;
      const setEnabled = vi
        .spyOn(window.openclaw.windowsNodeMxc, "setEnabled")
        .mockImplementation((params) => {
          structuredClone(params);
          return new Promise((_, rejectPromise) => {
            reject = rejectPromise;
          });
        });
      const errorMessage = vi.spyOn(ElMessage, "error");
      const { gateway, chat } = await mountReadyApp();
      const epoch = gateway.readinessEpoch;
      await requestFullActivation();
      expect(setEnabled).toHaveBeenCalledOnce();
      expect(gateway.ready).toBe(true);
      expect(chat.wsConnected).toBe(true);
      expect(gateway.readinessEpoch).toBe(epoch);
      expect(wrapper.findComponent(GatewayLoading).exists()).toBe(false);
      reject(new Error(reason));
      await flushPromises();
      expect(errorMessage).toHaveBeenCalledWith(reason);
      expect(gateway.ready).toBe(true);
      expect(chat.wsConnected).toBe(true);
      expect(wrapper.findComponent(SettingsView).exists()).toBe(true);
      await wrapper.find('[data-testid="mxc-select-full"]').trigger("click");
      expect(wrapper.findComponent(MxcCapabilityConsentDialog).props("modelValue")).toBe(true);
    },
  );

  it.each([0, 1])(
    "uses exactly one native WeChat prompt for response %s with a mode-only request",
    async (response) => {
      nativeDialog.mockResolvedValue({ response });
      const bridge = useNativeMainBridge();
      await mountReadyApp();
      await requestFullActivation();
      expect(bridge).toHaveBeenCalledExactlyOnceWith({ requestedMode: "full" });
      expect(nativeDialog).toHaveBeenCalledOnce();
      expect(nativeDialog.mock.calls[0][0]).toMatchObject({
        buttons: ["Disabled", "Enabled", "Cancel MXC activation"],
        defaultId: 0,
        cancelId: 2,
      });
      expect(persist).toHaveBeenCalledExactlyOnceWith(
        response === 1
          ? expect.objectContaining({
              action: "persist",
              configuration: {
                enabled: true,
                owner: expect.objectContaining({
                  accountId: "exact-bot",
                  userId: "exact-user@im.wechat",
                  boundAt: expect.any(String),
                }),
              },
            })
          : { action: "persist", configuration: { enabled: false, owner: null } },
      );
    },
  );

  it.each(["none", "multiple", "invalid", "disabled"] as const)(
    "skips native consent and persists disabled for %s canonical state",
    async (state) => {
      nativeOptions = {
        ...nativeOptions,
        weixinEnabled: state !== "disabled",
        invariantState: state === "disabled" ? "single" : state,
        account: null,
        enableAvailable: false,
      };
      useNativeMainBridge();
      await mountReadyApp();
      await requestFullActivation();
      expect(nativeDialog).not.toHaveBeenCalled();
      expect(persist).toHaveBeenCalledExactlyOnceWith({
        action: "persist",
        configuration: { enabled: false, owner: null },
      });
    },
  );

  it.each(["cancel", "identity-replaced"] as const)(
    "keeps the ordinary ready route on pending native consent and %s",
    async (outcome) => {
      let decide!: (value: { response: number }) => void;
      nativeDialog.mockImplementation(
        () =>
          new Promise<{ response: number }>((resolve) => {
            decide = resolve;
          }),
      );
      useNativeMainBridge();
      const errorMessage = vi.spyOn(ElMessage, "error");
      const { gateway, chat } = await mountReadyApp();
      const epoch = gateway.readinessEpoch;
      await requestFullActivation();
      expect(nativeDialog).toHaveBeenCalledOnce();
      expect(persist).not.toHaveBeenCalled();
      expect(gateway.ready).toBe(true);
      expect(chat.wsConnected).toBe(true);
      expect(wrapper.findComponent(GatewayLoading).exists()).toBe(false);
      if (outcome === "identity-replaced") {
        nativeOptions = {
          ...nativeOptions,
          account: { accountId: "replacement-bot", userId: "replacement-user" },
        };
      }
      decide({ response: outcome === "cancel" ? 2 : 1 });
      await flushPromises();
      expect(errorMessage).toHaveBeenCalledWith(
        expect.stringContaining(
          outcome === "cancel" ? "consent was cancelled" : "identity changed",
        ),
      );
      expect(persist).not.toHaveBeenCalled();
      expect(gateway.readinessEpoch).toBe(epoch);
      expect(gateway.ready).toBe(true);
      expect(chat.wsConnected).toBe(true);
      expect(wrapper.findComponent(GatewayLoading).exists()).toBe(false);
      expect(wrapper.findComponent(SettingsView).exists()).toBe(true);
    },
  );

  it("rejects a spoofed renderer owner instead of skipping native authority", async () => {
    useNativeMainBridge();
    const request = {
      requestedMode: "full" as const,
      remoteApproval: { enabled: true, owner: { accountId: "spoof", userId: "spoof" } },
    };
    await expect(window.openclaw.windowsNodeMxc.setEnabled(request)).rejects.toThrow(
      "Renderer-supplied",
    );
    expect(nativeDialog).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
  });

  it("tracks Off validation and only recovers after main confirms standard service readiness", async () => {
    let reject!: (error: Error) => void;
    vi.spyOn(window.openclaw.windowsNodeMxc, "setEnabled").mockImplementation((params) => {
      structuredClone(params);
      return new Promise((_, rejectPromise) => {
        reject = rejectPromise;
      });
    });
    const errorMessage = vi.spyOn(ElMessage, "error");
    const { gateway, chat } = await mountReadyApp();
    await requestFullActivation();
    emitPhase("locking");
    emitPhase("validating", "Assessing Limited-mode ambient filesystem access");
    await flushPromises();
    expect(status.requestedMode).toBe("off");
    expect(gateway.ready).toBe(false);
    expect(chat.wsConnected).toBe(false);
    const loading = wrapper.findComponent(GatewayLoading);
    expect(loading.props("mxcDesired")).toBe(false);
    expect(loading.find(".loading-status").text()).toContain("Validating policy");
    expect(loading.find(".loading-mxc-detail").text()).toContain("ambient filesystem access");
    expect(loading.find(".loading-status").text()).not.toContain("90%");
    emitPhase("failed", "ambient assessment timed out after 180000ms");
    await flushPromises();
    expect(gateway.lastError).toContain("ambient assessment timed out");
    emitPhase("starting-standard");
    await flushPromises();
    expect(gateway.ready).toBe(false);
    emitPhase("idle");
    await flushPromises();
    expect(gateway.ready).toBe(false);
    serviceReady();
    await flushPromises();
    await vi.advanceTimersByTimeAsync(650);
    await flushPromises();
    expect(gateway.ready).toBe(true);
    expect(wrapper.findComponent(SettingsView).exists()).toBe(true);
    reject(new Error("ambient assessment timed out after 180000ms"));
    await flushPromises();
    expect(errorMessage).toHaveBeenCalledWith("ambient assessment timed out after 180000ms");
    expect(wrapper.findComponent(GatewayLoading).exists()).toBe(false);
  });
});
