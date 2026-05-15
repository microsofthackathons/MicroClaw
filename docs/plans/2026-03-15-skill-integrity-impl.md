# Skill Integrity Check — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Detect tampering of skill files at desktop app startup using SHA-256 hashes and Ed25519 signatures, showing an alert dialog if changes are found.

**Architecture:** Everything runs in the desktop app (TypeScript). On first launch (or when no snapshot exists), generate an Ed25519 keypair, compute SHA-256 hashes of all skill files, sign the manifest, and persist. On subsequent launches, verify signature then compare hashes. If changes detected, show alert dialog before launching gateway. Reuses existing patterns from `device-identity.ts`.

**Tech Stack:** TypeScript (Node.js `crypto` module), Vue 3 (Element Plus)

---

### Task 1: Create skill-integrity.ts — hash computation and snapshot generation

**Files:**
- Create: `desktop/src/skill-integrity.ts`

**Step 1: Create the module with types, constants, and hash helpers**

```typescript
/**
 * Skill integrity verification — SHA-256 hashing + Ed25519 signing.
 *
 * On first launch, generates a keypair and baseline snapshot of all skill files.
 * On subsequent launches, verifies snapshot signature and compares file hashes.
 */

import { createHash, generateKeyPairSync, sign, verify, createPrivateKey, createPublicKey } from "crypto";
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";

// ── Types ──

export interface SkillFileHashes {
  [relativePath: string]: string;  // path → "sha256:<hex>"
}

export interface SkillSnapshot {
  version: number;
  created_at: string;
  signing_key_id: string;
  sources: {
    [source: string]: {
      base_dir: string;
      skills: {
        [skillId: string]: {
          files: SkillFileHashes;
        };
      };
    };
  };
}

export interface IntegrityChange {
  skill: string;
  source: string;
  file: string;
  type: "modified" | "added" | "removed";
  expected?: string;
  actual?: string;
}

export interface IntegrityResult {
  valid: boolean;
  signatureValid: boolean;
  snapshotExists: boolean;
  changes: IntegrityChange[];
}

// ── Constants ──

const SNAPSHOT_FILE = "skills_snapshot.json";
const SIGNATURE_FILE = "skills_snapshot.sig";
const PUBLIC_KEY_FILE = "skills_signing_key.pub";
const PRIVATE_KEY_FILE = "skills_signing_key.pem";

const EXCLUDED_NAMES = new Set([
  ".git", ".DS_Store", ".gitignore", "node_modules", "__pycache__",
  ".mypy_cache", ".cache", "Thumbs.db",
]);

function getStateDir(): string {
  if (process.env.OPENCLAW_STATE_DIR) return process.env.OPENCLAW_STATE_DIR;
  const homeDir = path.join(app.getPath("home"), ".openclaw");
  if (fs.existsSync(path.join(homeDir, "openclaw.json"))) return homeDir;
  return path.join(app.getPath("appData"), "openclaw");
}

// ── Hash helpers ──

function sha256File(filePath: string): string {
  const data = fs.readFileSync(filePath);
  return "sha256:" + createHash("sha256").update(data).digest("hex");
}

function isExcluded(name: string): boolean {
  return name.startsWith(".") || EXCLUDED_NAMES.has(name);
}

/**
 * Recursively hash all files in a directory. Returns map of
 * relative paths (forward slashes) to "sha256:<hex>" strings.
 */
function hashDirectory(dirPath: string): SkillFileHashes {
  const hashes: SkillFileHashes = {};
  function walk(current: string, prefix: string) {
    if (!fs.existsSync(current)) return;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (isExcluded(entry.name)) continue;
      const fullPath = path.join(current, entry.name);
      const relPath = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(fullPath, relPath);
      } else if (entry.isFile()) {
        hashes[relPath] = sha256File(fullPath);
      }
    }
  }
  walk(dirPath, "");
  return hashes;
}
```

**Step 2: Add keygen and signing functions**

```typescript
// ── Keypair management ──

interface SigningKeys {
  publicKeyDer: Buffer;
  privateKeyDer: Buffer;
  keyId: string;
}

function generateSigningKeys(): SigningKeys {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  });
  const keyId = "sha256:" + createHash("sha256").update(publicKey as Buffer).digest("hex").slice(0, 16);
  return { publicKeyDer: publicKey as Buffer, privateKeyDer: privateKey as Buffer, keyId };
}

function signData(data: Buffer, privateKeyDer: Buffer): Buffer {
  const keyObj = createPrivateKey({ key: privateKeyDer, format: "der", type: "pkcs8" });
  return sign(null, data, keyObj);
}

function verifySignature(data: Buffer, signature: Buffer, publicKeyDer: Buffer): boolean {
  try {
    const keyObj = createPublicKey({ key: publicKeyDer, format: "der", type: "spki" });
    return verify(null, data, keyObj, signature);
  } catch {
    return false;
  }
}
```

**Step 3: Add snapshot build function**

```typescript
// ── Snapshot generation ──

function getSkillDirs(): { source: string; baseDir: string }[] {
  const homeDir = app.getPath("home");
  return [
    { source: "builtin", baseDir: path.join(homeDir, ".openclaw-node", "node_modules", "openclaw", "skills") },
    { source: "managed", baseDir: path.join(homeDir, ".openclaw", "skills") },
  ];
}

function buildSnapshot(keyId: string): SkillSnapshot {
  const snapshot: SkillSnapshot = {
    version: 1,
    created_at: new Date().toISOString(),
    signing_key_id: keyId,
    sources: {},
  };

  for (const { source, baseDir } of getSkillDirs()) {
    const skills: SkillSnapshot["sources"][string]["skills"] = {};
    if (fs.existsSync(baseDir)) {
      for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || isExcluded(entry.name)) continue;
        const skillDir = path.join(baseDir, entry.name);
        const files = hashDirectory(skillDir);
        if (Object.keys(files).length > 0) {
          skills[entry.name] = { files };
        }
      }
    }
    snapshot.sources[source] = { base_dir: baseDir, skills };
  }

  return snapshot;
}
```

**Step 4: Commit**

```
feat: add skill-integrity.ts with hash computation and snapshot generation
```

---

### Task 2: Add verification and persistence to skill-integrity.ts

**Files:**
- Modify: `desktop/src/skill-integrity.ts`

**Step 1: Add the verify function**

```typescript
// ── Verification ──

export function verifySkillIntegrity(): IntegrityResult {
  const stateDir = getStateDir();
  const snapshotPath = path.join(stateDir, SNAPSHOT_FILE);
  const sigPath = path.join(stateDir, SIGNATURE_FILE);
  const pubKeyPath = path.join(stateDir, PUBLIC_KEY_FILE);

  // Check snapshot exists
  if (!fs.existsSync(snapshotPath) || !fs.existsSync(sigPath) || !fs.existsSync(pubKeyPath)) {
    return { valid: true, signatureValid: true, snapshotExists: false, changes: [] };
  }

  // Verify signature
  const snapshotData = fs.readFileSync(snapshotPath);
  const signature = fs.readFileSync(sigPath);
  const publicKeyDer = fs.readFileSync(pubKeyPath);

  const signatureValid = verifySignature(snapshotData, signature, publicKeyDer);
  if (!signatureValid) {
    return { valid: false, signatureValid: false, snapshotExists: true, changes: [] };
  }

  // Parse snapshot and compare
  const snapshot: SkillSnapshot = JSON.parse(snapshotData.toString("utf-8"));
  const changes: IntegrityChange[] = [];

  for (const [source, sourceData] of Object.entries(snapshot.sources)) {
    const baseDir = sourceData.base_dir;

    // Check each skill in snapshot
    for (const [skillId, skillData] of Object.entries(sourceData.skills)) {
      const skillDir = path.join(baseDir, skillId);

      // Check files in snapshot against disk
      for (const [relPath, expectedHash] of Object.entries(skillData.files)) {
        const fullPath = path.join(skillDir, ...relPath.split("/"));
        if (!fs.existsSync(fullPath)) {
          changes.push({ skill: skillId, source, file: relPath, type: "removed", expected: expectedHash });
        } else {
          const actualHash = sha256File(fullPath);
          if (actualHash !== expectedHash) {
            changes.push({ skill: skillId, source, file: relPath, type: "modified", expected: expectedHash, actual: actualHash });
          }
        }
      }

      // Check for added files on disk not in snapshot
      if (fs.existsSync(skillDir)) {
        const currentFiles = hashDirectory(skillDir);
        for (const relPath of Object.keys(currentFiles)) {
          if (!(relPath in skillData.files)) {
            changes.push({ skill: skillId, source, file: relPath, type: "added", actual: currentFiles[relPath] });
          }
        }
      }
    }

    // Check for entirely new skills on disk not in snapshot
    if (fs.existsSync(baseDir)) {
      for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || isExcluded(entry.name)) continue;
        if (!(entry.name in sourceData.skills)) {
          const files = hashDirectory(path.join(baseDir, entry.name));
          for (const relPath of Object.keys(files)) {
            changes.push({ skill: entry.name, source, file: relPath, type: "added", actual: files[relPath] });
          }
        }
      }
    }
  }

  return {
    valid: changes.length === 0,
    signatureValid: true,
    snapshotExists: true,
    changes,
  };
}
```

**Step 2: Add the generate/regenerate function**

```typescript
// ── Snapshot persistence ──

export function generateAndSignSnapshot(): void {
  const stateDir = getStateDir();
  fs.mkdirSync(stateDir, { recursive: true });

  const pubKeyPath = path.join(stateDir, PUBLIC_KEY_FILE);
  const privKeyPath = path.join(stateDir, PRIVATE_KEY_FILE);

  let keys: SigningKeys;

  // Reuse existing keypair if available (for re-signing after "Trust & Continue")
  if (fs.existsSync(pubKeyPath) && fs.existsSync(privKeyPath)) {
    const publicKeyDer = fs.readFileSync(pubKeyPath);
    const privateKeyDer = fs.readFileSync(privKeyPath);
    const keyId = "sha256:" + createHash("sha256").update(publicKeyDer).digest("hex").slice(0, 16);
    keys = { publicKeyDer, privateKeyDer, keyId };
  } else {
    keys = generateSigningKeys();
    fs.writeFileSync(pubKeyPath, keys.publicKeyDer);
    fs.writeFileSync(privKeyPath, keys.privateKeyDer);
  }

  const snapshot = buildSnapshot(keys.keyId);
  const snapshotJson = Buffer.from(JSON.stringify(snapshot, null, 2), "utf-8");
  const signature = signData(snapshotJson, keys.privateKeyDer);

  fs.writeFileSync(path.join(stateDir, SNAPSHOT_FILE), snapshotJson);
  fs.writeFileSync(path.join(stateDir, SIGNATURE_FILE), signature);
}
```

**Step 3: Commit**

```
feat: add integrity verification and snapshot persistence
```

---

### Task 3: Hook integrity check into desktop app startup

**Files:**
- Modify: `desktop/src/main.ts` (around line 164, before `startGateway`)
- Modify: `desktop/renderer/env.d.ts` (add IPC types)
- Modify: `desktop/src/preload.ts` (expose IPC)

**Step 1: Add IPC handlers in main.ts**

After the existing imports (line 7), add:

```typescript
import { verifySkillIntegrity, generateAndSignSnapshot, type IntegrityResult } from "./skill-integrity";
```

Add IPC handlers (after the `skills:update-managed-entries` handler):

```typescript
ipcMain.handle("skills:integrity-check", (): IntegrityResult => {
  return verifySkillIntegrity();
});

ipcMain.handle("skills:generate-snapshot", () => {
  generateAndSignSnapshot();
});
```

**Step 2: Add startup integrity check before gateway launch**

In `main.ts`, the `app.whenReady()` callback calls `startGateway()`. Before that call, add integrity check logic:

```typescript
// Run integrity check — generate baseline on first launch
const integrityResult = verifySkillIntegrity();
if (!integrityResult.snapshotExists) {
  console.log("No skill integrity snapshot found — generating baseline...");
  generateAndSignSnapshot();
} else if (!integrityResult.valid) {
  // Store result for renderer to display alert
  pendingIntegrityResult = integrityResult;
}
```

Add a module-level variable:

```typescript
let pendingIntegrityResult: IntegrityResult | null = null;
```

Add an IPC handler for the renderer to fetch pending results:

```typescript
ipcMain.handle("skills:pending-integrity-result", (): IntegrityResult | null => {
  return pendingIntegrityResult;
});

ipcMain.handle("skills:accept-integrity-changes", () => {
  generateAndSignSnapshot();
  pendingIntegrityResult = null;
});
```

**Step 3: Update env.d.ts**

Add `IntegrityChange` and `IntegrityResult` interfaces:

```typescript
interface IntegrityChange {
  skill: string;
  source: string;
  file: string;
  type: "modified" | "added" | "removed";
  expected?: string;
  actual?: string;
}

interface IntegrityResult {
  valid: boolean;
  signatureValid: boolean;
  snapshotExists: boolean;
  changes: IntegrityChange[];
}
```

Add to `OpenClawAPI.skills`:

```typescript
integrityCheck(): Promise<IntegrityResult>;
pendingIntegrityResult(): Promise<IntegrityResult | null>;
acceptIntegrityChanges(): Promise<void>;
generateSnapshot(): Promise<void>;
```

**Step 4: Update preload.ts**

Add to the skills section:

```typescript
integrityCheck: () => ipcRenderer.invoke("skills:integrity-check"),
pendingIntegrityResult: () => ipcRenderer.invoke("skills:pending-integrity-result"),
acceptIntegrityChanges: () => ipcRenderer.invoke("skills:accept-integrity-changes"),
generateSnapshot: () => ipcRenderer.invoke("skills:generate-snapshot"),
```

**Step 5: Commit**

```
feat: hook integrity check into startup and expose IPC handlers
```

---

### Task 4: Add integrity alert dialog to the desktop UI

**Files:**
- Modify: `desktop/renderer/src/views/SettingsView.vue` (or create a new component)

**Step 1: Add integrity alert dialog**

This should be shown as a modal dialog that appears on app startup when integrity issues are detected. Add it in the main App component or SettingsView. The simplest approach is an Element Plus `el-dialog`.

Add to the `<script setup>` section:

```typescript
// ── Integrity check ──
const integrityDialogVisible = ref(false);
const integrityResult = ref<IntegrityResult | null>(null);
const integrityLoading = ref(false);

const modifiedChanges = computed(() =>
  integrityResult.value?.changes.filter(c => c.type === "modified") ?? []
);
const addedChanges = computed(() =>
  integrityResult.value?.changes.filter(c => c.type === "added") ?? []
);
const removedChanges = computed(() =>
  integrityResult.value?.changes.filter(c => c.type === "removed") ?? []
);
```

In `onMounted`, after loading skills, add:

```typescript
// Check for pending integrity issues
try {
  const pending = await window.openclaw.skills.pendingIntegrityResult();
  if (pending && !pending.valid) {
    integrityResult.value = pending;
    integrityDialogVisible.value = true;
  }
} catch {}
```

Add handler functions:

```typescript
async function trustIntegrityChanges() {
  integrityLoading.value = true;
  try {
    await window.openclaw.skills.acceptIntegrityChanges();
    integrityDialogVisible.value = false;
    integrityResult.value = null;
    ElMessage.success("已信任变更，完整性快照已更新");
  } catch (err: any) {
    ElMessage.error("更新快照失败: " + (err.message || err));
  } finally {
    integrityLoading.value = false;
  }
}

function exitApp() {
  window.close();
}
```

**Step 2: Add dialog template**

Add before the closing `</template>` tag or inside the skills section:

```html
<!-- Integrity Alert Dialog -->
<el-dialog
  v-model="integrityDialogVisible"
  title="⚠️ 技能文件完整性检查"
  width="560"
  :close-on-click-modal="false"
  :close-on-press-escape="false"
  :show-close="false"
>
  <div v-if="integrityResult && !integrityResult.signatureValid" style="color:#ff3b30; margin-bottom:16px; font-weight:bold">
    🚨 完整性清单本身已被篡改 — 签名验证失败
  </div>

  <div v-if="integrityResult?.signatureValid" style="margin-bottom:12px; color:#666">
    以下技能文件自上次启动后发生了变化：
  </div>

  <div v-if="modifiedChanges.length" style="margin-bottom:12px">
    <div style="font-weight:bold; color:#ff9500; margin-bottom:4px">已修改 ({{ modifiedChanges.length }})</div>
    <div v-for="c in modifiedChanges" :key="c.skill + c.file" style="font-size:13px; color:#555; padding-left:12px">
      · {{ c.source }}/{{ c.skill }}/{{ c.file }}
    </div>
  </div>

  <div v-if="addedChanges.length" style="margin-bottom:12px">
    <div style="font-weight:bold; color:#ff3b30; margin-bottom:4px">新增文件 ({{ addedChanges.length }})</div>
    <div v-for="c in addedChanges" :key="c.skill + c.file" style="font-size:13px; color:#555; padding-left:12px">
      · {{ c.source }}/{{ c.skill }}/{{ c.file }}
    </div>
  </div>

  <div v-if="removedChanges.length" style="margin-bottom:12px">
    <div style="font-weight:bold; color:#ff9500; margin-bottom:4px">已删除 ({{ removedChanges.length }})</div>
    <div v-for="c in removedChanges" :key="c.skill + c.file" style="font-size:13px; color:#555; padding-left:12px">
      · {{ c.source }}/{{ c.skill }}/{{ c.file }}
    </div>
  </div>

  <template #footer>
    <el-button @click="exitApp">退出</el-button>
    <el-button type="primary" :loading="integrityLoading" @click="trustIntegrityChanges">
      信任并继续
    </el-button>
  </template>
</el-dialog>
```

**Step 3: Commit**

```
feat: add integrity alert dialog for skill tampering detection
```

---

### Task 5: Build and verify

**Step 1: Build the desktop app**

```bash
cd q:/src/microclaw/desktop && npm run pack
```

Verify no TypeScript or build errors.

**Step 2: Test the demo scenarios**

1. Launch app → should generate baseline snapshot on first launch (no dialog)
2. Close app, modify a skill file, relaunch → should show alert with modified file
3. Close app, drop a new file into a skill dir, relaunch → should show "added" alert
4. Close app, delete a file from a skill dir, relaunch → should show "removed" alert
5. Close app, edit `skills_snapshot.json`, relaunch → should show signature failure alert
6. Click "Trust & Continue" → snapshot regenerated, next launch is clean

**Step 3: Commit**

```
chore: verify build passes for skill integrity check
```

---

## Summary of Changes

| File | Change |
|------|--------|
| `desktop/src/skill-integrity.ts` | New: hash computation, snapshot generation, Ed25519 signing/verification |
| `desktop/src/main.ts` | Add startup integrity check, IPC handlers |
| `desktop/renderer/env.d.ts` | Add IntegrityResult types and IPC definitions |
| `desktop/src/preload.ts` | Expose integrity IPC to renderer |
| `desktop/renderer/src/views/SettingsView.vue` | Add integrity alert dialog |
