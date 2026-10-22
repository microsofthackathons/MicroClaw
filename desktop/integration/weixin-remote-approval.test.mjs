import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  send: vi.fn().mockResolvedValue({ messageId: "test-provider-client" }),
  error: vi.fn(),
  process: vi.fn(),
  getUpdates: vi.fn(),
  saveCursor: vi.fn(),
  monitorTransport: null,
}));
vi.mock("../../plugins/openclaw-weixin/src/auth/accounts.js", () => ({
  isActiveWeixinAccount: () => true,
  onWeixinAccountChanged: () => () => {},
  watchWeixinAccountState: () => () => {},
}));
vi.mock("../../plugins/openclaw-weixin/src/auth/pairing.js", () => ({
  readFrameworkAllowFromList: () => ["owner@im.wechat"],
}));
vi.mock("../../plugins/openclaw-weixin/src/messaging/debug-mode.js", () => ({
  isDebugMode: () => false,
}));
vi.mock("../../plugins/openclaw-weixin/src/config/reply-progress.js", () => ({
  resolveReplyProgressMessagesEnabled: () => false,
}));
vi.mock("../../plugins/openclaw-weixin/src/messaging/inbound.js", () => ({
  getContextToken: () => "test-context",
  setContextToken: () => {},
  getContextTokenFromMsgContext: () => "test-context",
  weixinMessageToMsgContext: (message, accountId) => ({
    From: message.from_user_id,
    To: message.from_user_id,
    Body: message.item_list?.[0]?.text_item?.text,
    AccountId: accountId,
    Provider: "openclaw-weixin",
  }),
  isMediaItem: () => false,
}));
vi.mock("../../plugins/openclaw-weixin/src/messaging/send.js", () => ({
  sendMessageWeixin: mocks.send,
}));
vi.mock("../../plugins/openclaw-weixin/src/messaging/process-message.js", async (original) => ({
  ...(await original()),
  processOneMessage: mocks.process,
}));
vi.mock("../../plugins/openclaw-weixin/src/security/remote-approval.js", async (original) => {
  const actual = await original();
  return {
    ...actual,
    WeixinRemoteApprovalTransport: class extends actual.WeixinRemoteApprovalTransport {
      constructor(options) {
        super(options);
        if (mocks.monitorTransport) return mocks.monitorTransport;
      }
    },
  };
});
vi.mock("../../plugins/openclaw-weixin/src/api/api.js", () => ({
  getUpdates: mocks.getUpdates,
  classifyFetchError: () => ({ type: "test", description: "test" }),
}));
vi.mock("../../plugins/openclaw-weixin/src/api/config-cache.js", () => ({
  WeixinConfigManager: class {
    async getForUser() {
      return {};
    }
  },
}));
vi.mock("../../plugins/openclaw-weixin/src/api/session-guard.js", () => ({
  STALE_TOKEN_ERRCODE: 40001,
  pauseSession: () => {},
  getRemainingPauseMs: () => 0,
}));
vi.mock("../../plugins/openclaw-weixin/src/storage/sync-buf.js", () => ({
  getSyncBufFilePath: () => "test-only-cursor.json",
  loadGetUpdatesBuf: () => "cursor-0",
  saveGetUpdatesBuf: mocks.saveCursor,
}));
vi.mock("../../plugins/openclaw-weixin/src/security/mxc-policy.js", () => ({
  isMxcWeixinIngressReleased: () => true,
  assertMxcWeixinIngressReleased: () => {},
  waitForMxcWeixinIngressRelease: () => {},
  isWeixinSenderAllowedByPolicy: (sender, allowed) => allowed.includes(sender.toLowerCase()),
}));
vi.mock("../../plugins/openclaw-weixin/src/util/logger.js", () => ({
  logger: {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: mocks.error,
    withAccount: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: mocks.error }),
  },
}));

import { interceptWeixinRemoteApprovalMessage } from "../../plugins/openclaw-weixin/src/messaging/process-message.js";
import { monitorWeixinProvider } from "../../plugins/openclaw-weixin/src/monitor/monitor.js";
import { parseWeixinUpdatesJson } from "../../plugins/openclaw-weixin/src/api/provider-metadata.js";
import { WeixinRemoteApprovalTransport } from "../../plugins/openclaw-weixin/src/security/remote-approval.js";
import { buildMicroclawWindowsNodeShellCommand } from "../src/openclaw-approval-replay-compat.mjs";
import { normalizeWindowsNodeMxcGatewayApproval } from "../src/windows-node-mxc";
import {
  commitMxcApprovalDecision,
  renderMxcApprovalTerminal,
  WindowsNodeMxcApprovalLifecycle,
} from "../src/windows-node-mxc-approval-lifecycle";
import {
  durableApprovalIdentityFromGateway,
  WindowsNodeMxcDurableApprovalStore,
} from "../src/windows-node-mxc-durable-approvals";
import {
  deliverWeixinRemoteApproval,
  findWeixinApprovalSource,
  bindWeixinApprovalRun,
} from "../src/windows-node-mxc-weixin-remote-approval-delivery";
import { runPinnedApprovalRequests } from "./pinned-approval-fixture.mjs";
import { createPinnedAgentRunStartNotifier } from "./pinned-session-fixture.mjs";
import { exactField, windowsCommand } from "./windows-command-fixture.mjs";
import {
  normalizeWeixinRemoteApprovalOwner,
  projectWeixinRemoteApprovalRuntimeConfiguration,
  WEIXIN_NATIVE_DURABLE_CONSENT_SCOPE,
  weixinRemoteApprovalConsentHash,
  WindowsNodeMxcWeixinRemoteApprovalBroker,
} from "../src/windows-node-mxc-weixin-remote-approval";
import { WindowsNodeMxcWeixinRemoteApprovalServer } from "../src/windows-node-mxc-weixin-remote-approval-transport";

const root = String.raw`C:\Users\sunt\Desktop`;
const operations = [
  ["folder creation", `New-Item -ItemType Directory -Path '${root}\\privacy_test_folder' -Force`],
  ["file creation", `New-Item -ItemType File -Path '${root}\\approval sample.txt' -Force`],
  [
    "content modification",
    `Set-Content -LiteralPath '${root}\\approval sample.txt' -Value '0' -Encoding utf8`,
  ],
  ["content append", `Add-Content -Path '${root}\\approval sample.txt' -Value '1'`],
  ["content clearing", `Clear-Content -LiteralPath '${root}\\approval sample.txt'`],
  ["file deletion", `Remove-Item -LiteralPath '${root}\\approval sample.txt' -Force`],
  ["recursive folder deletion", `Remove-Item -Path '${root}\\approval folder' -Recurse -Force`],
];
const sessionKey = "agent:main:main";
const security = {
  gatewayGeneration: "test-generation",
  policyFingerprint: "b".repeat(64),
  nodeId: "test-node",
  activationLeaseHash: "c".repeat(64),
  requestedMode: "limited-dacl",
  effectiveMode: "appcontainer-dacl",
};
const executablePath = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
const executableHash = createHash("sha256")
  .update(
    process.platform === "win32"
      ? readFileSync(executablePath)
      : Buffer.from("test-only-interpreter-fixture"),
  )
  .digest("hex");

function normalizedApproval(operation = operations[0][1], envelope = {}) {
  // Pinned wrapper plus source-derived replay of the unchanged host's declaration stripping/quoting.
  // This is not a captured historical Gateway payload. Windows uses the actual interpreter file hash.
  const input = `# [declare-access]rw:${root}[/declare-access]\npowershell -NoProfile -Command "${operation}"`;
  const gatewayArgv = buildMicroclawWindowsNodeShellCommand(input, { SystemRoot: "C:\\Windows" });
  const cleanCommand = input.slice(input.indexOf("\n") + 1);
  const argv = gatewayArgv.map((argument) => (argument === input ? cleanCommand : argument));
  const approval = normalizeWindowsNodeMxcGatewayApproval(
    {
      id: `test-approval-${randomUUID()}`,
      request: {
        host: "node",
        nodeId: security.nodeId,
        runId: "fixture-run",
        toolCallId: "fixture-tool",
        turnSourceChannel: "openclaw-weixin",
        turnSourceAccountId: "bot",
        turnSourceTo: "OWNER@IM.WECHAT",
        remoteApprovalOrigin: {
          contract: "microclaw.gateway-approval-origin.v1",
          gatewayGeneration: security.gatewayGeneration,
          agentId: "main",
          runSessionKey: sessionKey,
          executionSessionKey: sessionKey,
          runId: "fixture-run",
          toolCallId: "fixture-tool",
          nodeId: security.nodeId,
          channel: "openclaw-weixin",
          accountId: "bot",
          to: "OWNER@IM.WECHAT",
        },
        systemRunPlan: {
          argv,
          commandText: windowsCommand(argv),
          commandPreview: input,
          executablePath: gatewayArgv[0],
          executableSha256: executableHash,
          cwd: null,
          cwdBinding: "isolated-scratch:v1",
          agentId: "main",
          sessionKey,
          declaredAccess: [{ access: "rw", path: root }],
        },
      },
      allowedDecisions: ["allow-once", "allow-always", "deny"],
      ...envelope,
    },
    security.nodeId,
    security.gatewayGeneration,
  );
  if (!approval) throw new Error("Production normalization rejected the replayed Gateway plan");
  return approval;
}

function phoneMessage(text, cursor = 42, extra = {}) {
  return {
    message_id: 1000 + cursor,
    seq: cursor,
    from_user_id: "OWNER@IM.WECHAT",
    to_user_id: "BOT@IM.WECHAT",
    message_type: 1,
    create_time_ms: Date.now(),
    item_list: [{ type: 1, text_item: { text } }],
    ...extra,
  };
}

describe("production source, plan, broker, pipe, decision and phone lifecycle", () => {
  const resources = [];
  const directories = [];
  const lifecycles = [];
  afterEach(async () => {
    for (const lifecycle of lifecycles.splice(0)) await lifecycle.cancel("test-cleanup");
    for (const resource of resources.splice(0)) resource.close();
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
    vi.unstubAllEnvs();
    mocks.send.mockReset().mockResolvedValue({ messageId: "test-provider-client" });
    mocks.error.mockClear();
    mocks.process.mockReset();
    mocks.getUpdates.mockReset();
    mocks.saveCursor.mockReset();
    mocks.monitorTransport = null;
  });

  async function pipeline(
    approval = normalizedApproval(),
    durableConsent = true,
    scopeOverride = undefined,
  ) {
    const sources = new Map();
    const configuration = projectWeixinRemoteApprovalRuntimeConfiguration(
      {
        enabled: true,
        ...(durableConsent
          ? { consentScope: scopeOverride ?? WEIXIN_NATIVE_DURABLE_CONSENT_SCOPE }
          : {}),
        owner: normalizeWeixinRemoteApprovalOwner(
          "bot",
          "owner@im.wechat",
          "2026-10-20T00:00:00.000Z",
        ),
      },
      true,
    );
    const readWireOwner = () => ({ accountId: "bot", userId: "OWNER@IM.WECHAT" });
    const broker = new WindowsNodeMxcWeixinRemoteApprovalBroker(undefined, readWireOwner);
    broker.configure(configuration);
    const directory = mkdtempSync(path.join(os.tmpdir(), "microclaw-weixin-approval-test-"));
    directories.push(directory);
    const store = new WindowsNodeMxcDurableApprovalStore(path.join(directory, "approvals.json"));
    const resolveGateway = vi.fn().mockResolvedValue(undefined);
    const resolved = [];
    const states = [];
    const diagnostics = [];
    const errors = [];
    const expiresAtUnixMs = Date.now() + 60_000;
    let challengeId;
    let clock;
    let deliveryAttempt;
    let currentApproval = approval;
    let lifecycle;
    const pipe =
      process.platform === "win32"
        ? `\\\\.\\pipe\\microclaw-delivery-test-${randomUUID()}`
        : path.join(directory, "approval.sock");
    vi.stubEnv("MICROCLAW_MXC_WEIXIN_REMOTE_APPROVAL_PIPE", pipe);
    vi.stubEnv("MICROCLAW_MXC_WEIXIN_REMOTE_APPROVAL_TOKEN", "test-pipe-secret");
    const server = new WindowsNodeMxcWeixinRemoteApprovalServer(
      pipe,
      "test-pipe-secret",
      async (source) => {
        if (source.sourcePhase === "start" && source.direct && !source.quoted && !source.forwarded)
          sources.set(source.sessionKey, {
            ...source,
            gatewayGeneration: security.gatewayGeneration,
            runIds: [],
          });
        if (source.sourcePhase === "run")
          bindWeixinApprovalRun(sources, source, security.gatewayGeneration);
        if (source.sourcePhase !== "candidate") return { consumed: false };
        const result = broker.resolveCandidate({
          ...source,
          requests: [{ approval: currentApproval }],
          security,
        });
        if (result.status === "approved" || result.status === "denied") {
          try {
            await lifecycle.decide(result.decision, "wechat");
          } catch {
            broker.failResolution(result.challengeId, "test-resolution-rejected");
          }
          return { consumed: true, approvalActive: lifecycle.pending };
        }
        return {
          consumed: result.consumed,
          acknowledgement: result.acknowledgement,
          approvalActive: lifecycle.pending,
        };
      },
    );
    resources.push(server);
    await server.start();
    const identity = durableApprovalIdentityFromGateway(approval, security.policyFingerprint);
    if (!identity)
      throw new Error("The normalized plan must support the existing exact durable identity");
    lifecycle = new WindowsNodeMxcApprovalLifecycle(expiresAtUnixMs, {
      now: () => clock ?? Date.now(),
      resolve: (decision, origin) =>
        commitMxcApprovalDecision({
          decision,
          origin,
          expiresAtUnixMs,
          now: () => clock ?? Date.now(),
          resolveGateway,
          persistDurable: async () => {
            await store.add({
              ...identity,
              ...(origin === "wechat"
                ? { weixinConsentHash: weixinRemoteApprovalConsentHash(configuration) }
                : {}),
            });
          },
          persistenceError: (error) => errors.push(error),
        }),
      terminal: async (outcome) => {
        broker.settleApproval(
          approval.id,
          outcome.status === "accepted" ? outcome.decision : outcome.status,
          outcome.origin,
        );
        resolved.push({ requestId: approval.id, ...outcome });
        await deliveryAttempt;
        await server.deliver({
          accountId: "bot",
          to: "OWNER@IM.WECHAT",
          text: renderMxcApprovalTerminal(outcome, "en-US"),
          ...(challengeId ? { terminalChallengeId: challengeId } : {}),
        });
      },
      error: (...error) => errors.push(error),
    });
    lifecycles.push(lifecycle);
    lifecycle.start();
    const transport = new WeixinRemoteApprovalTransport({
      accountId: "bot",
      baseUrl: "https://weixin.invalid",
      token: "test-account-token",
      error: mocks.error,
      diagnostic: (record) => diagnostics.push(record),
    });
    resources.unshift(transport);
    await transport.start();
    const resolveAgentRoute = vi.fn(() => ({ agentId: "main", sessionKey }));
    const deps = {
      accountId: "bot",
      token: "test-account-token",
      config: { session: { dmScope: "main" } },
      channelRuntime: { routing: { resolveAgentRoute } },
      remoteApprovalTransport: transport,
    };
    return {
      approval,
      sources,
      broker,
      readWireOwner,
      server,
      transport,
      deps,
      resolveAgentRoute,
      store,
      lifecycle,
      resolveGateway,
      resolved,
      states,
      diagnostics,
      errors,
      expiresAtUnixMs,
      changeApproval: (value) => {
        currentApproval = value;
      },
      expire: () => {
        clock = expiresAtUnixMs;
      },
      async deliver(overrides = {}) {
        deliveryAttempt = deliverWeixinRemoteApproval({
          approval,
          configuration,
          readWireOwner,
          source: findWeixinApprovalSource(sources, approval),
          security,
          server,
          broker,
          expiresAtUnixMs,
          locale: "en-US",
          isPending: () => lifecycle.pending,
          challenge: (delivery) => {
            challengeId = delivery.challengeId;
          },
          state: (value) => states.push(value),
          diagnostic: (reason) => diagnostics.push({ reason }),
          ...overrides,
        });
        return deliveryAttempt;
      },
      async start() {
        expect(
          await interceptWeixinRemoteApprovalMessage(
            phoneMessage("Perform the requested filesystem operation"),
            deps,
            "start",
          ),
        ).toBe(false);
        await transport.intercept({
          message: phoneMessage("Perform the requested filesystem operation"),
          agentId: "main",
          sessionKey,
          sourcePhase: "run",
          runId: approval.origin.runId,
        });
        return this.deliver();
      },
      reply: (text, cursor = 43, extra = {}) =>
        interceptWeixinRemoteApprovalMessage(phoneMessage(text, cursor, extra), deps),
    };
  }

  const cases = operations.flatMap(([operation, script]) =>
    ["desktop", "wechat"].flatMap((origin) =>
      ["allow-once", "allow-always", "deny"].map((decision) => [
        operation,
        script,
        origin,
        decision,
      ]),
    ),
  );

  it("routes the real pinned builder/schema/handler's distinct policy/run lineage through source cache, broker, pipe and sender", async () => {
    const base = normalizedApproval();
    const executionSession = "agent:main:sandbox:policy-execution-fixture";
    const results = runPinnedApprovalRequests(
      {
        argv: [base.executable, ...base.arguments],
        commandText: base.command,
        commandPreview: `# [declare-access]rw:${root}[/declare-access]\n${operations[0][1]}`,
        cwd: null,
        cwdBinding: base.canonicalCwd,
        agentId: "main",
        sessionKey: executionSession,
        executablePath: base.executablePath,
        executableSha256: base.executableSha256,
        declaredAccess: base.declaredAccess,
      },
      "OWNER@IM.WECHAT",
    );
    const trusted = results.find((result) => result.kind === "trusted");
    const approval = normalizeWindowsNodeMxcGatewayApproval(
      {
        id: "actual-approval",
        request: trusted.request,
      },
      security.nodeId,
      security.gatewayGeneration,
    );
    expect(approval.origin).toMatchObject({
      runSessionKey: sessionKey,
      executionSessionKey: executionSession,
      runId: "actual-run",
      toolCallId: "actual-tool",
    });
    expect(approval.sessionKey).toBe(executionSession);
    const state = await pipeline(approval, false);
    expect(findWeixinApprovalSource(state.sources, approval)).toBeUndefined();
    const delivery = await state.start();
    expect(delivery).not.toBeNull();
    expect(state.diagnostics).toContainEqual({ reason: "prompt-delivered" });
    expect(mocks.send).toHaveBeenCalled();
    expect(state.sources.has(sessionKey)).toBe(true);
    expect(state.sources.has(executionSession)).toBe(false);
    expect(
      durableApprovalIdentityFromGateway(approval, security.policyFingerprint).sessionKey,
    ).toBe(executionSession);
    for (const kind of ["caller-forgery", "cross-agent", "cross-run"]) {
      expect(results.find((result) => result.kind === kind).request).toBeNull();
    }
    expect(
      results.find((result) => result.kind === "untrusted").request.remoteApprovalOrigin,
    ).toBeUndefined();
    for (const kind of [
      "producer-without-channel",
      "producer-without-account",
      "producer-without-recipient",
    ]) {
      const request = results.find((result) => result.kind === kind).request;
      expect(request).not.toBeNull();
      expect(request.remoteApprovalOrigin).toBeUndefined();
      const local = normalizeWindowsNodeMxcGatewayApproval(
        { id: kind, request },
        security.nodeId,
        security.gatewayGeneration,
      );
      expect(local.origin).toBeUndefined();
      expect(await state.deliver({ approval: local })).toBeNull();
      expect(state.states.at(-1).reason).toBe("source-origin-unavailable");
    }
    for (const kind of [
      "valid-other-run",
      "valid-other-channel",
      "valid-other-account",
      "valid-other-recipient",
    ]) {
      const independentlyAuthorized = results.find((result) => result.kind === kind).request;
      expect(independentlyAuthorized).not.toBeNull();
      const other = normalizeWindowsNodeMxcGatewayApproval(
        {
          id: kind,
          request: independentlyAuthorized,
        },
        security.nodeId,
        security.gatewayGeneration,
      );
      expect(other.origin).toBeDefined();
      const sent = mocks.send.mock.calls.length;
      expect(await state.deliver({ approval: other })).toBeNull();
      expect(state.states.at(-1)).toMatchObject({
        state: "local-only",
        reason: kind === "valid-other-run" ? "source-run-mismatch" : "source-provider-mismatch",
      });
      expect(mocks.send).toHaveBeenCalledTimes(sent);
    }
    for (const remoteApprovalOrigin of [undefined, { contract: "invalid-present-origin" }]) {
      const other = normalizeWindowsNodeMxcGatewayApproval(
        {
          id: "legacy-key-without-origin",
          request: {
            ...trusted.request,
            sessionKey,
            systemRunPlan: { ...trusted.request.systemRunPlan, sessionKey },
            remoteApprovalOrigin,
          },
        },
        security.nodeId,
        security.gatewayGeneration,
      );
      expect(other.sessionKey).toBe(sessionKey);
      expect(other.origin).toBeUndefined();
      expect(findWeixinApprovalSource(state.sources, other)).toBeUndefined();
      expect(await state.deliver({ approval: other })).toBeNull();
      expect(state.states.at(-1).reason).toBe("source-origin-unavailable");
    }
    for (const patch of [
      { gatewayGeneration: "old-generation" },
      { runId: "another-run" },
      { toolCallId: "another-tool" },
      { agentId: "another-agent" },
      { executionSessionKey: sessionKey },
    ]) {
      const rejected = normalizeWindowsNodeMxcGatewayApproval(
        {
          id: "mismatched-approval",
          request: {
            ...trusted.request,
            remoteApprovalOrigin: { ...trusted.request.remoteApprovalOrigin, ...patch },
          },
        },
        security.nodeId,
        security.gatewayGeneration,
      );
      expect(rejected.sessionKey).toBe(executionSession);
      expect(rejected.origin).toBeUndefined();
      expect(findWeixinApprovalSource(state.sources, rejected)).toBeUndefined();
    }
    state.sources.set(sessionKey, { ...state.sources.get(sessionKey), agentId: "other" });
    await expect(state.deliver()).resolves.toBeNull();
    expect(state.diagnostics).toContainEqual({ reason: "source-agent-mismatch" });
  }, 45_000);

  it.each([false, true])(
    "delivers the real folder-plan pipeline with lossless provider int64 wire metadata (quoted=%s)",
    async (quoted) => {
      const state = await pipeline(normalizedApproval(), false);
      const wireMessage = (text, id, seq) => {
        const encode = (value) => (quoted ? JSON.stringify(value) : value);
        const wire = JSON.stringify({ ...phoneMessage(text), message_id: "ID", seq: "SEQ" })
          .replace('"ID"', encode(id))
          .replace('"SEQ"', encode(seq));
        return parseWeixinUpdatesJson(`{"msgs":[${wire}]}`).msgs[0];
      };
      await interceptWeixinRemoteApprovalMessage(
        wireMessage(
          "Create the requested Desktop folder",
          "18446744073709551000",
          "9007199254740993",
        ),
        state.deps,
        "start",
      );
      expect(state.sources.get(sessionKey)).toMatchObject({
        messageId: "18446744073709551000",
        cursor: "9007199254740993",
      });
      await state.transport.intercept({
        message: wireMessage(
          "Create the requested Desktop folder",
          "18446744073709551000",
          "9007199254740993",
        ),
        agentId: "main",
        sessionKey,
        sourcePhase: "run",
        runId: state.approval.origin.runId,
      });
      const delivery = await state.deliver();
      expect(delivery).not.toBeNull();
      expect(mocks.send).toHaveBeenCalledOnce();
      const code = /#([23456789A-Z]{8})\]/.exec(delivery.text)[1];
      await interceptWeixinRemoteApprovalMessage(
        wireMessage(`1 ${code}`, "18446744073709551001", "9007199254740994"),
        state.deps,
      );
      expect(state.resolveGateway).toHaveBeenCalledExactlyOnceWith("allow-once");
      expect(state.store.list()).toHaveLength(0);
    },
  );

  it.each([
    ["1", "allow-once"],
    ["3", "deny"],
  ])(
    "preserves legacy code-bound %s across the real pipeline but refuses durable authority",
    async (digit, decision) => {
      const state = await pipeline(normalizedApproval(), false);
      const delivery = await state.start();
      expect(delivery.text).toContain("renew local native consent");
      const code = /#([23456789A-Z]{8})\]/.exec(delivery.text)[1];
      expect(await state.reply(`2 ${code}`)).toBe(true);
      expect(state.resolveGateway).not.toHaveBeenCalled();
      expect(state.store.list()).toHaveLength(0);
      expect(await state.reply(`${digit} ${code}`, 44)).toBe(true);
      expect(state.resolveGateway).toHaveBeenCalledExactlyOnceWith(decision);
      expect(state.resolved[0]).toMatchObject({ decision, origin: "wechat" });
      expect(state.store.list()).toHaveLength(0);
    },
  );
  it("does not persist a phone Always through an invalid runtime consent marker", async () => {
    const state = await pipeline(normalizedApproval(), true, "invalid-native-scope");
    const delivery = await state.start();
    const code = /#([23456789A-Z]{8})\]/.exec(delivery.text)[1];
    expect(await state.reply(`2 ${code}`)).toBe(true);
    expect(state.resolveGateway).not.toHaveBeenCalled();
    expect(state.store.list()).toHaveLength(0);
    expect(await state.reply(`1 ${code}`, 44)).toBe(true);
    expect(state.resolveGateway).toHaveBeenCalledExactlyOnceWith("allow-once");
    expect(state.store.list()).toHaveLength(0);
  });
  it.each(cases)("%s: %s resolves from %s as %s", async (_operation, script, origin, decision) => {
    const state = await pipeline(normalizedApproval(script));
    const delivery = await state.start();
    expect(delivery).not.toBeNull();
    expect(state.resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({ channel: "openclaw-weixin" }),
    );
    expect(state.sources.get(sessionKey)).toMatchObject({
      senderId: "OWNER@IM.WECHAT",
      agentId: "main",
      sessionKey,
    });
    expect(JSON.parse(exactField(delivery.text, "Request 1 command"))).toBe(state.approval.command);
    expect(delivery.text).toContain(executableHash);
    expect(state.states.at(-1)).toMatchObject({ state: "sent", replyMode: "code-required" });
    if (origin === "desktop") await state.lifecycle.decide(decision, origin);
    else {
      const code = /#([23456789A-Z]{8})\]/.exec(delivery.text)[1];
      const option = decision === "allow-once" ? "1" : decision === "allow-always" ? "2" : "3";
      expect(await state.reply(`${option} ${code}`)).toBe(true);
    }
    expect(state.resolveGateway).toHaveBeenCalledExactlyOnceWith(
      decision === "allow-always" ? "allow-once" : decision,
    );
    expect(state.resolved).toEqual([
      expect.objectContaining({
        requestId: state.approval.id,
        status: "accepted",
        decision,
        origin,
      }),
    ]);
    expect(mocks.send).toHaveBeenCalledTimes(2);
    expect(mocks.send.mock.calls[1][0].text).toContain(`(${origin})`);
    expect(mocks.send.mock.calls[1][0].text).toContain("not command execution success");
    expect(state.store.list()).toHaveLength(decision === "allow-always" ? 1 : 0);
    if (decision === "allow-always") {
      const record = state.store.list()[0];
      expect(record.argv).toEqual([state.approval.executable, ...state.approval.arguments]);
      expect(record.declaredAccess).toEqual(state.approval.declaredAccess);
      expect(record.sessionKey).toBe(sessionKey);
      expect(record.weixinConsentHash).toEqual(
        origin === "wechat" ? expect.stringMatching(/^[a-f0-9]{64}$/) : undefined,
      );
    }
    expect(await state.reply("1", 44)).toBe(false);
    expect(state.resolveGateway).toHaveBeenCalledTimes(1);
  });

  it("intercepts bare/invalid/malformed metadata before the REAL monitor agent queue without extending its deadline", async () => {
    const state = await pipeline();
    await state.start();
    mocks.monitorTransport = state.transport;
    const abort = new AbortController();
    mocks.getUpdates
      .mockResolvedValueOnce({
        ret: 0,
        get_updates_buf: "cursor-1",
        msgs: [
          phoneMessage("not a decision", 43),
          phoneMessage("1", 44),
          phoneMessage("2", 45, { seq: undefined }),
        ],
      })
      .mockImplementationOnce(async () => {
        abort.abort();
        throw new Error("test abort");
      });
    await monitorWeixinProvider({
      ...state.deps,
      baseUrl: "https://weixin.invalid",
      cdnBaseUrl: "https://cdn.invalid",
      abortSignal: abort.signal,
      longPollTimeoutMs: 1,
    });
    expect(mocks.process).not.toHaveBeenCalled();
    expect(state.resolveGateway).not.toHaveBeenCalled();
    expect(state.lifecycle.pending).toBe(true);
    expect(state.lifecycle.expiresAtUnixMs).toBe(state.expiresAtUnixMs);
    expect(mocks.send.mock.calls.map(([value]) => value.text).join("\n")).toContain(
      "current prompt's choices and request code",
    );
    expect(state.diagnostics).toContainEqual(
      expect.objectContaining({ code: "provider-cursor-unavailable" }),
    );
  });

  it.each([
    [{ sessionKey: "agent:main:other" }, "source-session-mismatch"],
    [{ agentId: "other" }, "source-agent-mismatch"],
  ])(
    "reports exact route mismatch rather than silently dropping the prompt: %j",
    async (change, reason) => {
      const state = await pipeline();
      await interceptWeixinRemoteApprovalMessage(phoneMessage("request"), state.deps, "start");
      await state.transport.intercept({
        message: phoneMessage("request"),
        agentId: "main",
        sessionKey,
        sourcePhase: "run",
        runId: state.approval.origin.runId,
      });
      const source = { ...state.sources.get(sessionKey), ...change };
      expect(await state.deliver({ source })).toBeNull();
      expect(state.states.at(-1)).toMatchObject({ state: "local-only", reason });
      expect(mocks.send).not.toHaveBeenCalled();
    },
  );

  it.each([
    [{ seq: undefined }, "provider-cursor-unavailable"],
    [{ seq: "042" }, "provider-cursor-unavailable"],
    [{ message_id: undefined }, "provider-message-id-unavailable"],
    [{ message_id: -1 }, "provider-message-id-unavailable"],
    [{ from_user_id: 42 }, "provider-identity-invalid"],
  ])("fails closed with shape diagnostics for provider metadata %j", async (change, reason) => {
    const state = await pipeline();
    await interceptWeixinRemoteApprovalMessage(
      phoneMessage("request", 42, change),
      state.deps,
      "start",
    );
    expect(state.sources.size).toBe(0);
    expect(state.diagnostics).toContainEqual(expect.objectContaining({ code: reason }));
    expect(await state.deliver()).toBeNull();
    expect(state.states.at(-1).reason).toBe("source-unavailable");
    expect(JSON.stringify(state.diagnostics)).not.toContain("test-account-token");
  });

  it.each(["private unclassified content", "Bearer example-secret"])(
    "keeps content local with a data-free phone notice and real terminal receipt: %s",
    async (content) => {
      const state = await pipeline(
        normalizedApproval(`Set-Content -Path '${root}\\sample.txt' -Value '${content}'`),
      );
      expect(await state.start()).toBeNull();
      expect(state.states.at(-1)).toMatchObject({
        state: "local-only",
        reason: expect.stringMatching(/^presentation-/),
      });
      expect(mocks.send.mock.calls[0][0].text).not.toContain(content);
      expect(mocks.send.mock.calls[0][0].text).not.toContain("sample.txt");
      await state.lifecycle.decide("deny", "desktop");
      expect(mocks.send).toHaveBeenCalledTimes(2);
      expect(state.resolved[0]).toMatchObject({ decision: "deny", origin: "desktop" });
    },
  );

  it("does not authorize after unconfirmed delivery or automatically resend", async () => {
    const state = await pipeline();
    mocks.send.mockRejectedValueOnce(new Error("test transport lost"));
    expect(await state.start()).toBeNull();
    expect(state.states.at(-1)).toMatchObject({
      state: "unconfirmed",
      reason: "delivery-unconfirmed",
    });
    const code = /#([23456789A-Z]{8})\]/.exec(mocks.send.mock.calls[0][0].text)[1];
    expect(await state.reply(`1 ${code}`)).toBe(true);
    expect(state.resolveGateway).not.toHaveBeenCalled();
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });

  it.each([
    [null, "security-unavailable"],
    ["missing-transport", "transport-unavailable"],
  ])("reports security/transport failures and grants nothing: %s", async (failure, reason) => {
    const state = await pipeline();
    await interceptWeixinRemoteApprovalMessage(phoneMessage("request"), state.deps, "start");
    await state.transport.intercept({
      message: phoneMessage("request"),
      agentId: "main",
      sessionKey,
      sourcePhase: "run",
      runId: state.approval.origin.runId,
    });
    const overrides = failure === null ? { security: null } : { server: null };
    expect(await state.deliver(overrides)).toBeNull();
    expect(state.states.at(-1)).toMatchObject({ state: "local-only", reason });
    expect(state.resolveGateway).not.toHaveBeenCalled();
  });

  it("binds the actual dispatch callback to the original provider message, before approval delivery; ignores callbacks after completion", async () => {
    const { processOneMessage } = await vi.importActual(
      "../../plugins/openclaw-weixin/src/messaging/process-message.js",
    );
    const state = await pipeline(normalizedApproval(), false);
    const order = [];
    const intercept = state.transport.intercept.bind(state.transport);
    vi.spyOn(state.transport, "intercept").mockImplementation(async (params) => {
      order.push(params.sourcePhase);
      return intercept(params);
    });
    let callback;
    const full = parseWeixinUpdatesJson(
      JSON.stringify({
        msgs: [
          {
            ...phoneMessage("Create the requested folder"),
            message_id: "RAW_PROVIDER_ID",
          },
        ],
      }).replace('"RAW_PROVIDER_ID"', "18446744073709551000"),
    ).msgs[0];
    const deps = {
      ...state.deps,
      log: vi.fn(),
      errLog: mocks.error,
      channelRuntime: {
        ...state.deps.channelRuntime,
        session: {
          resolveStorePath: () => "test-only-store",
          recordInboundSession: async () => {
            order.push("record");
          },
        },
        reply: {
          finalizeInboundContext: (ctx) => ctx,
          resolveHumanDelayConfig: () => undefined,
          createReplyDispatcherWithTyping: () => ({
            dispatcher: {},
            replyOptions: {},
            markDispatchIdle: vi.fn(),
          }),
          withReplyDispatcher: ({ run }) => run(),
          dispatchReplyFromConfig: async ({ replyOptions }) => {
            order.push("dispatch");
            callback = replyOptions.onAgentRunStart;
            const notify = createPinnedAgentRunStartNotifier(callback, state.approval.origin.runId);
            notify();
            notify();
            await vi.waitFor(() =>
              expect(state.sources.get(sessionKey).runIds).toEqual([state.approval.origin.runId]),
            );
            order.push("delivery");
            expect(await state.deliver()).not.toBeNull();
          },
        },
      },
    };
    await processOneMessage(full, deps);
    expect(order).toEqual(["start", "record", "dispatch", "run", "delivery"]);
    expect(state.sources.get(sessionKey)).toMatchObject({
      messageId: "18446744073709551000",
      cursor: "42",
      runIds: [state.approval.origin.runId],
    });
    callback("late-other-run", "late-test-identity");
    expect(order).toEqual(["start", "record", "dispatch", "run", "delivery"]);
    expect(mocks.error).toHaveBeenCalledWith(
      "weixin remote approval reason=source-run-callback-inactive",
    );
  });

  it("cannot bind a missing/late callback to the next message, a reconnected generation, or a completed source", async () => {
    const state = await pipeline(normalizedApproval(), false);
    await interceptWeixinRemoteApprovalMessage(phoneMessage("original"), state.deps, "start");
    expect(await state.deliver()).toBeNull();
    expect(state.states.at(-1).reason).toBe("source-run-mismatch");
    const original = state.sources.get(sessionKey);
    await interceptWeixinRemoteApprovalMessage(phoneMessage("next", 44), state.deps, "start");
    expect(
      bindWeixinApprovalRun(
        state.sources,
        { ...original, runId: state.approval.origin.runId },
        security.gatewayGeneration,
      ),
    ).toBeNull();
    const next = state.sources.get(sessionKey);
    expect(
      bindWeixinApprovalRun(
        state.sources,
        { ...next, runId: state.approval.origin.runId },
        "reconnected-generation",
      ),
    ).toBeNull();
    state.sources.clear();
    expect(
      bindWeixinApprovalRun(
        state.sources,
        { ...next, runId: state.approval.origin.runId },
        security.gatewayGeneration,
      ),
    ).toBeNull();
    expect(mocks.send).not.toHaveBeenCalled();
    expect(state.resolveGateway).not.toHaveBeenCalled();
  });

  it("consumes a reply across real transport disconnect without dispatch or an automatic decision", async () => {
    const state = await pipeline();
    const delivery = await state.start();
    state.server.close();
    await new Promise((resolve) => setImmediate(resolve));
    const code = /#([23456789A-Z]{8})\]/.exec(delivery.text)[1];
    expect(await state.reply(`1 ${code}`)).toBe(true);
    expect(state.resolveGateway).not.toHaveBeenCalled();
    expect(state.lifecycle.expiresAtUnixMs).toBe(state.expiresAtUnixMs);
  });

  it("preserves only a valid original Gateway expiry during production normalization", () => {
    const expiry = Date.now() + 30_000;
    expect(normalizedApproval(operations[0][1], { expiresAtMs: expiry }).expiresAtUnixMs).toBe(
      expiry,
    );
    for (const invalid of [null, "later", Number.NaN, -1]) {
      expect(() => normalizedApproval(operations[0][1], { expiresAtMs: invalid })).toThrow(
        "normalization rejected",
      );
    }
  });

  it("keeps changed exact arguments fenced and expiry performs actual denial with a timeout receipt", async () => {
    const state = await pipeline();
    const delivery = await state.start();
    state.changeApproval({
      ...state.approval,
      arguments: [...state.approval.arguments, "changed"],
    });
    const code = /#([23456789A-Z]{8})\]/.exec(delivery.text)[1];
    expect(await state.reply(`2 ${code}`)).toBe(true);
    expect(state.resolveGateway).not.toHaveBeenCalled();
    state.expire();
    await state.lifecycle.decide("deny", "timeout");
    expect(state.resolveGateway).toHaveBeenCalledExactlyOnceWith("deny");
    expect(state.resolved[0]).toMatchObject({ decision: "deny", origin: "timeout" });
    expect(mocks.send.mock.calls.at(-1)[0].text).toContain("(timeout)");
    expect(state.store.list()).toEqual([]);
  });

  it("lets the first Desktop decision win a concurrent phone Always reply and emits one receipt", async () => {
    const state = await pipeline();
    const delivery = await state.start();
    let finish;
    state.resolveGateway.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const desktop = state.lifecycle.decide("allow-once", "desktop");
    const code = /#([23456789A-Z]{8})\]/.exec(delivery.text)[1];
    expect(await state.reply(`2 ${code}`)).toBe(true);
    finish();
    await desktop;
    expect(state.resolveGateway).toHaveBeenCalledTimes(1);
    expect(state.resolved).toHaveLength(1);
    expect(state.resolved[0]).toMatchObject({ decision: "allow-once", origin: "desktop" });
    expect(state.store.list()).toEqual([]);
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });

  it("lets a phone decision win a concurrent Desktop denial, once", async () => {
    const state = await pipeline();
    const delivery = await state.start();
    let finish;
    state.resolveGateway.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const code = /#([23456789A-Z]{8})\]/.exec(delivery.text)[1];
    const phone = state.reply(`1 ${code}`);
    await vi.waitFor(() => expect(state.resolveGateway).toHaveBeenCalledTimes(1));
    await expect(state.lifecycle.decide("deny", "desktop")).rejects.toThrow("in progress");
    finish();
    await phone;
    expect(state.resolved).toEqual([
      expect.objectContaining({ decision: "allow-once", origin: "wechat" }),
    ]);
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });

  it("does not reactivate an old prompt whose sender completes after its terminal receipt", async () => {
    const state = await pipeline();
    const deliver = state.server.deliver.bind(state.server);
    vi.spyOn(state.server, "deliver").mockImplementation((params) =>
      deliver({ ...params, timeoutMs: 25 }),
    );
    let finishOldSend;
    mocks.send.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOldSend = resolve;
        }),
    );
    expect(await state.start()).toBeNull();
    await state.lifecycle.decide("deny", "desktop");
    finishOldSend({});
    await new Promise((resolve) => setImmediate(resolve));
    expect(state.transport.shouldReserveInbound(phoneMessage("ordinary message", 45))).toBe(false);
    expect(await state.reply("1", 45)).toBe(false);
    expect(state.resolveGateway).toHaveBeenCalledExactlyOnceWith("deny");
    expect(mocks.send).toHaveBeenCalledTimes(2);
  });
});
