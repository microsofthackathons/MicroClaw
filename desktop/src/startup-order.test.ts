import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("desktop startup order", () => {
  it("starts the Gateway after integrity verification but before renderer loading", () => {
    const source = readFileSync(resolve(process.cwd(), "src/main.ts"), "utf8");
    const lifecycle = source.slice(
      source.indexOf("app.whenReady().then"),
      source.indexOf('app.on("window-all-closed"'),
    );

    const integrityIndex = lifecycle.indexOf("verifySkillIntegrity()");
    const gatewayIndex = lifecycle.indexOf("startApplicationServices().catch");
    const rendererIndex = lifecycle.indexOf("mainWindow.loadFile(indexPath)");

    expect(integrityIndex).toBeGreaterThan(-1);
    expect(gatewayIndex).toBeGreaterThan(integrityIndex);
    expect(rendererIndex).toBeGreaterThan(gatewayIndex);
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
});
