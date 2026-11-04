import { describe, expect, it } from "vitest";
import {
  updateWindowsNodeInstructions,
  WINDOWS_NODE_ACCESS_INSTRUCTIONS,
  WINDOWS_NODE_MEMORY_INSTRUCTIONS,
  WINDOWS_NODE_MXC_POWERSHELL_DELETE_INSTRUCTIONS,
  WINDOWS_NODE_POWERSHELL_QUOTING_INSTRUCTIONS,
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
    expect(updated).toMatch(/native file tools\s+are\s+unavailable/);
    expect(updateWindowsNodeInstructions(updated, legacy)).toBe(updated);
  });

  it("upgrades the prior generated transport guidance without changing user notes", () => {
    const source = `${legacy}\n${previousTransport}\n## User notes\n\nPreserve my instructions.\n`;
    const updated = updateWindowsNodeInstructions(source, legacy);

    expect(updated).toContain("Preserve my instructions.");
    expect(updated).not.toContain("inline PowerShell generally");
    expect(updated).toContain(WINDOWS_NODE_POWERSHELL_QUOTING_INSTRUCTIONS.trim());
    expect(updated).toContain(WINDOWS_NODE_MXC_POWERSHELL_DELETE_INSTRUCTIONS.trim());
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

  it("guides agents to initialize their own MXC deletion script without broadening access", () => {
    expect(WINDOWS_NODE_MXC_POWERSHELL_DELETE_INSTRUCTIONS).toContain(
      "include a scoped filesystem-drive setup in\nyour own PowerShell script",
    );
    expect(WINDOWS_NODE_MXC_POWERSHELL_DELETE_INSTRUCTIONS).toContain("New-PSDrive");
    expect(WINDOWS_NODE_MXC_POWERSHELL_DELETE_INSTRUCTIONS).toContain("Remove-Item -LiteralPath");
    expect(WINDOWS_NODE_MXC_POWERSHELL_DELETE_INSTRUCTIONS).toContain("-ErrorAction Stop");
    expect(WINDOWS_NODE_MXC_POWERSHELL_DELETE_INSTRUCTIONS).toContain(
      "Do not broaden\nfolder grants or add recursive deletion",
    );
    expect(WINDOWS_NODE_MXC_POWERSHELL_DELETE_INSTRUCTIONS).toContain("one-use approval");
  });

  it("preserves customized deletion guidance and does not add a duplicate", () => {
    const source = "## PowerShell deletion in MXC\n\nMy custom deletion instructions.\n";
    const updated = updateWindowsNodeInstructions(source, legacy);

    expect(updated).toContain("My custom deletion instructions.");
    expect(updated).not.toContain(WINDOWS_NODE_MXC_POWERSHELL_DELETE_INSTRUCTIONS.trim());
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

  it("routes ordinary file work by current tool availability instead of conversation history", () => {
    expect(WINDOWS_NODE_SHELL_INSTRUCTIONS).toMatch(
      /prefer an appropriate native file tool\s+when it is available in the current turn/,
    );
    expect(WINDOWS_NODE_SHELL_INSTRUCTIONS).toMatch(
      /In MXC mode native file tools are\s+unavailable; use scoped memory tools/,
    );
    expect(WINDOWS_NODE_SHELL_INSTRUCTIONS).toMatch(/contained exec\s+for other file operations/);
    expect(WINDOWS_NODE_SHELL_INSTRUCTIONS).toMatch(
      /Route by the tools available now,\s+not by a\s+previous mode or the last successful action/,
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
    expect(updated).toContain("use scoped memory tools for memory recall");
    expect(updated).toContain("Route by the tools available now");
    expect(updated.match(/## Windows Node command transport/g)).toHaveLength(1);
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
