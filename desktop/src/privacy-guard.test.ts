import { describe, expect, it } from "vitest";
import {
  isPathWithinDirectories,
  shouldRejectStrictFilePermission,
  shouldRejectStrictRuntimeGrant,
} from "./privacy-guard";

describe("privacy guard", () => {
  it("recognizes exact and nested whitelist paths without accepting siblings", () => {
    const directories = ["C:\\allowed", "D:\\read-only"];

    expect(isPathWithinDirectories("C:\\allowed", directories)).toBe(true);
    expect(isPathWithinDirectories("C:\\allowed\\nested\\file.txt", directories)).toBe(true);
    expect(isPathWithinDirectories("C:\\allowed-sibling\\file.txt", directories)).toBe(false);
    expect(isPathWithinDirectories("C:\\allowed\\..\\outside\\file.txt", directories)).toBe(false);
    expect(isPathWithinDirectories("D:\\read-only\\report.txt", directories)).toBe(true);
  });

  it("allows only sensitive-file confirmation inside the Strict whitelist", () => {
    const directories = ["C:\\allowed"];

    expect(
      shouldRejectStrictFilePermission(
        "strict",
        "sensitive-file",
        "C:\\allowed\\.env",
        directories,
      ),
    ).toBe(false);
    expect(
      shouldRejectStrictFilePermission(
        "strict",
        "sensitive-file",
        "C:\\outside\\.env",
        directories,
      ),
    ).toBe(true);
    expect(
      shouldRejectStrictFilePermission(
        "strict",
        "directory-access",
        "C:\\allowed\\report.txt",
        directories,
      ),
    ).toBe(true);
    expect(
      shouldRejectStrictFilePermission(
        "balanced",
        "directory-access",
        "C:\\outside\\report.txt",
        directories,
      ),
    ).toBe(false);
  });

  it("disables runtime directory grants only in Strict mode", () => {
    expect(shouldRejectStrictRuntimeGrant("basic")).toBe(false);
    expect(shouldRejectStrictRuntimeGrant("balanced")).toBe(false);
    expect(shouldRejectStrictRuntimeGrant("strict")).toBe(true);
  });
});
