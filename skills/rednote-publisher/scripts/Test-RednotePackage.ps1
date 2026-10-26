[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$PackagePath,

    [string]$OutputPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.IO.Compression;
using System.Text;

public static class RednotePngValidator
{
    private static uint ReadUInt32BigEndian(BinaryReader reader)
    {
        byte[] bytes = reader.ReadBytes(4);
        if (bytes.Length != 4) throw new InvalidDataException("Unexpected end of PNG.");
        return ((uint)bytes[0] << 24) | ((uint)bytes[1] << 16) |
               ((uint)bytes[2] << 8) | bytes[3];
    }

    private static uint ReadUInt32BigEndian(byte[] bytes, int offset)
    {
        return ((uint)bytes[offset] << 24) | ((uint)bytes[offset + 1] << 16) |
               ((uint)bytes[offset + 2] << 8) | bytes[offset + 3];
    }

    private static uint UpdateCrc(uint crc, byte[] bytes)
    {
        foreach (byte value in bytes)
        {
            crc ^= value;
            for (int bit = 0; bit < 8; bit++)
            {
                crc = (crc & 1) != 0 ? 0xEDB88320U ^ (crc >> 1) : crc >> 1;
            }
        }
        return crc;
    }

    private static uint CalculateCrc(byte[] type, byte[] data)
    {
        uint crc = 0xFFFFFFFFU;
        crc = UpdateCrc(crc, type);
        crc = UpdateCrc(crc, data);
        return crc ^ 0xFFFFFFFFU;
    }

    private static uint CalculateAdler32(byte[] data)
    {
        const uint modulus = 65521U;
        uint first = 1U;
        uint second = 0U;
        foreach (byte value in data)
        {
            first = (first + value) % modulus;
            second = (second + first) % modulus;
        }
        return (second << 16) | first;
    }

    public static int[] Validate(string path)
    {
        byte[] signature = new byte[] { 137, 80, 78, 71, 13, 10, 26, 10 };
        uint width = 0;
        uint height = 0;
        byte bitDepth = 0;
        byte colorType = 0;
        byte interlace = 0;
        bool foundHeader = false;
        bool foundEnd = false;

        using (FileStream stream = File.OpenRead(path))
        using (BinaryReader reader = new BinaryReader(stream))
        using (MemoryStream idat = new MemoryStream())
        {
            byte[] actualSignature = reader.ReadBytes(8);
            if (actualSignature.Length != 8)
                throw new InvalidDataException("PNG signature is truncated.");
            for (int i = 0; i < signature.Length; i++)
                if (actualSignature[i] != signature[i])
                    throw new InvalidDataException("PNG signature is invalid.");

            while (stream.Position < stream.Length)
            {
                uint length = ReadUInt32BigEndian(reader);
                if (length > 64U * 1024U * 1024U)
                    throw new InvalidDataException("PNG chunk is too large.");
                byte[] type = reader.ReadBytes(4);
                byte[] data = reader.ReadBytes(checked((int)length));
                if (type.Length != 4 || data.Length != length)
                    throw new InvalidDataException("PNG chunk is truncated.");
                uint expectedCrc = ReadUInt32BigEndian(reader);
                if (CalculateCrc(type, data) != expectedCrc)
                    throw new InvalidDataException("PNG chunk CRC is invalid.");

                string chunkType = Encoding.ASCII.GetString(type);
                if (chunkType == "IHDR")
                {
                    if (foundHeader || data.Length != 13)
                        throw new InvalidDataException("PNG IHDR is invalid.");
                    foundHeader = true;
                    width = ReadUInt32BigEndian(data, 0);
                    height = ReadUInt32BigEndian(data, 4);
                    bitDepth = data[8];
                    colorType = data[9];
                    interlace = data[12];
                }
                else if (chunkType == "IDAT")
                {
                    if (!foundHeader)
                        throw new InvalidDataException("PNG IDAT appears before IHDR.");
                    if (idat.Length + data.Length > 129L * 1024L * 1024L)
                        throw new InvalidDataException("PNG cumulative IDAT data is too large.");
                    idat.Write(data, 0, data.Length);
                }
                else if (chunkType == "IEND")
                {
                    if (data.Length != 0)
                        throw new InvalidDataException("PNG IEND is invalid.");
                    foundEnd = true;
                    break;
                }
            }

            if (!foundHeader || !foundEnd || width == 0 || height == 0)
                throw new InvalidDataException("PNG is missing required chunks.");
            if (interlace != 0)
                throw new InvalidDataException("Interlaced PNG is not supported.");

            int channels;
            switch (colorType)
            {
                case 0: channels = 1; break;
                case 2: channels = 3; break;
                case 3: channels = 1; break;
                case 4: channels = 2; break;
                case 6: channels = 4; break;
                default: throw new InvalidDataException("PNG color type is unsupported.");
            }
            long rowBytes = (((long)width * channels * bitDepth) + 7L) / 8L;
            long expectedLength = (rowBytes + 1L) * height;
            if (expectedLength <= 0 || expectedLength > 128L * 1024L * 1024L)
                throw new InvalidDataException("PNG decoded size is unsupported.");
            if (idat.Length > expectedLength + (1024L * 1024L))
                throw new InvalidDataException("PNG compressed data is unexpectedly large.");

            byte[] zlib = idat.ToArray();
            if (zlib.Length < 6 || (zlib[0] & 0x0F) != 8 ||
                (((int)zlib[0] << 8) + zlib[1]) % 31 != 0)
                throw new InvalidDataException("PNG zlib stream is invalid.");

            byte[] raw;
            using (MemoryStream compressed = new MemoryStream(zlib, 2, zlib.Length - 6, false))
            using (DeflateStream deflate = new DeflateStream(compressed, CompressionMode.Decompress))
            using (MemoryStream decoded = new MemoryStream())
            {
                byte[] buffer = new byte[8192];
                int read;
                while ((read = deflate.Read(buffer, 0, buffer.Length)) > 0)
                {
                    if (decoded.Length + read > expectedLength)
                        throw new InvalidDataException("PNG decompressed data exceeds IHDR bounds.");
                    decoded.Write(buffer, 0, read);
                }
                raw = decoded.ToArray();
            }

            uint expectedAdler = ReadUInt32BigEndian(zlib, zlib.Length - 4);
            if (CalculateAdler32(raw) != expectedAdler)
                throw new InvalidDataException("PNG Adler32 is invalid.");

            if (raw.LongLength != expectedLength)
                throw new InvalidDataException("PNG scanline data length is invalid.");
        }

        return new int[] { checked((int)width), checked((int)height) };
    }
}
'@

function Get-PngDimensions {
    param([string]$Path)

    try {
        $dimensions = [RednotePngValidator]::Validate($Path)
        return @{ Width = $dimensions[0]; Height = $dimensions[1] }
    }
    catch {
        throw "Unreadable PNG image '$Path': $($_.Exception.Message)"
    }
}

function Get-Sha256Hex {
    param([string]$Path)

    $stream = [System.IO.File]::OpenRead($Path)
    $algorithm = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = $algorithm.ComputeHash($stream)
        return ([System.BitConverter]::ToString($bytes)).Replace("-", "").ToLowerInvariant()
    }
    finally {
        $algorithm.Dispose()
        $stream.Dispose()
    }
}

function Test-NonEmptyString {
    param([object]$Value)
    return $Value -is [string] -and -not [string]::IsNullOrWhiteSpace($Value)
}

$resolvedPackagePath = [System.IO.Path]::GetFullPath($PackagePath)
if (-not [System.IO.Path]::IsPathRooted($PackagePath)) {
    throw "PackagePath must be an absolute path."
}
if (-not (Test-Path -LiteralPath $resolvedPackagePath -PathType Container)) {
    throw "Package directory not found: $resolvedPackagePath"
}

$errors = [System.Collections.Generic.List[string]]::new()
$stageValidator = Join-Path $PSScriptRoot "Test-RednoteStage.ps1"
foreach ($stage in @("Ideas", "Material")) {
    $stageOutput = & powershell -NoProfile -ExecutionPolicy Bypass -File $stageValidator `
        -Stage $stage `
        -ProjectPath $resolvedPackagePath 2>&1 | Out-String
    if ($LASTEXITCODE -ne 0) {
        $errors.Add("$stage stage validation failed: $($stageOutput.Trim())")
    }
}
$requiredFiles = @(
    "ideas.json",
    "ideas.md",
    "ideas-validation.json",
    "material-kit.json",
    "material-kit.md",
    "material-validation.json",
    "package.json",
    "post.md",
    "cover.png",
    "publish-checklist.md",
    "sources.md",
    "manifest.json"
)
foreach ($relativePath in $requiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $resolvedPackagePath $relativePath) -PathType Leaf)) {
        $errors.Add("Missing required file: $relativePath")
    }
}

$packageSpec = $null
$ideasSpec = $null
$materialSpec = $null
$materialKitSha256 = $null
$manifestSpec = $null
$packageJsonPath = Join-Path $resolvedPackagePath "package.json"
if (Test-Path -LiteralPath $packageJsonPath -PathType Leaf) {
    try {
        $packageSpec = Get-Content -LiteralPath $packageJsonPath -Raw -Encoding UTF8 |
            ConvertFrom-Json
    }
    catch {
        $errors.Add("package.json is not valid JSON: $($_.Exception.Message)")
    }
}

$ideasPath = Join-Path $resolvedPackagePath "ideas.json"
if (Test-Path -LiteralPath $ideasPath -PathType Leaf) {
    try {
        $ideasSpec = Get-Content -LiteralPath $ideasPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($ideasSpec.schemaVersion -ne 1 -or
            -not (Test-NonEmptyString $ideasSpec.projectId) -or
            -not (Test-NonEmptyString $ideasSpec.recommendedIdeaId)) {
            $errors.Add("ideas.json requires schemaVersion, projectId, and recommendedIdeaId.")
        }
    }
    catch {
        $errors.Add("ideas.json is not valid JSON: $($_.Exception.Message)")
    }
}

$materialPath = Join-Path $resolvedPackagePath "material-kit.json"
if (Test-Path -LiteralPath $materialPath -PathType Leaf) {
    try {
        $materialKitSha256 = Get-Sha256Hex $materialPath
        $materialSpec = Get-Content -LiteralPath $materialPath -Raw -Encoding UTF8 |
            ConvertFrom-Json
        if ($materialSpec.schemaVersion -ne 1) {
            $errors.Add("material-kit.json schemaVersion must be 1.")
        }
        foreach ($field in @("projectId", "materialKitId", "selectedIdeaId")) {
            if (-not (Test-NonEmptyString $materialSpec.$field)) {
                $errors.Add("material-kit.json requires a non-empty $field.")
            }
        }
        if ($null -ne $ideasSpec) {
            if ($materialSpec.projectId -ne $ideasSpec.projectId) {
                $errors.Add("material-kit.json projectId must match ideas.json.")
            }
            $ideaIds = @($ideasSpec.ideas | ForEach-Object { $_.id })
            if ($ideaIds -notcontains $materialSpec.selectedIdeaId) {
                $errors.Add("material-kit.json selectedIdeaId must match ideas.json.")
            }
        }
    }
    catch {
        $errors.Add("material-kit.json is not valid JSON: $($_.Exception.Message)")
    }
}

$manifestPath = Join-Path $resolvedPackagePath "manifest.json"
if (Test-Path -LiteralPath $manifestPath -PathType Leaf) {
    try {
        $manifestSpec = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 |
            ConvertFrom-Json
    }
    catch {
        $errors.Add("manifest.json is not valid JSON: $($_.Exception.Message)")
    }
}

$cardFiles = @()
$cardsDirectory = Join-Path $resolvedPackagePath "cards"
if (Test-Path -LiteralPath $cardsDirectory -PathType Container) {
    $cardFiles = @(Get-ChildItem -LiteralPath $cardsDirectory -Filter "*.png" -File |
        Where-Object { $_.Name -match "^\d{2}\.png$" } |
        Sort-Object Name)
}
if ($cardFiles.Count -lt 3 -or $cardFiles.Count -gt 8) {
    $errors.Add("Expected 3-8 visual cards, found $($cardFiles.Count).")
}

$imageFiles = @()
$coverPath = Join-Path $resolvedPackagePath "cover.png"
if (Test-Path -LiteralPath $coverPath -PathType Leaf) {
    $imageFiles += Get-Item -LiteralPath $coverPath
}
$imageFiles += $cardFiles
foreach ($image in $imageFiles) {
    try {
        $dimensions = Get-PngDimensions $image.FullName
        if ($dimensions.Width -ne 1242 -or $dimensions.Height -ne 1660) {
            $errors.Add(
                "Image '$($image.Name)' must be 1242x1660, found " +
                "$($dimensions.Width)x$($dimensions.Height)."
            )
        }
    }
    catch {
        $errors.Add($_.Exception.Message)
    }
}

if ($null -ne $packageSpec) {
    try {
        if ($packageSpec.schemaVersion -ne 1) {
            $errors.Add("package.json schemaVersion must be 1.")
        }
        foreach ($field in @("projectId", "materialKitId", "materialKitSha256", "selectedIdeaId")) {
            if (-not (Test-NonEmptyString $packageSpec.$field)) {
                $errors.Add("package.json requires a non-empty $field.")
            }
        }
        if ($null -ne $materialSpec) {
            if ($packageSpec.projectId -ne $materialSpec.projectId) {
                $errors.Add("package.json projectId must match material-kit.json.")
            }
            if ($packageSpec.materialKitId -ne $materialSpec.materialKitId) {
                $errors.Add("package.json materialKitId must match material-kit.json.")
            }
            if ($packageSpec.materialKitSha256 -ne $materialKitSha256) {
                $errors.Add("package.json materialKitSha256 must match material-kit.json.")
            }
            if ($packageSpec.selectedIdeaId -ne $materialSpec.selectedIdeaId) {
                $errors.Add("package.json selectedIdeaId must match material-kit.json.")
            }
            foreach ($sharedField in @("topic", "audience", "angle")) {
                if ($packageSpec.$sharedField -ne $materialSpec.$sharedField) {
                    $errors.Add("package.json $sharedField must match material-kit.json.")
                }
            }
            $allowedSourceUrls = @(
                @($materialSpec.sourceFacts) |
                    Where-Object { $_.sourceType -eq "web" } |
                    ForEach-Object { $_.sourceUrl } |
                    Sort-Object -Unique
            )
            $packageSourceUrls = @()
            foreach ($source in @($packageSpec.sources)) {
                if ($null -eq $source -or
                    -not (Test-NonEmptyString $source.url) -or
                    $allowedSourceUrls -notcontains $source.url) {
                    $errors.Add("Every package source must come from material-kit.json.")
                }
                else {
                    $packageSourceUrls += $source.url
                }
            }
            $packageSourceUrls = @($packageSourceUrls | Sort-Object -Unique)
            if ((ConvertTo-Json $packageSourceUrls -Compress) -ne
                (ConvertTo-Json $allowedSourceUrls -Compress)) {
                $errors.Add(
                    "package.json sources must include every web source from material-kit.json."
                )
            }
        }
        foreach ($field in @("topic", "audience", "angle", "body", "coverText")) {
            if (-not (Test-NonEmptyString $packageSpec.$field)) {
                $errors.Add("package.json requires a non-empty $field.")
            }
        }
        $titles = @($packageSpec.titles)
        if ($titles.Count -lt 3 -or $titles.Count -gt 5 -or @($titles | Where-Object {
                    -not (Test-NonEmptyString $_)
                }).Count -gt 0) {
            $errors.Add("package.json requires 3-5 non-empty title options.")
        }
        $hashtags = @($packageSpec.hashtags)
        if ($hashtags.Count -lt 3 -or $hashtags.Count -gt 10 -or @($hashtags | Where-Object {
                    -not (Test-NonEmptyString $_)
                }).Count -gt 0) {
            $errors.Add("package.json requires 3-10 non-empty hashtags.")
        }
        $slides = @($packageSpec.slides)
        if ($slides.Count -ne $cardFiles.Count) {
            $errors.Add("Rendered card count does not match package.json slides.")
        }
        foreach ($slide in $slides) {
            if ($null -eq $slide -or
                -not (Test-NonEmptyString $slide.title) -or
                -not (Test-NonEmptyString $slide.body)) {
                $errors.Add("Every package.json slide requires a non-empty title and body.")
            }
        }
    }
    catch {
        $errors.Add("package.json is missing required arrays.")
    }
}

$textFiles = @(
    "ideas.json",
    "ideas.md",
    "ideas-validation.json",
    "material-kit.json",
    "material-kit.md",
    "material-validation.json",
    "package.json",
    "post.md",
    "publish-checklist.md",
    "sources.md"
)
foreach ($relativePath in $textFiles) {
    $candidate = Join-Path $resolvedPackagePath $relativePath
    if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) { continue }
    $content = Get-Content -LiteralPath $candidate -Raw -Encoding UTF8
    if ([string]::IsNullOrWhiteSpace($content) -or $content.Trim().Length -lt 10) {
        $errors.Add("Required text file is empty or incomplete: $relativePath.")
        continue
    }
    if ($content -match
        "(?i)\bTODO\b|\bTBD\b|\u5F85\u8865\u5145|\u5F85\u786E\u8BA4|Lorem ipsum") {
        $errors.Add("Placeholder text found in $relativePath.")
    }
}

if ($null -ne $manifestSpec) {
    try {
        if ($manifestSpec.schemaVersion -ne 1) {
            $errors.Add("manifest.json schemaVersion must be 1.")
        }
        if ($manifestSpec.status -ne "publish-ready") {
            $errors.Add("manifest.json status must be publish-ready.")
        }
        if ($null -ne $materialSpec) {
            if ($manifestSpec.projectId -ne $materialSpec.projectId) {
                $errors.Add("manifest.json projectId must match material-kit.json.")
            }
            if ($manifestSpec.materialKitId -ne $materialSpec.materialKitId) {
                $errors.Add("manifest.json materialKitId must match material-kit.json.")
            }
            if ($manifestSpec.materialKitSha256 -ne $materialKitSha256) {
                $errors.Add("manifest.json materialKitSha256 must match material-kit.json.")
            }
            if ($manifestSpec.selectedIdeaId -ne $materialSpec.selectedIdeaId) {
                $errors.Add("manifest.json selectedIdeaId must match material-kit.json.")
            }
            if ($manifestSpec.topic -ne $materialSpec.topic) {
                $errors.Add("manifest.json topic must match material-kit.json.")
            }
            $manifestPalette = ConvertTo-Json @($manifestSpec.palette) -Compress
            $materialPalette = ConvertTo-Json @($materialSpec.visualDirection.palette) -Compress
            if ($manifestPalette -ne $materialPalette) {
                $errors.Add("manifest.json palette must match material-kit.json.")
            }
        }
        if ($manifestSpec.canvas.width -ne 1242 -or $manifestSpec.canvas.height -ne 1660) {
            $errors.Add("manifest.json canvas must be 1242x1660.")
        }
        $expectedCards = @($cardFiles | ForEach-Object { "cards/$($_.Name)" })
        $manifestCards = @($manifestSpec.files.cards)
        $manifestCardJson = ConvertTo-Json $manifestCards -Compress
        $expectedCardJson = ConvertTo-Json $expectedCards -Compress
        if ($manifestCardJson -ne $expectedCardJson) {
            $errors.Add("manifest.json card paths do not match rendered cards.")
        }
        if ($manifestSpec.files.cover -ne "cover.png") {
            $errors.Add("manifest.json cover path must be cover.png.")
        }
        $expectedFiles = @{
            post = "post.md"
            package = "package.json"
            sources = "sources.md"
            checklist = "publish-checklist.md"
        }
        foreach ($field in $expectedFiles.Keys) {
            if ($manifestSpec.files.$field -ne $expectedFiles[$field]) {
                $errors.Add("manifest.json $field path is invalid.")
            }
        }
    }
    catch {
        $errors.Add("manifest.json is missing required fields.")
    }
}

$result = [ordered]@{
    ok = $errors.Count -eq 0
    checkedAt = (Get-Date).ToUniversalTime().ToString("o")
    packagePath = $resolvedPackagePath
    imageCount = $imageFiles.Count
    cardCount = $cardFiles.Count
    errors = @($errors)
}
$json = $result | ConvertTo-Json -Depth 5
if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
    $resolvedOutputPath = [System.IO.Path]::GetFullPath($OutputPath)
    if (-not [System.IO.Path]::IsPathRooted($OutputPath)) {
        throw "OutputPath must be an absolute path."
    }
    $json | Set-Content -LiteralPath $resolvedOutputPath -Encoding UTF8
}
Write-Output $json
if (-not $result.ok) {
    exit 1
}
