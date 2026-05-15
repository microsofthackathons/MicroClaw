/**
 * Tests for sensitive-shield.ts — standalone shield orchestration module.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";

// Save and mock USERPROFILE before importing the module
const FAKE_HOME = "C:\\Users\\testuser";
const originalEnv = { ...process.env };

beforeEach(() => {
  process.env.USERPROFILE = FAKE_HOME;
});

afterEach(() => {
  process.env = { ...originalEnv };
});

// Import after env setup — shouldShield reads USERPROFILE at call time
import { shouldShield, DEFAULT_SENSITIVE_DIRS } from "./sensitive-shield";

// ── shouldShield ──

describe("shouldShield", () => {
  it("returns true for the home directory itself", () => {
    expect(shouldShield(FAKE_HOME)).toBe(true);
    expect(shouldShield("C:\\Users\\testuser")).toBe(true);
    expect(shouldShield("C:\\Users\\testuser\\")).toBe(true);
  });

  it("returns true for parent of home (e.g. C:\\Users)", () => {
    expect(shouldShield("C:\\Users")).toBe(true);
    expect(shouldShield("C:\\")).toBe(true);
  });

  it("returns false for subdirectory of home", () => {
    expect(shouldShield("C:\\Users\\testuser\\Documents")).toBe(false);
    expect(shouldShield("C:\\Users\\testuser\\.openclaw")).toBe(false);
  });

  it("returns false for unrelated directory", () => {
    expect(shouldShield("D:\\projects")).toBe(false);
    expect(shouldShield("C:\\MyData")).toBe(false);
  });

  it("returns false for a different user's home", () => {
    expect(shouldShield("C:\\Users\\otheruser")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(shouldShield("c:\\users\\TESTUSER")).toBe(true);
    expect(shouldShield("C:\\USERS")).toBe(true);
  });
});

// ── DEFAULT_SENSITIVE_DIRS ──

describe("DEFAULT_SENSITIVE_DIRS", () => {
  it("contains all expected sensitive directories", () => {
    expect(DEFAULT_SENSITIVE_DIRS).toContain(".ssh");
    expect(DEFAULT_SENSITIVE_DIRS).toContain(".gnupg");
    expect(DEFAULT_SENSITIVE_DIRS).toContain(".aws");
    expect(DEFAULT_SENSITIVE_DIRS).toContain(".azure");
    expect(DEFAULT_SENSITIVE_DIRS).toContain(path.join(".config", "gcloud"));
  });

  it("has exactly 5 entries", () => {
    expect(DEFAULT_SENSITIVE_DIRS).toHaveLength(5);
  });
});
