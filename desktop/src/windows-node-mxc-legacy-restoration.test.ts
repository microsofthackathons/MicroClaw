import { describe, expect, it } from "vitest";
import {
  applyWindowsNodeMxcGatewayPolicy,
  buildWindowsNodeMxcToolPolicy,
  restoreWindowsNodeMxcGatewayPolicy,
  WINDOWS_NODE_MXC_NODE_COMMANDS,
  WINDOWS_NODE_MXC_TOOL_ALLOWLIST,
  WINDOWS_NODE_MXC_TOOL_DENYLIST,
} from "./windows-node-mxc";

describe("legacy MXC restriction restoration", () => {
  it("restores previously disabled features without replacing unrelated later edits", () => {
    const legacy = {
      agents: {
        list: [
          {
            id: "main",
            tools: {
              ...buildWindowsNodeMxcToolPolicy("node-1"),
              allow: [...WINDOWS_NODE_MXC_TOOL_ALLOWLIST, "custom-tool"],
              deny: [...WINDOWS_NODE_MXC_TOOL_DENYLIST, "custom-denied"],
            },
          },
        ],
      },
      gateway: {
        nodes: {
          commands: {
            allow: [
              ...WINDOWS_NODE_MXC_NODE_COMMANDS,
              "canvas.present",
              "canvas.hide",
              "canvas.navigate",
              "canvas.eval",
              "canvas.snapshot",
              "canvas.caps",
              "canvas.a2ui.push",
              "canvas.a2ui.pushJSONL",
              "canvas.a2ui.reset",
              "canvas.a2ui.dump",
            ],
            deny: [],
          },
        },
      },
      channels: { discord: { enabled: false, token: "new-token" } },
      hooks: { enabled: false, internal: { enabled: false } },
      cron: { enabled: false, maxConcurrentRuns: 4 },
      plugins: {
        enabled: true,
        allow: ["canvas", "memory-core", "custom-plugin"],
        deny: [],
        slots: { memory: "memory-core" },
        entries: {
          canvas: { enabled: true },
          "memory-core": { enabled: true },
          "old-plugin": { enabled: false, config: { updated: true } },
          "custom-plugin": { enabled: true },
        },
      },
    };
    const backups = {
      main: { allow: ["read"], deny: ["previously-denied"] },
      "$microclaw.gateway.nodes": { commands: { allow: ["custom.node"], deny: ["other.node"] } },
      "$microclaw.ingress.channels": { discord: { enabled: true, token: "old-token" } },
      "$microclaw.ingress.hooks": { enabled: true, internal: { enabled: true } },
      "$microclaw.ingress.cron": { enabled: true, maxConcurrentRuns: 2 },
      "$microclaw.ingress.plugins": {
        allow: ["old-plugin"],
        entries: { "old-plugin": { enabled: true, config: { updated: false } } },
      },
    };

    const restored = restoreWindowsNodeMxcGatewayPolicy(legacy, backups);
    expect(restored).toMatchObject({
      agents: {
        list: [
          {
            id: "main",
            tools: { allow: ["read", "custom-tool"], deny: ["previously-denied", "custom-denied"] },
          },
        ],
      },
      gateway: { nodes: { commands: { allow: ["custom.node"], deny: ["other.node"] } } },
      channels: { discord: { enabled: true, token: "new-token" } },
      hooks: { enabled: true, internal: { enabled: true } },
      cron: { enabled: true, maxConcurrentRuns: 4 },
      plugins: {
        allow: ["old-plugin", "custom-plugin"],
        entries: {
          "old-plugin": { enabled: true, config: { updated: true } },
          "custom-plugin": { enabled: true },
        },
      },
    });
    expect(legacy.channels.discord.enabled).toBe(false);
  });

  it("restores unchanged imposed fields even when an allowlist was replaced", () => {
    const legacy = {
      agents: {
        list: [
          {
            id: "main",
            tools: { ...buildWindowsNodeMxcToolPolicy("node-1"), allow: ["my-explicit-allow"] },
          },
        ],
      },
    };
    const restored = restoreWindowsNodeMxcGatewayPolicy(legacy, {
      main: { allow: ["old-allow"], deny: ["old-deny"] },
    });
    expect(restored.agents).toMatchObject({
      list: [{ tools: { allow: ["my-explicit-allow"], deny: ["old-deny"] } }],
    });
  });

  it("restores legacy plugin entry states without replacing a later allowlist", () => {
    const legacy = {
      plugins: {
        enabled: true,
        allow: ["edited-plugin"],
        slots: { memory: "memory-core" },
        entries: {
          canvas: { enabled: true },
          "memory-core": { enabled: true },
          "old-plugin": { enabled: false, config: { updated: true } },
          "user-disabled": { enabled: false },
        },
      },
    };
    const restored = restoreWindowsNodeMxcGatewayPolicy(legacy, {
      "$microclaw.ingress.plugins": {
        allow: ["old-plugin"],
        entries: {
          "old-plugin": { enabled: true },
          "user-disabled": { enabled: false },
        },
      },
    });
    expect(restored).toMatchObject({
      plugins: {
        allow: ["edited-plugin"],
        entries: {
          "old-plugin": { enabled: true, config: { updated: true } },
          "user-disabled": { enabled: false },
        },
      },
    });
  });

  it("recognizes reordered legacy plugin allowlists", () => {
    const restored = restoreWindowsNodeMxcGatewayPolicy(
      {
        plugins: {
          enabled: true,
          allow: ["custom-plugin", "memory-core", "canvas"],
          slots: { memory: "memory-core" },
          entries: { canvas: { enabled: true }, "memory-core": { enabled: true } },
        },
      },
      {
        "$microclaw.ingress.plugins": { allow: ["original-plugin"] },
      },
    );
    expect(restored).toMatchObject({
      plugins: { allow: ["original-plugin", "custom-plugin"] },
    });
  });

  it("routes exec without disabling Gateway tools, channels, plugins, cron, or hooks", () => {
    const source = {
      agents: { list: [{ id: "main", tools: { allow: ["read", "exec"] } }] },
      tools: { deny: ["custom"] },
      channels: { discord: { enabled: true } },
      plugins: { entries: { custom: { enabled: true } } },
      cron: { enabled: true },
      hooks: { enabled: true },
    };
    const applied = applyWindowsNodeMxcGatewayPolicy(source, "node-1");
    expect(applied.config).toMatchObject({
      agents: {
        list: [{ id: "main", tools: { allow: ["read", "exec"], exec: { host: "node" } } }],
      },
      tools: { deny: ["custom"], exec: { host: "node" } },
      channels: source.channels,
      plugins: source.plugins,
      cron: source.cron,
      hooks: source.hooks,
    });
    expect(applied.backups).toEqual({});
    expect(source).not.toHaveProperty("gateway");
  });
});
