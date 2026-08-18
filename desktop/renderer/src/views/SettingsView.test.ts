import { createPinia } from "pinia";
import { flushPromises, shallowMount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { defineComponent } from "vue";
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

  const localNode = {
    id: "node-local",
    displayName: "Local Windows node",
    platform: "windows",
    connected: true,
    paired: true,
    remoteIp: null,
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
    gatewayPolicyState: "locked",
    gatewayPolicyReady: true,
    effectiveToolsReady: true,
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

  it("persists a changed node immediately while MXC mode is enabled", async () => {
    routeState.section = "security";
    const NodeSelectStub = defineComponent({
      emits: ["change"],
      template: `<button class="node-select" @click="$emit('change', 'node-local')" />`,
    });
    const wrapper = shallowMount(SettingsView, {
      global: {
        plugins: [createPinia()],
        stubs: { "el-select": NodeSelectStub },
      },
    });

    await flushPromises();
    await wrapper.find(".node-select").trigger("click");
    await flushPromises();

    expect(setWindowsNodeMxcEnabled).toHaveBeenCalledWith({
      enabled: true,
      nodeId: "node-local",
    });
  });

  it("automatically replaces the diagnostic sentinel for exactly one eligible node", async () => {
    routeState.section = "security";
    getWindowsNodeMxcStatus.mockResolvedValueOnce(
      status("diagnostic-unpaired-local-node", [localNode]),
    );

    shallowMount(SettingsView, {
      global: {
        plugins: [createPinia()],
      },
    });
    await flushPromises();

    expect(setWindowsNodeMxcEnabled).toHaveBeenCalledWith({
      enabled: true,
      nodeId: "node-local",
    });
  });

  it("keeps a pending valid selection when a refresh returns the old sentinel", async () => {
    routeState.section = "security";
    let resolveSelection!: (value: WindowsNodeMxcStatus) => void;
    setWindowsNodeMxcEnabled.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSelection = resolve;
      }),
    );
    const NodeSelectStub = defineComponent({
      props: { modelValue: { type: String, default: "" } },
      emits: ["change"],
      template: `<button class="node-select" :data-value="modelValue" @click="$emit('change', 'node-local')" />`,
    });
    const wrapper = shallowMount(SettingsView, {
      global: {
        plugins: [createPinia()],
        stubs: { "el-select": NodeSelectStub },
      },
    });
    await flushPromises();

    await wrapper.find(".node-select").trigger("click");
    window.dispatchEvent(new Event("focus"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await wrapper.vm.$nextTick();

    expect(wrapper.find(".node-select").attributes("data-value")).toBe("node-local");

    resolveSelection(status("node-local"));
    await flushPromises();
  });
});
