Run the full project build via `build.ps1`.

This builds everything: desktop app, portable zip, and the installer exe.

Steps:
1. Run `powershell -ExecutionPolicy Bypass -File build.ps1` from the repo root (`q:/src/microclaw`)
2. Use a 10-minute timeout since the build includes electron-builder and pyinstaller
3. Report the build result: success or failure with error details
4. On success, list the output artifacts and their sizes from `dist/`
