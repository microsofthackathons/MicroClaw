import path from "path";
import { pathToFileURL } from "url";
import { describe, expect, it } from "vitest";

import { isTrustedRendererUrl } from "./trusted-renderer-url";

describe("trusted renderer URL", () => {
  const packagedIndexPath = path.resolve("C:\\MicroClaw\\resources\\app\\renderer\\index.html");

  it("accepts only the exact development origin", () => {
    const options = {
      development: true,
      developmentUrl: "http://localhost:5173",
      packagedIndexPath,
    };
    expect(isTrustedRendererUrl("http://localhost:5173/settings", options)).toBe(true);
    expect(isTrustedRendererUrl("http://localhost.attacker.example/settings", options)).toBe(false);
    expect(isTrustedRendererUrl("http://localhost:5174/settings", options)).toBe(false);
    expect(isTrustedRendererUrl("https://localhost:5173/settings", options)).toBe(false);
  });

  it("accepts only the packaged renderer entry file", () => {
    const options = {
      development: false,
      developmentUrl: "http://localhost:5173",
      packagedIndexPath,
    };
    expect(isTrustedRendererUrl(`${pathToFileURL(packagedIndexPath).href}#/settings`, options)).toBe(
      true,
    );
    expect(
      isTrustedRendererUrl(pathToFileURL(path.resolve(path.dirname(packagedIndexPath), "evil.html")).href, options),
    ).toBe(false);
    expect(isTrustedRendererUrl("file:///C:/Users/Public/attacker.html", options)).toBe(false);
  });
});
