function Start-BuildTiming {
    param([Diagnostics.Stopwatch]$Timer = [Diagnostics.Stopwatch]::StartNew())

    $script:buildTiming = @{
        Timer = $Timer
        Stages = [Collections.Generic.List[object]]::new()
        CurrentStage = $null
        StageStartedAt = [TimeSpan]::Zero
        Finished = $false
    }
}

function Complete-BuildStage {
    param(
        [Parameter(Mandatory = $true)][TimeSpan]$Elapsed,
        [ValidateSet('success', 'failed')][string]$Status = 'success'
    )

    if ($null -eq $script:buildTiming.CurrentStage) { return }

    $stage = [PSCustomObject]@{
        Name = $script:buildTiming.CurrentStage
        Seconds = ($Elapsed - $script:buildTiming.StageStartedAt).TotalSeconds
        Status = $Status
    }
    $script:buildTiming.Stages.Add($stage)
    $script:buildTiming.CurrentStage = $null
    Write-Host ("  [timing] {0} [{1}]: {2:F2}s" -f $stage.Name, $stage.Status, $stage.Seconds)
}

function Start-BuildStage {
    param([Parameter(Mandatory = $true)][string]$Name)

    if ($script:buildTiming.Finished) { throw 'Build timing has already finished.' }

    $elapsed = $script:buildTiming.Timer.Elapsed
    if ($null -ne $script:buildTiming.CurrentStage) {
        Complete-BuildStage -Elapsed $elapsed
        $script:buildTiming.StageStartedAt = $elapsed
    }
    $script:buildTiming.CurrentStage = $Name
    Write-Host "  [timing] Starting: $Name"
}

function Write-BuildTimingSummary {
    param([ValidateSet('success', 'failed')][string]$Status = 'success')

    if ($script:buildTiming.Finished) { return }

    $script:buildTiming.Timer.Stop()
    $elapsed = $script:buildTiming.Timer.Elapsed
    Complete-BuildStage -Elapsed $elapsed -Status $Status
    $script:buildTiming.Finished = $true

    Write-Host "`n=== Build timing summary ($Status) ===" -ForegroundColor Cyan
    foreach ($stage in $script:buildTiming.Stages) {
        $percentage = 0.0
        if ($elapsed.TotalSeconds -gt 0) {
            $percentage = 100.0 * $stage.Seconds / $elapsed.TotalSeconds
        }
        Write-Host ("  {0,-52} {1,9:F2}s  {2,5:F1}%  [{3}]" -f `
            $stage.Name, $stage.Seconds, $percentage, $stage.Status)
    }
    Write-Host ("  Total build:     {0:F2} minutes ({1:F2} seconds)" -f `
        $elapsed.TotalMinutes, $elapsed.TotalSeconds)
}
