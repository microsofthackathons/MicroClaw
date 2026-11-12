import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { normalizeWindowsNodeMxcGatewayApproval } from "./windows-node-mxc";

const source = readFileSync(resolve(process.cwd(), "src", "main.ts"), "utf8");
const routeStart = source.indexOf('if (evt.event === "exec.approval.requested")');
const routeEnd = source.indexOf('if (evt.event === "exec.approval.resolved")', routeStart);
const handlerStart = source.indexOf("async function handleWindowsNodeMxcGatewayApproval(");
const handlerEnd = source.indexOf(
  "function beginPendingWindowsNodeMxcRemoteDelivery(",
  handlerStart,
);
if (routeStart < 0 || routeEnd < 0 || handlerStart < 0 || handlerEnd < 0)
  throw new Error("Cannot locate the Gateway approval route");

const code = ts.transpileModule(
  `${source.slice(handlerStart, handlerEnd)}
   async function route(evt: any) { ${source.slice(routeStart, routeEnd)} }
   globalThis.route = route;`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
).outputText;

const nodeId = "a".repeat(64);
const fingerprint = "b".repeat(64);
const generation = "gateway-generation";

function payload(required: boolean) {
  const command = 'powershell.exe -Command "New-Item test.txt"';
  return {
    id: "approval-1",
    request: {
      host: "node",
      nodeId,
      systemRunPlan: {
        argv: ["powershell.exe", "-Command", "New-Item test.txt"],
        cwd: null,
        commandText: command,
        commandPreview: `# [declare-access]rw:C:\\Users\\test\\Downloads[/declare-access]\n${command}`,
        agentId: "main",
        sessionKey: "agent:main:approval-regression",
        executablePath: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        executableSha256: "c".repeat(64),
        cwdBinding: "isolated-scratch:v1",
        declaredAccess: [{ access: "rw", path: "C:\\Users\\test\\Downloads" }],
        policyFingerprint: fingerprint,
        commandConsent: { required, allowAlwaysAvailable: required },
      },
    },
  };
}

function harness(mode: "off" | "full") {
  const request = vi.fn(async () => ({}));
  const send = vi.fn();
  const folders = vi.fn(() => [] as Array<{ path: string; access: "ro" | "rw" }>);
  const requireReady = vi.fn(async () => {});
  const validateFolderPolicy = vi.fn(async () => {});
  const context = {
    route: undefined as ((event: unknown) => Promise<void>) | undefined,
    isWindowsNodeMxcDesired: () => mode === "full",
    getWindowsNodeMxcRequestedMode: () => mode,
    normalizeWindowsNodeMxcGatewayApproval,
    settingsStore: {
      get: (name: string) => (name === "windowsNodeMxcNodeId" ? nodeId : "en-US"),
    },
    gatewayGenerationId: generation,
    gwClient: { connected: true, request },
    windowsNodeMxcApprovalProofContext: { policyFingerprint: fingerprint },
    windowsNodeMxcApprovalResolutionCompletion: null,
    getWindowsNodeMxcMissingFolders: folders,
    getBundledWindowsNodeFolders: () => [],
    planRequestedWindowsNodeMxcFolders: async (
      changes: Array<{ path: string; access: "ro" | "rw" }>,
    ) => changes,
    toBundledWindowsNodeFolders: (changes: Array<{ path: string; access: "ro" | "rw" }>) => changes,
    bundledWindowsNodeHost: { validateFolderPolicy },
    windowsNodeMxcWeixinContext: null,
    withWindowsNodeMxcApprovalResolution: async (operation: () => Promise<void>) => operation(),
    requireEffectiveWindowsNodeMxc: requireReady,
    isApplicationIngressReady: () => true,
    findPendingWindowsNodeMxcGatewayApproval: () => null,
    mxcApprovalDeadline: () => Date.now() + 60_000,
    findWeixinApprovalSource: () => null,
    windowsNodeMxcWeixinRemoteApprovalSources: [],
    currentWindowsNodeMxcWeixinRemoteApprovalSecurity: () => null,
    windowsNodeMxcWeixinRemoteApprovalServer: null,
    resolveSupportedLocale: (locale: string) => locale,
    WeixinRemoteDeliveryCoordinator: class {},
    WindowsNodeMxcApprovalLifecycle: class {
      start() {}
    },
    pendingWindowsNodeMxcGatewayApproval: null,
    queuedWindowsNodeMxcGatewayApprovals: [],
    projectWindowsNodeMxcApprovalForRenderer: (approval: unknown) => approval,
    sendToWindow: send,
    mainWindow: {},
    beginPendingWindowsNodeMxcRemoteDelivery: vi.fn(),
    describeGatewayApprovalContext: () => ({}),
    console: { info: vi.fn(), error: vi.fn() },
  };
  runInNewContext(code, context);
  if (!context.route) throw new Error("Gateway approval route did not load");
  return {
    context,
    request,
    send,
    folders,
    requireReady,
    validateFolderPolicy,
    route: context.route,
  };
}

describe("Gateway approval routing", () => {
  it.each(["off", "full"] as const)(
    "automatically resolves pre-authorized commands in %s mode",
    async (mode) => {
      const fixture = harness(mode);
      await fixture.route({ event: "exec.approval.requested", payload: payload(false) });
      await vi.waitFor(() =>
        expect(fixture.request).toHaveBeenCalledWith("exec.approval.resolve", {
          id: "approval-1",
          decision: "allow-once",
        }),
      );
      expect(fixture.requireReady).toHaveBeenCalledWith(true);
      expect(fixture.send).not.toHaveBeenCalled();
      expect(fixture.folders).toHaveBeenCalledTimes(mode === "full" ? 1 : 0);
    },
  );

  it("binds stale Off-mode declarations without enforcing MXC path restrictions", async () => {
    const approval = payload(false);
    const uncPath = "\\\\example.invalid\\share";
    approval.request.systemRunPlan.commandPreview =
      `# [declare-access]rw:${uncPath}[/declare-access]\n` +
      approval.request.systemRunPlan.commandText;
    approval.request.systemRunPlan.declaredAccess = [{ access: "rw", path: uncPath }];

    const off = harness("off");
    await off.route({ event: "exec.approval.requested", payload: approval });
    await vi.waitFor(() =>
      expect(off.request).toHaveBeenCalledWith("exec.approval.resolve", {
        id: "approval-1",
        decision: "allow-once",
      }),
    );
    expect(off.folders).not.toHaveBeenCalled();

    const full = harness("full");
    await full.route({ event: "exec.approval.requested", payload: approval });
    expect(full.request).toHaveBeenCalledWith("exec.approval.resolve", {
      id: "approval-1",
      decision: "deny",
    });

    const tampered = harness("off");
    approval.request.systemRunPlan.declaredAccess[0].path = "\\\\other.invalid\\share";
    await tampered.route({ event: "exec.approval.requested", payload: approval });
    expect(tampered.request).toHaveBeenCalledWith("exec.approval.resolve", {
      id: "approval-1",
      decision: "deny",
    });
  });

  it("prompts for command consent in Off mode without requesting a folder grant", async () => {
    const fixture = harness("off");
    await fixture.route({ event: "exec.approval.requested", payload: payload(true) });
    await vi.waitFor(() => expect(fixture.send).toHaveBeenCalledOnce());
    expect(fixture.send).toHaveBeenCalledWith(
      expect.anything(),
      "windows-node-mxc:approval-request",
      expect.objectContaining({
        id: "approval-1",
        containmentStrength: "off",
        allowedDecisions: expect.arrayContaining(["deny", "allow-once", "allow-always"]),
      }),
    );
    expect(fixture.folders).not.toHaveBeenCalled();
    expect(fixture.request).not.toHaveBeenCalled();
  });

  it("offers an explicit combined approval for a profile parent accepted by upstream", async () => {
    const fixture = harness("full");
    const profile = "C:\\Users\\test";
    const approval = payload(true);
    approval.request.systemRunPlan.commandPreview =
      `# [declare-access]ro:${profile}[/declare-access]\n` +
      approval.request.systemRunPlan.commandText;
    approval.request.systemRunPlan.declaredAccess = [{ access: "ro", path: profile }];
    fixture.folders.mockReturnValue([{ path: profile, access: "ro" }]);

    await fixture.route({ event: "exec.approval.requested", payload: approval });
    await vi.waitFor(() => expect(fixture.send).toHaveBeenCalledOnce());
    expect(fixture.validateFolderPolicy).toHaveBeenCalledWith([{ path: profile, access: "ro" }]);
    expect(fixture.send).toHaveBeenCalledWith(
      expect.anything(),
      "windows-node-mxc:approval-request",
      expect.objectContaining({
        folderChanges: [{ path: profile, access: "ro" }],
        allowedDecisions: ["deny", "allow-once"],
      }),
    );
    expect(fixture.request).not.toHaveBeenCalled();
  });

  it("denies an upstream-rejected folder before showing an approval", async () => {
    const fixture = harness("full");
    const protectedChild = "C:\\Users\\test\\.ssh";
    const approval = payload(true);
    approval.request.systemRunPlan.commandPreview =
      `# [declare-access]ro:${protectedChild}[/declare-access]\n` +
      approval.request.systemRunPlan.commandText;
    approval.request.systemRunPlan.declaredAccess = [{ access: "ro", path: protectedChild }];
    fixture.folders.mockReturnValue([{ path: protectedChild, access: "ro" }]);
    fixture.validateFolderPolicy.mockRejectedValueOnce(new Error("Upstream protected folder"));

    await fixture.route({ event: "exec.approval.requested", payload: approval });
    await vi.waitFor(() =>
      expect(fixture.request).toHaveBeenCalledWith("exec.approval.resolve", {
        id: "approval-1",
        decision: "deny",
      }),
    );
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it("denies malformed Off-mode requests rather than leaving them pending", async () => {
    const fixture = harness("off");
    await fixture.route({
      event: "exec.approval.requested",
      payload: { id: "malformed", request: {} },
    });
    expect(fixture.request).toHaveBeenCalledWith("exec.approval.resolve", {
      id: "malformed",
      decision: "deny",
    });
    expect(fixture.send).not.toHaveBeenCalled();
  });

  it.each(["off", "full"] as const)(
    "leaves unrelated approval requests for their own clients in %s mode",
    async (mode) => {
      const fixture = harness(mode);
      const otherNode = payload(false);
      otherNode.request.nodeId = "d".repeat(64);
      await fixture.route({ event: "exec.approval.requested", payload: otherNode });
      await fixture.route({
        event: "exec.approval.requested",
        payload: { id: "gateway-approval", request: { host: "gateway" } },
      });
      expect(fixture.request).not.toHaveBeenCalled();
      expect(fixture.send).not.toHaveBeenCalled();
    },
  );
});
