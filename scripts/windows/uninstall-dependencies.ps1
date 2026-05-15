<#
.SYNOPSIS
    MicroClaw 依赖卸载脚本 — 卸载 setup-dependencies.ps1 安装的 Node.js、Git、OpenClaw。

.DESCRIPTION
    此脚本卸载 setup-dependencies.ps1 安装的所有第三方依赖：
      1. 停止 node.exe 进程
      2. 卸载 OpenClaw (npm uninstall -g)
      3. 清理系统级 npm 全局 openclaw
      4. 删除 Git (~/.openclaw-git)
      5. 清理 PATH 环境变量（不包含 Node.js 路径）
      6. 删除 OpenClaw 配置 (~/.openclaw)
      7. 删除 npm 缓存
      8. 移除 Windows Defender 排除项

    此脚本不会删除 Node.js（即使是托管安装在 ~/.openclaw-node）。
    此脚本不会删除 MicroClaw 桌面客户端 (~/.microclaw)。
    使用 MicroClaw 安装器卸载桌面客户端。

.PARAMETER SkipGit
    跳过 Git 卸载

.EXAMPLE
    .\uninstall-dependencies.ps1
    .\uninstall-dependencies.ps1 -SkipGit
#>

[CmdletBinding()]
param(
    [switch]$SkipGit
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Paths ──
$NodeDir       = Join-Path $env:USERPROFILE ".openclaw-node"
$GitDir        = Join-Path $env:USERPROFILE ".openclaw-git"
$NpmGlobalBin  = Join-Path $env:APPDATA "npm"
$NpmCache      = Join-Path $env:LOCALAPPDATA "npm-cache"

# ── Logging ──
function Write-Step  { param([string]$msg) Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok    { param([string]$msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn  { param([string]$msg) Write-Host "  [WARN] $msg" -ForegroundColor Yellow }
function Write-Info  { param([string]$msg) Write-Host "  $msg" -ForegroundColor Gray }
function Write-Err   { param([string]$msg) Write-Host "  [ERROR] $msg" -ForegroundColor Red }

function Remove-FromUserPath {
    param([string]$Dir)
    try {
        $currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
        if (-not $currentPath) { return }
        $parts = $currentPath -split ";" | Where-Object { $_.Trim().ToLower() -ne $Dir.ToLower() -and $_.Trim() -ne "" }
        $newPath = ($parts -join ";")
        [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
        # Update current session
        $env:Path = ($env:Path -split ";" | Where-Object { $_.Trim().ToLower() -ne $Dir.ToLower() -and $_.Trim() -ne "" }) -join ";"
        Write-Info "Removed from user PATH: $Dir"
    } catch {
        Write-Warn "Could not remove from user PATH: $_"
    }
}

function Broadcast-SettingsChange {
    try {
        Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class WinEnv {
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Auto)]
    public static extern IntPtr SendMessageTimeout(
        IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam,
        uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
}
"@ -ErrorAction SilentlyContinue
        $HWND_BROADCAST = [IntPtr]0xFFFF
        $WM_SETTINGCHANGE = 0x001A
        $result = [UIntPtr]::Zero
        [WinEnv]::SendMessageTimeout($HWND_BROADCAST, $WM_SETTINGCHANGE, [UIntPtr]::Zero, "Environment", 0x0002, 5000, [ref]$result) | Out-Null
    } catch {}
}

# ══════════════════════════════════════════════════════════════
# Confirmation
# ══════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "========================================" -ForegroundColor Yellow
Write-Host "  MicroClaw Dependency Uninstaller      " -ForegroundColor Yellow
Write-Host "========================================" -ForegroundColor Yellow
Write-Host ""
Write-Host "This will remove:" -ForegroundColor White
if (-not $SkipGit) {
Write-Host "  - Git:          $GitDir" -ForegroundColor Gray
}
Write-Host "  - OpenClaw:     (npm global package)" -ForegroundColor Gray
Write-Host "  - OpenClaw cfg: ~/.openclaw" -ForegroundColor Gray
Write-Host "  - npm cache:    $NpmCache" -ForegroundColor Gray
Write-Host ""
Write-Host "This will NOT remove:" -ForegroundColor White
Write-Host "  - Node.js (kept intact, including $NodeDir if present)" -ForegroundColor Gray
Write-Host "  - MicroClaw desktop app (~/.microclaw)" -ForegroundColor Gray
Write-Host ""

$confirm = Read-Host "Continue? (y/N)"
if ($confirm -notin @("y", "Y", "yes", "Yes")) {
    Write-Host "Cancelled." -ForegroundColor Yellow
    exit 0
}

# ══════════════════════════════════════════════════════════════
# Step 1: Stop node.exe processes
# ══════════════════════════════════════════════════════════════
Write-Step "Stopping Node.js processes..."
try {
    $nodeProcs = Get-Process -Name "node" -ErrorAction SilentlyContinue
    if ($nodeProcs) {
        Stop-Process -Name "node" -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 2
        Write-Ok "Stopped node.exe processes"
    } else {
        Write-Info "No node.exe processes running"
    }
} catch {
    Write-Warn "Could not stop node.exe: $_"
}

# Clean gateway lock files
$lockDir = Join-Path $env:LOCALAPPDATA "Temp\openclaw"
if (Test-Path $lockDir) {
    $locks = Get-ChildItem -Path $lockDir -Filter "gateway.*.lock" -ErrorAction SilentlyContinue
    foreach ($lock in $locks) {
        Remove-Item -Path $lock.FullName -Force -ErrorAction SilentlyContinue
        Write-Info "Removed lock file: $($lock.Name)"
    }
}

# ══════════════════════════════════════════════════════════════
# Step 2: Uninstall OpenClaw via npm
# ══════════════════════════════════════════════════════════════
Write-Step "Uninstalling OpenClaw..."

# Try managed npm first
$npmCmd = Join-Path $NodeDir "npm.cmd"
if (Test-Path $npmCmd) {
    try {
        $prevEAP = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        & $npmCmd uninstall -g openclaw --prefix $NodeDir 2>&1 | ForEach-Object { Write-Info $_ }
        $ErrorActionPreference = $prevEAP
        Write-Ok "OpenClaw uninstalled from managed Node.js"
    } catch {
        $ErrorActionPreference = $prevEAP
        Write-Warn "npm uninstall failed: $_"
    }
}

# Also clean system-level npm global (if openclaw was installed there)
$systemNpmPaths = @(
    "${env:ProgramFiles}\nodejs\npm.cmd",
    "${env:ProgramFiles(x86)}\nodejs\npm.cmd"
)
foreach ($sysNpm in $systemNpmPaths) {
    if (Test-Path $sysNpm) {
        try {
            $prevEAP = $ErrorActionPreference
            $ErrorActionPreference = "Continue"
            & $sysNpm uninstall -g openclaw 2>&1 | Out-Null
            $ErrorActionPreference = $prevEAP
            Write-Info "Cleaned openclaw from system npm ($sysNpm)"
        } catch {
            $ErrorActionPreference = $prevEAP
        }
        break
    }
}

# Direct cleanup: remove openclaw shims from %APPDATA%\npm
if (Test-Path $NpmGlobalBin) {
    foreach ($name in @("openclaw", "openclaw.cmd", "openclaw.ps1")) {
        $shimPath = Join-Path $NpmGlobalBin $name
        if (Test-Path $shimPath) {
            Remove-Item -Path $shimPath -Force -ErrorAction SilentlyContinue
            Write-Info "Removed $shimPath"
        }
    }
    $pkgDir = Join-Path $NpmGlobalBin "node_modules\openclaw"
    if (Test-Path $pkgDir) {
        Remove-Item -Path $pkgDir -Recurse -Force -ErrorAction SilentlyContinue
        Write-Info "Removed $pkgDir"
    }
}

# ══════════════════════════════════════════════════════════════
# Step 3: Keep Node.js installed (intentionally skipped)
# ══════════════════════════════════════════════════════════════
Write-Step "Skipping Node.js removal (kept by design)"
Write-Info "Node.js will NOT be uninstalled, including $NodeDir if present"

# ══════════════════════════════════════════════════════════════
# Step 4: Remove Git
# ══════════════════════════════════════════════════════════════
if (-not $SkipGit) {
    Write-Step "Removing Git ($GitDir)..."
    if (Test-Path $GitDir) {
        Remove-Item -Path $GitDir -Recurse -Force -ErrorAction SilentlyContinue
        if (Test-Path $GitDir) {
            Write-Warn "$GitDir not fully deleted"
        } else {
            Write-Ok "Deleted $GitDir"
        }

        # Remove Git from PATH
        $gitBin = Join-Path $GitDir "bin"
        $gitCmd = Join-Path $GitDir "cmd"
        Remove-FromUserPath $gitBin
        Remove-FromUserPath $gitCmd
    } else {
        Write-Info "$GitDir does not exist, skipping"
    }
}

# ══════════════════════════════════════════════════════════════
# Step 5: Clean PATH
# ══════════════════════════════════════════════════════════════
Write-Step "Cleaning PATH..."
# Node.js path intentionally left in PATH
Remove-FromUserPath $NpmGlobalBin

# Remove OfficeCLI from PATH if it was in the managed skills dir
$officecliDir = Join-Path $env:USERPROFILE ".openclaw\skills\officecli\bin"
Remove-FromUserPath $officecliDir

Broadcast-SettingsChange
Write-Ok "PATH cleaned (restart terminal to take effect)"

# ══════════════════════════════════════════════════════════════
# Step 6: Remove OpenClaw config (~/.openclaw)
# ══════════════════════════════════════════════════════════════
$OpenClawDir = Join-Path $env:USERPROFILE ".openclaw"
Write-Step "Removing OpenClaw config ($OpenClawDir)..."
if (Test-Path $OpenClawDir) {
    Remove-Item -Path $OpenClawDir -Recurse -Force -ErrorAction SilentlyContinue
    if (Test-Path $OpenClawDir) {
        Write-Warn "$OpenClawDir not fully deleted"
    } else {
        Write-Ok "Deleted $OpenClawDir"
    }
} else {
    Write-Info "$OpenClawDir does not exist, skipping"
}

# ══════════════════════════════════════════════════════════════
# Step 7: Clean npm cache
# ══════════════════════════════════════════════════════════════
Write-Step "Cleaning npm cache..."
if (Test-Path $NpmCache) {
    Remove-Item -Path $NpmCache -Recurse -Force -ErrorAction SilentlyContinue
    Write-Ok "Deleted npm cache: $NpmCache"
} else {
    Write-Info "npm cache not found, skipping"
}

# ══════════════════════════════════════════════════════════════
# Step 8: Remove Defender exclusions
# ══════════════════════════════════════════════════════════════
Write-Step "Removing Windows Defender exclusions (requires admin)..."
$exclusionDirs = @(
    $GitDir,
    $NpmCache,
    $env:TEMP
) | Where-Object { $_ }

$psCommands = ($exclusionDirs | ForEach-Object { "Remove-MpPreference -ExclusionPath '$($_.Replace("'","''"))' -ErrorAction SilentlyContinue" }) -join "; "

try {
    Start-Process powershell -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList "-NoProfile", "-Command", $psCommands -ErrorAction Stop
    Write-Ok "Defender exclusions removed"
} catch {
    Write-Warn "Defender exclusion removal failed (non-fatal, may need admin): $_"
}

# ══════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  Dependencies uninstalled!             " -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "Removed:" -ForegroundColor White
if (-not $SkipGit) {
Write-Host "  Git:          $GitDir" -ForegroundColor Gray
}
Write-Host "  OpenClaw:     (npm global package + config)" -ForegroundColor Gray
Write-Host "  npm cache:    $NpmCache" -ForegroundColor Gray
Write-Host ""
Write-Host "NOT removed:" -ForegroundColor Yellow
Write-Host "  Node.js:      kept intact ($NodeDir if present)" -ForegroundColor Gray
Write-Host "  Desktop app:  ~/.microclaw (use MicroClaw installer to uninstall)" -ForegroundColor Gray
Write-Host ""
