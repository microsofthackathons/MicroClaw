# Skill Manager for Windows Installer — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a skill catalog with certification labels and an installer popup so users can review/modify the bundled skill allowlist before it's injected into `openclaw.json`.

**Architecture:** A static Python catalog (`skill_catalog.py`) defines all 52 bundled skills with a `certified` flag. The installer GUI gets a new "高级选项" (Advanced Options) button that opens a Tkinter modal showing skills as checkboxes (pre-checked = certified). The final selection flows through `config → write_config() → openclaw.json skills.allowBundled`.

**Tech Stack:** Python 3, Tkinter, existing deployer config system

---

### Task 1: Create the Skill Catalog Data File

**Files:**
- Create: `deployer/skill_catalog.py`

**Certification rule:** A skill is certified if it does NOT require external API keys or network access to untrusted third-party services, **with the exception** of OpenAI skills (which are always certified due to MS collaboration). Skills like `clawhub` that talk to the OpenClaw ecosystem are also certified.

**Step 1: Create `deployer/skill_catalog.py`**

```python
"""Bundled skill catalog for the OpenClaw deployer.

Each entry maps a skill directory name → metadata dict.
The ``certified`` flag marks skills pre-approved for the default allowlist.

Certification rule
------------------
certified=True when the skill:
  • runs locally with no external API key, OR
  • is an OpenAI skill (MS collaboration partner), OR
  • talks only to the OpenClaw ecosystem (clawhub).
"""

from __future__ import annotations
from typing import TypedDict


class SkillInfo(TypedDict):
    description: str
    certified: bool


# Complete catalog of the 52 bundled skills shipped with OpenClaw.
# Keep alphabetically sorted by key.
SKILL_CATALOG: dict[str, SkillInfo] = {
    "1password":          {"description": "1Password 密码管理集成",               "certified": False},
    "apple-notes":        {"description": "Apple 备忘录管理",                     "certified": True},
    "apple-reminders":    {"description": "Apple 提醒事项管理",                   "certified": True},
    "bear-notes":         {"description": "Bear 笔记管理（需 API 密钥）",         "certified": False},
    "blogwatcher":        {"description": "博客和 RSS 订阅监控",                  "certified": True},
    "blucli":             {"description": "BluOS 音响控制",                       "certified": True},
    "bluebubbles":        {"description": "iMessage 集成（需 API 密钥）",         "certified": False},
    "camsnap":            {"description": "RTSP/ONVIF 摄像头抓帧",               "certified": True},
    "canvas":             {"description": "HTML 内容展示到 OpenClaw 节点",        "certified": True},
    "clawhub":            {"description": "搜索安装 AgentSkill 市场技能",         "certified": True},
    "coding-agent":       {"description": "委派编码任务给子代理",                 "certified": True},
    "discord":            {"description": "Discord 消息操作（需 API 密钥）",      "certified": False},
    "eightctl":           {"description": "Eight Sleep 床垫控制（需 API 密钥）",  "certified": False},
    "gemini":             {"description": "Google Gemini AI（需 API 密钥）",      "certified": False},
    "gh-issues":          {"description": "GitHub Issue 修复代理（需 Token）",    "certified": False},
    "gifgrep":            {"description": "GIF 搜索工具（需 API 密钥）",          "certified": False},
    "github":             {"description": "GitHub CLI 操作（需 Token）",          "certified": False},
    "gog":                {"description": "Google Workspace 集成（需 API 密钥）", "certified": False},
    "goplaces":           {"description": "Google Places API（需 API 密钥）",     "certified": False},
    "healthcheck":        {"description": "主机安全加固与风险配置",               "certified": True},
    "himalaya":           {"description": "CLI 邮件客户端（需 IMAP 配置）",       "certified": False},
    "imsg":               {"description": "iMessage/SMS 收发",                    "certified": True},
    "mcporter":           {"description": "MCP 服务器管理",                       "certified": True},
    "model-usage":        {"description": "模型用量与成本统计",                   "certified": True},
    "nano-banana-pro":    {"description": "Gemini 图像生成（需 API 密钥）",       "certified": False},
    "nano-pdf":           {"description": "自然语言编辑 PDF",                     "certified": True},
    "notion":             {"description": "Notion 页面与数据库（需 API 密钥）",   "certified": False},
    "obsidian":           {"description": "Obsidian 笔记库管理",                  "certified": True},
    "openai-image-gen":   {"description": "OpenAI 图像生成（需 API 密钥）",       "certified": True},
    "openai-whisper":     {"description": "本地语音转文字（离线）",               "certified": True},
    "openai-whisper-api": {"description": "OpenAI 语音转文字 API",               "certified": True},
    "openhue":            {"description": "Philips Hue 灯光控制",                "certified": True},
    "oracle":             {"description": "AI 代码分析最佳实践",                  "certified": True},
    "ordercli":           {"description": "Foodora 订单查询（需 API 密钥）",      "certified": False},
    "peekaboo":           {"description": "macOS UI 自动化与截图",               "certified": True},
    "sag":                {"description": "ElevenLabs TTS（需 API 密钥）",       "certified": False},
    "session-logs":       {"description": "搜索分析会话日志",                     "certified": True},
    "sherpa-onnx-tts":    {"description": "本地文本转语音（离线）",               "certified": True},
    "skill-creator":      {"description": "创建和编辑 AgentSkill",               "certified": True},
    "slack":              {"description": "Slack 消息管理（需 API 密钥）",        "certified": False},
    "songsee":            {"description": "音频频谱可视化",                       "certified": True},
    "sonoscli":           {"description": "Sonos 音响控制",                       "certified": True},
    "spotify-player":     {"description": "Spotify 播放控制（需 API 密钥）",      "certified": False},
    "summarize":          {"description": "URL/播客/文件摘要（需 API 密钥）",     "certified": False},
    "things-mac":         {"description": "Things 3 任务管理（需 API 密钥）",     "certified": False},
    "tmux":               {"description": "tmux 会话远程控制",                    "certified": True},
    "trello":             {"description": "Trello 看板管理（需 API 密钥）",       "certified": False},
    "video-frames":       {"description": "视频帧提取（ffmpeg）",                 "certified": True},
    "voice-call":         {"description": "语音通话（需 API 密钥）",              "certified": False},
    "wacli":              {"description": "WhatsApp 消息收发",                    "certified": True},
    "weather":            {"description": "天气查询（wttr.in/Open-Meteo）",       "certified": True},
    "xurl":               {"description": "X (Twitter) API 客户端（需 API 密钥）","certified": False},
}


def get_certified_skills() -> list[str]:
    """Return sorted list of skill names where certified=True."""
    return sorted(k for k, v in SKILL_CATALOG.items() if v["certified"])


def get_all_skill_names() -> list[str]:
    """Return all skill names sorted alphabetically."""
    return sorted(SKILL_CATALOG.keys())
```

**Step 2: Commit**

```bash
git add deployer/skill_catalog.py
git commit -m "feat: add bundled skill catalog with certification flags"
```

---

### Task 2: Create the Skill Manager UI Module

**Files:**
- Create: `deployer/skill_manager_ui.py`

This is a Tkinter `Toplevel` modal dialog. It displays all 52 skills as checkboxes grouped into "已认证" (Certified) and "未认证" (Uncertified) sections. The dialog has toolbar buttons and returns the selected list.

**Step 1: Create `deployer/skill_manager_ui.py`**

```python
"""Skill Manager popup — lets the user modify the bundled skill allowlist.

Opens as a modal Toplevel dialog from the main installer window.
Returns a list of selected skill names, or None if the user cancelled.
"""

from __future__ import annotations
import tkinter as tk
from tkinter import ttk
from typing import Optional

from deployer.skill_catalog import SKILL_CATALOG, get_certified_skills


# ── Colours (match deploy.py palette) ──
BG       = "#ffffff"
BG_CARD  = "#f7f8fa"
FG       = "#222222"
FG_DIM   = "#999999"
ACCENT   = "#4a90d9"
TAG_CERT = "#34c759"
TAG_WARN = "#ff9500"


class SkillManagerDialog(tk.Toplevel):
    """Modal dialog for selecting which bundled skills to allow.

    Usage::

        dialog = SkillManagerDialog(parent, preselected=["tmux", "canvas"])
        parent.wait_window(dialog)
        selected = dialog.result  # list[str] or None
    """

    result: Optional[list[str]] = None

    def __init__(self, parent: tk.Tk, preselected: list[str] | None = None):
        super().__init__(parent)
        self.title("技能管理器 — 选择允许的内置技能")
        self.configure(bg=BG)
        self.geometry("560x520")
        self.resizable(False, True)
        self.transient(parent)
        self.grab_set()

        # If no preselection given, default to certified skills
        if preselected is None:
            preselected = get_certified_skills()

        self._vars: dict[str, tk.BooleanVar] = {}
        self._build_ui(preselected)

        # Centre on parent
        self.update_idletasks()
        px = parent.winfo_x() + (parent.winfo_width() - self.winfo_width()) // 2
        py = parent.winfo_y() + (parent.winfo_height() - self.winfo_height()) // 2
        self.geometry(f"+{max(px, 0)}+{max(py, 0)}")

    # ── UI ──

    def _build_ui(self, preselected: list[str]):
        # Title
        tk.Label(self, text="选择允许安装的内置技能", font=("Segoe UI", 14, "bold"),
                 bg=BG, fg=FG).pack(pady=(12, 4))
        tk.Label(self, text="未勾选的技能将在运行时被禁用",
                 font=("Segoe UI", 9), bg=BG, fg=FG_DIM).pack(pady=(0, 8))

        # Toolbar
        toolbar = tk.Frame(self, bg=BG)
        toolbar.pack(fill="x", padx=16, pady=(0, 8))

        for text, cmd in [
            ("仅认证",  self._select_certified),
            ("全选",    self._select_all),
            ("全不选",  self._select_none),
        ]:
            tk.Button(toolbar, text=text, command=cmd,
                      font=("Segoe UI", 9), bg=BG_CARD, fg=FG,
                      bd=1, relief="solid", padx=10, pady=2,
                      cursor="hand2").pack(side="left", padx=(0, 6))

        # Selection count label
        self._count_label = tk.Label(toolbar, text="", font=("Segoe UI", 9),
                                     bg=BG, fg=FG_DIM)
        self._count_label.pack(side="right")

        # Scrollable checklist
        list_frame = tk.Frame(self, bg=BG)
        list_frame.pack(fill="both", expand=True, padx=16, pady=(0, 8))

        canvas = tk.Canvas(list_frame, bg=BG, highlightthickness=0)
        scrollbar = ttk.Scrollbar(list_frame, orient="vertical", command=canvas.yview)
        inner = tk.Frame(canvas, bg=BG)

        inner.bind("<Configure>", lambda e: canvas.configure(scrollregion=canvas.bbox("all")))
        canvas.create_window((0, 0), window=inner, anchor="nw")
        canvas.configure(yscrollcommand=scrollbar.set)

        canvas.pack(side="left", fill="both", expand=True)
        scrollbar.pack(side="right", fill="y")

        # Mouse wheel scrolling
        def _on_mousewheel(event):
            canvas.yview_scroll(int(-1 * (event.delta / 120)), "units")
        canvas.bind_all("<MouseWheel>", _on_mousewheel)

        # Populate skills — certified first, then uncertified
        pre_set = set(preselected)
        certified = sorted(k for k, v in SKILL_CATALOG.items() if v["certified"])
        uncertified = sorted(k for k, v in SKILL_CATALOG.items() if not v["certified"])

        self._add_section(inner, "✓ 已认证技能", TAG_CERT, certified, pre_set)
        self._add_section(inner, "⚠ 未认证技能（需要外部 API 密钥或第三方服务）", TAG_WARN, uncertified, pre_set)

        self._update_count()

        # Bottom buttons
        btn_frame = tk.Frame(self, bg=BG)
        btn_frame.pack(fill="x", padx=16, pady=(0, 12))

        tk.Button(btn_frame, text="确认", command=self._on_ok,
                  bg=ACCENT, fg="#ffffff", font=("Segoe UI", 11, "bold"),
                  bd=0, padx=24, pady=6, cursor="hand2",
                  relief="flat").pack(side="right", padx=(6, 0))

        tk.Button(btn_frame, text="取消", command=self._on_cancel,
                  bg=BG_CARD, fg=FG, font=("Segoe UI", 11),
                  bd=1, relief="solid", padx=24, pady=6,
                  cursor="hand2").pack(side="right")

    def _add_section(self, parent: tk.Frame, title: str, color: str,
                     skills: list[str], preselected: set[str]):
        tk.Label(parent, text=title, font=("Segoe UI", 10, "bold"),
                 bg=BG, fg=color, anchor="w").pack(fill="x", pady=(8, 4))

        for name in skills:
            info = SKILL_CATALOG[name]
            var = tk.BooleanVar(value=name in preselected)
            var.trace_add("write", lambda *_: self._update_count())
            self._vars[name] = var

            row = tk.Frame(parent, bg=BG)
            row.pack(fill="x", pady=1)

            cb = tk.Checkbutton(row, variable=var, bg=BG, activebackground=BG,
                                highlightthickness=0, bd=0)
            cb.pack(side="left")

            tk.Label(row, text=name, font=("Consolas", 10), bg=BG, fg=FG,
                     width=22, anchor="w").pack(side="left")

            tk.Label(row, text=info["description"], font=("Segoe UI", 9),
                     bg=BG, fg=FG_DIM, anchor="w").pack(side="left", fill="x")

    # ── Toolbar actions ──

    def _select_certified(self):
        certified = get_certified_skills()
        for name, var in self._vars.items():
            var.set(name in certified)

    def _select_all(self):
        for var in self._vars.values():
            var.set(True)

    def _select_none(self):
        for var in self._vars.values():
            var.set(False)

    def _update_count(self):
        n = sum(1 for v in self._vars.values() if v.get())
        self._count_label.config(text=f"已选 {n}/{len(self._vars)} 个技能")

    # ── Dialog result ──

    def _on_ok(self):
        self.result = sorted(name for name, var in self._vars.items() if var.get())
        self.grab_release()
        self.destroy()

    def _on_cancel(self):
        self.result = None
        self.grab_release()
        self.destroy()
```

**Step 2: Commit**

```bash
git add deployer/skill_manager_ui.py
git commit -m "feat: add skill manager Tkinter popup dialog"
```

---

### Task 3: Wire the Skill Manager Button into the Installer GUI

**Files:**
- Modify: `deploy.py:60-131` (add "高级选项" button to `_build_ui`)
- Modify: `deploy.py:134-151` (wire skill selection into `_on_install`)

**Step 1: Add import and state in `deploy.py`**

Add to imports (after line 17):
```python
from deployer.skill_catalog import get_certified_skills
from deployer.skill_manager_ui import SkillManagerDialog
```

Add instance variable in `__init__` (after line 53 `self._failed = False`):
```python
        self._selected_skills: list[str] | None = None  # None = dialog not opened, use certified default
```

**Step 2: Add "高级选项" button in `_build_ui`**

After the mirror selector frame (after line 92), add a new frame with the advanced options button:
```python
        # Advanced options button
        adv_frame = tk.Frame(container, bg=BG)
        adv_frame.pack(pady=(0, 16))

        self._adv_btn = tk.Button(
            adv_frame, text="⚙ 高级选项：技能管理", command=self._on_skill_manager,
            bg=BG_CARD, fg=FG_DIM, activebackground="#e8e8e8",
            font=("Segoe UI", 10), bd=1, relief="solid",
            padx=16, pady=4, cursor="hand2")
        self._adv_btn.pack()

        self._skill_status = tk.Label(
            adv_frame, text="", font=("Segoe UI", 9), bg=BG, fg=FG_DIM)
        self._skill_status.pack(pady=(4, 0))
```

**Step 3: Add the `_on_skill_manager` handler**

Add new method to the `DeployerApp` class:
```python
    def _on_skill_manager(self):
        preselected = self._selected_skills if self._selected_skills is not None else get_certified_skills()
        dialog = SkillManagerDialog(self, preselected=preselected)
        self.wait_window(dialog)
        if dialog.result is not None:
            self._selected_skills = dialog.result
            n = len(dialog.result)
            self._skill_status.config(text=f"已选择 {n} 个技能")
```

**Step 4: Wire skill selection into `_on_install`**

In `_on_install` (around line 150, after mirror config is set), inject the skill selection into the deployer config:
```python
        # Apply skill selection
        skills = self._selected_skills if self._selected_skills is not None else get_certified_skills()
        self.config.set("skills.enable", True)
        self.config.set("skills.allowBundled", skills)
```

**Step 5: Commit**

```bash
git add deploy.py
git commit -m "feat: wire skill manager popup into installer GUI"
```

---

### Task 4: Update `config.py` Defaults

**Files:**
- Modify: `deployer/config.py:87-91`

The default config should have `skills.enable: True` and `allowBundled` pre-populated with certified skills so headless installs also get a safe default.

**Step 1: Update `DEFAULT_CONFIG`**

Change the `skills` section:
```python
    "skills": {
        "enable": True,
        "allowBundled": [],   # populated at runtime from skill_catalog.get_certified_skills()
        "allowManaged": [],
    },
```

Note: We keep `allowBundled: []` in the static default — the runtime population happens in `deploy.py._on_install`. This avoids a circular import and keeps the catalog as single source of truth.

**Step 2: Commit**

```bash
git add deployer/config.py
git commit -m "feat: default skills.enable to True for new installs"
```

---

### Task 5: Verify `write_config()` Handles the New Flow

**Files:**
- Modify: `deployer/windows_setup.py:702-737` (minor — the logic already works, but verify edge cases)

**Step 1: Review and adjust `write_config` skill injection**

The existing code at [windows_setup.py:702-737](deployer/windows_setup.py#L702-L737) already handles the `skills.enable → allowBundled` injection correctly. Verify:

- When `skills.enable=True` and `allowBundled` is a non-empty list → writes `skills.allowBundled` into `openclaw.json`. ✓
- When `allowBundled` is empty → no restriction. ✓
- `allowManaged` handling is independent and extensible. ✓

No code changes needed unless testing reveals issues. If the list is `[]` (empty after user deselects all), we should log a warning. Add after line 711:

```python
            if not allow_bundled:
                self.log.warn("  Skill whitelist: allowBundled is empty — all bundled skills will load")
```

**Step 2: Commit (if changes made)**

```bash
git add deployer/windows_setup.py
git commit -m "fix: add warning for empty bundled skill allowlist"
```

---

### Task 6: Manual Testing

**Step 1: Launch the installer GUI**

```bash
cd /q/src/microclaw && python deploy.py
```

**Step 2: Verify the main window**

- "⚙ 高级选项：技能管理" button appears between mirror selector and install button
- Clicking it opens the skill manager modal

**Step 3: Verify the skill manager modal**

- All 52 skills are listed, certified ones checked by default
- OpenAI skills (`openai-image-gen`, `openai-whisper`, `openai-whisper-api`) show as certified ✓
- "仅认证" / "全选" / "全不选" buttons work
- Counter updates live (e.g., "已选 28/52 个技能")
- "确认" closes dialog, main window shows "已选择 N 个技能"
- "取消" closes dialog, no change

**Step 4: Commit any fixes**

---

## Summary of Files Changed

| File | Action | Description |
|------|--------|-------------|
| `deployer/skill_catalog.py` | **Create** | 52-skill catalog with certified flags |
| `deployer/skill_manager_ui.py` | **Create** | Tkinter modal popup for skill selection |
| `deploy.py` | **Modify** | Add "高级选项" button + wire skill list into config |
| `deployer/config.py` | **Modify** | Default `skills.enable` to `True` |
| `deployer/windows_setup.py` | **Modify** | Minor: add warning for empty allowlist |
