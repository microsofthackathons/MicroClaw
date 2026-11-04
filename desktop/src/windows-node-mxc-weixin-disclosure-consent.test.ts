import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import {
  createWeixinDisclosureDialog,
  planNativeWeixinDisclosure,
  validateWeixinFullDetailDisclosure,
} from "./windows-node-mxc-weixin-disclosure-consent";
import {
  migrateWeixinRemoteApprovalConfiguration,
  normalizeWeixinRemoteApprovalOwner,
  weixinFullDetailDisclosureHash,
  weixinRemoteApprovalConsentHash,
  WEIXIN_NATIVE_DURABLE_CONSENT_SCOPE,
  WindowsNodeMxcWeixinRemoteApprovalBroker,
  type WeixinRemoteApprovalConfiguration,
} from "./windows-node-mxc-weixin-remote-approval";
import {
  projectWindowsNodeMxcApprovalForRenderer,
  type WindowsNodeMxcGatewayApproval,
} from "./windows-node-mxc";
import {
  WeixinRemoteDeliveryCoordinator,
  deliverWeixinRemoteApproval,
  remoteApprovalDiagnosticBinding,
} from "./windows-node-mxc-weixin-remote-approval-delivery";
import { describeWeixinSessionBinding } from "./weixin-session-routing";
import { describeWeixinApprovalDecision } from "./mxc-approval-context-diagnostics";
import { isTrustedRendererUrl } from "./trusted-renderer-url";
// @ts-expect-error External ESM actual Main-function fixture.
import { createMainFunctionFixture } from "../integration/main-weixin-inbound-fixture.mjs";

const owner = normalizeWeixinRemoteApprovalOwner(
  "public-bot",
  "public-user@im.wechat",
  "2026-10-23T00:00:00.000Z",
);
function eligible() {
  return {
    weixinEnabled: true,
    linkedAccountCount: 1,
    authenticatedAccountCount: 1,
    invariantState: "single" as const,
    account: { accountId: owner.accountId, userId: owner.userId },
    enableAvailable: true,
    unavailableReason: null,
  };
}
function harness(response = 1, durable = false) {
  let configuration: WeixinRemoteApprovalConfiguration = {
    enabled: true,
    owner: { ...owner },
    ...(durable ? { consentScope: WEIXIN_NATIVE_DURABLE_CONSENT_SCOPE } : {}),
  };
  const options = eligible();
  const showDialog = vi.fn().mockResolvedValue({ response });
  const readConfiguration = () => configuration;
  const broker = new WindowsNodeMxcWeixinRemoteApprovalBroker(undefined, () => options.account);
  broker.configure(configuration);
  const approval: WindowsNodeMxcGatewayApproval = {
    id: "public-pending",
    command: "public.exe --public",
    executable: "public.exe",
    arguments: ["--public"],
    executablePath: "C:\\Tools\\public.exe",
    executableSha256: "a".repeat(64),
    canonicalCwd: "isolated-scratch:v1",
    agent: "main",
    sessionKey: "agent:main:public",
    declaredAccess: [],
    hasMutableFileOperand: false,
    allowedDecisions: ["allow-once", "deny", "allow-always"],
    expiresAtUnixMs: 200000,
  };
  const pending = () => ({
    request: { ...approval },
    gatewayGeneration: "generation",
    expiresAtUnixMs: 180000,
    lifecycle: { pending: true, decide: vi.fn() },
    remoteChallengeId: "old-challenge" as string | null,
    remoteDisclosureHash: null as string | null,
    remoteDelivery: {
      state: "sending" as const,
      reason: null,
      replyMode: "simple-current-prompt" as const,
      revision: 4,
    },
    remoteDeliveryCoordinator: new WeixinRemoteDeliveryCoordinator(),
  });
  const first = pending();
  const queued = pending();
  const frame = { url: "http://127.0.0.1:59999/" };
  const webContents = { mainFrame: frame };
  const mainWindow = { isDestroyed: () => false, webContents };
  const trusted = createMainFunctionFixture("assertTrustedRendererIpc", {
    mainWindow,
    isTrustedRendererUrl,
    isDev: true,
    VITE_DEV_URL: "http://127.0.0.1:59999",
    PACKAGED_RENDERER_INDEX_PATH: "",
  });
  const store = {
    get: vi.fn(() => "en-US"),
    set: vi.fn((key: string, value: unknown) => {
      expect(key).toBe("windowsNodeMxcWeixinRemoteApproval");
      configuration = migrateWeixinRemoteApprovalConfiguration(value);
    }),
  };
  const send = vi.fn();
  const resolutionActivity = { pending: 0 };
  const publish = createMainFunctionFixture("publishPendingWeixinRemoteDelivery", {
    sendToWindow: send,
    mainWindow,
    projectWindowsNodeMxcApprovalForRenderer,
    getWindowsNodeMxcRequestedMode: () => "limited-dacl",
  });
  const main = createMainFunctionFixture("requestWindowsNodeMxcWeixinDisclosure", {
    assertTrustedRendererIpc: trusted.handle,
    windowsNodeMxcNativeDisclosurePending: false,
    windowsNodeMxcApprovalResolutionActivity: resolutionActivity,
    windowsNodeMxcSecurityTransitionInProgress: false,
    gatewayGenerationId: "generation",
    getStoredWindowsNodeMxcWeixinRemoteApprovalConfiguration: readConfiguration,
    getWindowsNodeMxcWeixinRemoteApprovalConfiguration: () => {
      broker.configure(readConfiguration());
      return readConfiguration();
    },
    planNativeWeixinDisclosure,
    getWeixinRemoteApprovalActivationOptions: () => options,
    isWindowsNodeMxcDesired: () => true,
    readConfig: () => ({}),
    resolveSupportedLocale: () => "en-US",
    settingsStore: store,
    dialog: { showMessageBox: (_window: unknown, dialog: unknown) => showDialog(dialog) },
    mainWindow,
    windowsNodeMxcWeixinRemoteApprovalBroker: broker,
    allPendingWindowsNodeMxcGatewayApprovals: () => [first, queued],
    publishPendingWeixinRemoteDelivery: publish.handle,
    getWindowsNodeMxcWeixinDisclosureStatus: () => ({
      consented: weixinFullDetailDisclosureHash(configuration) !== null,
      available: true,
    }),
  });
  return {
    main,
    broker,
    store,
    readConfiguration,
    options,
    showDialog,
    first,
    queued,
    send,
    resolutionActivity,
    event: { sender: webContents, senderFrame: frame },
    replaceConfiguration: (value: WeixinRemoteApprovalConfiguration) => {
      configuration = value;
    },
  };
}

describe("dedicated native full-detail disclosure consent", () => {
  it.each(["en-US", "zh-CN"] as const)(
    "has a separately localized default-safe warning in %s",
    (locale) => {
      const dialog = createWeixinDisclosureDialog(locale);
      expect(dialog).toMatchObject({ type: "warning", defaultId: 0, cancelId: 2, noLink: true });
      expect(dialog.buttons).toHaveLength(3);
      expect(JSON.stringify(dialog)).not.toContain("weixinDisclosure.");
      expect(dialog.detail).toMatch(
        locale === "en-US" ? /filters cannot prove/ : /无法证明任意文本/,
      );
      expect(dialog.detail).toMatch(
        locale === "en-US" ? /every argument and inline file contents/ : /每个参数和内联文件内容/,
      );
      expect(dialog.detail).toMatch(locale === "en-US" ? /does not grant durable/ : /不会授予永久/);
      expect(dialog.detail).toMatch(locale === "en-US" ? /cannot retract/ : /无法撤回/);
    },
  );

  it.each([0, 2])(
    "actual Main/native response %s never persists or changes pending state",
    async (response) => {
      const h = harness(response);
      const before = JSON.stringify(h.first);
      expect(await h.main.handle(h.event, { intent: "enable-full-details" })).toMatchObject({
        consented: false,
      });
      expect(h.store.set).not.toHaveBeenCalled();
      expect(JSON.stringify(h.first)).toBe(before);
      expect(h.send).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    "actual Main persists only a native owner-bound receipt, durable already=%s",
    async (durable) => {
      const h = harness(1, durable);
      const before = h.readConfiguration();
      const originalDeadline = h.first.expiresAtUnixMs;
      expect(await h.main.handle(h.event, { intent: "enable-full-details" })).toMatchObject({
        consented: true,
      });
      const result = h.readConfiguration();
      expect(h.store.set).toHaveBeenCalledOnce();
      expect(validateWeixinFullDetailDisclosure(result.fullDetailDisclosure, owner)).toEqual(
        result.fullDetailDisclosure,
      );
      expect(result.owner).toEqual(owner);
      expect(result.consentScope).toBe(before.consentScope);
      expect(weixinRemoteApprovalConsentHash(result) !== null).toBe(durable);
      for (const pending of [h.first, h.queued]) {
        expect(pending.lifecycle.pending).toBe(true);
        expect(pending.lifecycle.decide).not.toHaveBeenCalled();
        expect(pending.expiresAtUnixMs).toBe(originalDeadline);
        expect(pending.remoteChallengeId).toBeNull();
        expect(pending.remoteDelivery).toMatchObject({
          state: "local-only",
          reason: "security-binding-invalid",
          revision: 5,
        });
        const resend = vi.fn(async () => null);
        for (const trigger of ["source-bound", "promoted", "initial"] as const) {
          await pending.remoteDeliveryCoordinator.begin(
            trigger,
            () => ({
              pending: true,
              challengeId: pending.remoteChallengeId,
              state: pending.remoteDelivery,
            }),
            resend,
          );
        }
        expect(resend).not.toHaveBeenCalled();
      }
      expect(h.send).toHaveBeenCalledTimes(2);
      expect(h.send.mock.calls.every((call) => call[2].expiresAtUnixMs === originalDeadline)).toBe(
        true,
      );
      expect(h.broker.getConfiguration()).toEqual(result);
    },
  );

  it("revokes disclosure without a second dialog or changing owner/durable consent", async () => {
    const h = harness(1, true);
    await h.main.handle(h.event, { intent: "enable-full-details" });
    const original = h.readConfiguration();
    const hash = weixinRemoteApprovalConsentHash(original);
    expect(await h.main.handle(h.event, { intent: "revoke" })).toMatchObject({
      consented: false,
    });
    expect(h.readConfiguration()).toEqual({
      enabled: true,
      owner,
      consentScope: WEIXIN_NATIVE_DURABLE_CONSENT_SCOPE,
    });
    expect(h.showDialog).toHaveBeenCalledOnce();
    expect(weixinRemoteApprovalConsentHash(h.readConfiguration())).toBe(hash);
  });

  it("reports and revokes a saved disclosure while MXC is off without disabling enrollment", async () => {
    const h = harness(1, true);
    await h.main.handle(h.event, { intent: "enable-full-details" });
    h.main.replace("isWindowsNodeMxcDesired", () => false);
    h.main.replace("getWindowsNodeMxcWeixinRemoteApprovalConfiguration", () => {
      const runtime = { ...h.readConfiguration(), enabled: false };
      h.broker.configure(runtime);
      return runtime;
    });
    const status = createMainFunctionFixture("getWindowsNodeMxcWeixinDisclosureStatus", {
      getStoredWindowsNodeMxcWeixinRemoteApprovalConfiguration: h.readConfiguration,
      getWindowsNodeMxcWeixinRemoteApprovalConfiguration: () => ({
        ...h.readConfiguration(),
        enabled: false,
      }),
      validateWeixinFullDetailDisclosure,
      isWindowsNodeMxcDesired: () => false,
      isAuthenticatedWeixinRemoteApprovalOwner: () => true,
    });
    expect(status.handle()).toEqual({ consented: true, available: false });
    await h.main.handle(h.event, { intent: "revoke" });
    expect(h.readConfiguration()).toEqual({
      enabled: true,
      owner,
      consentScope: WEIXIN_NATIVE_DURABLE_CONSENT_SCOPE,
    });
    expect(h.broker.getConfiguration()).toMatchObject({ enabled: false });
    expect(status.handle()).toEqual({ consented: false, available: false });
  });

  it.each(["sender", "frame", "url"] as const)(
    "executes actual trusted-renderer %s rejection before any dialog/store",
    async (kind) => {
      const h = harness();
      const event = { ...h.event };
      if (kind === "sender") event.sender = { ...h.event.sender };
      if (kind === "frame") event.senderFrame = { ...h.event.senderFrame };
      if (kind === "url") h.event.senderFrame.url = "https://untrusted.invalid/";
      await expect(h.main.handle(event, { intent: "enable-full-details" })).rejects.toThrow(
        "trusted MicroClaw renderer",
      );
      expect(h.showDialog).not.toHaveBeenCalled();
      expect(h.store.set).not.toHaveBeenCalled();
    },
  );

  it.each([
    { intent: "use-legacy" },
    null,
    true,
    {},
    { intent: "enable-full-details", enabled: true },
    { intent: "enable-full-details", fullDetailDisclosure: {} },
    { intent: "enable-full-details", owner },
    { intent: "enable-full-details", receiptId: "forged" },
    { intent: "enable-full-details", consentScope: WEIXIN_NATIVE_DURABLE_CONSENT_SCOPE },
  ])("rejects renderer authority fields %# before native confirmation", async (request) => {
    const h = harness();
    await expect(h.main.handle(h.event, request)).rejects.toThrow(
      "Only a native WeChat disclosure intent",
    );
    expect(h.store.set).not.toHaveBeenCalled();
    expect(h.showDialog).not.toHaveBeenCalled();
  });

  it.each(["owner", "binding", "authentication", "mode", "generation", "policy"] as const)(
    "actual Main revalidates %s after native confirmation",
    async (change) => {
      const h = harness();
      h.showDialog.mockImplementation(async () => {
        if (change === "owner") h.options.account.userId = "different-public-user@im.wechat";
        if (change === "binding")
          h.replaceConfiguration({
            ...h.readConfiguration(),
            owner: { ...owner, boundAt: "2026-10-23T01:00:00.000Z" },
          });
        if (change === "authentication") h.options.enableAvailable = false;
        if (change === "mode") h.main.replace("isWindowsNodeMxcDesired", () => false);
        if (change === "generation") h.main.replace("gatewayGenerationId", "new-generation");
        if (change === "policy")
          h.replaceConfiguration({
            ...h.readConfiguration(),
            consentScope: WEIXIN_NATIVE_DURABLE_CONSENT_SCOPE,
          });
        return { response: 1 };
      });
      await expect(h.main.handle(h.event, { intent: "enable-full-details" })).rejects.toThrow(
        /changed|unavailable/,
      );
      expect(h.store.set).not.toHaveBeenCalled();
      expect(h.send).not.toHaveBeenCalled();
    },
  );

  it("serializes native disclosure and releases the gate after an error", async () => {
    const h = harness();
    let finish!: (value: { response: number }) => void;
    h.showDialog.mockImplementationOnce(
      () =>
        new Promise<{ response: number }>((resolve) => {
          finish = resolve;
        }),
    );
    const first = h.main.handle(h.event, { intent: "enable-full-details" });
    await expect(h.main.handle(h.event, { intent: "enable-full-details" })).rejects.toThrow("busy");
    finish({ response: -1 });
    await expect(first).rejects.toThrow("Invalid native");
    expect(h.store.set).not.toHaveBeenCalled();
    h.showDialog.mockResolvedValue({ response: 1 });
    expect(await h.main.handle(h.event, { intent: "enable-full-details" })).toMatchObject({
      consented: true,
    });
  });

  it.each(["before-dialog", "after-dialog"] as const)(
    "does not apply a disclosure change across an already committing approval %s",
    async (when) => {
      const h = harness();
      if (when === "before-dialog") h.resolutionActivity.pending = 1;
      else
        h.showDialog.mockImplementation(async () => {
          h.resolutionActivity.pending = 1;
          return { response: 1 };
        });
      await expect(h.main.handle(h.event, { intent: "enable-full-details" })).rejects.toThrow(
        when === "before-dialog" ? "busy" : "authority changed",
      );
      expect(h.store.set).not.toHaveBeenCalled();
      expect(h.first.lifecycle.pending).toBe(true);
      expect(h.send).not.toHaveBeenCalled();
    },
  );

  it("actual Main serialization fences active and queued decisions until every completion or failure settles", async () => {
    const h = harness();
    const resolutions = createMainFunctionFixture("withWindowsNodeMxcApprovalResolution", {
      windowsNodeMxcApprovalResolutionActivity: h.resolutionActivity,
      windowsNodeMxcApprovalResolutionInProgress: false,
      windowsNodeMxcApprovalResolutionCompletion: null,
      windowsNodeMxcFailClosedPromise: null,
      windowsNodeMxcSecurityTransitionInProgress: false,
    });
    let release!: () => void;
    const first = resolutions.handle(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    expect(h.resolutionActivity.pending).toBe(1);
    const second = resolutions.handle(async () => {
      expect(h.resolutionActivity.pending).toBeGreaterThan(0);
      await expect(h.main.handle(h.event, { intent: "revoke" })).rejects.toThrow("busy");
      expect(h.store.set).not.toHaveBeenCalled();
      return "second";
    });
    expect(h.resolutionActivity.pending).toBe(2);
    await expect(h.main.handle(h.event, { intent: "enable-full-details" })).rejects.toThrow("busy");
    expect(h.showDialog).not.toHaveBeenCalled();
    release();
    await first;
    await expect(second).resolves.toBe("second");
    expect(h.resolutionActivity.pending).toBe(0);
    await expect(
      resolutions.handle(async () => {
        throw new Error("synthetic preflight error");
      }),
    ).rejects.toThrow("synthetic preflight error");
    expect(h.resolutionActivity.pending).toBe(0);
    resolutions.replace("windowsNodeMxcSecurityTransitionInProgress", true);
    await expect(resolutions.handle(async () => undefined)).rejects.toThrow("lifecycle transition");
    expect(h.resolutionActivity.pending).toBe(0);
    expect(h.first.lifecycle.pending).toBe(true);
    expect(h.store.set).not.toHaveBeenCalled();
  });

  it("actual Main delivery ignores a late provider acknowledgement after native revocation, keeping Desktop deadline and no resend", async () => {
    const h = harness();
    await h.main.handle(h.event, { intent: "enable-full-details" });
    const security = {
      gatewayGeneration: "generation",
      policyFingerprint: "b".repeat(64),
      nodeId: "public-node",
      activationLeaseHash: "d".repeat(64),
      requestedMode: "limited-dacl" as const,
      effectiveMode: "appcontainer-dacl",
    };
    const request = {
      ...h.first.request,
      id: "public-new-after-consent",
      origin: {
        contract: "microclaw.gateway-approval-origin.v1" as const,
        gatewayGeneration: "generation",
        agentId: "main",
        runSessionKey: "agent:main:public",
        executionSessionKey: "agent:main:public",
        runId: "public-run",
        toolCallId: "public-tool",
        nodeId: "public-node",
        channel: "openclaw-weixin",
        accountId: owner.accountId,
        to: owner.userId,
      },
      expiresAtUnixMs: Date.now() + 60000,
    };
    const pending = {
      ...h.first,
      request,
      expiresAtUnixMs: Date.now() + 45000,
      remoteDelivery: null,
      remoteChallengeId: null,
      remoteCoordinator: new WeixinRemoteDeliveryCoordinator(),
      remoteAttempt: Promise.resolve(null),
      remoteSecurity: security,
      remoteSource: {
        accountId: owner.accountId,
        senderId: owner.userId,
        conversationId: owner.userId,
        agentId: "main",
        sessionKey: "agent:main:public",
        messageId: "100",
        cursor: 100,
        receivedAtUnixMs: Date.now(),
        gatewayGeneration: "generation",
        runIds: ["public-run"],
        direct: true,
        forwarded: false,
        quoted: false,
      },
    };
    h.main.replace("allPendingWindowsNodeMxcGatewayApprovals", () => [pending]);
    const publish = createMainFunctionFixture("publishPendingWeixinRemoteDelivery", {
      sendToWindow: h.send,
      mainWindow: {},
      projectWindowsNodeMxcApprovalForRenderer,
      getWindowsNodeMxcRequestedMode: () => "limited-dacl",
    });
    let finish!: () => void;
    const deliver = vi.fn(
      (params) =>
        new Promise<void>((resolve) => {
          finish = () => {
            params.onDelivered?.();
            resolve();
          };
        }),
    );
    const server = { isRegistered: () => true, deliver };
    const main = createMainFunctionFixture("beginPendingWindowsNodeMxcRemoteDelivery", {
      getWindowsNodeMxcWeixinRemoteApprovalConfiguration: h.readConfiguration,
      weixinFullDetailDisclosureHash,
      pendingWindowsNodeMxcGatewayApproval: pending,
      findPendingWindowsNodeMxcGatewayApproval: () => pending,
      currentWindowsNodeMxcWeixinRemoteApprovalSecurity: () => security,
      deliverWeixinRemoteApproval,
      windowsNodeMxcWeixinRemoteApprovalBroker: h.broker,
      readAuthenticatedWeixinWireOwner: () => ({
        accountId: owner.accountId,
        userId: owner.userId,
      }),
      getOpenClawStateDir: () => "synthetic-no-filesystem-access",
      publishPendingWeixinRemoteDelivery: publish.handle,
      remoteApprovalDiagnosticBinding,
      describeWeixinSessionBinding,
      describeWeixinApprovalDecision,
      windowsNodeMxcWeixinRemoteApprovalSources: new Map(),
      console: { info: vi.fn(), error: vi.fn() },
    });
    main.handle(pending, "en-US", server);
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
    const original = pending.expiresAtUnixMs;
    await h.main.handle(h.event, { intent: "revoke" });
    const revoked = JSON.stringify(pending.remoteDelivery);
    expect(pending.remoteDelivery).toMatchObject({
      state: "local-only",
      reason: "security-binding-invalid",
    });
    const delivered = vi.spyOn(h.broker, "markDelivered");
    finish();
    await pending.remoteAttempt;
    expect(delivered).not.toHaveBeenCalled();
    expect(JSON.stringify(pending.remoteDelivery)).toBe(revoked);
    expect(pending.remoteChallengeId).toBeNull();
    expect(pending.expiresAtUnixMs).toBe(original);
    expect(pending.lifecycle.pending).toBe(true);
    for (const trigger of ["source-bound", "promoted"] as const) {
      main.handle(pending, "en-US", server, false, trigger);
      await pending.remoteAttempt;
    }
    expect(deliver).toHaveBeenCalledOnce();
  });

  it("executes the actual preload bridge as intent-only IPC, never renderer-supplied receipt authority", async () => {
    const filename = join(__dirname, "preload.ts");
    const ast = ts.createSourceFile(
      filename,
      readFileSync(filename, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    let initializer: ts.ObjectLiteralExpression | undefined;
    const visit = (node: ts.Node) => {
      if (
        ts.isPropertyAssignment(node) &&
        node.name.getText(ast) === "windowsNodeMxc" &&
        ts.isObjectLiteralExpression(node.initializer)
      )
        initializer = node.initializer;
      ts.forEachChild(node, visit);
    };
    visit(ast);
    if (!initializer) throw new Error("Actual preload Windows Node bridge missing");
    const output = ts.transpileModule(`const bridge = ${initializer.getText(ast)};`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const invoke = vi.fn().mockResolvedValue({ consented: false, available: true });
    const bridge = new Function("ipcRenderer", `${output}; return bridge;`)({ invoke });
    await bridge.getDisclosureStatus();
    await bridge.requestDisclosure("enable-full-details");
    await bridge.requestDisclosure("revoke");
    expect(invoke.mock.calls).toEqual([
      ["windows-node-mxc:weixin-disclosure-status"],
      ["windows-node-mxc:weixin-disclosure-request", { intent: "enable-full-details" }],
      ["windows-node-mxc:weixin-disclosure-request", { intent: "revoke" }],
    ]);
  });

  it("does not silently migrate an existing owner or an invalid/rebound receipt", async () => {
    const h = harness();
    const legacy = h.readConfiguration();
    expect(migrateWeixinRemoteApprovalConfiguration(legacy)).toEqual(legacy);
    await h.main.handle(h.event, { intent: "enable-full-details" });
    const current = h.readConfiguration();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      for (const candidate of [
        { ...current, owner: { ...owner, boundAt: "2026-10-23T01:00:00.000Z" } },
        {
          ...current,
          fullDetailDisclosure: { ...current.fullDetailDisclosure, receiptId: "forged" },
        },
        { ...current, fullDetailDisclosure: { ...current.fullDetailDisclosure, extra: true } },
      ]) {
        expect(
          migrateWeixinRemoteApprovalConfiguration(candidate).fullDetailDisclosure,
        ).toBeUndefined();
      }
      expect(warn).toHaveBeenCalledTimes(3);
      expect(warn.mock.calls.flat().join(" ")).not.toContain(owner.userId);
    } finally {
      warn.mockRestore();
    }
  });

  it("keeps full-detail/remote authority outside the actual generic Settings key allowlist", () => {
    const filename = join(__dirname, "main.ts");
    const ast = ts.createSourceFile(
      filename,
      readFileSync(filename, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    const statement = ast.statements.find(
      (node) =>
        ts.isVariableStatement(node) &&
        node.declarationList.declarations.some(
          (d) => d.name.getText(ast) === "RENDERER_WRITABLE_SETTING_KEYS",
        ),
    );
    if (!statement) throw new Error("Actual Settings allowlist missing");
    const source = ts.transpileModule(statement.getText(ast), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const allowed = new Function(
      `${source}; return RENDERER_WRITABLE_SETTING_KEYS;`,
    )() as Set<string>;
    for (const key of [
      "windowsNodeMxcWeixinRemoteApproval",
      "fullDetailDisclosure",
      "receiptId",
      "consentScope",
    ])
      expect(allowed.has(key)).toBe(false);
    expect(readFileSync(filename, "utf8")).toContain(
      "if (!RENDERER_WRITABLE_SETTING_KEYS.has(key))",
    );
  });
});
