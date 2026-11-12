import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import {
  planWindowsNodeMxcFolderUpsert,
  type WindowsNodeMxcGatewayApproval,
} from "./windows-node-mxc";
import {
  migrateWeixinRemoteApprovalConfiguration,
  normalizeWeixinRemoteApprovalOwner,
  weixinRemoteApprovalAuthorityHash,
  weixinRemoteApprovalConsentHash,
  WEIXIN_NATIVE_DURABLE_CONSENT_SCOPE,
  WindowsNodeMxcWeixinRemoteApprovalBroker,
  type WeixinRemoteApprovalConfiguration,
} from "./windows-node-mxc-weixin-remote-approval";
import {
  WeixinRemoteDeliveryCoordinator,
  deliverWeixinRemoteApproval,
  exactWeixinApprovalSource,
  remoteApprovalDiagnosticBinding,
} from "./windows-node-mxc-weixin-remote-approval-delivery";
import { commitMxcApprovalDecision } from "./windows-node-mxc-approval-lifecycle";
import { describeWeixinSessionBinding } from "./weixin-session-routing";
import { describeWeixinApprovalDecision } from "./mxc-approval-context-diagnostics";
// @ts-expect-error External ESM actual Main-function fixture.
import { createMainFunctionFixture } from "../integration/main-weixin-inbound-fixture.mjs";

const owner = normalizeWeixinRemoteApprovalOwner(
  "public-bot",
  "public-user@im.wechat",
  "2026-10-23T00:00:00.000Z",
);
const security = {
  gatewayGeneration: "generation",
  policyFingerprint: "b".repeat(64),
  nodeId: "public-node",
  activationLeaseHash: "d".repeat(64),
  requestedMode: "limited-dacl" as const,
  effectiveMode: "appcontainer-dacl",
};

function fixture(folderChanges = false) {
  const now = Date.now();
  const source = {
    accountId: owner.accountId,
    senderId: owner.userId,
    conversationId: owner.userId,
    agentId: "main",
    sessionKey: "agent:main:public",
    messageId: "100",
    cursor: 100,
    receivedAtUnixMs: now,
    gatewayGeneration: security.gatewayGeneration,
    runIds: ["public-run"],
    direct: true,
    forwarded: false,
    quoted: false,
  };
  const request: WindowsNodeMxcGatewayApproval = {
    id: "public-pending",
    command: "public.exe --public",
    executable: "public.exe",
    arguments: ["--public"],
    executablePath: "C:\\Tools\\public.exe",
    executableSha256: "a".repeat(64),
    canonicalCwd: "isolated-scratch:v1",
    agent: source.agentId,
    sessionKey: source.sessionKey,
    declaredAccess: [],
    hasMutableFileOperand: false,
    allowedDecisions: ["allow-once", "deny"],
    expiresAtUnixMs: now + 60_000,
    origin: {
      contract: "microclaw.gateway-approval-origin.v1",
      gatewayGeneration: security.gatewayGeneration,
      agentId: source.agentId,
      runSessionKey: source.sessionKey,
      executionSessionKey: source.sessionKey,
      runId: "public-run",
      toolCallId: "public-tool",
      nodeId: security.nodeId,
      channel: "openclaw-weixin",
      accountId: owner.accountId,
      to: owner.userId,
    },
    ...(folderChanges
      ? {
          folderChanges: [{ path: "C:\\Approved", access: "rw" as const }],
          planSha256: "e".repeat(64),
          policyFingerprint: security.policyFingerprint,
        }
      : {}),
  };
  let configuration: WeixinRemoteApprovalConfiguration = { enabled: true, owner };
  const broker = new WindowsNodeMxcWeixinRemoteApprovalBroker(undefined, () => ({
    accountId: owner.accountId,
    userId: owner.userId,
  }));
  const readConfiguration = () => {
    broker.configure(configuration);
    return configuration;
  };
  readConfiguration();
  const pending = {
    request,
    gatewayGeneration: security.gatewayGeneration,
    receivedAtUnixMs: now,
    expiresAtUnixMs: now + 45_000,
    lifecycle: { pending: true, decide: vi.fn() },
    remoteSource: source,
    remoteSecurity: security,
    remoteChallengeId: null as string | null,
    remoteAuthorityHash: null as string | null,
    remoteDelivery: null,
    remoteCoordinator: new WeixinRemoteDeliveryCoordinator(),
    remoteAttempt: Promise.resolve(null),
    folderGrantsSaved: false,
  };
  const changeConfiguration = (value: WeixinRemoteApprovalConfiguration) => {
    configuration = value;
    readConfiguration();
  };
  const createResolvingChallenge = () => {
    const delivery = broker.createChallenge({
      source,
      requests: [{ approval: request }],
      security,
      locale: "en-US",
      now,
      expiresAtUnixMs: pending.expiresAtUnixMs,
    });
    if (!delivery) throw new Error("Enrolled owner fixture was rejected");
    pending.remoteChallengeId = delivery.challengeId;
    pending.remoteAuthorityHash = weixinRemoteApprovalAuthorityHash(readConfiguration());
    expect(broker.markDelivered(delivery.challengeId, now + 1)).toBe(true);
    expect(
      broker.resolveCandidate({
        ...source,
        text: "1",
        messageId: "101",
        cursor: 101,
        now: now + 2,
        requests: [{ approval: request }],
        security,
      }),
    ).toMatchObject({ status: "approved", decision: "allow-once" });
    return delivery.challengeId;
  };
  return {
    broker,
    source,
    request,
    pending,
    readConfiguration,
    changeConfiguration,
    createResolvingChallenge,
  };
}

describe("automatic WeChat approval authority", () => {
  it.each([
    undefined,
    null,
    { contract: "old-receipt", owner },
    { receiptId: "forged", owner: { ...owner, userId: "other@im.wechat" } },
  ])("migrates an enrolled owner independently of legacy disclosure data %#", (legacyReceipt) => {
    const stored = { enabled: true, owner, fullDetailDisclosure: legacyReceipt };
    const migrated = migrateWeixinRemoteApprovalConfiguration(stored);
    expect(migrated).toEqual({ enabled: true, owner });
    expect(weixinRemoteApprovalAuthorityHash(migrated)).not.toBeNull();
    expect(weixinRemoteApprovalConsentHash(migrated)).toBeNull();
    expect(
      migrateWeixinRemoteApprovalConfiguration({
        ...stored,
        consentScope: WEIXIN_NATIVE_DURABLE_CONSENT_SCOPE,
      }),
    ).toEqual({ enabled: true, owner, consentScope: WEIXIN_NATIVE_DURABLE_CONSENT_SCOPE });
  });

  it("does not grant authority without a valid enabled owner", () => {
    for (const stored of [
      { enabled: false, owner },
      { enabled: true, owner: null },
      { enabled: true, owner: { ...owner, userId: "not-an-owner" } },
    ]) {
      expect(
        weixinRemoteApprovalAuthorityHash(migrateWeixinRemoteApprovalConfiguration(stored)),
      ).toBeNull();
    }
  });

  it("serializes active and queued approval resolutions and releases the lock after failures", async () => {
    const resolutions = createMainFunctionFixture("withWindowsNodeMxcApprovalResolution", {
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
    const secondOperation = vi.fn(async () => "second");
    const second = resolutions.handle(secondOperation);
    expect(secondOperation).not.toHaveBeenCalled();
    release();
    await first;
    await expect(second).resolves.toBe("second");
    await expect(
      resolutions.handle(async () => {
        throw new Error("synthetic failure");
      }),
    ).rejects.toThrow("synthetic failure");
    await expect(resolutions.handle(async () => "recovered")).resolves.toBe("recovered");
    resolutions.replace("windowsNodeMxcSecurityTransitionInProgress", true);
    await expect(resolutions.handle(async () => undefined)).rejects.toThrow("lifecycle transition");
  });

  it.each(["disabled", "rebound", "disable-and-restore"] as const)(
    "ignores a late delivery acknowledgement after enrollment changes: %s",
    async (change) => {
      const state = fixture();
      const { pending, broker, readConfiguration, changeConfiguration } = state;
      let finish!: () => void;
      const deliver = vi.fn(
        (params: { onDelivered?: () => void }) =>
          new Promise<void>((resolve) => {
            finish = () => {
              params.onDelivered?.();
              resolve();
            };
          }),
      );
      const published: string[] = [];
      const main = createMainFunctionFixture("beginPendingWindowsNodeMxcRemoteDelivery", {
        getWindowsNodeMxcWeixinRemoteApprovalConfiguration: readConfiguration,
        weixinRemoteApprovalAuthorityHash,
        pendingWindowsNodeMxcGatewayApproval: pending,
        findPendingWindowsNodeMxcGatewayApproval: () => pending,
        currentWindowsNodeMxcWeixinRemoteApprovalSecurity: () => security,
        deliverWeixinRemoteApproval,
        windowsNodeMxcWeixinRemoteApprovalBroker: broker,
        readAuthenticatedWeixinWireOwner: () => ({
          accountId: owner.accountId,
          userId: owner.userId,
        }),
        getOpenClawStateDir: () => "synthetic-no-filesystem-access",
        publishPendingWeixinRemoteDelivery: (_pending: unknown, delivery: { state: string }) => {
          published.push(delivery.state);
          Object.assign(pending, { remoteDelivery: delivery });
        },
        remoteApprovalDiagnosticBinding,
        describeWeixinSessionBinding,
        describeWeixinApprovalDecision,
        windowsNodeMxcWeixinRemoteApprovalSources: new Map(),
        console: { info: vi.fn(), error: vi.fn() },
      });
      const server = { isRegistered: () => true, deliver };
      main.handle(pending, "en-US", server);
      await vi.waitFor(() => expect(deliver).toHaveBeenCalledOnce());
      const challengeId = pending.remoteChallengeId!;
      const originalDeadline = pending.expiresAtUnixMs;
      if (change === "rebound") {
        changeConfiguration({
          enabled: true,
          owner: { ...owner, boundAt: "2026-10-24T00:00:00Z" },
        });
      } else {
        changeConfiguration({ enabled: false, owner: null });
        if (change === "disable-and-restore") changeConfiguration({ enabled: true, owner });
      }
      finish();
      await pending.remoteAttempt;
      expect(published).not.toContain("sent");
      expect(broker.markDelivered(challengeId)).toBe(false);
      expect(pending.lifecycle.pending).toBe(true);
      expect(pending.expiresAtUnixMs).toBe(originalDeadline);
      for (const trigger of ["source-bound", "promoted"] as const) {
        main.handle(pending, "en-US", server, false, trigger);
        await pending.remoteAttempt;
      }
      expect(deliver).toHaveBeenCalledOnce();
    },
  );

  it("keeps renderer-writable settings from changing remote approval authority", () => {
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
          (declaration) => declaration.name.getText(ast) === "RENDERER_WRITABLE_SETTING_KEYS",
        ),
    );
    if (!statement) throw new Error("Actual Settings allowlist missing");
    const source = ts.transpileModule(statement.getText(ast), {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    const allowed = new Function(
      `${source}; return RENDERER_WRITABLE_SETTING_KEYS;`,
    )() as Set<string>;
    expect(allowed.has("windowsNodeMxcWeixinRemoteApproval")).toBe(false);
    expect(allowed.has("consentScope")).toBe(false);
    expect(readFileSync(filename, "utf8")).toContain(
      "if (!RENDERER_WRITABLE_SETTING_KEYS.has(key))",
    );
  });
});

describe("actual Main WeChat resolution fencing", () => {
  function resolutionFixture(
    folderChanges = false,
    currentFolders: { ro: string[]; rw: string[] } = { ro: [], rw: [] },
  ) {
    const state = fixture(folderChanges);
    const challengeId = state.createResolvingChallenge();
    const client = { connected: true, request: vi.fn().mockResolvedValue({}) };
    const lock = createMainFunctionFixture("withWindowsNodeMxcApprovalResolution", {
      windowsNodeMxcApprovalResolutionInProgress: false,
      windowsNodeMxcApprovalResolutionCompletion: null,
      windowsNodeMxcFailClosedPromise: null,
      windowsNodeMxcSecurityTransitionInProgress: false,
    });
    const applyFolders = vi.fn(
      async (_next: unknown, _pending: unknown, assertCurrent: () => void) => {
        assertCurrent();
      },
    );
    const planFolders = createMainFunctionFixture("planRequestedWindowsNodeMxcFolders", {
      getWindowsNodeMxcFolderPolicy: () => currentFolders,
      validateWindowsNodeMxcUserDir: async (folder: string) => ({
        ok: true,
        canonicalPath: folder,
      }),
      planWindowsNodeMxcFolderUpsert,
    });
    const commit = createMainFunctionFixture("commitPendingWindowsNodeMxcGatewayApproval", {
      exactWeixinApprovalSource,
      getWindowsNodeMxcWeixinRemoteApprovalConfiguration: state.readConfiguration,
      weixinRemoteApprovalAuthorityHash,
      windowsNodeMxcWeixinRemoteApprovalBroker: state.broker,
      readAuthenticatedWeixinWireOwner: () => ({
        accountId: owner.accountId,
        userId: owner.userId,
      }),
      getOpenClawStateDir: () => "synthetic-no-filesystem-access",
      withWindowsNodeMxcApprovalResolution: lock.handle,
      gatewayGenerationId: security.gatewayGeneration,
      windowsNodeMxcApprovalProofContext: {},
      gwClient: client,
      requireEffectiveWindowsNodeMxc: async () => undefined,
      windowsNodeMxcSecurityTransitionInProgress: false,
      findPendingWindowsNodeMxcGatewayApproval: () => state.pending,
      isApplicationIngressReady: () => true,
      currentWindowsNodeMxcWeixinRemoteApprovalSecurity: () => security,
      sendToWindow: vi.fn(),
      mainWindow: {},
      planRequestedWindowsNodeMxcFolders: planFolders.handle,
      applyRunningWindowsNodeMxcFolders: applyFolders,
      commitMxcApprovalDecision,
      windowsNodeMxcGatewayApprovalResolutionTarget: null,
      windowsNodeMxcWeixinRemoteApprovalServer: null,
      resolveSupportedLocale: () => "en-US",
      settingsStore: { get: () => "en-US" },
      console: { info: vi.fn(), error: vi.fn() },
    });
    state.pending.lifecycle.decide.mockImplementation((decision, origin) =>
      commit.handle(state.pending, decision, origin, security),
    );
    const resolve = createMainFunctionFixture("resolvePendingWindowsNodeMxcGatewayApproval", {
      findPendingWindowsNodeMxcGatewayApproval: () => state.pending,
      getWindowsNodeMxcWeixinRemoteApprovalConfiguration: state.readConfiguration,
      weixinRemoteApprovalAuthorityHash,
      windowsNodeMxcWeixinRemoteApprovalBroker: state.broker,
    });
    return { ...state, challengeId, client, lock, applyFolders, commit, resolve };
  }

  it.each(["disabled", "rebound", "disabled-then-restored", "rebound-then-restored"] as const)(
    "rejects a queued resolution after enrollment authority changes: %s",
    async (change) => {
      const state = resolutionFixture();
      let release!: () => void;
      const first = state.lock.handle(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          }),
      );
      const result = state.resolve.handle(state.request.id, "allow-once", true, security);
      expect(state.pending.lifecycle.decide).toHaveBeenCalledOnce();
      if (change.startsWith("disabled")) state.changeConfiguration({ enabled: false, owner: null });
      else
        state.changeConfiguration({
          enabled: true,
          owner: { ...owner, boundAt: "2026-10-24T00:00:00Z" },
        });
      if (change.endsWith("restored")) state.changeConfiguration({ enabled: true, owner });
      expect(state.broker.isResolutionPending(state.challengeId)).toBe(false);
      release();
      await first;
      await expect(result).rejects.toThrow(
        /WeChat (?:approval owner|folder approval authority) changed/,
      );
      expect(state.client.request).not.toHaveBeenCalled();
    },
  );

  it("keeps the consumed exact challenge valid during its own folder-policy relock", async () => {
    const state = resolutionFixture(true);
    state.applyFolders.mockImplementation(async (_next, _pending, assertCurrent) => {
      assertCurrent();
      state.broker.invalidateAll("security-relock", state.request.id);
      expect(state.broker.isResolutionPending(state.challengeId)).toBe(true);
      assertCurrent();
    });
    await expect(
      state.resolve.handle(state.request.id, "allow-once", true, security),
    ).resolves.toBeUndefined();
    expect(state.pending.folderGrantsSaved).toBe(true);
    expect(state.client.request).toHaveBeenCalledExactlyOnceWith("exec.approval.resolve", {
      id: state.request.id,
      decision: "allow-once",
    });
  });

  it("preserves existing child grants when an approved request adds their parent", async () => {
    const state = resolutionFixture(true, {
      rw: ["C:\\Approved\\Work"],
      ro: ["C:\\Approved\\Reference"],
    });
    await expect(
      state.resolve.handle(state.request.id, "allow-once", true, security),
    ).resolves.toBeUndefined();
    expect(state.applyFolders).toHaveBeenCalledOnce();
    expect(state.applyFolders.mock.calls[0][0]).toEqual({
      rw: ["C:\\Approved", "C:\\Approved\\Work"],
      ro: ["C:\\Approved\\Reference"],
    });
  });

  it.each(["disabled", "rebound"] as const)(
    "fails closed if %s enrollment changes during a folder grant",
    async (change) => {
      const state = resolutionFixture(true);
      state.applyFolders.mockImplementation(async (_next, _pending, assertCurrent) => {
        assertCurrent();
        state.changeConfiguration(
          change === "disabled"
            ? { enabled: false, owner: null }
            : { enabled: true, owner: { ...owner, boundAt: "2026-10-24T00:00:00Z" } },
        );
        assertCurrent();
      });
      await expect(
        state.resolve.handle(state.request.id, "allow-once", true, security),
      ).rejects.toThrow("WeChat folder approval authority changed");
      expect(state.pending.folderGrantsSaved).toBe(false);
      expect(state.client.request).not.toHaveBeenCalled();
    },
  );
});
