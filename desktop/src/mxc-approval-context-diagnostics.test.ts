import * as crypto from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import * as ts from "typescript";
import { beforeAll, describe, expect, it, vi } from "vitest";
import {
  describeGatewayApprovalContext,
  describeWeixinApprovalDecision,
  extractSafeMxcApprovalMetadataLine,
  WEIXIN_DELIVERY_DIAGNOSTIC_CONTRACT,
  isSafeMxcApprovalMetadataFrame,
} from "./mxc-approval-context-diagnostics";
// @ts-expect-error The Gateway compatibility preload is external ESM.
import * as compat from "./openclaw-approval-replay-compat.mjs";

const digest = (value: string) =>
  crypto.createHash("sha256").update(value).digest("hex").slice(0, 16);

describe("privacy-safe approval context diagnostics", () => {
  const deliveryFrame = {
    contract: WEIXIN_DELIVERY_DIAGNOSTIC_CONTRACT,
    stage: "provider",
    kind: "prompt",
    code: "provider-rejected",
    deliveryHash: "a".repeat(16),
    providerClientHash: "b".repeat(16),
    challengeHash: "c".repeat(16),
    approvalHash: "d".repeat(16),
    sessionHash: "e".repeat(16),
    httpStatus: 200,
    providerRet: -3,
  };
  it("collects both actual delivery log markers with only the fixed primitive delivery contract", () => {
    const frame = JSON.stringify(deliveryFrame);
    for (const prefix of [
      "[weixin-remote-approval-delivery] ",
      "[gateway] [openclaw-weixin] weixin-remote-approval-delivery ",
    ])
      expect(extractSafeMxcApprovalMetadataLine(prefix + frame)).toBe(frame);
    expect(extractSafeMxcApprovalMetadataLine("[unrelated] PRIVATE TOKEN")).toBeNull();
    expect(extractSafeMxcApprovalMetadataLine("[weixin-remote-approval-context] {")).toBeNull();
  });
  it.each([
    { code: "PRIVATE EXCEPTION" },
    { command: "PRIVATE COMMAND" },
    { body: { ret: -3 } },
    { deliveryHash: "raw-private-delivery-id" },
    { providerClientHash: "a".repeat(64) },
    { providerRet: null },
    { providerRet: false },
    { providerRet: "" },
    { providerRet: 0.5 },
    { providerRet: 9007199254740992 },
    { httpStatus: 99 },
    { httpStatus: 600 },
    { kind: "PRIVATE RECIPIENT" },
    { stage: "PRIVATE STAGE" },
  ])("rejects invalid or non-whitelisted delivery metadata %j", (change) => {
    const frame = JSON.stringify({ ...deliveryFrame, ...change });
    expect(isSafeMxcApprovalMetadataFrame(frame)).toBe(false);
    expect(
      extractSafeMxcApprovalMetadataLine("[weixin-remote-approval-delivery] " + frame),
    ).toBeNull();
  });
  it("requires a real hashed correlation and stage-appropriate fixed code", () => {
    expect(
      isSafeMxcApprovalMetadataFrame(
        JSON.stringify({
          contract: WEIXIN_DELIVERY_DIAGNOSTIC_CONTRACT,
          stage: "provider",
          kind: "acknowledgement",
          code: "provider-accepted",
          inboundHash: "f".repeat(16),
          providerClientHash: "a".repeat(16),
        }),
      ),
    ).toBe(true);
    expect(
      isSafeMxcApprovalMetadataFrame(
        JSON.stringify({
          contract: WEIXIN_DELIVERY_DIAGNOSTIC_CONTRACT,
          stage: "pipe",
          kind: "terminal",
          code: "delivery-dispatched",
          deliveryHash: "a".repeat(16),
        }),
      ),
    ).toBe(true);
    expect(
      isSafeMxcApprovalMetadataFrame(
        JSON.stringify({
          contract: WEIXIN_DELIVERY_DIAGNOSTIC_CONTRACT,
          stage: "provider",
          kind: "prompt",
          code: "provider-accepted",
        }),
      ),
    ).toBe(false);
    expect(
      isSafeMxcApprovalMetadataFrame(
        JSON.stringify({
          ...deliveryFrame,
          stage: "pipe",
        }),
      ),
    ).toBe(false);
  });
  it("persists source-cache, approved-origin and exact bound-run hashes through the collector allowlist", () => {
    const approval = {
      id: "PRIVATE APPROVAL",
      sessionKey: "PRIVATE POLICY",
      agent: "PRIVATE AGENT",
      origin: {
        runId: "PRIVATE RUN",
        runSessionKey: "PRIVATE CHAT",
        executionSessionKey: "PRIVATE POLICY",
        channel: "PRIVATE CHANNEL",
        accountId: "PRIVATE ACCOUNT",
        to: "PRIVATE RECIPIENT",
        toolCallId: "PRIVATE TOOL",
      },
      command: "PRIVATE COMMAND",
      token: "PRIVATE TOKEN",
    };
    const source = {
      accountId: "PRIVATE ACCOUNT",
      senderId: "PRIVATE RECIPIENT",
      conversationId: "PRIVATE RECIPIENT",
      sessionKey: "PRIVATE CHAT",
      providerSessionKey: "PRIVATE PROVIDER CHAT",
      agentId: "PRIVATE AGENT",
      messageId: "PRIVATE MESSAGE",
      cursor: "PRIVATE CURSOR",
      runId: "PRIVATE RUN",
      gatewayGeneration: "PRIVATE GENERATION",
    };
    for (const [stage, reason, boundRun] of [
      ["weixin-source-validation", "source-route-unresolved", undefined],
      ["weixin-source-validation", "source-identity-mismatch", undefined],
      ["weixin-source-validation", "security-binding-invalid", undefined],
      ["weixin-source-cached", "source-cached", undefined],
      ["weixin-run-registration", "source-run-bound", "PRIVATE RUN"],
      ["weixin-main-delivery", "source-run-mismatch", undefined],
      ["weixin-main-delivery", "prompt-delivered", "PRIVATE RUN"],
    ] as const) {
      const frame = describeWeixinApprovalDecision(stage, reason, approval, source, boundRun);
      expect(frame.approvedOriginPresent).toBe(true);
      expect(frame.origin.runId.hash).toBe(digest("PRIVATE RUN"));
      expect(frame.source.senderId.hash).toBe(digest("PRIVATE RECIPIENT"));
      expect(frame.source.providerSessionKey.hash).toBe(digest("PRIVATE PROVIDER CHAT"));
      expect(frame.boundRun.hash).toBe(boundRun ? digest(boundRun) : undefined);
      const serialized = JSON.stringify(frame);
      expect(serialized).not.toContain("PRIVATE");
      expect(isSafeMxcApprovalMetadataFrame(serialized)).toBe(true);
      expect(isSafeMxcApprovalMetadataFrame(serialized.replace(reason, "PRIVATE TOKEN"))).toBe(
        false,
      );
      expect(
        isSafeMxcApprovalMetadataFrame(serialized.slice(0, -1) + ',"command":"PRIVATE COMMAND"}'),
      ).toBe(false);
    }
    expect(
      isSafeMxcApprovalMetadataFrame(
        JSON.stringify(describeGatewayApprovalContext({ request: { sessionKey: "PRIVATE CHAT" } })),
      ),
    ).toBe(true);
  });

  it("does not invoke metadata getters or serializers for the new decision stages", () => {
    const source = Object.defineProperty({}, "runId", {
      get() {
        throw new Error("PRIVATE GETTER");
      },
    });
    const approval = Object.defineProperty({}, "origin", {
      get() {
        throw new Error("PRIVATE GETTER");
      },
    });
    expect(() =>
      describeWeixinApprovalDecision(
        "weixin-main-delivery",
        "source-origin-unavailable",
        approval,
        source,
      ),
    ).not.toThrow();
    expect(
      describeWeixinApprovalDecision(
        "weixin-main-delivery",
        "source-origin-unavailable",
        approval,
        source,
      ).source.runId.type,
    ).toBe("accessor");
  });

  it("keeps the CommonJS main and injected ESM field contracts identical", () => {
    const envelope = {
      id: "private-approval",
      sessionKey: "private-envelope-session",
      agentId: "private-envelope-agent",
      runId: "private-envelope-run",
      toolCallId: "private-envelope-tool",
      originatingClientId: "private-client",
      request: {
        sessionKey: "private-request-session",
        agentId: "private-request-agent",
        runId: "private-request-run",
        toolCallId: "private-request-tool",
        origin: "private-origin",
        originatingClientId: "private-request-client",
        originatingDeviceId: "private-device",
        turnSourceChannel: "private-channel",
        turnSourceTo: "private-sender",
        turnSourceAccountId: "private-account",
        turnSourceThreadId: "private-thread",
        systemRunPlan: {
          sessionKey: "private-plan-session",
          agentId: "private-plan-agent",
          runId: "private-plan-run",
          toolCallId: "private-plan-tool",
        },
        command: "PRIVATE COMMAND",
        argv: ["PRIVATE ARGUMENT"],
        token: "PRIVATE TOKEN",
      },
      origin: {
        kind: "private-kind",
        channel: "private-channel",
        sessionKey: "private-origin-session",
        agentId: "private-origin-agent",
        runId: "private-origin-run",
        toolCallId: "private-origin-tool",
        turnSourceChannel: "private-turn-channel",
        turnSourceTo: "private-turn-to",
        turnSourceAccountId: "private-turn-account",
        turnSourceThreadId: "private-turn-thread",
      },
    };
    const actual = describeGatewayApprovalContext(envelope);
    expect(actual).toEqual(
      compat.describeMxcApprovalContext("gateway-approval-requested", { envelope }),
    );
    expect(actual.request.sessionKey).toEqual({
      present: true,
      type: "string",
      hash: digest(envelope.request.sessionKey),
      length: envelope.request.sessionKey.length,
    });
    expect(actual.plan.sessionKey.hash).not.toBe(actual.request.sessionKey.hash);
    expect(JSON.stringify(actual)).not.toMatch(/private-|PRIVATE/);
    expect(actual.request).not.toHaveProperty("command");
    expect(actual.request).not.toHaveProperty("argv");
    expect(actual.request).not.toHaveProperty("token");
  });

  it("never invokes getters, serializers, or inherited identity fields", () => {
    const request = Object.create({ agentId: "PRIVATE INHERITED" });
    for (const key of ["sessionKey", "systemRunPlan", "command", "token", "toJSON"]) {
      Object.defineProperty(request, key, {
        get() {
          throw new Error("PRIVATE GETTER");
        },
      });
    }
    const envelope = { request };
    const actual = describeGatewayApprovalContext(envelope);
    expect(actual).toEqual(
      compat.describeMxcApprovalContext("gateway-approval-requested", { envelope }),
    );
    expect(actual.request.sessionKey).toEqual({ present: true, type: "accessor" });
    expect(actual.request.agentId).toEqual({ present: false, type: "missing" });
    expect(actual.plan.sessionKey).toEqual({ present: false, type: "missing" });
    expect(JSON.stringify(actual)).not.toContain("PRIVATE");
  });

  it.each([undefined, null, 42, 1n, Symbol("PRIVATE"), ["PRIVATE"], { secret: "PRIVATE" }])(
    "reports only shape for non-string metadata (%s)",
    (value) => {
      const envelope = { request: { sessionKey: value } };
      const actual = describeGatewayApprovalContext(envelope);
      expect(actual).toEqual(
        compat.describeMxcApprovalContext("gateway-approval-requested", { envelope }),
      );
      expect(actual.request.sessionKey.present).toBe(true);
      expect(actual.request.sessionKey).not.toHaveProperty("hash");
      expect(JSON.stringify(actual)).not.toContain("PRIVATE");
    },
  );

  it("rejects an unrecognized diagnostic stage without echoing it", () => {
    expect(() => compat.describeMxcApprovalContext("PRIVATE UNTRUSTED STAGE", {})).toThrow(
      "Unsupported MXC approval diagnostic stage",
    );
  });

  it("observes the actual main approval envelope before normalization, behind the existing MXC gate", () => {
    const source = readFileSync(join(__dirname, "main.ts"), "utf8");
    const branch = source.indexOf(
      'if (evt.event === "exec.approval.requested" && isWindowsNodeMxcDesired())',
    );
    const diagnostic = source.indexOf("describeGatewayApprovalContext(evt.payload)", branch);
    const normalize = source.indexOf("normalizeWindowsNodeMxcGatewayApproval(", branch);
    expect(branch).toBeGreaterThan(-1);
    expect(diagnostic).toBeGreaterThan(branch);
    expect(normalize).toBeGreaterThan(diagnostic);
  });
});

const publishedPackage = process.env.MICROCLAW_OPENCLAW_TEST_PACKAGE_DIR;
describe.skipIf(!publishedPackage)("real pinned exec diagnostic boundaries", () => {
  let original: ts.SourceFile;
  let patched: ts.SourceFile;

  beforeAll(() => {
    if (!publishedPackage) throw new Error("A verified pinned package is required");
    compat.validatePinnedOpenClawApprovalPackage(publishedPackage, { approval: true });
    const source = readFileSync(join(publishedPackage, "dist", "bash-tools-Bl8Bd3CR.mjs"), "utf8");
    original = ts.createSourceFile(
      "original.mjs",
      source,
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.JS,
    );
    patched = ts.createSourceFile(
      "patched.mjs",
      compat.patchPinnedOpenClawBashTools(source),
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.JS,
    );
  });

  function declaration(source: ts.SourceFile, name: string): string {
    const match = source.statements.find(
      (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name,
    );
    if (!match) throw new Error(`Missing pinned function: ${name}`);
    return match.getText(source);
  }

  function evaluate(name: string, scope: Record<string, unknown>, includePrepare = false) {
    const definitions = [
      declaration(patched, "buildMxcApprovalContextDiagnostic"),
      declaration(patched, "logMicroclawMxcApprovalContext"),
      ...(includePrepare
        ? [
            declaration(patched, "buildMicroclawUnresolvedNodeRunKey"),
            declaration(patched, "prepareNodeSystemRun"),
          ]
        : []),
      declaration(patched, name),
    ].join("\n");
    return new Function(...Object.keys(scope), `${definitions}\nreturn ${name};`)(
      ...Object.values(scope),
    );
  }

  it.each(["1", ""])(
    "executes the real exec-tool closure with declared agent/tool correlation (gate=%s)",
    async (gate) => {
      const info = vi.fn();
      const stop = new Error("mock policy boundary");
      const policy = vi.fn(() => {
        throw stop;
      });
      const createExecTool = evaluate("createExecTool", {
        crypto,
        console: { info },
        process: { env: { MICROCLAW_WINDOWS_NODE_MXC_APPROVAL_COMPAT: gate } },
        isSecretEgressProxyActive: () => false,
        resolveExecPreparedRunEnvironment: () => ({}),
        resolveStoredSubagentCapabilities: () => ({ depth: 0 }),
        clampWithDefault: (_value: unknown, fallback: number) => fallback,
        readEnvInt: () => undefined,
        resolveExecDefaultTimeoutSec: () => 60,
        normalizePathPrepend: () => [],
        resolveExecSafeBinRuntimePolicy: () => ({
          unprofiledSafeBins: [],
          unprofiledInterpreterSafeBins: [],
        }),
        logInfo: vi.fn(),
        resolveExecNotificationDefaults: () => ({}),
        BACKGROUND_EXEC_FOLLOW_UP: "",
        EXEC_MANUAL_COLLECTION_FOLLOW_UP: "",
        resolveApprovalRunningNoticeMs: () => 1000,
        parseAgentSessionKey: () => null,
        createExecHostResolver: () => () => "node",
        createExecRequestPreparation: () => ({
          normalizeParams: (args: unknown) => args,
          isResolveExecEnvPrepared: () => true,
          getExecHookContext: () => ({}),
          getResolvedExecWorkdirPreparedState: () => undefined,
        }),
        EXEC_TOOL_DISPLAY_SUMMARY: "",
        execSchema: {},
        createExecToolExecutionTimeoutResolver: () => () => 0,
        captureAgentToolSourceExecutionGuard: () => () => undefined,
        assertSupportedExecParams: vi.fn(),
        normalizeOptionalString: (value: unknown) =>
          typeof value === "string" ? value.trim() : undefined,
        resolveExecElevatedMode: () => "off",
        requireValidExecTarget: (value: unknown) => value,
        resolveExecTarget: () => ({ effectiveHost: "node", selectedTarget: "node" }),
        resolveExecModePolicy: policy,
      });
      const defaults = {
        sessionKey: "PRIVATE DEFAULT SESSION",
        agentId: "PRIVATE AGENT",
        preparedStoreEnvironment: {},
        autoReviewer: vi.fn(),
        security: "allowlist",
        ask: "always",
      };
      const tool = createExecTool(defaults);
      await expect(
        tool.execute("PRIVATE TOOL ID", { command: "PRIVATE COMMAND", host: "node" }),
      ).rejects.toBe(stop);
      expect(policy).toHaveBeenCalledExactlyOnceWith({
        mode: undefined,
        security: "allowlist",
        ask: "always",
      });
      expect(info).toHaveBeenCalledTimes(gate === "1" ? 1 : 0);
      if (gate === "1") {
        const diagnostic = info.mock.calls[0][1];
        expect(diagnostic.stage).toBe("exec-defaults");
        expect(diagnostic.defaults.sessionKey.hash).toBe(digest(defaults.sessionKey));
        expect(diagnostic.origin.agentId.hash).toBe(digest(defaults.agentId));
        expect(diagnostic.origin.toolCallId.hash).toBe(digest("PRIVATE TOOL ID"));
        expect(JSON.stringify(info.mock.calls)).not.toContain("PRIVATE");
      }
    },
  );

  it.each(["1", ""])(
    "executes the real node/prepare functions without altering policy inputs (gate=%s)",
    async (gate) => {
      const order: string[] = [];
      const info = vi.fn((_namespace, diagnostic) => {
        order.push(diagnostic.stage);
      });
      const plan = {
        argv: ["never-executed"],
        cwd: null,
        commandText: "PRIVATE COMMAND",
        agentId: "PRIVATE OUTPUT AGENT",
        sessionKey: "PRIVATE OUTPUT SESSION",
      };
      const target = {
        nodeId: "mock-only-node",
        supportsSystemRunPrepare: true,
        argv: ["never-executed"],
      };
      const stop = new Error("mock analysis boundary");
      const analyze = vi.fn(async () => {
        order.push("analysis");
        throw stop;
      });
      const gateway = vi.fn(async () => {
        order.push("gateway-prepare");
        return { payload: { plan } };
      });
      const executeNodeHostCommand = evaluate(
        "executeNodeHostCommand",
        {
          crypto,
          console: { info },
          process: { env: { MICROCLAW_WINDOWS_NODE_MXC_APPROVAL_COMPAT: gate } },
          resolveNodeExecutionTarget: vi.fn().mockResolvedValue(target),
          resolveExecHostApprovalContext: vi.fn().mockResolvedValue({
            hostSecurity: "allowlist",
            hostAsk: "always",
            askFallback: "deny",
          }),
          callGatewayTool: gateway,
          parsePreparedSystemRunPayload: (payload: unknown) => payload,
          findMicroclawUnresolvedNodeRun: () => null,
          analyzeNodeApprovalRequirement: analyze,
        },
        true,
      );
      const params = {
        command: "PRIVATE COMMAND",
        agentId: "PRIVATE INPUT AGENT",
        sessionKey: "PRIVATE INPUT SESSION",
        toolCallId: "PRIVATE TOOL ID",
        security: "allowlist",
        ask: "always",
      };
      await expect(executeNodeHostCommand(params)).rejects.toBe(stop);
      expect(gateway).toHaveBeenCalledExactlyOnceWith(
        "node.invoke",
        { timeoutMs: 15_000 },
        expect.objectContaining({
          nodeId: target.nodeId,
          command: "system.run.prepare",
          params: {
            command: target.argv,
            security: "allowlist",
            ask: "always",
            rawCommand: params.command,
            agentId: params.agentId,
            sessionKey: params.sessionKey,
          },
        }),
      );
      expect(analyze).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          request: params,
          target,
          prepared: expect.objectContaining({ plan, sessionKey: plan.sessionKey }),
          hostSecurity: "allowlist",
          hostAsk: "always",
        }),
      );
      expect(order).toEqual(
        gate === "1"
          ? ["node-prepare-input", "gateway-prepare", "node-prepare-output", "analysis"]
          : ["gateway-prepare", "analysis"],
      );
      if (gate === "1") {
        expect(info.mock.calls[0][1].request.sessionKey.hash).toBe(digest(params.sessionKey));
        expect(info.mock.calls[1][1].request.sessionKey.hash).toBe(digest(params.sessionKey));
        expect(info.mock.calls[1][1].plan.sessionKey.hash).toBe(digest(plan.sessionKey));
        expect(JSON.stringify(info.mock.calls)).not.toContain("PRIVATE");
      }
    },
  );

  it("applies deterministically once and rejects double application or duplicated/drifted anchors", () => {
    const input = original.text;
    const result = compat.patchPinnedOpenClawBashTools(input);
    expect(compat.patchPinnedOpenClawBashTools(input)).toBe(result);
    expect(result.match(/function logMicroclawMxcApprovalContext\(/g)).toHaveLength(1);
    expect(() => compat.patchPinnedOpenClawBashTools(result)).toThrow(/did not match exactly once/);
    for (const anchor of [
      compat.PINNED_BASH_TOOLS_HOST_SELECTION_SOURCE,
      compat.PINNED_BASH_TOOLS_PREPARED_SOURCE,
    ]) {
      expect(() => compat.patchPinnedOpenClawBashTools(`${input}\n${anchor}`)).toThrow(
        /did not match exactly once/,
      );
      expect(() =>
        compat.patchPinnedOpenClawBashTools(input.replace(anchor, "/* unsupported anchor */")),
      ).toThrow(/did not match exactly once/);
    }
  });
});
