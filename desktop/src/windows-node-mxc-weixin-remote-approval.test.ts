import { describe, expect, it } from "vitest";

import type { WindowsNodeMxcGatewayApproval } from "./windows-node-mxc";
import {
  classifyWeixinRemoteApprovalPresentation,
  migrateWeixinRemoteApprovalConfiguration,
  normalizeWeixinRemoteApprovalOwner,
  renderWeixinRemoteApprovalPrompt,
  WindowsNodeMxcWeixinRemoteApprovalBroker,
  WINDOWS_NODE_MXC_WEIXIN_REMOTE_APPROVAL_MAX_ATTEMPTS,
  type WeixinRemoteApprovalCandidate,
  type WeixinRemoteApprovalCreateInput,
} from "./windows-node-mxc-weixin-remote-approval";

const approval: WindowsNodeMxcGatewayApproval = {
  id: "approval-1",
  command: "hostname.exe",
  executable: "hostname.exe",
  arguments: [],
  executablePath: "C:\\Windows\\System32\\hostname.exe",
  executableSha256: "a".repeat(64),
  canonicalCwd: "isolated-scratch:v1",
  agent: "main",
  sessionKey: "agent:main:weixin:owner",
  declaredAccess: [],
  hasMutableFileOperand: false,
  allowedDecisions: ["allow-once", "deny"],
};

function input(now = 1_000): WeixinRemoteApprovalCreateInput {
  return {
    source: {
      accountId: "BOT@IM.WECHAT",
      senderId: "OWNER@IM.WECHAT",
      conversationId: "OWNER@IM.WECHAT",
      messageId: "100",
      cursor: 100,
      agentId: "main",
      sessionKey: approval.sessionKey,
      direct: true,
      forwarded: false,
      quoted: false,
      receivedAtUnixMs: now,
    },
    requests: [{ approval }],
    security: {
      gatewayGeneration: "generation-1",
      policyFingerprint: "b".repeat(64),
      nodeId: "c".repeat(64),
      activationLeaseHash: "d".repeat(64),
      requestedMode: "limited-dacl",
      effectiveMode: "limited-dacl",
    },
    locale: "en-US",
    now,
  };
}

function configuredBroker(
  audit?: ConstructorParameters<typeof WindowsNodeMxcWeixinRemoteApprovalBroker>[0],
): WindowsNodeMxcWeixinRemoteApprovalBroker {
  const broker = new WindowsNodeMxcWeixinRemoteApprovalBroker(audit);
  broker.configure({
    enabled: true,
    owner: normalizeWeixinRemoteApprovalOwner(
      "BOT@IM.WECHAT",
      "OWNER@IM.WECHAT",
      "2026-10-14T00:00:00.000Z",
    ),
  });
  return broker;
}

function candidate(
  code: string,
  overrides: Partial<WeixinRemoteApprovalCandidate> = {},
): WeixinRemoteApprovalCandidate {
  const base = input();
  return {
    accountId: base.source.accountId,
    senderId: base.source.senderId,
    conversationId: base.source.conversationId,
    messageId: "101",
    cursor: 101,
    direct: true,
    forwarded: false,
    quoted: false,
    text: `1 ${code}`,
    now: 2_000,
    requests: base.requests,
    security: base.security,
    ...overrides,
  };
}

function codeFromPrompt(text: string): string {
  const match = /#([23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{8})\]/.exec(text);
  if (!match) throw new Error("challenge code missing");
  return match[1];
}

describe("WeChat remote approval broker", () => {
  it("migrates missing or invalid settings to default-off and preserves valid bindings", () => {
    expect(migrateWeixinRemoteApprovalConfiguration(undefined)).toEqual({
      enabled: false,
      owner: null,
    });
    expect(migrateWeixinRemoteApprovalConfiguration({ enabled: true, owner: null })).toEqual({
      enabled: false,
      owner: null,
    });
    expect(
      migrateWeixinRemoteApprovalConfiguration({
        enabled: true,
        owner: {
          accountId: "BOT@IM.WECHAT",
          userId: "OWNER@IM.WECHAT",
          boundAt: "2026-10-14T00:00:00.000Z",
        },
      }),
    ).toEqual({
      enabled: true,
      owner: normalizeWeixinRemoteApprovalOwner(
        "bot@im.wechat",
        "owner@im.wechat",
        "2026-10-14T00:00:00.000Z",
      ),
    });
  });

  it("is default-off and requires an exact authenticated owner binding", () => {
    const broker = new WindowsNodeMxcWeixinRemoteApprovalBroker();
    expect(broker.createChallenge(input())).toBeNull();
    expect(() => normalizeWeixinRemoteApprovalOwner("bot", "display name")).toThrow();
  });

  it.each([
    ["hostname.exe", "C:\\Windows\\System32\\hostname.exe", [], "hostname.exe"],
    ["whoami.exe", "C:\\Windows\\System32\\whoami.exe", [], "whoami.exe"],
    ["whoami.exe", "C:\\Windows\\System32\\whoami.exe", ["/user"], "whoami.exe /user"],
    ["whoami.exe", "C:\\Windows\\System32\\whoami.exe", ["/groups"], "whoami.exe /groups"],
    ["whoami.exe", "C:\\Windows\\System32\\whoami.exe", ["/priv"], "whoami.exe /priv"],
    ["ipconfig.exe", "C:\\Windows\\System32\\ipconfig.exe", [], "ipconfig.exe"],
    ["ipconfig.exe", "C:\\Windows\\System32\\ipconfig.exe", ["/all"], "ipconfig.exe /all"],
    ["systeminfo.exe", "C:\\Windows\\System32\\systeminfo.exe", [], "systeminfo.exe"],
  ] as const)(
    "allows only the exact predefined tuple %s %j",
    (executable, executablePath, argumentsValue, command) => {
      const broker = configuredBroker();
      const allowed = input();
      allowed.requests = [
        {
          approval: {
            ...approval,
            executable,
            executablePath,
            arguments: [...argumentsValue],
            command,
          },
        },
      ];
      expect(broker.createChallenge(allowed)).not.toBeNull();
    },
  );

  it.each([
    ["unknown executable", { executable: "curl.exe" }],
    ["unknown executable path", { executablePath: "C:\\Tools\\hostname.exe" }],
    ["unknown argument", { arguments: ["/unknown"] }],
    ["command drift", { command: "hostname.exe " }],
    ["declaration", { declaredAccess: [{ access: "ro" as const, path: "C:\\safe" }] }],
    ["non-scratch CWD", { canonicalCwd: "C:\\Temp" }],
    ["mutable operand", { hasMutableFileOperand: true }],
    [
      "missing one-use decision",
      { allowedDecisions: ["deny"] as WindowsNodeMxcGatewayApproval["allowedDecisions"] },
    ],
  ])("keeps structurally unrecognized %s requests local-only", (_name, approvalOverride) => {
    const broker = configuredBroker();
    const blocked = input();
    blocked.requests = [{ approval: { ...approval, ...approvalOverride } }];
    expect(broker.createChallenge(blocked)).toBeNull();
  });

  it("keeps unknown effective containment modes local-only", () => {
    const broker = configuredBroker();
    const blocked = input();
    blocked.security = { ...blocked.security, effectiveMode: "future-tier" };
    expect(broker.createChallenge(blocked)).toBeNull();
  });

  it.each([
    ["1", "allow-once", ["approval-1"]],
    ["2", "deny", ["approval-1"]],
    ["3", "allow-once", ["approval-1"]],
  ] as const)("resolves owner option %s exactly once", (option, decision, ids) => {
    const broker = configuredBroker();
    const delivery = broker.createChallenge(input())!;
    const code = codeFromPrompt(delivery.text);
    const result = broker.resolveCandidate(candidate(code, { text: `${option} ${code}` }));
    expect(result).toMatchObject({
      consumed: true,
      status: decision === "deny" ? "denied" : "approved",
      decision,
      approvalIds: ids,
    });
    if (result.status === "approved" || result.status === "denied") {
      broker.completeResolution(result.challengeId, result.status);
    }
    expect(
      broker.resolveCandidate(
        candidate(code, {
          cursor: 102,
          messageId: "102",
          requests: undefined,
          security: undefined,
        }),
      ),
    ).toMatchObject({ consumed: true, status: "rejected", reason: "replayed" });
  });

  it("limits option 3 to the explicitly enumerated originating-message batch", () => {
    const broker = configuredBroker();
    const batchInput = input();
    batchInput.requests = [
      { approval },
      {
        approval: {
          ...approval,
          id: "approval-2",
          command: "whoami.exe /groups",
          executable: "whoami.exe",
          executablePath: "C:\\Windows\\System32\\whoami.exe",
          arguments: ["/groups"],
        },
      },
    ];
    const delivery = broker.createChallenge(batchInput)!;
    const code = codeFromPrompt(delivery.text);
    expect(
      broker.resolveCandidate(
        candidate(code, { text: `3 ${code}`, requests: batchInput.requests }),
      ),
    ).toMatchObject({
      status: "approved",
      decision: "allow-once",
      approvalIds: ["approval-1", "approval-2"],
    });
  });

  it("keeps bare numeric messages ordinary but consumes exact or ambiguous code-shaped text", () => {
    const broker = configuredBroker();
    broker.createChallenge(input());
    expect(broker.resolveCandidate(candidate("", { text: "1" }))).toEqual({
      consumed: false,
      status: "not-candidate",
    });
    expect(
      broker.resolveCandidate(candidate("", { text: " 1 23456789 ", ambiguous: true })),
    ).toMatchObject({ consumed: true, status: "rejected", reason: "malformed" });
  });

  it("cannot create approval state from an agent-generated fake prompt", () => {
    const broker = configuredBroker();
    expect(broker.resolveCandidate(candidate("23456789"))).toMatchObject({
      consumed: true,
      status: "rejected",
      reason: "inactive",
    });
    expect(broker.getAuditEvents()).toEqual([]);
  });

  it.each([
    [{ senderId: "other@im.wechat" }, "identity"],
    [{ accountId: "other-bot@im.wechat" }, "identity"],
    [{ conversationId: "other@im.wechat" }, "identity"],
    [{ direct: false }, "group"],
    [{ forwarded: true }, "forwarded"],
    [{ quoted: true }, "quoted"],
    [{ cursor: 99 }, "cursor"],
    [{ cursor: 101, messageId: "100" }, "cursor"],
  ] as const)("fails closed for mismatched reply %#", (overrides, reason) => {
    const broker = configuredBroker();
    const delivery = broker.createChallenge(input())!;
    const code = codeFromPrompt(delivery.text);
    expect(broker.resolveCandidate(candidate(code, overrides))).toMatchObject({
      consumed: true,
      status: "rejected",
      reason,
    });
  });

  it("expires, bounds wrong-code attempts, and never logs the raw challenge", () => {
    const broker = configuredBroker();
    const delivery = broker.createChallenge(input())!;
    const code = codeFromPrompt(delivery.text);
    for (let index = 0; index < WINDOWS_NODE_MXC_WEIXIN_REMOTE_APPROVAL_MAX_ATTEMPTS; index++) {
      expect(
        broker.resolveCandidate(
          candidate("AAAAAAAA", {
            cursor: 101 + index,
            messageId: String(101 + index),
          }),
        ),
      ).toMatchObject({ consumed: true, status: "rejected", reason: "code" });
    }
    expect(JSON.stringify(broker.getAuditEvents())).not.toContain(code);

    const expired = configuredBroker();
    const expiredDelivery = expired.createChallenge(input())!;
    expect(
      expired.resolveCandidate(candidate(codeFromPrompt(expiredDelivery.text), { now: 200_000 })),
    ).toMatchObject({ status: "rejected", reason: "expired" });
  });

  it("enforces local-vs-remote first-response-wins", () => {
    const localFirst = configuredBroker();
    const localDelivery = localFirst.createChallenge(input())!;
    localFirst.markLocallyResolved("approval-1", "denied");
    expect(
      localFirst.resolveCandidate(candidate(codeFromPrompt(localDelivery.text))),
    ).toMatchObject({ status: "rejected", reason: "replayed" });

    const remoteFirst = configuredBroker();
    const remoteDelivery = remoteFirst.createChallenge(input())!;
    const result = remoteFirst.resolveCandidate(candidate(codeFromPrompt(remoteDelivery.text)));
    expect(result.status).toBe("approved");
    remoteFirst.markLocallyResolved("approval-1", "denied");
    if (result.status === "approved") {
      remoteFirst.completeResolution(result.challengeId, "approved");
    }
    expect(remoteFirst.getAuditEvents()).toEqual([
      expect.objectContaining({ result: "invalidated", reason: "local-denied" }),
    ]);
  });

  it.each([
    ["command", { command: "powershell.exe -File other.ps1" }],
    ["executable", { executable: "pwsh.exe" }],
    ["executablePath", { executablePath: "C:\\Other\\powershell.exe" }],
    ["executableSha256", { executableSha256: "f".repeat(64) }],
    ["arguments", { arguments: ["-File", "other.ps1"] }],
    ["canonicalCwd", { canonicalCwd: "C:\\Temp" }],
    ["declaredAccess", { declaredAccess: [{ access: "rw" as const, path: "C:\\Temp" }] }],
    ["agent", { agent: "other" }],
    ["sessionKey", { sessionKey: "agent:other:weixin:owner" }],
    ["mutable operand", { hasMutableFileOperand: true }],
    [
      "decisions",
      { allowedDecisions: ["deny"] as WindowsNodeMxcGatewayApproval["allowedDecisions"] },
    ],
  ])("rejects %s approval binding drift", (_field, approvalOverride) => {
    const broker = configuredBroker();
    const delivery = broker.createChallenge(input())!;
    expect(
      broker.resolveCandidate(
        candidate(codeFromPrompt(delivery.text), {
          requests: [{ approval: { ...approval, ...approvalOverride } }],
        }),
      ),
    ).toMatchObject({ status: "rejected", reason: "stale" });
  });

  it.each([
    ["gatewayGeneration", { gatewayGeneration: "generation-2" }],
    ["policyFingerprint", { policyFingerprint: "e".repeat(64) }],
    ["nodeId", { nodeId: "f".repeat(64) }],
    ["activationLeaseHash", { activationLeaseHash: "1".repeat(64) }],
    ["requestedMode", { requestedMode: "full" as const }],
    ["effectiveMode", { effectiveMode: "base-container" }],
  ])("rejects %s security binding drift", (_field, securityOverride) => {
    const broker = configuredBroker();
    const delivery = broker.createChallenge(input())!;
    expect(
      broker.resolveCandidate(
        candidate(codeFromPrompt(delivery.text), {
          security: { ...input().security, ...securityOverride },
        }),
      ),
    ).toMatchObject({ status: "rejected", reason: "stale" });
  });

  it("never sends raw authorization fields and keeps arbitrary free text local-only", () => {
    const broker = configuredBroker();
    const delivery = broker.createChallenge(input())!;
    expect(delivery.text).toContain("Windows host name");
    for (const rawValue of [
      approval.command,
      approval.executable,
      approval.executablePath,
      approval.executableSha256,
      approval.canonicalCwd,
      approval.agent!,
      approval.sessionKey,
    ]) {
      expect(delivery.text).not.toContain(rawValue);
    }

    const arbitrary = input();
    const duplicateJson = '{"safe":1,"safe":2,"number":9007199254740993}';
    const decomposed = "Cafe\u0301";
    arbitrary.requests = [
      {
        approval: {
          ...approval,
          command: `tool.exe "${decomposed}"`,
          executable: "tool.exe",
          executablePath: "C:\\Tools\\tool.exe",
          arguments: ["C:\\Users\\other-user\\Documents\\data.txt", duplicateJson, decomposed],
        },
      },
    ];
    expect(broker.createChallenge(arbitrary)).toBeNull();
  });

  it.each([
    ["C0 control", "\u0001"],
    ["C1 control", "\u0085"],
    ["line separator", "\u2028"],
    ["paragraph separator", "\u2029"],
    ["bidi override", "\u202e"],
    ["bidi isolate", "\u2066"],
    ["zero-width space", "\u200b"],
    ["variation selector", "\ufe0f"],
    ["combining grapheme joiner", "\u034f"],
    ["unpaired surrogate", "\ud800"],
  ])("keeps %s authorization values local-only", (_name, unsafeCharacter) => {
    const broker = configuredBroker();
    const unsafe = input();
    unsafe.requests = [
      {
        approval: {
          ...approval,
          arguments: ["-Command", `Write-Output safe${unsafeCharacter}Remove-Item C:\\Sensitive`],
        },
      },
    ];
    expect(broker.createChallenge(unsafe)).toBeNull();
  });

  it.each([
    "opaque-positional-password-value",
    "--passphrase=hunter2",
    "AccountKey=azure-storage-secret",
    "sv=2024-01-01&sig=azure-sas-secret",
    "//registry.npmjs.org/:_authToken=npm-secret",
    "xoxb-1234567890-1234567890-opaque",
    "X-Auth: custom-credential",
    "dGhpcy1pcy1hbi11bmtub3duLWNyZWRlbnRpYWw=",
    "--token=inline-secret",
    "--password adjacent-secret",
    "Authorization: Bearer abcdef",
    "Cookie: session=secret",
    '{"password":"json-secret"}',
    '{"clientSecret":"oauth-secret"}',
    "--myPrivateKeyFile=C:\\key.pem",
    "ghp_123456789012345678901234567890",
    "github_pat_123456789012345678901234567890",
    "https://owner:github_pat_123456789012345678901234567890@github.com/org/private.git",
    "https://opaque-credential@example.test/private",
    "-----BEGIN PRIVATE KEY-----",
  ])("keeps secret-bearing value local-only: %s", (secretValue) => {
    const broker = configuredBroker();
    const unsafe = input();
    unsafe.requests = [{ approval: { ...approval, arguments: [secretValue] } }];
    expect(broker.createChallenge(unsafe)).toBeNull();
    expect(JSON.stringify(broker.getAuditEvents())).not.toContain(secretValue);
  });

  it("enforces deterministic request, argument, declaration, line, and total caps", () => {
    const broker = configuredBroker();
    const tooManyArguments = input();
    tooManyArguments.requests = [
      {
        approval: {
          ...approval,
          arguments: Array.from({ length: 9 }, (_, index) => `arg-${index}`),
        },
      },
    ];
    expect(broker.createChallenge(tooManyArguments)).toBeNull();

    const tooManyDeclarations = input();
    tooManyDeclarations.requests = [
      {
        approval: {
          ...approval,
          declaredAccess: Array.from({ length: 9 }, (_, index) => ({
            access: "ro" as const,
            path: `C:\\safe\\${index}`,
          })),
        },
      },
    ];
    expect(broker.createChallenge(tooManyDeclarations)).toBeNull();

    const oversizedLine = input();
    oversizedLine.requests = [{ approval: { ...approval, arguments: ["x".repeat(200)] } }];
    expect(broker.createChallenge(oversizedLine)).toBeNull();

    const tooManyRequests = input();
    tooManyRequests.requests = Array.from({ length: 9 }, (_, index) => ({
      approval: { ...approval, id: `approval-${index}`, command: `cmd-${index}` },
    }));
    expect(broker.createChallenge(tooManyRequests)).toBeNull();
  });

  it("renders truthful English and Chinese one-use option copy", () => {
    const presentation = classifyWeixinRemoteApprovalPresentation([{ approval }], input().security);
    expect(presentation).not.toBeNull();
    for (const locale of ["en-US", "zh-CN"] as const) {
      const prompt = renderWeixinRemoteApprovalPrompt({
        code: "23456789",
        expiresAtUnixMs: 123_000,
        presentation: presentation!,
        locale,
      });
      expect(prompt).toContain(`1 23456789`);
      expect(prompt).toContain(`2 23456789`);
      expect(prompt).toContain(`3 23456789`);
      expect(prompt).not.toContain(approval.executableSha256);
      expect(prompt).not.toContain(approval.canonicalCwd);
      expect(prompt).not.toContain(approval.sessionKey);
      expect(prompt).toMatch(
        locale === "zh-CN" ? /不会创建永久授权/ : /no durable or future approval/,
      );
    }
  });

  it("audits only hashes and non-secret metadata after actual Electron resolution", () => {
    const events: unknown[] = [];
    const broker = configuredBroker((event) => events.push(event));
    const delivery = broker.createChallenge(input())!;
    const code = codeFromPrompt(delivery.text);
    const result = broker.resolveCandidate(candidate(code));
    expect(events).toEqual([]);
    expect(result.status).toBe("approved");
    if (result.status === "approved") {
      broker.completeResolution(result.challengeId, "approved");
    }
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(code);
    expect(serialized).not.toContain(approval.id);
    expect(serialized).not.toContain(approval.command);
    expect(events).toEqual([
      expect.objectContaining({
        result: "approved",
        reason: "approved",
        approvalIdHashes: [expect.stringMatching(/^[a-f0-9]{64}$/)],
      }),
    ]);
  });

  it("invalidates on relock, Off, restart, logout, rebind, disable, and request supersession", () => {
    for (const reason of [
      "security-relock",
      "mxc-off",
      "gateway-generation-change",
      "weixin-logout",
      "configuration-changed",
      "feature-disabled",
      "superseded",
    ]) {
      const broker = configuredBroker();
      const delivery = broker.createChallenge(input())!;
      if (reason === "superseded") {
        broker.createChallenge({ ...input(), source: { ...input().source, messageId: "101" } });
      } else {
        broker.invalidateAll(reason);
      }
      const result = broker.resolveCandidate(
        candidate(codeFromPrompt(delivery.text), { cursor: 102 }),
      );
      expect(result).toMatchObject({ consumed: true, status: "rejected" });
      if (reason !== "superseded") {
        expect(result).toMatchObject({ reason: "replayed" });
      }
    }
  });
});
