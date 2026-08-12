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
        'resources\mxc-plugin\index.mjs',
        'resources\mxc-plugin\runtime.mjs',
        'resources\mxc-plugin\worker.mjs',
        'resources\mxc-plugin\openclaw.plugin.json',
        'resources\mxc-plugin\node_modules\@microsoft\mxc-sdk\package.json',
        'resources\mxc-plugin\node_modules\@microsoft\mxc-sdk\bin\x64\wxc-exec.exe',
        'resources\mxc-plugin\node_modules\node-pty\package.json',
        'resources\mxc-plugin\node_modules\semver\package.json'
    )
    $packageFiles = $archive.Entries.FullName |
        ForEach-Object { [Uri]::UnescapeDataString($_).Replace('/', '\') }
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
