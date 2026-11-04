export const WINDOWS_NODE_MEMORY_INSTRUCTIONS = `## Memory recall before filesystem tools

In both regular and MXC modes, use memory tools before native file tools or exec
when reading memories. For questions about prior work, decisions, preferences,
or todos, use memory_search first, then memory_get for the needed memory-file
excerpts. For a known memory file such as MEMORY.md, USER.md, or memory/*.md,
use memory_get directly rather than read, type, Get-Content, or another exec command.
If tools are deferred, discover memory_search or memory_get with tool_search,
inspect with tool_describe when needed, and invoke with tool_call.

Memory recall is scoped by OpenClaw to the current agent's configured memory
sources and session privacy rules. It runs in the Gateway, independently of MXC
folder grants; it is not general filesystem permission. Do not read raw session
transcripts or use filesystem tools to bypass a memory privacy refusal.
If recall is unavailable, denied, stale, or fails, report that limitation rather
than claiming there are no memories or silently falling back to exec.
Reading memory does not authorize editing it or changing any folder permissions.
`;

const PRE_MEMORY_TRANSPORT_INSTRUCTIONS = `## Windows Node command transport

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

const WINDOWS_NODE_TRANSPORT_INSTRUCTIONS = PRE_MEMORY_TRANSPORT_INSTRUCTIONS.replace(
  "In MXC mode,\nnative file tools are unavailable; choose an exec command for file operations.",
  "For ordinary file reads, writes, and edits, prefer an appropriate native file tool\n" +
    "when it is available in the current turn. In MXC mode native file tools are\n" +
    "unavailable; use scoped memory tools for memory recall and contained exec\n" +
    "for other file operations. Choose exec for shell workflows or operations\n" +
    "without a suitable native tool. Route by the tools available now, not by a\n" +
    "previous mode or the last successful action. Do not retry a denied or failed\n" +
    "native operation through exec unless the user authorizes that fallback.",
);

const PRE_FILE_ROUTING_TRANSPORT_INSTRUCTIONS = PRE_MEMORY_TRANSPORT_INSTRUCTIONS.replace(
  "native file tools are unavailable; choose an exec command for file operations.",
  "native file tools are unavailable; use scoped memory tools for memory recall\n" +
    "and contained exec for other file operations.",
);

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

export const WINDOWS_NODE_SHELL_INSTRUCTIONS = `${WINDOWS_NODE_MEMORY_INSTRUCTIONS}
${WINDOWS_NODE_TRANSPORT_INSTRUCTIONS}
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

const PREVIOUS_TRANSPORT_INSTRUCTIONS_DYNAMIC_VARIANT = PREVIOUS_TRANSPORT_INSTRUCTIONS.replace(
  "inline PowerShell generally require one-use approval; do not rewrite commands\n" +
    "to bypass this. MXC folder grants remain independent of command consent.",
  "quoted or dynamic PowerShell may require one-use approval. Never change an\n" +
    "approved command to bypass consent. MXC folder grants remain independent of command consent.",
);

const PREVIOUS_TRANSPORT_INSTRUCTIONS_SHORT_GRANT_COPY =
  PREVIOUS_TRANSPORT_INSTRUCTIONS_DYNAMIC_VARIANT.replace(
    "MXC folder grants remain independent of command consent.",
    "MXC folder grants remain independent.",
  );

export function updateWindowsNodeInstructions(content: string, legacySection: string): string {
  let updated = content;
  const legacy = legacySection.trim();
  if (legacy && updated.includes(legacy)) {
    const replacements = [WINDOWS_NODE_ACCESS_SECTION.trim()];
    if (!updated.includes("## Memory recall before filesystem tools")) {
      replacements.push(WINDOWS_NODE_MEMORY_INSTRUCTIONS.trim());
    }
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
  for (const previous of [
    PREVIOUS_TRANSPORT_INSTRUCTIONS,
    PREVIOUS_TRANSPORT_INSTRUCTIONS_DYNAMIC_VARIANT,
    PREVIOUS_TRANSPORT_INSTRUCTIONS_SHORT_GRANT_COPY,
    PRE_MEMORY_TRANSPORT_INSTRUCTIONS,
    PRE_FILE_ROUTING_TRANSPORT_INSTRUCTIONS,
  ]) {
    if (updated.includes(previous.trim())) {
      updated = updated.replace(previous.trim(), WINDOWS_NODE_TRANSPORT_INSTRUCTIONS.trim());
    }
  }
  const missing: string[] = [];
  if (!updated.includes("## Pre-declaring File System Access")) {
    missing.push(WINDOWS_NODE_ACCESS_SECTION.trim());
  }
  if (!updated.includes("## Memory recall before filesystem tools")) {
    missing.push(WINDOWS_NODE_MEMORY_INSTRUCTIONS.trim());
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
