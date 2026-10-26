; MicroClaw single-exe setup stub (NSIS)
; ---------------------------------------------------------------------------
; Wraps the PyInstaller *onedir* installer (dist\MicroClawInstaller\) into ONE
; downloadable, code-signable .exe. On launch it:
;   1. selects an isolated staging directory for this payload,
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
;   PAYLOAD_ID   SHA-256 identity of the complete onedir payload
; ---------------------------------------------------------------------------

Unicode true
!include "FileFunc.nsh"
LoadLanguageFile "${NSISDIR}\Contrib\Language files\English.nlf"
LoadLanguageFile "${NSISDIR}\Contrib\Language files\SimpChinese.nlf"

!ifndef PAYLOAD_DIR
  !error "PAYLOAD_DIR is required (path to the onedir installer)."
!endif
!ifndef OUT_FILE
  !define OUT_FILE "MicroClawSetup.exe"
!endif
!ifndef VERSION
  !define VERSION "0.0.0.0"
!endif
!ifndef PAYLOAD_ID
  !error "PAYLOAD_ID is required."
!endif

Name "MicroClaw"
OutFile "${OUT_FILE}"
!ifdef ICON
  Icon "${ICON}"
!endif

; Extraction only — no admin needed. The inner installer self-elevates the
; individual steps (e.g. the Node.js MSI) when required.
RequestExecutionLevel user
SetCompressor /SOLID lzma

InstallDir "$LOCALAPPDATA\MicroClaw\Setup\${PAYLOAD_ID}"
SilentInstall silent
Var ExtractOnly

; Version resource — a proper version block improves the signed file's
; presentation in SmartScreen / UAC / file properties.
VIProductVersion "${VERSION}"
VIAddVersionKey "ProductName"    "MicroClaw Setup"
VIAddVersionKey "FileDescription" "MicroClaw Installer"
VIAddVersionKey "FileVersion"    "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "CompanyName"    "MicroClaw"
VIAddVersionKey "LegalCopyright" "Copyright (C) 2026 MicroClaw"

LangString PreparingText ${LANG_ENGLISH} "Preparing MicroClaw..."
LangString PreparingText ${LANG_SIMPCHINESE} "正在准备 MicroClaw..."
LangString ExtractionFailedText ${LANG_ENGLISH} "Could not prepare the complete MicroClaw installer. Close other installer windows and try again."
LangString ExtractionFailedText ${LANG_SIMPCHINESE} "未能完整准备 MicroClaw 安装器。请关闭其他安装窗口后重试。"

Function .onInit
  StrCpy $LANGUAGE ${LANG_SIMPCHINESE}
  StrCpy $ExtractOnly 0
  ${GetParameters} $0
  ClearErrors
  ${GetOptions} $0 "/EXTRACT_ONLY" $1
  IfErrors init_done
  StrCpy $ExtractOnly 1
init_done:
FunctionEnd

Section "Install"
  ; Reuse staging only when the previous extraction completed with the exact
  ; payload embedded in this setup build.
  IfFileExists "$INSTDIR\MicroClawInstaller.exe" 0 extract_payload
  IfFileExists "$INSTDIR\.payload-complete" 0 extract_payload
  FileOpen $0 "$INSTDIR\.payload-complete" r
  FileRead $0 $1
  FileClose $0
  StrCmp $1 "${PAYLOAD_ID}" launch_installer extract_payload

extract_payload:
  StrCmp $ExtractOnly 1 reset_staging
  Banner::show /NOUNLOAD "$(PreparingText)"

  ; Reset only this build's incomplete staging, never another running build.
reset_staging:
  ClearErrors
  RMDir /r "$INSTDIR"
  IfErrors extraction_failed
  SetOutPath "$INSTDIR"
  SetOverwrite on

  DetailPrint "Extracting MicroClaw installer..."
  File /r "${PAYLOAD_DIR}\*"
  IfErrors extraction_failed
  StrCmp $ExtractOnly 1 payload_check
  Banner::destroy

payload_check:
  IfFileExists "$INSTDIR\MicroClawInstaller.exe" payload_complete extraction_failed

payload_complete:
  ClearErrors
  FileOpen $0 "$INSTDIR\.payload-complete" w
  IfErrors extraction_failed
  FileWrite $0 "${PAYLOAD_ID}"
  FileClose $0
  IfErrors extraction_failed
  Goto launch_installer

extraction_failed:
  StrCmp $ExtractOnly 1 extraction_quit
  Banner::destroy
  MessageBox MB_ICONSTOP "$(ExtractionFailedText)"
extraction_quit:
  SetErrorLevel 2
  Quit

launch_installer:
  StrCmp $ExtractOnly 1 extraction_done
  ; Fire-and-forget: launch the real installer, then let this stub close.
  DetailPrint "Starting MicroClaw installer..."
  ClearErrors
  Exec '"$INSTDIR\MicroClawInstaller.exe"'
  IfErrors extraction_failed
extraction_done:
  SetErrorLevel 0
SectionEnd
