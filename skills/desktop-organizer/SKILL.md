---
name: Desktop Organizer
slug: desktop-organizer
version: 1.3.0
description: "Scan a Windows desktop, show a plan, then STOP and wait for user go-ahead before organizing."
metadata: {"clawdbot":{"emoji":"","requires":{"bins":[]},"os":["win32"]}}
---

# Skill: desktop-organizer

**Description:** Scan a Windows desktop, show a plan, then **STOP** and wait for user go-ahead before organizing. PowerShell only.

---

## Progress Reporting

You **MUST** report progress using special markers so the UI can render a step-by-step progress panel. The markers are invisible to the user (stripped from display).

### Format

**Plan block** — a fenced code block with language tag `json:plan`, containing a JSON array of `{"step": N, "label": "..."}` objects.

**Step markers** — HTML comments: `<!-- step:N:start -->` and `<!-- step:N:done -->`.

### Rules

1. **Generate the plan based on what you ACTUALLY find** — never copy any example. The plan must reflect the real files/folders on the user's desktop.
2. **This is a TWO-PHASE workflow.** Each phase gets its own plan block:
   - **Phase 1 (scan & present):** Emit a plan block for the scan/analysis steps BEFORE your first tool call. Steps like "Scan desktop", "Analyze structure", "Present plan". Finish ALL steps in this plan. Then present the plan to the user and STOP.
   - **Phase 2 (execute after "go"):** When the user says "go", emit a NEW plan block for the execution steps. Steps like "Create folders", "Move screenshots to Images/", "Rename 'New folder'". Each step should describe one logical action on the user's files.
3. **The plan block MUST be the VERY FIRST thing you output** — do NOT write any text before the plan block. No greetings, no "I'll help you", no explanation. Start your response directly with the ````json:plan` fenced block. Any visible text should come AFTER the plan block and step markers.
4. **Labels must be in the user's language**, concise (under 20 chars), and describe the logical action (NOT raw shell commands).
5. **Every step MUST have both start and done markers**, emitted in order. This includes the LAST step — you MUST emit `<!-- step:N:done -->` for the final step BEFORE stopping, even if you are about to wait for user input.
6. A step marker MUST appear on its own line.
7. If a step fails, still emit `<!-- step:N:done -->`.
8. **CRITICAL — Stream markers INTERLEAVED with tool calls, never in a single batch at the end.** The UI animation depends on each `<!-- step:N:start -->` arriving BEFORE the tool calls for that step run, and `<!-- step:N:done -->` arriving AFTER those tool calls finish but BEFORE the next step's `start` marker. Concretely, your output stream MUST follow this exact ordering:

   1. Emit the ````json:plan` block as the very first tokens of the response.
   2. Emit `<!-- step:1:start -->` on its own line **and flush** (do not buffer it together with later content).
   3. Run the tool calls that belong to step 1.
   4. Emit `<!-- step:1:done -->` on its own line **before** starting step 2.
   5. Emit `<!-- step:2:start -->`, run step 2's tools, emit `<!-- step:2:done -->`.
   6. Repeat for every step. Never emit multiple `start` markers in a row, never emit all `done` markers at the end.

   **Forbidden pattern (this breaks the UI animation):**

       ```json:plan
       [...]
       ```
       (run all tool calls silently)
       <!-- step:1:start --><!-- step:1:done -->
       <!-- step:2:start --><!-- step:2:done -->
       <!-- step:3:start --><!-- step:3:done -->

   **Required pattern:**

       ```json:plan
       [...]
       ```
       <!-- step:1:start -->
       (tool call for step 1)
       <!-- step:1:done -->
       <!-- step:2:start -->
       (tool call for step 2)
       <!-- step:2:done -->

9. **One step = one logical action.** Do not collapse "probe access + scan files + scan folders" into a single step that runs three tool calls before any marker is emitted. Either give each its own step, or pick ONE representative tool call for the step and emit `done` immediately after it returns.
10. **No silent prelude.** You may not run any tool call before emitting the plan block and `<!-- step:1:start -->`. The very first thing the user's UI sees from you must be the plan block, followed immediately by `<!-- step:1:start -->`, followed by the first tool invocation.

### Example (Phase 1 — DO NOT copy these labels, generate your own)

The model outputs something like:

    ```json:plan
    [{"step": 1, "label": "Scan desktop"}, {"step": 2, "label": "Analyze files"}]
    ```

    <!-- step:1:start -->
    (run probe & scan commands)
    <!-- step:1:done -->
    <!-- step:2:start -->
    (analyze results)
    <!-- step:2:done -->

    Here's what I found: ...
    Do you want me to proceed?

### Example (Phase 2 — after user says "go")

    ```json:plan
    [{"step": 1, "label": "Create folders"}, {"step": 2, "label": "Move PDFs"}, {"step": 3, "label": "Rename 'New folder'"}]
    ```

    <!-- step:1:start -->
    (create directory commands)
    <!-- step:1:done -->
    <!-- step:2:start -->
    (move commands)
    <!-- step:2:done -->
    ...

---

## Input

Absolute path, e.g.:

```
C:\Users\Administrator\Desktop
```

If the user does **not** provide a path, detect it automatically. **Important:** `[Environment]::GetFolderPath('Desktop')` returns empty inside AppContainer sandboxes. Read the actual desktop path from the Windows registry instead:

```powershell
(Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders').Desktop
```

This returns the exact desktop path Windows is using (works for both local and OneDrive-redirected desktops).

Use the returned absolute path for all subsequent steps. Do NOT use `~`, or relative paths — always use the full literal absolute path.

---

## Rules

- **This is a Windows environment**
- **PowerShell first** 
- **No variables** (`$p`, `$folder`, etc.) — inline the full absolute path every time
- **No wildcards** — no `*`, `?`, `[…]`
- **Top-level items only** — scan top-level files AND folders, but do not recurse into subfolders
- **Do NOT move files outside the desktop** — files may only be moved into subfolders directly under the same desktop path (e.g., `C:\Users\Administrator\Desktop\Documents\`). Never move files to any location outside the desktop folder.
- **Do NOT touch shortcuts** — never move, rename, or reorganize `.lnk` (shortcut) files. Leave all shortcuts exactly where they are. Exclude them from the plan entirely.
- **Match the user's language** — all output, plans, tables, labels, and messages must be in the same language the user is using. If the user writes in Chinese, respond in Chinese; if in English, respond in English.
- **STOP after plan** — after presenting the plan to the user, you **MUST** stop completely. Do NOT create folders, do NOT move files, do NOT execute anything. Wait until the user explicitly replies with a go command (e.g., "yes", "go", "do it", "proceed"). No automatic execution, ever.

---

## Flow

### Step 1 — Read Probe

Verify access to the desktop path before doing anything else.

```powershell
"Get-ChildItem -LiteralPath 'C:\Users\Administrator\Desktop' -Force | Out-Null"
```

If this fails → retry this probe, if it fails again, report the error to the user and go to the next step.

### Step 2 — Scan

List every top-level item (files AND folders) on the desktop.

**2a) Scan files:**

```powershell
"Get-ChildItem -LiteralPath 'C:\Users\Administrator\Desktop' -Force -File | Select Name, FullName, Extension"
```

**2b) Scan folders:**

```powershell
"Get-ChildItem -LiteralPath 'C:\Users\Administrator\Desktop' -Force -Directory | Select Name, FullName"
```

Collect BOTH results for planning. Do NOT skip existing folders — they must appear in the plan.

### Step 3 — Plan → then waiting for user input

The plan MUST address ALL top-level items:

1. **Loose files** — group by type and propose which category folder each file moves into
2. **Existing folders** — analyze each folder's name and propose a CONCRETE action:
   - **Group similar folders** — e.g. "ModelA", "ModelB-1", "ModelB-2" → move all into a new `Models/` parent folder
   - **Consolidate variant folders** — e.g. "ModelB-1", "ModelB-1-fix", "ModelB-2", "ModelB-2-mini", "ModelB-2-mini-fix" → group under `Models/ModelB/` with subfolders `v1/`, `v1-fix/`, `v2/`, `v2-mini/`, `v2-mini-fix/` (or keep original names under the parent)
   - **Move into a category** — e.g. a folder named "invoices" → move into `Documents/`
   - **Rename for consistency** — e.g. "New folder" → rename to something meaningful based on contents
   - **Keep in place** — ONLY if the folder is already a well-named category folder (e.g. "Documents", "Images")

   **"Leave as-is" is NOT acceptable as a default.** You must actively propose grouping or categorization for every folder. If multiple folders share a common prefix or theme (e.g. "ModelA", "ModelB-1", "ModelC"), they MUST be grouped into a parent folder. If a folder has variants (e.g. "X", "X-fix", "X-mini"), group them together under the base name.

**Present to the user:**

- **Files to organize** — table of files → target folder
- **Existing folders** — table of folders → proposed action (group / move / rename / keep) with clear reasoning
- **Proposed folder structure (BEFORE → AFTER)** — show both current and proposed final layout as a tree:

```
BEFORE (current desktop):
├── ModelA/
├── ModelB-1/
├── ModelB-1-fix/
├── ModelB-2/
├── ModelB-2-mini/
├── ModelB-2-mini-fix/
├── ModelC/
├── report.pdf
├── photo.jpg
└── setup.exe

AFTER (proposed):
├── Models/
│   ├── ModelA/
│   ├── ModelB/
│   │   ├── ModelB-1/
│   │   ├── ModelB-1-fix/
│   │   ├── ModelB-2/
│   │   ├── ModelB-2-mini/
│   │   └── ModelB-2-mini-fix/
│   └── ModelC/
├── Documents/
│   └── report.pdf
├── Images/
│   └── photo.jpg
└── Installers/
    └── setup.exe
```

Then:

> **waiting for user input.** Do NOT proceed. Do NOT create folders. Do NOT move files.
> Wait for the user to explicitly say "go", "yes", "do it", "proceed", or similar.
> If the user does not confirm, do nothing.

### Step 4 — Execute (ONLY after user explicitly says GO)

**Do not enter this step unless the user has replied with an explicit go command after seeing the plan.**

#### 4-pre) Request write access to the desktop ROOT in ONE call

Before creating any subfolder or moving any file, you **MUST** issue a single standalone `declare-access` command that asks for **read-write access to the desktop root path itself** (not any subfolder). This produces ONE permission dialog covering all subsequent writes anywhere under the desktop. Without this, the sandbox will pop a separate dialog for every category subfolder you create (`Documents/`, `Images/`, `Installers/`, ...), because the scan phase only granted read-only access to the desktop.

Emit it as a standalone command (the entire command IS the declare-access tag, with no trailing shell command):

```
[declare-access]rw:C:\Users\Administrator\Desktop[/declare-access]
```

Rules for this pre-step:

- Use the **literal desktop root path** detected earlier (e.g. `C:\Users\yuxwei\Desktop` or the OneDrive-redirected path). Do NOT request `Desktop\Documents`, `Desktop\*`, or any subfolder — the request must target the desktop root exactly so the permission dialog asks the user once for the whole desktop.
- Do NOT use `ro:` here — Phase 2 needs write access. Use `rw:` only.
- Run this BEFORE the write probe in 4a. After the user grants it, every later `New-Item` and `Move-Item` under the desktop is auto-approved by the sandbox without further prompts.
- If the user denies this request, stop Phase 2 and report that organization cannot proceed.

#### 4a) Create category folders

After the rw access is granted in 4-pre, run a write probe.txt to verify write access to the target folder.

```powershell
"New-Item -Path 'C:\Users\Administrator\Desktop\ProbeTestPwsh.txt' -Force | Select-Object FullName, Length, LastWriteTime | Format-List"
```

And then delete the probe file.

One command per folder. Only create folders for categories that have files. Folders are created under the same desktop path.

**Note:** `New-Item` does NOT support `-LiteralPath`. Use `-Path` instead (it is safe for folder creation).

```powershell
powershell -NoProfile -NonInteractive -Command "New-Item -ItemType Directory -Path 'C:\Users\Administrator\Desktop\Documents' -Force | Out-Null"
```

#### 4b) Move files

One command per file or folder.

```powershell
powershell -NoProfile -NonInteractive -Command "Move-Item -LiteralPath 'C:\Users\Administrator\Desktop\report.pdf' -Destination 'C:\Users\Administrator\Desktop\PDFs\'"
```

**Move rules:**

- Always use `-LiteralPath` with full absolute source path
- Destination is `<same desktop path>\<Category>\` — never outside the desktop
- **No overwrite** — if a file with the same name exists in the destination, skip it and report the conflict
- **No deletion** — never delete any file except the probe test file (probe file can be deleted)
- Process files or folder **one at a time**

---

## Absolute Prohibitions

- ❌ **Never move files outside the desktop** — destination must always be a subfolder under the same desktop path
- ❌ **Never execute automatically after plan** — must STOP and WAIT for explicit user go command
- ❌ **Never touch shortcut (.lnk) files** — never move, rename, or include shortcuts in the organization plan
- ❌ **Never start/launch any executable** — no `Start-Process`, `Invoke-Item`, or running any `.exe`/`.msi`

---

## Summary

| Step | Action  | Detail |
|------|---------|--------|
| 1    | Probe   | Verify access, stop on failure |
| 2    | Scan    | List all top-level files |
| 3    | Plan    | Group files and show structure →  wait for user input go |
| 4-pre| Declare | Request `rw:` on the desktop ROOT in one declare-access call before any write |
| 4    | Execute | Create folders & move files — **only after user says go** |
