[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$Path
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$package = (Resolve-Path $Path).Path
if ([IO.Path]::GetExtension($package) -ne '.msix') {
    throw "Expected an .msix package: $package"
}

$archive = [IO.Compression.ZipFile]::OpenRead($package)
try {
    $manifestEntry = $archive.GetEntry('AppxManifest.xml')
    if (-not $manifestEntry) { throw 'MSIX is missing AppxManifest.xml' }

    $reader = [IO.StreamReader]::new($manifestEntry.Open())
    try {
        [xml]$manifest = $reader.ReadToEnd()
    } finally {
        $reader.Dispose()
    }
    $identity = $manifest.Package.Identity
    if (-not $identity.Name -or -not $identity.Publisher -or
        $identity.ProcessorArchitecture -ne 'x64' -or
        $identity.Version -notmatch '^\d+\.\d+\.\d+\.\d+$') {
        throw "Invalid MSIX identity: $($identity.OuterXml)"
    }

    $required = @(
        'MicroClawDesktop.exe',
        'resources\node.exe',
        'resources\openclaw.asar',
        'resources\AppContainerLauncher.exe',
        'resources\sandbox-preload.js',
        'resources\sandbox-state.js',
        'resources\sandbox-permission.js',
        'resources\sandbox-fs-hooks.js',
        'resources\sandbox-cp-hooks.js',
        'resources\sandbox-sensitive.js',
        'resources\path-extraction.js'
    )
    $packageFiles = $archive.Entries.FullName | ForEach-Object { $_.Replace('/', '\') }
    foreach ($relativePath in $required) {
        $found = $packageFiles |
            Where-Object { $_.EndsWith($relativePath, [StringComparison]::OrdinalIgnoreCase) } |
            Select-Object -First 1
        if (-not $found) { throw "MSIX is missing required file: $relativePath" }
    }

    Write-Host "Validated $package"
    Write-Host "  Identity: $($identity.Name)"
    Write-Host "  Publisher: $($identity.Publisher)"
    Write-Host "  Version: $($identity.Version)"
    Write-Host "  Architecture: $($identity.ProcessorArchitecture)"
}
finally {
    $archive.Dispose()
}
