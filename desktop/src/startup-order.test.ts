import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("desktop startup order", () => {
  it("rejects missing gateway runtime files instead of silently waiting for the installer timeout", () => {
    const source = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");
    for (const filename of ["nodePath", "entryPath"]) {
      const start = source.indexOf(`if (!fs.existsSync(${filename}))`);
      const guard = source.slice(start, source.indexOf("\n    }", start));
      expect(start).toBeGreaterThan(-1);
      expect(guard).toContain('setGatewayStatus("failed")');
      expect(guard).toContain("rollbackStartupAgentSkills()");
      expect(guard).toContain("throw new Error(");
      expect(guard).not.toContain("return;");
    }
    const services = source.slice(source.indexOf("startApplicationServices().catch"));
    expect(services.slice(0, services.indexOf("});"))).toContain("signalPostInstallFailure(err)");
  });

  it("prepares the installer runtime headlessly before upgrade recovery or application startup", () => {
    const source = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");
    const lifecycle = source.slice(source.indexOf("const applicationStartup = app.whenReady()"));
    const preparation = lifecycle.indexOf("process.argv.includes(INSTALLER_RUNTIME_ARGUMENT)");
    const exit = lifecycle.indexOf(
      "app.exit(await prepareInstallerRuntime(prepareBundledOpenClawDir))",
    );
    expect(preparation).toBeGreaterThan(-1);
    expect(exit).toBeGreaterThan(preparation);
    expect(lifecycle.slice(exit, lifecycle.indexOf("if (!settingsStore.has"))).toContain("return;");
    for (const action of [
      "validateInstallerOwnedUpgrade(",
      "registerIpcHandlers()",
      "const initialWindow = createMainWindow()",
      "startApplicationServices().catch",
    ]) {
      expect(lifecycle.indexOf(action)).toBeGreaterThan(exit);
    }
  });

  it("keeps configured model use and catalog reads independent of the Copilot setup flag", () => {
    const source = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");
    const chatValidation = source.slice(
      source.indexOf("async function assertChatModelEnabled("),
      source.indexOf("async function withInternalModelChat<"),
    );
    expect(chatValidation).toContain("assertChatModelSupported(modelRef)");
    expect(chatValidation).not.toContain("internalFeatures");
    expect(chatValidation).not.toContain("assertModelProviderEnabled");
    expect(source).toContain("hasConfiguredModel(config)");
    for (const channel of [
      "gateway:warm-up-agent",
      "model:github-copilot:status",
      "model:github-copilot:list-models",
    ]) {
      const start = source.indexOf(`ipcMain.handle("${channel}"`);
      expect(start).toBeGreaterThan(-1);
      const handler = source.slice(start, source.indexOf("\n  });", start));
      expect(handler).not.toContain("internalFeatures.githubCopilot");
    }
    for (const channel of ["model:github-copilot:prepare", "model:github-copilot:start-login"]) {
      const start = source.indexOf(`ipcMain.handle("${channel}"`);
      expect(start).toBeGreaterThan(-1);
      const handler = source.slice(start, source.indexOf("\n  });", start));
      expect(handler).toContain("assertGitHubCopilotEnabled(internalFeatures.githubCopilot)");
    }
  });

  it("forwards the chat send acknowledgment instead of discarding the request run ID", () => {
    const source = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");
    const handler = source.slice(
      source.indexOf('"chat:send-message"'),
      source.indexOf('"chat:load-history"'),
    );
    expect(handler).toContain("return await gwClient.sendChat(");
  });
  it("uses archive-backed loading only for the packaged bundled runtime before compatibility hooks", () => {
    const source = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");
    const setup = source.slice(
      source.indexOf("const archiveLoaderPath ="),
      source.indexOf("const approvalCompatPath ="),
    );
    expect(setup).toContain("app.isPackaged &&");
    expect(setup).toContain(
      'entryPath === path.join(bundledRuntimeRoot, "node_modules", "openclaw", "openclaw.mjs")',
    );
    expect(setup).toContain("fs.existsSync(runtimeArchivePath)");
    expect(setup).toContain("delete gwEnv.MICROCLAW_OPENCLAW_ARCHIVE");
    expect(setup).toContain("delete gwEnv.MICROCLAW_OPENCLAW_RUNTIME_ROOT");
    expect(setup).toContain(
      "gwEnv.NODE_OPTIONS += ` --import=${pathToFileURL(archiveLoaderPath).href}`",
    );
    const packaging = readFileSync(resolve(process.cwd(), "electron-builder.yml"), "utf8");
    expect(packaging).toContain("from: src/openclaw-archive-loader.mjs");
  });

  it("defers second-instance recovery until initial preparation and navigation finish", () => {
    const source = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");
    const handler = source.slice(
      source.indexOf('app.on("second-instance"'),
      source.indexOf("const applicationStartup = app.whenReady()"),
    );
    const waitIndex = handler.indexOf("applicationStartup");
    const callbackIndex = handler.indexOf(".then(async () =>");
    const recoveryIndex = handler.indexOf('showOrRecoverMainWindow("second-instance")');
    expect(waitIndex).toBeGreaterThan(-1);
    expect(callbackIndex).toBeGreaterThan(waitIndex);
    expect(recoveryIndex).toBeGreaterThan(callbackIndex);
    expect(handler.indexOf("await ensureGatewayConnected()")).toBeGreaterThan(recoveryIndex);
    expect(handler.slice(callbackIndex, recoveryIndex)).toContain(
      "if (explicitQuitRequested) return;",
    );
  });

  it("prepares integrity before creating a window and loads the renderer before service preflight", () => {
    const source = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");
    const lifecycle = source.slice(
      source.indexOf("app.whenReady().then"),
      source.indexOf('app.on("window-all-closed"'),
    );

    const preparationIndex = lifecycle.indexOf("await prepareBundledOpenClawDir()");
    const integrityIndex = lifecycle.indexOf("verifySkillIntegrity()");
    const snapshotIndex = lifecycle.indexOf("generateAndSignSnapshot()");
    const windowIndex = lifecycle.indexOf("const initialWindow = createMainWindow()");
    const servicesIndex = lifecycle.indexOf("startApplicationServices().catch");
    const rendererIndex = lifecycle.indexOf("await loadMainWindowRenderer(initialWindow)");

    expect(preparationIndex).toBeGreaterThan(-1);
    expect(integrityIndex).toBeGreaterThan(preparationIndex);
    expect(lifecycle.slice(preparationIndex, integrityIndex)).toContain(
      'requestExplicitQuit("runtime-preparation-failed")',
    );
    expect(snapshotIndex).toBeGreaterThan(integrityIndex);
    expect(windowIndex).toBeGreaterThan(snapshotIndex);
    expect(rendererIndex).toBeGreaterThan(windowIndex);
    expect(servicesIndex).toBeGreaterThan(rendererIndex);
    expect(servicesIndex).toBeGreaterThan(
      lifecycle.indexOf('scheduleMainWindowRecovery("initial-renderer-load-failed"'),
    );
    expect(lifecycle.slice(rendererIndex, servicesIndex)).toContain(
      "if (explicitQuitRequested) return;",
    );
    expect(lifecycle).not.toMatch(/await\s+startApplicationServices\(/);

    const serviceStart = source.indexOf("async function startApplicationServices()");
    expect(serviceStart).toBeGreaterThan(-1);
    const service = source.slice(serviceStart, source.indexOf("\n}", serviceStart) + 2);
    expect(service).toContain("await startGateway();");
  });

  it("stops the standard Gateway before Off-to-MXC preflight so paused ingress cannot race", () => {
    const source = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");
    const handler = source.slice(
      source.search(/ipcMain\.handle\(\s*"windows-node-mxc:set-enabled"/u),
      source.indexOf('"windows-node-mxc:approval-respond"'),
    );
    const suspensionBranch = handler.indexOf("if (suspendCronBeforePreflight)");
    const gatewayStop = handler.indexOf(
      "await stopGatewayForSecurityTransition(configuredPort)",
      suspensionBranch,
    );
    const preflight = handler.indexOf(
      "await prepareWindowsNodeMxcContainment(requestedMode)",
      suspensionBranch,
    );

    expect(suspensionBranch).toBeGreaterThan(-1);
    expect(handler.indexOf("closeWindowsNodeMxcIngress()", suspensionBranch)).toBeGreaterThan(
      suspensionBranch,
    );
    expect(gatewayStop).toBeGreaterThan(suspensionBranch);
    expect(preflight).toBeGreaterThan(gatewayStop);
    expect(handler).toContain("Restoring standard Gateway after MXC preflight failure");
  });

  it("performs one tracked containment validation before mutation and reuses it for readiness", () => {
    const source = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");
    const handler = source.slice(
      source.search(/ipcMain\.handle\(\s*"windows-node-mxc:set-enabled"/u),
      source.indexOf('"windows-node-mxc:approval-respond"'),
    );
    const planning = handler.indexOf("await planWeixinRemoteApprovalNativeTransition(");
    const validating = handler.indexOf(
      'setWindowsNodeMxcLifecycleState("validating", validationDetail)',
    );
    const preparations = handler.match(/await prepareWindowsNodeMxcContainment\(requestedMode\)/gu);
    const preparation = handler.indexOf("await prepareWindowsNodeMxcContainment(requestedMode)");
    const policyMutation = handler.indexOf("applyWindowsNodeMxcGatewayPolicy(");
    const remoteApprovalPersistence = handler.indexOf(
      "persistWindowsNodeMxcWeixinRemoteApprovalPlan(",
    );
    const settingsMutation = handler.indexOf(
      'settingsStore.set("windowsNodeMxcSelection", nextSelection)',
    );
    const readiness = handler.indexOf(
      "await runAutomaticWindowsNodeMxcReadiness(preparedContainment)",
    );

    expect(planning).toBeGreaterThan(-1);
    expect(handler.indexOf("assertTrustedRendererIpc(event)")).toBeLessThan(planning);
    expect(handler.indexOf("assertNativeWeixinRemoteApprovalAuthority(params)")).toBeLessThan(
      handler.indexOf("windowsNodeMxcLifecycleOperations.acquire<"),
    );
    expect(handler).toContain(
      "readOptions: () => getWeixinRemoteApprovalActivationOptions(readConfig())",
    );
    expect(handler).toContain("selection: remoteApprovalSelection");
    expect(handler).not.toContain("params?.remoteApproval");
    expect(validating).toBeGreaterThan(planning);
    expect(preparations).toHaveLength(1);
    expect(preparation).toBeGreaterThan(validating);
    expect(policyMutation).toBeGreaterThan(preparation);
    expect(remoteApprovalPersistence).toBeGreaterThan(policyMutation);
    expect(settingsMutation).toBeGreaterThan(remoteApprovalPersistence);
    expect(readiness).toBeGreaterThan(settingsMutation);
    expect(handler).toContain("mxc-validation-failed");
    expect(handler).toContain('settingsStore.delete("windowsNodeMxcAmbientAccess")');
    const automatic = source.slice(
      source.indexOf("async function runAutomaticWindowsNodeMxcReadiness("),
      source.indexOf("async function startApplicationServices("),
    );
    expect(automatic).toContain(
      'await startGatewayWithWindowsNodeMxcPolicy("locked", preparedContainment)',
    );
    expect(automatic).toContain(
      "assertPreparedWindowsNodeMxcContainment(preparedContainment, requestedMode)",
    );
    expect(source).toContain("prepared.transitionId !== windowsNodeMxcReadinessTransitionId");
    const guardFailure = handler.indexOf("if (!transitionMutationStarted && !validationStarted)");
    const failureEvent = handler.indexOf('setWindowsNodeMxcLifecycleState("failed", detail)');
    expect(guardFailure).toBeGreaterThan(preparation);
    expect(failureEvent).toBeGreaterThan(guardFailure);
    expect(handler.slice(guardFailure, failureEvent)).toContain("throw error;");
  });

  it("blocks Gateway restart and generic config mutation before they can change Hooks state", () => {
    const source = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");
    const restartHandler = source.slice(
      source.indexOf('ipcMain.handle("gateway:restart"'),
      source.indexOf("// --- Config ---"),
    );
    const configWriteHandler = source.slice(
      source.indexOf('ipcMain.handle("config:write"'),
      source.indexOf("// --- Skills ---"),
    );
    const restartGuard = restartHandler.indexOf("assertWindowsNodeMxcConfigurationMutable()");
    const restartMutation = restartHandler.indexOf("restartManagedGateway");
    const configGuard = configWriteHandler.indexOf("isWindowsNodeMxcDesired()");
    const configMutation = configWriteHandler.indexOf("fs.writeFileSync");

    expect(restartGuard).toBeGreaterThan(-1);
    expect(restartMutation).toBeGreaterThan(restartGuard);
    expect(configGuard).toBeGreaterThan(-1);
    expect(configMutation).toBeGreaterThan(configGuard);
    expect(configWriteHandler).toContain(
      "config:write is blocked while Windows Node + MXC mode is enabled",
    );
  });

  it("keeps an in-progress MXC lifecycle alive across renderer loss", () => {
    const source = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");
    const createWindow = source.slice(
      source.indexOf("function createMainWindow()"),
      source.indexOf(
        "// ---------------------------------------------------------------------------\n// Gateway management",
      ),
    );
    const applyHandler = source.slice(
      source.indexOf('"windows-node-mxc:apply-folder-policy"'),
      source.indexOf("// App lifecycle"),
    );
    const applyFolders = source.slice(
      source.indexOf("async function applyRunningWindowsNodeMxcFolders("),
      source.indexOf(
        "async function ",
        source.indexOf("async function applyRunningWindowsNodeMxcFolders(") + 1,
      ),
    );
    const appLifecycle = source.slice(source.indexOf('app.on("window-all-closed"'));

    expect(createWindow).toContain('win.on("close"');
    expect(createWindow).toContain("shouldPreventWindowClose(lifecycleWindowState())");
    expect(createWindow).toContain('win.webContents.on("render-process-gone"');
    expect(createWindow).toContain("scheduleMainWindowRecovery");
    expect(appLifecycle).toContain("shouldQuitAfterAllWindowsClosed(process.platform, state)");
    expect(appLifecycle).toContain('electronLifecycleDiagnostics.log("before-quit")');
    expect(appLifecycle).toContain("closeWindowsNodeMxcIngress()");
    expect(appLifecycle).toContain("bundledWindowsNodeHost.revokeActivationLease()");
    expect(appLifecycle).toContain('stopGatewayProcessGracefully("Application quit")');
    expect(appLifecycle).toContain("event.preventDefault()");
    expect(appLifecycle).toContain("if (applicationQuitReady) return");
    expect(appLifecycle).not.toContain("stopGatewayProcess()");
    expect(applyHandler).toContain("assertTrustedRendererIpc(event)");
    expect(applyHandler).toContain("return applyRunningWindowsNodeMxcFolders(draft)");
    expect(applyFolders).toContain("return windowsNodeMxcLifecycleOperations.run(");
    expect(applyFolders).toContain('{ kind: "apply-folder-policy" }');
  });
});
