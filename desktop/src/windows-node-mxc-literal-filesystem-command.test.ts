import { describe, expect, it } from "vitest";
import { classifyLiteralFilesystemCommand } from "./windows-node-mxc-literal-filesystem-command";

const root = String.raw`C:\Approved`;
function plan(script: string) {
  return {
    executable: String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
    executablePath: String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
    arguments: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `powershell -NoProfile -Command "${script}"`,
    ],
    declaredAccess: [{ access: "rw", path: root }],
  };
}

describe("closed literal filesystem presentation grammar", () => {
  it.each([
    ["New-Item -ItemType Directory -Path 'C:\\Approved\\a folder' -Force", "create-directory"],
    ["New-Item -Path 'C:\\Approved\\a file.txt' -ItemType File -Force", "create-file"],
    [
      "Set-Content -LiteralPath 'C:\\Approved\\a file.txt' -Value '0' -Encoding utf8",
      "set-content",
    ],
    ["Add-Content -Path 'C:\\Approved\\a file.txt' -Value '1' -NoNewline", "append-content"],
    ["Clear-Content -LiteralPath 'C:\\Approved\\a file.txt' -Force", "clear-content"],
    ["Remove-Item -Path 'C:\\Approved\\a file.txt' -Force", "remove-path"],
    ["Remove-Item -LiteralPath 'C:\\Approved\\a folder' -Recurse -Force", "remove-path"],
    ["Set-Content -Path 'C:\\Approved\\a file.txt' -Value ''", "set-content"],
  ])("classifies the exact nested operation %s", (script, kind) => {
    expect(classifyLiteralFilesystemCommand(plan(script))).toMatchObject({ kind });
  });

  it.each([
    "New-Item -ItemType SymbolicLink -Path 'C:\\Approved\\a'",
    "New-Item -ItemType Directory -Path 'C:\\Approved\\a'; whoami",
    "New-Item -ItemType Directory -Path 'C:\\Approved\\a' | whoami",
    "New-Item -ItemType Directory -Path '$HOME\\a'",
    "New-Item -ItemType Directory -Path 'C:\\Approved\\a`nb'",
    "New-Item -ItemType Directory -Path 'C:\\Approved\\a' # comment",
    "New-Item -ItemType Directory -Path 'C:\\Approved\\a' -Unknown",
    "New-Item -ItemType Directory -Path 'C:\\Approved\\a' -Path 'C:\\Approved\\b'",
    "New-Item -ItemType Directory -Path 'C:\\Approved\\..\\outside'",
    "New-Item -ItemType Directory -Path 'C:\\ApprovedElsewhere\\a'",
    "New-Item -ItemType Directory -Path 'C:\\Approved\\NUL.txt'",
    "New-Item -ItemType Directory -Path 'C:\\Approved\\a:stream'",
    "New-Item -ItemType Directory -Path '\\\\server\\share\\a'",
    "Remove-Item -Path 'C:\\Approved\\*' -Recurse",
    "Remove-Item -Path 'C:\\Approved\\a' -LiteralPath 'C:\\Approved\\b'",
    "Remove-Item -Path 'C:\\Approved\\a' -Recurse -Recurse",
    "Set-Content -Path 'C:\\Approved\\a' -Value 'my private text'",
    "Add-Content -Path 'C:\\Approved\\a' -Value 'Bearer example'",
    "Set-Content -Path 'C:\\Approved\\a' -Value (Get-Content elsewhere)",
    "Set-Content -Path 'C:\\Approved\\a' -Value '1' -Encoding unknown",
    "powershell -NoProfile -Command 'powershell -NoProfile -Command whoami'",
  ])("keeps unclassified content, executable syntax, and unsafe paths local: %s", (script) => {
    expect(classifyLiteralFilesystemCommand(plan(script))).toBeNull();
  });

  it("requires explicit RW coverage and the exact interpreter argv shape", () => {
    const value = plan("Remove-Item -Path 'C:\\Approved\\a' -Recurse");
    expect(
      classifyLiteralFilesystemCommand({
        ...value,
        declaredAccess: [{ access: "ro", path: root }],
      }),
    ).toBeNull();
    expect(
      classifyLiteralFilesystemCommand({ ...value, arguments: [...value.arguments, "extra"] }),
    ).toBeNull();
    expect(
      classifyLiteralFilesystemCommand({ ...value, executablePath: String.raw`C:\Other\cmd.exe` }),
    ).toBeNull();
  });

  it("exposes all already-validated effects, including empty content, without rewriting them", () => {
    expect(
      classifyLiteralFilesystemCommand(
        plan(
          "Set-Content -LiteralPath 'C:\\Approved\\a.txt' -Value '' -Encoding Unicode -NoNewline -Force",
        ),
      ),
    ).toMatchObject({
      kind: "set-content",
      path: "C:\\Approved\\a.txt",
      force: true,
      recursive: false,
      content: "",
      encoding: "Unicode",
      noNewline: true,
    });
    expect(
      classifyLiteralFilesystemCommand(
        plan("Remove-Item -LiteralPath 'C:\\Approved\\a' -Recurse -Force"),
      ),
    ).toMatchObject({
      force: true,
      recursive: true,
      content: null,
      encoding: null,
      noNewline: false,
    });
  });
});
