[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Ideas", "Material")]
    [string]$Stage,

    [Parameter(Mandatory = $true)]
    [string]$ProjectPath,

    [string]$OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Test-NonEmptyString {
    param([object]$Value)
    return $Value -is [string] -and -not [string]::IsNullOrWhiteSpace($Value)
}

function Test-StringArray {
    param(
        [object]$Value,
        [int]$Minimum,
        [int]$Maximum
    )

    $items = @($Value)
    if ($items.Count -lt $Minimum -or $items.Count -gt $Maximum) { return $false }
    return @($items | Where-Object { -not (Test-NonEmptyString $_) }).Count -eq 0
}

function Get-PropertyValue {
    param(
        [object]$Object,
        [string]$Name
    )

    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}

function Add-IdeasErrors {
    param(
        [object]$Ideas,
        [System.Collections.Generic.List[string]]$Errors
    )

    if ($Ideas.schemaVersion -ne 1) {
        $Errors.Add("ideas.json schemaVersion must be 1.")
    }
    foreach ($field in @("projectId", "theme", "audience", "retrievedAt", "recommendedIdeaId")) {
        if (-not (Test-NonEmptyString $Ideas.$field)) {
            $Errors.Add("ideas.json requires a non-empty $field.")
        }
    }
    $ideaItems = @($Ideas.ideas)
    if ($ideaItems.Count -ne 5) {
        $Errors.Add("ideas.json must contain exactly 5 ideas.")
    }
    $ids = [System.Collections.Generic.List[string]]::new()
    foreach ($idea in $ideaItems) {
        if ($null -eq $idea) {
            $Errors.Add("ideas.json contains a null idea.")
            continue
        }
        foreach ($field in @("id", "title", "hook", "whyNow")) {
            if (-not (Test-NonEmptyString $idea.$field)) {
                $Errors.Add("Every idea requires a non-empty $field.")
            }
        }
        if (Test-NonEmptyString $idea.id) { $ids.Add([string]$idea.id) }
        if (-not (Test-StringArray $idea.sourceUrls 1 10)) {
            $Errors.Add("Every idea requires 1-10 sourceUrls.")
        }
        foreach ($url in @($idea.sourceUrls)) {
            if ($url -isnot [string] -or $url -notmatch "^https?://") {
                $Errors.Add("Every idea source URL must use HTTP or HTTPS.")
            }
        }
    }
    if ($ids.Count -ne (@($ids | Select-Object -Unique)).Count) {
        $Errors.Add("Idea ids must be unique.")
    }
    if ((Test-NonEmptyString $Ideas.recommendedIdeaId) -and
        ($ids -notcontains ([string]$Ideas.recommendedIdeaId))) {
        $Errors.Add("recommendedIdeaId must match one of the 5 ideas.")
    }
}

function Read-JsonFile {
    param(
        [string]$Path,
        [string]$Label,
        [System.Collections.Generic.List[string]]$Errors
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        $Errors.Add("Missing required file: $Label")
        return $null
    }
    try {
        return Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json
    }
    catch {
        $Errors.Add("$Label is not valid JSON: $($_.Exception.Message)")
        return $null
    }
}

function Test-MarkdownFile {
    param(
        [string]$Path,
        [string]$Label,
        [System.Collections.Generic.List[string]]$Errors
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        $Errors.Add("Missing required file: $Label")
        return
    }
    $content = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($content) -or $content.Trim().Length -lt 100) {
        $Errors.Add("$Label is empty or incomplete.")
    }
    if ($content -match
        "(?i)\bTODO\b|\bTBD\b|\u5F85\u8865\u5145|\u5F85\u786E\u8BA4|Lorem ipsum") {
        $Errors.Add("Placeholder text found in $Label.")
    }
}

$resolvedProjectPath = [System.IO.Path]::GetFullPath($ProjectPath)
if (-not [System.IO.Path]::IsPathRooted($ProjectPath)) {
    throw "ProjectPath must be an absolute path."
}
if (-not (Test-Path -LiteralPath $resolvedProjectPath -PathType Container)) {
    throw "Project directory not found: $resolvedProjectPath"
}

$errors = [System.Collections.Generic.List[string]]::new()
$ideas = Read-JsonFile (Join-Path $resolvedProjectPath "ideas.json") "ideas.json" $errors
if ($null -ne $ideas) {
    try {
        Add-IdeasErrors $ideas $errors
    }
    catch {
        $errors.Add("ideas.json validation failed: $($_.Exception.Message)")
    }
}
Test-MarkdownFile (Join-Path $resolvedProjectPath "ideas.md") "ideas.md" $errors

$material = $null
if ($Stage -eq "Material") {
    $material = Read-JsonFile (
        Join-Path $resolvedProjectPath "material-kit.json"
    ) "material-kit.json" $errors
    Test-MarkdownFile (
        Join-Path $resolvedProjectPath "material-kit.md"
    ) "material-kit.md" $errors
    if ($null -ne $material) {
        try {
            if ($material.schemaVersion -ne 1) {
                $errors.Add("material-kit.json schemaVersion must be 1.")
            }
            foreach ($field in @(
                    "projectId",
                    "materialKitId",
                    "selectedIdeaId",
                    "topic",
                    "audience",
                    "angle",
                    "contentGoal"
                )) {
                if (-not (Test-NonEmptyString $material.$field)) {
                    $errors.Add("material-kit.json requires a non-empty $field.")
                }
            }
            if ($null -ne $ideas) {
                if ($material.projectId -ne $ideas.projectId) {
                    $errors.Add("material-kit.json projectId must match ideas.json.")
                }
                $ideaIds = @($ideas.ideas | ForEach-Object { $_.id })
                if ($ideaIds -notcontains $material.selectedIdeaId) {
                    $errors.Add("selectedIdeaId must match an idea in ideas.json.")
                }
            }
            if (-not (Test-StringArray $material.keyMessages 3 8)) {
                $errors.Add("material-kit.json requires 3-8 keyMessages.")
            }
            if (-not (Test-StringArray $material.keywords 3 12)) {
                $errors.Add("material-kit.json requires 3-12 keywords.")
            }
            if (-not (Test-StringArray $material.outline 3 8)) {
                $errors.Add("material-kit.json requires 3-8 outline items.")
            }
            $facts = @($material.sourceFacts)
            if ($facts.Count -lt 1 -or $facts.Count -gt 30) {
                $errors.Add("material-kit.json requires 1-30 sourceFacts.")
            }
            foreach ($fact in $facts) {
                if ($null -eq $fact -or -not (Test-NonEmptyString $fact.fact)) {
                    $errors.Add("Every sourceFact requires a non-empty fact.")
                    continue
                }
                if ($fact.sourceType -notin @("web", "user-material")) {
                    $errors.Add("sourceFact sourceType must be web or user-material.")
                }
                if ($fact.sourceType -eq "web") {
                    if (-not (Test-NonEmptyString $fact.sourceTitle) -or
                        -not (Test-NonEmptyString $fact.retrievedAt) -or
                        $fact.sourceUrl -isnot [string] -or
                        $fact.sourceUrl -notmatch "^https?://") {
                        $errors.Add(
                            "Web sourceFacts require sourceTitle, HTTP(S) URL, and retrievedAt."
                        )
                    }
                }
            }
            if ($null -eq $material.visualDirection) {
                $errors.Add("material-kit.json requires visualDirection.")
            }
            else {
                if (-not (Test-NonEmptyString $material.visualDirection.coverMood)) {
                    $errors.Add("visualDirection requires coverMood.")
                }
                if (-not (Test-StringArray $material.visualDirection.palette 2 5)) {
                    $errors.Add("visualDirection requires 2-5 palette colors.")
                }
                foreach ($color in @($material.visualDirection.palette)) {
                    if ($color -isnot [string] -or $color -notmatch "^#[0-9A-Fa-f]{6}$") {
                        $errors.Add("visualDirection palette colors must use #RRGGBB.")
                    }
                }
                if (-not (Test-StringArray $material.visualDirection.cardConcepts 3 8)) {
                    $errors.Add("visualDirection requires 3-8 cardConcepts.")
                }
            }
        }
        catch {
            $errors.Add("material-kit.json validation failed: $($_.Exception.Message)")
        }
    }
}

$result = [ordered]@{
    ok = $errors.Count -eq 0
    stage = $Stage
    checkedAt = (Get-Date).ToUniversalTime().ToString("o")
    projectPath = $resolvedProjectPath
    projectId = Get-PropertyValue $ideas "projectId"
    selectedIdeaId =
        if ($Stage -eq "Material" -and $null -ne $material) {
            Get-PropertyValue $material "selectedIdeaId"
        }
        elseif ($null -ne $ideas) {
            Get-PropertyValue $ideas "recommendedIdeaId"
        }
        else {
            $null
        }
    materialKitId = Get-PropertyValue $material "materialKitId"
    errors = @($errors)
}
$json = $result | ConvertTo-Json -Depth 6
if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
    if (-not [System.IO.Path]::IsPathRooted($OutputPath)) {
        throw "OutputPath must be an absolute path."
    }
    $json | Set-Content -LiteralPath ([System.IO.Path]::GetFullPath($OutputPath)) -Encoding UTF8
}
Write-Output $json
if (-not $result.ok) { exit 1 }
