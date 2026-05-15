$root = Split-Path -Parent $MyInvocation.MyCommand.Path
& "$root\scripts\windows\setup-dependencies.ps1" @args