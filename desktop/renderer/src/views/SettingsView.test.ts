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
  const offStatus = (overrides: Partial<WindowsNodeMxcStatus> = {}): WindowsNodeMxcStatus => ({
    ...status("node-local"),
    requestedMode: "off",
    desiredEnabled: false,
    canvas: {
      state: "off",
      commandCount: 8,
      nativeA2uiOnly: true,
      localFilesAllowed: false,
    },
    lifecycleState: {
      phase: "idle",
      detail: null,
      updatedAt: new Date(0).toISOString(),
    },
    ...overrides,
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
    expect(wrapper.find('[data-testid="mxc-off-disclosure"]').exists()).toBe(false);

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

  it("does not expose the internal node identity or a manual selector", async () => {
    routeState.section = "security";
    getWindowsNodeMxcStatus.mockResolvedValueOnce(status("node-local"));
    const wrapper = shallowMount(SettingsView, {
      global: {
        plugins: [createPinia()],
      },
    });

    await flushPromises();
    expect(wrapper.find(".mxc-card").text()).not.toContain("Local Windows node (node-local)");
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

  it("keeps Full protection status and controls without internal diagnostics", async () => {
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

    expect(wrapper.find('[data-testid="mxc-technical-details-toggle"]').exists()).toBe(false);
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

  it.each(["off", "full", "limited-dacl"] as const)(
    "omits internal diagnostics and verbose warnings in %s mode",
    async (requestedMode) => {
      routeState.section = "security";
      const compatibility =
        "Allow Windows UI APIs is required for PowerShell under MXC 0.7. It is a compatibility relaxation, not activation of UI capabilities. MXC is the only tool execution sandbox; Off runs without sandboxing.";
      const degraded =
        "Warning: this machine uses degraded DACL-based MXC containment. Execution remains blocked unless every other proof passes.";
      const blockers = [
        "Gateway agent tool policy drifted from the diagnostic-only locked MXC policy",
        "Current Full contained execution and outside-root denial smoke proofs are required",
      ];
      const warnings = [
        "allowWindowsUi is a PowerShell compatibility relaxation; it does not enable screen, input, camera, microphone, browser, location, or speech capabilities. Canvas is separately restricted to the reviewed native A2UI subset.",
        "BaseContainer API not present or not preferred, and AppContainer + BFS is not compiled into this binary; falling back to AppContainer + DACL",
        "AppContainer + DACL tier selected: AppContainer processes may be unable to open the NUL device (`\\Device\\Null`), which the kernel resets to an AppContainer-hostile default at every boot. Run `wxc-host-prep prepare-null-device` (elevated) to reapply the documented security descriptor.",
      ];
      const remediation = [
        "Retry automatic readiness. MicroClaw authorizes only its fixed internal probes; normal commands still require approval.",
      ];
      getWindowsNodeMxcStatus.mockResolvedValueOnce({
        ...(requestedMode === "off" ? offStatus() : status("node-local")),
        requestedMode,
        blockers,
        warnings,
        remediation,
      });
      const wrapper = shallowMount(SettingsView, {
        global: { plugins: [createPinia()] },
      });
      await flushPromises();

      const section = wrapper.find(".section");
      expect(section.find('[data-testid="mxc-technical-details-toggle"]').exists()).toBe(false);
      expect(section.find('[data-testid="mxc-technical-details"]').exists()).toBe(false);
      expect(section.find(".section-footer").exists()).toBe(false);
      expect(section.findAll(".mxc-mode-card")).toHaveLength(3);
      for (const message of [compatibility, degraded, ...blockers, ...warnings, ...remediation]) {
        expect(section.text()).not.toContain(message);
      }
      expect(section.text()).not.toContain("Security diagnostics");
      expect(section.text()).not.toContain("settings-fingerprint-1");
      expect(section.text()).not.toContain("microclaw.windows-cwd.v1");
      if (requestedMode !== "off") {
        expect(section.find('[data-testid="mxc-status-summary"]').text()).toContain(
          "Action required",
        );
        expect(section.find(".mxc-state").classes()).toContain("mxc-state-blocked");
      }
      expect(setWindowsNodeMxcEnabled).not.toHaveBeenCalled();
      wrapper.unmount();
    },
  );

  it("keeps activation errors and essential controls without verbose debug output", async () => {
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
    expect(wrapper.find(".section").text()).not.toContain(
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

  it("shows compact Limited protection and Canvas status without raw attestation", async () => {
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

    expect(wrapper.find('[data-testid="mxc-technical-details-toggle"]').exists()).toBe(false);
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

  it("shows Full active status and a concise confirmed-Off disclosure", async () => {
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
      .mockResolvedValueOnce(offStatus());
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
    expect(off.find('[data-testid="mxc-off-disclosure"]').text()).toBe(
      "MXC is off. Tools run without MXC isolation.",
    );
    expect(off.find('[data-testid="mxc-status-summary"]').exists()).toBe(false);
    off.unmount();
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

  it.each([
    ["en-US", "MXC is off. Tools run without MXC isolation."],
    ["zh-CN", "MXC 已关闭。工具运行时不受 MXC 隔离保护。"],
  ] as const)("shows only mode cards and the Off disclosure in %s", async (locale, disclosure) => {
    routeState.section = "security";
    setLocale(locale);
    getWindowsNodeMxcStatus.mockResolvedValueOnce(offStatus());
    const wrapper = shallowMount(SettingsView, {
      global: { plugins: [createPinia()] },
    });

    await flushPromises();

    expect(wrapper.findAll(".mxc-mode-card")).toHaveLength(3);
    expect(wrapper.find('[data-testid="mxc-off-disclosure"]').text()).toBe(disclosure);
    expect(wrapper.find(".mxc-folder-policy").exists()).toBe(false);
    expect(wrapper.find(".mxc-durable-approval").exists()).toBe(false);
    expect(wrapper.find('[data-testid="mxc-limited-approvals"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="mxc-ambient-compact"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="mxc-technical-details-toggle"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="mxc-canvas-status"]').exists()).toBe(false);
    expect(wrapper.find(".section-footer").exists()).toBe(false);
    expect(wrapper.find(".section > .mxc-alert").exists()).toBe(false);
    expect(stageFolder).not.toHaveBeenCalled();
    expect(setFolderPolicy).not.toHaveBeenCalled();
    expect(applyFolderPolicy).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it.each(["starting-standard", "failed", "idle"] as const)(
    "keeps shutdown details visible when Off is requested with lifecycle %s",
    async (phase) => {
      routeState.section = "security";
      getWindowsNodeMxcStatus.mockResolvedValueOnce(
        offStatus({
          lifecycleState: {
            phase,
            detail: "Standard Gateway restoration is incomplete.",
            updatedAt: new Date(0).toISOString(),
          },
          blockers: ["Retry Gateway restoration."],
        }),
      );
      const wrapper = shallowMount(SettingsView, {
        global: { plugins: [createPinia()] },
      });
      await flushPromises();

      expect(wrapper.find('[data-testid="mxc-off-disclosure"]').exists()).toBe(false);
      expect(wrapper.find('[data-testid="mxc-status-summary"]').text()).toContain(
        phase === "starting-standard" ? "Turning MXC off" : "Action required",
      );
      expect(wrapper.find(".mxc-primary-detail").text()).toContain(
        "Standard Gateway restoration is incomplete.",
      );
      expect(wrapper.find(".section").text()).not.toContain("Retry Gateway restoration.");
      expect(wrapper.find(".mxc-folder-policy").exists()).toBe(true);
      wrapper.unmount();
    },
  );

  it.each<{ name: string; remaining: Partial<WindowsNodeMxcStatus> }>([
    { name: "requested protection", remaining: { desiredEnabled: true } },
    { name: "effective protection", remaining: { effectiveEnabled: true } },
    { name: "effective strength", remaining: { effectiveStrength: "limited-dacl" } },
    { name: "active lease", remaining: { activationLeaseMode: "active" } },
    { name: "diagnostic lease", remaining: { activationLeaseMode: "diagnostic" } },
    {
      name: "paused Canvas",
      remaining: { canvas: { ...offStatus().canvas, state: "paused" } },
    },
    {
      name: "paused hooks",
      remaining: { hooks: { ...offStatus().hooks, pausedByMxc: true } },
    },
    {
      name: "folder-policy recovery",
      remaining: {
        folderPolicyRecovery: {
          previous: { rw: [], ro: [] },
          draft: { rw: ["C:\\Work"], ro: [] },
          updatedAt: new Date(0).toISOString(),
          failurePhase: "persisting",
          lastError: "Folder policy restoration failed.",
        },
      },
    },
  ])("does not conceal remaining $name when Off is selected", async ({ remaining }) => {
    routeState.section = "security";
    getWindowsNodeMxcStatus.mockResolvedValueOnce(offStatus(remaining));
    const wrapper = shallowMount(SettingsView, {
      global: { plugins: [createPinia()] },
    });
    await flushPromises();

    expect(wrapper.find('[data-testid="mxc-off-disclosure"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="mxc-status-summary"]').text()).toContain("Action required");
    expect(wrapper.find(".mxc-folder-policy").exists()).toBe(true);
    if (remaining.folderPolicyRecovery) {
      expect(wrapper.find(".mxc-folder-policy .mxc-alert-error").text()).toContain(
        "Folder policy restoration failed.",
      );
    }
    wrapper.unmount();
  });

  it("preserves saved folders and remembered commands across hiding and redisplaying", async () => {
    routeState.section = "security";
    const configured = status("node-local");
    configured.folders = [{ path: "C:\\Work", access: "rw" }];
    configured.durableApprovals.records = [
      {
        schemaVersion: 1,
        id: "remembered-command",
        executablePath: "C:\\Windows\\System32\\hostname.exe",
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
    ];
    getWindowsNodeMxcStatus.mockResolvedValueOnce(configured);
    setWindowsNodeMxcEnabled
      .mockResolvedValueOnce(
        offStatus({
          folders: configured.folders,
          durableApprovals: configured.durableApprovals,
        }),
      )
      .mockResolvedValueOnce(configured);
    const wrapper = shallowMount(SettingsView, {
      global: { plugins: [createPinia()] },
    });
    await flushPromises();
    expect(wrapper.find(".mxc-folder-policy").text()).toContain("C:\\Work");
    expect(wrapper.find(".mxc-durable-approval").text()).toContain("hostname.exe");

    for (const [mode, hidden] of [
      ["off", true],
      ["full", false],
    ] as const) {
      await wrapper.find(`[data-testid="mxc-select-${mode}"]`).trigger("click");
      if (mode === "full") {
        wrapper.findComponent(MxcCapabilityConsentDialog).vm.$emit("accept");
      }
      await flushPromises();
      expect(wrapper.find('[data-testid="mxc-off-disclosure"]').exists()).toBe(hidden);
      expect(wrapper.find(".mxc-folder-policy").exists()).toBe(!hidden);
      expect(wrapper.find(".mxc-durable-approval").exists()).toBe(!hidden);
    }

    expect(wrapper.find(".mxc-folder-policy").text()).toContain("C:\\Work");
    expect(wrapper.find(".mxc-durable-approval").text()).toContain("hostname.exe");
    expect(setFolderPolicy).not.toHaveBeenCalled();
    expect(applyFolderPolicy).not.toHaveBeenCalled();
    expect(window.openclaw.windowsNodeMxc.revokeDurableApproval).not.toHaveBeenCalled();
    expect(window.openclaw.windowsNodeMxc.revokeAllDurableApprovals).not.toHaveBeenCalled();
    wrapper.unmount();
  });

  it("does not treat a stale Off snapshot as confirmed after status inspection fails", async () => {
    routeState.section = "security";
    getWindowsNodeMxcStatus
      .mockResolvedValueOnce(offStatus())
      .mockRejectedValueOnce(new Error("Native status inspection failed"));
    vi.spyOn(ElMessage, "error");
    const wrapper = shallowMount(SettingsView, {
      global: { plugins: [createPinia()] },
    });
    await flushPromises();
    expect(wrapper.find('[data-testid="mxc-off-disclosure"]').exists()).toBe(true);

    await wrapper
      .findAll(".settings-menu-item")
      .find((item) => item.text() === "General")!
      .trigger("click");
    await wrapper
      .findAll(".settings-menu-item")
      .find((item) => item.text() === "Security")!
      .trigger("click");
    await flushPromises();

    expect(wrapper.find('[data-testid="mxc-off-disclosure"]').exists()).toBe(false);
    expect(wrapper.find('[data-testid="mxc-status-error"]').text()).toContain(
      "Native status inspection failed",
    );
    expect(wrapper.find('[data-testid="mxc-status-summary"]').text()).toContain("Action required");
    wrapper.unmount();
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

    expect(wrapper.find('[data-testid="mxc-technical-details-toggle"]').exists()).toBe(false);
    expect(wrapper.find(".mxc-card").text()).not.toContain("ambient-hash-1");
  });

  it("surfaces ambient exceptions without displaying the internal category diagnostics", async () => {
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

    expect(wrapper.find('[data-testid="mxc-technical-details-toggle"]').exists()).toBe(false);
    expect(wrapper.find(".mxc-card").text()).not.toContain("OpenClaw roaming state");
    expect(wrapper.find(".mxc-card").text()).not.toContain("ambient-hash-1");
  });

  it("stages RO and RW roots through the shared trusted picker API", async () => {
    routeState.section = "security";
    getWindowsNodeMxcStatus.mockResolvedValueOnce(status("node-local"));
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
    expect(setFolderPolicy).not.toHaveBeenCalled();
    expect(applyFolderPolicy).not.toHaveBeenCalled();
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

  it("stages changed and removed roots without updating the active policy", async () => {
    routeState.section = "security";
    const initial = {
      ...status("node-local"),
      folders: [
        { path: "C:\\Work", access: "rw" },
        { path: "C:\\Docs", access: "ro" },
      ],
    } satisfies WindowsNodeMxcStatus;
    getWindowsNodeMxcStatus.mockResolvedValueOnce(initial);
    const wrapper = shallowMount(SettingsView, {
      global: { plugins: [createPinia()] },
    });
    await flushPromises();

    await wrapper.find('[data-testid="mxc-change-ro"]').trigger("click");
    await flushPromises();
    expect(validateFolderPolicy).toHaveBeenLastCalledWith({
      rw: [],
      ro: ["C:\\Docs", "C:\\Work"],
    });

    const removeButtons = wrapper.findAll(".mxc-folder-policy .tag-remove");
    await removeButtons[0].trigger("click");
    await flushPromises();
    expect(validateFolderPolicy).toHaveBeenLastCalledWith({ rw: [], ro: ["C:\\Work"] });
    expect(setFolderPolicy).not.toHaveBeenCalled();
    expect(applyFolderPolicy).not.toHaveBeenCalled();
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
