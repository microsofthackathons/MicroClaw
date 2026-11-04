import { describe, expect, it, vi } from "vitest";

import type { WindowsNodeMxcGatewayApproval } from "./windows-node-mxc";
import { createPowerShellFilesystemInitialization } from "./windows-node-mxc-powershell-scope";
// @ts-expect-error External ESM Windows quoting fixture.
import { windowsCommand } from "../integration/windows-command-fixture.mjs";
import {
  migrateWeixinRemoteApprovalConfiguration,
  projectWeixinRemoteApprovalRuntimeConfiguration,
  normalizeWeixinRemoteApprovalOwner,
  WindowsNodeMxcWeixinRemoteApprovalBroker,
  WINDOWS_NODE_MXC_WEIXIN_REMOTE_APPROVAL_MAX_ATTEMPTS,
  WEIXIN_NATIVE_DURABLE_CONSENT_SCOPE,
  weixinRemoteApprovalConsentHash,
  type WeixinRemoteApprovalCandidate,
  type WeixinRemoteApprovalCreateInput,
  type WeixinRemoteApprovalConfiguration,
} from "./windows-node-mxc-weixin-remote-approval";
import { canonicalWindowsCommand } from "./windows-node-mxc-exec-presentation";

const approval: WindowsNodeMxcGatewayApproval = {
  id: "approval-1",
  command: "whoami.exe /all",
  executable: "whoami.exe",
  arguments: ["/all"],
  executablePath: "C:\\Windows\\System32\\whoami.exe",
  executableSha256: "a".repeat(64),
  canonicalCwd: "isolated-scratch:v1",
  agent: "main",
  sessionKey: "agent:main:weixin:owner",
  origin: {
    contract: "microclaw.gateway-approval-origin.v1",
    gatewayGeneration: "generation-1",
    agentId: "main",
    runSessionKey: "agent:main:weixin:owner",
    executionSessionKey: "agent:main:weixin:owner",
    runId: "actual-run",
    toolCallId: "actual-tool",
    nodeId: "c".repeat(64),
    channel: "openclaw-weixin",
    accountId: "bot@im.wechat",
    to: "OWNER@IM.WECHAT",
  },
  declaredAccess: [],
  hasMutableFileOperand: false,
  allowedDecisions: ["allow-once", "allow-always", "deny"],
};

describe("native consent capability across the real runtime configuration projection", () => {
  const owner = normalizeWeixinRemoteApprovalOwner(
    "bot",
    "owner@im.wechat",
    "2026-10-20T00:00:00.000Z",
  );
  it("preserves an existing validated native durable marker and exact owner epoch", () => {
    const stored = { enabled: true, owner, consentScope: WEIXIN_NATIVE_DURABLE_CONSENT_SCOPE };
    const projected = projectWeixinRemoteApprovalRuntimeConfiguration(stored, true);
    expect(projected).toEqual(stored);
    expect(weixinRemoteApprovalConsentHash(projected)).not.toBeNull();
  });
  it("does not upgrade a legacy owner or an invalid marker", () => {
    for (const stored of [
      { enabled: true, owner },
      { enabled: true, owner, consentScope: "invalid" },
    ]) {
      const projected = projectWeixinRemoteApprovalRuntimeConfiguration(stored, true);
      expect(projected.enabled).toBe(true);
      expect(projected.consentScope).toBeUndefined();
      expect(weixinRemoteApprovalConsentHash(projected)).toBeNull();
    }
  });
  it("still gates authority on the current authenticated runtime", () => {
    const projected = projectWeixinRemoteApprovalRuntimeConfiguration(
      { enabled: true, owner, consentScope: WEIXIN_NATIVE_DURABLE_CONSENT_SCOPE },
      false,
    );
    expect(projected.enabled).toBe(false);
    expect(weixinRemoteApprovalConsentHash(projected)).toBeNull();
  });
});

function input(now = 1_000): WeixinRemoteApprovalCreateInput {
  return {
    source: {
      accountId: "bot@im.wechat",
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
      gatewayGeneration: "generation-1",
      runIds: ["actual-run"],
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
  const broker = new WindowsNodeMxcWeixinRemoteApprovalBroker(audit, () => ({
    accountId: "bot@im.wechat",
    userId: "OWNER@IM.WECHAT",
  }));
  const owner = normalizeWeixinRemoteApprovalOwner(
    "BOT@IM.WECHAT",
    "OWNER@IM.WECHAT",
    "2026-10-14T00:00:00.000Z",
  );
  broker.configure({
    enabled: true,
    consentScope: WEIXIN_NATIVE_DURABLE_CONSENT_SCOPE,
    owner,
  });
  const create = broker.createChallenge.bind(broker);
  vi.spyOn(broker, "createChallenge").mockImplementation((value) => {
    const delivery = create(value);
    if (delivery) broker.markDelivered(delivery.challengeId, value.now ?? Date.now());
    return delivery;
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
    agentId: base.source.agentId,
    sessionKey: base.source.sessionKey,
    text: `1 ${code}`,
    now: 2_000,
    requests: base.requests,
    security: base.security,
    ...overrides,
  };
}

describe("WeChat stock CMD approvals", () => {
  function cmdInput(payload: string, folders = false): WeixinRemoteApprovalCreateInput {
    const request = input();
    request.requests = [
      {
        approval: {
          ...approval,
          command: windowsCommand(["cmd.exe", "/d", "/s", "/c", payload]),
          executable: "cmd.exe",
          executablePath: "C:\\Windows\\System32\\cmd.exe",
          arguments: ["/d", "/s", "/c", payload],
          declaredAccess: folders ? [{ access: "rw", path: "C:\\Work" }] : [],
          folderChanges: folders ? [{ access: "rw", path: "C:\\Work" }] : undefined,
          allowedDecisions: ["allow-once", "deny"],
          commandConsent: { required: true, allowAlwaysAvailable: false },
          policyFingerprint: request.security.policyFingerprint,
          planSha256: "e".repeat(64),
        },
      },
    ];
    return request;
  }

  it("allows a single safe stock CMD command once, not as a durable phone approval", () => {
    const request = cmdInput("git status");
    const broker = configuredBroker();
    const delivery = broker.createChallenge(request)!;

    expect(delivery.text).toContain('cmd.exe /d /s /c "git status"');
    expect(delivery.text).not.toContain("2: remember");
    expect(
      broker.resolveCandidate(candidate(delivery.replyCode, { requests: request.requests })),
    ).toMatchObject({ status: "approved", decision: "allow-once" });
  });

  it("retains a single combined folder and command approval for a literal CMD operation", () => {
    const request = cmdInput("mkdir C:\\Work\\child", true);
    const broker = configuredBroker();
    const delivery = broker.createChallenge(request)!;

    expect(delivery.text).toContain("mkdir C:\\Work\\child");
    expect(delivery.text).toContain("New persistent folder grants:");
    expect(delivery.text).toContain("C:\\Work");
    expect(delivery.text).toContain("Read/write:");
    expect(delivery.text).toContain("command runs once");
    expect(
      broker.resolveCandidate(candidate(delivery.replyCode, { requests: request.requests })),
    ).toMatchObject({ status: "approved", decision: "allow-once" });
  });

  it.each([
    "git status & whoami",
    "git status | whoami",
    "git status\nwhoami",
    "mkdir C:\\Work\\foo^&whoami",
    "mkdir C:\\Other\\child",
    "danger.bat",
    "powershell -Command whoami",
  ])("supports generic CMD text without changing its execution plan: %s", (payload) => {
    const request = cmdInput(payload, true);
    const before = structuredClone(request.requests);
    expect(configuredBroker().createChallengeResult(request).status).toBe("created");
    expect(request.requests).toEqual(before);
  });

  it("discloses a read-only declaration without inferring broader access from the command", () => {
    const request = cmdInput("mkdir C:\\Work\\child");
    request.requests[0].approval.declaredAccess = [{ access: "ro", path: "C:\\Work" }];
    const delivery = configuredBroker().createChallenge(request)!;
    expect(delivery.text).toContain("Read-only:");
    expect(delivery.text).not.toContain("New persistent folder grants:");
    expect(request.requests[0].approval.declaredAccess).toEqual([
      { access: "ro", path: "C:\\Work" },
    ]);
  });

  it.each(["en-US", "zh-CN"] as const)(
    "renders the wrapped PowerShell operation while binding approval to the unchanged CMD plan (%s)",
    (locale) => {
      const request = cmdInput("powershell -NoProfile -Command \"Test-Path 'C:\\Work\\a folder'\"");
      request.locale = locale;
      request.requests[0].approval.declaredAccess = [{ access: "ro", path: "C:\\Work" }];
      const before = structuredClone(request);
      const broker = configuredBroker();
      const delivery = broker.createChallenge(request)!;

      expect(delivery).not.toBeNull();
      expect(delivery.text).toContain("Test-Path");
      expect(delivery.text).toContain("C:\\Work\\a folder");
      expect(delivery.text).toContain("C:\\Windows\\System32\\cmd.exe");
      expect(delivery.text).toContain(locale === "en-US" ? "Read-only:" : "只读：");
      expect(delivery.text).not.toMatch(/^(?:Reply |回复 )?2[:：]/m);
      expect(delivery.text).not.toMatch(/powershell\.exe|initialization/);
      expect(request).toEqual(before);
      expect(
        broker.resolveCandidate(candidate(delivery.replyCode, { requests: request.requests })),
      ).toMatchObject({ status: "approved", decision: "allow-once" });
      expect(request).toEqual(before);
    },
  );

  it("preserves combined folder approval for a wrapped literal create", () => {
    const request = cmdInput(
      "powershell -NoProfile -Command \"New-Item -ItemType Directory -Path 'C:\\Work\\child' -Force\"",
      true,
    );
    const delivery = configuredBroker().createChallenge(request)!;
    expect(delivery).not.toBeNull();
    expect(delivery.text).toContain("New-Item");
    expect(delivery.text).toContain("C:\\Work\\child");
    expect(delivery.text).toContain("Read/write:");
    expect(delivery.text).toContain("Force");
    expect(delivery.text).toContain("this command runs once");
    expect(delivery.text).not.toContain("2: remember");
  });

  it.each(["payload", "wrapper", "command", "cwd", "access", "agent", "session"] as const)(
    "rejects a changed wrapped command %s after the phone prompt",
    (field) => {
      const request = cmdInput("powershell -NoProfile -Command \"Test-Path 'C:\\Work\\a'\"");
      request.requests[0].approval.declaredAccess = [{ access: "ro", path: "C:\\Work" }];
      const broker = configuredBroker();
      const delivery = broker.createChallenge(request)!;
      expect(delivery).not.toBeNull();
      const changed = structuredClone(request.requests);
      const value = changed[0].approval;
      if (field === "payload") value.arguments[3] = value.arguments[3].replace("\\a'", "\\b'");
      if (field === "wrapper") value.arguments[0] = "/v:on";
      if (field === "command") value.command += " ";
      if (field === "cwd") value.canonicalCwd = "C:\\Work";
      if (field === "access") value.declaredAccess[0].access = "rw";
      if (field === "agent") value.agent = "other";
      if (field === "session") value.sessionKey += ":other";
      expect(
        broker.resolveCandidate(candidate(delivery.replyCode, { requests: changed })),
      ).toMatchObject({ status: "rejected" });
    },
  );

  it.each([
    "type C:\\Work\\%SECRET%",
    "type C:\\Work\\credentials.txt",
    "powershell -NoProfile -Command \"Test-Path 'C:\\Work\\password_cache'\"",
    "powershell -EncodedCommand dGVzdA==",
  ])("keeps recognizable sensitive or encoded CMD content on Desktop: %s", (payload) => {
    expect(configuredBroker().createChallenge(cmdInput(payload, true))).toBeNull();
  });

  it.each([
    "powershell -NoProfile -Command \"Set-Content -Path 'C:\\Work\\a' -Value 'ordinary inline text'\"",
    "powershell -NoProfile -Command \"Test-Path 'C:\\Other\\a'\"",
    "powershell -NoProfile -Command \"Test-Path 'C:\\Work\\a'\" & whoami",
    "powershell -NoProfile -Command \"Get-Content 'C:\\Work\\a'\"",
  ])("presents ordinary wrapped PowerShell without a command-family allowlist: %s", (payload) => {
    expect(configuredBroker().createChallengeResult(cmdInput(payload, true)).status).toBe(
      "created",
    );
  });
});

describe("WeChat combined folder approvals", () => {
  function folderInput() {
    const request = input();
    request.requests = [
      {
        approval: {
          ...approval,
          canonicalCwd: "C:\\Work",
          declaredAccess: [{ path: "C:\\Work", access: "rw" }],
          folderChanges: [
            { path: "C:\\Work", access: "rw" },
            { path: "C:\\Reference", access: "ro" },
          ],
          allowedDecisions: ["allow-once", "deny"],
          policyFingerprint: request.security.policyFingerprint,
          planSha256: "e".repeat(64),
        },
      },
    ];
    return request;
  }
  it.each(["en-US", "zh-CN"] as const)(
    "discloses persistent exact grants with only Allow and Deny (%s)",
    (locale) => {
      const broker = configuredBroker();
      const request = { ...folderInput(), locale };
      const delivery = broker.createChallenge(request)!;
      expect(delivery).not.toBeNull();
      expect(delivery.text).toContain("C:\\Work");
      expect(delivery.text).toContain("C:\\Reference");
      expect(delivery.text).toContain(locale === "en-US" ? "Read/write:" : "读写：");
      expect(delivery.text).toContain(locale === "en-US" ? "Read-only:" : "只读：");
      expect(delivery.text).toContain(
        locale === "en-US" ? "until removed in Settings" : "直到在设置中移除",
      );
      expect(delivery.text).toContain(locale === "en-US" ? "Reply 1: allow" : "回复 1：允许");
      expect(delivery.text).toContain(locale === "en-US" ? "3: deny" : "3：拒绝");
      expect(delivery.text).not.toMatch(/^(?:Reply |回复 )?2[:：]/m);
      expect(
        broker.resolveCandidate(candidate(delivery.replyCode, { requests: request.requests })),
      ).toMatchObject({ status: "approved", decision: "allow-once" });
    },
  );
  it.each(["path", "access", "plan", "policy"] as const)(
    "rejects changed %s consent on reply",
    (field) => {
      const broker = configuredBroker();
      const request = folderInput();
      const delivery = broker.createChallenge(request)!;
      const changed = structuredClone(request.requests);
      const value = changed[0].approval;
      if (field === "path") value.folderChanges![0].path = "C:\\Other";
      if (field === "access") value.folderChanges![1].access = "rw";
      if (field === "plan") value.planSha256 = "f".repeat(64);
      if (field === "policy") value.policyFingerprint = "f".repeat(64);
      expect(
        broker.resolveCandidate(candidate(delivery.replyCode, { requests: changed })).status,
      ).toBe("rejected");
    },
  );
  it("never treats folder consent as a remembered command approval", () => {
    const broker = configuredBroker();
    const request = folderInput();
    const delivery = broker.createChallenge(request)!;
    expect(
      broker.resolveCandidate(
        candidate(delivery.replyCode, {
          requests: request.requests,
          text: `2 ${delivery.replyCode}`,
        }),
      ).status,
    ).toBe("rejected");
    request.requests[0].approval.allowedDecisions.push("allow-always");
    expect(broker.createChallengeResult(request)).toEqual({
      status: "rejected",
      reason: "security-binding-invalid",
    });
  });
  it.each(["C:\\Work\u202eHidden", "C:\\Secrets\\api-key", "C:\\Work\\" + "x".repeat(6000)])(
    "keeps unsafe or unrenderable folder grants local: %s",
    (folder) => {
      const request = folderInput();
      request.requests[0].approval.folderChanges![0].path = folder;
      expect(configuredBroker().createChallenge(request)).toBeNull();
    },
  );
  it("preserves only the consumed exact resolution across its own policy update", () => {
    const audit = vi.fn();
    const broker = configuredBroker(audit);
    const request = folderInput();
    const delivery = broker.createChallenge(request)!;
    expect(
      broker.resolveCandidate(candidate(delivery.replyCode, { requests: request.requests })).status,
    ).toBe("approved");
    const another = input();
    another.requests = [{ approval: { ...approval, id: "other-approval" } }];
    broker.createChallenge(another);
    expect(broker.invalidateAll("live-folder-update", approval.id)).toHaveLength(1);
    broker.completeResolution(delivery.challengeId, "approved");
    expect(audit).toHaveBeenLastCalledWith(expect.objectContaining({ result: "approved" }));
    expect(
      broker.resolveCandidate(candidate(delivery.replyCode, { requests: request.requests })).status,
    ).toBe("rejected");
  });
  it("does not preserve an unconsumed prompt or survive a real relock", () => {
    const audit = vi.fn();
    const broker = configuredBroker(audit);
    const request = folderInput();
    const delivery = broker.createChallenge(request)!;
    broker.invalidateAll("live-folder-update", approval.id);
    expect(
      broker.resolveCandidate(candidate(delivery.replyCode, { requests: request.requests })).status,
    ).toBe("rejected");
    const next = broker.createChallenge({ ...request, now: 3000 })!;
    broker.resolveCandidate(candidate(next.replyCode, { requests: request.requests, now: 4000 }));
    broker.invalidateAll("real-relock");
    audit.mockClear();
    broker.completeResolution(next.challengeId, "approved");
    expect(audit).not.toHaveBeenCalled();
  });
  it.each(["base-container", "appcontainer-bfs"])(
    "supports exact prepared PowerShell in Full %s",
    (effectiveMode) => {
      const request = input();
      request.security = { ...request.security, requestedMode: "full", effectiveMode };
      const access = [{ path: "C:\\Work", access: "rw" as const }];
      const executablePath = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
      const initialization = createPowerShellFilesystemInitialization(
        [
          "powershell.exe",
          "-NoProfile",
          "-Command",
          "Remove-Item -Path 'C:\\Work\\file.txt' -Force",
        ],
        executablePath,
        access,
      )!;
      expect(initialization).not.toBeNull();
      request.requests = [
        {
          approval: {
            ...approval,
            executable: "powershell.exe",
            executablePath,
            arguments: initialization.finalArgv.slice(1),
            command: `powershell.exe -NoProfile -Command "${initialization.finalArgv.at(-1)}"`,
            declaredAccess: access,
            providerInitialization: initialization,
          },
        },
      ];
      expect(configuredBroker().createChallengeResult(request).status).toBe("created");
      request.security.effectiveMode = "appcontainer-dacl";
      expect(configuredBroker().createChallengeResult(request)).toEqual({
        status: "rejected",
        reason: "security-binding-invalid",
      });
    },
  );
});

describe("WeChat Windows Node command consent", () => {
  function upstreamConsentInput() {
    const request = input();
    request.requests = [
      {
        approval: {
          ...approval,
          commandConsent: { required: true, allowAlwaysAvailable: true },
        },
      },
    ];
    return request;
  }

  it("allows one-use approval without extending old conversation consent to agent-wide rules", () => {
    const broker = configuredBroker();
    const request = upstreamConsentInput();
    const delivery = broker.createChallenge(request)!;

    expect(delivery.text).not.toMatch(/2: remember/);
    expect(
      broker.resolveCandidate(candidate(delivery.replyCode, { requests: request.requests })),
    ).toMatchObject({ status: "approved", decision: "allow-once" });
  });

  it("rejects a remote remember decision and binds the consent preview", () => {
    const request = upstreamConsentInput();
    const broker = configuredBroker();
    const delivery = broker.createChallenge(request)!;
    expect(
      broker.resolveCandidate(
        candidate(delivery.replyCode, {
          requests: request.requests,
          text: `2 ${delivery.replyCode}`,
        }),
      ).status,
    ).not.toBe("approved");

    const changed = upstreamConsentInput();
    const anotherBroker = configuredBroker();
    const anotherDelivery = anotherBroker.createChallenge(changed)!;
    changed.requests[0].approval.commandConsent!.required = false;
    expect(
      anotherBroker.resolveCandidate(
        candidate(anotherDelivery.replyCode, { requests: changed.requests }),
      ).status,
    ).toBe("rejected");
  });
});

describe("WeChat remote approval broker", () => {
  it("does not expose mutable owner authority through configuration snapshots", () => {
    const broker = configuredBroker();
    const snapshot = broker.getConfiguration();
    const originalUserId = snapshot.owner!.userId;
    snapshot.owner!.userId = "other@im.wechat";
    expect(broker.getConfiguration().owner!.userId).toBe(originalUserId);
    expect(broker.createChallengeResult(input()).status).toBe("created");
  });

  it("preserves legacy once-only consent without manufacturing durable authority and hashes the native scope and epoch", () => {
    const legacy = { enabled: true, owner: configuredBroker().getConfiguration().owner };
    expect(migrateWeixinRemoteApprovalConfiguration(legacy)).toEqual(legacy);
    expect(weixinRemoteApprovalConsentHash(legacy)).toBeNull();
    expect(
      weixinRemoteApprovalConsentHash(
        migrateWeixinRemoteApprovalConfiguration({
          ...legacy,
          consentScope: "renderer-selected",
        }),
      ),
    ).toBeNull();
    const current: WeixinRemoteApprovalConfiguration = {
      ...legacy,
      consentScope: WEIXIN_NATIVE_DURABLE_CONSENT_SCOPE,
    };
    expect(migrateWeixinRemoteApprovalConfiguration(current)).toEqual(current);
    expect(weixinRemoteApprovalConsentHash(current)).toMatch(/^[a-f0-9]{64}$/);
    expect(
      weixinRemoteApprovalConsentHash({
        ...current,
        owner: normalizeWeixinRemoteApprovalOwner(
          "BOT@IM.WECHAT",
          "OWNER@IM.WECHAT",
          "2026-10-15T00:00:00.000Z",
        ),
      }),
    ).not.toBe(weixinRemoteApprovalConsentHash(current));
  });

  it.each([
    ["1", "allow-once"],
    ["3", "deny"],
  ] as const)(
    "keeps legacy %s available after refusing durable approval without resetting the deadline",
    (digit, decision) => {
      const broker = configuredBroker();
      broker.configure({ ...broker.getConfiguration(), consentScope: undefined });
      const delivery = broker.createChallenge(input())!;
      expect(delivery.text).not.toMatch(/2: remember|renew local native consent|off and/);
      const code = delivery.replyCode;
      const rejected = broker.resolveCandidate(candidate(code, { text: `2 ${code}` }));
      expect(rejected).toMatchObject({ status: "rejected", reason: "consent-scope" });
      expect(rejected).toMatchObject({
        acknowledgement: expect.stringContaining("original deadline unchanged"),
      });
      expect(
        broker.resolveCandidate(
          candidate(code, {
            cursor: 102,
            messageId: "102",
            now: 2_100,
            text: `2 ${code}`,
          }),
        ),
      ).toMatchObject({ status: "rejected", acknowledgement: "" });
      expect(
        broker.resolveCandidate(
          candidate(code, {
            cursor: 103,
            messageId: "103",
            now: 2_200,
            text: `${digit} ${code}`,
          }),
        ),
      ).toMatchObject({ status: decision === "deny" ? "denied" : "approved", decision });
    },
  );

  it("invalidates pending authority when native durable consent is renewed or removed", () => {
    const broker = configuredBroker();
    const configuration = broker.getConfiguration();
    const delivery = broker.createChallenge(input())!;
    broker.configure({ ...configuration, consentScope: undefined });
    expect(broker.resolveCandidate(candidate(delivery.replyCode))).toMatchObject({
      status: "rejected",
    });
    broker.configure(configuration);
    const renewed = broker.createChallenge(input())!;
    expect(
      broker.resolveCandidate(
        candidate(renewed.replyCode, {
          text: `2 ${renewed.replyCode}`,
          messageId: "102",
          cursor: 102,
        }),
      ),
    ).toMatchObject({ status: "rejected" });
    expect(
      broker.resolveCandidate(
        candidate(renewed.replyCode, {
          text: `1 ${renewed.replyCode}`,
          messageId: "103",
          cursor: 103,
        }),
      ),
    ).toMatchObject({ status: "approved", decision: "allow-once" });
  });

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
    ["1", "allow-once", ["approval-1"]],
    ["3", "deny", ["approval-1"]],
  ] as const)("resolves owner option %s exactly once", (option, decision, ids) => {
    const broker = configuredBroker();
    const delivery = broker.createChallenge(input())!;
    const code = delivery.replyCode;
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

  it("keeps ambiguous multi-request batches local-only", () => {
    const broker = configuredBroker();
    const batchInput = input();
    batchInput.requests = [
      { approval },
      {
        approval: {
          ...approval,
          id: "approval-2",
          command: "hostname.exe",
          executable: "hostname.exe",
          executablePath: "C:\\Windows\\System32\\hostname.exe",
          arguments: [],
        },
      },
    ];
    expect(broker.createChallengeResult(batchInput)).toEqual({
      status: "rejected",
      reason: "ambiguous-request-set",
    });
  });

  it("accepts exact bare input but still rejects ambiguous input", () => {
    const broker = configuredBroker();
    broker.createChallenge(input());
    expect(broker.resolveCandidate(candidate("", { text: "1" }))).toMatchObject({
      consumed: true,
      status: "approved",
      decision: "allow-once",
    });
    broker.createChallenge(input());
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
    const code = delivery.replyCode;
    expect(broker.resolveCandidate(candidate(code, overrides))).toMatchObject({
      consumed: true,
      status: "rejected",
      reason,
    });
  });

  it("expires, bounds wrong-code attempts, and never logs the raw challenge", () => {
    const broker = configuredBroker();
    const delivery = broker.createChallenge(input())!;
    const code = delivery.replyCode;
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
      expired.resolveCandidate(candidate(expiredDelivery.replyCode, { now: 200_000 })),
    ).toMatchObject({ status: "rejected", reason: "expired" });
  });

  it("enforces local-vs-remote first-response-wins", () => {
    const localFirst = configuredBroker();
    const localDelivery = localFirst.createChallenge(input())!;
    localFirst.markLocallyResolved("approval-1", "denied");
    expect(localFirst.resolveCandidate(candidate(localDelivery.replyCode))).toMatchObject({
      status: "rejected",
      reason: "replayed",
    });

    const remoteFirst = configuredBroker();
    const remoteDelivery = remoteFirst.createChallenge(input())!;
    const result = remoteFirst.resolveCandidate(candidate(remoteDelivery.replyCode));
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
        candidate(delivery.replyCode, {
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
        candidate(delivery.replyCode, {
          security: { ...input().security, ...securityOverride },
        }),
      ),
    ).toMatchObject({ status: "rejected", reason: "stale" });
  });

  it("renders safely classified values without trimming, path rewriting, or number conversion", () => {
    const broker = configuredBroker();
    const exact = input();
    const exactPath = "C:\\Users\\other-user\\Documents\\Data-01.txt";
    exact.requests = [
      {
        approval: {
          ...approval,
          command: `whoami.exe ${exactPath} --mode -7.50`,
          arguments: [exactPath, "--mode", "-7.50"],
        },
      },
    ];
    const delivery = broker.createChallenge(exact)!;
    expect(delivery.text).toContain(exactPath);
    expect(delivery.text).toContain("-7.50");
    expect(exact.requests[0].approval.arguments).toEqual([exactPath, "--mode", "-7.50"]);
    expect(delivery.text).not.toContain("%USERPROFILE%");
  });

  it.each(['{"safe":1,"safe":2,"number":9007199254740993}', "Cafe\u0301", "任意文本"])(
    "renders unclassified exact text without transforming it: %s",
    (value) => {
      const broker = configuredBroker();
      const exact = input();
      exact.requests = [
        {
          approval: {
            ...approval,
            command: canonicalWindowsCommand(["whoami.exe", value]),
            arguments: [value],
          },
        },
      ];
      expect(broker.createChallenge(exact)).not.toBeNull();
    },
  );

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
          arguments: ["-Command", `Write-Output safe${unsafeCharacter}Remove-Item C:\\Public`],
          command: canonicalWindowsCommand([
            "whoami.exe",
            "-Command",
            `Write-Output safe${unsafeCharacter}Remove-Item C:\\Public`,
          ]),
        },
      },
    ];
    expect(broker.createChallenge(unsafe)).toBeNull();
  });

  it.each([
    "--******",
    "--passphrase=correct-horse-battery-staple",
    "AccountKey=abcdefghijklmnopqrstuvwxyz0123456789+/=",
    "sv=2026-01-01&sig=abcdefghijklmnopqrstuvwxyz0123456789",
    "npm_abcdefghijklmnopqrstuvwxyz0123456789",
    ["xoxb", "123456789012", "123456789012", "abcdefghijklmnopqrstuvwxyz"].join("-"),
  ])("keeps known missed credential form %# local-only", (secretValue) => {
    const broker = configuredBroker();
    const unsafe = input();
    unsafe.requests = [
      {
        approval: {
          ...approval,
          arguments: [secretValue],
          command: canonicalWindowsCommand([approval.executable, secretValue]),
        },
      },
    ];
    expect(broker.createChallenge(unsafe)).toBeNull();
    expect(JSON.stringify(broker.getAuditEvents())).not.toContain(secretValue);
  });

  it.each([
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
  ])("keeps secret-bearing value %# local-only", (secretValue) => {
    const broker = configuredBroker();
    const unsafe = input();
    unsafe.requests = [
      {
        approval: {
          ...approval,
          arguments: [secretValue],
          command: canonicalWindowsCommand([approval.executable, secretValue]),
        },
      },
    ];
    expect(broker.createChallenge(unsafe)).toBeNull();
    expect(JSON.stringify(broker.getAuditEvents())).not.toContain(secretValue);
  });

  it.each([
    "--opaque=value",
    "hunter2",
    "shortvalue",
    "123456",
    "654321",
    "correct horse battery staple",
    "abcdefghijklmnopqrstuvwxyz0123456789",
    "https://example.test/path",
    '{"unknown":"free-text"}',
  ])("supports ordinary free-form value without assuming it is public: %s", (unknownValue) => {
    const broker = configuredBroker();
    const unsafe = input();
    unsafe.requests = [
      {
        approval: {
          ...approval,
          arguments: [unknownValue],
          command: canonicalWindowsCommand([approval.executable, unknownValue]),
        },
      },
    ];
    expect(broker.createChallenge(unsafe)).not.toBeNull();
  });

  it("supports an unknown switch and its value without a command-family allowlist", () => {
    const broker = configuredBroker();
    const unsafe = input();
    const arguments_ = ["--opaque", "shortvalue"];
    unsafe.requests = [
      {
        approval: {
          ...approval,
          arguments: arguments_,
          command: canonicalWindowsCommand([approval.executable, ...arguments_]),
        },
      },
    ];
    expect(broker.createChallenge(unsafe)).not.toBeNull();
  });

  it("wraps ordinary arguments and declarations while bounding complete prompts and request sets", () => {
    const broker = configuredBroker();
    const tooManyArguments = input();
    tooManyArguments.requests = [
      {
        approval: {
          ...approval,
          arguments: Array.from({ length: 9 }, (_, index) => `arg-${index}`),
          command: canonicalWindowsCommand([
            approval.executable,
            ...Array.from({ length: 9 }, (_, index) => `arg-${index}`),
          ]),
        },
      },
    ];
    expect(broker.createChallenge(tooManyArguments)).not.toBeNull();

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
    expect(broker.createChallenge(tooManyDeclarations)).not.toBeNull();

    const oversizedLine = input();
    oversizedLine.requests = [
      {
        approval: {
          ...approval,
          arguments: ["x".repeat(200)],
          command: canonicalWindowsCommand([approval.executable, "x".repeat(200)]),
        },
      },
    ];
    const wrapped = broker.createChallenge(oversizedLine)!;
    expect(wrapped.text.split("\n").every((line) => line.length <= 160)).toBe(true);
    const tooLong = input();
    tooLong.requests = [
      {
        approval: {
          ...approval,
          arguments: ["x".repeat(6000)],
          command: canonicalWindowsCommand([approval.executable, "x".repeat(6000)]),
        },
      },
    ];
    expect(broker.createChallenge(tooLong)).toBeNull();

    const tooManyRequests = input();
    tooManyRequests.requests = Array.from({ length: 9 }, (_, index) => ({
      approval: { ...approval, id: `approval-${index}`, command: `cmd-${index}` },
    }));
    expect(broker.createChallenge(tooManyRequests)).toBeNull();
  });

  it("renders truthful English and Chinese exact-scope decision copy", () => {
    for (const locale of ["en-US", "zh-CN"] as const) {
      const request = { ...input(), locale };
      const prompt = configuredBroker().createChallenge(request)!.text;
      expect(prompt).toMatch(/1[:：]/);
      expect(prompt).toMatch(/3[:：]/);
      expect(prompt).not.toMatch(/^(?:Reply |回复 )?2[:：]/m);
      expect(prompt).not.toContain(approval.executableSha256);
      expect(prompt).toContain(approval.executablePath);
      expect(prompt).toMatch(
        locale === "zh-CN" ? /完整技术详情见桌面/ : /Technical details: Desktop/,
      );
    }
  });

  it("audits only hashes and non-secret metadata after actual Electron resolution", () => {
    const events: unknown[] = [];
    const broker = configuredBroker((event) => events.push(event));
    const delivery = broker.createChallenge(input())!;
    const code = delivery.replyCode;
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
      const result = broker.resolveCandidate(candidate(delivery.replyCode, { cursor: 102 }));
      expect(result).toMatchObject({ consumed: true, status: "rejected" });
      if (reason !== "superseded") {
        expect(result).toMatchObject({ reason: "replayed" });
      }
    }
  });
});
