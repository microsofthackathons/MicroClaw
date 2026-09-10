function Test-SupportedNodeVersion {
    param([string]$Version)

    if ($Version -cnotmatch '\Av?(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\z') {
        return $false
    }
    try {
        $parsed = [version]$Version.TrimStart("v")
    } catch {
        return $false
    }
    return (
        ($parsed.Major -eq 24 -and $parsed -ge [version]"24.16.0") -or
        ($parsed.Major -ge 26 -and $parsed -ge [version]"26.1.0")
    )
}
