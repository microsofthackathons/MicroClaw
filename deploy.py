#!/usr/bin/env python3
"""
MicroClaw Deployer — Microsoft Fluent-style installer
======================================================
3-step wizard: Welcome → Select Skills → Installation.
Clean white card UI, centred on screen, matching Fluent Design 2.
"""

import os
import shutil
import subprocess
import sys
import threading
import tkinter as tk
import tkinter.font as tkfont
import traceback
from pathlib import Path
from tkinter import filedialog, messagebox

from deployer.config import DeployerConfig
from deployer.install_timing import InstallTiming
from deployer.logger import DeployerLogger
from deployer.webview_bridge import InstallationCancelled, run_web_installer
from deployer.windows_setup import (
    DEFAULT_DESKTOP_DIR,
    DEFAULT_NODE_DIR,
    ActiveInstallation,
    WindowsSetup,
)

# ═══════════════════════════════════════════════════════════════
# Fluent Design palette
# ═══════════════════════════════════════════════════════════════
WINDOW_BG = "#ffffff"
CARD_BG = "#ffffff"
TEXT_PRIMARY = "#1a1a1a"
TEXT_SECONDARY = "#666666"
TEXT_MUTED = "#888888"
FIELD_BG = "#f5f5f5"
FIELD_BORDER = "#e0e0e0"
BTN_PRIMARY_BG = "#1a1a1a"
BTN_PRIMARY_FG = "#ffffff"
BTN_HOVER_BG = "#333333"
ACCENT_BLUE = "#0078d4"
SPINNER_BLUE = "#0078d4"
LINK_BLUE = "#0067b8"
DIVIDER = "#e0e0e0"
SUCCESS_COLOR = "#107c10"
ERROR_COLOR = "#c42b1c"

MS_RED = "#F25022"
MS_GREEN = "#7FBA00"
MS_BLUE = "#00A4EF"
MS_YELLOW = "#FFB900"

WINDOW_BORDER = "#c0c0c0"
TRANSPARENT_KEY = "#FF00FF"

WIN_WIDTH = 580
WIN_HEIGHT = 640
UNINSTALL_WIN_WIDTH = 700
UNINSTALL_WIN_HEIGHT = 540


# ═══════════════════════════════════════════════════════════════
# Windows taskbar setup
# ═══════════════════════════════════════════════════════════════
def _setup_windows_taskbar():
    import ctypes

    try:
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID(
            "ai.openclaw.microclaw.installer"
        )
    except Exception:
        pass
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)  # Per-Monitor DPI V2
    except Exception:
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(1)
        except Exception:
            try:
                ctypes.windll.user32.SetProcessDPIAware()
            except Exception:
                pass


def _apply_rounded_region(tk_window, radius=16):
    """Set a rounded-rectangle window region using Win32 CreateRoundRectRgn.

    This works reliably on both Windows 10 and 11 with overrideredirect(True).
    """
    try:
        import ctypes

        hwnd = ctypes.windll.user32.GetParent(tk_window.winfo_id())
        w = tk_window.winfo_width()
        h = tk_window.winfo_height()
        rgn = ctypes.windll.gdi32.CreateRoundRectRgn(0, 0, w + 1, h + 1, radius, radius)
        ctypes.windll.user32.SetWindowRgn(hwnd, rgn, True)
    except Exception:
        pass


# ═══════════════════════════════════════════════════════════════
# Rounded rectangle helper for Canvas
# ═══════════════════════════════════════════════════════════════
def _rounded_rect(canvas, x1, y1, x2, y2, r=10, **kwargs):
    """Draw a rounded rectangle on a tk.Canvas."""
    points = [
        x1 + r,
        y1,
        x2 - r,
        y1,
        x2,
        y1,
        x2,
        y1 + r,
        x2,
        y2 - r,
        x2,
        y2,
        x2 - r,
        y2,
        x1 + r,
        y2,
        x1,
        y2,
        x1,
        y2 - r,
        x1,
        y1 + r,
        x1,
        y1,
        x1 + r,
        y1,
    ]
    return canvas.create_polygon(points, smooth=True, **kwargs)


# ═══════════════════════════════════════════════════════════════
# Main Application — Fluent Installer
# ═══════════════════════════════════════════════════════════════
class DeployerApp(tk.Tk):
    def __init__(self, auto_uninstall: bool = False):
        super().__init__()
        self._auto_uninstall = auto_uninstall

        # DPI-aware scaling — fonts auto-scale via point sizes,
        # but pixel dimensions (window, canvas, padding) must be
        # multiplied by the DPI factor so the UI fits at 125%/150%/etc.
        self._dpi_scale = self._get_dpi_scale()

        base_win_w = UNINSTALL_WIN_WIDTH if self._auto_uninstall else WIN_WIDTH
        base_win_h = UNINSTALL_WIN_HEIGHT if self._auto_uninstall else WIN_HEIGHT
        self._win_w = self._s(base_win_w)
        self._win_h = self._s(base_win_h)

        self.title("MicroClaw")
        self.configure(bg=CARD_BG)
        self.geometry(f"{self._win_w}x{self._win_h}")
        self.resizable(False, False)
        self.withdraw()  # hide until frameless setup is done
        self._set_icon()

        self.config = DeployerConfig()
        self.logger = DeployerLogger()
        self._running = False
        self._failed = False
        self._current_page = 0
        self._install_pct = 0
        self._drag_x = 0
        self._drag_y = 0

        # State
        self._default_install_dir = str(DEFAULT_DESKTOP_DIR)
        self._default_allow_read = True
        self._install_dir_var = tk.StringVar(value=self._default_install_dir)
        self._allow_read_var = tk.BooleanVar(value=self._default_allow_read)

        self._init_fonts()
        self._build_ui()
        self._show_page(0)

        # Centre on screen
        self.update_idletasks()
        sw = self.winfo_screenwidth()
        sh = self.winfo_screenheight()
        x = (sw - self._win_w) // 2
        y = (sh - self._win_h) // 2
        self.geometry(f"+{x}+{y}")

        if self._auto_uninstall:
            # Uninstall mode: keep window hidden, show only the confirm dialog.
            # The main window appears only after the user confirms.
            self.after(100, self._on_uninstall)
        else:
            # Normal install mode: show the frameless window now
            self._apply_frameless()

    # ─────────────────────────────────────────────────────
    # DPI helpers
    # ─────────────────────────────────────────────────────
    def _get_dpi_scale(self) -> float:
        """Return DPI scale factor relative to 96 DPI (100%)."""
        try:
            dpi = self.winfo_fpixels("1i")  # pixels per inch on this monitor
            return dpi / 96.0
        except Exception:
            return 1.0

    def _s(self, px) -> int:
        """Scale a pixel value by DPI factor."""
        return round(px * self._dpi_scale)

    # ─────────────────────────────────────────────────────
    # Fonts
    # ─────────────────────────────────────────────────────
    def _init_fonts(self):
        self._font_title = tkfont.Font(family="Segoe UI", size=20, weight="bold")
        self._font_subtitle = tkfont.Font(family="Segoe UI", size=11)
        self._font_body = tkfont.Font(family="Segoe UI", size=10)
        self._font_small = tkfont.Font(family="Segoe UI", size=9)
        self._font_btn = tkfont.Font(family="Segoe UI", size=12, weight="bold")
        self._font_card = tkfont.Font(family="Segoe UI", size=10, weight="bold")
        self._font_card_icon = tkfont.Font(family="Segoe UI", size=13)
        self._font_section = tkfont.Font(family="Segoe UI", size=9)
        self._font_pct = tkfont.Font(family="Segoe UI", size=14)
        self._font_link = tkfont.Font(family="Segoe UI", size=9)
        self._font_checkbox = tkfont.Font(family="Segoe UI", size=10)
        self._font_chrome = tkfont.Font(family="Segoe UI", size=11)

    # ─────────────────────────────────────────────────────
    # Frameless window setup
    # ─────────────────────────────────────────────────────
    def _apply_frameless(self):
        """Strip the native title bar, apply rounded corners, then show.

        The window is `withdraw()`-ed before this method runs so that
        the user never sees the native title-bar flash.
        """
        self.overrideredirect(True)
        self.update_idletasks()

        # Force taskbar icon back (overrideredirect removes it)
        try:
            import ctypes

            GWL_EXSTYLE = -20
            WS_EX_APPWINDOW = 0x00040000
            WS_EX_TOOLWINDOW = 0x00000080
            hwnd = ctypes.windll.user32.GetParent(self.winfo_id())
            style = ctypes.windll.user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
            style = (style | WS_EX_APPWINDOW) & ~WS_EX_TOOLWINDOW
            ctypes.windll.user32.SetWindowLongW(hwnd, GWL_EXSTYLE, style)
        except Exception:
            pass

        # Centre
        sw = self.winfo_screenwidth()
        sh = self.winfo_screenheight()
        x = (sw - self._win_w) // 2
        y = (sh - self._win_h) // 2
        self.geometry(f"{self._win_w}x{self._win_h}+{x}+{y}")

        # Now show the fully-styled frameless window
        self.deiconify()
        self.update_idletasks()
        self.wm_attributes("-transparentcolor", TRANSPARENT_KEY)

    def _start_drag(self, event):
        self._drag_x = event.x
        self._drag_y = event.y

    def _do_drag(self, event):
        x = self.winfo_x() + (event.x - self._drag_x)
        y = self.winfo_y() + (event.y - self._drag_y)
        self.geometry(f"+{x}+{y}")

    def _minimize_window(self):
        # overrideredirect windows can't use iconify directly on some systems
        try:
            import ctypes

            hwnd = ctypes.windll.user32.GetParent(self.winfo_id())
            ctypes.windll.user32.ShowWindow(hwnd, 6)  # SW_MINIMIZE
        except Exception:
            self.withdraw()
            self.after(200, self.deiconify)

    def _close_window(self):
        if self._running:
            self._running = False
        self.destroy()

    # ─────────────────────────────────────────────────────
    # Build UI — one frame per page inside a card
    # ─────────────────────────────────────────────────────
    def _build_ui(self):
        # Transparent window bg — corners outside the rounded card become invisible
        self.configure(bg=TRANSPARENT_KEY)

        # Full-window canvas draws rounded card fill + border;
        # corners outside the rounded rect stay TRANSPARENT_KEY → invisible.
        border_r = self._s(18)
        card_inset = self._s(6)
        self._bg_canvas = tk.Canvas(
            self,
            width=self._win_w,
            height=self._win_h,
            bg=TRANSPARENT_KEY,
            highlightthickness=0,
            bd=0,
        )
        self._bg_canvas.place(x=0, y=0)
        _rounded_rect(
            self._bg_canvas,
            1,
            1,
            self._win_w - 1,
            self._win_h - 1,
            r=border_r,
            fill=CARD_BG,
            outline=WINDOW_BORDER,
            width=1,
        )

        # Drag support on canvas background (border / corner area)
        self._bg_canvas.bind("<Button-1>", self._start_drag)
        self._bg_canvas.bind("<B1-Motion>", self._do_drag)

        # Main card container — embedded in canvas, inset so its sharp
        # corners stay inside the rounded border.
        self._card = tk.Frame(self._bg_canvas, bg=CARD_BG, bd=0, highlightthickness=0)
        self._bg_canvas.create_window(
            card_inset,
            card_inset,
            anchor="nw",
            window=self._card,
            width=self._win_w - 2 * card_inset,
            height=self._win_h - 2 * card_inset,
        )

        # Custom window chrome: drag area + minimize/close buttons
        chrome = tk.Frame(self._card, bg=CARD_BG, height=self._s(40))
        chrome.pack(fill="x", side="top")
        chrome.pack_propagate(False)

        # Drag area (most of the top)
        drag_area = tk.Frame(chrome, bg=CARD_BG)
        drag_area.pack(side="left", fill="both", expand=True)
        drag_area.bind("<Button-1>", self._start_drag)
        drag_area.bind("<B1-Motion>", self._do_drag)

        # Close button (×)
        close_btn = tk.Label(
            chrome,
            text="\u00d7",
            font=self._font_chrome,
            bg=CARD_BG,
            fg="#666666",
            cursor="hand2",
            width=4,
            anchor="center",
        )
        close_btn.pack(side="right", fill="y")
        close_btn.bind("<Button-1>", lambda e: self._close_window())
        close_btn.bind("<Enter>", lambda e: close_btn.config(bg="#e81123", fg="#ffffff"))
        close_btn.bind("<Leave>", lambda e: close_btn.config(bg=CARD_BG, fg="#666666"))

        # Minimize button (−)
        min_btn = tk.Label(
            chrome,
            text="\u2212",
            font=self._font_chrome,
            bg=CARD_BG,
            fg="#666666",
            cursor="hand2",
            width=4,
            anchor="center",
        )
        min_btn.pack(side="right", fill="y")
        min_btn.bind("<Button-1>", lambda e: self._minimize_window())
        min_btn.bind("<Enter>", lambda e: min_btn.config(bg="#e5e5e5"))
        min_btn.bind("<Leave>", lambda e: min_btn.config(bg=CARD_BG))

        # Page content area (below chrome)
        self._content = tk.Frame(self._card, bg=CARD_BG)
        self._content.pack(fill="both", expand=True)

        self._pages: list[tk.Frame] = []
        self._build_welcome_page()
        self._build_skills_page()
        self._build_install_page()
        self._build_complete_page()

    # ─────── Page 0: Welcome ─────────────────────────────
    def _build_welcome_page(self):
        page = tk.Frame(self._content, bg=CARD_BG)

        # Microsoft 4-colour logo (larger, 48x48 with 3px gap)
        logo_sz = self._s(48)
        logo_half = self._s(22)
        logo_gap = self._s(26)
        logo_canvas = tk.Canvas(
            page, width=logo_sz, height=logo_sz, bg=CARD_BG, highlightthickness=0
        )
        logo_canvas.pack(pady=(self._s(16), 0))
        logo_canvas.create_rectangle(0, 0, logo_half, logo_half, fill=MS_RED, outline="")
        logo_canvas.create_rectangle(logo_gap, 0, logo_sz, logo_half, fill=MS_GREEN, outline="")
        logo_canvas.create_rectangle(0, logo_gap, logo_half, logo_sz, fill=MS_BLUE, outline="")
        logo_canvas.create_rectangle(
            logo_gap, logo_gap, logo_sz, logo_sz, fill=MS_YELLOW, outline=""
        )

        # Title
        tk.Label(
            page, text="Welcome to MicroClaw", font=self._font_title, bg=CARD_BG, fg=TEXT_PRIMARY
        ).pack(pady=(self._s(24), self._s(10)))

        # Subtitle
        tk.Label(
            page,
            text=(
                "This will install the MicroClaw desktop app\n"
                "and configure skills, sandbox, and plugins."
            ),
            font=self._font_subtitle,
            bg=CARD_BG,
            fg=TEXT_SECONDARY,
            justify="center",
        ).pack(pady=(0, self._s(28)))

        # Path input row — drawn as rounded rect on canvas
        pad_x = self._s(44)
        path_h = self._s(52)
        path_w = self._win_w - self._s(88)
        path_canvas = tk.Canvas(page, width=path_w, height=path_h, bg=CARD_BG, highlightthickness=0)
        path_canvas.pack(padx=pad_x, pady=(0, self._s(28)))
        _rounded_rect(
            path_canvas,
            0,
            0,
            path_w,
            path_h,
            r=self._s(20),
            fill=FIELD_BG,
            outline=FIELD_BORDER,
            width=1,
        )

        path_inner = tk.Frame(path_canvas, bg=FIELD_BG, bd=0, highlightthickness=0)
        path_canvas.create_window(
            self._s(14), path_h // 2, window=path_inner, anchor="w", width=path_w - self._s(56)
        )

        self._path_entry = tk.Entry(
            path_inner,
            textvariable=self._install_dir_var,
            font=self._font_body,
            bg=FIELD_BG,
            fg=TEXT_PRIMARY,
            bd=0,
            highlightthickness=0,
            insertbackground=TEXT_PRIMARY,
        )
        self._path_entry.pack(side="left", fill="x", expand=True)

        browse_btn = tk.Label(
            path_canvas,
            text="\U0001f4c2",
            font=self._font_card_icon,
            bg=FIELD_BG,
            fg=TEXT_SECONDARY,
            cursor="hand2",
        )
        path_canvas.create_window(path_w - self._s(16), path_h // 2, window=browse_btn, anchor="e")
        browse_btn.bind("<Button-1>", lambda e: self._browse_install_dir())

        # Continue button (full width minus padding)
        btn_w = self._win_w - self._s(88)
        btn_h = self._s(52)
        self._continue_btn = tk.Canvas(
            page, width=btn_w, height=btn_h, bg=CARD_BG, highlightthickness=0, cursor="hand2"
        )
        self._continue_btn.pack(padx=pad_x, pady=(0, self._s(20)))
        self._draw_primary_button(self._continue_btn, btn_w, btn_h, "Install", self._on_continue)

        # Checkbox row
        check_frame = tk.Frame(page, bg=CARD_BG)
        check_frame.pack(fill="x", padx=pad_x, pady=(0, self._s(20)))

        chk_sz = self._s(20)
        self._check_canvas = tk.Canvas(
            check_frame,
            width=chk_sz,
            height=chk_sz,
            bg=CARD_BG,
            highlightthickness=0,
            cursor="hand2",
        )
        self._check_canvas.pack(side="left")
        self._check_canvas.bind("<Button-1>", self._toggle_allow_read)
        self._draw_checkbox(self._check_canvas, self._allow_read_var.get())

        tk.Label(
            check_frame,
            text="Allow MicroClaw to read all files in its installation folder",
            font=self._font_checkbox,
            bg=CARD_BG,
            fg=TEXT_PRIMARY,
            cursor="hand2",
            anchor="w",
            justify="left",
            wraplength=self._win_w - self._s(88) - chk_sz - self._s(10),
        ).pack(side="left", padx=(self._s(10), 0))

        # Legal footer — two-line centered text
        legal_frame = tk.Frame(page, bg=CARD_BG)
        legal_frame.pack(side="bottom", pady=(0, self._s(32)))

        row1 = tk.Frame(legal_frame, bg=CARD_BG)
        row1.pack()
        tk.Label(
            row1,
            text="By clicking Continue, you agree to the ",
            font=self._font_small,
            bg=CARD_BG,
            fg=TEXT_SECONDARY,
        ).pack(side="left")
        tk.Label(
            row1,
            text="MicroClaw service",
            font=self._font_small,
            bg=CARD_BG,
            fg=LINK_BLUE,
            cursor="hand2",
        ).pack(side="left")

        row2 = tk.Frame(legal_frame, bg=CARD_BG)
        row2.pack()
        tk.Label(
            row2, text="agreement", font=self._font_small, bg=CARD_BG, fg=LINK_BLUE, cursor="hand2"
        ).pack(side="left")
        tk.Label(row2, text=" and ", font=self._font_small, bg=CARD_BG, fg=TEXT_SECONDARY).pack(
            side="left"
        )
        tk.Label(
            row2,
            text="Privacy Statement",
            font=self._font_small,
            bg=CARD_BG,
            fg=LINK_BLUE,
            cursor="hand2",
        ).pack(side="left")
        tk.Label(row2, text=".", font=self._font_small, bg=CARD_BG, fg=TEXT_SECONDARY).pack(
            side="left"
        )

        # Uninstall link (subtle, bottom-left)
        uninstall_lbl = tk.Label(
            legal_frame,
            text="Uninstall MicroClaw",
            font=self._font_small,
            bg=CARD_BG,
            fg=TEXT_MUTED,
            cursor="hand2",
        )
        uninstall_lbl.pack(pady=(self._s(8), 0))
        uninstall_lbl.bind("<Enter>", lambda e: uninstall_lbl.config(fg=ERROR_COLOR))
        uninstall_lbl.bind("<Leave>", lambda e: uninstall_lbl.config(fg=TEXT_MUTED))
        uninstall_lbl.bind("<Button-1>", lambda e: self._on_uninstall())

        self._pages.append(page)

    # ─────── Page 1: (placeholder, not shown) ──────────────
    def _build_skills_page(self):
        page = tk.Frame(self._content, bg=CARD_BG)
        self._pages.append(page)

    # ─────── Page 2: Installation Progress ────────────────
    def _build_install_page(self):
        page = tk.Frame(self._content, bg=CARD_BG)

        # Title
        self._install_title = tk.Label(
            page, text="Installation", font=self._font_title, bg=CARD_BG, fg=TEXT_PRIMARY
        )
        self._install_title.pack(pady=(self._s(48), 0))

        # Spinner canvas (circular arc)
        spinner_sz = self._s(80)
        self._spinner_canvas = tk.Canvas(
            page, width=spinner_sz, height=spinner_sz, bg=CARD_BG, highlightthickness=0
        )
        self._spinner_canvas.pack(pady=(self._s(60), self._s(12)))
        self._spinner_angle = 0
        self._spinner_running = False

        # Percentage
        self._pct_label = tk.Label(
            page, text="0%", font=self._font_pct, bg=CARD_BG, fg=TEXT_SECONDARY
        )
        self._pct_label.pack()

        # Status detail (small, below pct)
        self._status_label = tk.Label(
            page, text="", font=self._font_small, bg=CARD_BG, fg=TEXT_MUTED
        )
        self._status_label.pack(pady=(self._s(8), 0))

        # Cancel button (bottom right, subtle)
        cancel_frame = tk.Frame(page, bg=CARD_BG)
        cancel_frame.pack(side="bottom", fill="x", padx=self._s(24), pady=(0, self._s(20)))
        self._cancel_install_label = tk.Label(
            cancel_frame,
            text="Cancel",
            font=self._font_small,
            bg=CARD_BG,
            fg=TEXT_MUTED,
            cursor="hand2",
        )
        self._cancel_install_label.pack(side="right")
        self._cancel_install_label.bind("<Button-1>", lambda e: self._on_cancel_install())

        self._pages.append(page)

    # ─────── Page 3: Complete ─────────────────────────────
    def _build_complete_page(self):
        page = tk.Frame(self._content, bg=CARD_BG)

        self._complete_icon_label = tk.Label(
            page,
            text="\u2714",
            font=tkfont.Font(family="Segoe UI", size=40),
            bg=CARD_BG,
            fg=SUCCESS_COLOR,
        )
        self._complete_icon_label.pack(pady=(self._s(60), self._s(12)))

        self._complete_title = tk.Label(
            page, text="Installation Complete", font=self._font_title, bg=CARD_BG, fg=TEXT_PRIMARY
        )
        self._complete_title.pack(pady=(0, self._s(8)))

        self._complete_msg = tk.Label(
            page,
            text="MicroClaw has been installed successfully.",
            font=self._font_subtitle,
            bg=CARD_BG,
            fg=TEXT_SECONDARY,
            justify="center",
            wraplength=self._s(380),
        )
        self._complete_msg.pack(pady=(0, self._s(24)))

        self._complete_log_link = tk.Label(
            page, text="View Log", font=self._font_small, bg=CARD_BG, fg=LINK_BLUE, cursor="hand2"
        )
        self._complete_log_link.bind("<Button-1>", lambda e: self._open_log_file())

        self._launch_var = tk.BooleanVar(value=True)
        self._launch_check = tk.Checkbutton(
            page,
            text="Launch MicroClaw",
            variable=self._launch_var,
            font=self._font_body,
            bg=CARD_BG,
            fg=TEXT_PRIMARY,
            activebackground=CARD_BG,
            selectcolor=CARD_BG,
        )
        self._launch_check.pack()

        # Finish button
        btn_frame = tk.Frame(page, bg=CARD_BG)
        btn_frame.pack(side="bottom", fill="x", padx=self._s(44), pady=(0, self._s(32)))
        btn_w = self._win_w - self._s(88)
        btn_h = self._s(52)
        self._finish_btn = tk.Canvas(
            btn_frame, width=btn_w, height=btn_h, bg=CARD_BG, highlightthickness=0, cursor="hand2"
        )
        self._finish_btn.pack()
        self._draw_primary_button(self._finish_btn, btn_w, btn_h, "Finish", self._on_finish)

        self._pages.append(page)

    # ─────────────────────────────────────────────────────
    # UI helpers
    # ─────────────────────────────────────────────────────

    def _draw_primary_button(self, canvas: tk.Canvas, w: int, h: int, text: str, command):
        """Draw a dark rounded-rectangle primary button on a Canvas."""
        r = self._s(20)
        canvas.delete("all")
        _rounded_rect(canvas, 0, 0, w, h, r=r, fill=BTN_PRIMARY_BG, outline="")
        canvas.create_text(w // 2, h // 2, text=text, font=self._font_btn, fill=BTN_PRIMARY_FG)
        canvas.bind("<Button-1>", lambda e: command())

        def _enter(e):
            canvas.delete("all")
            _rounded_rect(canvas, 0, 0, w, h, r=r, fill=BTN_HOVER_BG, outline="")
            canvas.create_text(w // 2, h // 2, text=text, font=self._font_btn, fill=BTN_PRIMARY_FG)

        def _leave(e):
            canvas.delete("all")
            _rounded_rect(canvas, 0, 0, w, h, r=r, fill=BTN_PRIMARY_BG, outline="")
            canvas.create_text(w // 2, h // 2, text=text, font=self._font_btn, fill=BTN_PRIMARY_FG)

        canvas.bind("<Enter>", _enter)
        canvas.bind("<Leave>", _leave)

    def _draw_checkbox(self, canvas: tk.Canvas, checked: bool):
        sz = self._s(20)
        canvas.delete("all")
        if checked:
            _rounded_rect(canvas, 0, 0, sz, sz, r=self._s(4), fill=ACCENT_BLUE, outline="")
            canvas.create_text(
                sz // 2,
                sz // 2,
                text="\u2713",
                fill="white",
                font=tkfont.Font(family="Segoe UI", size=10, weight="bold"),
            )
        else:
            _rounded_rect(
                canvas, 0, 0, sz, sz, r=self._s(4), fill="", outline=FIELD_BORDER, width=1.5
            )

    def _toggle_allow_read(self, event=None):
        val = not self._allow_read_var.get()
        self._allow_read_var.set(val)
        self._draw_checkbox(self._check_canvas, val)

    def _add_section_divider(self, parent: tk.Frame, label: str):
        """Create a '── Label ──' style divider."""
        div_frame = tk.Frame(parent, bg=CARD_BG)
        div_frame.pack(fill="x", pady=(8, 10))

        left_line = tk.Frame(div_frame, bg=DIVIDER, height=1)
        left_line.pack(side="left", fill="x", expand=True, pady=8)
        tk.Label(div_frame, text=label, font=self._font_section, bg=CARD_BG, fg=TEXT_MUTED).pack(
            side="left", padx=12
        )
        right_line = tk.Frame(div_frame, bg=DIVIDER, height=1)
        right_line.pack(side="left", fill="x", expand=True, pady=8)

    def _create_skill_check_card(
        self, parent: tk.Frame, name: str, description: str, var: tk.BooleanVar, dark: bool
    ) -> tk.Frame:
        """Create a compact skill card with a checkbox-style toggle."""
        bg = BTN_PRIMARY_BG if (dark and var.get()) else ("#fafafa" if not dark else CARD_BG)
        fg = BTN_PRIMARY_FG if (dark and var.get()) else TEXT_PRIMARY

        frame = tk.Frame(
            parent,
            bg=bg,
            cursor="hand2",
            highlightbackground=FIELD_BORDER,
            highlightthickness=1 if not (dark and var.get()) else 0,
        )

        # Checkbox indicator
        check_lbl = tk.Label(
            frame, text="\u2713" if var.get() else " ", font=self._font_small, bg=bg, fg=fg, width=2
        )
        check_lbl.pack(side="left", padx=(8, 0), pady=10)

        # Skill name
        name_lbl = tk.Label(frame, text=name, font=self._font_card, bg=bg, fg=fg, anchor="w")
        name_lbl.pack(side="left", fill="x", expand=True, padx=(4, 8), pady=10)

        def _toggle(e=None):
            val = not var.get()
            var.set(val)
            if dark:
                new_bg = BTN_PRIMARY_BG if val else CARD_BG
                new_fg = BTN_PRIMARY_FG if val else TEXT_PRIMARY
                frame.config(bg=new_bg, highlightthickness=0 if val else 1)
            else:
                new_bg = "#fafafa"
                new_fg = TEXT_PRIMARY
                frame.config(bg=new_bg)
            check_lbl.config(text="\u2713" if val else " ", bg=new_bg, fg=new_fg)
            name_lbl.config(bg=new_bg, fg=new_fg)

        frame.bind("<Button-1>", _toggle)
        check_lbl.bind("<Button-1>", _toggle)
        name_lbl.bind("<Button-1>", _toggle)
        return frame

    # ─────────────────────────────────────────────────────
    # Spinner animation
    # ─────────────────────────────────────────────────────
    def _start_spinner(self):
        self._spinner_running = True
        self._animate_spinner()

    def _stop_spinner(self):
        self._spinner_running = False

    def _animate_spinner(self):
        if not self._spinner_running:
            return
        c = self._spinner_canvas
        c.delete("all")
        cx = cy = self._s(40)
        r = self._s(28)
        lw = max(2, self._s(4))
        # Track ring (light grey)
        c.create_oval(cx - r, cy - r, cx + r, cy + r, outline="#e8e8e8", width=lw)
        # Arc (blue, 270-degree sweep)
        c.create_arc(
            cx - r,
            cy - r,
            cx + r,
            cy + r,
            start=self._spinner_angle,
            extent=270,
            outline=SPINNER_BLUE,
            width=lw,
            style="arc",
        )
        self._spinner_angle = (self._spinner_angle - 8) % 360
        self.after(30, self._animate_spinner)

    # ─────────────────────────────────────────────────────
    # Page navigation
    # ─────────────────────────────────────────────────────
    def _show_page(self, idx: int):
        for p in self._pages:
            p.place_forget()
        self._current_page = idx
        self._pages[idx].place(x=0, y=0, relwidth=1, relheight=1)

    def _on_continue(self):
        self._on_start_install()

    def _on_finish(self):
        self.destroy()

    def _open_log_file(self):
        try:
            os.startfile(str(self.logger.log_file))
        except Exception:
            pass

    def _on_cancel_install(self):
        if self._running:
            self._running = False
            self._cancel_install_label.config(text="Cancelling...", fg=TEXT_MUTED)

    # ─────────────────────────────────────────────────────
    # Config helpers
    # ─────────────────────────────────────────────────────
    def _browse_install_dir(self):
        d = filedialog.askdirectory(
            title="Select install location", initialdir=self._install_dir_var.get()
        )
        if d:
            self._install_dir_var.set(d)

    # ─────────────────────────────────────────────────────
    # Install
    # ─────────────────────────────────────────────────────
    def _on_start_install(self):
        if self._running:
            return
        self._running = True
        self._failed = False

        self._show_page(2)
        self._start_spinner()

        threading.Thread(target=self._install_thread, daemon=True).start()

    def _set_progress(self, pct: int, text: str):
        def _do():
            self._install_pct = pct
            self._pct_label.config(text=f"{pct}%")
            self._status_label.config(text=text)

        self.after(0, _do)

    def _append_log_line(self, line: str):
        # In Fluent mode, logs go to the logger file; status_label shows current step
        pass

    def _build_install_steps(self, ws):
        return [
            # ── Third-party dependencies (previously done by setup.bat) ──
            (3, "Configuring PowerShell execution policy...", ws.ensure_execution_policy),
            # Apply Defender exclusions early so later IO-heavy steps aren't AV-scanned.
            (6, "Adding Defender exclusions...", ws.ensure_defender_exclusions),
            (10, "Installing Git...", ws.ensure_git),
            (18, "Preparing OpenClaw upgrade...", lambda: self._prepare_upgrade(ws)),
            (25, "Installing Node.js...", lambda: self._ensure_node(ws)),
            (35, "Configuring npm registry...", ws.setup_npm_mirror),
            (50, "Installing OpenClaw gateway...", lambda: self._ensure_openclaw(ws)),
            (55, "Updating PATH...", ws.add_to_path),
            # ── MicroClaw components ──
            (60, "Installing desktop client...", ws.install_desktop_client),
            (62, "Copying bundled assets...", lambda: self._copy_bundled_assets(ws)),
            (65, "Writing API keys...", lambda: self._write_env_file()),
            (70, "Writing OpenClaw configuration...", ws.write_config),
            (80, "Installing web search provider...", ws.install_search_provider_plugin),
            (85, "Provisioning AppContainer sandbox...", ws.provision_appcontainer),
            (90, "Installing WeChat plugin...", ws.install_weixin_plugin),
            (94, "Validating OpenClaw upgrade...", ws.verify_openclaw_upgrade),
            (95, "Installing uninstaller...", ws.install_uninstaller_bundle),
            (97, "Creating desktop shortcut...", ws.create_desktop_shortcut),
            (98, "Committing OpenClaw upgrade...", ws.commit_openclaw_upgrade),
        ]

    def _install_thread(self):
        log = self.logger
        timing = InstallTiming(log)
        ws = WindowsSetup(self.config, log)
        steps = self._build_install_steps(ws)

        for pct, label, fn in steps:
            if not self._running:
                self._set_progress(pct, "Installation cancelled.")
                rollback_ok = ws.rollback_openclaw_upgrade()
                if not rollback_ok:
                    log.error("Automatic OpenClaw rollback failed after cancellation")
                suffix = "" if rollback_ok else " Automatic rollback also failed."
                message = f"Installation cancelled.{suffix}"
                self.after(0, lambda text=message: self._finish_fail(text))
                self._running = False
                timing.finish("cancelled")
                return

            self._set_progress(pct, label)
            started_at = timing.start_step()
            try:
                result = fn()
                if result is not None and not result:
                    timing.record_step(label, started_at, "failed")
                    rollback_ok = ws.rollback_openclaw_upgrade()
                    suffix = "" if rollback_ok else " Automatic rollback also failed."
                    self._finish_fail(label.rstrip(".") + f" failed.{suffix}")
                    self._running = False
                    timing.finish("failed")
                    return
            except InstallationCancelled:
                timing.record_step(label, started_at, "cancelled")
                self._running = False
                self.after(0, self._return_to_welcome)
                timing.finish("cancelled")
                return
            except Exception as e:
                timing.record_step(label, started_at, "failed")
                log.error(f"{label} exception: {e}")
                rollback_ok = ws.rollback_openclaw_upgrade()
                suffix = "" if rollback_ok else " Automatic rollback also failed."
                detail = str(e).strip() or label.rstrip(".") + " failed."
                self._finish_fail(f"{detail}{suffix}")
                self._running = False
                timing.finish("failed")
                return
            timing.record_step(label, started_at, "success")

        self._running = False
        timing.finish("success")
        self._finish_ok()

    def _prepare_upgrade(self, ws: WindowsSetup) -> bool:
        active = ws.get_active_installation()
        if active is not None:
            if not self._confirm_close_running_apps(active):
                raise InstallationCancelled
            if not ws.stop_active_installation_for_upgrade(active):
                raise RuntimeError(
                    "MicroClaw/OpenClaw could not be closed automatically. "
                    "Exit it from the system tray and retry."
                )
        return ws.prepare_openclaw_upgrade()

    def _confirm_close_running_apps(self, active: ActiveInstallation) -> bool:
        completed = threading.Event()
        confirmed = False

        def _show_prompt():
            nonlocal confirmed
            process = f" (PID {', '.join(map(str, active.pids))})" if active.pids else ""
            try:
                confirmed = messagebox.askyesno(
                    "MicroClaw must be closed",
                    f"MicroClaw or OpenClaw is currently running{process}. "
                    "Continuing will close the app and interrupt active tasks.\n\n"
                    "Close it and continue?",
                    icon="warning",
                    parent=self,
                )
            finally:
                completed.set()

        self.after(0, _show_prompt)
        completed.wait()
        return confirmed

    def _return_to_welcome(self):
        self._stop_spinner()
        self._show_page(0)

    def _ensure_node(self, ws) -> bool:
        """Install Node.js if the managed copy is missing/outdated."""
        if ws.check_node_windows():
            return True
        return ws.install_node_windows()

    def _ensure_openclaw(self, ws) -> bool:
        """Install OpenClaw Gateway if not already present."""
        if ws.check_openclaw_windows():
            return True
        return ws.install_openclaw_windows()

    def _copy_bundled_assets(self, ws) -> bool:
        """Copy bundled skills (and setup-dependencies.ps1 for reference) next
        to the installed desktop client."""
        import sys

        candidates = []
        if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
            candidates.append(Path(sys._MEIPASS) / "setup-dependencies.ps1")
        if getattr(sys, "frozen", False):
            candidates.append(Path(sys.executable).parent / "setup-dependencies.ps1")
        # Prefer canonical path; fall back to the root wrapper for older checkouts.
        candidates.append(Path(__file__).parent / "scripts" / "windows" / "setup-dependencies.ps1")
        candidates.append(Path(__file__).parent / "setup-dependencies.ps1")

        src = None
        for c in candidates:
            if c.exists():
                src = c
                break

        dest_dir = DEFAULT_DESKTOP_DIR
        dest_dir.mkdir(parents=True, exist_ok=True)
        if src:
            try:
                shutil.copy2(str(src), str(dest_dir / "setup-dependencies.ps1"))
                self.logger.info(f"Setup script copied to {dest_dir} (for reference)")
            except Exception as e:
                self.logger.warn(f"Could not copy setup script: {e}")

        # Also copy bundled skills directory if present
        skills_src = None
        skills_candidates = []
        if getattr(sys, "frozen", False) and hasattr(sys, "_MEIPASS"):
            skills_candidates.append(Path(sys._MEIPASS) / "skills")
        if getattr(sys, "frozen", False):
            skills_candidates.append(Path(sys.executable).parent / "skills")
        skills_candidates.append(Path(__file__).parent.parent / "skills")

        for c in skills_candidates:
            if c.is_dir():
                skills_src = c
                break

        if skills_src:
            dest_skills = dest_dir / "skills"
            try:
                if dest_skills.exists():
                    shutil.rmtree(dest_skills)
                shutil.copytree(str(skills_src), str(dest_skills))
                self.logger.info(f"  Skills copied to {dest_skills}")
            except Exception as e:
                self.logger.warn(f"  Could not copy skills: {e}")

        return True

    def _write_env_file(self) -> bool:
        """Write API keys from .env (next to installer) to ~/.openclaw/.env."""
        api_key = self.config.get("model.api_key", "")
        base_url = self.config.get("model.base_url", "")
        model_name = self.config.get("model.model_name", "")
        brave_key = self.config.get("brave.api_key", "")
        if not api_key and not brave_key:
            self.logger.info("No API keys found in .env — skipping")
            return True

        openclaw_dir = Path.home() / ".openclaw"
        openclaw_dir.mkdir(parents=True, exist_ok=True)
        env_path = openclaw_dir / ".env"

        # Preserve existing lines not being overwritten
        existing = {}
        if env_path.exists():
            try:
                for line in env_path.read_text(encoding="utf-8").splitlines():
                    line = line.strip()
                    if not line or line.startswith("#"):
                        continue
                    k, _, v = line.partition("=")
                    if k.strip():
                        existing[k.strip()] = v.strip()
            except Exception:
                pass

        if api_key:
            existing["MODEL_API_KEY"] = api_key
            existing["OPENCLAW_MODEL_API_KEY"] = api_key
        if base_url:
            existing["MODEL_BASE_URL"] = base_url
        if model_name:
            existing["MODEL_NAME"] = model_name
        if brave_key:
            existing["BRAVE_API_KEY"] = brave_key

        try:
            lines = [f"{k}={v}" for k, v in existing.items()]
            env_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
            self.logger.success(f"API keys written to {env_path}")
        except Exception as e:
            self.logger.warn(f"Could not write .env: {e}")
        return True

    def _finish_ok(self):
        def _do():
            self._stop_spinner()
            self._set_progress(100, "Installation complete.")
            self._complete_icon_label.config(text="\u2714", fg=SUCCESS_COLOR)
            self._complete_title.config(text="Installation Complete")
            self._complete_msg.config(
                text=(
                    "MicroClaw has been installed successfully.\n\n"
                    "Launch it from the desktop shortcut or\n"
                    "the Start menu to begin."
                )
            )
            self._complete_log_link.pack_forget()
            self._launch_check.pack_forget()
            self._draw_primary_button(
                self._finish_btn,
                self._finish_btn.winfo_reqwidth(),
                self._finish_btn.winfo_reqheight(),
                "Finish",
                self._on_finish,
            )
            self._show_page(3)

        self.after(0, _do)

    def _finish_fail(self, msg: str):
        def _do():
            self._failed = True
            self._stop_spinner()
            self._complete_icon_label.config(text="\u2716", fg=ERROR_COLOR)
            self._complete_title.config(text="Installation Failed")
            self._complete_msg.config(text=f"{msg}\n\nPlease check the logs and retry.")
            self._complete_log_link.pack(pady=(0, self._s(16)))
            self._launch_check.pack_forget()
            self._draw_primary_button(
                self._finish_btn,
                self._finish_btn.winfo_reqwidth(),
                self._finish_btn.winfo_reqheight(),
                "Close",
                self._on_finish,
            )
            self._show_page(3)

        self.after(0, _do)

    # ─────────────────────────────────────────────────────
    # Uninstall
    # ─────────────────────────────────────────────────────
    def _on_uninstall(self):
        if self._running:
            return
        confirmed = messagebox.askyesno(
            "Confirm Uninstall",
            "Are you sure you want to uninstall MicroClaw?\n\n"
            "This will stop all services and delete related files.",
            icon="warning",
        )
        if not confirmed:
            if self._auto_uninstall:
                self.destroy()
            return
        self._running = True

        # If launched via --uninstall shortcut, the main window is still
        # hidden — apply frameless chrome and show it now for the progress UI.
        if self._auto_uninstall:
            self._apply_frameless()

        self.title("Uninstalling MicroClaw")
        self._install_title.config(text="Uninstalling")
        self._status_label.config(text="Preparing to uninstall...")
        self._pct_label.config(text="0%")
        self._cancel_install_label.pack_forget()

        self._show_page(2)
        self._start_spinner()

        threading.Thread(target=self._uninstall_thread, daemon=True).start()

    def _uninstall_thread(self):
        log = self.logger
        ws = WindowsSetup(self.config, log)

        steps = [
            (5, "Stopping daemon...", ws._uninstall_stop_daemon),
            (10, "Stopping gateway...", ws._uninstall_stop_gateway),
            (15, "Closing desktop client...", ws._uninstall_kill_desktop),
            (25, "Uninstalling plugins...", ws._uninstall_plugins),
            (35, "Cleaning official client...", ws._uninstall_clean_official),
            (45, "Cleaning AppContainer...", ws._uninstall_appcontainer),
            (55, "Removing desktop client...", ws._uninstall_clean_desktop),
            (65, "Removing OpenClaw gateway...", ws._uninstall_npm),
            (75, "Removing Node.js...", ws._uninstall_clean_node),
            (82, "Removing Git...", ws._uninstall_clean_git),
            (90, "Cleaning configuration...", ws._uninstall_clean_openclaw_state),
            (95, "Deleting shortcuts...", ws._uninstall_clean_shortcuts),
        ]

        try:
            for pct, label, fn in steps:
                self._set_progress(pct, label)
                try:
                    fn()
                except Exception as e:
                    log.warn(f"{label} exception: {e}")

            self._running = False
            log.success("Uninstall complete")
            self._finish_uninstall_ok()
        except Exception as e:
            log.error(f"Uninstall exception: {e}")
            self._running = False
            self._finish_uninstall_fail(str(e))

    def _finish_uninstall_ok(self):
        def _do():
            self._stop_spinner()
            self._set_progress(100, "Uninstall complete.")
            self._complete_icon_label.config(text="\u2714", fg=SUCCESS_COLOR)
            self._complete_title.config(text="Uninstall Complete")
            self._complete_msg.config(text="MicroClaw has been removed from your computer.")
            self._launch_check.pack_forget()
            self._show_page(3)

        self.after(0, _do)

    def _finish_uninstall_fail(self, msg: str):
        def _do():
            self._stop_spinner()
            self._complete_icon_label.config(text="\u2716", fg=ERROR_COLOR)
            self._complete_title.config(text="Uninstall Failed")
            self._complete_msg.config(text=f"{msg}")
            self._launch_check.pack_forget()
            self._show_page(3)

        self.after(0, _do)

    # ─────────────────────────────────────────────────────
    # Verify
    # ─────────────────────────────────────────────────────
    def _verify(self) -> bool:
        cmd = self._find_openclaw_cmd()
        if not cmd:
            return False
        install_dir = (
            Path(self._install_dir_var.get().strip())
            if self._install_dir_var.get().strip()
            else DEFAULT_NODE_DIR
        )
        env = os.environ.copy()
        env["PATH"] = str(install_dir) + os.pathsep + env.get("PATH", "")
        api_key = self.config.get("model.api_key", "")
        if api_key:
            env["OPENCLAW_MODEL_API_KEY"] = api_key
        try:
            r = subprocess.run(
                cmd + ["--version"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=15,
                env=env,
                creationflags=0x08000000,
            )
            return r.returncode == 0 and bool(r.stdout.strip())
        except Exception:
            return False

    def _find_openclaw_cmd(self) -> list[str] | None:
        install_dir = (
            Path(self._install_dir_var.get().strip())
            if self._install_dir_var.get().strip()
            else DEFAULT_NODE_DIR
        )
        for name in ("openclaw.cmd", "openclaw"):
            p = install_dir / name
            if p.exists():
                return [str(p)]
        found = shutil.which("openclaw")
        if found:
            return [found]
        npm_prefix = Path.home() / "AppData" / "Roaming" / "npm"
        for name in ("openclaw.cmd", "openclaw"):
            p = npm_prefix / name
            if p.exists():
                return [str(p)]
        return None

    def _launch_desktop(self):
        desktop = None
        try:
            import winreg

            key = winreg.OpenKey(
                winreg.HKEY_CURRENT_USER,
                r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders",
            )
            desktop_val, _ = winreg.QueryValueEx(key, "Desktop")
            winreg.CloseKey(key)
            reg_desktop = Path(os.path.expandvars(desktop_val))
            if reg_desktop.exists():
                desktop = reg_desktop
        except Exception:
            pass
        if desktop is None:
            desktop = Path.home() / "Desktop"
        shortcut = desktop / "MicroClawDesktop.lnk"
        if shortcut.exists():
            try:
                os.startfile(str(shortcut))
            except Exception:
                pass

    # ─────────────────────────────────────────────────────
    # Resource loading
    # ─────────────────────────────────────────────────────
    def _set_icon(self):
        candidates = []
        if getattr(sys, "frozen", False):
            candidates.append(Path(sys._MEIPASS) / "deployer" / "assets" / "microclaw.ico")
            candidates.append(Path(sys.executable).parent / "deployer" / "assets" / "microclaw.ico")
        candidates.append(Path(__file__).parent / "deployer" / "assets" / "microclaw.ico")
        for ico in candidates:
            if ico.exists():
                try:
                    self.iconbitmap(str(ico))
                    return
                except Exception:
                    pass


# ═══════════════════════════════════════════════════════════════
# Entry point
# ═══════════════════════════════════════════════════════════════
def _ensure_admin():
    import ctypes
    import os
    import sys

    try:
        is_admin = ctypes.windll.shell32.IsUserAnAdmin() != 0
    except Exception:
        is_admin = False
    if is_admin:
        return
    exe = sys.executable
    script = os.path.abspath(sys.argv[0])
    cwd = os.path.dirname(script)
    params = f'"{script}"'
    if sys.argv[1:]:
        params += " " + " ".join(f'"{a}"' for a in sys.argv[1:])
    ret = ctypes.windll.shell32.ShellExecuteW(None, "runas", exe, params, cwd, 1)
    if ret > 32:
        sys.exit(0)


def _log_web_installer_failure(exc: Exception):
    try:
        logger = DeployerLogger()
        logger.error(f"Web installer unavailable, falling back to legacy UI: {exc}")
        logger.debug(traceback.format_exc())
    except Exception:
        pass


def _show_legacy_ui_warning():
    try:
        messagebox.showwarning(
            "MicroClaw Installer",
            "The modern installer UI could not start on this machine.\n"
            "MicroClaw will continue with the compatibility installer.\n\n"
            "新安装界面无法在此设备上启动，程序将自动切换到兼容安装界面。",
        )
    except Exception:
        pass


def _run_installer(auto_uninstall: bool, use_legacy_ui: bool):
    if not auto_uninstall and not use_legacy_ui:
        try:
            run_web_installer()
            return
        except Exception as exc:
            _log_web_installer_failure(exc)
            _show_legacy_ui_warning()

    app = DeployerApp(auto_uninstall=auto_uninstall)
    app.mainloop()


def _check_uninstaller_runtime() -> int:
    # Reaching this function proves the packaged Python runtime and installer
    # modules loaded without triggering UI or elevation.
    return 0


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    if "--check-uninstaller" in args:
        return _check_uninstaller_runtime()

    _setup_windows_taskbar()
    auto_uninstall = "--uninstall" in args
    use_legacy_ui = "--legacy-ui" in args or os.environ.get("LEGACY_INSTALL_UI", "") == "1"
    if auto_uninstall:
        _ensure_admin()
    _run_installer(auto_uninstall=auto_uninstall, use_legacy_ui=use_legacy_ui)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
