import { createPinia } from "pinia";
import { flushPromises, shallowMount } from "@vue/test-utils";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "@/i18n";
import { useGatewayStore } from "@/stores/gateway";
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
  const preflightWindowsNodeMxc = vi.fn();
  const setWindowsNodeMxcEnabled = vi.fn();
  const addUserDir = vi.fn();
  const stageUserDir = vi.fn();
  const removeUserDir = vi.fn();
  const setUserDirAccess = vi.fn();
  const getUserDirs = vi.fn();
  const validateFolderPolicy = vi.fn();
  const applyFolderPolicy = vi.fn();
  const getRemoteApprovalStatus = vi.fn();
  const setRemoteApprovalEnabled = vi.fn();
  const revokeRemoteApproval = vi.fn();

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
    preflightWindowsNodeMxc.mockReset().mockResolvedValue(undefined);
    setWindowsNodeMxcEnabled
      .mockReset()
      .mockImplementation(
        async ({ requestedMode }: { requestedMode: WindowsNodeMxcStatus["requestedMode"] }) => ({
          ...status("node-local"),
          requestedMode,
          desiredEnabled: requestedMode !== "off",
        }),
      );
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
    getRemoteApprovalStatus.mockReset().mockResolvedValue({
      experimental: true,
      enabled: false,
      configured: false,
      owner: null,
      availableOwners: [],
      blockedReason: "owner-ambiguous",
    });
    setRemoteApprovalEnabled.mockReset().mockResolvedValue({ ok: true });
    revokeRemoteApproval.mockReset().mockResolvedValue({ ok: true });
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
      shell: { openExternal },
      mxc: {
        getStatus: vi.fn().mockResolvedValue({
          ready: false,
          packageReady: true,
          hashReady: true,
          osSupported: true,
          policyReady: true,
          workerReady: false,
          sdkVersion: "0.7.0",
          policyVersion: "0.7.0-alpha",
          upstreamCommit: "34d7fe2b4b3226bd4d11dc4a32419b7ec198a88b",
          architecture: "x64",
          binaryHash: "pinned-hash",
          isolationTier: "appcontainer-dacl",
          isolationWarnings: [],
          requiresHostPreparation: true,
          lastError: "DACL fallback refused",
          agents: [
            {
              id: "main",
              name: "Assistant",
              desired: { readonlyPaths: [], readwritePaths: [] },
              effective: { readonlyPaths: [], readwritePaths: [], workspace: null },
            },
          ],
        }),
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

  it("shows honest fail-closed Microsoft MXC readiness", async () => {
    const wrapper = shallowMount(SettingsView, {
      global: { plugins: [createPinia()] },
    });
    await flushPromises();
    await wrapper
      .findAll(".settings-menu-item")
      .find((item) => item.text() === "Security")!
      .trigger("click");
    await flushPromises();

    const text = wrapper.find(".settings-content").text();
    expect(wrapper.find("el-alert").attributes("title")).toBe(
      "Microsoft MXC public preview experiment",
    );
    expect(text).toContain("Blocked (fail closed)");
    expect(text).toContain("DACL fallback refused");
    expect(text).not.toContain("Tool sandbox (AppContainer)");
    expect(wrapper.find('[data-testid="mxc-confirm-limited"]').exists()).toBe(false);
    expect(getWindowsNodeMxcStatus).not.toHaveBeenCalled();
    expect(getRemoteApprovalStatus).not.toHaveBeenCalled();
    expect(setWindowsNodeMxcEnabled).not.toHaveBeenCalled();
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

  it("rejects excluded native compatibility APIs rather than offering an off-mode fallback", async () => {
    const api = createBrowserOpenClawMock();
    await expect(api.windowsNodeMxc.getStatus()).rejects.toThrow("mandatory MXC worker");
    await expect(api.windowsNodeMxc.setEnabled({ requestedMode: "off" })).rejects.toThrow(
      "mandatory MXC worker",
    );
    await expect(api.plugin.weixin.setRemoteApprovalEnabled(true)).rejects.toThrow(
      "mandatory MXC worker",
    );
  });
});
