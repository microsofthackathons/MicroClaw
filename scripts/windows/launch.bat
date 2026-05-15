@echo off
setlocal

REM ═══════════════════════════════════════════════════════
REM  MicroClaw Deployer — canonical Windows launcher
REM  Kept under scripts/windows; root launch.bat is a wrapper.
REM ═══════════════════════════════════════════════════════

for %%I in ("%~dp0..\..") do set "REPO_ROOT=%%~fI"

title MicroClaw Deployer

REM Check Python
python --version >nul 2>&1
if %errorlevel% neq 0 (
    echo [ERROR] Python 3 is required but not found in PATH.
    echo         Download from https://www.python.org/downloads/
    pause
    exit /b 1
)

REM Launch the GUI from the repo root so imports and assets resolve consistently.
cd /d "%REPO_ROOT%"
python deploy.py
if %errorlevel% neq 0 (
    echo.
    echo [ERROR] Deployer exited with an error.
    pause
)

endlocal
