import { describe, expect, it } from "vitest";
import {
  canonicalExecLiteralFields,
  canonicalWindowsCommand,
  createCanonicalExecPresentation,
  decodeExecLiteralFields,
  encodeExecLiteralField,
  PHONE_EXEC_MAX_FRAME_BYTES,
} from "./windows-node-mxc-exec-presentation";
import { renderCanonicalWeixinExecPrompt } from "./windows-node-mxc-weixin-exec-presentation";
import {
  normalizeWindowsNodeMxcGatewayApproval,
  type WindowsNodeMxcGatewayApproval,
} from "./windows-node-mxc";
import { createPowerShellFilesystemInitialization } from "./windows-node-mxc-powershell-scope";
import {
  normalizeWeixinRemoteApprovalOwner,
  weixinRemoteApprovalAuthorityHash,
  weixinRemoteApprovalConsentHash,
  WEIXIN_NATIVE_DURABLE_CONSENT_SCOPE,
  WindowsNodeMxcWeixinRemoteApprovalBroker,
  type WeixinRemoteApprovalConfiguration,
  type WeixinRemoteApprovalCreateInput,
} from "./windows-node-mxc-weixin-remote-approval";
// @ts-expect-error External ESM Windows quoting fixture.
import { windowsCommand } from "../integration/windows-command-fixture.mjs";

const exe = String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`;
const root = String.raw`C:\Approved`;
const file = `${root}\\public.txt`;
const owner = normalizeWeixinRemoteApprovalOwner(
  "public-bot",
  "public-user@im.wechat",
  "2026-10-23T00:00:00.000Z",
);
const security = {
  gatewayGeneration: "public-generation",
  policyFingerprint: "b".repeat(64),
  nodeId: "public-node",
  activationLeaseHash: "d".repeat(64),
  requestedMode: "limited-dacl" as const,
  effectiveMode: "appcontainer-dacl",
};
const scripts = [
  ["exists", `Test-Path -LiteralPath '${file}'`],
  ["create-directory", `New-Item -ItemType Directory -Path '${root}\\folder' -Force`],
  ["create-file", `New-Item -ItemType File -Path '${file}'`],
  ["remove", `Remove-Item -LiteralPath '${file}' -Force -Recurse`],
  ["clear", `Clear-Content -Path '${file}' -Force`],
  ["set", `Set-Content -Path '${file}' -Value 'Public sample for approval'`],
  ["append", `Add-Content -Path '${file}' -Value 'Another public sample'`],
  [
    "list",
    `Get-ChildItem -Path '${root}' | Select-Object Mode, LastWriteTime, Name | Format-Table -AutoSize`,
  ],
  ["read-content", `Get-Content -LiteralPath '${file}' -Raw`],
  ["copy", `Copy-Item -LiteralPath '${file}' -Destination '${root}\\copy.txt'`],
  ["move", `Move-Item -LiteralPath '${file}' -Destination '${root}\\moved.txt'`],
  ["rename", `Rename-Item -LiteralPath '${file}' -NewName 'renamed.txt'`],
  ["unknown-pipeline", "Acme-Inspect -Option public | Acme-Format -Style plain"],
  ["script", "$public = '样例文字'; Write-Output $public"],
] as const;

function fixture(script: string, nested = false, initialized = false) {
  const argv = [
    exe,
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    nested ? `powershell -NoProfile -Command "${script}"` : script,
  ];
  const access = [{ access: "rw" as const, path: root }];
  const initialization = initialized
    ? createPowerShellFilesystemInitialization(argv, exe, access)
    : null;
  if (initialized && !initialization)
    throw new Error("Reviewed initializer fixture was not prepared");
  const finalArgv = initialization?.finalArgv ?? argv;
  const plan = {
    argv: finalArgv,
    commandText: windowsCommand(finalArgv),
    commandPreview: `# [declare-access]rw:${root}[/declare-access]\n${finalArgv.at(-1)}`,
    cwd: null,
    cwdBinding: "isolated-scratch:v1",
    agentId: "main",
    sessionKey: "agent:main:public",
    executablePath: exe,
    executableSha256: "a".repeat(64),
    declaredAccess: access,
    ...(initialization ? { providerInitialization: initialization } : {}),
  };
  const origin = {
    contract: "microclaw.gateway-approval-origin.v1",
    gatewayGeneration: security.gatewayGeneration,
    agentId: "main",
    runSessionKey: plan.sessionKey,
    executionSessionKey: plan.sessionKey,
    runId: "public-run",
    toolCallId: "public-tool",
    nodeId: security.nodeId,
    channel: "openclaw-weixin",
    accountId: owner.accountId,
    to: owner.userId,
  };
  const envelope = {
    id: "public-approval",
    request: {
      host: "node",
      nodeId: security.nodeId,
      systemRunPlan: plan,
      runId: origin.runId,
      toolCallId: origin.toolCallId,
      remoteApprovalOrigin: origin,
      turnSourceChannel: origin.channel,
      turnSourceAccountId: origin.accountId,
      turnSourceTo: origin.to,
    },
  };
  const approval = normalizeWindowsNodeMxcGatewayApproval(
    envelope,
    security.nodeId,
    security.gatewayGeneration,
    "limited-dacl",
  );
  if (!approval) throw new Error("Canonical public fixture was rejected");
  return { approval, plan, envelope };
}

function render(approval: WindowsNodeMxcGatewayApproval, locale: "en-US" | "zh-CN" = "en-US") {
  return renderCanonicalWeixinExecPrompt({
    approval,
    locale,
    security,
    code: "23456789",
    expiresAtUnixMs: 180000,
  });
}

function commandIn(text: string): string {
  const lines = text.split("\n\n")[1].split("\n").slice(1);
  const escaped = !lines[0].startsWith("  | ");
  return lines
    .slice(escaped ? 1 : 0)
    .map((line) => {
      expect(line.endsWith(" |")).toBe(true);
      const value = line.slice(4, -2);
      return escaped ? JSON.parse(value) : value;
    })
    .join("");
}

function enrolledConfiguration(durable = false): WeixinRemoteApprovalConfiguration {
  return {
    enabled: true,
    owner,
    ...(durable ? { consentScope: WEIXIN_NATIVE_DURABLE_CONSENT_SCOPE } : {}),
  };
}

function input(approval: WindowsNodeMxcGatewayApproval): WeixinRemoteApprovalCreateInput {
  return {
    source: {
      accountId: owner.accountId,
      senderId: owner.userId,
      conversationId: owner.userId,
      messageId: "100",
      cursor: 100,
      agentId: "main",
      sessionKey: approval.sessionKey,
      direct: true,
      forwarded: false,
      quoted: false,
      receivedAtUnixMs: 1000,
      gatewayGeneration: security.gatewayGeneration,
      runIds: ["public-run"],
    },
    requests: [{ approval }],
    security,
    locale: "en-US",
    now: 1000,
    expiresAtUnixMs: 120000,
  };
}

describe("canonical v2 exec presentation independent of command names", () => {
  for (const locale of ["en-US", "zh-CN"] as const) {
    for (const nested of [false, true]) {
      it.each(scripts)(
        "fully represents %s and exact argv in " + locale + (nested ? " nested" : " direct"),
        (_kind, script) => {
          const { approval } = fixture(script, nested);
          const before = JSON.stringify(approval);
          const view = createCanonicalExecPresentation(approval);
          expect(view).not.toBeNull();
          const result = render(approval, locale);
          expect(result.status).toBe("supported");
          if (result.status !== "supported" || !view)
            throw new Error("Public canonical view not rendered");
          expect(commandIn(result.text)).toBe(canonicalWindowsCommand(view.argv));
          expect(result.text.length).toBeLessThanOrEqual(6000);
          expect(result.text.split("\n").every((line) => line.length <= 160)).toBe(true);
          expect(result.text).not.toMatch(/<[^>]*>|\*\*|```/);
          expect(result.text).not.toContain("\r");
          expect(result.text.indexOf(view.executablePath)).toBeLessThan(
            result.text.indexOf(locale === "en-US" ? "Reply 1:" : "回复 1："),
          );
          expect(JSON.stringify(approval)).toBe(before);
        },
      );
      it.each([
        `New-Item -ItemType Directory -Path '${root}\\folder' -Force`,
        `Remove-Item -Path '${file}' -Force -Recurse`,
      ])(
        "fully fits actual validated initializer %s, original and final argv in " +
          locale +
          (nested ? " nested" : " direct"),
        (script) => {
          const { approval, plan } = fixture(script, nested, true);
          const result = render(approval, locale);
          expect(result.status).toBe("supported");
          if (result.status !== "supported")
            throw new Error("Common initialized request exceeded complete display");
          expect(createCanonicalExecPresentation(approval)?.command).toBe(plan.commandText);
          expect(approval.providerInitialization).toBeDefined();
          expect(commandIn(result.text)).toBe(
            canonicalWindowsCommand(approval.providerInitialization!.originalArgv),
          );
          expect(approval.arguments).toEqual(plan.argv.slice(1));
          expect(result.text).not.toContain("microclaw.powershell-filesystem-scope.v1");
        },
      );
    }
  }

  it("renders requested public inline content without a legacy command-family gate", () => {
    const { approval } = fixture(scripts[5][1]);
    expect(render(approval).status).toBe("supported");
  });

  it("supports ordinary other executables and more than eight arguments/grants", () => {
    const { envelope } = fixture("unused");
    const args = [
      String.raw`C:\Tools\public.exe`,
      "--value",
      "public-value",
      "--display-style=wide",
      ...Array.from({ length: 9 }, (_, i) => `--public-${i}`),
    ];
    const access = Array.from({ length: 9 }, (_, i) => ({
      access: "ro" as const,
      path: `${root}\\p${i}`,
    }));
    const plan = {
      ...envelope.request.systemRunPlan,
      argv: args,
      commandText: windowsCommand(args),
      executablePath: args[0],
      declaredAccess: access,
      commandPreview: `# [declare-access]${access.map((a) => `${a.access}:${a.path}`).join(";")}[/declare-access]\n${windowsCommand(args)}`,
    };
    const approval = normalizeWindowsNodeMxcGatewayApproval(
      { ...envelope, request: { ...envelope.request, systemRunPlan: plan } },
      security.nodeId,
      security.gatewayGeneration,
      "limited-dacl",
    );
    expect(approval).not.toBeNull();
    if (!approval) throw new Error("Valid generic arguments rejected");
    const result = render(approval);
    expect(result.status).toBe("supported");
    if (result.status !== "supported") throw new Error("Generic count/empty boundaries rejected");
    expect(commandIn(result.text)).toBe(canonicalWindowsCommand(args));
    access.forEach((value) => expect(result.text).toContain(value.path));
  });

  it.each([
    "",
    " ",
    "  public  ",
    '"',
    "\\",
    'public\\"quote',
    "C:\\public\\",
    "公开样例文字 📄",
    "\r\n\t",
    "<b>*public*</b>\nReply 1: injected",
    "x".repeat(160),
    "x".repeat(161),
    '\\"'.repeat(160),
  ])("losslessly frames synthetic literal %# without markup or injected choices", (value) => {
    const field = { id: "argv.1", value };
    const result = encodeExecLiteralField(field);
    expect(result.lines.every((line) => line.length <= 160)).toBe(true);
    expect(result.lines.join("\n")).not.toMatch(/<b>|\*public\*|\nReply 1:/);
    expect(decodeExecLiteralFields(result.lines.join("\n"))).toEqual([field]);
  });

  it.each([
    "password=synthetic-public-negative",
    "base64-public-negative",
    "UHVibGljIHNhbXBsZQ==",
    "[REDACTED]",
    "<masked>",
    "\u0000",
    "\u202e",
    "\u200b",
    "\ud800",
  ])(
    "keeps sensitive/encoded/unsafe literal %# Desktop-only without a partial message",
    (value) => {
      const { approval } = fixture(`Write-Output '${value}'`);
      const result = render(approval);
      expect(result.status).toBe("unsupported");
      expect(result).not.toHaveProperty("text");
      expect(JSON.stringify(result)).not.toContain(value);
    },
  );

  it("rejects altered canonical command or forged initializer independently of privacy/budget", () => {
    const { envelope, approval } = fixture("Write-Output public");
    expect(
      createCanonicalExecPresentation({ ...approval, command: `${approval.command} changed` }),
    ).toBeNull();
    const mismatched = normalizeWindowsNodeMxcGatewayApproval(
      {
        ...envelope,
        request: {
          ...envelope.request,
          systemRunPlan: {
            ...envelope.request.systemRunPlan,
            commandText: `${approval.command} changed`,
          },
        },
      },
      security.nodeId,
    );
    expect(mismatched).not.toBeNull();
    if (!mismatched) throw new Error("Current normalizer unexpectedly rejected the fixture");
    expect(createCanonicalExecPresentation(mismatched)).toBeNull();
    const initialized = fixture(
      `New-Item -ItemType Directory -Path '${root}\\folder'`,
      false,
      true,
    ).approval;
    expect(initialized.providerInitialization).toBeDefined();
    if (!initialized.providerInitialization) throw new Error("Initializer absent");
    const forged = {
      ...initialized,
      providerInitialization: {
        ...initialized.providerInitialization,
        originalArgv: [exe, "-NoProfile", "-Command", "Write-Output changed"],
      },
    };
    expect(createCanonicalExecPresentation(forged)).toBeNull();
  });

  it("keeps phone privacy/length rejections out of Desktop canonical validity", () => {
    const { approval } = fixture(`Write-Output '${"public ".repeat(1500)}'`);
    expect(createCanonicalExecPresentation(approval)).not.toBeNull();
    expect(render(approval)).toMatchObject({
      status: "unsupported",
      reason: "presentation-too-long",
    });
    const sensitive = fixture("Write-Output 'password=synthetic-public-negative'").approval;
    expect(createCanonicalExecPresentation(sensitive)).not.toBeNull();
    expect(render(sensitive)).toMatchObject({
      status: "unsupported",
      reason: "presentation-sensitive",
    });
  });

  it("bounds the complete internal frame even when an oversized field is not shown on the phone", () => {
    const { approval } = fixture("Write-Output public");
    if (!approval.origin) throw new Error("Origin fixture missing");
    const oversized = {
      ...approval,
      origin: { ...approval.origin, toolCallId: "p".repeat(PHONE_EXEC_MAX_FRAME_BYTES) },
    };
    expect(createCanonicalExecPresentation(oversized)).not.toBeNull();
    expect(render(oversized)).toMatchObject({
      status: "unsupported",
      reason: "presentation-too-long",
    });
  });

  it("rejects malformed CWD and folder-policy identities before presentation", () => {
    const { approval } = fixture("Write-Output public");
    for (const change of [
      { canonicalCwd: "relative-folder" },
      { policyFingerprint: "not-a-policy-hash" },
      { planSha256: "not-a-plan-hash" },
      { folderChanges: [{ access: "ro" as const, path: "relative-folder" }] },
    ]) {
      expect(createCanonicalExecPresentation({ ...approval, ...change })).toBeNull();
    }
  });

  it.each(["en-US", "zh-CN"] as const)(
    "retains complete-prompt overflow and the shared Desktop literal-codec boundaries in %s",
    (locale) => {
      const { approval } = fixture("Write-Output public");
      let low = 0;
      let high = 6000;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        const result = render(
          { ...approval, canonicalCwd: `C:\\Public\\${"p".repeat(middle)}` },
          locale,
        );
        if (result.status === "supported") low = middle;
        else high = middle - 1;
      }
      const boundary = render(
        { ...approval, canonicalCwd: `C:\\Public\\${"p".repeat(low)}` },
        locale,
      );
      if (boundary.status !== "supported") throw new Error("Public budget boundary absent");
      expect(boundary.text.length).toBeLessThanOrEqual(6000);
      expect(
        render({ ...approval, canonicalCwd: `C:\\Public\\${"p".repeat(low + 1)}` }, locale),
      ).toMatchObject({
        status: "unsupported",
        reason: "presentation-too-long",
      });
      const line160 = encodeExecLiteralField({ id: "x", value: "p".repeat(151) }).lines;
      expect(line160[0].length).toBe(160);
      const wrapped161 = encodeExecLiteralField({ id: "x", value: "p".repeat(152) }).lines;
      expect(wrapped161).toHaveLength(2);
      expect(wrapped161.every((line) => line.length <= 160)).toBe(true);
      expect(decodeExecLiteralFields(wrapped161.join("\n"))).toEqual([
        { id: "x", value: "p".repeat(152) },
      ]);
    },
  );

  it.each([[""], ["", "value"], [exe, 7], [exe, null]].map((argv) => ({ argv })))(
    "rejects malformed canonical argv %# without coercion",
    ({ argv }) => {
      const { envelope } = fixture("unused");
      expect(
        normalizeWindowsNodeMxcGatewayApproval(
          {
            ...envelope,
            request: {
              ...envelope.request,
              systemRunPlan: { ...envelope.request.systemRunPlan, argv },
            },
          },
          security.nodeId,
        ),
      ).toBeNull();
    },
  );

  it.each(
    [
      ["", 'quote"tail', "C:\\public\\"],
      [exe, "space value", 'ends\\\\"', ""],
    ].map((argv) => ({ argv })),
  )("matches the existing production quoting fixture %#", ({ argv }) => {
    expect(canonicalWindowsCommand(argv)).toBe(windowsCommand(argv));
  });
});

describe("enrolled owner through actual normalizer and v2 broker", () => {
  it("does not advertise or accept durable choice 2 when canonical/native flags exclude allow-always", async () => {
    const broker = new WindowsNodeMxcWeixinRemoteApprovalBroker(undefined, () => ({
      accountId: owner.accountId,
      userId: owner.userId,
    }));
    broker.configure(enrolledConfiguration(true));
    const request = input({
      ...fixture(scripts[5][1]).approval,
      allowedDecisions: ["allow-once", "deny"],
    });
    const delivery = broker.createChallenge(request);
    if (!delivery) throw new Error("Canonical once/deny challenge missing");
    expect(delivery.text).not.toContain("2: remember");
    broker.markDelivered(delivery.challengeId, 1001);
    const candidate = {
      ...request.source,
      text: `2 ${delivery.replyCode}`,
      messageId: "101",
      cursor: 101,
      now: 1002,
      requests: request.requests,
      security,
    };
    expect(broker.resolveCandidate(candidate).status).not.toBe("approved");
    expect(
      broker.resolveCandidate({
        ...candidate,
        text: "1",
        messageId: "102",
        cursor: 102,
        now: 1003,
        expectedSimpleChallengeId: delivery.challengeId,
      }),
    ).toMatchObject({ status: "approved", decision: "allow-once" });
  });

  it.each([
    "argv",
    "exe-hash",
    "cwd",
    "grant",
    "agent",
    "session",
    "origin",
    "generation",
    "policy",
    "lease",
  ] as const)(
    "binds exact v2 canonical facts and stable security against candidate change %s",
    async (change) => {
      const broker = new WindowsNodeMxcWeixinRemoteApprovalBroker(undefined, () => ({
        accountId: owner.accountId,
        userId: owner.userId,
      }));
      broker.configure(enrolledConfiguration());
      const request = input(fixture(scripts[5][1]).approval);
      const delivery = broker.createChallenge(request);
      if (!delivery) throw new Error("Canonical public challenge missing");
      broker.markDelivered(delivery.challengeId, 1001);
      const candidate = {
        ...request.source,
        text: "1",
        messageId: "101",
        cursor: 101,
        now: 1002,
        expectedSimpleChallengeId: delivery.challengeId,
        requests: structuredClone(request.requests),
        security: { ...security },
      };
      const approval = candidate.requests[0].approval;
      if (change === "argv") {
        approval.arguments.push("public");
        approval.command = canonicalWindowsCommand([approval.executable, ...approval.arguments]);
      }
      if (change === "exe-hash") approval.executableSha256 = "e".repeat(64);
      if (change === "cwd") approval.canonicalCwd = "C:\\Other";
      if (change === "grant") approval.declaredAccess.push({ access: "rw", path: "C:\\Other" });
      if (change === "agent") approval.agent = "other";
      if (change === "session") approval.sessionKey = "agent:main:other";
      if (change === "origin" && approval.origin) approval.origin.runId = "different-public-run";
      if (change === "generation") candidate.security.gatewayGeneration = "new-generation";
      if (change === "policy") candidate.security.policyFingerprint = "e".repeat(64);
      if (change === "lease") candidate.security.activationLeaseHash = "e".repeat(64);
      expect(broker.resolveCandidate(candidate)).toMatchObject({
        status: "rejected",
        reason: "stale",
      });
    },
  );

  it("shows actual normalized decisions and absent/original deadlines without extending effective expiry", async () => {
    const broker = new WindowsNodeMxcWeixinRemoteApprovalBroker(undefined, () => ({
      accountId: owner.accountId,
      userId: owner.userId,
    }));
    broker.configure(enrolledConfiguration());
    const { approval } = fixture(scripts[5][1]);
    expect(canonicalExecLiteralFields(createCanonicalExecPresentation(approval)!)).toContainEqual({
      id: "request.deadline.absent",
      value: "true",
    });
    const request = input({ ...approval, expiresAtUnixMs: 50000 });
    request.expiresAtUnixMs = 100000;
    const delivery = broker.createChallenge(request);
    expect(delivery?.expiresAtUnixMs).toBe(50000);
    if (!delivery) throw new Error("Original-clamped deadline rejected");
    expect(delivery.text).toContain("1970-01-01 00:00:50.000 UTC (UTC+00:00)");
    expect(delivery.text).toContain("Reply 1: allow once");
    expect(delivery.text).toContain("3: deny");
    broker.markDelivered(delivery.challengeId, 1001);
    expect(
      broker.resolveCandidate({
        ...request.source,
        text: "1",
        messageId: "101",
        cursor: 101,
        now: 1002,
        security,
        expectedSimpleChallengeId: delivery.challengeId,
        requests: [{ approval: { ...request.requests[0].approval, expiresAtUnixMs: 50001 } }],
      }),
    ).toMatchObject({ status: "rejected", reason: "stale" });
    expect(
      renderCanonicalWeixinExecPrompt({
        approval: request.requests[0].approval,
        security,
        code: "23456789",
        expiresAtUnixMs: 50001,
        locale: "en-US",
      }),
    ).toMatchObject({ status: "unsupported", reason: "security-binding-invalid" });
    expect(broker.createChallengeResult({ ...request, now: 50000 })).toMatchObject({
      status: "rejected",
    });
  });

  it.each([false, true])(
    "never offers a durable phone decision, including mutable=%s",
    async (mutable) => {
      const broker = new WindowsNodeMxcWeixinRemoteApprovalBroker(undefined, () => ({
        accountId: owner.accountId,
        userId: owner.userId,
      }));
      broker.configure(enrolledConfiguration(true));
      const request = input({ ...fixture(scripts[5][1]).approval, hasMutableFileOperand: mutable });
      const delivery = broker.createChallenge(request);
      if (!delivery) throw new Error("Public request missing");
      expect(delivery.text).not.toContain("2: remember");
      broker.markDelivered(delivery.challengeId, 1001);
      const result = broker.resolveCandidate({
        ...request.source,
        text: "2",
        messageId: "101",
        cursor: 101,
        now: 1002,
        expectedSimpleChallengeId: delivery.challengeId,
        requests: request.requests,
        security: { ...security },
      });
      expect(result.status).toBe("rejected");
    },
  );

  it("automatically admits ordinary content and unknown command families for the enrolled owner", () => {
    const broker = new WindowsNodeMxcWeixinRemoteApprovalBroker(undefined, () => ({
      accountId: owner.accountId,
      userId: owner.userId,
    }));
    const configuration = enrolledConfiguration();
    broker.configure(configuration);
    const request = input(fixture(scripts[5][1]).approval);
    expect(configuration.consentScope).toBeUndefined();
    expect(weixinRemoteApprovalConsentHash(configuration)).toBeNull();
    const result = broker.createChallengeResult(request);
    expect(result.status).toBe("created");
    if (result.status !== "created") throw new Error("Enrolled owner's canonical request rejected");
    expect(result.delivery.text).toContain("Command (exact;");
    expect(result.delivery.text).not.toMatch(/legacy|Full details v2/);
    expect(result.delivery.text).not.toContain("2: remember");
    expect(broker.markDelivered(result.delivery.challengeId, 1001)).toBe(true);
    const resolution = broker.resolveCandidate({
      ...request.source,
      text: "1",
      messageId: "101",
      cursor: 101,
      now: 1002,
      requests: request.requests,
      security,
      expectedSimpleChallengeId: result.delivery.challengeId,
    });
    expect(resolution).toMatchObject({
      consumed: true,
      status: "approved",
      decision: "allow-once",
    });
    expect(
      broker.resolveCandidate({
        ...request.source,
        text: "1",
        messageId: "102",
        cursor: 102,
        now: 1003,
        requests: request.requests,
        security,
      }).status,
    ).not.toBe("approved");
    const unknown = { ...request, requests: [{ approval: fixture(scripts[12][1]).approval }] };
    expect(broker.createChallengeResult(unknown).status).toBe("created");
  });

  it.each(["disabled", "owner", "binding", "scope"] as const)(
    "invalidates a delivered challenge when enrolled authority changes: %s",
    (change) => {
      const configuration = enrolledConfiguration();
      const broker = new WindowsNodeMxcWeixinRemoteApprovalBroker(undefined, () => ({
        accountId: owner.accountId,
        userId: owner.userId,
      }));
      broker.configure(configuration);
      const request = input(fixture(scripts[5][1]).approval);
      const delivery = broker.createChallenge(request);
      expect(delivery).not.toBeNull();
      if (!delivery) throw new Error("Canonical challenge missing");
      expect(delivery.text).not.toContain("2: remember");
      broker.markDelivered(delivery.challengeId, 1001);
      const changed: WeixinRemoteApprovalConfiguration =
        change === "disabled"
          ? { ...configuration, enabled: false }
          : change === "owner"
            ? { ...configuration, owner: { ...owner, userId: "other@im.wechat" } }
            : change === "binding"
              ? { ...configuration, owner: { ...owner, boundAt: "2026-10-24T00:00:00.000Z" } }
              : { ...configuration, consentScope: WEIXIN_NATIVE_DURABLE_CONSENT_SCOPE };
      expect(weixinRemoteApprovalAuthorityHash(changed)).not.toBe(
        weixinRemoteApprovalAuthorityHash(configuration),
      );
      broker.configure(changed);
      expect(
        broker.resolveCandidate({
          ...request.source,
          text: "1",
          messageId: "101",
          cursor: 101,
          requests: request.requests,
          security,
          now: 1002,
        }).status,
      ).not.toBe("approved");
      broker.configure(configuration);
      expect(
        broker.resolveCandidate({
          ...request.source,
          text: "1",
          messageId: "102",
          cursor: 102,
          requests: request.requests,
          security,
          now: 1003,
        }).status,
      ).not.toBe("approved");
    },
  );

  it.each(["origin", "run", "generation", "request"] as const)(
    "retains %s authority fencing for v2",
    async (mutation) => {
      const broker = new WindowsNodeMxcWeixinRemoteApprovalBroker(undefined, () => ({
        accountId: owner.accountId,
        userId: owner.userId,
      }));
      broker.configure(enrolledConfiguration());
      const request = input(fixture(scripts[5][1]).approval);
      if (mutation === "origin")
        request.requests[0].approval = { ...request.requests[0].approval, origin: undefined };
      if (mutation === "run") request.source.runIds = ["wrong-run"];
      if (mutation === "generation")
        request.security = { ...security, gatewayGeneration: "wrong-generation" };
      if (mutation === "request") request.requests.push(request.requests[0]);
      expect(broker.createChallengeResult(request).status).toBe("rejected");
    },
  );
});
