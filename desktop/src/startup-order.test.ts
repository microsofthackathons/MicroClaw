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
    const rendererIndex = lifecycle.indexOf("mainWindow.loadFile(indexPath)");

    expect(integrityIndex).toBeGreaterThan(-1);
    expect(servicesIndex).toBeGreaterThan(integrityIndex);
    expect(rendererIndex).toBeGreaterThan(servicesIndex);
    expect(lifecycle).not.toMatch(/await\s+startApplicationServices\(/);

    const serviceStart = source.indexOf("async function startApplicationServices()");
    expect(serviceStart).toBeGreaterThan(-1);
    const service = source.slice(serviceStart, source.indexOf("\n}", serviceStart) + 2);
    expect(service).toContain("await startGateway();");
  });
});
