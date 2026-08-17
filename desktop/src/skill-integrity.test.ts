import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createPrivateKey, sign } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

// ── Fresh tmp dirs per test ─────────────────────────────────────────────
let tmpHome = "";
let tmpStateDir = "";

// ── Mocks (must be declared before importing the module under test) ────
vi.mock("electron", () => ({
  app: {
    getPath: (name: string) => {
      if (name === "home") return tmpHome;
      return "";
    },
  },
}));

vi.mock("./path-resolver", () => ({
  getOpenClawStateDir: () => tmpStateDir,
  resolveBuiltinSkillsDir: () => {
    const classic = path.join(tmpHome, ".openclaw-node", "node_modules", "openclaw", "skills");
    const lib = path.join(tmpHome, ".openclaw-node", "lib", "node_modules", "openclaw", "skills");
    return fs.existsSync(classic) ? classic : lib;
  },
}));

import {
  acceptManagedSkillIntegrityChanges,
  captureSkillIntegritySnapshotState,
  generateAndSignSnapshot,
  getSkillSourceDirs,
  isManagedSkillTrustedBySnapshot,
  migrateLegacySkillIntegritySnapshot,
  restoreSkillIntegritySnapshotState,
  verifySkillIntegrity,
} from "./skill-integrity";

// ── Helpers ─────────────────────────────────────────────────────────────
function builtinSkillsDir(): string {
  return path.join(tmpHome, ".openclaw-node", "node_modules", "openclaw", "skills");
}
function managedSkillsDir(): string {
  return path.join(tmpStateDir, "skills");
}

function writeFile(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf-8");
}

function seedSkill(baseDir: string, skillName: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    writeFile(path.join(baseDir, skillName, rel), content);
  }
}

function rewriteSnapshotAsLegacy(): void {
  const snapshotPath = path.join(tmpStateDir, "skills_snapshot.json");
  const signaturePath = path.join(tmpStateDir, "skills_snapshot.sig");
  const legacy = JSON.parse(fs.readFileSync(snapshotPath, "utf-8"));
  legacy.version = 1;
  delete legacy.sources.builtin.root_id;
  delete legacy.sources.managed.root_id;
  const legacyBytes = Buffer.from(JSON.stringify(legacy, null, 2), "utf-8");
  const privateKey = createPrivateKey({
    key: fs.readFileSync(path.join(tmpStateDir, "skills_signing_key.pem")),
    format: "der",
    type: "pkcs8",
  });
  fs.writeFileSync(snapshotPath, legacyBytes);
  fs.writeFileSync(signaturePath, sign(null, legacyBytes, privateKey));
}

// ── Setup / teardown ───────────────────────────────────────────────────
beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "microclaw-si-home-"));
  tmpStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "microclaw-si-state-"));
});

afterEach(() => {
  for (const dir of [tmpHome, tmpStateDir]) {
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── getSkillSourceDirs ─────────────────────────────────────────────────
describe("getSkillSourceDirs", () => {
  it("uses classic npm layout when it exists", () => {
    fs.mkdirSync(builtinSkillsDir(), { recursive: true });
    const dirs = getSkillSourceDirs();
    const builtin = dirs.find((d) => d.source === "builtin");
    expect(builtin?.baseDir).toBe(builtinSkillsDir());
  });

  it("falls back to lib/ layout when classic is absent", () => {
    const libLayout = path.join(
      tmpHome,
      ".openclaw-node",
      "lib",
      "node_modules",
      "openclaw",
      "skills",
    );
    fs.mkdirSync(libLayout, { recursive: true });
    const dirs = getSkillSourceDirs();
    const builtin = dirs.find((d) => d.source === "builtin");
    expect(builtin?.baseDir).toBe(libLayout);
  });

  it("always exposes the managed skills directory", () => {
    const dirs = getSkillSourceDirs();
    const managed = dirs.find((d) => d.source === "managed");
    expect(managed?.baseDir).toBe(managedSkillsDir());
  });
});

// ── Happy path: generate → verify ──────────────────────────────────────
describe("generateAndSignSnapshot + verifySkillIntegrity", () => {
  it("captures and restores the exact signed snapshot files", () => {
    seedSkill(builtinSkillsDir(), "alpha", { "SKILL.md": "content" });
    generateAndSignSnapshot();
    const original = captureSkillIntegritySnapshotState();
    expect(original.snapshot).not.toBeNull();
    expect(original.signature).not.toBeNull();

    seedSkill(managedSkillsDir(), "later", { "SKILL.md": "unrelated change" });
    generateAndSignSnapshot();
    restoreSkillIntegritySnapshotState(original);

    const restored = captureSkillIntegritySnapshotState();
    expect(restored.snapshot).toEqual(original.snapshot);
    expect(restored.signature).toEqual(original.signature);
    expect(verifySkillIntegrity().valid).toBe(false);
  });

  it("restores the absence of snapshot files", () => {
    const empty = captureSkillIntegritySnapshotState();
    expect(empty).toEqual({ snapshot: null, signature: null });
    seedSkill(builtinSkillsDir(), "alpha", { "SKILL.md": "content" });
    generateAndSignSnapshot();

    restoreSkillIntegritySnapshotState(empty);

    expect(verifySkillIntegrity().snapshotExists).toBe(false);
  });

  it("accepts changes only for the named managed skill", () => {
    seedSkill(managedSkillsDir(), "rednote-publisher", { "SKILL.md": "v1" });
    generateAndSignSnapshot();
    writeFile(path.join(managedSkillsDir(), "rednote-publisher", "SKILL.md"), "v2");

    acceptManagedSkillIntegrityChanges([
      {
        skillName: "rednote-publisher",
        expectedDirectory: path.join(managedSkillsDir(), "rednote-publisher"),
      },
    ]);

    expect(verifySkillIntegrity().valid).toBe(true);
  });

  it("refuses to rebaseline unrelated skill changes", () => {
    seedSkill(managedSkillsDir(), "rednote-publisher", { "SKILL.md": "v1" });
    seedSkill(managedSkillsDir(), "other", { "SKILL.md": "safe" });
    generateAndSignSnapshot();
    const baseline = captureSkillIntegritySnapshotState();
    writeFile(path.join(managedSkillsDir(), "rednote-publisher", "SKILL.md"), "v2");
    writeFile(path.join(managedSkillsDir(), "other", "SKILL.md"), "tampered");

    expect(() =>
      acceptManagedSkillIntegrityChanges([
        {
          skillName: "rednote-publisher",
          expectedDirectory: path.join(managedSkillsDir(), "rednote-publisher"),
        },
      ]),
    ).toThrow(/Unrelated skill integrity changes/);
    expect(captureSkillIntegritySnapshotState()).toEqual(baseline);
  });

  it("refuses to sign unexpected files inside the controlled skill", () => {
    const trusted = path.join(tmpHome, "trusted-rednote");
    seedSkill(managedSkillsDir(), "rednote-publisher", { "SKILL.md": "v1" });
    seedSkill(trusted, ".", { "SKILL.md": "v1" });
    generateAndSignSnapshot();
    writeFile(path.join(managedSkillsDir(), "rednote-publisher", ".injected"), "unapproved");

    expect(() =>
      acceptManagedSkillIntegrityChanges([
        { skillName: "rednote-publisher", expectedDirectory: trusted },
      ]),
    ).toThrow(/does not match the controlled lifecycle state/);
  });

  it("reports snapshotExists=false when no snapshot has been generated", () => {
    seedSkill(builtinSkillsDir(), "alpha", { "SKILL.md": "content" });

    const result = verifySkillIntegrity();
    expect(result.snapshotExists).toBe(false);
    expect(result.valid).toBe(true);
    expect(result.changes).toEqual([]);
  });

  it("writes snapshot, signature, and keypair files to the state dir", () => {
    seedSkill(builtinSkillsDir(), "alpha", { "SKILL.md": "hello" });

    generateAndSignSnapshot();

    expect(fs.existsSync(path.join(tmpStateDir, "skills_snapshot.json"))).toBe(true);
    expect(fs.existsSync(path.join(tmpStateDir, "skills_snapshot.sig"))).toBe(true);
    expect(fs.existsSync(path.join(tmpStateDir, "skills_signing_key.pub"))).toBe(true);
    expect(fs.existsSync(path.join(tmpStateDir, "skills_signing_key.pem"))).toBe(true);
  });

  it("writes root-aware version 2 snapshots", () => {
    seedSkill(builtinSkillsDir(), "alpha", { "SKILL.md": "hello" });
    generateAndSignSnapshot();

    const snapshot = JSON.parse(
      fs.readFileSync(path.join(tmpStateDir, "skills_snapshot.json"), "utf-8"),
    );

    expect(snapshot.version).toBe(2);
    expect(snapshot.sources.builtin.root_id).toBe("builtin-runtime");
    expect(snapshot.sources.managed.root_id).toBe("openclaw-state");
  });

  it("explicitly migrates a valid legacy snapshot", () => {
    seedSkill(builtinSkillsDir(), "alpha", { "SKILL.md": "hello" });
    seedSkill(managedSkillsDir(), "beta", { "SKILL.md": "managed" });
    generateAndSignSnapshot();
    const snapshotPath = path.join(tmpStateDir, "skills_snapshot.json");
    rewriteSnapshotAsLegacy();

    expect(migrateLegacySkillIntegritySnapshot()).toBe(true);
    expect(JSON.parse(fs.readFileSync(snapshotPath, "utf-8")).version).toBe(2);
    expect(verifySkillIntegrity().valid).toBe(true);
  });

  it("migrates a legacy snapshot after the builtin root relocates", () => {
    seedSkill(builtinSkillsDir(), "alpha", { "SKILL.md": "hello" });
    generateAndSignSnapshot();
    rewriteSnapshotAsLegacy();

    const relocated = path.join(
      tmpHome,
      ".openclaw-node",
      "lib",
      "node_modules",
      "openclaw",
      "skills",
    );
    seedSkill(relocated, "alpha", { "SKILL.md": "hello" });
    fs.rmSync(path.join(tmpHome, ".openclaw-node", "node_modules"), {
      recursive: true,
      force: true,
    });

    expect(migrateLegacySkillIntegritySnapshot()).toBe(true);
    expect(verifySkillIntegrity()).toMatchObject({
      valid: true,
      signatureValid: true,
      snapshotExists: true,
    });
  });

  it("trusts only exact managed skill contents from the signed snapshot", () => {
    const skillDirectory = path.join(managedSkillsDir(), "rednote-publisher");
    seedSkill(managedSkillsDir(), "rednote-publisher", { "SKILL.md": "v1" });
    generateAndSignSnapshot();

    expect(isManagedSkillTrustedBySnapshot("rednote-publisher", skillDirectory)).toBe(true);
    writeFile(path.join(skillDirectory, ".injected"), "unexpected");
    expect(isManagedSkillTrustedBySnapshot("rednote-publisher", skillDirectory)).toBe(false);
  });

  it("verifies cleanly immediately after generating", () => {
    seedSkill(builtinSkillsDir(), "alpha", {
      "SKILL.md": "# Alpha",
      "scripts/run.js": "console.log(1);",
    });
    seedSkill(managedSkillsDir(), "beta", { "_meta.json": "{}" });

    generateAndSignSnapshot();
    const result = verifySkillIntegrity();

    expect(result.signatureValid).toBe(true);
    expect(result.snapshotExists).toBe(true);
    expect(result.valid).toBe(true);
    expect(result.changes).toEqual([]);
  });

  it("reuses an existing keypair on repeated snapshot generation", () => {
    seedSkill(builtinSkillsDir(), "alpha", { "SKILL.md": "hello" });

    generateAndSignSnapshot();
    const pub1 = fs.readFileSync(path.join(tmpStateDir, "skills_signing_key.pub"));
    const priv1 = fs.readFileSync(path.join(tmpStateDir, "skills_signing_key.pem"));

    generateAndSignSnapshot();
    const pub2 = fs.readFileSync(path.join(tmpStateDir, "skills_signing_key.pub"));
    const priv2 = fs.readFileSync(path.join(tmpStateDir, "skills_signing_key.pem"));

    expect(pub1.equals(pub2)).toBe(true);
    expect(priv1.equals(priv2)).toBe(true);
  });
});

// ── Change detection ───────────────────────────────────────────────────
describe("verifySkillIntegrity — change detection", () => {
  beforeEach(() => {
    seedSkill(builtinSkillsDir(), "alpha", {
      "SKILL.md": "# alpha",
      "scripts/run.js": "console.log('alpha');",
    });
    generateAndSignSnapshot();
  });

  it("detects a modified file", () => {
    writeFile(path.join(builtinSkillsDir(), "alpha", "SKILL.md"), "# TAMPERED");
    const result = verifySkillIntegrity();

    expect(result.valid).toBe(false);
    expect(result.signatureValid).toBe(true);
    expect(result.changes).toHaveLength(1);
    expect(result.changes[0]).toMatchObject({
      skill: "alpha",
      source: "builtin",
      file: "SKILL.md",
      type: "modified",
    });
    expect(result.changes[0].expected).toMatch(/^sha256:/);
    expect(result.changes[0].actual).toMatch(/^sha256:/);
    expect(result.changes[0].expected).not.toBe(result.changes[0].actual);
  });

  it("detects a removed file", () => {
    fs.unlinkSync(path.join(builtinSkillsDir(), "alpha", "SKILL.md"));
    const result = verifySkillIntegrity();

    expect(result.valid).toBe(false);
    const removed = result.changes.find((c) => c.type === "removed");
    expect(removed).toMatchObject({
      skill: "alpha",
      source: "builtin",
      file: "SKILL.md",
      type: "removed",
    });
  });

  it("detects an added file inside a tracked skill", () => {
    writeFile(path.join(builtinSkillsDir(), "alpha", "extra.txt"), "surprise");
    const result = verifySkillIntegrity();

    expect(result.valid).toBe(false);
    const added = result.changes.find((c) => c.type === "added");
    expect(added).toMatchObject({
      skill: "alpha",
      source: "builtin",
      file: "extra.txt",
      type: "added",
    });
    expect(added?.actual).toMatch(/^sha256:/);
  });

  it("detects an entirely new skill directory as added files", () => {
    seedSkill(builtinSkillsDir(), "gamma", { "SKILL.md": "brand new" });
    const result = verifySkillIntegrity();

    expect(result.valid).toBe(false);
    const added = result.changes.find((c) => c.skill === "gamma");
    expect(added).toMatchObject({
      skill: "gamma",
      source: "builtin",
      file: "SKILL.md",
      type: "added",
    });
  });
});

// ── Signature tampering ────────────────────────────────────────────────
describe("verifySkillIntegrity — signature failures", () => {
  beforeEach(() => {
    seedSkill(builtinSkillsDir(), "alpha", { "SKILL.md": "hello" });
    generateAndSignSnapshot();
  });

  it("returns signatureValid=false when the snapshot content is tampered", () => {
    const snapPath = path.join(tmpStateDir, "skills_snapshot.json");
    const original = fs.readFileSync(snapPath, "utf-8");
    // Mutate a hash inside the snapshot without re-signing
    fs.writeFileSync(snapPath, original.replace(/sha256:[0-9a-f]{4}/, "sha256:dead"), "utf-8");

    const result = verifySkillIntegrity();
    expect(result.signatureValid).toBe(false);
    expect(result.valid).toBe(false);
  });

  it("returns signatureValid=false when the signature file is missing", () => {
    fs.unlinkSync(path.join(tmpStateDir, "skills_snapshot.sig"));
    const result = verifySkillIntegrity();
    expect(result.signatureValid).toBe(false);
  });

  it("returns signatureValid=false when the public key file is missing", () => {
    fs.unlinkSync(path.join(tmpStateDir, "skills_signing_key.pub"));
    const result = verifySkillIntegrity();
    expect(result.signatureValid).toBe(false);
  });

  it("returns signatureValid=false when the signature bytes are corrupted", () => {
    const sigPath = path.join(tmpStateDir, "skills_snapshot.sig");
    const sig = fs.readFileSync(sigPath);
    sig[0] ^= 0xff; // flip bits in first byte
    fs.writeFileSync(sigPath, sig);

    const result = verifySkillIntegrity();
    expect(result.signatureValid).toBe(false);
  });
});

// ── Excluded names ─────────────────────────────────────────────────────
describe("verifySkillIntegrity — excluded files/dirs", () => {
  it("ignores node_modules, __pycache__, and dotfiles in skills", () => {
    seedSkill(builtinSkillsDir(), "alpha", {
      "SKILL.md": "x",
      "node_modules/lib/index.js": "should be ignored",
      "__pycache__/foo.pyc": "ignored",
      ".DS_Store": "ignored",
      ".hidden/file.txt": "ignored",
    });

    generateAndSignSnapshot();

    // After snapshot, adding more files in excluded dirs must still verify clean
    writeFile(path.join(builtinSkillsDir(), "alpha", "node_modules", "lib", "new.js"), "x");
    writeFile(path.join(builtinSkillsDir(), "alpha", ".hidden", "new.txt"), "x");

    const result = verifySkillIntegrity();
    expect(result.valid).toBe(true);
    expect(result.changes).toEqual([]);
  });

  it("ignores dotfile-prefixed skill directories at the top level", () => {
    fs.mkdirSync(builtinSkillsDir(), { recursive: true });
    seedSkill(builtinSkillsDir(), "alpha", { "SKILL.md": "x" });
    seedSkill(builtinSkillsDir(), ".cache", { "junk.txt": "ignored" });

    generateAndSignSnapshot();
    const result = verifySkillIntegrity();
    expect(result.valid).toBe(true);
  });
});
