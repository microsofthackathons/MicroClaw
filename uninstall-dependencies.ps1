$root = Split-Path -Parent $MyInvocation.MyCommand.Path
& "$root\scripts\windows\uninstall-dependencies.ps1" @args