import { createPinia } from "pinia";
import { flushPromises, shallowMount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElMessage } from "element-plus";
import App from "./App.vue";
import SettingsView from "@/views/SettingsView.vue";
import GatewayLoading from "@/components/GatewayLoading.vue";
import MxcCapabilityConsentDialog from "@/components/MxcCapabilityConsentDialog.vue";
import MxcWeixinRemoteApprovalDialog from "@/components/MxcWeixinRemoteApprovalDialog.vue";
import { createBrowserOpenClawMock } from "@/browser-openclaw";
import { useGatewayStore } from "@/stores/gateway";
import { useChatStore } from "@/stores/chat";

type MxcStatus = Awaited<ReturnType<OpenClawAPI["windowsNodeMxc"]["getStatus"]>>;
type LifecycleState = MxcStatus["lifecycleState"];

describe("App MXC loading gate with the real Gateway store", () => {
  let lifecycle: (state: LifecycleState) => void;
  let serviceReady: () => void;
  let status: MxcStatus;
  let sequence: number;
  let wrapper: ReturnType<typeof shallowMount>;

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
    vi.spyOn(
      window.openclaw.windowsNodeMxc,
      "getWeixinRemoteApprovalActivationOptions",
    ).mockResolvedValue({
      weixinEnabled: true,
      linkedAccountCount: 1,
      authenticatedAccountCount: 1,
      invariantState: "single",
      account: { accountId: "exact-bot", userId: "exact-user" },
      enableAvailable: true,
      unavailableReason: null,
    });
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
          ElButton: true,
          ElOption: true,
          ElSelect: true,
          ElInput: true,
          ElDialog: true,
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

  async function selectEnabled() {
    const settings = wrapper.findComponent(SettingsView);
    await settings.find('[data-testid="mxc-select-full"]').trigger("click");
    settings.findComponent(MxcCapabilityConsentDialog).vm.$emit("accept");
    await flushPromises();
    settings.findComponent(MxcWeixinRemoteApprovalDialog).vm.$emit("confirm", {
      enabled: true,
      owner: { accountId: "exact-bot", userId: "exact-user" },
    });
    await flushPromises();
  }

  function emitPhase(phase: LifecycleState["phase"], detail: string | null = null) {
    status = {
      ...status,
      lifecycleState: { phase, detail, updatedAt: new Date(++sequence * 1000).toISOString() },
    };
    lifecycle(status.lifecycleState);
  }

  it.each([
    "WeChat remote approval activation cancelled",
    "Wait for the managed Gateway startup or restart to finish",
    "Another Windows Node + MXC lifecycle operation is already in progress",
  ])(
    "keeps the live ordinary route ready on pending native consent then early rejection: %s",
    async (reason) => {
      let reject!: (error: Error) => void;
      const setEnabled = vi.spyOn(window.openclaw.windowsNodeMxc, "setEnabled").mockImplementation(
        () =>
          new Promise((_, rejectPromise) => {
            reject = rejectPromise;
          }),
      );
      const errorMessage = vi.spyOn(ElMessage, "error");
      const { gateway, chat } = await mountReadyApp();
      const epoch = gateway.readinessEpoch;
      await selectEnabled();
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

  it("tracks Off validation and only recovers after main confirms standard service readiness", async () => {
    let reject!: (error: Error) => void;
    vi.spyOn(window.openclaw.windowsNodeMxc, "setEnabled").mockImplementation(
      () =>
        new Promise((_, rejectPromise) => {
          reject = rejectPromise;
        }),
    );
    const errorMessage = vi.spyOn(ElMessage, "error");
    const { gateway, chat } = await mountReadyApp();
    await selectEnabled();
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
