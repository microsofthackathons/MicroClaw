import { beforeAll, describe, expect, it } from "vitest";
import type {
  WeixinRemoteApprovalCandidate,
  WeixinRemoteApprovalCreateInput,
  WeixinRemoteApprovalConfiguration,
} from "./windows-node-mxc-weixin-remote-approval";
import {
  normalizeWeixinRemoteApprovalOwner,
  WEIXIN_NATIVE_DURABLE_CONSENT_SCOPE,
} from "./windows-node-mxc-weixin-remote-approval";

const modulePath =
  process.env.MICROCLAW_SIMPLE_REPLY_BASELINE ?? "./windows-node-mxc-weixin-remote-approval";
let WindowsNodeMxcWeixinRemoteApprovalBroker: typeof import("./windows-node-mxc-weixin-remote-approval").WindowsNodeMxcWeixinRemoteApprovalBroker;
beforeAll(async () => {
  const module: typeof import("./windows-node-mxc-weixin-remote-approval") = await import(
    modulePath
  );
  WindowsNodeMxcWeixinRemoteApprovalBroker = module.WindowsNodeMxcWeixinRemoteApprovalBroker;
});

function input(now = 1_000, id = "approval-A"): WeixinRemoteApprovalCreateInput {
  return {
    now,
    expiresAtUnixMs: now + 60_000,
    locale: "en-US",
    source: {
      accountId: "bot",
      senderId: "ExactPeer@im.wechat",
      conversationId: "ExactPeer@im.wechat",
      messageId: "100",
      cursor: "100",
      agentId: "main",
      sessionKey: "agent:main:test",
      direct: true,
      forwarded: false,
      quoted: false,
      receivedAtUnixMs: now,
      gatewayGeneration: "generation-A",
      runIds: ["run-A"],
    },
    security: {
      gatewayGeneration: "generation-A",
      policyFingerprint: "b".repeat(64),
      nodeId: "node-A",
      activationLeaseHash: "d".repeat(64),
      requestedMode: "limited-dacl",
      effectiveMode: "appcontainer-dacl",
    },
    requests: [
      {
        approval: {
          id,
          command: "whoami.exe /all",
          executable: "whoami.exe",
          arguments: ["/all"],
          executablePath: String.raw`C:\Windows\System32\whoami.exe`,
          executableSha256: "a".repeat(64),
          canonicalCwd: "isolated-scratch:v1",
          agent: "main",
          sessionKey: "agent:main:test",
          declaredAccess: [],
          hasMutableFileOperand: false,
          allowedDecisions: ["allow-once", "allow-always", "deny"],
          origin: {
            contract: "microclaw.gateway-approval-origin.v1",
            gatewayGeneration: "generation-A",
            agentId: "main",
            runSessionKey: "agent:main:test",
            executionSessionKey: "agent:main:test",
            runId: "run-A",
            toolCallId: `tool-${id}`,
            nodeId: "node-A",
            channel: "openclaw-weixin",
            accountId: "bot",
            to: "ExactPeer@im.wechat",
          },
        },
      },
    ],
  };
}

function setup(nativeDurable = false, delivered = true) {
  const request = input();
  let wireOwner = { accountId: "bot", userId: request.source.senderId };
  const broker = new WindowsNodeMxcWeixinRemoteApprovalBroker(undefined, () => wireOwner);
  const configuration: WeixinRemoteApprovalConfiguration = {
    enabled: true,
    owner: normalizeWeixinRemoteApprovalOwner("bot", wireOwner.userId, "2026-10-22T00:00:00Z"),
    ...(nativeDurable ? { consentScope: WEIXIN_NATIVE_DURABLE_CONSENT_SCOPE } : {}),
  };
  broker.configure(configuration);
  const delivery = broker.createChallenge(request);
  if (!delivery) throw new Error("Synthetic authority fixture was not eligible");
  if (delivered) expect(broker.markDelivered(delivery.challengeId, 1_001)).toBe(true);
  function reply(text = "1", extra: Partial<WeixinRemoteApprovalCandidate> = {}) {
    return broker.resolveCandidate({
      ...request.source,
      messageId: "101",
      cursor: "101",
      text,
      now: 2_000,
      requests: request.requests,
      security: request.security,
      ...extra,
    });
  }
  return {
    broker,
    request,
    delivery,
    configuration,
    reply,
    replaceWireOwner: (value: typeof wireOwner) => {
      wireOwner = value;
    },
  };
}

describe("temporary simple-current-prompt policy", () => {
  it("selects the single delivered exact current approval with bare 1", () => {
    const state = setup();
    expect(state.reply()).toMatchObject({
      status: "approved",
      decision: "allow-once",
      approvalIds: ["approval-A"],
    });
    expect(state.reply("3", { messageId: "102", cursor: "102" }).status).toBe("rejected");
  });

  it("denies the single delivered exact current approval with bare 3", () => {
    expect(setup().reply("3")).toMatchObject({ status: "denied", decision: "deny" });
  });

  it("eligible bare 2 requires existing native exact-conversation durable consent", () => {
    expect(setup(true).reply("2")).toMatchObject({ status: "approved", decision: "allow-always" });
    const legacy = setup();
    const before = JSON.stringify(legacy.configuration);
    expect(legacy.reply("2")).toMatchObject({ status: "rejected", reason: "consent-scope" });
    expect(JSON.stringify(legacy.configuration)).toBe(before);
    expect(legacy.reply("1", { messageId: "102", cursor: "102" })).toMatchObject({
      decision: "allow-once",
    });
  });

  it("does not advertise or accept 2 for an ineligible request despite native consent", () => {
    const state = setup(true);
    state.request.requests[0].approval.hasMutableFileOperand = true;
    const delivery = state.broker.createChallenge({ ...state.request, now: 2_000 });
    if (!delivery) throw new Error("Once-only request should still be eligible");
    state.broker.markDelivered(delivery.challengeId, 2_001);
    expect(delivery.text).not.toMatch(/2:/);
    expect(state.reply("2", { now: 2_002 })).toMatchObject({ status: "rejected" });
  });

  it("rejects pre-acknowledgement input and its later duplicate without automatic replay", () => {
    const state = setup(false, false);
    expect(state.reply()).toMatchObject({ status: "rejected", reason: "inactive" });
    state.broker.markDelivered(state.delivery.challengeId, 2_001);
    expect(state.reply("1", { now: 2_002 })).toMatchObject({
      status: "rejected",
      reason: "replayed",
    });
    expect(state.reply("1", { messageId: "102", cursor: "102", now: 2_003 })).toMatchObject({
      status: "approved",
    });
  });

  it("does not make an unacknowledged arrival eligible across an awaited route check", () => {
    const state = setup(false, false);
    const expectedSimpleChallengeId = state.broker.captureSimpleReplyChallenge(
      state.request.source,
      2_000,
    );
    expect(expectedSimpleChallengeId).toBeNull();
    state.broker.markDelivered(state.delivery.challengeId, 2_001);
    expect(state.reply("1", { now: 2_002, expectedSimpleChallengeId })).toMatchObject({
      status: "rejected",
      reason: "inactive",
    });
  });

  it.each([
    { accountId: "other" },
    { senderId: "exactpeer@im.wechat" },
    { conversationId: "other" },
    { direct: false },
    { forwarded: true },
    { quoted: true },
    { ambiguous: true },
    { agentId: "other" },
    { sessionKey: "agent:main:other" },
    { cursor: "100" },
    { cursor: "not-a-cursor" },
    { messageId: "not-a-message" },
  ])("retains exact identity, route and metadata guards: %j", (extra) => {
    expect(setup().reply("1", extra).status).toBe("rejected");
  });

  it.each(["1 WRONG123", "1 23456789 extra", "1 00000000", "1\n3", "1 ", "allow 1"])(
    "does not reinterpret malformed/coded text as a bare decision: %j",
    (text) => {
      expect(setup().reply(text).status).toBe("rejected");
    },
  );

  it("retains generation, policy, lease, plan and current authenticated owner checks", () => {
    for (const field of [
      "gatewayGeneration",
      "policyFingerprint",
      "activationLeaseHash",
      "nodeId",
    ] as const) {
      const state = setup();
      expect(
        state.reply("1", { security: { ...state.request.security, [field]: "changed" } }),
      ).toMatchObject({ status: "rejected", reason: "stale" });
    }
    const state = setup();
    state.replaceWireOwner({ accountId: "bot", userId: "other@im.wechat" });
    expect(state.reply()).toMatchObject({ status: "rejected", reason: "stale" });
  });

  it("rejects expired, absent and locally settled challenges", () => {
    expect(setup().reply("1", { now: 61_000 })).toMatchObject({
      status: "rejected",
      reason: "expired",
    });
    const state = setup();
    state.broker.markLocallyResolved("approval-A", "approved");
    expect(state.reply()).toMatchObject({ status: "rejected", reason: "inactive" });
    state.broker.invalidateAll("generation-changed");
    expect(state.reply("3", { messageId: "102", cursor: "102" }).status).toBe("rejected");
  });

  it("rejects a multi-request ambiguous challenge instead of displaying unusable bare choices", () => {
    const state = setup();
    const multiple = input();
    multiple.requests.push({ approval: { ...multiple.requests[0].approval, id: "second" } });
    expect(state.broker.createChallengeResult(multiple)).toEqual({
      status: "rejected",
      reason: "ambiguous-request-set",
    });
  });

  it("keeps coded replies backward-compatible without showing a required code", () => {
    const state = setup();
    expect(state.delivery.replyCode).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8}$/);
    expect(state.delivery.text).not.toContain(state.delivery.replyCode);
    expect(state.reply(`1 ${state.delivery.replyCode}`)).toMatchObject({ status: "approved" });
  });

  it("fences an already seen reply across replacement, even when the new source cursor precedes it", () => {
    const state = setup();
    expect(state.reply("1", { messageId: "201", cursor: "201" }).status).toBe("approved");
    const replacement = input(3_000, "approval-B");
    replacement.source.messageId = "200";
    replacement.source.cursor = "200";
    const delivery = state.broker.createChallenge(replacement);
    if (!delivery) throw new Error("Replacement failed");
    state.broker.markDelivered(delivery.challengeId, 3_001);
    expect(
      state.reply("1", {
        messageId: "201",
        cursor: "201",
        now: 3_002,
        requests: replacement.requests,
      }),
    ).toMatchObject({ status: "rejected", reason: "replayed" });
  });

  it("documents ACCEPTED RISK: a previously unseen delayed reply intended for expired A selects delivered B", () => {
    const state = setup();
    const replacement = input(70_000, "approval-B");
    replacement.source.messageId = "200";
    replacement.source.cursor = "200";
    const delivery = state.broker.createChallenge(replacement);
    if (!delivery) throw new Error("Replacement failed");
    state.broker.markDelivered(delivery.challengeId, 70_001);
    expect(
      state.reply("1", {
        messageId: "201",
        cursor: "201",
        now: 70_002,
        requests: replacement.requests,
      }),
    ).toMatchObject({ status: "approved", approvalIds: ["approval-B"] });
  });

  it("does not switch A to B during Main's awaited route revalidation", () => {
    const state = setup();
    const expectedSimpleChallengeId = state.broker.captureSimpleReplyChallenge(
      state.request.source,
      2_000,
    );
    const replacement = input(3_000, "approval-B");
    const delivery = state.broker.createChallenge(replacement);
    if (!delivery) throw new Error("Replacement failed");
    state.broker.markDelivered(delivery.challengeId, 3_001);
    expect(
      state.reply("1", { now: 3_002, requests: replacement.requests, expectedSimpleChallengeId }),
    ).toMatchObject({ status: "rejected", reason: "inactive" });
  });
});
