#Requires -Version 5.1

function Invoke-WithMicroClawNpmRegistry {
    param(
        [Parameter(Mandatory = $true)][string]$DefaultConfigPath,
        [Parameter(Mandatory = $true)][scriptblock]$Operation
    )
    $registry = $env:MICROCLAW_NPM_REGISTRY
    if (-not $registry) { $registry = $env:MSIX_NPM_REGISTRY }
    if (-not $registry) {
        $configuration = Get-Content -LiteralPath $DefaultConfigPath -Raw | ConvertFrom-Json
        if ($configuration.schema -ne 1) { throw 'Unsupported MicroClaw npm source configuration.' }
        $registry = $configuration.registry
    }
    $uri = $null
    if (-not $registry -or $registry.Trim() -notmatch '^https?://' -or $registry.Trim() -match '[\s\\]' -or
        -not [Uri]::TryCreate($registry.Trim(), [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -notin @('http','https') -or -not $uri.Host -or
        $uri.UserInfo -or $uri.Query -or $uri.Fragment) {
        throw 'MicroClaw npm registry must be an absolute HTTP(S) URL without credentials or query.'
    }
    $registry = $uri.AbsoluteUri.TrimEnd('/')
    $settings = @{
        MICROCLAW_NPM_REGISTRY = $registry
        npm_config_registry = $registry
        npm_config_replace_registry_host = 'npmjs'
    }
    $previous = @{}
    foreach ($entry in @(Get-ChildItem Env:)) {
        if ($settings.ContainsKey($entry.Name)) { $previous[$entry.Name] = $entry.Value }
    }
    try {
        foreach ($name in $settings.Keys) { [Environment]::SetEnvironmentVariable($name, $settings[$name], 'Process') }
        & $Operation $registry
    } finally {
        foreach ($entry in @(Get-ChildItem Env:)) {
            if ($settings.ContainsKey($entry.Name)) { Remove-Item -LiteralPath ("Env:" + $entry.Name) -ErrorAction SilentlyContinue }
        }
        foreach ($name in $previous.Keys) { [Environment]::SetEnvironmentVariable($name, $previous[$name], 'Process') }
    }
}
