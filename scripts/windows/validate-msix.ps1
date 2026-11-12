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
        'resources\windows-node\RUNTIME.json',
        'resources\windows-node\host\microclaw-windows-node-host.exe',
        'resources\openclaw-weixin\microclaw-runtime.json'
    )
    $packageFiles = $archive.Entries.FullName |
        ForEach-Object { [Uri]::UnescapeDataString($_).Replace('/', '\') }
    foreach ($relativePath in $packageFiles) {
        if ($relativePath -match '(?i)(^|\\)resources\\(AppContainerLauncher\.exe|sandbox-(preload|host-runtime|state|permission|fs-hooks|cp-hooks|sensitive)\.js|path-extraction\.js)$') {
            throw "MSIX contains a retired AppContainer resource: $relativePath"
        }
    }
    foreach ($relativePath in $required) {
        $found = $packageFiles |
            Where-Object { $_.EndsWith($relativePath, [StringComparison]::OrdinalIgnoreCase) } |
            Select-Object -First 1
        if (-not $found) { throw "MSIX is missing required file: $relativePath" }
    }

    # The SDK is bundled in the single-file host. Its fixed file worker is
    # installed alongside the host under a manifest-derived payload ID.
    $workerManifests = @($packageFiles | Where-Object {
        $_ -match '(?i)(^|\\)resources\\windows-node\\host\\Workers\\FileWorker\\win-x64\\[a-f0-9]{32}\\payload-manifest\.json$'
    })
    if ($workerManifests.Count -ne 1) {
        throw 'MSIX must contain exactly one x64 FileWorker payload manifest'
    }
    $workerDirectory = [IO.Path]::GetDirectoryName($workerManifests[0])
    foreach ($workerFile in 'OpenClaw.FileWorker.exe', 'coreclr.dll', 'OpenClaw.FileWorker.runtimeconfig.json') {
        $workerPath = Join-Path $workerDirectory $workerFile
        if ($workerPath -notin $packageFiles) {
            throw "MSIX is missing required file: $workerPath"
        }
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
