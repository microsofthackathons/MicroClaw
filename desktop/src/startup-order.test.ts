import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("desktop startup order", () => {
  it("starts application services after integrity verification without blocking renderer loading", () => {
    const source = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");
    const lifecycle = source.slice(
      source.indexOf("app.whenReady().then"),
      source.indexOf('app.on("window-all-closed"'),
    );

    const integrityIndex = lifecycle.indexOf("verifySkillIntegrity()");
    const servicesIndex = lifecycle.indexOf("startApplicationServices().catch");
    const rendererIndex = lifecycle.indexOf("await loadMainWindowRenderer(initialWindow)");

    expect(integrityIndex).toBeGreaterThan(-1);
    expect(servicesIndex).toBeGreaterThan(integrityIndex);
    expect(rendererIndex).toBeGreaterThan(servicesIndex);
    expect(lifecycle).not.toMatch(/await\s+startApplicationServices\(/);

    const serviceStart = source.indexOf("async function startApplicationServices()");
    expect(serviceStart).toBeGreaterThan(-1);
    const service = source.slice(serviceStart, source.indexOf("\n}", serviceStart) + 2);
    expect(service).toContain("await startGateway();");
  });

  it("stops the standard Gateway before Off-to-MXC preflight so paused ingress cannot race", () => {
    const source = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");
    const handler = source.slice(
      source.indexOf('ipcMain.handle(\n    "windows-node-mxc:set-enabled"'),
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
      source.indexOf('ipcMain.handle(\n    "windows-node-mxc:set-enabled"'),
      source.indexOf('"windows-node-mxc:approval-respond"'),
    );
    const confirmation = handler.indexOf("await planWeixinRemoteApprovalNativeTransition(");
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

    expect(confirmation).toBeGreaterThan(-1);
    expect(handler.indexOf("assertTrustedRendererIpc(event)")).toBeLessThan(confirmation);
    expect(handler.indexOf("assertNativeWeixinRemoteApprovalAuthority(params)")).toBeLessThan(
      handler.indexOf("windowsNodeMxcLifecycleOperations.acquire<"),
    );
    expect(handler).toContain(
      "readOptions: () => getWeixinRemoteApprovalActivationOptions(readConfig())",
    );
    expect(handler).toContain("selection: remoteApprovalSelection");
    expect(handler).not.toContain("params?.remoteApproval");
    expect(validating).toBeGreaterThan(confirmation);
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
      source.indexOf("// --- Sandbox capabilities ---"),
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
    expect(applyHandler).toContain("windowsNodeMxcLifecycleOperations.acquire");
    expect(applyHandler).toContain("lifecycleOperation.succeed(status)");
  });
});
