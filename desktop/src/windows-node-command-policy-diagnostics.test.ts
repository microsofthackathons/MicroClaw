import { describe, expect, it } from "vitest";
import { describeWindowsNodeCommandPolicyMismatch } from "./windows-node-command-policy-diagnostics";
import { applyWindowsNodeCommandPolicy } from "./windows-node-mxc";

describe("Windows node command policy diagnostics", () => {
  it("identifies a key-order-only mismatch without changing either config", () => {
    const expected = applyWindowsNodeCommandPolicy(
      { agents: { entries: { main: {} } } },
      "node-123",
    );
    const actual = structuredClone(expected);
    const gateway = actual.gateway as { nodes: { commands: { allow: string[]; deny: string[] } } };
    const { allow, deny } = gateway.nodes.commands;
    gateway.nodes.commands = { deny, allow };
    const actualBefore = JSON.stringify(actual);
    const expectedBefore = JSON.stringify(expected);

    expect(describeWindowsNodeCommandPolicyMismatch(actual, expected)).toMatchObject({
      serializedEqual: false,
      objectKeyOrderOnly: true,
      actual: { nodeCommands: { keys: ["deny", "allow"], allow, deny } },
      expected: { nodeCommands: { keys: ["allow", "deny"], allow, deny } },
    });
    expect(JSON.stringify(actual)).toBe(actualBefore);
    expect(JSON.stringify(expected)).toBe(expectedBefore);
  });

  it("shows actual and expected global and agent execution policy values", () => {
    const actual = {
      tools: { exec: { host: "gateway", ask: "off" } },
      agents: { entries: { main: { tools: { exec: { node: "wrong-node" } } } } },
    };
    const expected = applyWindowsNodeCommandPolicy(actual, "node-123");

    expect(describeWindowsNodeCommandPolicyMismatch(actual, expected)).toMatchObject({
      serializedEqual: false,
      objectKeyOrderOnly: false,
      actual: {
        toolsExec: { host: "gateway", ask: "off", node: "[missing]" },
        agents: [{ id: "main", exec: { node: "wrong-node" } }],
      },
      expected: {
        toolsExec: { host: "node", ask: "always", node: "node-123" },
        agents: [{ id: "main", exec: { node: "node-123" } }],
      },
    });
  });

  it("shows legacy command lists and agent rosters alongside their expected policies", () => {
    const actual = {
      agents: { list: [{ id: "legacy-agent" }] },
      gateway: { nodes: { allowCommands: ["custom.read"], denyCommands: ["system.run"] } },
    };
    const expected = applyWindowsNodeCommandPolicy(actual, "node-123");

    expect(describeWindowsNodeCommandPolicyMismatch(actual, expected)).toMatchObject({
      objectKeyOrderOnly: false,
      actual: {
        agents: [{ id: "legacy-agent", exec: { host: "[missing]" } }],
        nodeCommands: {
          legacyAllowCommands: ["custom.read"],
          legacyDenyCommands: ["system.run"],
        },
      },
      expected: {
        agents: [{ id: "legacy-agent", exec: { host: "node" } }],
        nodeCommands: {
          allow: expect.arrayContaining(["custom.read", "system.run"]),
          deny: [],
          legacyAllowCommands: "[missing]",
          legacyDenyCommands: "[missing]",
        },
      },
    });
  });

  it("does not log auth tokens, provider credentials, exec environments, or nested objects", () => {
    const actual = {
      gateway: {
        auth: { token: "PRIVATE_GATEWAY_TOKEN" },
        nodes: { commands: { allow: [{ token: "PRIVATE_COMMAND_TOKEN" }] } },
      },
      models: { providers: { example: { apiKey: "PRIVATE_API_KEY" } } },
      tools: {
        exec: { env: { TOKEN: "PRIVATE_EXEC_TOKEN" }, node: { token: "PRIVATE_NODE_TOKEN" } },
      },
      agents: {
        entries: { main: { tools: { exec: { env: { TOKEN: "PRIVATE_AGENT_TOKEN" } } } } },
      },
    };
    const expected = applyWindowsNodeCommandPolicy(actual, "node-123");
    const diagnostic = describeWindowsNodeCommandPolicyMismatch(actual, expected);

    expect(JSON.stringify(diagnostic)).not.toContain("PRIVATE_");
    expect(diagnostic).toMatchObject({
      actual: { toolsExec: { node: "[object]" }, nodeCommands: { allow: ["[object]"] } },
    });
  });

  it.each([
    { actual: undefined, type: "undefined" },
    { actual: null, type: "null" },
    { actual: [], type: "array" },
    { actual: "PRIVATE_INVALID_CONFIG", type: "string" },
  ])("describes invalid $type config without logging its contents", ({ actual, type }) => {
    const diagnostic = describeWindowsNodeCommandPolicyMismatch(actual, undefined);
    expect(diagnostic).toMatchObject({ objectKeyOrderOnly: false, actual: { type } });
    expect(JSON.stringify(diagnostic)).not.toContain("PRIVATE_");
  });

  it("does not classify identical configs as an order-only mismatch", () => {
    const actual = applyWindowsNodeCommandPolicy({}, "node-123");
    expect(describeWindowsNodeCommandPolicyMismatch(actual, structuredClone(actual))).toMatchObject(
      {
        serializedEqual: true,
        objectKeyOrderOnly: false,
      },
    );
  });
});
