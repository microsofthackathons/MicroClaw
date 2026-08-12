import { runMxcWorker } from "./runtime.mjs";
import process from "node:process";

const PLUGIN_ID = "microclaw-mxc";

function textResult(value, isError = false) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value) }],
    ...(isError ? { isError: true } : {}),
  };
}

function createTool(api, context, definition) {
  const agentId = context.agentId || "main";
  const config = api.pluginConfig || {};
  const policy = config.agents?.[agentId];
  if (
    process.env.MICROCLAW_MXC_READY !== "1" ||
    config.sdkVersion !== "0.7.0" ||
    config.policyVersion !== "0.7.0-alpha" ||
    config.upstreamCommit !== "34d7fe2b4b3226bd4d11dc4a32419b7ec198a88b" ||
    config.fallback?.allowDaclMutation !== false ||
    !policy
  ) {
    return null;
  }
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    async execute(_id, params) {
      const result = await runMxcWorker(policy, definition.request(params));
      if (!result.ok) return textResult(result.error || "MXC operation failed.", true);
      return textResult(result.content ?? result);
    },
  };
}

const definitions = [
  {
    name: "mxc_read",
    description: "Read one UTF-8 file through the fail-closed Microsoft MXC worker.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["path"],
      properties: { path: { type: "string" } },
    },
    request: (params) => ({ operation: "read", path: params.path }),
  },
  {
    name: "mxc_write",
    description: "Create one UTF-8 file through the fail-closed Microsoft MXC worker.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["path", "content"],
      properties: {
        path: { type: "string" },
        content: { type: "string" },
        overwrite: { type: "boolean", default: false },
      },
    },
    request: (params) => ({
      operation: "write",
      path: params.path,
      content: params.content,
      overwrite: params.overwrite === true,
    }),
  },
  {
    name: "mxc_edit",
    description: "Replace one unique string in a UTF-8 file through the Microsoft MXC worker.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["path", "oldText", "newText"],
      properties: {
        path: { type: "string" },
        oldText: { type: "string" },
        newText: { type: "string" },
      },
    },
    request: (params) => ({
      operation: "edit",
      path: params.path,
      oldText: params.oldText,
      newText: params.newText,
    }),
  },
  {
    name: "mxc_exec",
    description:
      "Run a bounded non-interactive command in the Microsoft MXC worker. There is no host fallback.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["command"],
      properties: {
        command: { type: "string", maxLength: 8192 },
        cwd: { type: "string" },
        timeoutMs: { type: "integer", minimum: 1000, maximum: 30000 },
      },
    },
    request: (params) => ({
      operation: "exec",
      command: params.command,
      cwd: params.cwd,
      timeoutMs: params.timeoutMs,
    }),
  },
];

export default {
  id: PLUGIN_ID,
  name: "MicroClaw Microsoft MXC Tools",
  description: "Experimental fail-closed tools backed by Microsoft MXC.",
  register(api) {
    for (const definition of definitions) {
      api.registerTool((context) => createTool(api, context, definition), {
        name: definition.name,
      });
    }
  },
};
