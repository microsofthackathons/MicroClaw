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
    const gatewayIndex = lifecycle.indexOf("startGateway().catch");
    const rendererIndex = lifecycle.indexOf("mainWindow.loadFile(indexPath)");

    expect(integrityIndex).toBeGreaterThan(-1);
    expect(gatewayIndex).toBeGreaterThan(integrityIndex);
    expect(rendererIndex).toBeGreaterThan(gatewayIndex);
  });
});
