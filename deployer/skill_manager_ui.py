"""Skill Manager popup — lets the user modify the bundled skill allowlist.

Opens as a modal Toplevel dialog from the main installer window.
Returns a list of selected skill names, or None if the user cancelled.
"""

from __future__ import annotations

import tkinter as tk
from tkinter import ttk

from deployer.skill_catalog import (
    MANAGED_SKILL_CATALOG,
    SKILL_CATALOG,
    get_windows_managed_skills,
    get_windows_skills,
)

# ── Colours (match deploy.py palette) ──
BG = "#ffffff"
BG_CARD = "#f7f8fa"
FG = "#222222"
FG_DIM = "#999999"
ACCENT = "#4a90d9"
TAG_CERT = "#34c759"
TAG_WARN = "#ff9500"


class SkillManagerDialog(tk.Toplevel):
    """Modal dialog for selecting which bundled skills to allow.

    Usage::

        dialog = SkillManagerDialog(parent, preselected=["tmux", "canvas"])
        parent.wait_window(dialog)
        selected = dialog.result  # list[str] or None
    """

    result: list[str] | None = None
    managed_result: list[str] | None = None

    def __init__(
        self,
        parent: tk.Tk,
        preselected: list[str] | None = None,
        preselected_managed: list[str] | None = None,
    ):
        super().__init__(parent)
        self.title("技能管理器 — 选择允许的技能")
        self.configure(bg=BG)
        self.geometry("560x620")
        self.resizable(False, True)
        self.transient(parent)
        self.grab_set()

        # If no preselection given, default to Windows skills
        if preselected is None:
            preselected = get_windows_skills()
        if preselected_managed is None:
            preselected_managed = get_windows_managed_skills()

        self._vars: dict[str, tk.BooleanVar] = {}
        self._managed_vars: dict[str, tk.BooleanVar] = {}
        self._build_ui(preselected, preselected_managed)

        # Centre on parent
        self.update_idletasks()
        px = parent.winfo_x() + (parent.winfo_width() - self.winfo_width()) // 2
        py = parent.winfo_y() + (parent.winfo_height() - self.winfo_height()) // 2
        self.geometry(f"+{max(px, 0)}+{max(py, 0)}")

    # ── UI ──

    def _build_ui(self, preselected: list[str], preselected_managed: list[str]):
        # Title
        tk.Label(self, text="选择允许安装的技能", font=("Segoe UI", 14, "bold"), bg=BG, fg=FG).pack(
            pady=(12, 4)
        )
        tk.Label(
            self, text="未勾选的技能将在运行时被禁用", font=("Segoe UI", 9), bg=BG, fg=FG_DIM
        ).pack(pady=(0, 8))

        # Toolbar
        toolbar = tk.Frame(self, bg=BG)
        toolbar.pack(fill="x", padx=16, pady=(0, 8))

        for text, cmd in [
            ("仅 Windows", self._select_windows),
            ("全选", self._select_all),
            ("全不选", self._select_none),
        ]:
            tk.Button(
                toolbar,
                text=text,
                command=cmd,
                font=("Segoe UI", 9),
                bg=BG_CARD,
                fg=FG,
                bd=1,
                relief="solid",
                padx=10,
                pady=2,
                cursor="hand2",
            ).pack(side="left", padx=(0, 6))

        # Selection count label
        self._count_label = tk.Label(toolbar, text="", font=("Segoe UI", 9), bg=BG, fg=FG_DIM)
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

        # Populate skills — bundled first, then managed
        pre_set = set(preselected)
        pre_managed_set = set(preselected_managed)

        # ═══ Bundled skills section ═══
        tk.Label(
            inner,
            text="═══ 内置技能 ═══",
            font=("Segoe UI", 11, "bold"),
            bg=BG,
            fg=FG,
            anchor="center",
        ).pack(fill="x", pady=(8, 2))

        windows_skills = sorted(k for k, v in SKILL_CATALOG.items() if "windows" in v["platform"])
        other_skills = sorted(k for k, v in SKILL_CATALOG.items() if "windows" not in v["platform"])

        self._add_section(
            inner, "✓ Windows 适配", TAG_CERT, windows_skills, pre_set, SKILL_CATALOG, self._vars
        )
        self._add_section(
            inner, "⚠ 其他平台", TAG_WARN, other_skills, pre_set, SKILL_CATALOG, self._vars
        )

        # ═══ Managed skills section ═══
        tk.Label(
            inner,
            text="═══ 托管技能 ═══",
            font=("Segoe UI", 11, "bold"),
            bg=BG,
            fg=FG,
            anchor="center",
        ).pack(fill="x", pady=(16, 2))

        windows_managed = sorted(
            k for k, v in MANAGED_SKILL_CATALOG.items() if "windows" in v["platform"]
        )
        other_managed = sorted(
            k for k, v in MANAGED_SKILL_CATALOG.items() if "windows" not in v["platform"]
        )

        self._add_section(
            inner,
            "✓ Windows 适配",
            TAG_CERT,
            windows_managed,
            pre_managed_set,
            MANAGED_SKILL_CATALOG,
            self._managed_vars,
        )
        self._add_section(
            inner,
            "⚠ 其他平台",
            TAG_WARN,
            other_managed,
            pre_managed_set,
            MANAGED_SKILL_CATALOG,
            self._managed_vars,
        )

        self._update_count()

        # Bottom buttons
        btn_frame = tk.Frame(self, bg=BG)
        btn_frame.pack(fill="x", padx=16, pady=(0, 12))

        tk.Button(
            btn_frame,
            text="确认",
            command=self._on_ok,
            bg=ACCENT,
            fg="#ffffff",
            font=("Segoe UI", 11, "bold"),
            bd=0,
            padx=24,
            pady=6,
            cursor="hand2",
            relief="flat",
        ).pack(side="right", padx=(6, 0))

        tk.Button(
            btn_frame,
            text="取消",
            command=self._on_cancel,
            bg=BG_CARD,
            fg=FG,
            font=("Segoe UI", 11),
            bd=1,
            relief="solid",
            padx=24,
            pady=6,
            cursor="hand2",
        ).pack(side="right")

    def _add_section(
        self,
        parent: tk.Frame,
        title: str,
        color: str,
        skills: list[str],
        preselected: set[str],
        catalog: dict,
        vars_dict: dict[str, tk.BooleanVar],
    ):
        tk.Label(
            parent, text=title, font=("Segoe UI", 10, "bold"), bg=BG, fg=color, anchor="w"
        ).pack(fill="x", pady=(8, 4))

        for name in skills:
            info = catalog[name]
            var = tk.BooleanVar(value=name in preselected)
            var.trace_add("write", lambda *_: self._update_count())
            vars_dict[name] = var

            row = tk.Frame(parent, bg=BG)
            row.pack(fill="x", pady=1)

            cb = tk.Checkbutton(
                row, variable=var, bg=BG, activebackground=BG, highlightthickness=0, bd=0
            )
            cb.pack(side="left")

            tk.Label(
                row, text=name, font=("Consolas", 10), bg=BG, fg=FG, width=22, anchor="w"
            ).pack(side="left")

            tk.Label(
                row, text=info["description"], font=("Segoe UI", 9), bg=BG, fg=FG_DIM, anchor="w"
            ).pack(side="left", fill="x")

    # ── Toolbar actions ──

    def _select_windows(self):
        windows = get_windows_skills()
        for name, var in self._vars.items():
            var.set(name in windows)
        windows_managed = get_windows_managed_skills()
        for name, var in self._managed_vars.items():
            var.set(name in windows_managed)

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

    def _update_count(self):
        nb = sum(1 for v in self._vars.values() if v.get())
        nm = sum(1 for v in self._managed_vars.values() if v.get())
        total = len(self._vars) + len(self._managed_vars)
        self._count_label.config(text=f"已选 {nb + nm}/{total} 个技能")

    # ── Dialog result ──

    def _on_ok(self):
        self.result = sorted(name for name, var in self._vars.items() if var.get())
        self.managed_result = sorted(name for name, var in self._managed_vars.items() if var.get())
        self.grab_release()
        self.destroy()

    def _on_cancel(self):
        self.result = None
        self.managed_result = None
        self.grab_release()
        self.destroy()
