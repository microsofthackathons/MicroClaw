import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readAuthenticatedWeixinWireOwner,
  readWeixinAccountStatus,
} from "../src/weixin-account-status";
import { buildMicroclawWindowsNodeShellCommand } from "../src/openclaw-approval-replay-compat.mjs";
import { normalizeWindowsNodeMxcGatewayApproval } from "../src/windows-node-mxc";
import {
  normalizeWeixinRemoteApprovalOwner,
  weixinRemoteApprovalConsentHash,
  WindowsNodeMxcWeixinRemoteApprovalBroker,
} from "../src/windows-node-mxc-weixin-remote-approval";
import {
  bindWeixinApprovalRun,
  deliverWeixinRemoteApproval,
} from "../src/windows-node-mxc-weixin-remote-approval-delivery";
import { WindowsNodeMxcWeixinRemoteApprovalServer } from "../src/windows-node-mxc-weixin-remote-approval-transport";
import { WeixinRemoteApprovalTransport } from "../../plugins/openclaw-weixin/src/security/remote-approval.js";
import { interceptWeixinRemoteApprovalMessage } from "../../plugins/openclaw-weixin/src/messaging/process-message.js";
import {
  clearContextTokensForAccount,
  getContextToken,
  setContextToken,
} from "../../plugins/openclaw-weixin/src/messaging/inbound.js";
import { runPinnedApprovalRequests } from "./pinned-approval-fixture.mjs";
import { exactField, windowsCommand } from "./windows-command-fixture.mjs";
import { logger } from "../../plugins/openclaw-weixin/src/util/logger.js";
import { isSafeMxcApprovalMetadataFrame } from "../src/mxc-approval-context-diagnostics";

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
  effectiveMode: "limited-dacl",
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
  captured ??= runPinnedApprovalRequests(plan, rawPeer).find(
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
    server = new WindowsNodeMxcWeixinRemoteApprovalServer(
      pipe,
      "synthetic-pipe-secret",
      async (source) => {
        if (source.sourcePhase === "start") {
          sources.set(key, {
            ...source,
            gatewayGeneration: security.gatewayGeneration,
            runIds: [],
          });
        } else if (source.sourcePhase === "run") {
          bindWeixinApprovalRun(sources, source, security.gatewayGeneration);
        } else if (source.sourcePhase === "candidate") {
          const decision = broker.resolveCandidate({
            ...source,
            requests: [{ approval }],
            security,
          });
          if (decision.status === "approved" || decision.status === "denied")
            decisions.push(decision);
          return { consumed: decision.consumed, acknowledgement: decision.acknowledgement };
        }
        return { consumed: false };
      },
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
    await transport.intercept({
      message: message({ ...extra, ...runExtra }),
      agentId: "main",
      sessionKey: key,
      sourcePhase: "run",
      runId: approval.origin.runId,
    });
  }
  async function deliver() {
    return deliverWeixinRemoteApproval({
      approval,
      configuration,
      source: sources.get(key),
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
    expect(sources.get(key).senderId).toBe(rawPeer);
    expect(sources.get(key).conversationId).toBe(rawPeer);
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
    expect(body.msg.item_list[0].text_item.text).toContain("1 ");
    expect(JSON.parse(exactField(body.msg.item_list[0].text_item.text, "Request 1 command"))).toBe(
      approval.command,
    );
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
    const code = /#([A-Z0-9]{8})\]/.exec(delivery.text)[1];
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
  it("rejects a same-fold byte-distinct source and a same-fold origin target without looking up aliases", async () => {
    await source({ from_user_id: rawPeer.toLowerCase() });
    expect(await deliver()).toBeNull();
    expect(states.at(-1).reason).toBe("source-identity-mismatch");
    expect(fetch).not.toHaveBeenCalled();
    await source();
    approval = { ...approval, origin: { ...approval.origin, to: rawPeer.toLowerCase() } };
    expect(await deliver()).toBeNull();
    expect(states.at(-1).reason).toBe("source-provider-mismatch");
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
    const code = /#([A-Z0-9]{8})\]/.exec(delivery.text)[1];
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
      const text = JSON.parse(fetch.mock.calls[0][1].body).msg.item_list[0].text_item.text;
      const code = /#([A-Z0-9]{8})\]/.exec(text)[1];
      const result = broker.resolveCandidate({
        ...sources.get(key),
        text: `1 ${code}`,
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
      "current prompt's choices and request code",
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
});
