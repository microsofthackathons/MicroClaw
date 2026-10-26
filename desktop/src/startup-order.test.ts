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
      source.indexOf('ipcMain.handle("windows-node-mxc:retry-readiness"'),
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
    expect(appLifecycle).toContain("stopGatewayProcess()");
    expect(applyHandler).toContain("windowsNodeMxcLifecycleOperations.acquire");
    expect(applyHandler).toContain("lifecycleOperation.succeed(status)");
  });
});
