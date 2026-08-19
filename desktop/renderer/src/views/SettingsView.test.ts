import { createPinia } from "pinia";
import { flushPromises, shallowMount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

  const localNode = {
    id: "node-local",
    displayName: "Local Windows node",
    platform: "windows",
    connected: true,
    paired: true,
    remoteIp: "127.0.0.1",
    commands: ["system.run", "system.run.prepare"],
  };

  const status = (
    selectedNodeId: string,
    nodes = [localNode, { ...localNode, id: "node-other" }],
  ): WindowsNodeMxcStatus => ({
    desiredEnabled: true,
    effectiveEnabled: false,
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
        getUserDirs: vi.fn().mockResolvedValue({ rw: [], ro: [] }),
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
});
