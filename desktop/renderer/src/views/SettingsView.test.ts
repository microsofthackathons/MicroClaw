import { createPinia } from "pinia";
import { flushPromises, shallowMount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElMessageBox } from "element-plus";
import { setLocale } from "@/i18n";
import { useGatewayStore } from "@/stores/gateway";
import SettingsView from "./SettingsView.vue";

const routeState = vi.hoisted(() => ({ section: "skills" }));
vi.mock("vue-router", () => ({
  useRoute: () => ({ params: { section: routeState.section } }),
}));

describe("SettingsView", () => {
  type WindowsNodeMxcStatus = Awaited<ReturnType<typeof window.openclaw.windowsNodeMxc.getStatus>>;
  const exportGatewayLogs = vi.fn();
  const getWindowsNodeMxcStatus = vi.fn();
  const setWindowsNodeMxcEnabled = vi.fn();
  const activateWindowsNodeMxc = vi.fn();
  const addUserDir = vi.fn();
  const stageUserDir = vi.fn();
  const removeUserDir = vi.fn();
  const setUserDirAccess = vi.fn();
  const getUserDirs = vi.fn();
  const validateFolderPolicy = vi.fn();
  const applyFolderPolicy = vi.fn();

  const localNode = {
    id: "node-local",
    displayName: "Local Windows node",
    platform: "windows",
    connected: true,
    paired: true,
    remoteIp: "127.0.0.1",
    commands: ["system.run", "system.run.prepare"],
  };

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const status = (
    selectedNodeId: string,
    nodes = [localNode, { ...localNode, id: "node-other" }],
  ): WindowsNodeMxcStatus => ({
    desiredEnabled: true,
    effectiveEnabled: false,
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
    settingsFingerprint: "settings",
    nodes,
    selectedNode: nodes.find((node) => node.id === selectedNodeId) ?? null,
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
      reason: null,
    },
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
      .mockImplementation(async ({ nodeId }: { nodeId: string }) => status(nodeId));
    activateWindowsNodeMxc.mockReset();
    addUserDir.mockReset().mockResolvedValue({ ok: false, dirs: { rw: [], ro: [] } });
    stageUserDir.mockReset().mockResolvedValue({
      ok: false,
      canceled: true,
      dirs: { rw: [], ro: [] },
    });
    removeUserDir.mockReset().mockResolvedValue({ ok: true, dirs: { rw: [], ro: [] } });
    setUserDirAccess.mockReset().mockResolvedValue({ ok: true, dirs: { rw: [], ro: [] } });
    getUserDirs.mockReset().mockResolvedValue({ rw: [], ro: [] });
    validateFolderPolicy.mockReset().mockImplementation(async (draft) => draft);
    applyFolderPolicy.mockReset();
    window.openclaw = {
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
      windowsNodeMxc: {
        getStatus: getWindowsNodeMxcStatus,
        setEnabled: setWindowsNodeMxcEnabled,
        runSmoke: vi.fn(),
        activate: activateWindowsNodeMxc,
        validateFolderPolicy,
        applyFolderPolicy,
        listDurableApprovals: vi.fn().mockResolvedValue([]),
        revokeDurableApproval: vi.fn().mockResolvedValue([]),
        revokeAllDurableApprovals: vi.fn().mockResolvedValue([]),
        respondApproval: vi.fn(),
        onApprovalRequest: vi.fn().mockReturnValue(() => undefined),
        onLifecycleState: vi.fn().mockReturnValue(() => undefined),
      },
      sandbox: {
        getStatus: vi.fn().mockResolvedValue({
          available: true,
          enabled: false,
          sandboxDirsRW: [],
          sandboxDirsRO: [],
        }),
        getExternalApps: vi.fn().mockResolvedValue([]),
        getCapabilities: vi.fn().mockResolvedValue([]),
        getUserDirs,
        addUserDir,
        stageUserDir,
        removeUserDir,
        setUserDirAccess,
      },
    } as unknown as typeof window.openclaw;
    exportGatewayLogs.mockReset().mockResolvedValue({
      canceled: false,
      filePath: "C:\\Logs\\gateway.log",
    });
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

  it("shows the deterministic app-owned node without a manual selector", async () => {
    routeState.section = "security";
    getWindowsNodeMxcStatus.mockResolvedValueOnce(status("node-local"));
    const wrapper = shallowMount(SettingsView, {
      global: {
        plugins: [createPinia()],
      },
    });

    await flushPromises();

    expect(wrapper.find(".mxc-card").text()).toContain("Local Windows node (online)");
    expect(wrapper.find(".mxc-card").find("el-select").exists()).toBe(false);
    expect(setWindowsNodeMxcEnabled).not.toHaveBeenCalled();
  });

  it("activates only after the locked-generation smoke proof is ready", async () => {
    routeState.section = "security";
    const passed = { outcome: "passed" as const, reason: "ok" };
    const lockedReady = {
      ...status("node-local"),
      strictFallbackEffective: true,
      allowWindowsUiEffective: true,
      smoke: {
        gatewayGeneration: "generation-1",
        nodeId: "node-local",
        settingsFingerprint: "settings",
        probeTier: "appcontainer-dacl",
        checkedAt: new Date().toISOString(),
        hostname: passed,
        powershell: passed,
        deniedOutsideRoot: passed,
      },
    };
    getWindowsNodeMxcStatus.mockResolvedValueOnce(lockedReady);
    activateWindowsNodeMxc.mockResolvedValueOnce({
      ...lockedReady,
      effectiveEnabled: true,
      gatewayPolicyState: "active",
      activationLeaseMode: "active",
    });
    const wrapper = shallowMount(SettingsView, {
      global: {
        plugins: [createPinia()],
      },
    });

    await flushPromises();
    const activateButton = wrapper
      .findAll("el-button")
      .find((button) => button.text() === "Activate verified route");
    expect(activateButton?.attributes("disabled")).toBe("false");

    await activateButton!.trigger("click");
    await flushPromises();

    expect(activateWindowsNodeMxc).toHaveBeenCalledOnce();
  });

  it("shows empty global RO and RW folder lists while MXC is disabled", async () => {
    routeState.section = "security";
    getWindowsNodeMxcStatus.mockResolvedValueOnce({
      ...status("node-local"),
      desiredEnabled: false,
    });
    const wrapper = shallowMount(SettingsView, {
      global: { plugins: [createPinia()] },
    });

    await flushPromises();

    const policy = wrapper.find(".mxc-folder-policy");
    expect(policy.text()).toContain("Global MXC approved folders");
    expect(policy.text()).toContain("global capability ceiling");
    expect(policy.findAll(".dir-empty")).toHaveLength(2);
    expect(policy.find('[data-testid="mxc-add-rw"]').attributes("disabled")).toBe("false");
    expect(policy.text()).not.toContain("Disable Windows Node + MXC");
  });

  it("adds RO and RW roots through the shared trusted picker API", async () => {
    routeState.section = "security";
    getWindowsNodeMxcStatus.mockImplementation(async () => ({
      ...status("node-local"),
      desiredEnabled: false,
      folders:
        addUserDir.mock.calls.length === 0
          ? []
          : addUserDir.mock.calls.length === 1
            ? [{ path: "C:\\Work", access: "rw" as const }]
            : [
                { path: "C:\\Work", access: "rw" as const },
                { path: "C:\\Docs", access: "ro" as const },
              ],
    }));
    addUserDir
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

    expect(addUserDir).toHaveBeenNthCalledWith(1, {
      access: "rw",
      policy: "windows-node-mxc",
    });
    expect(addUserDir).toHaveBeenNthCalledWith(2, {
      access: "ro",
      policy: "windows-node-mxc",
    });
    expect(wrapper.find(".mxc-folder-policy").text()).toContain("C:\\Work");
    expect(wrapper.find(".mxc-folder-policy").text()).toContain("C:\\Docs");
  });

  it("keeps the legacy AppContainer picker outside the MXC validation context", async () => {
    routeState.section = "security";
    getWindowsNodeMxcStatus.mockResolvedValue({
      ...status("node-local"),
      desiredEnabled: false,
    });
    addUserDir.mockResolvedValue({
      ok: true,
      removedChildren: [],
      dirs: { rw: ["C:\\Legacy"], ro: [] },
    });
    const wrapper = shallowMount(SettingsView, {
      global: { plugins: [createPinia()] },
    });
    await flushPromises();

    await wrapper.find('[data-testid="sandbox-add-rw"]').trigger("click");
    await flushPromises();

    expect(addUserDir).toHaveBeenCalledWith({ access: "rw" });
  });

  it("changes and removes roots through the shared folder settings API", async () => {
    routeState.section = "security";
    getWindowsNodeMxcStatus.mockResolvedValue({
      ...status("node-local"),
      desiredEnabled: false,
      folders: [
        { path: "C:\\Work", access: "rw" },
        { path: "C:\\Docs", access: "ro" },
      ],
    });
    getUserDirs.mockResolvedValue({
      rw: ["C:\\Work"],
      ro: ["C:\\Docs"],
    });
    setUserDirAccess.mockResolvedValue({
      ok: true,
      removedChildren: [],
      dirs: { rw: [], ro: ["C:\\Docs", "C:\\Work"] },
    });
    removeUserDir.mockResolvedValue({
      ok: true,
      dirs: { rw: [], ro: ["C:\\Work"] },
    });
    const wrapper = shallowMount(SettingsView, {
      global: { plugins: [createPinia()] },
    });
    await flushPromises();

    await wrapper.find('[data-testid="mxc-change-ro"]').trigger("click");
    await flushPromises();
    expect(setUserDirAccess).toHaveBeenCalledWith({ dir: "C:\\Work", access: "ro" });

    const removeButtons = wrapper.findAll(".mxc-folder-policy .tag-remove");
    await removeButtons[0].trigger("click");
    await flushPromises();
    expect(removeUserDir).toHaveBeenCalled();
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
    stageUserDir.mockResolvedValue({
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
    expect(stageUserDir).toHaveBeenCalledWith({
      access: "rw",
      draft: { rw: ["C:\\Work"], ro: ["C:\\Docs"] },
    });
    expect(policy.text()).toContain("C:\\New");
    expect(policy.find('[data-testid="mxc-apply-folder-policy"]').exists()).toBe(true);
    expect(addUserDir).not.toHaveBeenCalled();
    expect(setUserDirAccess).not.toHaveBeenCalled();
    expect(removeUserDir).not.toHaveBeenCalled();
  });

  it("confirms and applies the complete staged policy through one lifecycle transaction", async () => {
    routeState.section = "security";
    const initial = {
      ...status("node-local"),
      folders: [{ path: "C:\\Work", access: "rw" as const }],
    };
    getWindowsNodeMxcStatus.mockResolvedValueOnce(initial);
    stageUserDir.mockResolvedValue({
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
});
