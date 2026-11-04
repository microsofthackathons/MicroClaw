import { describe, expect, it } from "vitest";
import {
  updateWindowsNodeInstructions,
  WINDOWS_NODE_ACCESS_INSTRUCTIONS,
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
    expect(updated).toContain("native file tools are unavailable");
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
});
