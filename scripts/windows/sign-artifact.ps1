<#
.SYNOPSIS
    Authenticode-sign one or more files with Azure Trusted Signing (via signtool).

.DESCRIPTION
    This is the code-signing step for MicroClaw's release pipeline. It signs the
    single downloadable installer (dist\MicroClawSetup.exe) so Microsoft Defender
    SmartScreen no longer blocks it as an "unrecognized app".

    IMPORTANT — this script is OPT-IN and a NO-OP unless Trusted Signing is
    configured via environment variables. That keeps local developer builds and
    PR/CI builds (which have no signing secrets, and may run on forks) completely
    unchanged: they simply produce an unsigned artifact, exactly as before.

    Signing is enabled only when ALL of these are present:
        TRUSTED_SIGNING_ENDPOINT   e.g. https://wus2.codesigning.azure.net
        TRUSTED_SIGNING_ACCOUNT    your Trusted Signing account name
        TRUSTED_SIGNING_PROFILE    the certificate profile name

    Azure authentication is handled by the Trusted Signing dlib via
    Azure.Identity's DefaultAzureCredential. In CI, set a service principal:
        AZURE_TENANT_ID / AZURE_CLIENT_ID / AZURE_CLIENT_SECRET
    Locally you can instead use `az login` or a managed identity.

    Requirements (auto-resolved where possible):
      * signtool.exe from a Windows 10/11 SDK build >= 10.0.22621 (dlib support).
      * The Azure.CodeSigning.Dlib.dll from the NuGet package
        `Microsoft.Trusted.Signing.Client` (downloaded + cached on first use).

.PARAMETER Path
    One or more files to sign.

.EXAMPLE
    pwsh scripts\windows\sign-artifact.ps1 -Path dist\MicroClawSetup.exe
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, Position = 0)]
    [string[]]$Path,

    [string]$Endpoint      = $env:TRUSTED_SIGNING_ENDPOINT,
    [string]$Account       = $env:TRUSTED_SIGNING_ACCOUNT,
    [string]$CertProfile   = $env:TRUSTED_SIGNING_PROFILE,
    [string]$TimestampUrl  = $(if ($env:TRUSTED_SIGNING_TIMESTAMP_URL) { $env:TRUSTED_SIGNING_TIMESTAMP_URL } else { 'http://timestamp.acs.microsoft.com' }),
    [string]$ClientVersion = $(if ($env:TRUSTED_SIGNING_CLIENT_VERSION) { $env:TRUSTED_SIGNING_CLIENT_VERSION } else { '1.0.86' })
)

$ErrorActionPreference = 'Stop'

function Write-Info($m) { Write-Host "  [sign] $m" }

# --- Gate: skip cleanly when Trusted Signing is not configured ---------------
if (-not ($Endpoint -and $Account -and $CertProfile)) {
    Write-Info 'Trusted Signing not configured (TRUSTED_SIGNING_ENDPOINT/ACCOUNT/PROFILE unset) - skipping code signing.'
    Write-Info 'Artifacts will be produced UNSIGNED. This is expected for local and PR builds.'
    exit 0
}

# --- Resolve a signtool.exe new enough for /dlib (Trusted Signing) -----------
function Resolve-SignTool {
    if ($env:SIGNTOOL_PATH -and (Test-Path $env:SIGNTOOL_PATH)) { return $env:SIGNTOOL_PATH }

    $kitBins = @(
        "${env:ProgramFiles(x86)}\Windows Kits\10\bin",
        "$env:ProgramFiles\Windows Kits\10\bin"
    ) | Where-Object { Test-Path $_ }

    $candidates = foreach ($root in $kitBins) {
        Get-ChildItem $root -Directory -ErrorAction SilentlyContinue |
            Where-Object { $_.Name -match '^10\.' } |
            ForEach-Object {
                $exe = Join-Path $_.FullName 'x64\signtool.exe'
                if (Test-Path $exe) { [pscustomobject]@{ Version = [version]$_.Name; Path = $exe } }
            }
    }
    # Trusted Signing dlib requires SDK build >= 10.0.22621.
    $best = $candidates | Where-Object { $_.Version -ge [version]'10.0.22621.0' } |
        Sort-Object Version -Descending | Select-Object -First 1
    if (-not $best) {
        throw "No signtool.exe (Windows SDK >= 10.0.22621) found. Install the Windows 11 SDK, or set SIGNTOOL_PATH."
    }
    return $best.Path
}

# --- Ensure the Azure Trusted Signing dlib is available (cached) --------------
function Resolve-Dlib {
    param([string]$Version)

    $cacheRoot = Join-Path $env:LOCALAPPDATA "MicroClaw\trusted-signing\$Version"
    $existing = Get-ChildItem $cacheRoot -Recurse -Filter 'Azure.CodeSigning.Dlib.dll' -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($existing) { return $existing.FullName }

    New-Item -ItemType Directory -Force -Path $cacheRoot | Out-Null
    $nupkg = Join-Path $cacheRoot "package.zip"
    $url = "https://www.nuget.org/api/v2/package/Microsoft.Trusted.Signing.Client/$Version"
    Write-Info "Downloading Microsoft.Trusted.Signing.Client $Version ..."
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -Uri $url -OutFile $nupkg -UseBasicParsing

    $extractDir = Join-Path $cacheRoot 'pkg'
    if (Test-Path $extractDir) { Remove-Item $extractDir -Recurse -Force }
    Expand-Archive -Path $nupkg -DestinationPath $extractDir -Force

    $dll = Get-ChildItem $extractDir -Recurse -Filter 'Azure.CodeSigning.Dlib.dll' -ErrorAction SilentlyContinue |
        Where-Object { $_.FullName -match '\\x64\\' } | Select-Object -First 1
    if (-not $dll) {
        $dll = Get-ChildItem $extractDir -Recurse -Filter 'Azure.CodeSigning.Dlib.dll' -ErrorAction SilentlyContinue |
            Select-Object -First 1
    }
    if (-not $dll) {
        throw "Azure.CodeSigning.Dlib.dll not found inside Microsoft.Trusted.Signing.Client $Version."
    }
    return $dll.FullName
}

$signtool = Resolve-SignTool
$dlib     = Resolve-Dlib -Version $ClientVersion
Write-Info "signtool: $signtool"
Write-Info "dlib:     $dlib"

# --- Trusted Signing metadata file (account + certificate profile) -----------
$metadata = @{
    Endpoint               = $Endpoint
    CodeSigningAccountName = $Account
    CertificateProfileName = $CertProfile
} | ConvertTo-Json
$metadataFile = Join-Path ([IO.Path]::GetTempPath()) "trusted-signing-$([guid]::NewGuid().ToString('N')).json"
Set-Content -Path $metadataFile -Value $metadata -Encoding UTF8

try {
    foreach ($file in $Path) {
        if (-not (Test-Path $file)) { throw "File to sign not found: $file" }
        $full = (Resolve-Path $file).Path
        Write-Info "Signing $full"
        & $signtool sign /v /debug /fd SHA256 `
            /tr $TimestampUrl /td SHA256 `
            /dlib $dlib /dmdf $metadataFile `
            $full
        if ($LASTEXITCODE -ne 0) { throw "signtool sign failed (exit $LASTEXITCODE) for $full" }

        & $signtool verify /pa /v $full
        if ($LASTEXITCODE -ne 0) { throw "signtool verify failed (exit $LASTEXITCODE) for $full" }
        Write-Info "Signed + verified: $full"
    }
}
finally {
    Remove-Item $metadataFile -Force -ErrorAction SilentlyContinue
}

Write-Info "Code signing complete."
