"""Bundled skill catalog for the OpenClaw deployer.

Each entry maps a skill directory name → metadata dict.
The ``platform`` list marks which operating systems a skill supports.

Platform rule
-------------
platform=["windows", ...] when the skill:
  • has a working implementation on Windows (native or via standard tooling), OR
  • is a web/API-based service accessible from any OS.
"""

from __future__ import annotations

from typing import TypedDict


class SkillInfo(TypedDict):
    description: str
    platform: list[str]  # e.g. ["windows"], ["macos"], ["windows", "macos", "linux"]


# Complete catalog of the 17 bundled skills shipped with OpenClaw.
# Keep alphabetically sorted by key.
#
# Hand-aligned reference table where every row's description and platform
# columns line up. Ruff's formatter would collapse short rows to one line and
# explode long rows to multi-line, destroying the alignment, so we wrap the
# literal in `# fmt: off` / `# fmt: on`.
# fmt: off
SKILL_CATALOG: dict[str, SkillInfo] = {
    "1password":          {"description": "1Password 密码管理集成",               "platform": ["windows", "macos", "linux"]},
    "blucli":             {"description": "BluOS 音响控制",                       "platform": ["windows", "macos", "linux"]},
    "canvas":             {"description": "HTML 内容展示到 OpenClaw 节点",        "platform": ["windows", "macos", "linux"]},
    "coding-agent":       {"description": "委派编码任务给子代理",                 "platform": ["windows", "macos", "linux"]},
    "healthcheck":        {"description": "主机安全加固与风险配置",               "platform": ["windows", "macos", "linux"]},
    "mcporter":           {"description": "MCP 服务器管理",                       "platform": ["windows", "macos", "linux"]},
    "nano-pdf":           {"description": "自然语言编辑 PDF",                     "platform": ["windows", "macos", "linux"]},
    "obsidian":           {"description": "Obsidian 笔记库管理",                  "platform": ["windows", "macos", "linux"]},
    "openai-whisper":     {"description": "本地语音转文字（离线）",               "platform": ["windows", "macos", "linux"]},
    "openhue":            {"description": "Philips Hue 灯光控制",                "platform": ["windows", "macos", "linux"]},
    "oracle":             {"description": "AI 代码分析最佳实践",                  "platform": ["windows", "macos", "linux"]},
    "session-logs":       {"description": "搜索分析会话日志",                     "platform": ["windows", "macos", "linux"]},
    "sherpa-onnx-tts":    {"description": "本地文本转语音（离线）",               "platform": ["windows", "macos", "linux"]},
    "skill-creator":      {"description": "创建和编辑 AgentSkill",               "platform": ["windows", "macos", "linux"]},
    "songsee":            {"description": "音频频谱可视化",                       "platform": ["windows", "macos", "linux"]},
    "sonoscli":           {"description": "Sonos 音响控制",                       "platform": ["windows", "macos", "linux"]},
    "video-frames":       {"description": "视频帧提取（ffmpeg）",                 "platform": ["windows", "macos", "linux"]},
}
# fmt: on

# Catalog of known managed/workspace skills.
# Skills installed to ~/.agents/skills/ that appear here get platform metadata.
# Skills NOT in this catalog are treated as unknown and disabled by default.
# fmt: off
MANAGED_SKILL_CATALOG: dict[str, SkillInfo] = {
    "officecli":                  {"description": "Office 文档 CLI 工具（创建/编辑 .docx/.xlsx/.pptx，无需安装 Office）", "platform": ["windows", "macos", "linux"]},
    "excel-xlsx":                 {"description": "Microsoft Excel 工作簿创建与编辑",                            "platform": ["windows"]},
    "powerpoint-pptx":            {"description": "Microsoft PowerPoint 演示文稿创建与编辑",                     "platform": ["windows"]},
    "rednote-publisher":          {"description": "小红书选题、图文卡片与可发布内容包生成",                       "platform": ["windows"]},
    "security-practice":          {"description": "AI Agent 行为安全规范（红线/黄线规则、安装审计协议）",         "platform": ["windows"]},
    "word-docx":                  {"description": "Microsoft Word 文档创建与编辑",                               "platform": ["windows"]},
    "desktop-organizer":          {"description": "扫描 Windows 桌面文件与文件夹并分类整理",                     "platform": ["windows"]},
}
# fmt: on


def get_windows_skills() -> list[str]:
    """Return sorted list of skill names that support Windows."""
    return sorted(k for k, v in SKILL_CATALOG.items() if "windows" in v["platform"])


def get_windows_managed_skills() -> list[str]:
    """Return sorted list of managed skill names that support Windows."""
    return sorted(k for k, v in MANAGED_SKILL_CATALOG.items() if "windows" in v["platform"])


def get_all_skill_names() -> list[str]:
    """Return all skill names sorted alphabetically."""
    return sorted(SKILL_CATALOG.keys())


def export_catalog_json() -> dict[str, dict]:
    """Return the full catalog as a JSON-serializable dict."""
    return {k: dict(v) for k, v in SKILL_CATALOG.items()}


def get_all_managed_skill_names() -> list[str]:
    """Return all managed skill names sorted alphabetically."""
    return sorted(MANAGED_SKILL_CATALOG.keys())


def export_managed_catalog_json() -> dict[str, dict]:
    """Return the managed skill catalog as a JSON-serializable dict."""
    return {k: dict(v) for k, v in MANAGED_SKILL_CATALOG.items()}
