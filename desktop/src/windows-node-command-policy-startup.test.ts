import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureAgentPersonasConfig } from "./agent-personas";
import { readAgentRoster } from "./agent-roster";
import {
  applyWindowsNodeCommandPolicy,
  applyWindowsNodeMxcGatewayPolicy,
  buildWindowsNodeMxcToolPolicy,
  validateWindowsNodeMxcGatewayPolicy,
} from "./windows-node-mxc";

const nodeId = "startup-node";
const stateDir = resolve("test-state", "command-policy-startup");

function prepareConfig(source: Record<string, unknown>): Record<string, unknown> {
  const config = structuredClone(source);
  ensureAgentPersonasConfig(config, stateDir);
  return applyWindowsNodeCommandPolicy(config, nodeId);
}

describe("Windows Node command policy startup", () => {
  it("pins the completed persona roster before persisting the startup configuration", () => {
    const source = readFileSync(resolve("src/main.ts"), "utf8");
    const start = source.indexOf("async function startGatewayInner(");
    const end = source.indexOf("const originalAgentConfigText", start);
    const preflight = source.slice(start, end);
    const personas = preflight.indexOf("const preparedPersonas = prepareAgentPersonas(stateDir)");
    const policy = preflight.indexOf("applyWindowsNodeCommandPolicy(");

    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(personas).toBeGreaterThan(-1);
    expect(policy).toBeGreaterThan(personas);
    expect(preflight.match(/applyWindowsNodeCommandPolicy\(/gu)).toHaveLength(1);
    expect(preflight.replace(/\s+/gu, " ")).toContain(
      "preparedPersonas.config as Record<string, unknown>, nodeId",
    );
    expect(preflight).toContain("preparedPersonas.config = pinned");
    expect(preflight).toContain("preparedPersonas.changed ||=");
    expect(source).toContain("persistAgentPersonas(preparedPersonas!.config)");
    expect(source).toContain("Gateway command consent routing is not effective");
  });

  it("pins the default main agent created from an empty installation", () => {
    const source = { gateway: { port: 18789 }, tools: { allow: ["read", "write", "exec"] } };
    const original = structuredClone(source);
    const config = prepareConfig(source);
    const roster = readAgentRoster(config.agents);
    const expectedExec = buildWindowsNodeMxcToolPolicy(nodeId).exec;

    expect(source).toEqual(original);
    expect(roster.map((agent) => agent.id)).toEqual(["main"]);
    expect(config.tools).toMatchObject({ allow: ["read", "write", "exec"], exec: expectedExec });
    expect(roster[0].config.tools).toMatchObject({ exec: expectedExec });
    expect(JSON.stringify(applyWindowsNodeCommandPolicy(config, nodeId))).toBe(
      JSON.stringify(config),
    );
  });

  it("creates and pins the initial roster before Full-mode startup attestation", () => {
    const config = {
      gateway: { port: 18789 },
      agents: { defaults: { model: { primary: "custom/m" } } },
    };
    ensureAgentPersonasConfig(config, stateDir);
    const pinned = applyWindowsNodeMxcGatewayPolicy(config, nodeId, {}, "locked").config;
    expect(readAgentRoster(pinned.agents)).toHaveLength(1);
    expect(validateWindowsNodeMxcGatewayPolicy(pinned, nodeId, "locked").ready).toBe(true);

    const source = readFileSync(resolve("src/main.ts"), "utf8");
    const start = source.indexOf("async function startGatewayInner(");
    const preflight = source.slice(start, source.indexOf("gatewayToken =", start));
    expect(
      preflight.indexOf("ensureAgentPersonasConfig(config, getOpenClawStateDir())"),
    ).toBeLessThan(preflight.indexOf("applyWindowsNodeMxcGatewayPolicy("));
    expect(preflight).toContain("configBeforePersonas !== JSON.stringify(pinned.config)");
  });

  it.each(["entries", "list"] as const)(
    "pins every agent from the %s roster without replacing unrelated tool settings",
    (format) => {
      const entries = {
        main: { tools: { allow: ["read", "exec"] } },
        helper: {
          tools: { deny: ["browser"], exec: { backgroundMs: 1000 } },
          model: "example/model",
        },
      };
      const agents =
        format === "entries"
          ? { entries }
          : { list: Object.entries(entries).map(([id, config]) => ({ id, ...config })) };
      const config = prepareConfig({ agents });
      const roster = readAgentRoster(config.agents);
      const expectedExec = buildWindowsNodeMxcToolPolicy(nodeId).exec;

      expect(roster.map((agent) => agent.id)).toEqual(["main", "helper"]);
      for (const agent of roster) {
        expect(agent.config.tools).toMatchObject({ exec: expectedExec });
      }
      expect(roster[0].config.tools).toMatchObject({ allow: ["read", "exec"] });
      expect(roster[1].config).toMatchObject({
        model: "example/model",
        tools: { deny: ["browser"], exec: { backgroundMs: 1000 } },
      });
      expect(prepareConfig(config)).toEqual(config);
      expect(JSON.stringify(applyWindowsNodeCommandPolicy(config, nodeId))).toBe(
        JSON.stringify(config),
      );
    },
  );

  it.each([
    ["node", "different-node"],
    ["security", "full"],
    ["ask", "off"],
    ["strictInlineEval", false],
  ])("still detects a mismatched agent exec %s", (field, value) => {
    const config = prepareConfig({});
    const agent = readAgentRoster(config.agents)[0].config;
    const tools = agent.tools as { exec: Record<string, unknown> };
    tools.exec[field as string] = value;

    expect(JSON.stringify(applyWindowsNodeCommandPolicy(config, nodeId))).not.toBe(
      JSON.stringify(config),
    );
  });
});
