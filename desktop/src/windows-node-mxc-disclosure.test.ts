import { describe, expect, it } from "vitest";
import {
  applyWindowsNodeMxcGatewayPolicy,
  WINDOWS_NODE_MXC_CANVAS_ACTIONS,
  WINDOWS_NODE_MXC_CANVAS_COMMANDS,
  WINDOWS_NODE_MXC_DISABLED_PLUGIN_IDS,
  WINDOWS_NODE_MXC_GATEWAY_NATIVE_FS_TOOLS,
  WINDOWS_NODE_MXC_LOCKED_TOOL_DENYLIST,
  WINDOWS_NODE_MXC_TOOL_ALLOWLIST,
  validateWindowsNodeMxcSettings,
} from "./windows-node-mxc";
import {
  WINDOWS_NODE_MXC_CAPABILITY_DISCLOSURE,
  WINDOWS_NODE_MXC_CAPABILITY_DISCLOSURE_VERSION,
} from "./windows-node-mxc-disclosure";

const disclosureIds = WINDOWS_NODE_MXC_CAPABILITY_DISCLOSURE.groups.flatMap((group) =>
  group.items.map((item) => item.id),
);

describe("Windows Node MXC capability disclosure", () => {
  it("has a typed versioned render model with unique critical entries", () => {
    expect(WINDOWS_NODE_MXC_CAPABILITY_DISCLOSURE.version).toBe(
      WINDOWS_NODE_MXC_CAPABILITY_DISCLOSURE_VERSION,
    );
    expect(new Set(disclosureIds).size).toBe(disclosureIds.length);
    expect(WINDOWS_NODE_MXC_CAPABILITY_DISCLOSURE.groups.map((group) => group.id)).toEqual([
      "disabled",
      "paused",
      "available-restricted",
    ]);
  });

  it("locks disabled disclosure entries to current policy invariants", () => {
    expect(WINDOWS_NODE_MXC_GATEWAY_NATIVE_FS_TOOLS).toEqual([
      "read",
      "write",
      "edit",
      "apply_patch",
    ]);
    expect(WINDOWS_NODE_MXC_LOCKED_TOOL_DENYLIST).toEqual(
      expect.arrayContaining(["group:runtime", "group:fs", "group:plugins", "browser"]),
    );
    expect(WINDOWS_NODE_MXC_DISABLED_PLUGIN_IDS).toContain("memory-core");
    expect(disclosureIds).toEqual(
      expect.arrayContaining([
        "gateway-native-filesystem",
        "browser-automation",
        "mcp",
        "screen",
        "camera",
        "location",
        "tts",
        "stt",
        "gateway-memory",
      ]),
    );

    const strictSettings = {
      EnableNodeMode: true,
      NodeSystemRunEnabled: true,
      NodeCanvasEnabled: true,
      SystemRunSandboxEnabled: true,
      SystemRunBlockHostFallbackWhenMxcUnavailable: true,
      SystemRunAllowWindowsUi: true,
      SystemRunAllowOutbound: true,
      SandboxClipboard: 0,
      EnableMcpServer: false,
      NodeScreenEnabled: false,
      NodeCameraEnabled: false,
      NodeLocationEnabled: false,
      NodeBrowserProxyEnabled: false,
      NodeSttEnabled: false,
      NodeTtsEnabled: false,
    };
    expect(validateWindowsNodeMxcSettings(strictSettings).ready).toBe(true);
    for (const property of [
      "EnableMcpServer",
      "NodeScreenEnabled",
      "NodeCameraEnabled",
      "NodeLocationEnabled",
      "NodeBrowserProxyEnabled",
      "NodeSttEnabled",
      "NodeTtsEnabled",
    ] as const) {
      expect(
        validateWindowsNodeMxcSettings({ ...strictSettings, [property]: true }).ready,
        property,
      ).toBe(false);
    }
  });

  it("locks paused and restricted disclosure entries to the reviewed surface", () => {
    expect(WINDOWS_NODE_MXC_TOOL_ALLOWLIST).toEqual([
      "exec",
      "web_search",
      "web_fetch",
      "message",
      "canvas",
    ]);
    expect(WINDOWS_NODE_MXC_CANVAS_COMMANDS).toEqual([
      "canvas.present",
      "canvas.hide",
      "canvas.snapshot",
      "canvas.caps",
      "canvas.a2ui.push",
      "canvas.a2ui.pushJSONL",
      "canvas.a2ui.reset",
      "canvas.a2ui.dump",
    ]);
    expect(WINDOWS_NODE_MXC_CANVAS_ACTIONS).toEqual(["cancel", "click", "confirm", "submit"]);
    expect(disclosureIds).toEqual(
      expect.arrayContaining([
        "cron",
        "hooks-webhooks",
        "exec",
        "gateway-web",
        "wechat-message",
        "canvas-phase-1",
      ]),
    );

    const applied = applyWindowsNodeMxcGatewayPolicy(
      {
        agents: { list: [{ id: "main" }] },
        channels: {
          discord: { enabled: true },
          "openclaw-weixin": { enabled: true },
        },
        cron: { enabled: true },
        hooks: { enabled: true, internal: { enabled: true } },
        plugins: {
          enabled: true,
          entries: {
            "openclaw-weixin": { enabled: true },
            "memory-core": { enabled: true },
          },
        },
      },
      "node-123",
      {},
      "active",
    ).config;
    expect(applied).toMatchObject({
      channels: {
        discord: { enabled: false },
        "openclaw-weixin": { enabled: true },
      },
      cron: { enabled: false },
      hooks: { enabled: false, internal: { enabled: false } },
      plugins: {
        allow: ["canvas", "openclaw-weixin"],
        slots: { memory: "none" },
        entries: {
          canvas: { enabled: true },
          "openclaw-weixin": { enabled: true },
          "memory-core": { enabled: false },
        },
      },
    });
  });
});
