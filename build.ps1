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
Write-Host "`n=== Step 1/8: Build AppContainerLauncher ===" -ForegroundColor Cyan
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
Write-Host "`n=== Step 2/8: Clean stale build artifacts ===" -ForegroundColor Cyan
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
Write-Host "`n=== Step 3/8: Build & pack desktop ===" -ForegroundColor Cyan
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

# Step 4: Stage a self-contained Weixin runtime from pinned npm archives.
# OpenClaw does not install dependencies for local directory installs, so the
# installer must carry the plugin's production node_modules.
Write-Host "`n=== Step 4/8: Stage Weixin plugin ===" -ForegroundColor Cyan
$weixinDir = "$root\plugins\openclaw-weixin"
$weixinPackage = Get-Content "$weixinDir\package.json" -Raw | ConvertFrom-Json
$weixinManifest = Get-Content "$weixinDir\openclaw.plugin.json" -Raw | ConvertFrom-Json
if ($weixinPackage.version -ne $weixinManifest.version) {
    Write-Host "  ERROR: Weixin package and manifest versions do not match" -ForegroundColor Red
    exit 1
}

$weixinVendor = "$weixinDir\vendor"
$weixinArchive = "$weixinVendor\tencent-weixin-openclaw-weixin-2.4.6.tgz"
$zodArchive = "$weixinVendor\zod-4.4.3.tgz"
$qrcodeArchive = "$weixinVendor\qrcode-terminal-0.12.0.tgz"
$weixinArchives = @(
    [PSCustomObject]@{
        Path = $weixinArchive
        Sha256 = 'ef1c3600ca2fc0ee9076c1327af1e0d5d2e8e19fbb61e9f56c961fcde0bd07f6'
    },
    [PSCustomObject]@{
        Path = $zodArchive
        Sha256 = 'ee38f17f533fd500610685a483ae2f413c26f4eb33a51684314563c8d60f279c'
    },
    [PSCustomObject]@{
        Path = $qrcodeArchive
        Sha256 = '3a6260c4e0d80bd527a3f930e90ea2348c03646621f25aa0bd960ee205a0a706'
    }
)
foreach ($archive in $weixinArchives) {
    if (-not (Test-Path $archive.Path)) {
        Write-Host "  ERROR: Vendored Weixin archive is missing: $($archive.Path)" -ForegroundColor Red
        exit 1
    }
    $actualHash = (Get-FileHash $archive.Path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualHash -ne $archive.Sha256) {
        Write-Host "  ERROR: Vendored Weixin archive checksum mismatch: $($archive.Path)" -ForegroundColor Red
        exit 1
    }
}

$weixinStage = "$outDist\openclaw-weixin"
if (Test-Path $weixinStage) { Remove-Item $weixinStage -Recurse -Force }
$weixinInstallRoot = "$outDist\openclaw-weixin-offline-install"
if (Test-Path $weixinInstallRoot) { Remove-Item $weixinInstallRoot -Recurse -Force }
New-Item -ItemType Directory -Path $weixinInstallRoot -Force | Out-Null

try {
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    npm install --prefix $weixinInstallRoot --offline --ignore-scripts `
        --omit=dev --omit=peer --legacy-peer-deps --no-package-lock --no-save `
        $weixinArchive $zodArchive $qrcodeArchive 2>&1 |
        ForEach-Object { Write-Host "  $_" }
    $weixinInstallExitCode = $LASTEXITCODE
    $ErrorActionPreference = $previousPreference
    if ($weixinInstallExitCode -ne 0) {
        Write-Host "  ERROR: Vendored Weixin package installation failed" -ForegroundColor Red
        exit 1
    }

    $weixinInstalled = "$weixinInstallRoot\node_modules\@tencent-weixin\openclaw-weixin"
    $installedPackage = Get-Content "$weixinInstalled\package.json" -Raw | ConvertFrom-Json
    $installedManifest = Get-Content "$weixinInstalled\openclaw.plugin.json" -Raw | ConvertFrom-Json
    if ($installedPackage.version -ne $weixinPackage.version -or
        $installedManifest.version -ne $weixinManifest.version) {
        Write-Host "  ERROR: Vendored Weixin version does not match tracked metadata" -ForegroundColor Red
        exit 1
    }
    if (-not (Test-Path "$weixinInstalled\dist\index.js")) {
        Write-Host "  ERROR: Vendored Weixin plugin is missing dist\index.js" -ForegroundColor Red
        exit 1
    }

    Copy-Item $weixinInstalled $weixinStage -Recurse -Force
    New-Item -ItemType Directory -Path "$weixinStage\node_modules" -Force | Out-Null
    Copy-Item "$weixinInstallRoot\node_modules\zod" `
        "$weixinStage\node_modules\zod" -Recurse -Force
    Copy-Item "$weixinInstallRoot\node_modules\qrcode-terminal" `
        "$weixinStage\node_modules\qrcode-terminal" -Recurse -Force
} finally {
    if (Test-Path $weixinInstallRoot) {
        Remove-Item $weixinInstallRoot -Recurse -Force
    }
}

# The staged package is runtime-only. Removing devDependencies avoids pulling a
# second OpenClaw toolchain if the staged package is inspected by npm tooling.
$runtimePackage = Get-Content "$weixinStage\package.json" -Raw | ConvertFrom-Json
$runtimePackage.PSObject.Properties.Remove('devDependencies')
$runtimeJson = $runtimePackage | ConvertTo-Json -Depth 20
[IO.File]::WriteAllText(
    "$weixinStage\package.json",
    $runtimeJson + [Environment]::NewLine,
    (New-Object Text.UTF8Encoding($false))
)

foreach ($dependency in @('zod', 'qrcode-terminal')) {
    if (-not (Test-Path "$weixinStage\node_modules\$dependency\package.json")) {
        Write-Host "  ERROR: Weixin runtime dependency '$dependency' is missing" -ForegroundColor Red
        exit 1
    }
}
Write-Host "  Verified: openclaw-weixin $($weixinPackage.version), runtime dependencies bundled" -ForegroundColor Green

# Step 5: Create portable zip
Write-Host "`n=== Step 5/8: Create portable zip ===" -ForegroundColor Cyan
$zipPath = "$root\dist\microclaw-portable.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path "$root\desktop\release\win-unpacked\*" -DestinationPath $zipPath
$zipSizeMB = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
Write-Host "  -> $zipPath  ${zipSizeMB} MB"

# Step 6: Build installer (onedir mode to avoid WDAC blocking DLLs from temp)
Write-Host "`n=== Step 6/8: Build installer ===" -ForegroundColor Cyan
Push-Location $root
$installerBuilt = $false

# --- Ensure Python dependencies are installed (like npm install for Node) ---
$uvCmd = Get-Command uv -ErrorAction SilentlyContinue
$hasUvProject = $false
if ($uvCmd -and (Test-Path "$root\pyproject.toml")) {
    $hasUvProject = [bool](Select-String -Path "$root\pyproject.toml" -Pattern '^\s*\[project\]\s*$')
}
if ($hasUvProject) {
    # uv manages .venv automatically for installable projects.
    if (-not (Test-Path "$root\.venv\Scripts\pyinstaller.exe")) {
        Write-Host "  Python deps not found — running 'uv sync'..." -ForegroundColor Yellow
        $previousPreference = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        & $uvCmd.Source sync 2>&1 | ForEach-Object { Write-Host "  $_" }
        $uvExitCode = $LASTEXITCODE
        $ErrorActionPreference = $previousPreference
        if ($uvExitCode -ne 0) {
            Write-Host "  WARNING: uv sync failed" -ForegroundColor Yellow
        }
    }
} elseif ($uvCmd) {
    # This repository declares Python dependencies in requirements.txt.
    if (-not (Test-Path "$root\.venv\Scripts\pyinstaller.exe")) {
        $venvPython = "$root\.venv\Scripts\python.exe"
        $venvReady = Test-Path $venvPython
        if (-not $venvReady) {
            Write-Host "  Python environment not found — running 'uv venv --python 3.12'..." -ForegroundColor Yellow
            & $uvCmd.Source venv --python 3.12 "$root\.venv"
            $venvReady = $LASTEXITCODE -eq 0 -and (Test-Path $venvPython)
        }
        if ($venvReady) {
            Write-Host "  Python deps not found — running 'uv pip install -r requirements.txt'..." -ForegroundColor Yellow
            & $uvCmd.Source pip install --python $venvPython -r "$root\requirements.txt"
        }
        if (-not $venvReady -or $LASTEXITCODE -ne 0 -or
            -not (Test-Path "$root\.venv\Scripts\pyinstaller.exe")) {
            Write-Host "  WARNING: uv dependency installation failed" -ForegroundColor Yellow
        }
    }
} else {
    # This repository keeps runtime/build dependencies in requirements.txt;
    # pyproject.toml only configures Ruff and is not an installable uv project.
    $previousPreference = $ErrorActionPreference
    $ErrorActionPreference = "Continue"
    python -c "import PyInstaller" *> $null
    $pythonHasPyInstaller = $LASTEXITCODE -eq 0
    $ErrorActionPreference = $previousPreference
    if (-not (Test-Path "$root\.venv\Scripts\pyinstaller.exe") -and
        -not (Get-Command pyinstaller -ErrorAction SilentlyContinue) -and
        -not $pythonHasPyInstaller) {
        Write-Host "  Python deps not found — running 'pip install -r requirements.txt'..." -ForegroundColor Yellow
        $previousPreference = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        python -m pip install -r "$root\requirements.txt" 2>&1 | ForEach-Object { Write-Host "  $_" }
        $pipExitCode = $LASTEXITCODE
        $ErrorActionPreference = $previousPreference
        if ($pipExitCode -ne 0) {
            Write-Host "  WARNING: pip install failed" -ForegroundColor Yellow
        }
    }
}

# --- Run PyInstaller ---
# Strategy 1: `uv run` — uses project .venv with all deps
if (-not $installerBuilt -and $hasUvProject) {
    Write-Host "  Trying: uv run pyinstaller" -ForegroundColor DarkGray
    & $uvCmd.Source run pyinstaller MicroClawDeployer.spec --noconfirm
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

# Step 7: Pack onedir output into a single distributable zip
Write-Host "`n=== Step 7/8: Pack installer directory ===" -ForegroundColor Cyan
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

# Step 8: Build the single-exe setup (NSIS self-extractor) and code-sign it.
# This is the ONE file end users download. It extracts the onedir installer to a
# real directory under %LOCALAPPDATA% (not %TEMP%, preserving WDAC safety) and
# auto-launches MicroClawInstaller.exe. Only this stub needs signing to clear
# SmartScreen (it is the only file that carries Mark-of-the-Web on download).
Write-Host "`n=== Step 8/8: Build single-exe setup + sign ===" -ForegroundColor Cyan
$setupExe = "$root\dist\MicroClawSetup.exe"
$nsiScript = "$root\installer\microclaw-setup.nsi"
$setupIcon = "$root\deployer\assets\microclaw.ico"

# Resolve makensis: PATH first, then common install locations, then the copy
# that ships inside electron-builder's cache (already present after Step 3).
$makensis = $null
$mkCmd = Get-Command makensis -ErrorAction SilentlyContinue
if ($mkCmd) { $makensis = $mkCmd.Source }
if (-not $makensis) {
    $mkCandidates = @(
        "${env:ProgramFiles(x86)}\NSIS\makensis.exe",
        "$env:ProgramFiles\NSIS\makensis.exe"
    )
    $mkCandidates += Get-ChildItem "$env:LOCALAPPDATA\electron-builder\Cache\nsis" -Recurse -Filter makensis.exe -ErrorAction SilentlyContinue |
        Select-Object -ExpandProperty FullName
    $makensis = $mkCandidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
}

if (-not $makensis) {
    Write-Host "  ERROR: makensis (NSIS) not found. Install NSIS 3.x (e.g. 'choco install nsis')." -ForegroundColor Red
    Write-Host "         The onedir installer + zip were still produced." -ForegroundColor Yellow
    exit 1
}
Write-Host "  Using makensis: $makensis"

# Derive a 4-part version (NSIS VIProductVersion requires X.X.X.X).
$pkgVersion = '0.0.0'
try {
    $pkgVersion = (Get-Content "$root\desktop\package.json" -Raw | ConvertFrom-Json).version
} catch { }
$verParts = @($pkgVersion -split '\.') + @('0','0','0','0')
$version4 = ($verParts[0..3]) -join '.'

if (Test-Path $setupExe) { Remove-Item $setupExe -Force }

$prev = $ErrorActionPreference
$ErrorActionPreference = "Continue"
& $makensis `
    "/INPUTCHARSET" `
    "UTF8" `
    "/DPAYLOAD_DIR=$installerDir" `
    "/DOUT_FILE=$setupExe" `
    "/DICON=$setupIcon" `
    "/DVERSION=$version4" `
    $nsiScript 2>&1 | ForEach-Object { Write-Host "  $_" }
$nsisExit = $LASTEXITCODE
$ErrorActionPreference = $prev
if ($nsisExit -ne 0 -or -not (Test-Path $setupExe)) {
    Write-Host "  ERROR: makensis failed (exit $nsisExit) — MicroClawSetup.exe not produced." -ForegroundColor Red
    exit 1
}
$setupSizeMB = [math]::Round((Get-Item $setupExe).Length / 1MB, 1)
Write-Host "  -> $setupExe  ${setupSizeMB} MB" -ForegroundColor Green

# Code-sign the setup exe. This is a NO-OP unless Trusted Signing is configured
# (TRUSTED_SIGNING_ENDPOINT/ACCOUNT/PROFILE), so local + PR builds are unchanged.
# Run in a child process using the SAME PowerShell host (the signer calls
# `exit`, which would otherwise terminate this build script).
$psHost = (Get-Process -Id $PID).Path
if (-not $psHost) { $psHost = 'powershell' }
& $psHost -NoProfile -File "$root\scripts\windows\sign-artifact.ps1" -Path $setupExe
if ($LASTEXITCODE -ne 0) {
    Write-Host "  ERROR: signing step failed (exit $LASTEXITCODE)." -ForegroundColor Red
    exit 1
}

Write-Host "`n=== Done ===" -ForegroundColor Green
Write-Host "  Setup (one-exe): $setupExe"
Write-Host "  Installer dir:   $root\dist\MicroClawInstaller\"
Write-Host "  Installer zip:   $installerZip"
Write-Host "  Portable:        $zipPath"
