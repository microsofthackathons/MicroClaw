; MicroClaw single-exe setup stub (NSIS)
; ---------------------------------------------------------------------------
; Wraps the PyInstaller *onedir* installer (dist\MicroClawInstaller\) into ONE
; downloadable, code-signable .exe. On launch it:
;   1. clears any stale staging from a previous run,
;   2. extracts the onedir payload to a REAL directory under %LOCALAPPDATA%
;      (deliberately NOT %TEMP% — this preserves the WDAC-safe posture that
;      the team chose onedir for; unsigned bundled DLLs never load from %TEMP%),
;   3. auto-launches MicroClawInstaller.exe (the existing web installer UI),
;   4. exits, leaving the installer running — no manual step required.
;
; Only THIS stub needs an Authenticode signature to clear SmartScreen: it is
; the single file the user downloads (and therefore the only one that carries
; Mark-of-the-Web). Files it extracts are created by a trusted local process,
; so they carry no MOTW and are not re-evaluated by SmartScreen.
;
; Build-time defines (passed by build.ps1):
;   PAYLOAD_DIR  absolute path to dist\MicroClawInstaller (the onedir)
;   OUT_FILE     absolute path of the .exe to produce (dist\MicroClawSetup.exe)
;   ICON         absolute path to the app .ico
;   VERSION      4-part version string, e.g. 1.0.0.0
; ---------------------------------------------------------------------------

Unicode true

!ifndef PAYLOAD_DIR
  !error "PAYLOAD_DIR is required (path to the onedir installer)."
!endif
!ifndef OUT_FILE
  !define OUT_FILE "MicroClawSetup.exe"
!endif
!ifndef VERSION
  !define VERSION "0.0.0.0"
!endif

Name "MicroClaw Setup"
OutFile "${OUT_FILE}"
!ifdef ICON
  Icon "${ICON}"
!endif

; Extraction only — no admin needed. The inner installer self-elevates the
; individual steps (e.g. the Node.js MSI) when required.
RequestExecutionLevel user
SetCompressor /SOLID lzma

InstallDir "$LOCALAPPDATA\MicroClaw\Setup"
AutoCloseWindow true
ShowInstDetails show
BrandingText "MicroClaw"

; Version resource — a proper version block improves the signed file's
; presentation in SmartScreen / UAC / file properties.
VIProductVersion "${VERSION}"
VIAddVersionKey "ProductName"    "MicroClaw Setup"
VIAddVersionKey "FileDescription" "MicroClaw Installer"
VIAddVersionKey "FileVersion"    "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "CompanyName"    "MicroClaw"
VIAddVersionKey "LegalCopyright" "Copyright (C) 2026 MicroClaw"

Page instfiles

Section "Install"
  ; Bound disk usage to a single copy: wipe any leftover staging first.
  RMDir /r "$INSTDIR"
  SetOutPath "$INSTDIR"
  SetOverwrite on

  DetailPrint "Extracting MicroClaw installer..."
  File /r "${PAYLOAD_DIR}\*"

  IfFileExists "$INSTDIR\MicroClawInstaller.exe" +3 0
    MessageBox MB_ICONSTOP "Setup payload is incomplete: MicroClawInstaller.exe was not found."
    Abort "Missing MicroClawInstaller.exe"

  ; Fire-and-forget: launch the real installer, then let this stub close.
  DetailPrint "Starting MicroClaw installer..."
  Exec '"$INSTDIR\MicroClawInstaller.exe"'
SectionEnd
