import { describe, expect, it } from "vitest";
import {
  updateWindowsNodeInstructions,
  WINDOWS_NODE_ACCESS_INSTRUCTIONS,
  WINDOWS_NODE_GIT_INSTRUCTIONS,
  WINDOWS_NODE_MEMORY_INSTRUCTIONS,
  WINDOWS_NODE_PERMISSION_DENIED_INSTRUCTIONS,
  WINDOWS_NODE_POWERSHELL_QUOTING_INSTRUCTIONS,
  WINDOWS_NODE_POWERSHELL_SCRATCH_INSTRUCTIONS,
  WINDOWS_NODE_SHELL_INSTRUCTIONS,
} from "./windows-node-command-instructions";

describe("Windows Node command instructions", () => {
  const legacy = `## Pre-declaring File System Access

Use Get-ChildItem in the generated PowerShell examples.
`;
  const previousTransport = `## Windows Node command transport

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

  it("replaces a recognized generated section without changing surrounding content", () => {
    const source = `# Personality\n\nKeep my voice.\n\n${legacy}\n## Custom guidance\n\nKeep this too.\n`;
    const updated = updateWindowsNodeInstructions(source, legacy);

    expect(updated).toContain("# Personality\n\nKeep my voice.");
    expect(updated).toContain("## Custom guidance\n\nKeep this too.");
    expect(updated).not.toContain("Get-ChildItem");
    expect(updated).toContain(WINDOWS_NODE_ACCESS_INSTRUCTIONS.trim());
    expect(updateWindowsNodeInstructions(updated, legacy)).toBe(updated);
  });

  it("preserves a customized access section and adds the transport instructions once", () => {
    const source = "## Pre-declaring File System Access\n\nMy custom rules.\n";
    const updated = updateWindowsNodeInstructions(source, legacy);

    expect(updated).toContain("My custom rules.");
    expect(updated).toContain(WINDOWS_NODE_SHELL_INSTRUCTIONS.trim());
    expect(updateWindowsNodeInstructions(updated, legacy)).toBe(updated);
  });

  it("adds the complete instructions to a workspace that lacks them", () => {
    const updated = updateWindowsNodeInstructions("# My agent\n", legacy);

    expect(updated).toContain(WINDOWS_NODE_ACCESS_INSTRUCTIONS.trim());
    expect(updated).toMatch(/file tools remain available in both modes/);
    expect(updateWindowsNodeInstructions(updated, legacy)).toBe(updated);
  });

  it("upgrades generated access guidance to distinguish Off mode without changing user notes", () => {
    const previous = WINDOWS_NODE_ACCESS_INSTRUCTIONS.replace(
      "MXC can switch live. In Off mode, do not add declarations or request MXC\n" +
        "folder grants; host execution remains subject to command-consent settings.\n\n",
      "",
    );
    const updated = updateWindowsNodeInstructions(
      `# Agent\n\n${previous}\n## Notes\nKeep these.\n`,
      legacy,
    );
    expect(updated).toContain("In Off mode, do not add declarations");
    expect(updated).toContain("host execution remains subject to command-consent settings");
    expect(updated).toContain("## Notes\nKeep these.");
    expect(updateWindowsNodeInstructions(updated, legacy)).toBe(updated);
  });

  it("upgrades the prior generated transport guidance without changing user notes", () => {
    const source = `${legacy}\n${previousTransport}\n## User notes\n\nPreserve my instructions.\n`;
    const updated = updateWindowsNodeInstructions(source, legacy);

    expect(updated).toContain("Preserve my instructions.");
    expect(updated).not.toContain("inline PowerShell generally");
    expect(updated).toContain(WINDOWS_NODE_POWERSHELL_QUOTING_INSTRUCTIONS.trim());
    expect(updated).toContain(WINDOWS_NODE_POWERSHELL_SCRATCH_INSTRUCTIONS.trim());
    expect(updated).not.toContain("## PowerShell deletion in MXC");
    expect(updated.match(/## Windows Node command transport/g)).toHaveLength(1);
    expect(updateWindowsNodeInstructions(updated, legacy)).toBe(updated);
  });

  it("preserves customized transport guidance and appends the quoting preference once", () => {
    const source = `## Windows Node command transport\n\nMy custom transport guidance.\n`;
    const updated = updateWindowsNodeInstructions(source, legacy);

    expect(updated).toContain("My custom transport guidance.");
    expect(updated).toContain(WINDOWS_NODE_POWERSHELL_QUOTING_INSTRUCTIONS.trim());
    expect(updated).toContain("## Pre-declaring File System Access");
    expect(updated.match(/## Windows Node command transport/g)).toHaveLength(1);
    expect(updateWindowsNodeInstructions(updated, legacy)).toBe(updated);
  });

  it("asks for unquoted simple scripts but keeps quotes needed for correct parsing", () => {
    expect(WINDOWS_NODE_POWERSHELL_QUOTING_INSTRUCTIONS).toContain(
      "prefer leaving the entire -Command script\nunquoted",
    );
    expect(WINDOWS_NODE_POWERSHELL_QUOTING_INSTRUCTIONS).toContain(
      "only when both CMD and PowerShell will parse it correctly",
    );
    expect(WINDOWS_NODE_POWERSHELL_QUOTING_INSTRUCTIONS).toContain(
      "Keep quotes and escaping required for individual values",
    );
    expect(WINDOWS_NODE_POWERSHELL_QUOTING_INSTRUCTIONS).toContain(
      "Never sacrifice correctness or safety",
    );
  });

  it("removes the previous generated deletion workaround while preserving adjacent user notes", () => {
    const previous =
      "## PowerShell deletion in MXC\n\n" +
      "When using Remove-Item in MXC mode, include a scoped filesystem-drive setup in\n" +
      "your own PowerShell script before the deletion. This avoids a PowerShell provider\n" +
      "initialization failure without changing the OpenClaw command transport. For a\n" +
      "literal file, for example:\n\n" +
      "```\nREM [declare-access]rw:C:\\work[/declare-access]\n" +
      "powershell.exe -NoProfile -Command \"New-PSDrive -Name MicroClawCwd -PSProvider FileSystem -Root ([Environment]::CurrentDirectory) -Scope Script -ErrorAction Stop | Out-Null; Set-Location -LiteralPath 'MicroClawCwd:\\' -ErrorAction Stop; Remove-Item -LiteralPath 'C:\\work\\notes.txt' -Force -ErrorAction Stop\"\n" +
      "```\n\n" +
      "Declare only the folder needed for the requested operation. Do not broaden\n" +
      "folder grants or add recursive deletion unless the user requested it. Keep the\n" +
      "script quotes and escape values correctly for CMD and PowerShell. This compound\n" +
      "command may require one-use approval; do not alter it to bypass consent.\n";
    const updated = updateWindowsNodeInstructions(
      `# My agent\n\n${previous}\n## My notes\nKeep these.\n`,
      legacy,
    );
    expect(updated).toContain("## My notes\nKeep these.");
    expect(updated).not.toContain("## PowerShell deletion in MXC");
    expect(updated).toContain(WINDOWS_NODE_POWERSHELL_SCRATCH_INSTRUCTIONS.trim());
    expect(updateWindowsNodeInstructions(updated, legacy)).toBe(updated);
  });

  it("preserves customized deletion guidance and does not add a duplicate", () => {
    const source = "## PowerShell deletion in MXC\n\nMy custom deletion instructions.\n";
    const updated = updateWindowsNodeInstructions(source, legacy);

    expect(updated).toContain("My custom deletion instructions.");
    expect(updated).toContain(WINDOWS_NODE_POWERSHELL_SCRATCH_INSTRUCTIONS.trim());
    expect(updated.match(/## PowerShell deletion in MXC/g)).toHaveLength(1);
    expect(updateWindowsNodeInstructions(updated, legacy)).toBe(updated);
  });

  it("prioritizes discovered memory tools in regular and MXC modes without bypassing privacy", () => {
    expect(WINDOWS_NODE_MEMORY_INSTRUCTIONS).toContain("In both regular and MXC modes");
    expect(WINDOWS_NODE_MEMORY_INSTRUCTIONS).toContain("use memory_search first");
    expect(WINDOWS_NODE_MEMORY_INSTRUCTIONS).toContain("use memory_get directly rather than read");
    expect(WINDOWS_NODE_MEMORY_INSTRUCTIONS).toContain("tool_search");
    expect(WINDOWS_NODE_MEMORY_INSTRUCTIONS).toContain("tool_call");
    expect(WINDOWS_NODE_MEMORY_INSTRUCTIONS).toContain("bypass a memory privacy refusal");
    expect(WINDOWS_NODE_MEMORY_INSTRUCTIONS).toContain("silently falling back to exec");
    expect(WINDOWS_NODE_MEMORY_INSTRUCTIONS).toContain("does not authorize editing");
    expect(WINDOWS_NODE_SHELL_INSTRUCTIONS.indexOf("## Memory recall")).toBeLessThan(
      WINDOWS_NODE_SHELL_INSTRUCTIONS.indexOf("## Windows Node command transport"),
    );
  });

  it("explains how to retry scratch initialization without bypassing consent or folder grants", () => {
    expect(WINDOWS_NODE_POWERSHELL_SCRATCH_INSTRUCTIONS).toContain("approved working directory");
    expect(WINDOWS_NODE_POWERSHELL_SCRATCH_INSTRUCTIONS).toContain("New-PSDrive");
    expect(WINDOWS_NODE_POWERSHELL_SCRATCH_INSTRUCTIONS).toContain("new command for fresh consent");
    expect(WINDOWS_NODE_POWERSHELL_SCRATCH_INSTRUCTIONS).toContain("broaden folder grants");
  });

  it("explains Git's implicit global config without silently broadening access", () => {
    expect(WINDOWS_NODE_GIT_INSTRUCTIONS).toContain("global configuration outside the workspace");
    expect(WINDOWS_NODE_GIT_INSTRUCTIONS).toContain("Declare that directory read-only");
    expect(WINDOWS_NODE_GIT_INSTRUCTIONS).toContain("whole profile");
    expect(WINDOWS_NODE_GIT_INSTRUCTIONS).toContain("Do not silently grant");
    expect(WINDOWS_NODE_GIT_INSTRUCTIONS).toContain("change ownership, ACLs");
    const customized = "## Git configuration in MXC\n\nMy Git guidance.\n";
    const updated = updateWindowsNodeInstructions(customized, legacy);
    expect(updated).toContain(customized.trim());
    expect(updated.match(/## Git configuration in MXC/g)).toHaveLength(1);
    expect(updateWindowsNodeInstructions(updated, legacy)).toBe(updated);
  });

  it("requests scoped access after contained permission errors without bypassing consent", () => {
    expect(WINDOWS_NODE_PERMISSION_DENIED_INSTRUCTIONS).toContain("while MXC is On");
    for (const error of ["Permission denied", "Access is denied", "EACCES", "EPERM"]) {
      expect(WINDOWS_NODE_PERMISSION_DENIED_INSTRUCTIONS).toContain(error);
    }
    expect(WINDOWS_NODE_PERMISSION_DENIED_INSTRUCTIONS).toContain("[declare-access]");
    expect(WINDOWS_NODE_PERMISSION_DENIED_INSTRUCTIONS).toContain("smallest needed directory");
    expect(WINDOWS_NODE_PERMISSION_DENIED_INSTRUCTIONS).toContain("ro for reading, rw for");
    expect(WINDOWS_NODE_PERMISSION_DENIED_INSTRUCTIONS).toContain("fresh combined folder");
    expect(WINDOWS_NODE_PERMISSION_DENIED_INSTRUCTIONS).toContain("Check for partial effects");
    expect(WINDOWS_NODE_PERMISSION_DENIED_INSTRUCTIONS).toContain("ask rather than guessing");
    expect(WINDOWS_NODE_PERMISSION_DENIED_INSTRUCTIONS).toContain("Do not disable MXC");
    expect(WINDOWS_NODE_PERMISSION_DENIED_INSTRUCTIONS).toContain(
      "In Off mode, do not request MXC folder grants",
    );
  });

  it("adds permission recovery to existing generated guidance once, preserving user content", () => {
    const previous = WINDOWS_NODE_ACCESS_INSTRUCTIONS.replace(
      `${WINDOWS_NODE_PERMISSION_DENIED_INSTRUCTIONS}\n`,
      "",
    );
    const updated = updateWindowsNodeInstructions(
      `# My agent\n\n${previous}\n## Notes\nKeep these.\n`,
      legacy,
    );
    expect(updated).toContain(previous.trim());
    expect(updated).toContain("## Notes\nKeep these.");
    expect(updated).toContain(WINDOWS_NODE_PERMISSION_DENIED_INSTRUCTIONS.trim());
    expect(updated.match(/## Permission-denied recovery in MXC/g)).toHaveLength(1);
    expect(updateWindowsNodeInstructions(updated, legacy)).toBe(updated);
  });

  it("preserves customized permission recovery guidance", () => {
    const custom = "## Permission-denied recovery in MXC\n\nMy recovery rules.\n";
    const updated = updateWindowsNodeInstructions(custom, legacy);
    expect(updated).toContain(custom.trim());
    expect(updated.match(/## Permission-denied recovery in MXC/g)).toHaveLength(1);
    expect(updateWindowsNodeInstructions(updated, legacy)).toBe(updated);
  });

  it("routes ordinary file work by current tool availability instead of conversation history", () => {
    expect(WINDOWS_NODE_SHELL_INSTRUCTIONS).toMatch(/file tools remain available in both modes/);
    expect(WINDOWS_NODE_SHELL_INSTRUCTIONS).toMatch(
      /run outside MXC and bypass exec\s+consent and MXC folder grants/,
    );
    expect(WINDOWS_NODE_SHELL_INSTRUCTIONS).toMatch(
      /use contained exec when the user requests containment/,
    );
    expect(WINDOWS_NODE_SHELL_INSTRUCTIONS).toMatch(
      /Route by the tools available now, not by a previous mode or the last successful\s+action/,
    );
    expect(WINDOWS_NODE_SHELL_INSTRUCTIONS).toMatch(
      /Do not retry a denied or failed\s+native operation through exec/,
    );
  });

  it.each([false, true])("migrates generated transport (memory-aware: %s)", (memoryAware) => {
    let currentTransport = previousTransport.replace(
      "inline PowerShell generally require one-use approval; do not rewrite commands\n" +
        "to bypass this. MXC folder grants remain independent of command consent.",
      "quoted or dynamic PowerShell may require one-use approval. Never change an\n" +
        "approved command to bypass consent. MXC folder grants remain independent.",
    );
    if (memoryAware) {
      currentTransport = currentTransport.replace(
        "native file tools are unavailable; choose an exec command for file operations.",
        "native file tools are unavailable; use scoped memory tools for memory recall\n" +
          "and contained exec for other file operations.",
      );
    }
    const original = `# My agent\n\n${currentTransport}\n## My notes\nKeep these.\n`;
    const updated = updateWindowsNodeInstructions(original, legacy);
    expect(updated).toContain("## My notes\nKeep these.");
    expect(updated).toContain(WINDOWS_NODE_MEMORY_INSTRUCTIONS.trim());
    expect(updated).not.toContain("choose an exec command for file operations");
    expect(updated).toContain("file tools remain available in both modes");
    expect(updated).toContain("Route by the tools available now");
    expect(updated.match(/## Windows Node command transport/g)).toHaveLength(1);
    expect(updateWindowsNodeInstructions(updated, legacy)).toBe(updated);
  });

  it("migrates the last generated file-routing guidance and preserves user notes", () => {
    const previous = previousTransport
      .replace(
        "inline PowerShell generally require one-use approval; do not rewrite commands\n" +
          "to bypass this. MXC folder grants remain independent of command consent.",
        "quoted or dynamic PowerShell may require one-use approval. Never change an\n" +
          "approved command to bypass consent. MXC folder grants remain independent.",
      )
      .replace(
        "In MXC mode,\nnative file tools are unavailable; choose an exec command for file operations.",
        "For ordinary file reads, writes, and edits, prefer an appropriate native file tool\n" +
          "when it is available in the current turn. In MXC mode native file tools are\n" +
          "unavailable; use scoped memory tools for memory recall and contained exec\n" +
          "for other file operations. Choose exec for shell workflows or operations\n" +
          "without a suitable native tool. Route by the tools available now, not by a\n" +
          "previous mode or the last successful action. Do not retry a denied or failed\n" +
          "native operation through exec unless the user authorizes that fallback.",
      );
    const updated = updateWindowsNodeInstructions(`${previous}\n## Notes\nKeep these.\n`, legacy);
    expect(updated).toContain("## Notes\nKeep these.");
    expect(updated).toContain("file tools remain available in both modes");
    expect(updated).not.toContain("native file tools are\nunavailable");
    expect(updateWindowsNodeInstructions(updated, legacy)).toBe(updated);
  });

  it("preserves customized memory guidance rather than duplicating or overwriting it", () => {
    const source = "## Memory recall before filesystem tools\n\nMy memory privacy rules.\n";
    const updated = updateWindowsNodeInstructions(source, legacy);
    expect(updated).toContain(source.trim());
    expect(updated.match(/## Memory recall before filesystem tools/g)).toHaveLength(1);
    expect(updateWindowsNodeInstructions(updated, legacy)).toBe(updated);
  });
});
