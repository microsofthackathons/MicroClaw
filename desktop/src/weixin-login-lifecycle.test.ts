import { readFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

function readRepositoryFile(...parts: string[]): string {
  return readFileSync(path.resolve(process.cwd(), "..", ...parts), "utf8");
}

describe("Weixin login lifecycle", () => {
  it("restores the current MXC generation without a native popup or Gateway restart", () => {
    const source = readRepositoryFile("desktop", "src", "main.ts");
    const login = source.slice(
      source.indexOf("async function beginWindowsNodeMxcWeixinAccountChange"),
      source.indexOf("let weixinRuntimeRead"),
    );
    expect(login).not.toContain("showMessageBox");
    expect(login).not.toContain("stopGatewayForSecurityTransition");
    expect(login).not.toContain("runAutomaticWindowsNodeMxcReadiness");
    expect(login).not.toContain("closeWindowsNodeMxcWeixinRemoteApproval");
    expect(login).toContain('setActivationLease("active", 120_000)');
    expect(login).toContain('assertWindowsNodeMxcBaseReady(status, "active", true)');
    expect(login.indexOf("assertWindowsNodeMxcBaseReady")).toBeLessThan(
      login.indexOf("releaseWindowsNodeMxcIngress(generation)"),
    );
    expect(login).toContain("weixinResumeAfterLogin");
    expect(login).toContain('"mxc-weixin-login-failed"');
    expect(login).toContain('"mxc-weixin-disconnect-failed"');
  });

  it("provisions transport independently of account enrollment and retains it across owner changes", () => {
    const source = readRepositoryFile("desktop", "src", "main.ts");
    const startup = source.slice(
      source.indexOf("const nextWeixinContext ="),
      source.indexOf("const nextHooksEnvironment ="),
    );
    expect(startup).toMatch(/getBundledWindowsNodeFolders\(\),\s*true,/);
    expect(startup).not.toContain("nextRemoteApprovalConfiguration.enabled");
    const reconcile = source.slice(
      source.indexOf("function reconcileWindowsNodeMxcWeixinRemoteApprovalOwner"),
      source.indexOf("function persistWindowsNodeMxcWeixinRemoteApprovalPlan"),
    );
    expect(reconcile).toContain("windowsNodeMxcWeixinRemoteApprovalBroker.configure(disabled)");
    expect(reconcile).not.toContain("closeWindowsNodeMxcWeixinRemoteApproval");
  });
  it("hot-applies plugin toggles and guards QR readiness before admitting a login", () => {
    const source = readRepositoryFile("desktop", "src", "main.ts");
    const toggle = source.slice(
      source.indexOf('ipcMain.handle("plugin:weixin:set-enabled"'),
      source.indexOf('ipcMain.handle("plugin:weixin:login"'),
    );
    expect(toggle).toContain("await setWeixinPluginEnabled");
    expect(toggle).toContain("beginPluginChange");
    expect(toggle).toContain("endPluginChange");
    expect(toggle).not.toContain("writeFileSync");
    expect(toggle).not.toContain("restartManagedGateway");
    const qr = source.slice(
      source.indexOf('"plugin:weixin:login-qr-start"'),
      source.indexOf('"plugin:weixin:login-qr-wait"'),
    );
    expect(qr.indexOf("getChannelsStatus")).toBeLessThan(qr.indexOf("beginQr"));
    expect(qr).toContain("isWeixinLoginReady");
    expect(qr).toContain("isKnownWeixinQrStartRejection");
    expect(qr).toContain("canFallback: knownRejection");
    expect(qr).toContain("restartRequired: !knownRejection");
  });

  it.each(["ChannelsView.vue", "PluginsView.vue"])(
    "shares the lightweight connection card in %s",
    (viewName) => {
      const source = readRepositoryFile("desktop", "renderer", "src", "views", viewName);
      expect(source).toContain("WeixinConnectionCard");
      expect(source).not.toContain("gateway.restart");
      expect(source).not.toContain("el-switch");
    },
  );

  it("persists credentials before reporting success without reloading plugin configuration", () => {
    const source = readRepositoryFile("plugins", "openclaw-weixin", "src", "channel.ts");
    const waitHandler = source.slice(
      source.indexOf("loginWithQrWait: async"),
      source.indexOf("\n    },\n  },", source.indexOf("loginWithQrWait: async")),
    );

    expect(waitHandler).toContain("replaceWeixinAccount");
    expect(waitHandler).not.toContain("triggerWeixinChannelReload");
    expect(waitHandler.indexOf("replaceWeixinAccount")).toBeLessThan(
      waitHandler.lastIndexOf("return {"),
    );
  });

  it("keeps QR polling in the main process and disconnects using native channel logout", () => {
    const source = readRepositoryFile("desktop", "src", "main.ts");
    const handler = source.slice(
      source.indexOf('"plugin:weixin:login-qr-wait"'),
      source.indexOf("registerLocalModelHandlers", source.indexOf('"plugin:weixin:login-qr-wait"')),
    );

    expect(handler).not.toContain("restartManagedGateway");
    expect(handler).not.toContain("writeFileSync");
    expect(handler).toContain('"channels.logout"');
    expect(handler).toContain('beginWindowsNodeMxcWeixinAccountChange("disconnect")');
    expect(handler).toContain('guard.finish(result.ok ? "disconnected" : "cancelled")');
    expect(source).toContain("weixinQrSession.start(");
    expect(source).toContain("sessionKey, timeoutMs: 35_000");
  });

  it("resumes cancelled and expired QR channels in Off without bypassing the MXC guard", () => {
    const source = readRepositoryFile("desktop", "src", "main.ts");
    const wait = source.slice(
      source.indexOf("async function waitForWeixinConnection"),
      source.indexOf("let weixinMutationLockRevision"),
    );
    expect(wait).toContain(
      "!login && !weixinQrCancellation && !result.connected && !result.pending",
    );
    expect(wait.indexOf("await resumeWeixinAfterQr")).toBeLessThan(
      wait.indexOf("weixinMutations.qrConnected"),
    );
    expect(wait).toContain("gateway.connectionGeneration !== connection");
    expect(wait).toContain("const result = await gateway.weixinResumeAfterLogin()");
    const cancel = source.slice(
      source.indexOf('ipcMain.handle("plugin:weixin:cancel-login"'),
      source.indexOf("// --- WeChat QR Login via Gateway"),
    );
    expect(cancel.indexOf("await weixinQrSession.cancel")).toBeLessThan(
      cancel.indexOf("resumeWeixinAfterQr"),
    );
    expect(cancel).toContain("if (windowsNodeMxcWeixinLogin)");
    expect(cancel).toContain("else if (hadQrSession && gateway");
    expect(cancel).toContain("await weixinMutations.run(assertWeixinQrLoginMutable");
  });

  it("does not replace the Gateway after an attested successful CLI login", () => {
    const source = readRepositoryFile("desktop", "src", "main.ts");
    const handler = source.slice(
      source.indexOf('ipcMain.handle("plugin:weixin:login"'),
      source.indexOf('ipcMain.handle("plugin:weixin:cancel-login"'),
    );

    expect(handler).toContain('activationOutcome === "reload-failed"');
    expect(handler).toContain("activationOutcome === null");
    expect(handler).toContain("CLI activation completed without Gateway replacement");
    expect(handler).not.toContain('restartManagedGateway("Activating Weixin after login")');
  });

  it("revalidates the exact remote-approval owner after asynchronous security activation", () => {
    const source = readRepositoryFile("desktop", "src", "main.ts");
    const handler = source.slice(
      source.indexOf("async function handleWindowsNodeMxcWeixinRemoteApprovalInbound"),
      source.indexOf(
        "function configureWindowsNodeMxcWeixinRemoteApprovalBroker",
        source.indexOf("async function handleWindowsNodeMxcWeixinRemoteApprovalInbound"),
      ),
    );

    const activation = handler.indexOf("await requireEffectiveWindowsNodeMxc");
    const revalidation = handler.indexOf("const revalidatedConfiguration");
    const resolution = handler.indexOf(
      "windowsNodeMxcWeixinRemoteApprovalBroker.resolveCandidate",
      revalidation,
    );
    expect(activation).toBeGreaterThanOrEqual(0);
    expect(revalidation).toBeGreaterThan(activation);
    expect(resolution).toBeGreaterThan(revalidation);
    expect(handler).toContain(
      "weixinRemoteApprovalWireSourceRejection(\n    revalidatedConfiguration,\n    inbound,\n    readAuthenticatedWeixinWireOwner(getOpenClawStateDir()),",
    );
    expect(handler).toContain("sourceRejection !== null");
    expect(handler).toContain(
      "!windowsNodeMxcWeixinRemoteApprovalBroker.isAuthenticatedSource(inbound)",
    );
  });
});
