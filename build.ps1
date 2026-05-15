# One-click build: desktop app + appcontainer launcher -> portable zip -> installer exe
Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# Force UTF-8 so child-process output isn't garbled (e.g. 'ΓÇó' instead of '•').
$OutputEncoding = [System.Text.UTF8Encoding]::new()
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
[Console]::InputEncoding  = [System.Text.UTF8Encoding]::new()
$env:PYTHONIOENCODING = 'utf-8'

$root = Split-Path -Parent $MyInvocation.MyCommand.Path

# Prefer Node 22 from the standard per-user MSI install location, falling back
# to the legacy zip-extract path and finally the system Node.
$nodeCandidates = @(
    "$env:ProgramFiles\nodejs",
    "$env:LOCALAPPDATA\Programs\nodejs",
    "$env:USERPROFILE\.openclaw-node"
)
$nodeFound = $false
foreach ($candidate in $nodeCandidates) {
    if (Test-Path "$candidate\node.exe") {
        $env:PATH = "$candidate;$env:PATH"
        Write-Host "  Using Node: $candidate ($(& node --version))"
        $nodeFound = $true
        break
    }
}
if (-not $nodeFound) {
    # Fall back to whatever node.exe is already on PATH (e.g. nvm, chocolatey,
    # winget shims, or a non-standard install). Many dev machines keep node
    # outside the three "standard" locations above, and after an uninstall the
    # MSI directory is gone — but a system-wide node may still be available.
    $nodeCmd = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($nodeCmd) {
        $nodeDir = Split-Path -Parent $nodeCmd.Source
        Write-Host "  Using Node from PATH: $nodeDir ($(& node --version))"
        $nodeFound = $true
    }
}
if (-not $nodeFound) {
    Write-Host "  ERROR: node.exe not found in any of:" -ForegroundColor Red
    foreach ($candidate in $nodeCandidates) { Write-Host "    - $candidate" -ForegroundColor Red }
    Write-Host "    - PATH (Get-Command node.exe)" -ForegroundColor Red
    Write-Host "  Install Node.js 22+ (https://nodejs.org/) and re-run build.ps1." -ForegroundColor Red
    exit 1
}

# -- Step 1: Build AppContainerLauncher.exe (.NET 9) --
Write-Host "`n=== Step 1/6: Build AppContainerLauncher ===" -ForegroundColor Cyan
$acProject = "$root\appcontainer"
if (-not (Test-Path "$acProject\AppContainerLauncher.csproj")) {
    Write-Host "  ERROR: appcontainer project not found at $acProject" -ForegroundColor Red
    exit 1
}

# Pipe to ForEach-Object loses the native exit code in $LASTEXITCODE detection
# under StrictMode, so temporarily relax ErrorActionPreference (matches the
# npm/pyinstaller invocation style below) and then check $LASTEXITCODE.
$prev = $ErrorActionPreference
$ErrorActionPreference = "Continue"
dotnet publish $acProject -c Release -o "$acProject\bin\Release\net9.0-windows\win-x64" 2>&1 |
    ForEach-Object { Write-Host "  $_" }
$publishExit = $LASTEXITCODE
$ErrorActionPreference = $prev
if ($publishExit -ne 0) {
    Write-Host "  ERROR: dotnet publish failed with exit code $publishExit" -ForegroundColor Red
    exit 1
}

$acExe = "$acProject\bin\Release\net9.0-windows\win-x64\AppContainerLauncher.exe"
if (-not (Test-Path $acExe)) {
    Write-Host "  ERROR: AppContainerLauncher.exe not found after build at $acExe" -ForegroundColor Red
    exit 1
}
Write-Host "  AppContainerLauncher.exe built" -ForegroundColor Green

# Copy sandbox-preload.js and its modules alongside launcher (used by electron-builder extraResources)
$preloadSrc = "$acProject\sandbox-preload.js"
if (Test-Path $preloadSrc) {
    $releaseDir = "$acProject\bin\Release\net9.0-windows\win-x64"
    Copy-Item $preloadSrc "$releaseDir\sandbox-preload.js" -Force
    foreach ($mod in @('sandbox-state.js','sandbox-permission.js','sandbox-fs-hooks.js','sandbox-cp-hooks.js','sandbox-sensitive.js','path-extraction.js')) {
        $modSrc = "$acProject\$mod"
        if (Test-Path $modSrc) { Copy-Item $modSrc "$releaseDir\$mod" -Force }
    }
    Write-Host "  sandbox-preload.js + modules copied" -ForegroundColor Green
}

# -- Step 2: Clean dist/ to prevent stale TypeScript output --
Write-Host "`n=== Step 2/6: Clean stale build artifacts ===" -ForegroundColor Cyan
$distDir = "$root\desktop\dist"
if (Test-Path $distDir) {
    Remove-Item "$distDir\*.js" -Force -ErrorAction SilentlyContinue
    Remove-Item "$distDir\*.js.map" -Force -ErrorAction SilentlyContinue
    Write-Host "  Cleaned desktop\dist\"
}

# Ensure top-level dist/ exists so Compress-Archive can write into it later.
$outDist = "$root\dist"
if (-not (Test-Path $outDist)) {
    New-Item -ItemType Directory -Path $outDist -Force | Out-Null
    Write-Host "  Created $outDist"
}

# -- Step 3: Build & pack desktop --
Write-Host "`n=== Step 3/6: Build & pack desktop ===" -ForegroundColor Cyan
Push-Location "$root\desktop"
try {
    # First-run bootstrap: install npm deps (including renderer via postinstall)
    # if node_modules is missing or the installed dependency tree is incomplete.
    # Without this, `npm run pack` can fail later inside electron-builder.
    $needsNpmInstall = -not (Test-Path "$root\desktop\node_modules")
    if (-not $needsNpmInstall) {
        $prev = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        npm ls --depth=0 *> $null
        $npmLsExit = $LASTEXITCODE
        $ErrorActionPreference = $prev
        if ($npmLsExit -ne 0) {
            $needsNpmInstall = $true
            Write-Host "  desktop dependencies are incomplete — running 'npm install'..." -ForegroundColor Yellow
        }
    } else {
        Write-Host "  desktop\node_modules not found — running 'npm install'..." -ForegroundColor Yellow
    }

    if ($needsNpmInstall) {
        $prev = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        npm install 2>&1 | ForEach-Object { Write-Host "  $_" }
        $ErrorActionPreference = $prev
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  ERROR: npm install failed" -ForegroundColor Red
            exit 1
        }
    }

    $prev = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    npm run pack 2>&1 | ForEach-Object { Write-Host "  $_" }
    $ErrorActionPreference = $prev
    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ERROR: desktop build failed" -ForegroundColor Red
        exit 1
    }
} finally {
    Pop-Location
}

# -- Verify: ensure packed asar contains freshly compiled code --
$desktopAsar = "$root\desktop\release\win-unpacked\resources\app.asar"
if (Test-Path $desktopAsar) {
    $asarAge = (Get-Item $desktopAsar).LastWriteTime
    $srcAge  = (Get-ChildItem "$root\desktop\src\*.ts" | Sort-Object LastWriteTime -Descending | Select-Object -First 1).LastWriteTime
    if ($asarAge -lt $srcAge) {
        Write-Host "  WARNING: app.asar is older than source - possible stale build!" -ForegroundColor Yellow
    } else {
        Write-Host "  Verified: app.asar is newer than source files" -ForegroundColor Green
    }
}

# Step 4: Create portable zip
Write-Host "`n=== Step 4/6: Create portable zip ===" -ForegroundColor Cyan
$zipPath = "$root\dist\microclaw-portable.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path "$root\desktop\release\win-unpacked\*" -DestinationPath $zipPath
$zipSizeMB = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
Write-Host "  -> $zipPath  ${zipSizeMB} MB"

# Step 5: Build installer (onedir mode to avoid WDAC blocking DLLs from temp)
Write-Host "`n=== Step 5/6: Build installer ===" -ForegroundColor Cyan
Push-Location $root
$installerBuilt = $false

# --- Ensure Python dependencies are installed (like npm install for Node) ---
$uvCmd = Get-Command uv -ErrorAction SilentlyContinue
if ($uvCmd) {
    # uv manages .venv automatically; `uv sync` is fast and idempotent
    if (-not (Test-Path "$root\.venv\Scripts\pyinstaller.exe")) {
        Write-Host "  Python deps not found — running 'uv sync'..." -ForegroundColor Yellow
        uv sync 2>&1 | ForEach-Object { Write-Host "  $_" }
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  WARNING: uv sync failed" -ForegroundColor Yellow
        }
    }
} else {
    # Fallback: use pip with system/venv Python
    $pipTarget = $null
    if (Test-Path "$root\.venv\Scripts\pip.exe") {
        $pipTarget = "$root\.venv\Scripts\pip.exe"
    } else {
        $pipCmd = Get-Command pip -ErrorAction SilentlyContinue
        if ($pipCmd) { $pipTarget = $pipCmd.Source }
    }
    if ($pipTarget -and -not (Test-Path "$root\.venv\Scripts\pyinstaller.exe") -and
        -not (Get-Command pyinstaller -ErrorAction SilentlyContinue)) {
        Write-Host "  Python deps not found — running 'pip install -r requirements.txt'..." -ForegroundColor Yellow
        & $pipTarget install -r "$root\requirements.txt" 2>&1 | ForEach-Object { Write-Host "  $_" }
        if ($LASTEXITCODE -ne 0) {
            Write-Host "  WARNING: pip install failed" -ForegroundColor Yellow
        }
    }
}

# --- Run PyInstaller ---
# Strategy 1: `uv run` — uses project .venv with all deps
if (-not $installerBuilt -and $uvCmd) {
    Write-Host "  Trying: uv run pyinstaller" -ForegroundColor DarkGray
    uv run pyinstaller MicroClawDeployer.spec --noconfirm
    if ($LASTEXITCODE -eq 0) { $installerBuilt = $true }
}

# Strategy 2: project-local .venv
if (-not $installerBuilt -and (Test-Path "$root\.venv\Scripts\pyinstaller.exe")) {
    Write-Host "  Trying: .venv\Scripts\pyinstaller.exe" -ForegroundColor DarkGray
    & "$root\.venv\Scripts\pyinstaller.exe" MicroClawDeployer.spec --noconfirm
    if ($LASTEXITCODE -eq 0) { $installerBuilt = $true }
}

# Strategy 3: pyinstaller on PATH
if (-not $installerBuilt) {
    $pyinstaller = Get-Command pyinstaller -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty Source
    if ($pyinstaller) {
        Write-Host "  Trying: $pyinstaller" -ForegroundColor DarkGray
        & $pyinstaller MicroClawDeployer.spec --noconfirm
        if ($LASTEXITCODE -eq 0) { $installerBuilt = $true }
    }
}

# Strategy 4: python -m PyInstaller
if (-not $installerBuilt) {
    $pythonCmd = Get-Command python -ErrorAction SilentlyContinue
    $pythonOk  = $false
    if ($pythonCmd) {
        $ver = & python --version 2>&1
        if ($LASTEXITCODE -eq 0 -and $ver -match '^Python ') { $pythonOk = $true }
    }
    if ($pythonOk) {
        Write-Host "  Trying: python -m PyInstaller" -ForegroundColor DarkGray
        python -m PyInstaller MicroClawDeployer.spec --noconfirm
        if ($LASTEXITCODE -eq 0) { $installerBuilt = $true }
    }
}

if (-not $installerBuilt) {
    Write-Host "  ERROR: Could not build installer. All strategies failed." -ForegroundColor Red
    Write-Host "  The .spec file requires both pyinstaller and pywebview." -ForegroundColor Red
    Write-Host "  Recommended: install uv (https://docs.astral.sh/uv/) then run build.ps1 again." -ForegroundColor Yellow
    Write-Host "  Or manually:  pip install -r requirements.txt" -ForegroundColor Yellow
}
Pop-Location

if (-not $installerBuilt) {
    Write-Host "`n=== Build FAILED: installer was not produced ===" -ForegroundColor Red
    Write-Host "  Portable zip was built at: $zipPath" -ForegroundColor Yellow
    Write-Host "  But MicroClawInstaller.exe is missing — end users cannot install." -ForegroundColor Yellow
    exit 1
}

# Step 6: Pack onedir output into a single distributable zip
Write-Host "`n=== Step 6/6: Pack installer directory ===" -ForegroundColor Cyan
$installerDir = "$root\dist\MicroClawInstaller"
$installerZip = "$root\dist\MicroClawInstaller.zip"
if (-not (Test-Path $installerDir)) {
    Write-Host "  ERROR: installer directory not found at $installerDir" -ForegroundColor Red
    Write-Host "         PyInstaller reported success but produced no output." -ForegroundColor Red
    exit 1
}
if (Test-Path $installerZip) { Remove-Item $installerZip -Force }
Compress-Archive -Path "$installerDir\*" -DestinationPath $installerZip
$instZipSizeMB = [math]::Round((Get-Item $installerZip).Length / 1MB, 1)
Write-Host "  -> $installerZip  ${instZipSizeMB} MB" -ForegroundColor Green

Write-Host "`n=== Done ===" -ForegroundColor Green
Write-Host "  Installer dir: $root\dist\MicroClawInstaller\"
Write-Host "  Installer zip: $installerZip"
Write-Host "  Portable:      $zipPath"
