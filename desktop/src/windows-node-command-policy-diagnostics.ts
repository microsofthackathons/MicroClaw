import { isDeepStrictEqual } from "node:util";
import { readAgentRoster } from "./agent-roster";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function describeValue(value: unknown): unknown {
  if (value === undefined) return "[missing]";
  if (Array.isArray(value)) return value.map(describeValue);
  if (value !== null && typeof value === "object") return "[object]";
  return value;
}

function describeExec(value: unknown) {
  const exec = asRecord(value) ?? {};
  return {
    keys: Object.keys(exec),
    ...Object.fromEntries(
      ["host", "node", "security", "ask", "timeoutSeconds", "strictInlineEval"].map((key) => [
        key,
        describeValue(exec[key]),
      ]),
    ),
  };
}

function describePolicy(value: unknown) {
  const config = asRecord(value);
  if (!config)
    return { type: value === null ? "null" : Array.isArray(value) ? "array" : typeof value };
  const nodes = asRecord(asRecord(config.gateway)?.nodes) ?? {};
  const commands = asRecord(nodes.commands) ?? {};
  return {
    toolsExec: describeExec(asRecord(config.tools)?.exec),
    agents: readAgentRoster(config.agents).map(({ id, config: agent }) => ({
      id,
      exec: describeExec(asRecord(agent.tools)?.exec),
    })),
    nodeCommands: {
      keys: Object.keys(commands),
      allow: describeValue(commands.allow),
      deny: describeValue(commands.deny),
      legacyAllowCommands: describeValue(nodes.allowCommands),
      legacyDenyCommands: describeValue(nodes.denyCommands),
    },
  };
}

export function describeWindowsNodeCommandPolicyMismatch(actual: unknown, expected: unknown) {
  const serializedEqual = JSON.stringify(actual) === JSON.stringify(expected);
  return {
    serializedEqual,
    objectKeyOrderOnly: !serializedEqual && isDeepStrictEqual(actual, expected),
    actual: describePolicy(actual),
    expected: describePolicy(expected),
  };
}
