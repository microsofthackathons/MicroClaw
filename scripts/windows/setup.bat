@echo off
where pwsh >nul 2>&1 && (
    pwsh -ExecutionPolicy Bypass -File "%~dp0setup-dependencies.ps1" %*
) || (
    powershell -ExecutionPolicy Bypass -File "%~dp0setup-dependencies.ps1" %*
)
