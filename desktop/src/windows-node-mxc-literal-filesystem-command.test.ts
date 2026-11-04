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
  it.each(["ro", "rw"])(
    "classifies the observed nested read-only existence check with %s coverage",
    (access) => {
      const value = plan("Test-Path 'C:\\Approved\\a folder'");
      value.declaredAccess = [{ access, path: root }];
      expect(classifyLiteralFilesystemCommand(value)).toMatchObject({
        kind: "exists-path",
        path: "C:\\Approved\\a folder",
        force: false,
        recursive: false,
      });
    },
  );

  it.each(["", "-Path ", "-LiteralPath "])(
    "accepts only the literal Test-Path target form %s in direct and nested argv",
    (parameter) => {
      const script = `Test-Path ${parameter}'C:\\Approved\\a folder'`;
      const nested = plan(script);
      const direct = {
        ...nested,
        arguments: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      };
      for (const value of [direct, nested]) {
        expect(classifyLiteralFilesystemCommand(value)).toMatchObject({
          kind: "exists-path",
          path: "C:\\Approved\\a folder",
          force: false,
          recursive: false,
          content: null,
          encoding: null,
          noNewline: false,
        });
      }
    },
  );

  it.each([
    "Test-Path 'C:\\Approved\\a' -Force",
    "Test-Path 'C:\\Approved\\a' -Recurse",
    "Test-Path -Path 'C:\\Approved\\a' -LiteralPath 'C:\\Approved\\b'",
    "Test-Path -Path 'C:\\Approved\\a' -Path 'C:\\Approved\\b'",
    "Test-Path 'C:\\Approved\\a' 'C:\\Approved\\b'",
    "Test-Path -Path 'C:\\Approved\\a' -PathType Container",
    "Test-Path -Path 'C:\\Approved\\a' -IsValid",
    "Test-Path 'C:\\Approved\\*'",
    "Test-Path 'C:\\Approved\\a'; Remove-Item 'C:\\Approved\\a'",
    "Test-Path 'C:\\Approved\\a' | Out-String",
    "Test-Path (Join-Path 'C:\\Approved' 'a')",
    "Test-Path '$HOME\\a'",
    "Test-Path 'C:\\Approved\\..\\outside'",
    "Test-Path '\\\\server\\share\\a'",
    "Test-Path 'C:\\Approved\\a:stream'",
    "Test-Path 'C:\\Approved\\NUL.txt'",
  ])("rejects existence-check expansions or semantics outside the closed form: %s", (script) => {
    expect(classifyLiteralFilesystemCommand(plan(script))).toBeNull();
  });

  it("requires a covering declaration for read-only checks without relaxing mutating RO rejection", () => {
    const value = plan("Test-Path 'C:\\Approved\\a'");
    for (const declaredAccess of [
      [],
      [{ access: "ro", path: "C:\\Other" }],
      [{ access: "rw", path: "C:\\ApprovedElsewhere" }],
    ]) {
      expect(classifyLiteralFilesystemCommand({ ...value, declaredAccess })).toBeNull();
    }
    for (const script of [
      "Remove-Item -Path 'C:\\Approved\\a'",
      "Clear-Content -Path 'C:\\Approved\\a'",
      "Set-Content -Path 'C:\\Approved\\a' -Value '1'",
    ]) {
      expect(
        classifyLiteralFilesystemCommand({
          ...plan(script),
          declaredAccess: [{ access: "ro", path: root }],
        }),
      ).toBeNull();
    }
    for (const arguments_ of [
      ["-Command", "Test-Path 'C:\\Approved\\a'"],
      ["-NoProfile", "-File", "Test-Path.ps1"],
      ["-NoProfile", "-EncodedCommand", "dGVzdA=="],
      ["-NoProfile", "-Interactive", "-Command", "Test-Path 'C:\\Approved\\a'"],
      ["-NoProfile", "-Command", "Test-Path 'C:\\Approved\\a'", "extra"],
    ])
      expect(classifyLiteralFilesystemCommand({ ...value, arguments: arguments_ })).toBeNull();
  });

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
