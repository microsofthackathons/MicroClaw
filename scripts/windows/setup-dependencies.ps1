<#
.SYNOPSIS
    MicroClaw 依赖安装脚本 — 安装 Node.js、Git、OpenClaw Gateway 等第三方依赖。

.DESCRIPTION
    此脚本安装 MicroClaw 桌面客户端所需的核心第三方依赖：
      1. Git for Windows (PortableGit)
      2. Node.js v22+ (from npmmirror)
      3. npm 镜像源配置
      4. OpenClaw Gateway (npm install -g)
      5. V8 编译缓存预热
      6. 系统 PATH 配置

    配置文件、托管技能、AppContainer 沙箱、Defender 排除项等
    由 MicroClaw 安装器 (deploy.py / MicroClawInstaller.exe) 负责。

.PARAMETER NodeDir
    Node.js 安装目录 (默认: ~/.openclaw-node)

.PARAMETER Mirror
    npm 镜像源: npmmirror 或 tencent (默认: npmmirror)

.PARAMETER SkipGit
    跳过 Git 安装

.PARAMETER OpenClawTag
    OpenClaw npm 安装 tag (默认: 2026.7.1-1)

.EXAMPLE
    .\setup-dependencies.ps1
    .\setup-dependencies.ps1 -Mirror tencent -SkipGit
#>

[CmdletBinding()]
param(
    [string]$NodeDir = (Join-Path $env:USERPROFILE ".openclaw-node"),
    [ValidateSet("npmmirror", "tencent")]
    [string]$Mirror = "npmmirror",
    [switch]$SkipGit,
    [string]$OpenClawTag = "2026.7.1-1"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Mirror URLs ──
$Mirrors = @{
    npmmirror = @{
        NodeBase   = "https://registry.npmmirror.com/-/binary/node"
        GitBase    = "https://registry.npmmirror.com/-/binary/git-for-windows"
        NpmRegistry = "https://registry.npmmirror.com"
    }
    tencent = @{
        NodeBase   = "https://mirrors.cloud.tencent.com/nodejs-release"
        GitBase    = "https://registry.npmmirror.com/-/binary/git-for-windows"
        NpmRegistry = "http://mirrors.cloud.tencent.com/npm/"
    }
}

$MirrorConfig = $Mirrors[$Mirror]

# ── Paths ──
$OpenClawDir   = Join-Path $env:USERPROFILE ".openclaw"
$GitDir        = Join-Path $env:USERPROFILE ".openclaw-git"

# ── Logging ──
function Write-Step  { param([string]$msg) Write-Host "`n==> $msg" -ForegroundColor Cyan }
function Write-Ok    { param([string]$msg) Write-Host "  [OK] $msg" -ForegroundColor Green }
function Write-Warn  { param([string]$msg) Write-Host "  [WARN] $msg" -ForegroundColor Yellow }
function Write-Info  { param([string]$msg) Write-Host "  $msg" -ForegroundColor Gray }
function Write-Err   { param([string]$msg) Write-Host "  [ERROR] $msg" -ForegroundColor Red }

function Test-SupportedNodeVersion {
    param([string]$Version)
    try {
        $parsed = [version]$Version.TrimStart("v")
    } catch {
        return $false
    }
    if ($parsed.Major -eq 22) { return $parsed -ge [version]"22.22.3" }
    if ($parsed.Major -eq 23) { return $false }
    if ($parsed.Major -eq 24) { return $parsed -ge [version]"24.15.0" }
    if ($parsed.Major -ge 25) { return $parsed -ge [version]"25.9.0" }
    return $false
}

# ── Helpers ──
function Get-Arch {
    $machine = $env:PROCESSOR_ARCHITECTURE
    switch ($machine) {
        "AMD64"  { return "x64" }
        "ARM64"  { return "arm64" }
        "x86"    { return "x86" }
        default  { return "x64" }
    }
}

function Download-File {
    param([string]$Url, [string]$Dest)
    Write-Info "Downloading: $Url"
    $ProgressPreference = 'SilentlyContinue'
    try {
        Invoke-WebRequest -Uri $Url -OutFile $Dest -UseBasicParsing -TimeoutSec 120
    } finally {
        $ProgressPreference = 'Continue'
    }
    Write-Info "Download complete: $('{0:N1}' -f ((Get-Item $Dest).Length / 1MB)) MB"
}

function Add-ToUserPath {
    param([string]$Dir)
    $currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($currentPath -and $currentPath.ToLower().Contains($Dir.ToLower())) {
        Write-Info "Already in user PATH: $Dir"
        return
    }
    $newPath = "$Dir;$currentPath"
    [Environment]::SetEnvironmentVariable("Path", $newPath, "User")
    Write-Ok "Added to user PATH: $Dir"
    # Also update current session
    $env:Path = "$Dir;$env:Path"
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
# Step 0: Execution Policy
# ══════════════════════════════════════════════════════════════
Write-Step "Checking PowerShell execution policy..."
$policy = Get-ExecutionPolicy -Scope CurrentUser
if ($policy -in @("RemoteSigned", "Unrestricted", "Bypass")) {
    Write-Ok "ExecutionPolicy: $policy"
} else {
    try {
        Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned -Force
        Write-Ok "ExecutionPolicy set to RemoteSigned"
    } catch {
        Write-Warn "Could not set ExecutionPolicy: $_"
    }
}

# ══════════════════════════════════════════════════════════════
# Step 1: Git
# ══════════════════════════════════════════════════════════════
if (-not $SkipGit) {
    Write-Step "Checking Git..."
    $gitExe = Get-Command git -ErrorAction SilentlyContinue
    if ($gitExe) {
        Write-Ok "Git found: $($gitExe.Source)"
    } else {
        Write-Step "Installing Git for Windows ($Mirror)..."
        $arch = Get-Arch

        # Resolve latest Git version
        $gitVersion = "2.53.0"
        try {
            $releaseInfo = Invoke-RestMethod -Uri "https://api.github.com/repos/git-for-windows/git/releases/latest" -TimeoutSec 15 -UseBasicParsing
            $tag = $releaseInfo.tag_name
            $gitVersion = ($tag -replace '^v','') -replace '\.windows\.\d+$',''
            Write-Info "Resolved Git version: $gitVersion"
        } catch {
            Write-Warn "Could not resolve Git version, using fallback: $gitVersion"
        }

        # Build download URL
        if ($arch -eq "arm64") {
            $filename = "PortableGit-$gitVersion-arm64.7z.exe"
        } elseif ($arch -eq "x86") {
            $filename = "MinGit-$gitVersion-32-bit.zip"
        } else {
            $filename = "PortableGit-$gitVersion-64-bit.7z.exe"
        }
        $url = "$($MirrorConfig.GitBase)/v$gitVersion.windows.1/$filename"

        $tmpDir = Join-Path $env:TEMP "openclaw_git_$(Get-Random)"
        New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
        $dlPath = Join-Path $tmpDir $filename

        try {
            Download-File -Url $url -Dest $dlPath
            New-Item -ItemType Directory -Path $GitDir -Force | Out-Null

            if ($arch -eq "x86") {
                Expand-Archive -Path $dlPath -DestinationPath $GitDir -Force
            } else {
                & $dlPath "-o$GitDir" -y | Out-Null
            }

            $gitBin = Join-Path $GitDir "bin"
            if (-not (Test-Path (Join-Path $gitBin "git.exe"))) {
                $gitBin = Join-Path $GitDir "cmd"
            }

            if (Test-Path (Join-Path $gitBin "git.exe")) {
                $env:Path = "$gitBin;$env:Path"
                Add-ToUserPath $gitBin
                Write-Ok "Git installed to $GitDir"
            } else {
                Write-Err "Git extraction failed - git.exe not found"
            }
        } catch {
            Write-Err "Git install failed: $_"
        } finally {
            Remove-Item -Path $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }

    # Configure git to use HTTPS instead of SSH for GitHub
    $gitCmd = Get-Command git -ErrorAction SilentlyContinue
    if ($gitCmd) {
        git config --global "url.https://github.com/.insteadOf" "ssh://git@github.com/" 2>$null
        git config --global "url.https://github.com/.insteadOf" "git@github.com:" 2>$null
        Write-Info "Configured git to use HTTPS for GitHub"
    }
}

# ══════════════════════════════════════════════════════════════
# Step 2: Node.js
# ══════════════════════════════════════════════════════════════
Write-Step "Checking Node.js..."
$nodeExe = Join-Path $NodeDir "node.exe"
$needInstall = $true

if (Test-Path $nodeExe) {
    $ver = & $nodeExe --version 2>$null
    if ($ver) {
        Write-Info "Managed Node.js found: $ver"
        if (Test-SupportedNodeVersion $ver) {
            $needInstall = $false
        } else {
            Write-Warn "Node.js $ver is unsupported by OpenClaw $OpenClawTag; upgrading"
        }
    }
}

if ($needInstall) {
    Write-Step "Installing Node.js ($Mirror)..."
    $arch = Get-Arch

    # Resolve latest Node.js 22.x version
    $nodeVersion = "22.22.3"
    try {
        $versionIndex = Invoke-RestMethod -Uri "https://nodejs.org/dist/index.json" -TimeoutSec 15 -UseBasicParsing
        foreach ($entry in $versionIndex) {
            $v = $entry.version -replace '^v',''
            if ($v -match '^22\.') {
                $nodeVersion = $v
                break
            }
        }
        Write-Info "Resolved Node.js version: v$nodeVersion"
    } catch {
        Write-Warn "Could not resolve version, using fallback: $nodeVersion"
    }

    $nodeUrl = "$($MirrorConfig.NodeBase)/v$nodeVersion/node-v$nodeVersion-win-$arch.zip"
    $tmpDir = Join-Path $env:TEMP "openclaw_node_$(Get-Random)"
    New-Item -ItemType Directory -Path $tmpDir -Force | Out-Null
    $zipPath = Join-Path $tmpDir "node.zip"

    try {
        Download-File -Url $nodeUrl -Dest $zipPath

        # Verify SHA256 (best-effort)
        Write-Info "Verifying SHA256..."
        $localHash = (Get-FileHash -Path $zipPath -Algorithm SHA256).Hash.ToLower()
        $verified = $false
        try {
            $shasums = (Invoke-WebRequest -Uri "https://nodejs.org/dist/v$nodeVersion/SHASUMS256.txt" -UseBasicParsing -TimeoutSec 15).Content
            $expectedFile = "node-v$nodeVersion-win-$arch.zip"
            foreach ($line in $shasums -split "`n") {
                $parts = $line.Trim() -split '\s+'
                if ($parts.Count -ge 2 -and $parts[1].Trim() -eq $expectedFile) {
                    if ($localHash -eq $parts[0].Trim().ToLower()) {
                        Write-Ok "SHA256 verified"
                        $verified = $true
                    } else {
                        Write-Err "SHA256 mismatch! Expected: $($parts[0]) Got: $localHash"
                        throw "SHA256 verification failed"
                    }
                    break
                }
            }
            if (-not $verified) { throw "Filename not found in SHASUMS256 - cannot verify integrity" }
        } catch {
            if ($_.Exception.Message -eq "SHA256 verification failed") { throw }
            throw "Could not fetch SHASUMS256.txt - aborting to prevent installing unverified binaries"
        }

        Write-Step "Extracting Node.js..."
        Expand-Archive -Path $zipPath -DestinationPath $tmpDir -Force

        $extractedDir = Get-ChildItem -Path $tmpDir -Directory | Where-Object { $_.Name -match "^node-v" } | Select-Object -First 1
        if (-not $extractedDir -or -not (Test-Path (Join-Path $extractedDir.FullName "node.exe"))) {
            throw "Extraction failed: node.exe not found"
        }

        # Move to install dir
        New-Item -ItemType Directory -Path $NodeDir -Force | Out-Null
        foreach ($item in Get-ChildItem -Path $extractedDir.FullName) {
            $dest = Join-Path $NodeDir $item.Name
            if (Test-Path $dest) {
                Remove-Item -Path $dest -Recurse -Force
            }
            Move-Item -Path $item.FullName -Destination $dest
        }

        $ver = & (Join-Path $NodeDir "node.exe") --version 2>$null
        Write-Ok "Node.js $ver installed to $NodeDir"
    } catch {
        Write-Err "Node.js install failed: $_"
        exit 1
    } finally {
        Remove-Item -Path $tmpDir -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# ══════════════════════════════════════════════════════════════
# Step 3: Configure npm
# ══════════════════════════════════════════════════════════════
Write-Step "Configuring npm registry ($Mirror)..."
$npmCmd = Join-Path $NodeDir "npm.cmd"
if (-not (Test-Path $npmCmd)) {
    $npmCmd = Join-Path $NodeDir "npm"
}

# Set npm global config path to avoid touching system npmrc
$npmrcDir = Join-Path $NodeDir "etc"
New-Item -ItemType Directory -Path $npmrcDir -Force | Out-Null
$env:npm_config_globalconfig = Join-Path $npmrcDir "npmrc"

try {
    & $npmCmd config set prefix $NodeDir 2>$null
    & $npmCmd config set registry $($MirrorConfig.NpmRegistry)
    $actual = (& $npmCmd config get registry).Trim().TrimEnd('/')
    $expected = $MirrorConfig.NpmRegistry.TrimEnd('/')
    if ($actual -eq $expected) {
        Write-Ok "npm registry: $actual"
    } else {
        Write-Warn "npm registry set to $actual (expected $expected)"
    }
} catch {
    Write-Err "npm config failed: $_"
}

# ══════════════════════════════════════════════════════════════
# Step 4: Install OpenClaw
# ══════════════════════════════════════════════════════════════
Write-Step "Installing OpenClaw (tag=$OpenClawTag)..."

# Check if already installed
$openclawEntry = Join-Path $NodeDir "node_modules\openclaw\openclaw.mjs"
if (-not (Test-Path $openclawEntry)) {
    $openclawEntry = Join-Path $NodeDir "lib\node_modules\openclaw\openclaw.mjs"
}

$needOpenClaw = -not (Test-Path $openclawEntry)
if (-not $needOpenClaw) {
    try {
        $listOutput = & $npmCmd list -g openclaw --depth=0 2>$null
        if ($listOutput -match "openclaw@") {
            $ocVersion = ($listOutput -split "openclaw@")[-1].Trim() -split '\s+' | Select-Object -First 1
            if ($ocVersion -eq $OpenClawTag) {
                Write-Ok "OpenClaw already installed: $ocVersion"
            } else {
                Write-Err "Existing OpenClaw $ocVersion requires transactional upgrade. Run the MicroClaw installer."
                exit 1
            }
        } else {
            Write-Err "Existing OpenClaw version could not be determined. Run the MicroClaw installer."
            exit 1
        }
    } catch {
        Write-Err "Existing OpenClaw version check failed. Run the MicroClaw installer. $_"
        exit 1
    }
}

if ($needOpenClaw) {
    try {
        $env:Path = "$NodeDir;$env:Path"
        # Temporarily allow non-terminating errors so npm stderr warnings
        # (e.g. deprecation notices) don't abort under $ErrorActionPreference=Stop.
        $prevEAP = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        $npmOutput = & $npmCmd install -g "openclaw@$OpenClawTag" --prefix $NodeDir --registry $($MirrorConfig.NpmRegistry) --replace-registry-host always 2>&1
        $npmExitCode = $LASTEXITCODE
        foreach ($line in $npmOutput) {
            if ($line -is [System.Management.Automation.ErrorRecord]) {
                Write-Info "[npm] $($line.ToString())"
            } else {
                Write-Info $line
            }
        }
        $ErrorActionPreference = $prevEAP
        if ($npmExitCode -ne 0) { throw "npm install failed with exit code $npmExitCode" }
        Write-Ok "OpenClaw installed successfully"
    } catch {
        $ErrorActionPreference = $prevEAP
        Write-Err "OpenClaw install failed: $_"
        exit 1
    }
}

# ══════════════════════════════════════════════════════════════
# Step 5: System PATH
# ══════════════════════════════════════════════════════════════
Write-Step "Updating system PATH..."
Add-ToUserPath $NodeDir

$npmGlobalBin = Join-Path $env:USERPROFILE "AppData\Roaming\npm"
if (Test-Path $npmGlobalBin) {
    Add-ToUserPath $npmGlobalBin
}

Broadcast-SettingsChange
Write-Ok "PATH updated (restart terminal to take effect)"

# ══════════════════════════════════════════════════════════════
# Summary
# ══════════════════════════════════════════════════════════════
Write-Host ""
Write-Host "========================================" -ForegroundColor Green
Write-Host "  MicroClaw dependencies installed!     " -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Green
Write-Host ""
Write-Host "Installed components:" -ForegroundColor White
Write-Host "  Node.js:    $NodeDir" -ForegroundColor Gray
if (-not $SkipGit) {
Write-Host "  Git:        $GitDir" -ForegroundColor Gray
}
Write-Host "  OpenClaw:   $OpenClawDir" -ForegroundColor Gray
Write-Host ""
Write-Host "Next steps:" -ForegroundColor Yellow
Write-Host "  1. Install MicroClaw desktop app (if not already installed)" -ForegroundColor Gray
Write-Host "  2. Restart your terminal for PATH changes to take effect" -ForegroundColor Gray
Write-Host "  3. Launch MicroClaw from the desktop shortcut" -ForegroundColor Gray
Write-Host ""
