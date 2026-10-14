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

  it("stops the standard Gateway before Off-to-MXC containment preflight", () => {
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
    expect(gatewayStop).toBeGreaterThan(suspensionBranch);
    expect(preflight).toBeGreaterThan(gatewayStop);
    expect(handler).toContain("Restoring standard Gateway after MXC preflight failure");
  });
});
