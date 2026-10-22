import { createHash, randomUUID, randomBytes } from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
  renameSync,
} from "node:fs";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readAuthenticatedWeixinWireOwner,
  readWeixinAccountStatus,
} from "../src/weixin-account-status";
import {
  buildMicroclawWindowsNodeShellCommand,
  createWindowsNodeMxcApprovalProofMinter,
} from "../src/openclaw-approval-replay-compat.mjs";
import { normalizeWindowsNodeMxcGatewayApproval } from "../src/windows-node-mxc";
import {
  normalizeWeixinRemoteApprovalOwner,
  WEIXIN_NATIVE_DURABLE_CONSENT_SCOPE,
  weixinRemoteApprovalConsentHash,
  weixinRemoteApprovalWireSourceRejection,
  WindowsNodeMxcWeixinRemoteApprovalBroker,
} from "../src/windows-node-mxc-weixin-remote-approval";
import {
  bindWeixinApprovalRun,
  deliverWeixinRemoteApproval,
  exactWeixinApprovalSource,
  findWeixinApprovalSource,
  remoteApprovalDiagnosticBinding,
} from "../src/windows-node-mxc-weixin-remote-approval-delivery";
import {
  describeWeixinSessionBinding,
  resolveWeixinSessionRoute,
} from "../src/weixin-session-routing";
import { WindowsNodeMxcWeixinRemoteApprovalServer } from "../src/windows-node-mxc-weixin-remote-approval-transport";
import { WeixinRemoteApprovalTransport } from "../../plugins/openclaw-weixin/src/security/remote-approval.js";
import {
  interceptWeixinRemoteApprovalMessage,
  processOneMessage,
} from "../../plugins/openclaw-weixin/src/messaging/process-message.js";
import { registerUserInFrameworkStore } from "../../plugins/openclaw-weixin/src/auth/pairing.js";
import {
  clearContextTokensForAccount,
  getContextToken,
  setContextToken,
} from "../../plugins/openclaw-weixin/src/messaging/inbound.js";
import { runPinnedApprovalRequests } from "./pinned-approval-fixture.mjs";
import { createPinnedAgentRunStartNotifier } from "./pinned-session-fixture.mjs";
import { createMainWeixinInboundFixture } from "./main-weixin-inbound-fixture.mjs";
import { windowsCommand } from "./windows-command-fixture.mjs";
import { logger } from "../../plugins/openclaw-weixin/src/util/logger.js";
import {
  describeWeixinApprovalDecision,
  isSafeMxcApprovalMetadataFrame,
} from "../src/mxc-approval-context-diagnostics";

vi.mock("../../plugins/openclaw-weixin/src/util/logger.js", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const rawPeer = "AbCdEfCaseSensitive@im.wechat";
const key = "agent:main:main";
const security = {
  gatewayGeneration: "test-generation",
  policyFingerprint: "b".repeat(64),
  nodeId: "test-node",
  activationLeaseHash: "d".repeat(64),
  requestedMode: "limited-dacl",
  effectiveMode: "appcontainer-dacl",
};
const root = String.raw`C:\Users\sunt\Desktop`;
const target = `${root}\\wire_fixture_folder`;
const executable = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
let captured;
function approvalFor(script = `New-Item -ItemType Directory -Path '${target}' -Force`) {
  const command = `powershell -NoProfile -Command "${script}"`;
  const preview = `# [declare-access]rw:${root}[/declare-access]\n${command}`;
  const argv = buildMicroclawWindowsNodeShellCommand(preview, { SystemRoot: "C:\\Windows" }).map(
    (argument) => (argument === preview ? command : argument),
  );
  const plan = {
    argv,
    commandText: windowsCommand(argv),
    commandPreview: preview,
    cwd: null,
    cwdBinding: "isolated-scratch:v1",
    agentId: "main",
    sessionKey: key,
    executablePath: executable,
    executableSha256: createHash("sha256")
      .update(
        process.platform === "win32" ? readFileSync(executable) : Buffer.from("test-interpreter"),
      )
      .digest("hex"),
    declaredAccess: [{ access: "rw", path: root }],
  };
  captured ??= runPinnedApprovalRequests(plan, rawPeer, security.nodeId).find(
    (entry) => entry.kind === "trusted",
  ).request;
  const request = {
    ...captured,
    systemRunPlan: plan,
    command: plan.commandText,
    commandPreview: preview,
  };
  const result = normalizeWindowsNodeMxcGatewayApproval(
    { id: randomUUID(), request },
    security.nodeId,
    security.gatewayGeneration,
  );
  if (!result) throw new Error("Actual pinned Gateway request/normalized folder plan rejected");
  return result;
}

describe("exact authenticated provider peer through real cache, sender, HTTP adapter and approval pipe", () => {
  let stateDir;
  let server;
  let transport;
  let fetch;
  let records;
  let sources;
  let decisions;
  let configuration;
  let broker;
  let approval;
  let states;
  let pending;
  let inboundDiagnostics;
  let main;
  let mainDiagnostics;
  let gateway;
  const credentialPath = () => path.join(stateDir, "openclaw-weixin", "accounts", "bot.json");
  function credential(userId = rawPeer) {
    writeFileSync(credentialPath(), JSON.stringify({ token: "synthetic-account-token", userId }));
  }
  function message(extra = {}) {
    return {
      from_user_id: rawPeer,
      to_user_id: "bot",
      message_type: 1,
      message_id: 1001,
      seq: 42,
      context_token: "synthetic-exact-context",
      item_list: [{ type: 1, text_item: { text: "Create the fixture folder" } }],
      ...extra,
    };
  }
  beforeEach(async () => {
    stateDir = mkdtempSync(path.join(os.tmpdir(), "microclaw-wire-authority-"));
    mkdirSync(path.join(stateDir, "openclaw-weixin", "accounts"), { recursive: true });
    writeFileSync(path.join(stateDir, "openclaw-weixin", "accounts.json"), '["bot"]');
    writeFileSync(path.join(stateDir, "openclaw.json"), "{}");
    credential();
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);
    vi.stubEnv("OPENCLAW_CONFIG_PATH", path.join(stateDir, "openclaw.json"));
    const pipe =
      process.platform === "win32"
        ? `\\\\.\\pipe\\microclaw-wire-test-${randomUUID()}`
        : path.join(stateDir, "wire.sock");
    vi.stubEnv("MICROCLAW_MXC_WEIXIN_REMOTE_APPROVAL_PIPE", pipe);
    vi.stubEnv("MICROCLAW_MXC_WEIXIN_REMOTE_APPROVAL_TOKEN", "synthetic-pipe-secret");
    fetch = vi
      .fn()
      .mockImplementation(async () => new globalThis.Response('{"ret":0}', { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    setContextToken("bot", rawPeer, "synthetic-exact-context");
    records = [];
    states = [];
    inboundDiagnostics = [];
    decisions = [];
    sources = new Map();
    pending = true;
    configuration = {
      enabled: true,
      owner: normalizeWeixinRemoteApprovalOwner("bot", rawPeer, "2026-10-20T00:00:00Z"),
    };
    broker = new WindowsNodeMxcWeixinRemoteApprovalBroker(undefined, () =>
      readAuthenticatedWeixinWireOwner(stateDir),
    );
    broker.configure(configuration);
    approval = approvalFor();
    mainDiagnostics = [];
    gateway = {
      connected: true,
      request: vi.fn().mockResolvedValue({ ok: true, key, agentId: "main" }),
    };
    main = createMainWeixinInboundFixture({
      windowsNodeMxcWeixinRemoteApprovalSources: sources,
      bindWeixinApprovalRun,
      gatewayGenerationId: security.gatewayGeneration,
      describeWeixinApprovalDecision,
      allPendingWindowsNodeMxcGatewayApprovals: () => [],
      exactWeixinApprovalSource,
      getWindowsNodeMxcWeixinRemoteApprovalConfiguration: () => configuration,
      readAuthenticatedWeixinWireOwner,
      getOpenClawStateDir: () => stateDir,
      windowsNodeMxcWeixinRemoteApprovalBroker: broker,
      pendingWindowsNodeMxcGatewayApproval: {
        get request() {
          return approval;
        },
      },
      requireEffectiveWindowsNodeMxc: vi.fn().mockResolvedValue(undefined),
      currentWindowsNodeMxcWeixinRemoteApprovalSecurity: () => security,
      resolvePendingWindowsNodeMxcGatewayApproval: async (id, decision) => {
        decisions.push({ approvalIds: [id], decision });
      },
      gwClient: gateway,
      resolveWeixinSessionRoute,
      describeWeixinSessionBinding,
      remoteApprovalDiagnosticBinding,
      weixinRemoteApprovalWireSourceRejection,
      windowsNodeMxcSecurityTransitionInProgress: false,
      console: {
        info: (marker, record) => {
          if (marker === "[weixin-remote-approval-context]")
            mainDiagnostics.push(JSON.parse(record));
        },
        warn: vi.fn(),
        error: vi.fn(),
      },
    });
    server = new WindowsNodeMxcWeixinRemoteApprovalServer(
      pipe,
      "synthetic-pipe-secret",
      main.handle,
    );
    await server.start();
    transport = new WeixinRemoteApprovalTransport({
      accountId: "bot",
      baseUrl: "https://weixin.invalid",
      token: "synthetic-account-token",
      diagnostic: (record) => inboundDiagnostics.push(record),
      deliveryDiagnostic: (record) => records.push(record),
    });
    await transport.start();
    await source();
  }, 30_000);
  afterEach(() => {
    transport?.close();
    server?.close();
    clearContextTokensForAccount("bot");
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(stateDir, { recursive: true, force: true });
  });
  async function source(extra = {}, runExtra = {}) {
    const resolveAgentRoute = vi.fn().mockReturnValue({ agentId: "main", sessionKey: key });
    await interceptWeixinRemoteApprovalMessage(
      message(extra),
      {
        accountId: "bot",
        token: "synthetic-account-token",
        config: {},
        channelRuntime: { routing: { resolveAgentRoute } },
        remoteApprovalTransport: transport,
      },
      "start",
    );
    expect(resolveAgentRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "openclaw-weixin",
        peer: { kind: "direct", id: message(extra).from_user_id },
      }),
    );
    let registration;
    const notify = createPinnedAgentRunStartNotifier((actualRunId) => {
      registration = transport.intercept({
        message: message({ ...extra, ...runExtra }),
        agentId: "main",
        sessionKey: key,
        sourcePhase: "run",
        runId: actualRunId,
      });
    }, approval.origin.runId);
    notify();
    await registration;
  }
  async function deliver() {
    return deliverWeixinRemoteApproval({
      approval,
      configuration,
      source: findWeixinApprovalSource(sources, approval),
      security,
      server,
      broker,
      readWireOwner: () => readAuthenticatedWeixinWireOwner(stateDir),
      expiresAtUnixMs: Date.now() + 60_000,
      locale: "en-US",
      isPending: () => pending,
      challenge: () => {},
      state: (state) => states.push(state),
      diagnostic: () => {},
      deliveryDiagnostic: (record) => records.push(record),
    });
  }
  it("delivers the ordinary actual normalized folder plan with exact context and correlated provider receipt", async () => {
    expect(approval.origin.to).toBe(rawPeer);
    expect(gateway.request).toHaveBeenCalledWith(
      "sessions.resolve",
      {
        key,
        agentId: "main",
        includeGlobal: false,
        includeUnknown: false,
      },
      3_000,
    );
    expect(sources.get(key)).toBeDefined();
    expect(sources.get(key).senderId).toBe(rawPeer);
    expect(sources.get(key).conversationId).toBe(rawPeer);
    expect(mainDiagnostics).toContainEqual(
      expect.objectContaining({
        stage: "weixin-source-cached",
        reason: "source-cached",
      }),
    );
    expect(mainDiagnostics).toContainEqual(
      expect.objectContaining({
        stage: "weixin-run-registration",
        reason: "source-run-bound",
      }),
    );
    for (const record of mainDiagnostics)
      expect(isSafeMxcApprovalMetadataFrame(JSON.stringify(record))).toBe(true);
    expect(readWeixinAccountStatus(stateDir).currentAccount.userId).toBe(rawPeer.toLowerCase());
    expect(getContextToken("bot", rawPeer.toLowerCase())).toBeUndefined();
    const delivery = await deliver();
    expect(delivery).not.toBeNull();
    expect(delivery.senderId).toBe(rawPeer);
    expect(weixinRemoteApprovalConsentHash(configuration)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.msg.to_user_id).toBe(rawPeer);
    expect(body.msg.context_token).toBe("synthetic-exact-context");
    expect(body.msg.item_list[0].text_item.text).toContain("Reply 1:");
    expect(body.msg.item_list[0].text_item.text).toContain(target);
    expect(body.msg.item_list[0].text_item.text).toContain(executable);
    expect(body.msg.item_list[0].text_item.text).not.toContain("Args:");
    expect(approval.command).toBe(windowsCommand([approval.executable, ...approval.arguments]));
    expect(approval.command).toContain(target);
    const receipt = records.find(
      (record) => record.stage === "provider" && record.code === "provider-accepted",
    );
    expect(receipt.providerClientHash).toBe(
      createHash("sha256").update(body.msg.client_id).digest("hex").slice(0, 16),
    );
    expect(records).toContainEqual(
      expect.objectContaining({
        stage: "pipe",
        kind: "prompt",
        code: "delivery-dispatched",
        deliveryHash: receipt.deliveryHash,
      }),
    );
    for (const record of records)
      expect(isSafeMxcApprovalMetadataFrame(JSON.stringify(record))).toBe(true);
    const code = delivery.replyCode;
    expect(
      await transport.intercept({
        message: message({
          message_id: 1002,
          seq: 43,
          item_list: [{ type: 1, text_item: { text: `1 ${code}` } }],
        }),
        agentId: "main",
        sessionKey: key,
        sourcePhase: "candidate",
      }),
    ).toBe(true);
    expect(decisions).toHaveLength(1);
    expect(decisions[0].decision).toBe("allow-once");
    expect(JSON.stringify(records)).not.toContain(rawPeer);
    expect(JSON.stringify(records)).not.toContain("synthetic-exact-context");
  });
  it.each([
    ["1", "allow-once"],
    ["3", "deny"],
  ])(
    "runs actual plugin dispatch and pinned SDK callback through Main and bare %s before a second agent dispatch",
    async (digit, decision) => {
      sources.clear();
      mainDiagnostics.length = 0;
      await registerUserInFrameworkStore({ accountId: "bot", userId: rawPeer });
      const order = [];
      const intercept = transport.intercept.bind(transport);
      vi.spyOn(transport, "intercept").mockImplementation(async (params) => {
        order.push(params.sourcePhase);
        return intercept(params);
      });
      const dispatch = vi.fn(async ({ replyOptions }) => {
        order.push("dispatch");
        const notify = createPinnedAgentRunStartNotifier(
          replyOptions.onAgentRunStart,
          approval.origin.runId,
        );
        notify();
        await vi.waitFor(() => expect(sources.get(key)?.runIds).toEqual([approval.origin.runId]));
        expect(await deliver()).not.toBeNull();
        order.push("delivery");
      });
      const deps = {
        accountId: "bot",
        token: "synthetic-account-token",
        config: { channels: { "openclaw-weixin": { replyProgressMessages: false } } },
        remoteApprovalTransport: transport,
        log: vi.fn(),
        errLog: vi.fn(),
        channelRuntime: {
          routing: { resolveAgentRoute: () => ({ agentId: "main", sessionKey: key }) },
          session: {
            resolveStorePath: () => path.join(stateDir, "test-only-store"),
            recordInboundSession: async () => order.push("record"),
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
            dispatchReplyFromConfig: dispatch,
          },
        },
      };
      await processOneMessage(message(), deps);
      expect(deps.errLog).not.toHaveBeenCalled();
      expect(order).toEqual(["start", "record", "dispatch", "run", "delivery"]);
      expect(fetch).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(fetch.mock.calls[0][1].body).msg;
      expect(sent.to_user_id).toBe(rawPeer);
      expect(sent.context_token).toBe("synthetic-exact-context");
      expect(sent.item_list[0].text_item.text).toContain("Reply 1:");
      await processOneMessage(
        message({
          message_id: 1002,
          seq: 43,
          item_list: [{ type: 1, text_item: { text: digit } }],
        }),
        deps,
      );
      expect(deps.errLog).not.toHaveBeenCalled();
      expect(decisions).toEqual([{ approvalIds: [approval.id], decision }]);
      expect(dispatch).toHaveBeenCalledTimes(1);
      await processOneMessage(
        message({
          message_id: 1002,
          seq: 43,
          item_list: [{ type: 1, text_item: { text: digit } }],
        }),
        deps,
      );
      expect(decisions).toHaveLength(1);
      expect(dispatch).toHaveBeenCalledTimes(1);
      expect(weixinRemoteApprovalConsentHash(configuration)).toBeNull();
    },
  );

  it.each([false, true])(
    "accepts bare 2 only for an actually normalized eligible plan with native durable consent=%s",
    async (nativeConsent) => {
      const executable = String.raw`C:\Windows\System32\whoami.exe`;
      const argv = [executable, "/all"];
      const systemRunPlan = {
        argv,
        commandText: windowsCommand(argv),
        commandPreview: windowsCommand(argv),
        cwd: null,
        cwdBinding: "isolated-scratch:v1",
        agentId: "main",
        sessionKey: key,
        executablePath: executable,
        executableSha256: createHash("sha256")
          .update(
            process.platform === "win32"
              ? readFileSync(executable)
              : Buffer.from("synthetic-whoami"),
          )
          .digest("hex"),
        declaredAccess: [],
      };
      approval = normalizeWindowsNodeMxcGatewayApproval(
        {
          id: randomUUID(),
          request: { ...captured, systemRunPlan, command: systemRunPlan.commandText },
        },
        security.nodeId,
        security.gatewayGeneration,
      );
      expect(approval).not.toBeNull();
      expect(approval.hasMutableFileOperand).toBe(false);
      expect(approval.allowedDecisions).toContain("allow-always");
      if (nativeConsent) {
        configuration = { ...configuration, consentScope: WEIXIN_NATIVE_DURABLE_CONSENT_SCOPE };
        broker.configure(configuration);
      }
      const before = JSON.stringify(configuration);
      const delivery = await deliver();
      expect(delivery).not.toBeNull();
      expect(delivery.text.includes("2: remember")).toBe(nativeConsent);
      expect(
        await transport.intercept({
          message: message({
            message_id: 1002,
            seq: 43,
            item_list: [{ type: 1, text_item: { text: "2" } }],
          }),
          agentId: "main",
          sessionKey: key,
          sourcePhase: "candidate",
        }),
      ).toBe(true);
      expect(decisions).toEqual(
        nativeConsent ? [{ approvalIds: [approval.id], decision: "allow-always" }] : [],
      );
      expect(JSON.stringify(configuration)).toBe(before);
    },
  );

  it.each([
    ["no prompt", {}, "none"],
    ["wrong authenticated peer", { from_user_id: rawPeer.toLowerCase() }, "sent"],
    [
      "quoted",
      { item_list: [{ type: 1, text_item: { text: "1" }, ref_msg: { title: "synthetic quote" } }] },
      "sent",
    ],
    ["forwarded", { message_type: 2 }, "sent"],
    [
      "mixed text and attachment",
      { item_list: [{ type: 1, text_item: { text: "1" } }, { type: 2 }] },
      "sent",
    ],
    ["missing cursor", { seq: undefined }, "sent"],
    ["missing message ID", { message_id: undefined }, "sent"],
    [
      "malformed coded reply",
      { item_list: [{ type: 1, text_item: { text: "1 WRONG123" } }] },
      "sent",
    ],
    ["wrong canonical route", {}, "route"],
    ["generation drift", {}, "generation"],
    ["local resolution", {}, "local"],
    ["expired prompt", {}, "expired"],
  ])("keeps actual plugin→Main bare reply fail-closed: %s", async (_name, extra, state) => {
    if (state !== "none") await deliver();
    if (state === "route")
      gateway.request.mockResolvedValue({ ok: true, key: "agent:main:other", agentId: "main" });
    if (state === "generation") main.replace("gatewayGenerationId", "generation-changed");
    if (state === "local") broker.markLocallyResolved(approval.id, "approved");
    if (state === "expired") {
      const now = Date.now();
      vi.spyOn(Date, "now").mockReturnValue(now + 61_000);
    }
    try {
      expect(
        await transport.intercept({
          message: message({
            message_id: 1002,
            seq: 43,
            item_list: [{ type: 1, text_item: { text: "1" } }],
            ...extra,
          }),
          agentId: "main",
          sessionKey: key,
          sourcePhase: "candidate",
        }),
      ).toBe(true);
      expect(decisions).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("pins acknowledgement eligibility at arrival, not after awaited effective-mode validation", async () => {
    let acknowledge;
    fetch.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          acknowledge = resolve;
        }),
    );
    const deliveryPromise = deliver();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    main.replace("requireEffectiveWindowsNodeMxc", async () => {
      acknowledge(new globalThis.Response('{"ret":0}', { status: 200 }));
      await deliveryPromise;
    });
    const reply = () =>
      transport.intercept({
        message: message({
          message_id: 1002,
          seq: 43,
          item_list: [{ type: 1, text_item: { text: "1" } }],
        }),
        agentId: "main",
        sessionKey: key,
        sourcePhase: "candidate",
      });
    expect(await reply()).toBe(true);
    expect(await deliveryPromise).not.toBeNull();
    expect(decisions).toEqual([]);
    expect(await reply()).toBe(true);
    expect(decisions).toEqual([]);
    const promptReceipts = records.filter(
      (entry) => entry.kind === "prompt" && entry.code === "provider-accepted",
    );
    expect(
      new Set(promptReceipts.map((entry) => `${entry.deliveryHash}:${entry.providerClientHash}`))
        .size,
    ).toBe(1);
    expect(
      fetch.mock.calls.filter(([, params]) =>
        JSON.parse(params.body).msg.item_list[0].text_item.text.startsWith(
          "[MicroClaw Security Approval]",
        ),
      ),
    ).toHaveLength(1);
  });

  it.each([
    "client replacement",
    "client disconnect",
    "generation change",
    "pending replacement",
    "feature disabled",
    "consent epoch",
    "consent scope",
    "raw owner replacement",
    "security transition",
  ])("revalidates actual Main authority after its awaited reply route: %s", async (change) => {
    await deliver();
    let finishRoute;
    gateway.request.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRoute = resolve;
        }),
    );
    const reply = transport.intercept({
      message: message({
        message_id: 1002,
        seq: 43,
        item_list: [{ type: 1, text_item: { text: "1" } }],
      }),
      agentId: "main",
      sessionKey: key,
      sourcePhase: "candidate",
    });
    await vi.waitFor(() => expect(finishRoute).toBeTypeOf("function"));
    if (change === "client replacement") main.replace("gwClient", { ...gateway });
    if (change === "client disconnect") gateway.connected = false;
    if (change === "generation change") main.replace("gatewayGenerationId", "changed-generation");
    if (change === "pending replacement")
      main.replace("pendingWindowsNodeMxcGatewayApproval", { request: approval });
    if (change === "feature disabled") configuration = { ...configuration, enabled: false };
    if (change === "consent epoch")
      configuration = {
        ...configuration,
        owner: { ...configuration.owner, boundAt: "2026-10-22T00:00:00Z" },
      };
    if (change === "consent scope")
      configuration = { ...configuration, consentScope: WEIXIN_NATIVE_DURABLE_CONSENT_SCOPE };
    if (change === "raw owner replacement") credential(rawPeer.toLowerCase());
    if (change === "security transition")
      main.replace("windowsNodeMxcSecurityTransitionInProgress", true);
    finishRoute({ ok: true, key, agentId: "main" });
    expect(await reply).toBe(true);
    expect(decisions).toEqual([]);
    for (const record of mainDiagnostics)
      expect(isSafeMxcApprovalMetadataFrame(JSON.stringify(record))).toBe(true);
  });
  it("rejects a same-fold byte-distinct source and a same-fold origin target without looking up aliases", async () => {
    sources.clear();
    await source({ from_user_id: rawPeer.toLowerCase() });
    expect(await deliver()).toBeNull();
    expect(states.at(-1).reason).toBe("source-unavailable");
    expect(mainDiagnostics).toContainEqual(
      expect.objectContaining({
        stage: "weixin-source-validation",
        reason: "source-identity-mismatch",
      }),
    );
    expect(fetch).not.toHaveBeenCalled();
    await source();
    approval = { ...approval, origin: { ...approval.origin, to: rawPeer.toLowerCase() } };
    expect(await deliver()).toBeNull();
    expect(states.at(-1).reason).toBe("source-provider-mismatch");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    [
      "raw credential replaced with a same-fold peer",
      () => credential(rawPeer.toLowerCase()),
      "source-identity-mismatch",
    ],
    [
      "consent owner replaced",
      () => {
        configuration = {
          ...configuration,
          owner: { ...configuration.owner, boundAt: "2026-10-22T00:00:00Z" },
        };
      },
      "security-binding-invalid",
    ],
    [
      "consent revoked",
      () => {
        configuration = { ...configuration, enabled: false };
      },
      "source-owner-unavailable",
    ],
    [
      "Gateway generation changed",
      () => main.replace("gatewayGenerationId", "replacement-generation"),
      "security-binding-invalid",
    ],
    [
      "Gateway client replaced",
      () => main.replace("gwClient", { ...gateway }),
      "security-binding-invalid",
    ],
    [
      "Gateway disconnected",
      () => {
        gateway.connected = false;
      },
      "security-binding-invalid",
    ],
    [
      "security transition began",
      () => main.replace("windowsNodeMxcSecurityTransitionInProgress", true),
      "security-binding-invalid",
    ],
  ])(
    "revalidates %s after the awaited authoritative route lookup",
    async (_name, mutate, reason) => {
      sources.clear();
      gateway.request.mockImplementationOnce(async () => {
        mutate();
        return { ok: true, key, agentId: "main" };
      });
      await source();
      expect(sources.size).toBe(0);
      expect(await deliver()).toBeNull();
      expect(fetch).not.toHaveBeenCalled();
      expect(mainDiagnostics).toContainEqual(
        expect.objectContaining({
          stage: "weixin-source-validation",
          reason,
        }),
      );
    },
  );
  it.each([
    ["missing route", { ok: false }],
    ["different route agent", { ok: true, key, agentId: "other-agent" }],
  ])("rejects %s without guessing an alias", async (_name, result) => {
    sources.clear();
    gateway.request.mockResolvedValueOnce(result);
    await source();
    expect(sources.size).toBe(0);
    expect(await deliver()).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
    expect(mainDiagnostics).toContainEqual(
      expect.objectContaining({
        stage: "weixin-source-validation",
        reason: "source-route-unresolved",
      }),
    );
  });
  it("does not substitute a newly resolved route for the actual approved originating route", async () => {
    sources.clear();
    const replacementRoute = "agent:main:other-conversation";
    gateway.request.mockResolvedValueOnce({ ok: true, key: replacementRoute, agentId: "main" });
    await source();
    expect(sources.has(key)).toBe(false);
    expect(sources.get(replacementRoute).senderId).toBe(rawPeer);
    expect(await deliver()).toBeNull();
    expect(states.at(-1).reason).toBe("source-unavailable");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("removes the exact raw source when actual plugin completion arrives", async () => {
    expect(sources.get(key).senderId).toBe(rawPeer);
    await interceptWeixinRemoteApprovalMessage(
      message(),
      {
        accountId: "bot",
        token: "synthetic-account-token",
        config: {},
        channelRuntime: {
          routing: { resolveAgentRoute: () => ({ agentId: "main", sessionKey: key }) },
        },
        remoteApprovalTransport: transport,
      },
      "complete",
    );
    expect(sources.size).toBe(0);
    expect(await deliver()).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([
    ["missing seq", { seq: undefined }, "provider-cursor-unavailable"],
    ["unsafe numeric seq", { seq: 9007199254740992 }, "provider-cursor-unavailable"],
    ["missing message ID", { message_id: undefined }, "provider-message-id-unavailable"],
  ])("keeps %s fail-closed with typed normalization diagnostics", async (_name, extra, reason) => {
    sources.clear();
    await source(extra);
    expect(await deliver()).toBeNull();
    expect(states.at(-1).reason).toBe("source-unavailable");
    expect(inboundDiagnostics).toContainEqual(expect.objectContaining({ code: reason }));
    expect(fetch).not.toHaveBeenCalled();
  });
  it("does not bind an unrelated provider message to the real SDK run", async () => {
    await source({}, { message_id: 2002, seq: 44 });
    expect(await deliver()).toBeNull();
    expect(states.at(-1).reason).toBe("source-run-mismatch");
    expect(fetch).not.toHaveBeenCalled();
  });
  it("keeps current owner replacement fail-closed even when canonical lowercase identity is unchanged", async () => {
    const delivery = await deliver();
    const code = delivery.replyCode;
    credential(rawPeer.toLowerCase());
    await transport.intercept({
      message: message({
        message_id: 1002,
        seq: 43,
        item_list: [{ type: 1, text_item: { text: `1 ${code}` } }],
      }),
      agentId: "main",
      sessionKey: key,
      sourcePhase: "candidate",
    });
    expect(decisions).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it("reports provider rejection with exact client/delivery hashes and no response body or retry", async () => {
    fetch.mockResolvedValue(
      new globalThis.Response('{"ret":-3,"errmsg":"synthetic-sensitive-provider-body"}', {
        status: 200,
      }),
    );
    expect(await deliver()).toBeNull();
    expect(states.at(-1).state).toBe("unconfirmed");
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(records).toContainEqual(
      expect.objectContaining({
        stage: "provider",
        code: "provider-rejected",
        providerRet: -3,
        providerClientHash: createHash("sha256")
          .update(body.msg.client_id)
          .digest("hex")
          .slice(0, 16),
      }),
    );
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(records)).not.toContain("synthetic-sensitive-provider-body");
    expect(JSON.stringify(records)).not.toContain("synthetic-account-token");
  });
  it.each([null, false, "", "0", 0.5, 9007199254740992, "synthetic-private-return-code"])(
    "rejects present malformed provider ret=%j without authority, raw diagnostics or retry",
    async (ret) => {
      vi.clearAllMocks();
      fetch.mockResolvedValue(
        new globalThis.Response(
          JSON.stringify({
            ret,
            errmsg: "synthetic-sensitive-provider-body",
          }),
          { status: 200 },
        ),
      );
      expect(await deliver()).toBeNull();
      expect(states.at(-1).state).toBe("unconfirmed");
      expect(records).toContainEqual(
        expect.objectContaining({
          stage: "provider",
          kind: "prompt",
          code: "provider-response-invalid",
        }),
      );
      expect(records.some((record) => record.code === "provider-accepted")).toBe(false);
      expect(fetch).toHaveBeenCalledTimes(1);
      const result = broker.resolveCandidate({
        ...sources.get(key),
        text: "1",
        messageId: "1002",
        cursor: "43",
        receivedAtUnixMs: Date.now(),
        ambiguous: false,
        requests: [{ approval }],
        security,
      });
      expect(result.status).not.toBe("approved");
      expect(decisions).toEqual([]);
      expect(fetch).toHaveBeenCalledTimes(1);
      const diagnostics = JSON.stringify({
        records,
        logs: Object.values(logger).flatMap((log) => log.mock.calls),
      });
      expect(diagnostics).not.toContain("synthetic-sensitive-provider-body");
      expect(diagnostics).not.toContain("synthetic-private-return-code");
      expect(diagnostics).not.toContain("synthetic-account-token");
    },
  );
  it("accepts omitted protobuf-default ret without changing exact owner or legacy consent", async () => {
    fetch.mockResolvedValue(new globalThis.Response("{}", { status: 200 }));
    expect(await deliver()).not.toBeNull();
    expect(states.at(-1).state).toBe("sent");
    expect(weixinRemoteApprovalConsentHash(configuration)).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  function assertProviderSend(index, kind) {
    const body = JSON.parse(fetch.mock.calls[index][1].body);
    expect(body.msg.to_user_id).toBe(rawPeer);
    expect(body.msg.context_token).toBe("synthetic-exact-context");
    const providerClientHash = createHash("sha256")
      .update(body.msg.client_id)
      .digest("hex")
      .slice(0, 16);
    const record = records.find(
      (entry) =>
        entry.kind === kind &&
        entry.code === "provider-accepted" &&
        entry.providerClientHash === providerClientHash,
    );
    expect(record).toBeDefined();
    expect(isSafeMxcApprovalMetadataFrame(JSON.stringify(record))).toBe(true);
    return { body, record };
  }
  it("sends rejected-reply acknowledgement via the exact raw peer/cache and a real provider client receipt", async () => {
    await deliver();
    expect(
      await transport.intercept({
        message: message({
          message_id: 1002,
          seq: 43,
          item_list: [{ type: 1, text_item: { text: "1 AAAAAAAA" } }],
        }),
        agentId: "main",
        sessionKey: key,
        sourcePhase: "candidate",
      }),
    ).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    const { record } = assertProviderSend(1, "acknowledgement");
    expect(record.inboundHash).toMatch(/^[a-f0-9]{16}$/);
    expect(record.challengeHash).toBeUndefined();
    expect(decisions).toEqual([]);
  });
  it("sends a no-decision reminder through the same exact sender and binds the current challenge", async () => {
    const delivery = await deliver();
    expect(
      await transport.intercept({
        message: message({
          seq: undefined,
          item_list: [{ type: 1, text_item: { text: "uncoded follow-up" } }],
        }),
        agentId: "main",
        sessionKey: key,
        sourcePhase: "candidate",
      }),
    ).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    const { body, record } = assertProviderSend(1, "reminder");
    expect(record.challengeHash).toBe(
      createHash("sha256").update(delivery.challengeId).digest("hex").slice(0, 16),
    );
    expect(body.msg.item_list[0].text_item.text).toContain(
      "one available digit from the current prompt",
    );
    expect(body.msg.item_list[0].text_item.text).not.toContain("exact always");
    expect(decisions).toEqual([]);
  });
  it("sends terminal notices through exact raw identity and revalidates replacement before the next send", async () => {
    const delivery = await deliver();
    await server.deliver({
      accountId: "bot",
      to: rawPeer,
      kind: "terminal",
      terminalChallengeId: delivery.challengeId,
      text: "MicroClaw Security Approval: closed.",
      onDiagnostic: (record) => records.push(record),
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    const { record } = assertProviderSend(1, "terminal");
    expect(record.challengeHash).toBe(
      createHash("sha256").update(delivery.challengeId).digest("hex").slice(0, 16),
    );
    credential(rawPeer.toLowerCase());
    await expect(
      server.deliver({
        accountId: "bot",
        to: rawPeer,
        kind: "terminal",
        terminalChallengeId: delivery.challengeId,
        text: "MicroClaw Security Approval: closed.",
        onDiagnostic: (entry) => records.push(entry),
      }),
    ).rejects.toThrow("unconfirmed");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(records).toContainEqual(
      expect.objectContaining({
        kind: "terminal",
        code: "owner-changed",
        stage: "provider",
      }),
    );
  });
  it("reports missing exact context without trying a same-fold cache entry or contacting the provider", async () => {
    clearContextTokensForAccount("bot");
    setContextToken("bot", rawPeer.toLowerCase(), "synthetic-wrong-context");
    expect(await deliver()).toBeNull();
    expect(records).toContainEqual(
      expect.objectContaining({ code: "context-unavailable", stage: "provider" }),
    );
    expect(fetch).not.toHaveBeenCalled();
  });
  it("sends only a safe local-only notice for secret-bearing arbitrary script", async () => {
    approval = approvalFor("$apiKey='synthetic-inline-secret'; Invoke-Expression $apiKey");
    expect(await deliver()).toBeNull();
    expect(states.at(-1).state).toBe("local-only");
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body.msg.to_user_id).toBe(rawPeer);
    expect(body.msg.item_list[0].text_item.text).toContain("Desktop");
    expect(JSON.stringify(body)).not.toContain("synthetic-inline-secret");
    expect(JSON.stringify(body)).not.toContain("Invoke-Expression");
  });
  it.skipIf(!process.env.MICROCLAW_NATIVE_APPROVAL_BRIDGE_TEST)(
    "binds actual builder/closed consent/phone/proof to native create-delete with exact canonical CWD and error semantics",
    async () => {
      const bridge = mkdtempSync(path.join(os.tmpdir(), "microclaw-native-scope-"));
      const secretBase64 = randomBytes(32).toString("base64");
      const repository = path.resolve("..");
      const nodeIdBefore = security.nodeId;
      let exited = false;
      let output = "";
      let testError;
      const child = spawn(
        "dotnet",
        [
          "test",
          path.join(
            repository,
            "windows-node-host.Tests",
            "MicroClaw.WindowsNodeHost.Tests.csproj",
          ),
          "--no-build",
          "--no-restore",
          "-m:1",
          "-p:BuildInParallel=false",
          "-nodeReuse:false",
          "--filter",
          "FullyQualifiedName~PowerShellFilesystemScopeNativeApprovalBridge",
          "--logger",
          "trx;LogFileName=result.trx",
          "--results-directory",
          bridge,
          "--verbosity",
          "quiet",
        ],
        {
          cwd: repository,
          windowsHide: true,
          env: {
            ...process.env,
            MICROCLAW_NATIVE_APPROVAL_BRIDGE: bridge,
            MICROCLAW_NATIVE_APPROVAL_BRIDGE_SECRET: secretBase64,
            MICROCLAW_MXC_NATIVE_TEST_SCRATCH: bridge,
          },
        },
      );
      child.stdout.on("data", (value) => {
        output = (output + value).slice(-20000);
      });
      child.stderr.on("data", (value) => {
        output = (output + value).slice(-20000);
      });
      const completion = new Promise((resolve, reject) => {
        child.once("error", () =>
          reject(new Error("Native approval bridge process failed to start")),
        );
        child.once("exit", (code) => {
          exited = true;
          resolve(code);
        });
      });
      async function read(file) {
        const target = path.join(bridge, file);
        const deadline = Date.now() + 60_000;
        while (!existsSync(target) && !exited && Date.now() < deadline) await delay(25);
        if (!existsSync(target))
          throw new Error(`Native bridge failed before ${file}; see isolated test log`);
        return JSON.parse(readFileSync(target, "utf8"));
      }
      function write(file, value) {
        const target = path.join(bridge, file);
        writeFileSync(target + ".pending", JSON.stringify(value));
        renameSync(target + ".pending", target);
      }
      try {
        const info = await read("ready.json");
        security.nodeId = info.nodeId;
        const minter = createWindowsNodeMxcApprovalProofMinter({
          secretBase64,
          gatewayGeneration: info.generation,
          policyFingerprint: info.fingerprint,
          nodeId: info.nodeId,
        });
        const evidence = [];
        for (let step = 0; step < 8; step++) {
          const target = path.win32.join(info.grant, step < 4 ? "direct-child" : "nested-child");
          const operation =
            step % 4 < 2
              ? `New-Item -ItemType Directory -Path '${target}'${step % 4 === 0 ? " -Force" : ""}`
              : `Remove-Item -Path '${target}' -Recurse -Force`;
          const script = step < 4 ? operation : `powershell -NoProfile -Command "${operation}"`;
          const rawCommand = `# [declare-access]rw:${info.grant}[/declare-access]\n${script}`;
          const command = buildMicroclawWindowsNodeShellCommand(rawCommand);
          write(`${step}.input.json`, {
            command,
            rawCommand,
            cwd: info.cwd,
            agentId: "main",
            sessionKey: key,
            timeoutMs: 30_000,
          });
          const prepared = await read(`${step}.prepared.json`);
          const nativePlan = prepared.plan;
          const captured = runPinnedApprovalRequests(nativePlan, rawPeer, info.nodeId).find(
            (entry) => entry.kind === "trusted",
          );
          expect(captured.request.systemRunPlan.providerInitialization).toEqual(
            nativePlan.providerInitialization,
          );
          approval = normalizeWindowsNodeMxcGatewayApproval(
            {
              id: randomUUID(),
              request: captured.request,
            },
            info.nodeId,
            security.gatewayGeneration,
            "limited-dacl",
          );
          expect(approval).not.toBeNull();
          expect(approval.canonicalCwd.toLowerCase()).not.toBe(info.grant.toLowerCase());
          sources.clear();
          await source({ message_id: 1001 + step * 4, seq: 42 + step * 4 });
          const delivery = await deliver();
          expect(delivery).not.toBeNull();
          expect(delivery.text).toContain("Scoped CWD initialization");
          const code = delivery.replyCode;
          expect(
            await transport.intercept({
              message: message({
                message_id: 1002 + step * 4,
                seq: 43 + step * 4,
                item_list: [{ type: 1, text_item: { text: `1 ${code}` } }],
              }),
              agentId: "main",
              sessionKey: key,
              sourcePhase: "candidate",
            }),
          ).toBe(true);
          expect(decisions.at(-1).decision).toBe("allow-once");
          expect(weixinRemoteApprovalConsentHash(configuration)).toBeNull();
          const approvedPlan = captured.request.systemRunPlan;
          const proof = minter.mint({
            approvalId: approval.id,
            nodeId: info.nodeId,
            plan: approvedPlan,
          });
          write(`${step}.approved.json`, {
            command: approvedPlan.argv,
            rawCommand: approvedPlan.commandText,
            cwd: approvedPlan.cwd,
            agentId: approvedPlan.agentId,
            sessionKey: approvedPlan.sessionKey,
            systemRunPlan: approvedPlan,
            microclawApprovalProof: proof,
          });
          const result = await read(`${step}.result.json`);
          expect(result.exitCode).toBe(step % 4 === 1 || step % 4 === 3 ? 1 : 0);
          expect(result.success).toBe(result.exitCode === 0);
          await server.deliver({
            accountId: "bot",
            to: rawPeer,
            kind: "terminal",
            terminalChallengeId: delivery.challengeId,
            text: "MicroClaw Security Approval: completed.",
          });
          evidence.push({
            step,
            planSha256: proof.planSha256,
            exitCode: result.exitCode,
            success: result.success,
            exactPhoneScope: true,
            legacyOnceOnly: true,
            noRealPhoneSend: true,
          });
        }
        expect(await completion).toBe(0);
        const native = await read("evidence.json");
        expect(native.results).toHaveLength(8);
        expect(native.privateStateEmpty).toBe(true);
        expect(native.ancestors.every((entry) => entry.unchanged)).toBe(true);
        if (process.env.MICROCLAW_NATIVE_APPROVAL_EVIDENCE)
          writeFileSync(
            process.env.MICROCLAW_NATIVE_APPROVAL_EVIDENCE,
            JSON.stringify({ evidence, native }, null, 2),
          );
      } catch (error) {
        testError = error;
      } finally {
        security.nodeId = nodeIdBefore;
        if (!exited) writeFileSync(path.join(bridge, "abort"), "abort");
        await Promise.race([completion, delay(40_000)]);
        const logs = process.env.MICROCLAW_NATIVE_APPROVAL_EVIDENCE;
        if (logs) {
          writeFileSync(logs + ".test.log", output);
          if (existsSync(path.join(bridge, "result.trx")))
            writeFileSync(logs + ".trx", readFileSync(path.join(bridge, "result.trx")));
        }
        if (exited) rmSync(bridge, { recursive: true, force: true });
      }
      if (!exited)
        throw new AggregateError(
          testError ? [testError] : [],
          `Native bridge process ${child.pid} did not stop after bounded abort`,
        );
      if (testError) throw testError;
    },
    240_000,
  );
});
