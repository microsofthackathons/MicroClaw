# Managed Skill Control Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a managed/workspace skill catalog with certification metadata, pre-configured enable/disable defaults, and separate UI sections in both the installer and desktop app — mirroring the existing bundled skill system.

**Architecture:** Add `MANAGED_SKILL_CATALOG` to `skill_catalog.py` with certified (`microsoft-speedbird`) and uncertified (`unknown-slowbird`) entries. The installer dialog gets a second section for managed skills. The desktop `skills:list` IPC handler reads a new `managed_skill_catalog.json` to show certification badges and uses `skills.entries` for enable/disable state. The desktop UI separates builtin and managed skills into distinct groups with independent toggles.

**Tech Stack:** Python (Tkinter), TypeScript (Electron IPC), Vue 3 (Element Plus)

---

### Task 1: Add MANAGED_SKILL_CATALOG to skill_catalog.py

**Files:**
- Modify: `deployer/skill_catalog.py:78-93`

**Step 1: Add the managed skill catalog and helper functions**

After the existing `SKILL_CATALOG` dict (line 78), add:

```python
# Catalog of known managed/workspace skills.
# Skills installed to ~/.agents/skills/ that appear here get certification metadata.
# Skills NOT in this catalog are treated as uncertified and disabled by default.
MANAGED_SKILL_CATALOG: dict[str, SkillInfo] = {
    "microsoft-speedbird": {"description": "Microsoft Speedbird 认证技能", "certified": True},
    "unknown-slowbird":    {"description": "未认证的 Slowbird 技能",       "certified": False},
}
```

**Step 2: Add helper functions**

After the existing `export_catalog_json()` function, add:

```python
def get_certified_managed_skills() -> list[str]:
    """Return sorted list of managed skill names where certified=True."""
    return sorted(k for k, v in MANAGED_SKILL_CATALOG.items() if v["certified"])


def get_all_managed_skill_names() -> list[str]:
    """Return all managed skill names sorted alphabetically."""
    return sorted(MANAGED_SKILL_CATALOG.keys())


def export_managed_catalog_json() -> dict[str, dict]:
    """Return the managed skill catalog as a JSON-serializable dict."""
    return {k: dict(v) for k, v in MANAGED_SKILL_CATALOG.items()}
```

**Step 3: Commit**

```
feat: add MANAGED_SKILL_CATALOG to skill_catalog.py
```

---

### Task 2: Update deployer config defaults for managed skills

**Files:**
- Modify: `deployer/config.py:85-89`

**Step 1: Update the skills section in DEFAULT_CONFIG**

The `allowManaged` field is already present (line 88) but defaults to `[]`. No structural change needed — the installer will populate it from the new catalog. This task is a no-op if the current default is acceptable.

Verify: `allowManaged: []` means "no managed skills enabled by default" which aligns with the whitelist model. The installer will set it to `get_certified_managed_skills()` at install time.

**No code change needed. Move to next task.**

---

### Task 3: Update installer SkillManagerDialog to show managed skills separately

**Files:**
- Modify: `deployer/skill_manager_ui.py`
- Modify: `deploy.py:20-21,75,213-220,242-244`

**Step 1: Update SkillManagerDialog to accept managed skill preselection**

In `deployer/skill_manager_ui.py`, update the import (line 12):

```python
from deployer.skill_catalog import (
    SKILL_CATALOG, get_certified_skills,
    MANAGED_SKILL_CATALOG, get_certified_managed_skills,
)
```

**Step 2: Update constructor to accept managed skill preselection**

Change `__init__` to accept a second preselection list:

```python
def __init__(self, parent: tk.Tk,
             preselected: list[str] | None = None,
             preselected_managed: list[str] | None = None):
    super().__init__(parent)
    self.title("技能管理器 — 选择允许的技能")
    self.configure(bg=BG)
    self.geometry("560x620")  # taller to fit managed section
    self.resizable(False, True)
    self.transient(parent)
    self.grab_set()

    if preselected is None:
        preselected = get_certified_skills()
    if preselected_managed is None:
        preselected_managed = get_certified_managed_skills()

    self._vars: dict[str, tk.BooleanVar] = {}
    self._managed_vars: dict[str, tk.BooleanVar] = {}
    self._build_ui(preselected, preselected_managed)

    # Centre on parent
    self.update_idletasks()
    px = parent.winfo_x() + (parent.winfo_width() - self.winfo_width()) // 2
    py = parent.winfo_y() + (parent.winfo_height() - self.winfo_height()) // 2
    self.geometry(f"+{max(px, 0)}+{max(py, 0)}")
```

Add `managed_result` alongside `result`:

```python
result: Optional[list[str]] = None
managed_result: Optional[list[str]] = None
```

**Step 3: Update _build_ui to add managed skills section**

Change `_build_ui` signature to accept both preselection lists. After the existing bundled skills sections (certified + uncertified), add a separator and managed skills section:

```python
def _build_ui(self, preselected: list[str], preselected_managed: list[str]):
    # Title — update to cover both skill types
    tk.Label(self, text="选择允许安装的技能", font=("Segoe UI", 14, "bold"),
             bg=BG, fg=FG).pack(pady=(12, 4))
    tk.Label(self, text="未勾选的技能将在运行时被禁用",
             font=("Segoe UI", 9), bg=BG, fg=FG_DIM).pack(pady=(0, 8))

    # Toolbar (applies to bundled skills only)
    toolbar = tk.Frame(self, bg=BG)
    toolbar.pack(fill="x", padx=16, pady=(0, 8))
    for text, cmd in [
        ("仅认证",  self._select_certified),
        ("全选",    self._select_all),
        ("全不选",  self._select_none),
    ]:
        tk.Button(toolbar, text=text, command=cmd, ...).pack(...)

    self._count_label = tk.Label(toolbar, ...)
    self._count_label.pack(side="right")

    # Scrollable checklist
    # ... existing canvas/scrollbar setup ...

    # ── Built-in Skills ──
    pre_set = set(preselected)
    certified = sorted(k for k, v in SKILL_CATALOG.items() if v["certified"])
    uncertified = sorted(k for k, v in SKILL_CATALOG.items() if not v["certified"])

    tk.Label(inner, text="═══ 内置技能 ═══", font=("Segoe UI", 11, "bold"),
             bg=BG, fg=FG).pack(fill="x", pady=(8, 4))
    self._add_section(inner, "✓ 已认证技能", TAG_CERT, certified, pre_set, SKILL_CATALOG, self._vars)
    self._add_section(inner, "⚠ 未认证技能（需要外部 API 密钥或第三方服务）", TAG_WARN, uncertified, pre_set, SKILL_CATALOG, self._vars)

    # ── Managed / Workspace Skills ──
    managed_pre_set = set(preselected_managed)
    managed_cert = sorted(k for k, v in MANAGED_SKILL_CATALOG.items() if v["certified"])
    managed_uncert = sorted(k for k, v in MANAGED_SKILL_CATALOG.items() if not v["certified"])

    tk.Label(inner, text="═══ 托管技能 ═══", font=("Segoe UI", 11, "bold"),
             bg=BG, fg=FG).pack(fill="x", pady=(16, 4))
    self._add_section(inner, "✓ 已认证技能", TAG_CERT, managed_cert, managed_pre_set, MANAGED_SKILL_CATALOG, self._managed_vars)
    self._add_section(inner, "⚠ 未认证技能", TAG_WARN, managed_uncert, managed_pre_set, MANAGED_SKILL_CATALOG, self._managed_vars)

    self._update_count()
    # ... bottom buttons unchanged ...
```

**Step 4: Update _add_section to accept catalog and vars dict**

```python
def _add_section(self, parent: tk.Frame, title: str, color: str,
                 skills: list[str], preselected: set[str],
                 catalog: dict[str, SkillInfo], vars_dict: dict[str, tk.BooleanVar]):
    tk.Label(parent, text=title, font=("Segoe UI", 10, "bold"),
             bg=BG, fg=color, anchor="w").pack(fill="x", pady=(8, 4))
    for name in skills:
        info = catalog[name]
        var = tk.BooleanVar(value=name in preselected)
        var.trace_add("write", lambda *_: self._update_count())
        vars_dict[name] = var
        # ... row rendering same as before, using info["description"] ...
```

**Step 5: Update _update_count to include managed skills**

```python
def _update_count(self):
    nb = sum(1 for v in self._vars.values() if v.get())
    nm = sum(1 for v in self._managed_vars.values() if v.get())
    total = len(self._vars) + len(self._managed_vars)
    self._count_label.config(text=f"已选 {nb + nm}/{total} 个技能")
```

**Step 6: Update _on_ok to return both results**

```python
def _on_ok(self):
    self.result = sorted(name for name, var in self._vars.items() if var.get())
    self.managed_result = sorted(name for name, var in self._managed_vars.items() if var.get())
    self.grab_release()
    self.destroy()
```

**Step 7: Update _select_certified, _select_all, _select_none for both**

The toolbar buttons should affect both bundled AND managed vars:

```python
def _select_certified(self):
    certified = get_certified_skills()
    for name, var in self._vars.items():
        var.set(name in certified)
    managed_certified = get_certified_managed_skills()
    for name, var in self._managed_vars.items():
        var.set(name in managed_certified)

def _select_all(self):
    for var in self._vars.values():
        var.set(True)
    for var in self._managed_vars.values():
        var.set(True)

def _select_none(self):
    for var in self._vars.values():
        var.set(False)
    for var in self._managed_vars.values():
        var.set(False)
```

**Step 8: Update deploy.py to handle managed skill selection**

In `deploy.py`, update import (line 20):

```python
from deployer.skill_catalog import get_certified_skills, get_certified_managed_skills
```

Add `_selected_managed_skills` field (near line 75):

```python
self._selected_skills: list[str] | None = None
self._selected_managed_skills: list[str] | None = None
```

Update `_on_skill_manager` (line 213):

```python
def _on_skill_manager(self):
    preselected = self._selected_skills if self._selected_skills is not None else get_certified_skills()
    preselected_managed = self._selected_managed_skills if self._selected_managed_skills is not None else get_certified_managed_skills()
    dialog = SkillManagerDialog(self, preselected=preselected, preselected_managed=preselected_managed)
    self.wait_window(dialog)
    if dialog.result is not None:
        self._selected_skills = dialog.result
        self._selected_managed_skills = dialog.managed_result
        nb = len(dialog.result)
        nm = len(dialog.managed_result) if dialog.managed_result else 0
        self._skill_status.config(text=f"已选择 {nb} 内置 + {nm} 托管技能")
```

Update `_on_install` (line 242):

```python
skills = self._selected_skills if self._selected_skills is not None else get_certified_skills()
managed_skills = self._selected_managed_skills if self._selected_managed_skills is not None else get_certified_managed_skills()
self.config.set("skills.enable", True)
self.config.set("skills.allowBundled", skills)
self.config.set("skills.allowManaged", managed_skills)
```

**Step 9: Commit**

```
feat: add managed skills section to installer skill manager dialog
```

---

### Task 4: Update windows_setup.py to export managed skill catalog

**Files:**
- Modify: `deployer/windows_setup.py:22,870-879`

**Step 1: Update import**

```python
from deployer.skill_catalog import export_catalog_json, export_managed_catalog_json
```

**Step 2: Write managed_skill_catalog.json alongside skill_catalog.json**

After the existing skill_catalog.json write (line 879), add:

```python
        # ── Managed skill catalog (certification metadata for managed/workspace skills) ──
        managed_catalog_path = openclaw_dir / "managed_skill_catalog.json"
        try:
            managed_catalog_path.write_text(
                json.dumps(export_managed_catalog_json(), indent=2, ensure_ascii=False),
                encoding="utf-8",
            )
            self.log.success(f"Managed skill catalog written to {managed_catalog_path}")
        except Exception as e:
            self.log.warn(f"Managed skill catalog write failed (non-fatal): {e}")
```

**Step 3: Commit**

```
feat: export managed_skill_catalog.json during installation
```

---

### Task 5: Update desktop IPC to return managed skills with certification data

**Files:**
- Modify: `desktop/renderer/env.d.ts:25-32,55-58`
- Modify: `desktop/src/main.ts:298-356`
- Modify: `desktop/src/preload.ts:47-51`

**Step 1: Update SkillEntry type to include 'managed' source**

In `desktop/renderer/env.d.ts`, line 29:

```typescript
source: 'builtin' | 'custom' | 'managed';
```

**Step 2: Update skills.list() return type**

In `desktop/renderer/env.d.ts`, line 56:

```typescript
list(): Promise<{ builtin: SkillEntry[]; custom: SkillEntry[]; managed: SkillEntry[] }>;
```

**Step 3: Add updateManagedEntries to the skills API**

In `desktop/renderer/env.d.ts`, add after line 57:

```typescript
updateManagedEntries(entries: Record<string, { enabled: boolean }>): Promise<void>;
```

**Step 4: Update skills:list IPC handler in main.ts**

In `desktop/src/main.ts`, update the `skills:list` handler (line 298-347):

- Load `managed_skill_catalog.json` alongside `skill_catalog.json`
- Add managed skill directory: `path.join(homeDir, ".openclaw", "skills")` (OpenClaw's managed skills path)
- Load `skills.entries` from config for managed skill enabled state
- Scan managed dir, match against managed catalog for certification
- For skills NOT found on disk but present in catalog, still list them (with enabled from entries)
- Return `{ builtin, custom, managed }`

```typescript
ipcMain.handle("skills:list", () => {
    const homeDir = app.getPath("home");
    const builtinDir = path.join(homeDir, ".openclaw-node", "node_modules", "openclaw", "skills");
    const customDir = path.join(homeDir, ".agents", "skills");
    const managedDir = path.join(homeDir, ".openclaw", "skills");

    // Load bundled certification catalog
    let catalog: Record<string, { description: string; certified: boolean }> = {};
    try {
      const catalogPath = path.join(getOpenClawStateDir(), "skill_catalog.json");
      if (fs.existsSync(catalogPath)) {
        catalog = JSON.parse(fs.readFileSync(catalogPath, "utf-8"));
      }
    } catch {}

    // Load managed certification catalog
    let managedCatalog: Record<string, { description: string; certified: boolean }> = {};
    try {
      const managedCatalogPath = path.join(getOpenClawStateDir(), "managed_skill_catalog.json");
      if (fs.existsSync(managedCatalogPath)) {
        managedCatalog = JSON.parse(fs.readFileSync(managedCatalogPath, "utf-8"));
      }
    } catch {}

    // Load config
    const config = readConfig();
    const allowBundled: string[] | undefined = config?.skills?.allowBundled;
    const entries: Record<string, { enabled: boolean }> = config?.skills?.entries ?? {};

    function scanSkills(dir: string, source: "builtin" | "custom" | "managed"): SkillEntry[] {
      const results: SkillEntry[] = [];
      if (!fs.existsSync(dir)) return results;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const skillMd = path.join(dir, entry.name, "SKILL.md");
        let name = entry.name;
        let description = "";
        if (fs.existsSync(skillMd)) {
          const head = fs.readFileSync(skillMd, "utf-8").slice(0, 1000);
          const nameMatch = head.match(/^name:\s*(.+)/m);
          const descMatch = head.match(/^description:\s*(.+)/m);
          if (nameMatch) name = nameMatch[1].trim();
          if (descMatch) description = descMatch[1].replace(/^["']|["']$/g, "").trim();
        }

        const cat = source === "builtin" ? catalog : managedCatalog;
        const certified = cat[entry.name]?.certified ?? false;
        if (source === "managed" && !description && managedCatalog[entry.name]?.description) {
          description = managedCatalog[entry.name].description;
        }

        let enabled = true;
        if (source === "builtin" && allowBundled && allowBundled.length > 0) {
          enabled = allowBundled.includes(entry.name);
        } else if (source === "managed") {
          // Managed skills: check entries, default disabled if not in catalog as certified
          if (entries[entry.name] !== undefined) {
            enabled = entries[entry.name].enabled;
          } else {
            enabled = certified; // certified → enabled, uncertified/unknown → disabled
          }
        }

        results.push({ id: entry.name, name, description, source, certified, enabled });
      }
      return results;
    }

    // Also include catalog-only managed skills (not yet on disk)
    const managedOnDisk = scanSkills(managedDir, "managed");
    const onDiskIds = new Set(managedOnDisk.map(s => s.id));
    for (const [id, info] of Object.entries(managedCatalog)) {
      if (!onDiskIds.has(id)) {
        const enabled = entries[id]?.enabled ?? info.certified;
        managedOnDisk.push({
          id, name: id, description: info.description,
          source: "managed", certified: info.certified, enabled,
        });
      }
    }

    return {
      builtin: scanSkills(builtinDir, "builtin"),
      custom: scanSkills(customDir, "custom"),
      managed: managedOnDisk,
    };
});
```

**Step 5: Add skills:update-managed-entries IPC handler**

After `skills:update-allowlist` handler (line 356):

```typescript
ipcMain.handle("skills:update-managed-entries",
  (_event, updatedEntries: Record<string, { enabled: boolean }>) => {
    const config = readConfig() || {};
    if (!config.skills) config.skills = {};
    if (!config.skills.entries) config.skills.entries = {};
    Object.assign(config.skills.entries, updatedEntries);
    const stateDir = getOpenClawStateDir();
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(getConfigPath(), JSON.stringify(config, null, 2), "utf-8");
  }
);
```

**Step 6: Update preload.ts to expose new IPC methods**

In `desktop/src/preload.ts`, update skills section (line 47-51):

```typescript
skills: {
    list: () => ipcRenderer.invoke("skills:list"),
    updateAllowlist: (allowBundled: string[]) =>
      ipcRenderer.invoke("skills:update-allowlist", allowBundled),
    updateManagedEntries: (entries: Record<string, { enabled: boolean }>) =>
      ipcRenderer.invoke("skills:update-managed-entries", entries),
},
```

**Step 7: Commit**

```
feat: add managed skill scanning, catalog loading, and IPC handlers
```

---

### Task 6: Update SettingsView.vue to show managed skills separately

**Files:**
- Modify: `desktop/renderer/src/views/SettingsView.vue:344-427,533-562,738-744`

**Step 1: Add managed skill state**

After `customSkills` ref (line 534):

```typescript
const managedSkills = ref<SkillEntry[]>([]);

const certifiedManagedSkills = computed(() =>
  managedSkills.value.filter(s => s.certified).sort((a, b) => a.name.localeCompare(b.name))
);
const uncertifiedManagedSkills = computed(() =>
  managedSkills.value.filter(s => !s.certified).sort((a, b) => a.name.localeCompare(b.name))
);
const managedEnabledCount = computed(() =>
  managedSkills.value.filter(s => s.enabled).length
);
```

**Step 2: Add toggleManagedSkill function**

After `toggleSkill` function (line 562):

```typescript
async function toggleManagedSkill(skillId: string, enabled: boolean) {
  const skill = managedSkills.value.find(s => s.id === skillId);
  if (skill) skill.enabled = enabled;

  try {
    await window.openclaw.skills.updateManagedEntries({ [skillId]: { enabled } });
    await window.openclaw.gateway.restart();
    ElMessage.success("托管技能配置已更新，网关正在重启…");
  } catch (err: any) {
    if (skill) skill.enabled = !enabled;
    ElMessage.error("托管技能配置更新失败: " + (err.message || err));
  }
}
```

**Step 3: Update loadSkills to include managed skills**

At line 739-741:

```typescript
const skills = await window.openclaw.skills.list();
builtinSkills.value = skills.builtin;
customSkills.value = skills.custom;
managedSkills.value = skills.managed ?? [];
```

**Step 4: Update the template to separate builtin and managed sections**

Replace the skills template section (lines 344-427) with:

```html
<!-- Skills -->
<div v-if="activeSection === 'skills'" class="section">
  <div class="section-label">技能管理</div>

  <!-- ══ Built-in Skills ══ -->
  <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:8px">
    <span class="sub-label" style="margin:0">内置技能 ({{ builtinSkills.length }})</span>
    <span class="skill-count-label">{{ enabledCount }}/{{ builtinSkills.length }} 已启用</span>
  </div>

  <!-- Certified Built-in -->
  <div v-if="certifiedSkills.length" class="sub-label" style="font-size:12px; margin-top:4px">已认证 ({{ certifiedSkills.length }})</div>
  <div v-if="certifiedSkills.length" class="card-group">
    <div v-for="(skill, idx) in certifiedSkills" :key="skill.id" class="card-row"
         :class="{ 'no-border': idx === certifiedSkills.length - 1 }">
      <div class="skill-info">
        <div style="display:flex; align-items:center; gap:8px">
          <span class="row-label">{{ skill.name }}</span>
          <span class="badge badge-green">已认证</span>
        </div>
        <span class="skill-desc">{{ skill.description }}</span>
      </div>
      <el-switch :model-value="skill.enabled" @change="(val: boolean) => toggleSkill(skill.id, val)" />
    </div>
  </div>

  <!-- Uncertified Built-in -->
  <div v-if="uncertifiedSkills.length" class="sub-label" style="font-size:12px">未认证 ({{ uncertifiedSkills.length }})</div>
  <div v-if="uncertifiedSkills.length" class="card-group">
    <div v-for="(skill, idx) in uncertifiedSkills" :key="skill.id" class="card-row"
         :class="{ 'no-border': idx === uncertifiedSkills.length - 1 }">
      <div class="skill-info">
        <div style="display:flex; align-items:center; gap:8px">
          <span class="row-label">{{ skill.name }}</span>
          <span class="badge badge-orange">未认证</span>
        </div>
        <span class="skill-desc">{{ skill.description }}</span>
      </div>
      <el-switch :model-value="skill.enabled" @change="(val: boolean) => toggleSkill(skill.id, val)" />
    </div>
  </div>

  <div v-if="!builtinSkills.length" class="card-group">
    <div class="card-row no-border placeholder-row">
      <span class="placeholder-text">未检测到内置技能</span>
    </div>
  </div>

  <!-- ══ Managed / Workspace Skills ══ -->
  <div style="display:flex; align-items:center; justify-content:space-between; margin-top:20px; margin-bottom:8px">
    <span class="sub-label" style="margin:0">托管技能 ({{ managedSkills.length }})</span>
    <span class="skill-count-label">{{ managedEnabledCount }}/{{ managedSkills.length }} 已启用</span>
  </div>

  <!-- Certified Managed -->
  <div v-if="certifiedManagedSkills.length" class="sub-label" style="font-size:12px; margin-top:4px">已认证 ({{ certifiedManagedSkills.length }})</div>
  <div v-if="certifiedManagedSkills.length" class="card-group">
    <div v-for="(skill, idx) in certifiedManagedSkills" :key="skill.id" class="card-row"
         :class="{ 'no-border': idx === certifiedManagedSkills.length - 1 }">
      <div class="skill-info">
        <div style="display:flex; align-items:center; gap:8px">
          <span class="row-label">{{ skill.name }}</span>
          <span class="badge badge-green">已认证</span>
        </div>
        <span class="skill-desc">{{ skill.description }}</span>
      </div>
      <el-switch :model-value="skill.enabled" @change="(val: boolean) => toggleManagedSkill(skill.id, val)" />
    </div>
  </div>

  <!-- Uncertified / Unknown Managed -->
  <div v-if="uncertifiedManagedSkills.length" class="sub-label" style="font-size:12px">未认证 ({{ uncertifiedManagedSkills.length }})</div>
  <div v-if="uncertifiedManagedSkills.length" class="card-group">
    <div v-for="(skill, idx) in uncertifiedManagedSkills" :key="skill.id" class="card-row"
         :class="{ 'no-border': idx === uncertifiedManagedSkills.length - 1 }">
      <div class="skill-info">
        <div style="display:flex; align-items:center; gap:8px">
          <span class="row-label">{{ skill.name }}</span>
          <span class="badge badge-orange">未认证</span>
        </div>
        <span class="skill-desc">{{ skill.description }}</span>
      </div>
      <el-switch :model-value="skill.enabled" @change="(val: boolean) => toggleManagedSkill(skill.id, val)" />
    </div>
  </div>

  <div v-if="!managedSkills.length" class="card-group">
    <div class="card-row no-border placeholder-row">
      <span class="placeholder-text">暂无托管技能</span>
    </div>
  </div>

  <!-- ══ Custom Skills (unchanged) ══ -->
  <div class="sub-label">Custom Skills ({{ customSkills.length }})</div>
  <div class="card-group">
    <template v-if="customSkills.length">
      <div v-for="(skill, idx) in customSkills" :key="skill.id" class="card-row"
           :class="{ 'no-border': idx === customSkills.length - 1 }">
        <div class="skill-info">
          <span class="row-label">{{ skill.name }}</span>
          <span class="skill-desc">{{ skill.description }}</span>
        </div>
        <span class="badge badge-blue">Custom</span>
      </div>
    </template>
    <div v-else class="card-row no-border placeholder-row">
      <span class="placeholder-text">暂无自定义技能</span>
    </div>
  </div>
</div>
```

**Step 5: Commit**

```
feat: separate managed skills UI in desktop settings view
```

---

## Summary of Changes

| File | Change |
|------|--------|
| `deployer/skill_catalog.py` | Add `MANAGED_SKILL_CATALOG` + helpers |
| `deployer/skill_manager_ui.py` | Add managed skills section to dialog |
| `deploy.py` | Pass managed skill selection to config |
| `deployer/windows_setup.py` | Export `managed_skill_catalog.json` |
| `desktop/renderer/env.d.ts` | Add `'managed'` source, new IPC types |
| `desktop/src/main.ts` | Scan managed dir, load managed catalog, new IPC handler |
| `desktop/src/preload.ts` | Expose `updateManagedEntries` |
| `desktop/renderer/src/views/SettingsView.vue` | Separate managed skills UI section |
