#Requires -Version 5.1
# Only operates in a uniquely named temporary fixture, never a user profile.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '..\reset-microclaw-for-first-install.ps1')

$testTemp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')
$testRoot = Join-Path $testTemp ('microclaw-reset-safety-' + [Guid]::NewGuid().ToString('N'))
if (-not $testRoot.StartsWith($testTemp + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Test fixture escaped the temporary directory'
}
New-Item -ItemType Directory -Path $testRoot | Out-Null
$owned = Join-Path $testRoot 'owned'
$outside = Join-Path $testRoot 'outside'
New-Item -ItemType Directory -Path $owned, $outside | Out-Null
$kept = Join-Path $outside 'keep.txt'
[IO.File]::WriteAllText($kept, 'must survive')
$checks = 0
try {
    if (-not (Test-CleanupPath (Join-Path $owned 'nested') @($owned))) { throw 'Child path rejected' }
    if (Test-CleanupPath ($owned + '-other') @($owned)) { throw 'Sibling prefix accepted' }
    if (Test-CleanupPath (Join-Path $owned '..\outside') @($owned)) { throw 'Traversal accepted' }
    $checks += 3

    $rejected = $false
    try { Remove-CleanupTree -Path $outside -AllowedRoot $owned } catch { $rejected = $true }
    if (-not $rejected -or -not (Test-Path -LiteralPath $kept)) { throw 'Outside-root deletion was not rejected' }
    $checks++

    $linked = Join-Path $owned 'linked-peer'
    New-Item -ItemType Junction -Path $linked -Target $outside | Out-Null
    $rejected = $false
    try { Remove-CleanupTree -Path (Join-Path $linked 'keep.txt') -AllowedRoot $owned } catch { $rejected = $true }
    if (-not $rejected -or -not (Test-Path -LiteralPath $kept)) { throw 'Redirected ancestor was followed' }
    $checks++

    $nested = Join-Path $owned 'spaces [literal]'
    [IO.Directory]::CreateDirectory($nested) | Out-Null
    $readOnly = Join-Path $nested 'read-only.txt'
    [IO.File]::WriteAllText($readOnly, 'remove')
    [IO.File]::SetAttributes($readOnly, [IO.FileAttributes]::ReadOnly)
    Remove-CleanupTree -Path $owned -AllowedRoot $owned
    if (Test-Path -LiteralPath $owned) { throw 'Allowlisted tree was not removed' }
    if ([IO.File]::ReadAllText($kept) -ne 'must survive') { throw 'Junction target was modified' }
    $checks += 2

    $processPath = [Environment]::GetEnvironmentVariable('Path', 'Process')
    try {
        $fixturePath = $owned + ';' + ($owned + '-other') + ';' + $outside
        [Environment]::SetEnvironmentVariable('Path', $fixturePath, 'Process')
        Remove-CleanupPathEntries -Scope Process -Roots @($owned) -WhatIf
        if ([Environment]::GetEnvironmentVariable('Path', 'Process') -ne $fixturePath) { throw 'WhatIf changed PATH' }
        Remove-CleanupPathEntries -Scope Process -Roots @($owned)
        if ([Environment]::GetEnvironmentVariable('Path', 'Process') -ne (($owned + '-other') + ';' + $outside)) {
            throw 'PATH cleanup removed an unrelated entry'
        }
        $checks += 2
    } finally {
        [Environment]::SetEnvironmentVariable('Path', $processPath, 'Process')
    }
    Write-Output "PASS: $checks safety checks (literal paths, traversal, junctions, read-only files, PATH and WhatIf)."
} finally {
    if ([IO.Path]::GetFullPath($testRoot) -ne $testRoot -or
        -not $testRoot.StartsWith($testTemp + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Unsafe test cleanup target'
    }
    Remove-CleanupTree -Path $testRoot -AllowedRoot $testRoot
}
