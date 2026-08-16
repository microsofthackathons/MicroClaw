[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SpecPath,

    [Parameter(Mandatory = $true)]
    [string]$OutputPath,

    [switch]$Force
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing

$CanvasWidth = 1242
$CanvasHeight = 1660
$SkillDirectory = Split-Path -Parent $PSScriptRoot
$TemplateDirectory = Join-Path $SkillDirectory "templates"
$KnownOutputs = @(
    "post.md",
    "package.json",
    "cover.png",
    "publish-checklist.md",
    "sources.md",
    "manifest.json",
    "validation.json"
)

function Get-RequiredText {
    param(
        [object]$Object,
        [string]$Name
    )

    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property -or $property.Value -isnot [string] -or
        [string]::IsNullOrWhiteSpace($property.Value)) {
        throw "package.json requires a non-empty '$Name' string."
    }
    return $property.Value.Trim()
}

function Get-TextArray {
    param(
        [object]$Value,
        [string]$Name,
        [int]$Minimum,
        [int]$Maximum
    )

    $items = @($Value) | ForEach-Object {
        if ($_ -isnot [string] -or [string]::IsNullOrWhiteSpace($_)) {
            throw "'$Name' must contain non-empty strings."
        }
        $_.Trim()
    }
    if ($items.Count -lt $Minimum -or $items.Count -gt $Maximum) {
        throw "'$Name' must contain between $Minimum and $Maximum items."
    }
    return $items
}

function Assert-NoLinkedPath {
    param([string]$Path)

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $root = [System.IO.Path]::GetPathRoot($fullPath)
    $current = $root
    $relative = $fullPath.Substring($root.Length)
    foreach ($segment in ($relative -split "[\\/]")) {
        if ([string]::IsNullOrWhiteSpace($segment)) { continue }
        $current = Join-Path $current $segment
        if (-not (Test-Path -LiteralPath $current)) { continue }
        $item = Get-Item -LiteralPath $current -Force
        $hasLinkType =
            $item.PSObject.Properties["LinkType"] -and
            -not [string]::IsNullOrWhiteSpace([string]$item.LinkType)
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -or
            $hasLinkType) {
            throw "Linked or reparse-point paths are not supported: $current"
        }
    }
}

function Get-GeneratedCardPaths {
    param([string]$Directory)

    return @(foreach ($index in 1..8) {
        Join-Path $Directory ("{0:D2}.png" -f $index)
    })
}

function Remove-GeneratedOutputs {
    param([string]$Directory)

    foreach ($name in $KnownOutputs) {
        $candidate = Join-Path $Directory $name
        if (Test-Path -LiteralPath $candidate) {
            Assert-NoLinkedPath $candidate
            Remove-Item -LiteralPath $candidate -Force
        }
    }
    $cardsPath = Join-Path $Directory "cards"
    if (Test-Path -LiteralPath $cardsPath) {
        Assert-NoLinkedPath $cardsPath
        foreach ($cardPath in Get-GeneratedCardPaths $cardsPath) {
            if (Test-Path -LiteralPath $cardPath) {
                Assert-NoLinkedPath $cardPath
                Remove-Item -LiteralPath $cardPath -Force
            }
        }
        if (@(Get-ChildItem -LiteralPath $cardsPath -Force).Count -eq 0) {
            Remove-Item -LiteralPath $cardsPath -Force
        }
    }
}

function Backup-GeneratedOutputs {
    param([string]$Directory)

    $existingFiles = @($KnownOutputs | Where-Object {
        Test-Path -LiteralPath (Join-Path $Directory $_)
    })
    $cardsPath = Join-Path $Directory "cards"
    $existingCards = @()
    if (Test-Path -LiteralPath $cardsPath) {
        Assert-NoLinkedPath $cardsPath
        $existingCards = @(Get-GeneratedCardPaths $cardsPath | Where-Object {
            Test-Path -LiteralPath $_
        })
    }
    if ($existingFiles.Count -eq 0 -and $existingCards.Count -eq 0) {
        return $null
    }

    $parent = Split-Path -Parent $Directory
    $backup = Join-Path $parent (".rednote-backup-" + [guid]::NewGuid().ToString("N"))
    New-Item -ItemType Directory -Path $backup | Out-Null
    try {
        foreach ($name in $existingFiles) {
            $source = Join-Path $Directory $name
            Assert-NoLinkedPath $source
            Move-Item -LiteralPath $source -Destination (Join-Path $backup $name)
        }
        if ($existingCards.Count -gt 0) {
            $backupCards = Join-Path $backup "cards"
            New-Item -ItemType Directory -Path $backupCards | Out-Null
            foreach ($cardPath in $existingCards) {
                Assert-NoLinkedPath $cardPath
                Move-Item -LiteralPath $cardPath -Destination $backupCards
            }
        }
        return $backup
    }
    catch {
        $backupError = $_
        Restore-GeneratedOutputs $Directory $backup
        throw $backupError
    }
}

function Restore-GeneratedOutputs {
    param(
        [string]$Directory,
        [string]$Backup
    )

    if ([string]::IsNullOrWhiteSpace($Backup) -or
        -not (Test-Path -LiteralPath $Backup -PathType Container)) {
        return
    }
    foreach ($name in $KnownOutputs) {
        $source = Join-Path $Backup $name
        if (Test-Path -LiteralPath $source) {
            Move-Item -LiteralPath $source -Destination (Join-Path $Directory $name)
        }
    }
    $backupCards = Join-Path $Backup "cards"
    if (Test-Path -LiteralPath $backupCards) {
        $cardsPath = Join-Path $Directory "cards"
        New-Item -ItemType Directory -Path $cardsPath -Force | Out-Null
        foreach ($card in Get-ChildItem -LiteralPath $backupCards -File) {
            Move-Item -LiteralPath $card.FullName -Destination $cardsPath
        }
    }
    Remove-Item -LiteralPath $Backup -Recurse -Force
}

function New-TextFont {
    param(
        [single]$Size,
        [System.Drawing.FontStyle]$Style = [System.Drawing.FontStyle]::Regular
    )

    foreach ($family in @("Microsoft YaHei UI", "Microsoft YaHei", "Segoe UI")) {
        try {
            return [System.Drawing.Font]::new(
                $family,
                $Size,
                $Style,
                [System.Drawing.GraphicsUnit]::Pixel
            )
        }
        catch {
            continue
        }
    }
    throw "No supported UI font is installed."
}

function Assert-TextFits {
    param(
        [System.Drawing.Graphics]$Graphics,
        [string]$Text,
        [System.Drawing.Font]$Font,
        [single]$Width,
        [single]$Height,
        [string]$Field
    )

    $layout = [System.Drawing.SizeF]::new($Width, 10000)
    $measured = $Graphics.MeasureString($Text, $Font, $layout)
    if ($measured.Height -gt ($Height + 1)) {
        throw "'$Field' does not fit the visual template. Shorten the text and rerender."
    }
}

function Draw-TextBlock {
    param(
        [System.Drawing.Graphics]$Graphics,
        [string]$Text,
        [System.Drawing.Font]$Font,
        [System.Drawing.Brush]$Brush,
        [single]$X,
        [single]$Y,
        [single]$Width,
        [single]$Height,
        [System.Drawing.StringAlignment]$Alignment = [System.Drawing.StringAlignment]::Near
    )

    $rectangle = [System.Drawing.RectangleF]::new($X, $Y, $Width, $Height)
    $format = [System.Drawing.StringFormat]::new()
    try {
        $format.Alignment = $Alignment
        $format.LineAlignment = [System.Drawing.StringAlignment]::Near
        $format.Trimming = [System.Drawing.StringTrimming]::EllipsisWord
        $format.FormatFlags = [System.Drawing.StringFormatFlags]::LineLimit
        $Graphics.DrawString($Text, $Font, $Brush, $rectangle, $format)
    }
    finally {
        $format.Dispose()
    }
}

function Get-Palette {
    param([string]$Seed)

    $palettes = @(
        @{ Background = "#FFF7F0"; Accent = "#F06C5B"; Text = "#2F2522"; Muted = "#7B6861" },
        @{ Background = "#F3F7F1"; Accent = "#719D73"; Text = "#243127"; Muted = "#627064" },
        @{ Background = "#F5F3FA"; Accent = "#8A75B6"; Text = "#2E2938"; Muted = "#6F6879" },
        @{ Background = "#F2F7FA"; Accent = "#5B91B2"; Text = "#23323B"; Muted = "#64737C" }
    )
    $checksum = 0
    foreach ($character in $Seed.ToCharArray()) {
        $checksum += [int][char]$character
    }
    return $palettes[$checksum % $palettes.Count]
}

function Convert-ToColor {
    param([string]$Hex)
    return [System.Drawing.ColorTranslator]::FromHtml($Hex)
}

function Save-Cover {
    param(
        [string]$Path,
        [string]$Topic,
        [string]$CoverText,
        [string]$CoverSubtitle,
        [hashtable]$Palette
    )

    $bitmap = [System.Drawing.Bitmap]::new($CanvasWidth, $CanvasHeight)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $background = [System.Drawing.SolidBrush]::new((Convert-ToColor $Palette.Background))
    $accent = [System.Drawing.SolidBrush]::new((Convert-ToColor $Palette.Accent))
    $textBrush = [System.Drawing.SolidBrush]::new((Convert-ToColor $Palette.Text))
    $mutedBrush = [System.Drawing.SolidBrush]::new((Convert-ToColor $Palette.Muted))
    $titleFont = New-TextFont 82 ([System.Drawing.FontStyle]::Bold)
    $subtitleFont = New-TextFont 44
    $topicFont = New-TextFont 34 ([System.Drawing.FontStyle]::Bold)
    try {
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.TextRenderingHint =
            [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
        $graphics.FillRectangle($background, 0, 0, $CanvasWidth, $CanvasHeight)
        $graphics.FillRectangle($accent, 90, 120, 20, 170)
        $graphics.FillEllipse($accent, 930, 1090, 390, 390)
        $graphics.FillEllipse($background, 990, 1150, 270, 270)

        Assert-TextFits $graphics $Topic $topicFont 900 90 "topic"
        Assert-TextFits $graphics $CoverText $titleFont 1000 520 "coverText"
        Draw-TextBlock $graphics $Topic $topicFont $mutedBrush 130 130 900 90
        Draw-TextBlock $graphics $CoverText $titleFont $textBrush 130 360 1000 520
        if (-not [string]::IsNullOrWhiteSpace($CoverSubtitle)) {
            Assert-TextFits $graphics $CoverSubtitle $subtitleFont 850 220 "coverSubtitle"
            Draw-TextBlock $graphics $CoverSubtitle $subtitleFont $mutedBrush 135 930 850 220
        }
        $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
        $topicFont.Dispose()
        $subtitleFont.Dispose()
        $titleFont.Dispose()
        $mutedBrush.Dispose()
        $textBrush.Dispose()
        $accent.Dispose()
        $background.Dispose()
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

function Save-Card {
    param(
        [string]$Path,
        [string]$Topic,
        [string]$Title,
        [string]$Body,
        [int]$Index,
        [int]$Total,
        [hashtable]$Palette
    )

    $bitmap = [System.Drawing.Bitmap]::new($CanvasWidth, $CanvasHeight)
    $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
    $background = [System.Drawing.SolidBrush]::new((Convert-ToColor $Palette.Background))
    $accent = [System.Drawing.SolidBrush]::new((Convert-ToColor $Palette.Accent))
    $textBrush = [System.Drawing.SolidBrush]::new((Convert-ToColor $Palette.Text))
    $mutedBrush = [System.Drawing.SolidBrush]::new((Convert-ToColor $Palette.Muted))
    $titleFont = New-TextFont 72 ([System.Drawing.FontStyle]::Bold)
    $bodyFont = New-TextFont 45
    $smallFont = New-TextFont 30 ([System.Drawing.FontStyle]::Bold)
    try {
        $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $graphics.TextRenderingHint =
            [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
        $graphics.FillRectangle($background, 0, 0, $CanvasWidth, $CanvasHeight)
        $graphics.FillRectangle($accent, 0, 0, $CanvasWidth, 24)
        $graphics.FillEllipse($accent, 980, 90, 110, 110)

        Assert-TextFits $graphics $Topic $smallFont 820 70 "topic"
        Assert-TextFits $graphics $Title $titleFont 1020 360 "slides[$Index].title"
        Assert-TextFits $graphics $Body $bodyFont 990 600 "slides[$Index].body"
        Draw-TextBlock $graphics $Topic $smallFont $mutedBrush 110 100 820 70
        Draw-TextBlock $graphics ("{0:D2}" -f $Index) $smallFont $background 1003 125 80 55 `
            ([System.Drawing.StringAlignment]::Center)
        Draw-TextBlock $graphics $Title $titleFont $textBrush 110 300 1020 360
        Draw-TextBlock $graphics $Body $bodyFont $textBrush 115 760 990 600
        Draw-TextBlock $graphics "$Index / $Total" $smallFont $mutedBrush 110 1480 1000 60 `
            ([System.Drawing.StringAlignment]::Far)
        $bitmap.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
    }
    finally {
        $smallFont.Dispose()
        $bodyFont.Dispose()
        $titleFont.Dispose()
        $mutedBrush.Dispose()
        $textBrush.Dispose()
        $accent.Dispose()
        $background.Dispose()
        $graphics.Dispose()
        $bitmap.Dispose()
    }
}

$resolvedSpecPath = [System.IO.Path]::GetFullPath($SpecPath)
$resolvedOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
if (-not [System.IO.Path]::IsPathRooted($SpecPath) -or
    -not [System.IO.Path]::IsPathRooted($OutputPath)) {
    throw "SpecPath and OutputPath must be absolute paths."
}
if (-not (Test-Path -LiteralPath $resolvedSpecPath -PathType Leaf)) {
    throw "Spec file not found: $resolvedSpecPath"
}
Assert-NoLinkedPath $resolvedSpecPath
Assert-NoLinkedPath $resolvedOutputPath

$spec = Get-Content -LiteralPath $resolvedSpecPath -Raw -Encoding UTF8 | ConvertFrom-Json
$materialPath = Join-Path $resolvedOutputPath "material-kit.json"
if (-not (Test-Path -LiteralPath $materialPath -PathType Leaf)) {
    throw "material-kit.json is required before rendering the final package."
}
Assert-NoLinkedPath $materialPath
$material = Get-Content -LiteralPath $materialPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ($spec.schemaVersion -ne 1) {
    throw "package.json schemaVersion must be 1."
}
if ($material.schemaVersion -ne 1) {
    throw "material-kit.json schemaVersion must be 1."
}
$projectId = Get-RequiredText $spec "projectId"
$materialKitId = Get-RequiredText $spec "materialKitId"
if ($projectId -ne (Get-RequiredText $material "projectId")) {
    throw "package.json projectId must match material-kit.json."
}
if ($materialKitId -ne (Get-RequiredText $material "materialKitId")) {
    throw "package.json materialKitId must match material-kit.json."
}
$topic = Get-RequiredText $spec "topic"
$audience = Get-RequiredText $spec "audience"
$angle = Get-RequiredText $spec "angle"
$body = Get-RequiredText $spec "body"
$coverText = Get-RequiredText $spec "coverText"
$coverSubtitle = ""
if ($spec.PSObject.Properties["coverSubtitle"] -and
    $spec.coverSubtitle -is [string]) {
    $coverSubtitle = $spec.coverSubtitle.Trim()
}
$titles = Get-TextArray $spec.titles "titles" 3 5
$hashtags = Get-TextArray $spec.hashtags "hashtags" 3 10
$slides = @($spec.slides)
if ($slides.Count -lt 3 -or $slides.Count -gt 8) {
    throw "'slides' must contain between 3 and 8 cards."
}
foreach ($slide in $slides) {
    [void](Get-RequiredText $slide "title")
    [void](Get-RequiredText $slide "body")
}

if (Test-Path -LiteralPath $resolvedOutputPath) {
    $existingGenerated = @(
        foreach ($name in $KnownOutputs | Where-Object { $_ -ne "package.json" }) {
            $candidate = Join-Path $resolvedOutputPath $name
            if (Test-Path -LiteralPath $candidate) { $candidate }
        }
        $outputPackagePath = Join-Path $resolvedOutputPath "package.json"
        $specIsOutputPackage = [System.StringComparer]::OrdinalIgnoreCase.Equals(
            $resolvedSpecPath,
            [System.IO.Path]::GetFullPath($outputPackagePath)
        )
        if ((Test-Path -LiteralPath $outputPackagePath) -and -not $specIsOutputPackage) {
            $outputPackagePath
        }
        $cardsCandidate = Join-Path $resolvedOutputPath "cards"
        if (Test-Path -LiteralPath $cardsCandidate) { $cardsCandidate }
    )
    if ($existingGenerated.Count -gt 0 -and -not $Force) {
        throw "Output directory already contains files. Use -Force to replace generated outputs."
    }
}
else {
    New-Item -ItemType Directory -Path $resolvedOutputPath -Force | Out-Null
}

$backupPath = Backup-GeneratedOutputs $resolvedOutputPath
try {
$cardsDirectory = Join-Path $resolvedOutputPath "cards"
New-Item -ItemType Directory -Path $cardsDirectory -Force | Out-Null

$sources = @()
if ($spec.PSObject.Properties["sources"]) {
    $sources = @($spec.sources)
}
$materialSourceUrls = @(
    @($material.sourceFacts) |
        Where-Object {
            $_.sourceType -eq "web" -and
            $_.sourceUrl -is [string] -and
            -not [string]::IsNullOrWhiteSpace($_.sourceUrl)
        } |
        ForEach-Object { [string]$_.sourceUrl }
)
foreach ($source in $sources) {
    if ($null -eq $source -or
        $source.url -isnot [string] -or
        [string]::IsNullOrWhiteSpace($source.url)) {
        throw "Every package source requires a URL."
    }
    if ($materialSourceUrls -notcontains [string]$source.url) {
        throw "Package source '$($source.url)' is not present in material-kit.json."
    }
}

$normalizedSpec = [ordered]@{
    schemaVersion = 1
    projectId = $projectId
    materialKitId = $materialKitId
    topic = $topic
    audience = $audience
    angle = $angle
    titles = $titles
    body = $body
    coverText = $coverText
    coverSubtitle = $coverSubtitle
    slides = @($slides | ForEach-Object {
        [ordered]@{
            title = Get-RequiredText $_ "title"
            body = Get-RequiredText $_ "body"
        }
    })
    hashtags = @($hashtags | ForEach-Object { $_.TrimStart("#") })
    sources = $sources
}

$packageJsonPath = Join-Path $resolvedOutputPath "package.json"
$normalizedSpec | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $packageJsonPath -Encoding UTF8

$palette = Get-Palette $topic
$coverPath = Join-Path $resolvedOutputPath "cover.png"
Save-Cover $coverPath $topic $coverText $coverSubtitle $palette

$cardFiles = @()
for ($index = 0; $index -lt $normalizedSpec.slides.Count; $index++) {
    $filename = "{0:D2}.png" -f ($index + 1)
    $cardPath = Join-Path $cardsDirectory $filename
    $slide = $normalizedSpec.slides[$index]
    Save-Card $cardPath $topic $slide.title $slide.body ($index + 1) `
        $normalizedSpec.slides.Count $palette
    $cardFiles += "cards/$filename"
}

$hashtagLine = ($normalizedSpec.hashtags | ForEach-Object { "#$_" }) -join " "
$titleLines = ($titles | ForEach-Object { "- $_" }) -join [Environment]::NewLine
$postTemplate = Get-Content -LiteralPath (Join-Path $TemplateDirectory "post.zh-CN.md") `
    -Raw -Encoding UTF8
$postMarkdown = $postTemplate.
    Replace("{{TITLES}}", $titleLines).
    Replace("{{BODY}}", $body).
    Replace("{{COVER_TEXT}}", $coverText).
    Replace("{{COVER_SUBTITLE}}", $coverSubtitle).
    Replace("{{HASHTAGS}}", $hashtagLine).
    Replace("{{AUDIENCE}}", $audience).
    Replace("{{ANGLE}}", $angle)
$postMarkdown | Set-Content -LiteralPath (Join-Path $resolvedOutputPath "post.md") -Encoding UTF8

$sourceLines = @()
foreach ($source in @($normalizedSpec.sources)) {
    if ($null -eq $source) { continue }
    $sourceTitle = if ($source.PSObject.Properties["title"]) { [string]$source.title } else { "Source" }
    $sourceUrl = if ($source.PSObject.Properties["url"]) { [string]$source.url } else { "" }
    $retrievedAt =
        if ($source.PSObject.Properties["retrievedAt"]) { [string]$source.retrievedAt } else { "" }
    if (-not [string]::IsNullOrWhiteSpace($sourceUrl)) {
        $sourceLines += "- [$sourceTitle]($sourceUrl) ($retrievedAt)"
    }
}
if ($sourceLines.Count -eq 0) {
    $sourceLines += "- No external sources were used."
}
$sourcesTemplate = Get-Content -LiteralPath (Join-Path $TemplateDirectory "sources.zh-CN.md") `
    -Raw -Encoding UTF8
$sourcesTemplate.Replace("{{SOURCES}}", ($sourceLines -join [Environment]::NewLine)) |
    Set-Content -LiteralPath (Join-Path $resolvedOutputPath "sources.md") -Encoding UTF8

$checklist = Get-Content -LiteralPath (Join-Path $TemplateDirectory "publish-checklist.zh-CN.md") `
    -Raw -Encoding UTF8
$checklist | Set-Content -LiteralPath (Join-Path $resolvedOutputPath "publish-checklist.md") `
    -Encoding UTF8

$manifest = [ordered]@{
    schemaVersion = 1
    status = "publish-ready"
    generatedAt = (Get-Date).ToUniversalTime().ToString("o")
    projectId = $projectId
    materialKitId = $materialKitId
    topic = $topic
    canvas = [ordered]@{
        width = $CanvasWidth
        height = $CanvasHeight
        aspectRatio = "3:4"
    }
    files = [ordered]@{
        post = "post.md"
        package = "package.json"
        cover = "cover.png"
        cards = $cardFiles
        sources = "sources.md"
        checklist = "publish-checklist.md"
    }
}
$manifest | ConvertTo-Json -Depth 8 |
    Set-Content -LiteralPath (Join-Path $resolvedOutputPath "manifest.json") -Encoding UTF8

if (-not [string]::IsNullOrWhiteSpace($backupPath) -and
    (Test-Path -LiteralPath $backupPath)) {
    Remove-Item -LiteralPath $backupPath -Recurse -Force
}
Write-Output ($manifest | ConvertTo-Json -Depth 8)
}
catch {
    $renderError = $_
    try {
        Remove-GeneratedOutputs $resolvedOutputPath
        Restore-GeneratedOutputs $resolvedOutputPath $backupPath
    }
    catch {
        throw "Render failed and rollback failed: $($_.Exception.Message)"
    }
    throw $renderError
}
