import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs";
import os from "os";
import path from "path";
import { createPublicKey, verify } from "crypto";

// ── Mock path-resolver: point state dir at a fresh tmp dir per test ──
let tmpStateDir = "";

vi.mock("./path-resolver", () => ({
  getOpenClawStateDir: () => tmpStateDir,
}));

import {
  loadOrCreateDeviceIdentity,
  signDevicePayload,
  buildDeviceAuthPayload,
} from "./device-identity";

// ── Setup / teardown ──────────────────────────────────────────────────
beforeEach(() => {
  tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "microclaw-devid-"));
});

afterEach(() => {
  if (tmpStateDir && fs.existsSync(tmpStateDir)) {
    fs.rmSync(tmpStateDir, { recursive: true, force: true });
  }
});

// ── loadOrCreateDeviceIdentity ────────────────────────────────────────
describe("loadOrCreateDeviceIdentity", () => {
  it("generates a new identity on first call and persists it", () => {
    const id = loadOrCreateDeviceIdentity();

    expect(id.deviceId).toMatch(/^[0-9a-f]{64}$/);
    expect(id.publicKey).toBeTypeOf("string");
    expect(id.privateKey).toBeTypeOf("string");

    const filePath = path.join(tmpStateDir, "device-identity.json");
    expect(fs.existsSync(filePath)).toBe(true);

    const saved = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(saved.version).toBe(1);
    expect(saved.deviceId).toBe(id.deviceId);
    expect(saved.publicKey).toBe(id.publicKey);
    expect(saved.privateKey).toBe(id.privateKey);
    expect(typeof saved.createdAtMs).toBe("number");
  });

  it("returns the same identity on subsequent calls (idempotent)", () => {
    const first = loadOrCreateDeviceIdentity();
    const second = loadOrCreateDeviceIdentity();
    expect(second).toEqual(first);
  });

  it("regenerates when the stored file is corrupt JSON", () => {
    const filePath = path.join(tmpStateDir, "device-identity.json");
    fs.writeFileSync(filePath, "{not valid json", "utf-8");

    const id = loadOrCreateDeviceIdentity();
    expect(id.deviceId).toMatch(/^[0-9a-f]{64}$/);

    // File should now be valid JSON
    const saved = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    expect(saved.version).toBe(1);
  });

  it("regenerates when stored JSON is missing required fields", () => {
    const filePath = path.join(tmpStateDir, "device-identity.json");
    fs.writeFileSync(filePath, JSON.stringify({ version: 1 }), "utf-8");

    const id = loadOrCreateDeviceIdentity();
    expect(id.deviceId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("regenerates when version is not 1", () => {
    const filePath = path.join(tmpStateDir, "device-identity.json");
    fs.writeFileSync(
      filePath,
      JSON.stringify({
        version: 999,
        deviceId: "x".repeat(64),
        publicKey: "AA",
        privateKey: "BB",
      }),
      "utf-8",
    );

    const id = loadOrCreateDeviceIdentity();
    // Regenerated → deviceId will not equal the placeholder above
    expect(id.deviceId).not.toBe("x".repeat(64));
  });

  it("derives deviceId from the stored public key on load", () => {
    // Create identity, then tamper with the deviceId field on disk
    const original = loadOrCreateDeviceIdentity();
    const filePath = path.join(tmpStateDir, "device-identity.json");
    const saved = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    saved.deviceId = "0".repeat(64); // lie about the id
    fs.writeFileSync(filePath, JSON.stringify(saved), "utf-8");

    const reloaded = loadOrCreateDeviceIdentity();
    // Should be re-derived from publicKey, not trust the tampered field
    expect(reloaded.deviceId).toBe(original.deviceId);
    expect(reloaded.deviceId).not.toBe("0".repeat(64));
  });

  it("creates the state directory if it does not exist", () => {
    // Remove tmp dir and point at a nested non-existent path
    fs.rmSync(tmpStateDir, { recursive: true, force: true });
    tmpStateDir = path.join(tmpStateDir, "nested", "dir");
    expect(fs.existsSync(tmpStateDir)).toBe(false);

    const id = loadOrCreateDeviceIdentity();
    expect(id.deviceId).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.existsSync(tmpStateDir)).toBe(true);
  });
});

// ── signDevicePayload ─────────────────────────────────────────────────
describe("signDevicePayload", () => {
  it("produces a base64url signature that verifies with the public key", () => {
    const id = loadOrCreateDeviceIdentity();
    const payload = "some|payload|to|sign";
    const sigB64 = signDevicePayload(id.privateKey, payload);

    expect(sigB64).toMatch(/^[A-Za-z0-9_-]+$/); // base64url
    const sig = Buffer.from(sigB64, "base64url");
    const rawPub = Buffer.from(id.publicKey, "base64url");

    // Reconstruct SPKI DER from raw 32-byte Ed25519 public key
    const spkiHeader = Buffer.from("302a300506032b6570032100", "hex");
    const spki = Buffer.concat([spkiHeader, rawPub]);
    const pubKeyObj = createPublicKey({ key: spki, format: "der", type: "spki" });

    const ok = verify(null, Buffer.from(payload, "utf-8"), pubKeyObj, sig);
    expect(ok).toBe(true);
  });

  it("produces different signatures for different payloads", () => {
    const id = loadOrCreateDeviceIdentity();
    const a = signDevicePayload(id.privateKey, "payload-a");
    const b = signDevicePayload(id.privateKey, "payload-b");
    expect(a).not.toBe(b);
  });

  it("produces identical signatures for the same payload (deterministic Ed25519)", () => {
    const id = loadOrCreateDeviceIdentity();
    const a = signDevicePayload(id.privateKey, "same");
    const b = signDevicePayload(id.privateKey, "same");
    expect(a).toBe(b);
  });
});

// ── buildDeviceAuthPayload ────────────────────────────────────────────
describe("buildDeviceAuthPayload", () => {
  const base = {
    deviceId: "deviceid",
    clientId: "clientid",
    clientMode: "desktop",
    role: "owner",
    scopes: ["chat", "tools"],
    signedAtMs: 1700000000000,
    token: "tok123",
    nonce: "nonce-abc",
  };

  it("joins fields with '|' in the documented order", () => {
    expect(buildDeviceAuthPayload(base)).toBe(
      "v2|deviceid|clientid|desktop|owner|chat,tools|1700000000000|tok123|nonce-abc",
    );
  });

  it("serializes null token as an empty string", () => {
    expect(buildDeviceAuthPayload({ ...base, token: null })).toBe(
      "v2|deviceid|clientid|desktop|owner|chat,tools|1700000000000||nonce-abc",
    );
  });

  it("joins scopes with comma", () => {
    const payload = buildDeviceAuthPayload({
      ...base,
      scopes: ["a", "b", "c"],
    });
    expect(payload).toContain("|a,b,c|");
  });

  it("handles empty scopes array", () => {
    const payload = buildDeviceAuthPayload({ ...base, scopes: [] });
    // Empty scopes → empty field between role and timestamp
    expect(payload).toContain("|owner||1700000000000|");
  });
});
