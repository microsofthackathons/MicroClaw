## AppContainer Provisioning Script for MicroClaw
## Run this ONCE as Administrator to set up the AppContainer environment.
##
## Usage (elevated):
##   powershell -ExecutionPolicy Bypass -File provision-appcontainer.ps1

param(
    [string]$ContainerName = "MicroClaw",
    [string]$LauncherDir = $PSScriptRoot,
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$exe = Join-Path $LauncherDir "bin\Release\net9.0-windows\win-x64\AppContainerLauncher.exe"

if (-not (Test-Path $exe)) {
    # Try dotnet run instead
    $useRun = $true
} else {
    $useRun = $false
}

function Invoke-Launcher {
    param([string[]]$Args)
    if ($useRun) {
        $output = & dotnet run --project $LauncherDir -c Release -- @Args 2>&1
    } else {
        $output = & $exe @Args 2>&1
    }
    $output | ForEach-Object { Write-Host "  $_" }
    return $LASTEXITCODE
}

Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  MicroClaw AppContainer Provisioning"
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""

# Step 1: Check OS support
Write-Host "[1/5] Checking OS support..." -ForegroundColor Yellow
$checkResult = if ($useRun) {
    dotnet run --project $LauncherDir -c Release -- check 2>&1 | Out-String
} else {
    & $exe check 2>&1 | Out-String
}
if ($checkResult -match '"supported":\s*false') {
    Write-Host "  ERROR: This Windows version does not support AppContainer for Win32 apps." -ForegroundColor Red
    Write-Host "  Minimum: Windows 10 Version 2004 (Build 19041)" -ForegroundColor Red
    exit 1
}
Write-Host "  $($checkResult.Trim())" -ForegroundColor Green

# Step 2: Create/verify AppContainer profile
Write-Host ""
Write-Host "[2/5] Creating AppContainer profile '$ContainerName'..." -ForegroundColor Yellow
$sid = if ($useRun) {
    dotnet run --project $LauncherDir -c Release -- sid --name $ContainerName 2>&1 | Select-Object -Last 1
} else {
    & $exe sid --name $ContainerName 2>&1 | Select-Object -Last 1
}
Write-Host "  SID: $sid" -ForegroundColor Green

# Step 3: Admin setup — traverse ACLs on all drive roots and C:\Users
# Grants Traverse+ReadAttributes (no ListDirectory) on all fixed drives
# so AppContainer processes can reach paths on any drive.
Write-Host ""
Write-Host "[3/5] Setting traverse ACLs (requires admin, optional with --preserve-symlinks)..." -ForegroundColor Yellow
$code = Invoke-Launcher @("setup", "--name", $ContainerName)
if ($code -ne 0) {
    Write-Host "  INFO: Skipped C:\+C:\Users ACL — not required when using --preserve-symlinks." -ForegroundColor DarkGray
}

# Step 4: Grant directory ACLs
Write-Host ""
Write-Host "[4/5] Granting directory access..." -ForegroundColor Yellow

$home = $env:USERPROFILE
$dirs = @(
    @{ Path = "$home\.openclaw-node";          Access = "r";  Desc = "Node.js binary (read-only)" },
    @{ Path = "$home\.openclaw-node\node_modules"; Access = "r";  Desc = "npm packages (read-only)" },
    @{ Path = "$home\.openclaw";               Access = "rw"; Desc = "State / config (read-write)" },
    @{ Path = "$env:LOCALAPPDATA\Temp";        Access = "rw"; Desc = "Temp directory (read-write)" }
)

foreach ($d in $dirs) {
    if (Test-Path $d.Path) {
        Write-Host "  $($d.Desc): $($d.Path)" -ForegroundColor Gray
        Invoke-Launcher @("grant", "--name", $ContainerName, "--dir", $d.Path, "--access", $d.Access) | Out-Null
    } else {
        Write-Host "  SKIP (not found): $($d.Path)" -ForegroundColor DarkGray
    }
}

# Grant minimal traverse (no inherit) on ancestor dirs so Node.js realpathSync works.
# This does NOT give read access to user profile contents — only allows directory traversal.
# The GrantAncestorTraverse in ContainerManager.cs also does this at runtime,
# but we do it here too for the provisioning script to be self-contained.
Write-Host "  Ancestor traverse (no inherit): $home" -ForegroundColor Gray
# Use icacls to set traverse-only without inheritance flags
# (CI)(OI) would inherit; without them it applies only to the directory itself
$sid = Invoke-Launcher @("sid", "--name", $ContainerName) | Select-Object -Last 1
$sid = $sid.Trim()
foreach ($ancestor in @($home, (Split-Path $home -Parent))) {
    if (Test-Path $ancestor) {
        icacls $ancestor /grant "${sid}:(REA,RA,X)" 2>$null | Out-Null
        Write-Host "    Traverse: $ancestor" -ForegroundColor DarkGray
    }
}

# Step 5: Loopback exemption (for network connectivity)
Write-Host ""
Write-Host "[5/5] Adding loopback network exemption..." -ForegroundColor Yellow
Invoke-Launcher @("loopback", "--name", $ContainerName) | Out-Null

Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host "  Provisioning complete!"
Write-Host "  Container: $ContainerName"
Write-Host "  SID: $sid"
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "To test:" -ForegroundColor Gray
Write-Host "  dotnet run --project $LauncherDir -c Release -- run --name $ContainerName --exe `"$home\.openclaw-node\node.exe`" --workdir `"$home\.openclaw`" -- -e `"console.log('Hello from AppContainer')`"" -ForegroundColor DarkGray
