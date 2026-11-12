#Requires -Version 5.1
<#
.SYNOPSIS
Remove the current user's MicroClaw/OpenClaw installation and state without backup.
.DESCRIPTION
Deletes chat history, credentials, settings, plugins, managed Node/Git, the
per-user OpenClaw npm package, runtime caches and extracted installer caches.
Only allowlisted paths are removed. Directory junctions/symlinks are unlinked,
never traversed. System Node/Git, unrelated npm packages, the repository and
dist/MicroClawSetup.exe are retained. Shared npm caches and Windows caches are
not cleared; this is a cleaned-profile reinstall, not a clean Windows image.

Run from an elevated PowerShell as the SAME Windows user being reset.
No backup is made and no confirmation is requested. -WhatIf is read-only.
Each parent directory is deleted in one native traversal, without per-file
PowerShell path validation or a post-deletion verification pass.
.EXAMPLE
& .\scripts\windows\reset-microclaw-for-first-install.ps1 -WhatIf
.EXAMPLE
& .\scripts\windows\reset-microclaw-for-first-install.ps1
#>
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function ConvertTo-CleanupPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    if (-not [IO.Path]::IsPathRooted($Path)) { throw "Not an absolute path: $Path" }
    return [IO.Path]::GetFullPath($Path).TrimEnd([char[]]'\/')
}

function Test-CleanupPath {
    param([string]$Path, [string[]]$Roots)
    if ([string]::IsNullOrWhiteSpace($Path)) { return $false }
    try { $candidate = ConvertTo-CleanupPath $Path } catch { return $false }
    foreach ($root in $Roots) {
        if ($candidate.Equals($root, [StringComparison]::OrdinalIgnoreCase) -or
            $candidate.StartsWith($root + '\', [StringComparison]::OrdinalIgnoreCase)) {
            return $true
        }
    }
    return $false
}

function Assert-CleanupParents {
    param([Parameter(Mandatory = $true)][string]$Path)
    $parent = [IO.Path]::GetDirectoryName($Path)
    while ($parent) {
        $item = Get-Item -LiteralPath $parent -Force -ErrorAction SilentlyContinue
        if ($null -ne $item -and ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
            throw "Refusing cleanup through a redirected parent: $parent"
        }
        $next = [IO.Path]::GetDirectoryName($parent)
        if ($next -eq $parent) { break }
        $parent = $next
    }
}

function Remove-CleanupTree {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$AllowedRoot
    )
    $absolute = ConvertTo-CleanupPath $Path
    $root = ConvertTo-CleanupPath $AllowedRoot
    if (-not (Test-CleanupPath $absolute @($root))) {
        throw "Cleanup escaped its allowlisted root: $absolute"
    }
    Assert-CleanupParents $absolute
    # Keep the traversal out of PowerShell's per-file pipeline. Read-only files
    # are removed, while junctions are unlinked without entering their targets.
    if (-not ('MicroClawCleanup.FastTreeDelete' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.IO;

namespace MicroClawCleanup {
    public static class FastTreeDelete {
        public static void Remove(string path) {
            FileAttributes attributes;
            try { attributes = File.GetAttributes(path); }
            catch (FileNotFoundException) { return; }
            catch (DirectoryNotFoundException) { return; }
            RemoveEntry(path, attributes);
        }

        private static void RemoveEntry(string path, FileAttributes attributes) {
            bool directory = (attributes & FileAttributes.Directory) != 0;
            if ((attributes & FileAttributes.ReparsePoint) != 0) {
                if (directory) Directory.Delete(path, false);
                else File.Delete(path);
                return;
            }
            if (directory) {
                foreach (FileSystemInfo child in new DirectoryInfo(path).EnumerateFileSystemInfos()) {
                    RemoveEntry(child.FullName, child.Attributes);
                }
            }
            if ((attributes & FileAttributes.ReadOnly) != 0) {
                File.SetAttributes(path, attributes & ~FileAttributes.ReadOnly);
            }
            if (directory) Directory.Delete(path, false);
            else File.Delete(path);
        }
    }
}
'@
    }
    [MicroClawCleanup.FastTreeDelete]::Remove($absolute)
}

function Test-OwnedCommand {
    param([string]$Command, [string[]]$Roots)
    if (-not $Command) { return $false }
    $normalized = $Command.Replace('/', '\')
    foreach ($root in $Roots) {
        if ($normalized.IndexOf($root + '\', [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            return $true
        }
    }
    return $false
}

function Get-OwnedCleanupProcesses {
    param([string[]]$Roots, [string]$UserSid)
    $processes = @(Get-CimInstance Win32_Process)
    $selected = @{}
    foreach ($process in $processes) {
        if ($process.ProcessId -eq $PID) { continue }
        $named = $process.Name -in @('MicroClawDesktop.exe', 'MicroClawInstaller.exe', 'MicroClawSetup.exe')
        $located = Test-CleanupPath $process.ExecutablePath $Roots
        $gateway = $process.Name -in @('node.exe', 'openclaw.exe') -and
            (Test-OwnedCommand $process.CommandLine $Roots)
        if (-not ($named -or $located -or $gateway)) { continue }
        $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid
        if ($owner.ReturnValue -eq 0 -and $owner.Sid -eq $UserSid) {
            $selected[[int]$process.ProcessId] = $process
        }
    }
    # Include only same-user descendants of the selected application processes.
    do {
        $added = $false
        foreach ($process in $processes) {
            if ($process.ProcessId -eq $PID -or $selected.ContainsKey([int]$process.ProcessId) -or
                -not $selected.ContainsKey([int]$process.ParentProcessId)) { continue }
            $parent = $selected[[int]$process.ParentProcessId]
            if ($process.CreationDate -lt $parent.CreationDate) { continue }
            $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid
            if ($owner.ReturnValue -eq 0 -and $owner.Sid -eq $UserSid) {
                $selected[[int]$process.ProcessId] = $process
                $added = $true
            }
        }
    } while ($added)
    return @($selected.Values | Sort-Object CreationDate -Descending)
}

function Remove-CleanupPathEntries {
    [CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
    param([string]$Scope, [string[]]$Roots)
    $original = [Environment]::GetEnvironmentVariable('Path', $Scope)
    if (-not $original) { return }
    $retained = @(); $removed = @()
    foreach ($entry in ($original -split ';')) {
        $expanded = [Environment]::ExpandEnvironmentVariables($entry.Trim().Trim('"'))
        if (Test-CleanupPath $expanded $Roots) { $removed += $entry }
        else { $retained += $entry }
    }
    if ($removed.Count -and $PSCmdlet.ShouldProcess("$Scope PATH: $($removed -join ';')", 'Remove application entries')) {
        [Environment]::SetEnvironmentVariable('Path', ($retained -join ';'), $Scope)
    }
}

# Dot-sourcing defines helpers for isolated safety checks; it never resets a profile.
if ($MyInvocation.InvocationName -eq '.') { return }

$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$principal = New-Object Security.Principal.WindowsPrincipal($identity)
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) -and -not $WhatIfPreference) {
    throw 'Open PowerShell as administrator using the Windows account you want to reset.'
}
$profileRoot = ConvertTo-CleanupPath ([Environment]::GetFolderPath('UserProfile'))
$roamingRoot = ConvertTo-CleanupPath ([Environment]::GetFolderPath('ApplicationData'))
$localRoot = ConvertTo-CleanupPath ([Environment]::GetFolderPath('LocalApplicationData'))
$npmRoot = Join-Path $roamingRoot 'npm'
$cleanupRoots = @(
    (Join-Path $profileRoot '.microclaw'),
    (Join-Path $profileRoot '.openclaw'),
    (Join-Path $profileRoot '.openclaw-node'),
    (Join-Path $profileRoot '.openclaw-git'),
    (Join-Path $roamingRoot 'microclaw'),
    (Join-Path $roamingRoot 'MicroClawDesktop'),
    (Join-Path $roamingRoot 'openclaw'),
    (Join-Path $localRoot 'MicroClaw'),
    (Join-Path $localRoot 'openclaw'),
    (Join-Path $localRoot 'Temp\openclaw'),
    (Join-Path $npmRoot 'node_modules\openclaw')
) | ForEach-Object { ConvertTo-CleanupPath $_ } | Select-Object -Unique

# Validate every final absolute target before the first change. Never delete a
# profile root, a drive root, the script/repository, or a redirected parent tree.
foreach ($target in $cleanupRoots) {
    if (-not (Test-CleanupPath $target @($profileRoot, $roamingRoot, $localRoot)) -or
        $target -in @($profileRoot, $roamingRoot, $localRoot) -or
        (Test-CleanupPath $PSCommandPath @($target))) {
        throw "Unsafe cleanup target: $target"
    }
    Assert-CleanupParents $target
}
foreach ($setting in @('OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH', 'OPENCLAW_NODE_DIR')) {
    $value = [Environment]::GetEnvironmentVariable($setting)
    if ($value -and -not (Test-CleanupPath $value $cleanupRoots)) {
        throw "$setting points outside the standard cleanup scope. No cleanup was started."
    }
}

Write-Host "Reset user: $($identity.Name)" -ForegroundColor Cyan
Write-Host 'No backup. All MicroClaw/OpenClaw history, credentials and settings in these paths will be deleted:' -ForegroundColor Yellow
$cleanupRoots | ForEach-Object { Write-Host "  $_" }

# Stop/remove only tasks whose actions point into this user's application roots.
foreach ($task in @(Get-ScheduledTask | Where-Object { $_.TaskName -match 'MicroClaw|OpenClaw' })) {
    $ownedAction = @($task.Actions | Where-Object {
        (Test-CleanupPath $_.Execute $cleanupRoots) -or
        (Test-OwnedCommand ($_.Execute + ' ' + $_.Arguments) $cleanupRoots)
    })
    if ($ownedAction.Count -and $PSCmdlet.ShouldProcess($task.TaskPath + $task.TaskName, 'Stop and remove application task')) {
        Stop-ScheduledTask -InputObject $task
        Unregister-ScheduledTask -InputObject $task -Confirm:$false
    } elseif (-not $ownedAction.Count) {
        Write-Warning "Task retained because ownership could not be established: $($task.TaskName)"
    }
}

$processes = @(Get-OwnedCleanupProcesses $cleanupRoots $identity.User.Value)
foreach ($process in $processes) {
    if ($PSCmdlet.ShouldProcess("$($process.Name) PID $($process.ProcessId)", 'Stop current-user application process')) {
        $current = Get-CimInstance Win32_Process -Filter "ProcessId=$($process.ProcessId)"
        if ($null -ne $current -and $current.CreationDate -eq $process.CreationDate) {
            Stop-Process -Id $process.ProcessId -Force -ErrorAction Stop
        }
    }
}
foreach ($scope in @('User', 'Machine', 'Process')) { Remove-CleanupPathEntries $scope $cleanupRoots }

$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
if (Test-Path -LiteralPath $runKey) {
    $key = Get-Item -LiteralPath $runKey
    foreach ($name in $key.GetValueNames()) {
        $command = [string]$key.GetValue($name)
        if ((Test-OwnedCommand $command $cleanupRoots) -and $PSCmdlet.ShouldProcess("$runKey [$name]", 'Remove app autostart entry')) {
            Remove-ItemProperty -LiteralPath $runKey -Name $name
        }
    }
}
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\MicroClaw'
if ((Test-Path -LiteralPath $uninstallKey) -and $PSCmdlet.ShouldProcess($uninstallKey, 'Remove installed-app registration')) {
    Remove-Item -LiteralPath $uninstallKey -Recurse -Force
}

$shortcutNames = @('MicroClawDesktop.lnk', 'MicroClawDesktop.url', 'MicroClaw.lnk', 'MicroClaw.url', 'Uninstall MicroClaw.lnk')
$leafFiles = @('openclaw', 'openclaw.cmd', 'openclaw.ps1') | ForEach-Object { Join-Path $npmRoot $_ }
foreach ($folder in @([Environment]::GetFolderPath('DesktopDirectory'), [Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('Startup'))) {
    if (-not $folder) { continue }
    foreach ($name in $shortcutNames) { $leafFiles += Join-Path $folder $name }
}
foreach ($file in $leafFiles) {
    $absolute = ConvertTo-CleanupPath $file
    Assert-CleanupParents $absolute
    if ((Test-Path -LiteralPath $absolute) -and $PSCmdlet.ShouldProcess($absolute, 'Remove application shim or shortcut')) {
        Remove-CleanupTree -Path $absolute -AllowedRoot $absolute
    }
}

$issues = New-Object 'System.Collections.Generic.List[string]'
foreach ($target in $cleanupRoots) {
    if (-not $PSCmdlet.ShouldProcess($target, 'Delete application files and user state without backup')) { continue }
    Write-Host "Deleting: $target" -ForegroundColor Cyan
    $deleteTimer = [Diagnostics.Stopwatch]::StartNew()
    try {
        Remove-CleanupTree -Path $target -AllowedRoot $target
        Write-Host ("Deleted: {0} ({1:F1}s)" -f $target, $deleteTimer.Elapsed.TotalSeconds)
    } catch { $issues.Add("Could not fully remove ${target}: $($_.Exception.Message)") }
}

# Only remove exact product-path exclusions. Shared Temp/npm-cache exclusions
# may belong to other workflows and are reported, not silently removed.
# Leave existing product exclusions in effect until the file deletion finishes.
if (Get-Command Get-MpPreference -ErrorAction SilentlyContinue) {
    try {
        $preferences = Get-MpPreference
        foreach ($excluded in @($preferences.ExclusionPath)) {
            if (-not $excluded) { continue }
            $absolute = ConvertTo-CleanupPath $excluded
            if ($absolute -in $cleanupRoots -and $PSCmdlet.ShouldProcess($excluded, 'Remove product-specific Defender exclusion')) {
                Remove-MpPreference -ExclusionPath $excluded
            }
        }
    } catch {
        if ($WhatIfPreference) {
            Write-Warning 'Defender exclusions could not be inspected in this preview; administrator access is required.'
        } else {
            $issues.Add("Defender settings could not be fully reset: $($_.Exception.Message)")
        }
    }
}

Write-Host 'Retained: repository/dist installer, system Node/Git, shared npm and Windows caches.'
Write-Host 'Shared Temp/npm-cache Defender exclusions, if present, are also retained.'
if ($issues.Count) {
    $issues | ForEach-Object { Write-Warning $_ }
    throw 'Cleanup is incomplete. Do not label the next run a clean-profile installation.'
}
if ($WhatIfPreference) { Write-Host 'Preview only. No processes, files or settings were changed.' }
else { Write-Host 'Cleanup complete. Run the existing Setup EXE, then use its Open MicroClaw button.' -ForegroundColor Green }
