import { createPinia } from "pinia";
import { flushPromises, shallowMount } from "@vue/test-utils";
import { createMemoryHistory, createRouter } from "vue-router";
import { isProxy } from "vue";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElMessage } from "element-plus";
import App from "./App.vue";
import SettingsView from "@/views/SettingsView.vue";
import GatewayLoading from "@/components/GatewayLoading.vue";
import MxcCapabilityConsentDialog from "@/components/MxcCapabilityConsentDialog.vue";
import PermissionDialog from "@/components/PermissionDialog.vue";
import { createBrowserOpenClawMock } from "@/browser-openclaw";
import { useGatewayStore } from "@/stores/gateway";
import { useChatStore } from "@/stores/chat";
import { agentRunLifecycleEvent } from "../../src/chat-run-lifecycle";
import { GatewayClient } from "../../src/gateway-client";
import { GatewaySessionObserver } from "../../src/gateway-session-observer";
import {
  forwardGatewaySessionUpdate,
  CHAT_SESSION_UPDATE_CHANNEL,
} from "../../src/chat-session-update";
// @ts-expect-error The pinned Gateway fixture executes external ESM in a separate Node process.
import { runPinnedSessionFixture } from "../../integration/pinned-session-fixture.mjs";
import { planWeixinRemoteApprovalNativeTransition } from "../../src/windows-node-mxc-weixin-remote-approval-consent";
import { WEIXIN_NATIVE_DURABLE_CONSENT_SCOPE } from "../../src/windows-node-mxc-weixin-remote-approval";
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
  let approvalRequest: Parameters<OpenClawAPI["windowsNodeMxc"]["onApprovalRequest"]>[0];
  let approvalResolved: Parameters<OpenClawAPI["windowsNodeMxc"]["onApprovalResolved"]>[0];
  const nativeDialog = vi.fn();
  const persist = vi.fn();
  let chatEvent: Parameters<OpenClawAPI["chat"]["onEvent"]>[0];

  beforeEach(async () => {
    vi.useFakeTimers();
    window.matchMedia = vi.fn().mockReturnValue({
      matches: false,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    });
    window.openclaw = createBrowserOpenClawMock();
    vi.spyOn(window.openclaw.chat, "onEvent").mockImplementation((callback) => {
      chatEvent = callback;
      return vi.fn();
    });
    vi.spyOn(window.openclaw.chat, "onSessionUpdate").mockReturnValue(vi.fn());
    vi.spyOn(window.openclaw.windowsNodeMxc, "respondApproval").mockResolvedValue(undefined);
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
    vi.spyOn(window.openclaw.windowsNodeMxc, "onApprovalRequest").mockImplementation((callback) => {
      approvalRequest = callback;
      return vi.fn();
    });
    vi.spyOn(window.openclaw.windowsNodeMxc, "onApprovalResolved").mockImplementation(
      (callback) => {
        approvalResolved = callback;
        return vi.fn();
      },
    );
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

  it.skipIf(!process.env.MICROCLAW_OPENCLAW_TEST_PACKAGE_DIR)(
    "shows actual pinned session events through GatewayClient and main notifications before the terminal reply",
    async () => {
      const fixture = runPinnedSessionFixture();
      const ipc = new EventEmitter();
      vi.mocked(window.openclaw.chat.onSessionUpdate).mockImplementation((callback) => {
        const handler = (_event: unknown, payload: { sessionKey: string }) => callback(payload);
        ipc.on(CHAT_SESSION_UPDATE_CHANNEL, handler);
        return () => {
          ipc.removeListener(CHAT_SESSION_UPDATE_CHANNEL, handler);
        };
      });
      const observer = new GatewaySessionObserver(async (method, params) => {
        if (method === "sessions.subscribe") return fixture.catalog.payload;
        expect(method).toBe("sessions.messages.subscribe");
        expect(params).toEqual(fixture.params);
        return fixture.ack.payload;
      });
      await observer.select(fixture.params.key);
      await observer.connect();
      const client = Object.create(GatewayClient.prototype) as GatewayClient;
      Object.assign(client, {
        sessionObserver: observer,
        sessionTitleWaiters: new Map(),
        opts: {
          onEvent: (event: { event: string; payload?: unknown }) =>
            forwardGatewaySessionUpdate(event, (channel, payload) =>
              ipc.emit(channel, {}, payload),
            ),
        },
      });
      const receive = (event: unknown) => client["handleMessage"](JSON.stringify(event));
      const key = "agent:main:main";
      const runId = "external-phone-run";
      const history = vi.spyOn(window.openclaw.chat, "loadHistory").mockResolvedValue({
        sessionKey: key,
        messages: [],
        sessionInfo: { key, hasActiveRun: false, activeRunIds: [] },
      });
      const observe = vi.spyOn(window.openclaw.chat, "observeSession");
      const { gateway, chat } = await mountReadyApp();
      await flushPromises();
      const epoch = gateway.readinessEpoch;
      expect(observe).toHaveBeenCalledWith(key);
      history.mockResolvedValue(fixture.history);
      receive(fixture.events[0]);
      await flushPromises();
      expect(chat.messages).toHaveLength(1);
      expect(chat.messages[0].role).toBe("user");
      expect(chat.streaming).toBe(true);
      expect(chat.chatRunId).toBe(runId);
      approvalRequest(permission("phone-approval-wait"));
      await flushPromises();
      expect(chat.streaming).toBe(true);
      expect(chat.messages.some((message) => message.role === "assistant")).toBe(false);
      receive(fixture.events[1]);
      await flushPromises();
      expect(chat.messages).toHaveLength(1);
      const calls = history.mock.calls.length;
      receive({
        ...fixture.events[0],
        payload: { ...fixture.events[0].payload, sessionKey: "agent:other:main", agentId: "other" },
      });
      await flushPromises();
      expect(history).toHaveBeenCalledTimes(calls);
      expect(gateway.ready).toBe(true);
      expect(gateway.readinessEpoch).toBe(epoch);
      expect(wrapper.findComponent(GatewayLoading).exists()).toBe(false);
      history.mockResolvedValue({
        sessionKey: key,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: "Phone folder request" }],
            timestamp: 1000,
          },
          { role: "assistant", content: [{ type: "text", text: "Completed" }], timestamp: 2000 },
        ],
        sessionInfo: { key, hasActiveRun: false, activeRunIds: [] },
      });
      receive(fixture.events[1]);
      await flushPromises();
      expect(chat.messages).toHaveLength(2);
      expect(chat.streaming).toBe(false);
    },
    45_000,
  );

  it("routes actual external lifecycle through App+Pinia without a renderer send or global loader", async () => {
    const { gateway, chat } = await mountReadyApp();
    const key = "agent:main:main";
    chat.setMainSessionKey(key);
    const start = agentRunLifecycleEvent({
      stream: "lifecycle",
      sessionKey: key,
      runId: "wechat-run",
      data: { phase: "start" },
    });
    const end = agentRunLifecycleEvent({
      stream: "lifecycle",
      sessionKey: key,
      runId: "wechat-run",
      data: { phase: "end" },
    });
    if (!start || !end) throw new Error("Invalid lifecycle fixture");
    chatEvent(start);
    expect(chat.streaming).toBe(true);
    expect(chat.chatRunId).toBe("wechat-run");
    expect(chat.messages).toEqual([]);
    expect(gateway.ready).toBe(true);
    expect(wrapper.findComponent(GatewayLoading).exists()).toBe(false);
    chatEvent(end);
    await flushPromises();
    expect(chat.streaming).toBe(false);
    expect(chat.lastError).toBeNull();
    expect(gateway.ready).toBe(true);
  });

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
                consentScope: WEIXIN_NATIVE_DURABLE_CONSENT_SCOPE,
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

  function permission(
    id: string,
  ): NonNullable<Awaited<ReturnType<OpenClawAPI["windowsNodeMxc"]["getPendingApproval"]>>> {
    return {
      id,
      commandText: "hostname.exe",
      approvalLayer: "gateway",
      executable: "hostname.exe",
      arguments: [],
      canonicalCwd: "isolated-scratch:v1",
      agent: "main",
      declaredAccess: [],
      allowedDecisions: ["deny", "allow-once", "allow-always"],
      expiresAtUnixMs: Date.now() + 60_000,
    };
  }

  it.each(["wechat", "timeout"] as const)(
    "does not resurrect an approval resolved by %s while status is loading",
    async (origin) => {
      let finish!: (value: MxcStatus) => void;
      vi.mocked(window.openclaw.windowsNodeMxc.getStatus).mockImplementation(
        () =>
          new Promise<MxcStatus>((resolve) => {
            finish = resolve;
          }),
      );
      const { gateway } = await mountReadyApp();
      const epoch = gateway.readinessEpoch;
      approvalRequest(permission("status-race"));
      await flushPromises();
      approvalResolved({
        requestId: "status-race",
        approvalLayer: "gateway",
        status: "accepted",
        decision: "deny",
        origin,
      });
      finish(status);
      await flushPromises();
      expect(wrapper.findComponent(PermissionDialog).props("request")).toBeNull();
      expect(gateway.ready).toBe(true);
      expect(gateway.readinessEpoch).toBe(epoch);
    },
  );

  it.each(["resolved", "null", "generation"] as const)(
    "ignores a late initial %s snapshot without hiding a newer request",
    async (kind) => {
      let finish!: (value: ReturnType<typeof permission> | null) => void;
      vi.spyOn(window.openclaw.windowsNodeMxc, "getPendingApproval").mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const { gateway } = await mountReadyApp();
      const epoch = gateway.readinessEpoch;
      if (kind === "resolved")
        approvalResolved({
          requestId: "snapshot-race",
          status: "accepted",
          decision: "deny",
          origin: "timeout",
        });
      if (kind === "generation") {
        gateway.resetReady();
        serviceReady();
        await flushPromises();
      }
      approvalRequest(permission("newer"));
      await flushPromises();
      finish(kind === "null" ? null : permission("snapshot-race"));
      await flushPromises();
      expect(wrapper.findComponent(PermissionDialog).props("request")?.requestId).toBe("newer");
      wrapper.findComponent(PermissionDialog).vm.$emit("respond", "deny");
      await flushPromises();
      expect(wrapper.findComponent(PermissionDialog).props("request")).toBeNull();
      if (kind !== "generation") expect(gateway.readinessEpoch).toBe(epoch);
    },
  );

  it("targets closed requests by layer as well as ID and rejects late delivery updates", async () => {
    await mountReadyApp();
    approvalRequest(permission("shared-id"));
    approvalRequest({ ...permission("shared-id"), approvalLayer: "node" });
    await flushPromises();
    approvalResolved({
      requestId: "shared-id",
      approvalLayer: "gateway",
      status: "accepted",
      decision: "deny",
      origin: "timeout",
    });
    approvalRequest({
      ...permission("shared-id"),
      remoteDelivery: {
        state: "sent",
        reason: null,
        replyMode: "code-required",
        revision: 100,
      },
    });
    await flushPromises();
    expect(wrapper.findComponent(PermissionDialog).props("request")).toMatchObject({
      requestId: "shared-id",
      approvalLayer: "node",
    });
    wrapper.findComponent(PermissionDialog).vm.$emit("respond", "deny");
    await flushPromises();
    approvalRequest({ ...permission("shared-id"), approvalLayer: "node" });
    await flushPromises();
    expect(wrapper.findComponent(PermissionDialog).props("request")).toBeNull();
  });

  it("updates one pending request and dismisses only the exact remotely resolved request without resetting readiness", async () => {
    const { gateway } = await mountReadyApp();
    const epoch = gateway.readinessEpoch;
    const first = permission("first");
    await approvalRequest(first);
    await approvalRequest(permission("second"));
    await flushPromises();
    expect(wrapper.findComponent(PermissionDialog).props("request")?.requestId).toBe("first");
    await approvalRequest({
      ...first,
      remoteDelivery: { state: "sent", reason: null, replyMode: "code-required", revision: 2 },
    });
    await flushPromises();
    expect(wrapper.findComponent(PermissionDialog).props("request")).toMatchObject({
      requestId: "first",
      expiresAtUnixMs: first.expiresAtUnixMs,
      remoteDelivery: { state: "sent", revision: 2 },
    });
    approvalResolved({
      requestId: "first",
      status: "accepted",
      decision: "allow-always",
      origin: "wechat",
      durableSaved: true,
    });
    await flushPromises();
    expect(wrapper.findComponent(PermissionDialog).props("request")?.requestId).toBe("second");
    approvalResolved({
      requestId: "first",
      status: "accepted",
      decision: "deny",
      origin: "timeout",
    });
    await flushPromises();
    expect(wrapper.findComponent(PermissionDialog).props("request")?.requestId).toBe("second");
    expect(gateway.ready).toBe(true);
    expect(gateway.readinessEpoch).toBe(epoch);
  });

  it("does not pop the next permission or show a stale IPC error when main resolution wins the Desktop response race", async () => {
    await mountReadyApp();
    const error = vi.spyOn(ElMessage, "error");
    await approvalRequest(permission("race-first"));
    await approvalRequest(permission("race-second"));
    const respond = vi
      .spyOn(window.openclaw.windowsNodeMxc, "respondApproval")
      .mockImplementation(async () => {
        approvalResolved({
          requestId: "race-first",
          status: "accepted",
          decision: "deny",
          origin: "timeout",
        });
        throw new Error("This approval is no longer pending");
      });
    wrapper.findComponent(PermissionDialog).vm.$emit("respond", "allow-once");
    await flushPromises();
    expect(respond).toHaveBeenCalledExactlyOnceWith({
      requestId: "race-first",
      decision: "allow-once",
    });
    expect(wrapper.findComponent(PermissionDialog).props("request")?.requestId).toBe("race-second");
    expect(error).not.toHaveBeenCalledWith("This approval is no longer pending");
  });
});
