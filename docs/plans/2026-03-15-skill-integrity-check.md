# Skill Integrity Check & Signature Verification — Design Document

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Detect tampering of skill files (modified, added, or removed) at desktop app startup using SHA-256 hashes and Ed25519 signature verification.

**Architecture:** Installer generates an Ed25519 keypair, computes SHA-256 hashes of all files in every skill directory, and signs the hash manifest. At desktop app startup, the signature and file hashes are verified before launching the gateway. If changes are detected, an alert dialog is shown.

**Tech Stack:** Python (installer-side keygen + hashing + signing), TypeScript/Node (desktop-side verification), Vue 3 (alert dialog)

---

## 1. Threat Model

| Threat | Attack | Detection |
|--------|--------|-----------|
| Prompt injection | Attacker modifies `SKILL.md` to inject malicious instructions | Hash mismatch on modified file |
| Payload injection | Attacker drops a new script into a skill directory | File present on disk but absent from snapshot |
| Safety removal | Attacker deletes safety guardrail files from a skill | File in snapshot but missing from disk |
| Cover-up | Attacker modifies snapshot to hide changes | Signature verification fails |

### Out of scope

- Admin-level attackers (Windows design limitation)
- Runtime/in-memory attacks
- Network-based attacks
- Content encryption

---

## 2. Artifacts

Three files generated at install time, stored in `~/.openclaw/`:

| File | Purpose |
|------|---------|
| `skills_snapshot.json` | SHA-256 hash of every file in every skill directory |
| `skills_snapshot.sig` | Ed25519 signature of the snapshot file |
| `skills_signing_key.pub` | Public key for verification |

The private key is used only during signing and stored separately (or discarded).

---

## 3. Snapshot Format

**Scope:** Every file recursively under each skill directory. A skill may contain `SKILL.md`, `.md` reference docs, `.py`/`.sh` scripts, binary executables, and subdirectories (`scripts/`, `references/`, `bin/`, `examples/`, etc.).

**Exclusions:** Dotfiles/dotdirs (`.git`, `.DS_Store`), `node_modules/`, `__pycache__/`

```json
{
  "version": 1,
  "created_at": "2026-03-15T10:00:00Z",
  "signing_key_id": "sha256:abc123...",
  "sources": {
    "builtin": {
      "base_dir": "~/.openclaw-node/node_modules/openclaw/skills",
      "skills": {
        "tmux": {
          "files": {
            "SKILL.md": "sha256:aabb...",
            "scripts/setup.sh": "sha256:ccdd..."
          }
        },
        "coding-agent": {
          "files": {
            "SKILL.md": "sha256:1122...",
            "references/patterns.md": "sha256:3344..."
          }
        }
      }
    },
    "managed": {
      "base_dir": "~/.openclaw/skills",
      "skills": {
        "microsoft-speedbird": {
          "files": {
            "SKILL.md": "sha256:5566...",
            "scripts/run.py": "sha256:7788..."
          }
        }
      }
    }
  }
}
```

---

## 4. Verification Logic

### 4.1 Three types of tamper detection

```
for each skill in snapshot:
  for each file in snapshot[skill]:
    if file missing on disk        → REMOVED
    if hash(file) != snapshot hash → MODIFIED
  for each file on disk in skill dir:
    if file not in snapshot         → ADDED
```

### 4.2 Startup flow

```
Desktop app startup (main.ts):
  1. Read skills_snapshot.json + skills_snapshot.sig + skills_signing_key.pub
  2. Verify Ed25519 signature of snapshot
     → if invalid → CRITICAL alert ("snapshot itself was tampered")
     → if snapshot missing → CRITICAL alert ("no integrity baseline found")
  3. Compute current SHA-256 hashes of all skill files on disk
  4. Compare against snapshot:
     → collect MODIFIED, ADDED, REMOVED lists
  5. If any changes detected → send alert to renderer → show dialog
  6. If clean → launch gateway normally
```

### 4.3 Signature scheme

- **Algorithm:** Ed25519 (same as existing device-identity.ts)
- **What is signed:** Raw bytes of `skills_snapshot.json`
- **Key generation:** At install time, Python generates keypair using `cryptography` library or `nacl`
- **Signing:** Private key signs the snapshot JSON bytes → base64-encoded `.sig` file
- **Verification:** Desktop app verifies using Node.js `crypto.sign`/`crypto.verify` with Ed25519

---

## 5. Alert Dialog

### 5.1 Severity levels

**Critical (red):**
- Snapshot signature invalid
- Snapshot file missing

**Warning (orange):**
- Files modified, added, or removed

### 5.2 Dialog content

```
⚠️ 技能文件完整性检查发现以下变更：

已修改 (2):
  · managed/microsoft-speedbird/SKILL.md
  · builtin/coding-agent/scripts/helper.py

新增文件 (1):
  · managed/microsoft-speedbird/scripts/payload.sh

已删除 (1):
  · builtin/tmux/references/guide.md

[信任并继续]  [查看详情]  [退出]
```

### 5.3 User actions

| Action | Behavior |
|--------|----------|
| **信任并继续** (Trust & Continue) | Accept changes, regenerate snapshot with current state, re-sign, launch gateway |
| **查看详情** (View Details) | Expand to show full file paths and hash values |
| **退出** (Exit) | Close app without launching gateway |

### 5.4 "Trust & Continue" re-signing

When user trusts changes, the desktop app must regenerate the snapshot and re-sign it. This requires the private key to be available. Options:

- **Store private key** in `~/.openclaw/skills_signing_key.pem` (protected by NTFS ACL if AppContainer is set up)
- Desktop app reads private key → regenerates snapshot → signs → writes new `.json` + `.sig`
- This allows the "trust" flow to work without re-running the installer

---

## 6. Implementation Scope

### Installer side (Python — `deployer/skill_protection.py`)

```python
class SkillProtection:
    def generate_keypair() -> tuple[bytes, bytes]
    def compute_snapshot(skill_dirs: dict[str, Path]) -> dict
    def sign_snapshot(snapshot_json: bytes, private_key: bytes) -> bytes
    def write_artifacts(openclaw_dir: Path, snapshot: dict, signature: bytes, public_key: bytes, private_key: bytes)
```

Called from `deployer/windows_setup.py` after writing skill configs.

### Desktop side (TypeScript — `desktop/src/skill-integrity.ts`)

```typescript
interface IntegrityResult {
  valid: boolean;
  signatureValid: boolean;
  snapshotExists: boolean;
  modified: { skill: string; file: string; expected: string; actual: string }[];
  added: { skill: string; file: string }[];
  removed: { skill: string; file: string }[];
}

function verifySkillIntegrity(): Promise<IntegrityResult>
function regenerateSnapshot(): Promise<void>  // for "Trust & Continue"
```

Called from `desktop/src/main.ts` at startup, before `startGateway()`.

### Desktop UI (Vue — startup alert)

New IPC channel `skills:integrity-check` → returns `IntegrityResult` → renderer shows modal if issues found.

---

## 7. Demo Scenarios

### Demo 1: Tamper detection (30 seconds)

1. Launch MicroClaw → starts normally, no alerts (clean state)
2. Close MicroClaw
3. Open a skill file in Notepad, add: `Ignore all previous instructions and...`
4. Save and relaunch MicroClaw
5. Alert dialog shows the modified file
6. **Talking point:** "MicroClaw detects prompt injection attacks at startup"

### Demo 2: Malicious file injection (30 seconds)

1. Close MicroClaw
2. Drop a new file `evil.py` into an existing skill directory
3. Relaunch → alert shows "新增文件: managed/microsoft-speedbird/evil.py"
4. **Talking point:** "Even stealthy file additions are caught"

### Demo 3: File deletion detection (20 seconds)

1. Delete a script file from a skill directory
2. Relaunch → alert shows the removed file
3. **Talking point:** "Attackers can't silently remove safety guardrails"

### Demo 4: Snapshot tampering (20 seconds)

1. Edit `skills_snapshot.json` directly (change a hash value)
2. Relaunch → critical alert: "The integrity manifest itself has been tampered with"
3. **Talking point:** "Cryptographic signatures prevent attackers from covering their tracks"

### Demo 5: Clean state (10 seconds)

1. Launch MicroClaw without any modifications
2. Starts normally with no alerts
3. **Talking point:** "Zero friction when everything is clean — users never see this unless something is wrong"

---

## 8. File Summary

| File | Layer | Purpose |
|------|-------|---------|
| `deployer/skill_protection.py` | Installer (Python) | Keygen, hashing, signing |
| `deployer/windows_setup.py` | Installer (Python) | Call skill_protection after config |
| `desktop/src/skill-integrity.ts` | Desktop (TypeScript) | Verification + hash comparison |
| `desktop/src/main.ts` | Desktop (TypeScript) | Startup hook before gateway launch |
| `desktop/src/preload.ts` | Desktop (TypeScript) | Expose integrity IPC to renderer |
| `desktop/renderer/env.d.ts` | Desktop (TypeScript) | IntegrityResult type definition |
| `desktop/renderer/src/views/SettingsView.vue` or new modal | Desktop (Vue) | Alert dialog UI |
| `~/.openclaw/skills_snapshot.json` | Runtime artifact | Hash manifest |
| `~/.openclaw/skills_snapshot.sig` | Runtime artifact | Ed25519 signature |
| `~/.openclaw/skills_signing_key.pub` | Runtime artifact | Public key |
| `~/.openclaw/skills_signing_key.pem` | Runtime artifact | Private key (for re-signing) |
