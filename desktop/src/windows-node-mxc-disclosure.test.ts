import { describe, expect, it } from "vitest";
import {
  applyWindowsNodeMxcGatewayPolicy,
  validateWindowsNodeMxcSettings,
} from "./windows-node-mxc";
import {
  WINDOWS_NODE_MXC_CAPABILITY_DISCLOSURE,
  WINDOWS_NODE_MXC_CAPABILITY_DISCLOSURE_VERSION,
} from "./windows-node-mxc-disclosure";

describe("Windows Node MXC capability disclosure", () => {
  it("accurately identifies the command-only containment boundary", () => {
    const groups = WINDOWS_NODE_MXC_CAPABILITY_DISCLOSURE.groups;
    expect(WINDOWS_NODE_MXC_CAPABILITY_DISCLOSURE.version).toBe(
      WINDOWS_NODE_MXC_CAPABILITY_DISCLOSURE_VERSION,
    );
    expect(groups.map((group) => group.id)).toEqual(["contained", "outside-mxc"]);
    expect(groups[0].items.map((item) => item.id)).toEqual(["windows-node-exec"]);
    expect(groups[1].items.map((item) => item.id)).toEqual([
      "gateway-native-filesystem",
      "gateway-runtime",
      "canvas",
    ]);
    const allItems = [...groups[0].items, ...groups[1].items];
    expect(new Set(allItems.map((item) => item.id)).size).toBe(allItems.length);
    for (const item of allItems) {
      expect(item.translationKey).toBe(`settings.windowsNodeMxcConsent.item.${item.id}`);
    }
  });

  it("does not disable unrelated node features in MXC settings validation", () => {
    const settings = {
      EnableNodeMode: true,
      NodeSystemRunEnabled: true,
      NodeCanvasEnabled: true,
      SystemRunSandboxEnabled: true,
      SystemRunBlockHostFallbackWhenMxcUnavailable: true,
      SystemRunAllowWindowsUi: true,
      SystemRunAllowOutbound: true,
      SandboxClipboard: 0,
      EnableMcpServer: true,
      NodeScreenEnabled: true,
      NodeCameraEnabled: true,
      NodeLocationEnabled: true,
      NodeBrowserProxyEnabled: true,
      NodeSttEnabled: true,
      NodeTtsEnabled: true,
    };

    expect(validateWindowsNodeMxcSettings(settings).ready).toBe(true);
    expect(
      validateWindowsNodeMxcSettings({ ...settings, SystemRunSandboxEnabled: false }).blockers,
    ).toContain("Windows node MXC sandbox is disabled");
  });

  it("preserves Gateway tools, channels, plugins, Cron, and Hooks", () => {
    const source = {
      agents: { list: [{ id: "main" }] },
      tools: { allow: ["read", "write", "browser"] },
      channels: { discord: { enabled: true } },
      cron: { enabled: true },
      hooks: { enabled: true, internal: { enabled: true } },
      plugins: {
        enabled: true,
        entries: { "openclaw-weixin": { enabled: true }, "custom-plugin": { enabled: true } },
      },
    };

    const applied = applyWindowsNodeMxcGatewayPolicy(source, "node-123");

    expect(applied.config).toMatchObject({
      tools: { allow: ["read", "write", "browser"] },
      channels: { discord: { enabled: true } },
      cron: { enabled: true },
      hooks: { enabled: true, internal: { enabled: true } },
      plugins: {
        enabled: true,
        entries: { "openclaw-weixin": { enabled: true }, "custom-plugin": { enabled: true } },
      },
    });
    expect(applied.backups).toEqual({});
  });
});
