const WINDOWS_NODE_TRANSPORT_INSTRUCTIONS = `## Windows Node command transport

The exec tool uses OpenClaw's Windows Node transport: cmd.exe /d /s /c.
Use CMD syntax, not bare PowerShell cmdlets. For example, use \`dir\`, \`type\`,
or \`git status\`. Invoke powershell.exe explicitly when PowerShell is necessary.
Command consent applies to exec in both regular and MXC modes. Regular mode
also permits native file tools, which bypass command consent. In MXC mode,
native file tools are unavailable; choose an exec command for file operations.
Windows Node decides whether a command can be remembered. CMD built-ins and
quoted or dynamic PowerShell may require one-use approval. Never change an
approved command to bypass consent. MXC folder grants remain independent.
`;

export const WINDOWS_NODE_POWERSHELL_QUOTING_INSTRUCTIONS = `## PowerShell command quoting

For a simple PowerShell command, prefer leaving the entire -Command script
unquoted only when both CMD and PowerShell will parse it correctly. For example:
\`powershell.exe -Command New-Item -Path 'C:\\work\\notes.txt' -ItemType File -Force\`
Keep quotes and escaping required for individual values. For compound scripts,
shell metacharacters, or other cases where removing the script's double quotes
changes parsing, use the correct syntax instead.
Never sacrifice correctness or safety to make a command rememberable;
Windows Node decides whether Allow always is available.
`;

export const WINDOWS_NODE_MXC_POWERSHELL_DELETE_INSTRUCTIONS = `## PowerShell deletion in MXC

When using Remove-Item in MXC mode, include a scoped filesystem-drive setup in
your own PowerShell script before the deletion. This avoids a PowerShell provider
initialization failure without changing the OpenClaw command transport. For a
literal file, for example:

\`\`\`
REM [declare-access]rw:C:\\work[/declare-access]
powershell.exe -NoProfile -Command "New-PSDrive -Name MicroClawCwd -PSProvider FileSystem -Root ([Environment]::CurrentDirectory) -Scope Script -ErrorAction Stop | Out-Null; Set-Location -LiteralPath 'MicroClawCwd:\\' -ErrorAction Stop; Remove-Item -LiteralPath 'C:\\work\\notes.txt' -Force -ErrorAction Stop"
\`\`\`

Declare only the folder needed for the requested operation. Do not broaden
folder grants or add recursive deletion unless the user requested it. Keep the
script quotes and escape values correctly for CMD and PowerShell. This compound
command may require one-use approval; do not alter it to bypass consent.
`;

export const WINDOWS_NODE_SHELL_INSTRUCTIONS = `${WINDOWS_NODE_TRANSPORT_INSTRUCTIONS}
${WINDOWS_NODE_POWERSHELL_QUOTING_INSTRUCTIONS}
${WINDOWS_NODE_MXC_POWERSHELL_DELETE_INSTRUCTIONS}`;

const WINDOWS_NODE_ACCESS_SECTION = `## Pre-declaring File System Access

For exec commands that access files outside the workspace in MXC mode, put
a declaration on the first line and the actual CMD command on the next line.
The host removes the declaration before execution. Use literal absolute Windows
directory paths, with ro for reading or rw for creating, changing, or deleting.
Do not use variables in declarations or submit a declaration without a command.

\`\`\`
REM [declare-access]ro:C:\\Users\\alice\\Desktop[/declare-access]
dir "C:\\Users\\alice\\Desktop"
\`\`\`

\`\`\`
REM [declare-access]rw:C:\\Users\\alice\\Desktop;rw:C:\\Users\\alice\\Documents[/declare-access]
move "C:\\Users\\alice\\Desktop\\report.xlsx" "C:\\Users\\alice\\Documents\\"
\`\`\`

Declare only the directories actually needed, never a drive root or all users.
A declaration requests access; it does not grant it. Missing MXC folder grants
and command approval are presented together in one prompt.
`;

export const WINDOWS_NODE_ACCESS_INSTRUCTIONS = `${WINDOWS_NODE_ACCESS_SECTION}
${WINDOWS_NODE_SHELL_INSTRUCTIONS}`;

const PREVIOUS_TRANSPORT_INSTRUCTIONS = `## Windows Node command transport

The exec tool uses OpenClaw's Windows Node transport: cmd.exe /d /s /c.
Use CMD syntax, not bare PowerShell cmdlets. For example, use \`dir\`, \`type\`,
or \`git status\`. Invoke powershell.exe explicitly when PowerShell is necessary.
Command consent applies to exec in both regular and MXC modes. Regular mode
also permits native file tools, which bypass command consent. In MXC mode,
native file tools are unavailable; choose an exec command for file operations.
Windows Node decides whether a command can be remembered. CMD built-ins and
inline PowerShell generally require one-use approval; do not rewrite commands
to bypass this. MXC folder grants remain independent of command consent.
`;

export function updateWindowsNodeInstructions(content: string, legacySection: string): string {
  let updated = content;
  const legacy = legacySection.trim();
  if (legacy && updated.includes(legacy)) {
    const replacements = [WINDOWS_NODE_ACCESS_SECTION.trim()];
    if (!updated.includes("## Windows Node command transport")) {
      replacements.push(WINDOWS_NODE_TRANSPORT_INSTRUCTIONS.trim());
    }
    if (!updated.includes("## PowerShell command quoting")) {
      replacements.push(WINDOWS_NODE_POWERSHELL_QUOTING_INSTRUCTIONS.trim());
    }
    if (!updated.includes("## PowerShell deletion in MXC")) {
      replacements.push(WINDOWS_NODE_MXC_POWERSHELL_DELETE_INSTRUCTIONS.trim());
    }
    updated = updated.replace(legacy, replacements.join("\n\n"));
  }
  if (updated.includes(PREVIOUS_TRANSPORT_INSTRUCTIONS.trim())) {
    updated = updated.replace(
      PREVIOUS_TRANSPORT_INSTRUCTIONS.trim(),
      WINDOWS_NODE_TRANSPORT_INSTRUCTIONS.trim(),
    );
  }
  const missing: string[] = [];
  if (!updated.includes("## Pre-declaring File System Access")) {
    missing.push(WINDOWS_NODE_ACCESS_SECTION.trim());
  }
  if (!updated.includes("## Windows Node command transport")) {
    missing.push(WINDOWS_NODE_TRANSPORT_INSTRUCTIONS.trim());
  }
  if (!updated.includes("## PowerShell command quoting")) {
    missing.push(WINDOWS_NODE_POWERSHELL_QUOTING_INSTRUCTIONS.trim());
  }
  if (!updated.includes("## PowerShell deletion in MXC")) {
    missing.push(WINDOWS_NODE_MXC_POWERSHELL_DELETE_INSTRUCTIONS.trim());
  }
  return missing.length ? `${updated.trimEnd()}\n\n${missing.join("\n\n")}\n` : updated;
}
