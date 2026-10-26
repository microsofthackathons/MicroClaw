import { createPinia } from "pinia";
import { isProxy } from "vue";
import { flushPromises, shallowMount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElMessage, ElMessageBox } from "element-plus";
import { setLocale } from "@/i18n";
import { useGatewayStore } from "@/stores/gateway";
import { useChatStore } from "@/stores/chat";
import MxcCapabilityConsentDialog from "@/components/MxcCapabilityConsentDialog.vue";
import SettingsView from "./SettingsView.vue";
import { createBrowserOpenClawMock } from "@/browser-openclaw";

const routeState = vi.hoisted(() => ({ section: "skills" }));
vi.mock("vue-router", () => ({
  useRoute: () => ({ params: { section: routeState.section } }),
}));

describe("SettingsView", () => {
  type WindowsNodeMxcStatus = Awaited<ReturnType<typeof window.openclaw.windowsNodeMxc.getStatus>>;
  const exportGatewayLogs = vi.fn();
  const openExternal = vi.fn();
  const getWindowsNodeMxcStatus = vi.fn();
  const setWindowsNodeMxcEnabled = vi.fn();
  const stageFolder = vi.fn();
  const setFolderPolicy = vi.fn();
  const validateFolderPolicy = vi.fn();
  const applyFolderPolicy = vi.fn();

  const localNode = {
    id: "node-local",
    displayName: "Local Windows node",
    platform: "windows",
    connected: true,
    paired: true,
    remoteIp: "127.0.0.1",
    commands: [
      "system.run",
      "system.run.readiness",
      "system.run.prepare",
      "system.which",
      "system.run.cwd-policy",
    ],
  };
  const ambientCategories: Array<
    NonNullable<WindowsNodeMxcStatus["ambientAccess"]>["entries"][number]["category"]
  > = [
    "desktop",
    "documents",
    "downloads",
    "microclaw-state",
    "openclaw-state",
    "openclaw-roaming-state",
    "ssh",
    "gnupg",
    "aws",
    "azure",
    "kube",
    "gcloud",
    "windows-credentials",
    "powershell-history",
    "browser-chrome",
    "browser-edge",
    "browser-brave",
    "browser-firefox",
  ];

  const ambientAccess = (
    overrides: Partial<
      Record<
        NonNullable<WindowsNodeMxcStatus["ambientAccess"]>["entries"][number]["category"],
        NonNullable<WindowsNodeMxcStatus["ambientAccess"]>["entries"][number]["status"]
      >
    > = {},
  ): NonNullable<WindowsNodeMxcStatus["ambientAccess"]> => ({
    contract: "microclaw.windows-node-mxc-ambient-access.v1",
    hash: "ambient-hash-1",
    checkedAt: new Date(0).toISOString(),
    entries: ambientCategories.map((category) => ({
      category,
      status: overrides[category] ?? "denied",
    })),
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const status = (
    selectedNodeId: string,
    nodes = [localNode, { ...localNode, id: "node-other" }],
  ): WindowsNodeMxcStatus => ({
    requestedMode: "full",
    effectiveStrength: "off",
    effectiveTier: null,
    desiredEnabled: true,
    effectiveEnabled: false,
    hooks: {
      requestedExternalEnabled: false,
      requestedInternalEnabled: false,
      effectiveExternalEnabled: false,
      effectiveInternalEnabled: false,
      pausedByMxc: false,
    },
    canvas: {
      state: "paused",
      commandCount: 8,
      nativeA2uiOnly: true,
      localFilesAllowed: false,
    },
    lifecycleState: {
      phase: "locked",
      detail: null,
      updatedAt: new Date(0).toISOString(),
    },
    folderPolicyRecovery: null,
    durableApprovals: { records: [], invalidRecords: 0, warning: null },
    selectedNodeId,
    settingsPath: "",
    companionPath: "",
    companionInstalled: true,
    settingsLoaded: true,
    settingsFingerprint: "settings-fingerprint-1",
    nodes,
    selectedNode: nodes.find((node) => node.id === selectedNodeId) ?? null,
    helperRevision: "fc9add75eda78daf548d80a55ffb64e63b159961",
    mxcRuntimeVersion: "0.7.0",
    cwdPolicyContract: "microclaw.windows-cwd.v1",
    cwdAttestationReady: true,
    activationLeaseContract: "microclaw.windows-activation.v1",
    gatewayGeneration: "generation-1",
    activationLeaseMode: null,
    activationLeaseExpiresAt: null,
    gatewayPolicyState: "locked",
    gatewayPolicyReady: true,
    effectiveToolsReady: true,
    effectiveToolsState: "verified",
    strictFallbackEffective: false,
    allowWindowsUiEffective: false,
    folders: [],
    durableApprovalsPresent: false,
    probe: {
      outcome: "supported",
      tier: "appcontainer-dacl",
      needsDaclAugmentation: true,
      degraded: true,
      warnings: [],
      probes: {
        baseContainerApiPresent: false,
        bfscfgPresent: false,
        bfsCompiledIn: false,
      },
      reason: null,
    },
    fullAvailability: {
      available: true,
      summary: "Full containment is available.",
      blockers: [],
      remediation: [],
    },
    limitedAvailability: {
      available: true,
      summary: "Limited containment is available.",
      blockers: [],
      remediation: [],
    },
    ambientAccess: null,
    smoke: null,
    blockers: [],
    warnings: [],
    remediation: [],
  });
  beforeEach(() => {
    routeState.section = "skills";
    setLocale("en-US");
    getWindowsNodeMxcStatus.mockReset().mockResolvedValue(status("diagnostic-unpaired-local-node"));
    setWindowsNodeMxcEnabled
      .mockReset()
      .mockImplementation(
        async ({ requestedMode }: { requestedMode: WindowsNodeMxcStatus["requestedMode"] }) => ({
          ...status("node-local"),
          requestedMode,
          desiredEnabled: requestedMode !== "off",
        }),
      );
    stageFolder.mockReset().mockResolvedValue({
      ok: false,
      canceled: true,
      dirs: { rw: [], ro: [] },
    });
    setFolderPolicy.mockReset().mockImplementation(async (draft) => draft);
    validateFolderPolicy.mockReset().mockImplementation(async (draft) => draft);
    applyFolderPolicy.mockReset();
    window.openclaw = {
      model: createBrowserOpenClawMock().model,
      config: {
        read: vi.fn().mockResolvedValue(null),
      },
      settings: {
        get: vi.fn().mockResolvedValue({
          language: "en-US",
          autoStart: false,
          minimizeToTray: false,
          themeMode: "light",
          privacyLevel: "basic",
        }),
        set: vi.fn().mockResolvedValue(undefined),
      },
      logs: {
        exportGateway: exportGatewayLogs,
      },
      shell: {
        openExternal,
      },
      windowsNodeMxc: {
        getStatus: getWindowsNodeMxcStatus,
        setEnabled: setWindowsNodeMxcEnabled,
        validateFolderPolicy,
        applyFolderPolicy,
        stageFolder,
        setFolderPolicy,
        getFolders: vi.fn().mockResolvedValue({ rw: [], ro: [] }),
        listDurableApprovals: vi.fn().mockResolvedValue([]),
        revokeDurableApproval: vi.fn().mockResolvedValue([]),
        revokeAllDurableApprovals: vi.fn().mockResolvedValue([]),
        respondApproval: vi.fn(),
        onApprovalRequest: vi.fn().mockReturnValue(() => undefined),
        onLifecycleState: vi.fn().mockReturnValue(() => undefined),
      },
    } as unknown as typeof window.openclaw;
    exportGatewayLogs.mockReset().mockResolvedValue({
      canceled: false,
      filePath: "C:\\Logs\\gateway.log",
    });
    openExternal.mockReset().mockResolvedValue(undefined);
  });

  it("hides the development-only Skills section by default", async () => {
    const wrapper = shallowMount(SettingsView, {
      global: {
        plugins: [createPinia()],
      },
    });

    await flushPromises();

    expect(wrapper.find(".settings-content--skills").exists()).toBe(false);
    expect(wrapper.findAll(".settings-menu-item").some((item) => item.text() === "Skills")).toBe(
      false,
    );
    expect(wrapper.find(".settings-menu-item.active").text()).toBe("General");
  });

  it("shows Gateway status and log export at the end of General", async () => {
    const pinia = createPinia();
    useGatewayStore(pinia).addLog("[info] Gateway started");
    const wrapper = shallowMount(SettingsView, {
      global: {
        plugins: [pinia],
      },
    });

    await flushPromises();

    const menuItems = wrapper.findAll(".settings-menu-item");
    await menuItems.find((item) => item.text() === "General")!.trigger("click");
    expect(wrapper.find(".settings-content").text()).toContain("Gateway");
    expect(wrapper.find(".settings-content").text()).toContain("Connection status");
    expect(wrapper.find(".settings-content").text()).toContain("Logs");
    expect(wrapper.find(".settings-content").text()).toContain("Gateway logs");
    expect(menuItems.some((item) => item.text() === "Gateway")).toBe(false);

    await wrapper
      .findAll("el-button")
      .find((button) => button.text() === "Export")!
      .trigger("click");
    await flushPromises();

    expect(exportGatewayLogs).toHaveBeenCalledWith(["[info] Gateway started"]);
  });

  it("keeps all modes visible and loads Security independently of general settings", async () => {
    routeState.section = "security";
    vi.mocked(window.openclaw.settings.get).mockReturnValueOnce(new Promise(() => {}));
    let resolveStatus!: (value: WindowsNodeMxcStatus) => void;
    getWindowsNodeMxcStatus.mockReturnValueOnce(
      new Promise<WindowsNodeMxcStatus>((resolve) => {
        resolveStatus = resolve;
      }),
    );
    const wrapper = shallowMount(SettingsView, {
      global: { plugins: [createPinia()] },
    });
    await flushPromises();

    expect(getWindowsNodeMxcStatus).toHaveBeenCalledTimes(1);
    expect(wrapper.find('[data-testid="mxc-status-loading"]').exists()).toBe(true);
    for (const mode of ["off", "limited", "full"]) {
      expect(wrapper.find(`[data-testid="mxc-mode-${mode}"]`).exists()).toBe(true);
      expect(wrapper.find(`[data-testid="mxc-select-${mode}"]`).attributes("disabled")).toBe(
        "true",
      );
    }
    expect(wrapper.find(".mxc-mode-card.selected").exists()).toBe(false);

    resolveStatus({
      ...status("node-local"),
      requestedMode: "off",
      desiredEnabled: false,
    });
    await flushPromises();

    expect(wrapper.find('[data-testid="mxc-status-loading"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="mxc-mode-off"]').classes()).toContain("selected");
    expect(wrapper.find('[data-testid="mxc-select-full"]').attributes("disabled")).toBe("false");
    expect(wrapper.find('[data-testid="mxc-select-limited"]').attributes("disabled")).toBe("false");
    expect(setWindowsNodeMxcEnabled).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("shows a persistent status error and retries without hiding the mode controls", async () => {
    routeState.section = "security";
    getWindowsNodeMxcStatus
      .mockRejectedValueOnce(new Error("Native status inspection failed"))
      .mockResolvedValueOnce({
        ...status("node-local"),
        requestedMode: "off",
        desiredEnabled: false,
      });
    const errorMessage = vi.spyOn(ElMessage, "error");
    const wrapper = shallowMount(SettingsView, {
      global: { plugins: [createPinia()] },
    });
    await flushPromises();

    expect(wrapper.find('[data-testid="mxc-status-error"]').text()).toContain(
      "Native status inspection failed",
    );
    expect(errorMessage).toHaveBeenCalledWith("Native status inspection failed");
    expect(wrapper.findAll(".mxc-mode-card")).toHaveLength(3);
    expect(wrapper.find('[data-testid="mxc-select-full"]').attributes("disabled")).toBe("true");
    expect(setWindowsNodeMxcEnabled).not.toHaveBeenCalled();

    await wrapper.find('[data-testid="mxc-status-retry"]').trigger("click");
    await flushPromises();

    expect(getWindowsNodeMxcStatus).toHaveBeenCalledTimes(2);
    expect(wrapper.find('[data-testid="mxc-status-error"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="mxc-mode-off"]').classes()).toContain("selected");
    expect(setWindowsNodeMxcEnabled).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("shows the deterministic app-owned node without a manual selector", async () => {
    routeState.section = "security";
    getWindowsNodeMxcStatus.mockResolvedValueOnce(status("node-local"));
    const wrapper = shallowMount(SettingsView, {
      global: {
        plugins: [createPinia()],
      },
    });

    await flushPromises();
    await wrapper.find('[data-testid="mxc-technical-details-toggle"]').trigger("click");
    expect(wrapper.find('[data-testid="mxc-technical-details"]').text()).toContain(
      "Local Windows node (node-local)",
    );
    expect(wrapper.find(".mxc-card").find("el-select").exists()).toBe(false);
    expect(setWindowsNodeMxcEnabled).not.toHaveBeenCalled();
  });

  it("does not expose a standalone WeChat remote approval settings card", async () => {
    routeState.section = "security";
    const wrapper = shallowMount(SettingsView, {
      global: { plugins: [createPinia()] },
    });
    await flushPromises();

    expect(wrapper.find('[data-testid="weixin-remote-approval"]').exists()).toBe(false);
  });

  it("keeps technical MXC details collapsed on a fresh Settings view", async () => {
    routeState.section = "security";
    getWindowsNodeMxcStatus.mockResolvedValueOnce({
      ...status("node-local"),
      effectiveStrength: "full",
      effectiveTier: "base-container",
      effectiveEnabled: true,
      lifecycleState: {
        phase: "active",
        detail: null,
        updatedAt: new Date(0).toISOString(),
      },
      activationLeaseMode: "active",
      gatewayPolicyState: "active",
      strictFallbackEffective: true,
    });
    const wrapper = shallowMount(SettingsView, {
      global: { plugins: [createPinia()] },
    });

    await flushPromises();

    const toggle = wrapper.find('[data-testid="mxc-technical-details-toggle"]');
    expect(toggle.attributes("aria-expanded")).toBe("false");
    expect(wrapper.find('[data-testid="mxc-technical-details"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="mxc-status-summary"]').text()).toBe(
      "Full containment — Active",
    );
    expect(wrapper.find('[data-testid="mxc-add-rw"]').exists()).toBe(true);
    expect(wrapper.find(".mxc-card").text()).toContain("Remembered exact commands");
    expect(wrapper.find(".mxc-card").text()).not.toContain("Gateway generation");
  });

  it("shows backed-up requested Hooks as paused while MXC is active", async () => {
    routeState.section = "security";
    getWindowsNodeMxcStatus.mockResolvedValueOnce({
      ...status("node-local"),
      hooks: {
        requestedExternalEnabled: true,
        requestedInternalEnabled: true,
        effectiveExternalEnabled: false,
        effectiveInternalEnabled: false,
        pausedByMxc: true,
      },
    });
    const wrapper = shallowMount(SettingsView, {
      global: { plugins: [createPinia()] },
    });

    await flushPromises();

    expect(wrapper.find('[data-testid="mxc-hooks-paused"]').text()).toBe(
      "Webhooks and internal hooks stay paused in MXC Locked and Active states. Requests are rejected, internal events are dropped, and neither is replayed.",
    );
  });

  it("localizes the fail-closed Hooks pause and no-replay status", async () => {
    routeState.section = "security";
    setLocale("zh-CN");
    getWindowsNodeMxcStatus.mockResolvedValueOnce({
      ...status("node-local"),
      hooks: {
        requestedExternalEnabled: true,
        requestedInternalEnabled: false,
        effectiveExternalEnabled: false,
        effectiveInternalEnabled: false,
        pausedByMxc: true,
      },
    });
    const wrapper = shallowMount(SettingsView, {
      global: { plugins: [createPinia()] },
    });

    await flushPromises();

    expect(wrapper.find('[data-testid="mxc-hooks-paused"]').text()).toBe(
      "MXC 处于已锁定或已激活状态时，Webhook 始终暂停。请求会被拒绝且不会重放。",
    );
  });

  it("expands and collapses the accessible MXC technical disclosure", async () => {
    routeState.section = "security";
    getWindowsNodeMxcStatus.mockResolvedValueOnce(status("node-local"));
    const wrapper = shallowMount(SettingsView, {
      global: { plugins: [createPinia()] },
    });
    await flushPromises();

    const toggle = wrapper.find('[data-testid="mxc-technical-details-toggle"]');
    expect(toggle.attributes("aria-controls")).toBe("windows-node-mxc-technical-details");

    await toggle.trigger("click");
    const details = wrapper.find('[data-testid="mxc-technical-details"]');
    expect(toggle.attributes("aria-expanded")).toBe("true");
    expect(details.attributes("role")).toBe("region");
    expect(details.text()).toContain("Policy lifecycle");
    expect(details.text()).toContain("Gateway generation");
    expect(details.text()).toContain("settings-fingerprint-1");
    expect(details.text()).toContain("microclaw.windows-cwd.v1");
    expect(details.text()).toContain("Contained child-process smoke");

    await toggle.trigger("click");
    expect(toggle.attributes("aria-expanded")).toBe("false");
    expect(wrapper.find('[data-testid="mxc-technical-details"]').exists()).toBe(false);
  });

  it("keeps action-required failures and essential controls outside technical details", async () => {
    routeState.section = "security";
    getWindowsNodeMxcStatus.mockResolvedValueOnce({
      ...status("node-local"),
      lifecycleState: {
        phase: "failed",
        detail: "The bundled node disconnected.",
        updatedAt: new Date(0).toISOString(),
      },
      blockers: ["Reconnect the exact bundled node before retrying."],
    });
    const wrapper = shallowMount(SettingsView, {
      global: { plugins: [createPinia()] },
    });

    await flushPromises();

    expect(wrapper.find('[data-testid="mxc-technical-details"]').exists()).toBe(false);
    expect(wrapper.find(".mxc-card").text()).toContain("Action required");
    expect(wrapper.find(".mxc-card").text()).toContain("The bundled node disconnected.");
    expect(wrapper.find(".section").text()).toContain(
      "Reconnect the exact bundled node before retrying.",
    );
    expect(wrapper.find('[data-testid="mxc-add-ro"]').exists()).toBe(true);
    expect(wrapper.find(".mxc-card").text()).toContain("No exact commands are remembered.");
  });

  it("does not expose manual readiness or activation actions", async () => {
    routeState.section = "security";
    const wrapper = shallowMount(SettingsView, {
      global: {
        plugins: [createPinia()],
      },
    });

    await flushPromises();
    const text = wrapper.find(".mxc-card").text();
    expect(text).not.toContain("Refresh readiness");
    expect(text).not.toContain("Run contained smoke");
    expect(text).not.toContain("Activate verified route");
  });

  it("shows a compact active status and keeps raw attestation collapsed by default", async () => {
    routeState.section = "security";
    getWindowsNodeMxcStatus.mockResolvedValueOnce({
      ...status("node-local"),
      requestedMode: "limited-dacl",
      effectiveStrength: "limited-dacl",
      effectiveTier: "appcontainer-dacl",
      effectiveEnabled: true,
      canvas: {
        state: "active",
        commandCount: 8,
        nativeA2uiOnly: true,
        localFilesAllowed: false,
      },
      ambientAccess: ambientAccess(),
      lifecycleState: {
        phase: "active",
        detail: null,
        updatedAt: new Date(0).toISOString(),
      },
    });
    const wrapper = shallowMount(SettingsView, {
      global: { plugins: [createPinia()] },
    });

    await flushPromises();

    expect(wrapper.find('[data-testid="mxc-mode-full"]').text()).toContain("Full containment");
    expect(wrapper.find('[data-testid="mxc-mode-limited"]').text()).toContain(
      "Limited containment (DACL)",
    );
    expect(wrapper.find('[data-testid="mxc-mode-off"]').text()).toContain(
      "without an execution sandbox",
    );
    expect(wrapper.find('[data-testid="mxc-status-summary"]').text()).toBe(
      "Limited containment (DACL) — Active",
    );
    expect(wrapper.find('[data-testid="mxc-canvas-status"]').text()).toContain(
      "Canvas Phase 1 — Active",
    );
    expect(wrapper.find('[data-testid="mxc-technical-details"]').exists()).toBe(false);
    expect(wrapper.find(".mxc-card").text()).not.toContain(
      "Requested modeLimited containment (DACL)",
    );

    await wrapper.find('[data-testid="mxc-technical-details-toggle"]').trigger("click");
    const diagnostics = wrapper.find('[data-testid="mxc-technical-details"]');
    expect(diagnostics.text()).toContain("Requested modeLimited containment (DACL)");
    expect(diagnostics.text()).toContain("Attested effective strengthLimited containment (DACL)");
    expect(diagnostics.text()).toContain("Attested effective tierappcontainer-dacl");
    expect(wrapper.find('[data-testid="mxc-technical-details-toggle"]').text()).toContain(
      "Security diagnostics",
    );
  });

  it("shows Canvas as paused while requested MXC remains locked", async () => {
    routeState.section = "security";
    const wrapper = shallowMount(SettingsView, {
      global: { plugins: [createPinia()] },
    });

    await flushPromises();

    expect(wrapper.find('[data-testid="mxc-canvas-status"]').text()).toContain(
      "unavailable until MXC reaches Active",
    );
  });

  it("keeps Full and Off status summaries concise and truthful", async () => {
    routeState.section = "security";
    getWindowsNodeMxcStatus
      .mockResolvedValueOnce({
        ...status("node-local"),
        effectiveStrength: "full",
        effectiveTier: "base-container",
        effectiveEnabled: true,
        lifecycleState: {
          phase: "active",
          detail: null,
          updatedAt: new Date(0).toISOString(),
        },
      })
      .mockResolvedValueOnce({
        ...status("node-local"),
        requestedMode: "off",
        desiredEnabled: false,
      });
    const full = shallowMount(SettingsView, {
      global: { plugins: [createPinia()] },
    });
    await flushPromises();
    expect(full.find('[data-testid="mxc-status-summary"]').text()).toBe(
      "Full containment — Active",
    );

    full.unmount();
    const off = shallowMount(SettingsView, {
      global: { plugins: [createPinia()] },
    });
    await flushPromises();
    expect(off.find('[data-testid="mxc-status-summary"]').text()).toBe("Containment — Off");
  });

  it("leaves readiness unchanged until main-process lifecycle events gate the transition", async () => {
    routeState.section = "security";
    const pinia = createPinia();
    const wrapper = shallowMount(SettingsView, {
      global: {
        plugins: [pinia],
      },
    });
    await flushPromises();
    const gateway = useGatewayStore(pinia);
    const chat = useChatStore(pinia);
    gateway.markReady();
    chat.wsConnected = true;

    await wrapper.find('[data-testid="mxc-select-off"]').trigger("click");
    await flushPromises();

    expect(gateway.ready).toBe(true);
    expect(chat.wsConnected).toBe(true);
    expect(setWindowsNodeMxcEnabled).toHaveBeenCalledWith({ requestedMode: "off" });
  });

  it("keeps the standard route ready and settles when main-process validation rejects enablement", async () => {
    routeState.section = "security";
    getWindowsNodeMxcStatus.mockResolvedValue({
      ...status("node-local"),
      requestedMode: "off",
      desiredEnabled: false,
    });
    setWindowsNodeMxcEnabled.mockRejectedValueOnce(new Error("exact backend unavailable"));
    const errorMessage = vi.spyOn(ElMessage, "error");
    const pinia = createPinia();
    const wrapper = shallowMount(SettingsView, {
      global: {
        plugins: [pinia],
      },
    });
    await flushPromises();
    const gateway = useGatewayStore(pinia);
    const chat = useChatStore(pinia);
    gateway.markReady();
    chat.wsConnected = true;

    await wrapper.find('[data-testid="mxc-select-full"]').trigger("click");
    expect(setWindowsNodeMxcEnabled).not.toHaveBeenCalled();
    wrapper.findComponent(MxcCapabilityConsentDialog).vm.$emit("accept");
    await flushPromises();

    expect(gateway.ready).toBe(true);
    expect(chat.wsConnected).toBe(true);
    expect(setWindowsNodeMxcEnabled).toHaveBeenCalledTimes(1);
    expect(errorMessage).toHaveBeenCalledWith("exact backend unavailable");

    await wrapper.find('[data-testid="mxc-select-full"]').trigger("click");
    expect(wrapper.findComponent(MxcCapabilityConsentDialog).props("modelValue")).toBe(true);
  });

  it("requires explicit acknowledgement before enabling Limited containment", async () => {
    routeState.section = "security";
    getWindowsNodeMxcStatus.mockResolvedValue({
      ...status("node-local"),
      requestedMode: "full",
      desiredEnabled: true,
    });
    const wrapper = shallowMount(SettingsView, {
      global: {
        plugins: [createPinia()],
        stubs: {
          "el-dialog": {
            props: ["modelValue"],
            template: '<div v-if="modelValue"><slot/><slot name="footer"/></div>',
          },
        },
      },
    });
    await flushPromises();

    await wrapper.find('[data-testid="mxc-select-limited"]').trigger("click");
    expect(wrapper.findComponent(MxcCapabilityConsentDialog).props("targetMode")).toBe(
      "limited-dacl",
    );
    expect(setWindowsNodeMxcEnabled).not.toHaveBeenCalled();
    wrapper.findComponent(MxcCapabilityConsentDialog).vm.$emit("accept");
    await wrapper.vm.$nextTick();

    const confirm = wrapper.find('[data-testid="mxc-confirm-limited"]');
    expect(confirm.attributes("disabled")).toBe("true");
    await wrapper.find('[data-testid="mxc-limited-ack-checkbox"]').setValue(true);
    await confirm.trigger("click");
    await flushPromises();

    expect(setWindowsNodeMxcEnabled).toHaveBeenCalledWith({
      requestedMode: "limited-dacl",
      acknowledgeLimitedFilesystem: true,
    });
  });

  it("cancels capability disclosure without changing mode, UI selection, or lifecycle state", async () => {
    routeState.section = "security";
    getWindowsNodeMxcStatus.mockResolvedValue({
      ...status("node-local"),
      requestedMode: "off",
      desiredEnabled: false,
    });
    const pinia = createPinia();
    const wrapper = shallowMount(SettingsView, {
      global: { plugins: [pinia] },
    });
    await flushPromises();
    const gateway = useGatewayStore(pinia);
    const chat = useChatStore(pinia);
    gateway.markReady();
    chat.wsConnected = true;

    await wrapper.find('[data-testid="mxc-select-full"]').trigger("click");
    const consent = wrapper.findComponent(MxcCapabilityConsentDialog);
    expect(consent.props("modelValue")).toBe(true);
    expect(consent.props("targetMode")).toBe("full");
    expect(wrapper.find('[data-testid="mxc-mode-off"]').classes()).toContain("selected");
    expect(setWindowsNodeMxcEnabled).not.toHaveBeenCalled();

    consent.vm.$emit("cancel");
    await wrapper.vm.$nextTick();

    expect(consent.props("modelValue")).toBe(false);
    expect(wrapper.find('[data-testid="mxc-mode-off"]').classes()).toContain("selected");
    expect(gateway.ready).toBe(true);
    expect(chat.wsConnected).toBe(true);
    expect(setWindowsNodeMxcEnabled).not.toHaveBeenCalled();
  });

  it("sends only a clone-safe mode request and leaves WeChat consent to main", async () => {
    routeState.section = "security";
    getWindowsNodeMxcStatus.mockResolvedValue({
      ...status("node-local"),
      requestedMode: "off",
      desiredEnabled: false,
    });
    setWindowsNodeMxcEnabled.mockImplementation(async (params) => {
      expect(isProxy(params)).toBe(false);
      expect(structuredClone(params)).toEqual({ requestedMode: "full" });
      return status("node-local");
    });
    const wrapper = shallowMount(SettingsView, {
      global: { plugins: [createPinia()] },
    });
    await flushPromises();

    await wrapper.find('[data-testid="mxc-select-full"]').trigger("click");
    wrapper.findComponent(MxcCapabilityConsentDialog).vm.$emit("accept");
    await flushPromises();

    expect(setWindowsNodeMxcEnabled).toHaveBeenCalledExactlyOnceWith({ requestedMode: "full" });
    expect(wrapper.text()).not.toContain("Remote command approval");
    wrapper.unmount();
  });

  it("sends only mode and explicit Limited acknowledgement, never a WeChat owner", async () => {
    routeState.section = "security";
    getWindowsNodeMxcStatus.mockResolvedValue({
      ...status("node-local"),
      requestedMode: "off",
      desiredEnabled: false,
    });
    const wrapper = shallowMount(SettingsView, {
      global: {
        plugins: [createPinia()],
        stubs: {
          "el-dialog": {
            props: ["modelValue"],
            template: '<div v-if="modelValue"><slot/><slot name="footer"/></div>',
          },
        },
      },
    });
    await flushPromises();

    await wrapper.find('[data-testid="mxc-select-limited"]').trigger("click");
    wrapper.findComponent(MxcCapabilityConsentDialog).vm.$emit("accept");
    await wrapper.vm.$nextTick();
    await wrapper.find('[data-testid="mxc-limited-ack-checkbox"]').setValue(true);
    await wrapper.find('[data-testid="mxc-confirm-limited"]').trigger("click");
    await flushPromises();

    expect(setWindowsNodeMxcEnabled).toHaveBeenCalledWith({
      requestedMode: "limited-dacl",
      acknowledgeLimitedFilesystem: true,
    });
    wrapper.unmount();
  });

  it("deduplicates disclosure requests and double-submit before applying Full once", async () => {
    routeState.section = "security";
    getWindowsNodeMxcStatus.mockResolvedValue({
      ...status("node-local"),
      requestedMode: "off",
      desiredEnabled: false,
    });
    let releaseSetEnabled!: () => void;
    setWindowsNodeMxcEnabled.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        releaseSetEnabled = resolve;
      }),
    );
    const wrapper = shallowMount(SettingsView, {
      global: { plugins: [createPinia()] },
    });
    await flushPromises();

    const full = wrapper.find('[data-testid="mxc-select-full"]');
    await full.trigger("click");
    await full.trigger("click");
    const consent = wrapper.findComponent(MxcCapabilityConsentDialog);
    expect(consent.props("targetMode")).toBe("full");

    consent.vm.$emit("accept");
    consent.vm.$emit("accept");
    await Promise.resolve();
    expect(setWindowsNodeMxcEnabled).toHaveBeenCalledTimes(1);

    releaseSetEnabled();
    await flushPromises();
    expect(setWindowsNodeMxcEnabled).toHaveBeenCalledTimes(1);
    expect(setWindowsNodeMxcEnabled).toHaveBeenCalledWith({
      requestedMode: "full",
    });
  });

  it("prompts and applies an explicit Limited to Full switch", async () => {
    routeState.section = "security";
    getWindowsNodeMxcStatus.mockResolvedValue({
      ...status("node-local"),
      requestedMode: "limited-dacl",
      effectiveStrength: "limited-dacl",
      desiredEnabled: true,
    });
    const wrapper = shallowMount(SettingsView, {
      global: { plugins: [createPinia()] },
    });
    await flushPromises();

    await wrapper.find('[data-testid="mxc-select-full"]').trigger("click");
    const consent = wrapper.findComponent(MxcCapabilityConsentDialog);
    expect(consent.props("targetMode")).toBe("full");
    consent.vm.$emit("accept");
    await flushPromises();

    expect(setWindowsNodeMxcEnabled).toHaveBeenCalledWith({ requestedMode: "full" });
  });

  it("does not prompt during status refresh or internal recovery updates", async () => {
    routeState.section = "security";
    getWindowsNodeMxcStatus.mockResolvedValue({
      ...status("node-local"),
      requestedMode: "full",
      effectiveStrength: "off",
      lifecycleState: {
        phase: "locked",
        detail: "Recovered fail closed",
        updatedAt: new Date().toISOString(),
      },
    });
    const wrapper = shallowMount(SettingsView, {
      global: { plugins: [createPinia()] },
    });
    await flushPromises();

    window.dispatchEvent(new Event("focus"));
    await flushPromises();

    expect(wrapper.findComponent(MxcCapabilityConsentDialog).props("modelValue")).toBe(false);
    expect(setWindowsNodeMxcEnabled).not.toHaveBeenCalled();
    expect(wrapper.find('[data-testid="mxc-status-summary"]').text()).toContain("Full containment");
  });

  it("disables unavailable Full containment and shows exact availability guidance", async () => {
    routeState.section = "security";
    getWindowsNodeMxcStatus.mockResolvedValueOnce({
      ...status("node-local"),
      requestedMode: "off",
      desiredEnabled: false,
      fullAvailability: {
        available: false,
        summary: "Base Container isolation is unavailable.",
        blockers: ["BFS support is not compiled in."],
        remediation: ["Install a full MXC runtime build."],
      },
    });
    const wrapper = shallowMount(SettingsView, {
      global: { plugins: [createPinia()] },
    });
    await flushPromises();

    const full = wrapper.find('[data-testid="mxc-mode-full"]');
    expect(full.text()).toContain("Base Container isolation is unavailable.");
    expect(full.text()).toContain("BFS support is not compiled in.");
    expect(full.text()).toContain("Install a full MXC runtime build.");
    expect(full.find('[data-testid="mxc-select-full"]').attributes("disabled")).toBe("true");
  });

  it("shows empty global RO and RW folder lists while MXC is disabled", async () => {
    routeState.section = "security";
    getWindowsNodeMxcStatus.mockResolvedValueOnce({
      ...status("node-local"),
      requestedMode: "off",
      desiredEnabled: false,
    });
    const wrapper = shallowMount(SettingsView, {
      global: { plugins: [createPinia()] },
    });

    await flushPromises();

    const policy = wrapper.find(".mxc-folder-policy");
    expect(policy.text()).toContain("Configured MXC folders");
    expect(policy.text()).toContain("used when Full or Limited containment is selected");
    expect(policy.findAll(".dir-empty")).toHaveLength(2);
    expect(policy.find('[data-testid="mxc-add-rw"]').attributes("disabled")).toBe("false");
    expect(policy.text()).not.toContain("Disable Windows Node + MXC");
    expect(wrapper.find('[data-testid="mxc-ambient-compact"]').exists()).toBe(false);
  });

  it("does not show Limited ambient attestation for Full containment", async () => {
    routeState.section = "security";
    const wrapper = shallowMount(SettingsView, {
      global: { plugins: [createPinia()] },
    });

    await flushPromises();

    expect(wrapper.find('[data-testid="mxc-ambient-compact"]').exists()).toBe(false);
  });

  it("summarizes all-denied ambient access separately from selected folder grants", async () => {
    routeState.section = "security";
    getWindowsNodeMxcStatus.mockResolvedValueOnce({
      ...status("node-local"),
      requestedMode: "limited-dacl",
      effectiveStrength: "limited-dacl",
      effectiveTier: "appcontainer-dacl",
      effectiveEnabled: true,
      ambientAccess: ambientAccess(),
      folders: [{ path: String.raw`C:\Users\Alice\Desktop`, access: "rw" }],
      lifecycleState: {
        phase: "active",
        detail: null,
        updatedAt: new Date(0).toISOString(),
      },
    });
    const wrapper = shallowMount(SettingsView, {
      global: { plugins: [createPinia()] },
    });
    await flushPromises();

    expect(wrapper.find('[data-testid="mxc-ambient-compact"]').text()).toBe(
      "No inherited filesystem access detected (18/18 denied)",
    );
    expect(wrapper.find('[data-testid="mxc-ambient-compact"]').classes()).toContain(
      "mxc-summary-ok",
    );
    expect(wrapper.find('[data-testid="mxc-ambient-diagnostics"]').exists()).toBe(false);

    const policy = wrapper.find(".mxc-folder-policy");
    expect(policy.text()).toContain(String.raw`C:\Users\Alice\Desktop`);
    expect(policy.text()).toContain("Read/write");
    expect(policy.text()).toContain("not an exclusive allowlist");

    await wrapper.find('[data-testid="mxc-technical-details-toggle"]').trigger("click");
    const ambient = wrapper.find('[data-testid="mxc-ambient-diagnostics"]');
    expect(ambient.text()).toContain("Ambient access before selected-folder grants");
    expect(ambient.text()).toContain("Desktop");
    expect(ambient.text()).toContain("Denied");
    expect(ambient.text()).toContain("microclaw.windows-node-mxc-ambient-access.v1");
    expect(ambient.text()).toContain("ambient-hash-1");
    expect(ambient.text()).not.toContain(String.raw`C:\Users\Alice\Desktop`);
  });

  it("surfaces ambient exceptions prominently and hides category rows until expanded", async () => {
    routeState.section = "security";
    getWindowsNodeMxcStatus.mockResolvedValueOnce({
      ...status("node-local"),
      requestedMode: "limited-dacl",
      effectiveStrength: "limited-dacl",
      effectiveTier: "appcontainer-dacl",
      effectiveEnabled: true,
      ambientAccess: ambientAccess({ desktop: "read-write" }),
      folders: [{ path: String.raw`C:\Work`, access: "ro" }],
      durableApprovals: {
        records: [
          {
            schemaVersion: 1,
            id: "remembered-command",
            executablePath: String.raw`C:\Windows\System32\hostname.exe`,
            executableSha256: "sha",
            argv: [],
            commandText: "hostname.exe",
            cwdBinding: "isolated-scratch:v1",
            declaredAccess: [],
            agentId: null,
            sessionKey: "main",
            policyFingerprint: "policy",
            approvalPlanContract: "microclaw.windows-node-approval-plan.v2",
            createdAt: new Date(0).toISOString(),
            lastUsedAt: null,
          },
        ],
        invalidRecords: 0,
        warning: null,
      },
      lifecycleState: {
        phase: "active",
        detail: null,
        updatedAt: new Date(0).toISOString(),
      },
    });
    const wrapper = shallowMount(SettingsView, {
      global: { plugins: [createPinia()] },
    });
    await flushPromises();

    const policy = wrapper.find(".mxc-folder-policy");
    expect(policy.text()).toContain("Limited additional filesystem grants");
    expect(policy.text()).toContain("add access");
    expect(policy.text()).toContain("not an exclusive allowlist");
    expect(policy.text()).toContain("Read-only cannot reduce access");
    expect(wrapper.find('[data-testid="mxc-limited-approvals"]').text()).toContain(
      "Per-command approval only",
    );
    expect(wrapper.find(".mxc-card").text()).not.toContain("hostname.exe");

    const ambientSummary = wrapper.find('[data-testid="mxc-ambient-compact"]');
    expect(ambientSummary.text()).toContain(
      "Inherited filesystem access detected: Desktop — Read/write",
    );
    expect(ambientSummary.text()).toContain("(17/18 denied)");
    expect(ambientSummary.classes()).toContain("mxc-summary-error");
    expect(wrapper.find('[data-testid="mxc-ambient-diagnostics"]').exists()).toBe(false);

    await wrapper.find('[data-testid="mxc-technical-details-toggle"]').trigger("click");
    const ambient = wrapper.find('[data-testid="mxc-ambient-diagnostics"]');
    expect(ambient.text()).toContain("Ambient access before selected-folder grants");
    expect(ambient.text()).toContain("Desktop");
    expect(ambient.text()).toContain("Read/write");
    expect(ambient.text()).toContain("OpenClaw roaming state");
    expect(ambient.text()).toContain("SSH");
    expect(ambient.text()).toContain("Denied");
    expect(ambient.text()).not.toMatch(/[A-Z]:\\/);
  });

  it("adds RO and RW roots through the shared trusted picker API", async () => {
    routeState.section = "security";
    getWindowsNodeMxcStatus.mockImplementation(async () => ({
      ...status("node-local"),
      requestedMode: "off",
      desiredEnabled: false,
      folders:
        setFolderPolicy.mock.calls.length === 0
          ? []
          : setFolderPolicy.mock.calls.length === 1
            ? [{ path: "C:\\Work", access: "rw" as const }]
            : [
                { path: "C:\\Work", access: "rw" as const },
                { path: "C:\\Docs", access: "ro" as const },
              ],
    }));
    stageFolder
      .mockResolvedValueOnce({
        ok: true,
        removedChildren: [],
        dirs: { rw: ["C:\\Work"], ro: [] },
      })
      .mockResolvedValueOnce({
        ok: true,
        removedChildren: [],
        dirs: { rw: ["C:\\Work"], ro: ["C:\\Docs"] },
      });
    const wrapper = shallowMount(SettingsView, {
      global: { plugins: [createPinia()] },
    });
    await flushPromises();

    await wrapper.find('[data-testid="mxc-add-rw"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-testid="mxc-add-ro"]').trigger("click");
    await flushPromises();

    expect(stageFolder).toHaveBeenNthCalledWith(1, {
      access: "rw",
      draft: { rw: [], ro: [] },
    });
    expect(stageFolder).toHaveBeenNthCalledWith(2, {
      access: "ro",
      draft: { rw: ["C:\\Work"], ro: [] },
    });
    expect(setFolderPolicy).toHaveBeenLastCalledWith({ rw: ["C:\\Work"], ro: ["C:\\Docs"] });
    expect(wrapper.find(".mxc-folder-policy").text()).toContain("C:\\Work");
    expect(wrapper.find(".mxc-folder-policy").text()).toContain("C:\\Docs");
  });

  it("does not expose the retired AppContainer controls when MXC is Off", async () => {
    routeState.section = "security";
    getWindowsNodeMxcStatus.mockResolvedValue({
      ...status("node-local"),
      requestedMode: "off",
      desiredEnabled: false,
    });
    const wrapper = shallowMount(SettingsView, {
      global: { plugins: [createPinia()] },
    });
    await flushPromises();

    expect(wrapper.find('[data-testid="sandbox-add-rw"]').exists()).toBe(false);
    expect(wrapper.text()).not.toContain("AppContainer");
    expect(wrapper.text()).toContain("without an execution sandbox");
    expect(stageFolder).not.toHaveBeenCalled();
    expect(setFolderPolicy).not.toHaveBeenCalled();
  });

  it("changes and removes roots through the shared folder settings API", async () => {
    routeState.section = "security";
    const initial = {
      ...status("node-local"),
      requestedMode: "off",
      desiredEnabled: false,
      folders: [
        { path: "C:\\Work", access: "rw" },
        { path: "C:\\Docs", access: "ro" },
      ],
    } satisfies WindowsNodeMxcStatus;
    getWindowsNodeMxcStatus.mockImplementation(async () => {
      const saved = setFolderPolicy.mock.lastCall?.[0];
      return saved
        ? {
            ...initial,
            folders: [
              ...saved.rw.map((path: string) => ({ path, access: "rw" as const })),
              ...saved.ro.map((path: string) => ({ path, access: "ro" as const })),
            ],
          }
        : initial;
    });
    const wrapper = shallowMount(SettingsView, {
      global: { plugins: [createPinia()] },
    });
    await flushPromises();

    await wrapper.find('[data-testid="mxc-change-ro"]').trigger("click");
    await flushPromises();
    expect(setFolderPolicy).toHaveBeenLastCalledWith({
      rw: [],
      ro: ["C:\\Docs", "C:\\Work"],
    });

    const removeButtons = wrapper.findAll(".mxc-folder-policy .tag-remove");
    await removeButtons[0].trigger("click");
    await flushPromises();
    expect(setFolderPolicy).toHaveBeenLastCalledWith({ rw: [], ro: ["C:\\Work"] });
  });

  it("stages folder edits without mutating the active MXC policy", async () => {
    routeState.section = "security";
    getWindowsNodeMxcStatus.mockResolvedValueOnce({
      ...status("node-local"),
      folders: [
        { path: "C:\\Work", access: "rw" },
        { path: "C:\\Docs", access: "ro" },
      ],
    });
    stageFolder.mockResolvedValue({
      ok: true,
      dirs: { rw: ["C:\\Work", "C:\\New"], ro: ["C:\\Docs"] },
    });
    const wrapper = shallowMount(SettingsView, {
      global: { plugins: [createPinia()] },
    });
    await flushPromises();

    const policy = wrapper.find(".mxc-folder-policy");
    expect(policy.text()).toContain("Changes are staged only");
    expect(policy.find('[data-testid="mxc-add-rw"]').attributes("disabled")).toBe("false");
    await policy.find('[data-testid="mxc-add-rw"]').trigger("click");
    await flushPromises();
    expect(stageFolder).toHaveBeenCalledWith({
      access: "rw",
      draft: { rw: ["C:\\Work"], ro: ["C:\\Docs"] },
    });
    expect(policy.text()).toContain("C:\\New");
    expect(policy.find('[data-testid="mxc-apply-folder-policy"]').exists()).toBe(true);
    expect(setFolderPolicy).not.toHaveBeenCalled();
  });

  it("confirms and applies the complete staged policy through one lifecycle transaction", async () => {
    routeState.section = "security";
    const initial = {
      ...status("node-local"),
      folders: [{ path: "C:\\Work", access: "rw" as const }],
    };
    getWindowsNodeMxcStatus.mockResolvedValueOnce(initial);
    stageFolder.mockResolvedValue({
      ok: true,
      dirs: { rw: ["C:\\Work"], ro: ["C:\\Docs"] },
    });
    applyFolderPolicy.mockResolvedValue({
      ...initial,
      effectiveEnabled: true,
      gatewayPolicyState: "active",
      lifecycleState: {
        phase: "active",
        detail: "Approved folder policy applied",
        updatedAt: new Date().toISOString(),
      },
      folders: [
        { path: "C:\\Work", access: "rw" },
        { path: "C:\\Docs", access: "ro" },
      ],
    });
    vi.spyOn(ElMessageBox, "confirm").mockResolvedValue("confirm" as never);
    const wrapper = shallowMount(SettingsView, {
      global: { plugins: [createPinia()] },
    });
    await flushPromises();

    await wrapper.find('[data-testid="mxc-add-ro"]').trigger("click");
    await flushPromises();
    await wrapper.find('[data-testid="mxc-apply-folder-policy"]').trigger("click");
    await flushPromises();

    expect(applyFolderPolicy).toHaveBeenCalledWith({
      rw: ["C:\\Work"],
      ro: ["C:\\Docs"],
    });
  });

  it("shows the exact failed folder-policy phase and nested diagnostics", async () => {
    routeState.section = "security";
    getWindowsNodeMxcStatus.mockResolvedValueOnce({
      ...status("node-local"),
      folderPolicyRecovery: {
        previous: { rw: ["C:\\Desktop"], ro: [] },
        draft: { rw: ["C:\\Desktop", "C:\\Users\\sunt\\Documents"], ro: [] },
        updatedAt: "2026-10-20T07:40:04.792Z",
        failurePhase: "persisting",
        lastError:
          "MXC ACL grant failed: launcher(timedOut=true); verification(protectedChildrenSufficient=false)",
      },
    });

    const wrapper = shallowMount(SettingsView, {
      global: { plugins: [createPinia()] },
    });
    await flushPromises();

    const recovery = wrapper.find(".mxc-folder-policy .mxc-alert-error");
    expect(recovery.text()).toContain("persisting:");
    expect(recovery.text()).toContain("timedOut=true");
    expect(recovery.text()).toContain("protectedChildrenSufficient=false");
  });

  it("opens the English legal documents from About", async () => {
    const wrapper = shallowMount(SettingsView, {
      global: {
        plugins: [createPinia()],
      },
    });

    await flushPromises();
    await wrapper
      .findAll(".settings-menu-item")
      .find((item) => item.text() === "About")!
      .trigger("click");

    const links = wrapper.findAll(".legal-link");
    expect(links.map((link) => link.text())).toEqual([
      "MicroClaw End User License Agreement",
      "Privacy Statement",
    ]);
    expect(links[0].attributes("href")).toBe("https://microclaw.microsoft.com/eula.en.html");
    expect(links[1].attributes("href")).toBe("https://www.microsoft.com/privacy/privacystatement");

    await links[0].trigger("click");
    await links[1].trigger("click");

    expect(openExternal.mock.calls).toEqual([
      ["https://microclaw.microsoft.com/eula.en.html"],
      ["https://www.microsoft.com/privacy/privacystatement"],
    ]);

    setLocale("zh-CN");
    await wrapper.vm.$nextTick();

    expect(links[0].text()).toBe("MicroClaw 最终用户许可协议");
    expect(links[0].attributes("href")).toBe("https://microclaw.microsoft.com/eula.html");
  });
});
