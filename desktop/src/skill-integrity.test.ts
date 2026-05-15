import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
}));

import {
  generateAndSignSnapshot,
  verifySkillIntegrity,
  getSkillSourceDirs,
} from "./skill-integrity";

// ── Helpers ─────────────────────────────────────────────────────────────
function builtinSkillsDir(): string {
  return path.join(tmpHome, ".openclaw-node", "node_modules", "openclaw", "skills");
}
function managedSkillsDir(): string {
  return path.join(tmpHome, ".openclaw", "skills");
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
