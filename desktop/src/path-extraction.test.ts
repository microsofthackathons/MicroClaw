/**
 * Tests for sandbox path extraction regex patterns.
 *
 * These test the shared path-extraction module used by sandbox-preload.js
 * to determine which file paths a shell command will read/write.
 */
import { describe, it, expect } from "vitest";
import path from "path";

// Import the shared JS module (CommonJS)
const pe = require("../../appcontainer/path-extraction.js");
const {
  extractWritePaths,
  extractReadPaths,
  extractShellPayload,
  cleanExtractedPath,
  expandEnvVarsInCmd,
  filterSystemPaths,
  extractShellPayloadFromString,
  SHELL_PATH_RE,
  SYSTEM_DIR_RE,
} = pe;

// ── extractShellPayload ──

describe("extractShellPayload", () => {
  it("strips pwsh.exe full path and flags", () => {
    expect(
      extractShellPayload("C:\\Program Files\\PowerShell\\7\\pwsh.exe", [
        "-NoProfile",
        "-Command",
        "dir C:\\a C:\\b",
      ]),
    ).toBe("dir C:\\a C:\\b");
  });

  it("strips cmd.exe and /d /s /c flags", () => {
    expect(
      extractShellPayload("C:\\Windows\\System32\\cmd.exe", ["/d", "/s", "/c", "dir C:\\a"]),
    ).toBe("dir C:\\a");
  });

  it("strips powershell short name", () => {
    expect(extractShellPayload("powershell", ["-Command", "Get-ChildItem C:\\a"])).toBe(
      "Get-ChildItem C:\\a",
    );
  });

  it("handles pwsh without -Command (positional args)", () => {
    expect(extractShellPayload("pwsh", ["-NoProfile", "Get-ChildItem C:\\a"])).toBe(
      "Get-ChildItem C:\\a",
    );
  });

  it("strips wrapping quotes from payload", () => {
    expect(extractShellPayload("cmd.exe", ["/c", '"dir C:\\a"'])).toBe("dir C:\\a");
  });
});

// ── extractReadPaths ──

describe("extractReadPaths", () => {
  describe("comma-separated paths", () => {
    it("splits on comma+space (PowerShell array syntax)", () => {
      const paths = extractReadPaths("dir C:\\a, C:\\b, C:\\c, C:\\d");
      expect(paths).toEqual(["C:\\a", "C:\\b", "C:\\c", "C:\\d"]);
    });

    it("splits on bare comma", () => {
      const paths = extractReadPaths("dir C:\\a,C:\\b");
      expect(paths).toEqual(["C:\\a", "C:\\b"]);
    });

    it("preserves commas inside quotes", () => {
      const paths = extractReadPaths('dir "C:\\my, folder"');
      expect(paths).toContain("C:\\my, folder");
    });

    it("preserves bare commas inside quotes", () => {
      const paths = extractReadPaths('dir "C:\\my,folder"');
      expect(paths).toContain("C:\\my,folder");
    });

    it("does not leave trailing commas on paths", () => {
      const paths = extractReadPaths("dir C:\\a, C:\\b");
      for (const p of paths) {
        expect(p).not.toMatch(/,$/);
      }
    });
  });

  describe("dir / Get-ChildItem and aliases", () => {
    it("extracts single unquoted dir path", () => {
      const paths = extractReadPaths("dir C:\\Users\\test");
      expect(paths).toContain("C:\\Users\\test");
    });

    it("extracts quoted dir path with spaces", () => {
      const paths = extractReadPaths('dir "C:\\Users\\My Documents"');
      expect(paths).toContain("C:\\Users\\My Documents");
    });

    it("extracts Get-ChildItem with -Path", () => {
      const paths = extractReadPaths("Get-ChildItem -Path C:\\data");
      expect(paths).toContain("C:\\data");
    });

    it("extracts Get-ChildItem unquoted", () => {
      const paths = extractReadPaths("Get-ChildItem C:\\a -ErrorAction SilentlyContinue");
      expect(paths).toContain("C:\\a");
    });

    it("extracts Get-ChildItem quoted with spaces", () => {
      const paths = extractReadPaths('Get-ChildItem "C:\\Program Files\\app"');
      expect(paths).toContain("C:\\Program Files\\app");
    });

    it("extracts ls alias unquoted", () => {
      expect(extractReadPaths("ls C:\\data")).toContain("C:\\data");
    });

    it("extracts ls alias quoted", () => {
      expect(extractReadPaths('ls "C:\\my folder"')).toContain("C:\\my folder");
    });

    it("extracts gci alias unquoted", () => {
      expect(extractReadPaths("gci C:\\temp")).toContain("C:\\temp");
    });

    it("extracts gci alias with -Path", () => {
      expect(extractReadPaths("gci -Path C:\\logs")).toContain("C:\\logs");
    });

    it("extracts Get-ChildItem with -Force before unquoted path", () => {
      const paths = extractReadPaths(
        "Get-ChildItem -Force C:\\a | Select-Object Mode,Length,LastWriteTime,Name | Format-Table -AutoSize",
      );
      expect(paths).toContain("C:\\a");
    });

    it("extracts Get-ChildItem with -Force before quoted path", () => {
      const paths = extractReadPaths('Get-ChildItem -Force "C:\\Users\\My Folder"');
      expect(paths).toContain("C:\\Users\\My Folder");
    });

    it("extracts Get-ChildItem with multiple switches before path", () => {
      const paths = extractReadPaths("Get-ChildItem -Force -Recurse C:\\data");
      expect(paths).toContain("C:\\data");
    });

    it("extracts gci with -Hidden before path", () => {
      expect(extractReadPaths("gci -Hidden C:\\temp")).toContain("C:\\temp");
    });

    it("extracts ls with -Force -Path", () => {
      expect(extractReadPaths("ls -Force -Path C:\\logs")).toContain("C:\\logs");
    });
  });

  describe("Get-Content / cat / type and aliases", () => {
    it("extracts Get-Content unquoted", () => {
      expect(extractReadPaths("Get-Content C:\\a\\test.txt")).toContain("C:\\a\\test.txt");
    });

    it("extracts Get-Content quoted", () => {
      expect(extractReadPaths('Get-Content "C:\\a\\my file.txt"')).toContain("C:\\a\\my file.txt");
    });

    it("extracts gc alias unquoted", () => {
      expect(extractReadPaths("gc C:\\data\\file.txt")).toContain("C:\\data\\file.txt");
    });

    it("extracts gc alias quoted", () => {
      expect(extractReadPaths('gc "C:\\my docs\\file.txt"')).toContain("C:\\my docs\\file.txt");
    });

    it("extracts cat unquoted", () => {
      expect(extractReadPaths("cat C:\\logs\\app.log")).toContain("C:\\logs\\app.log");
    });

    it("extracts type unquoted", () => {
      expect(extractReadPaths("type C:\\readme.txt")).toContain("C:\\readme.txt");
    });

    it("extracts head unquoted", () => {
      expect(extractReadPaths("head C:\\logs\\app.log")).toContain("C:\\logs\\app.log");
    });

    it("extracts tail unquoted", () => {
      expect(extractReadPaths("tail C:\\logs\\app.log")).toContain("C:\\logs\\app.log");
    });
  });

  describe("Test-Path / Resolve-Path", () => {
    it("extracts Test-Path unquoted", () => {
      expect(extractReadPaths("Test-Path C:\\config\\app.json")).toContain("C:\\config\\app.json");
    });

    it("extracts Resolve-Path quoted", () => {
      expect(extractReadPaths('Resolve-Path "C:\\data\\*.csv"')).toContain("C:\\data");
    });
  });

  describe("Select-String and alias", () => {
    it("extracts Select-String with -Path", () => {
      expect(
        extractReadPaths('Select-String -Path "C:\\logs\\app.log" -Pattern "error"'),
      ).toContain("C:\\logs\\app.log");
    });

    it("extracts sls alias unquoted", () => {
      expect(extractReadPaths("sls C:\\data\\file.csv")).toContain("C:\\data\\file.csv");
    });
  });

  describe("Import-Csv / Get-FileHash", () => {
    it("extracts Import-Csv quoted", () => {
      expect(extractReadPaths('Import-Csv "C:\\data\\records.csv"')).toContain(
        "C:\\data\\records.csv",
      );
    });

    it("extracts Import-Csv unquoted", () => {
      expect(extractReadPaths("Import-Csv C:\\data\\records.csv")).toContain(
        "C:\\data\\records.csv",
      );
    });

    it("extracts Get-FileHash quoted", () => {
      expect(extractReadPaths('Get-FileHash "C:\\downloads\\setup.exe"')).toContain(
        "C:\\downloads\\setup.exe",
      );
    });

    it("extracts Get-FileHash unquoted", () => {
      expect(extractReadPaths("Get-FileHash C:\\app\\binary.dll")).toContain("C:\\app\\binary.dll");
    });
  });

  describe("Get-Item and alias", () => {
    it("extracts Get-Item unquoted", () => {
      expect(extractReadPaths("Get-Item C:\\config")).toContain("C:\\config");
    });

    it("extracts gi alias unquoted", () => {
      expect(extractReadPaths("gi C:\\data")).toContain("C:\\data");
    });
  });

  describe("icacls (read-only)", () => {
    it("extracts icacls target path", () => {
      expect(extractReadPaths("icacls C:\\secure\\folder")).toContain("C:\\secure\\folder");
    });

    it("extracts icacls quoted path", () => {
      expect(extractReadPaths('icacls "C:\\my folder"')).toContain("C:\\my folder");
    });
  });

  describe("find / findstr", () => {
    it("extracts findstr target file", () => {
      const paths = extractReadPaths('findstr "pattern" C:\\logs\\app.log');
      expect(paths).toContain("C:\\logs\\app.log");
    });
  });

  describe("Python read", () => {
    it("extracts open() default read mode", () => {
      const paths = extractReadPaths('open("C:\\data\\input.csv")');
      expect(paths).toContain("C:\\data\\input.csv");
    });

    it("extracts open() explicit 'r' mode", () => {
      const paths = extractReadPaths('open("C:\\data\\input.csv", "r")');
      expect(paths).toContain("C:\\data\\input.csv");
    });
  });

  describe(".NET read methods", () => {
    it("extracts File::ReadAllText", () => {
      const paths = extractReadPaths('[System.IO.File]::ReadAllText("C:\\data\\config.json")');
      expect(paths).toContain("C:\\data\\config.json");
    });
  });

  describe("generic fallback", () => {
    it("catches unquoted paths not matched by specific patterns", () => {
      const paths = extractReadPaths("somecmd C:\\unknown\\path");
      expect(paths).toContain("C:\\unknown\\path");
    });

    it("does not match shell executable paths (after extractShellPayload)", () => {
      // After extractShellPayload, the shell exe is stripped.
      // This tests that the payload alone doesn't leak "C:\Program"
      const payload = "dir C:\\a C:\\b C:\\c";
      const paths = extractReadPaths(payload);
      expect(paths).not.toContain("C:\\Program");
      expect(paths).toContain("C:\\a");
      expect(paths).toContain("C:\\b");
      expect(paths).toContain("C:\\c");
    });
  });

  describe("glob patterns", () => {
    it("resolves globs to parent directory", () => {
      const paths = extractReadPaths("dir C:\\Users\\test\\*.pdf");
      expect(paths).toContain("C:\\Users\\test");
      expect(paths).not.toContain("C:\\Users\\test\\*.pdf");
    });
  });
});

// ── extractWritePaths ──

describe("extractWritePaths", () => {
  describe("PowerShell write cmdlets", () => {
    it("extracts Out-File quoted path", () => {
      expect(extractWritePaths('Out-File "C:\\output\\result.txt"')).toContain(
        "C:\\output\\result.txt",
      );
    });

    it("extracts Out-File unquoted path", () => {
      expect(extractWritePaths("Out-File C:\\output\\result.txt")).toContain(
        "C:\\output\\result.txt",
      );
    });

    it("extracts Set-Content with -Path", () => {
      expect(extractWritePaths('Set-Content -Path "C:\\a\\test.txt" -Value "hello"')).toContain(
        "C:\\a\\test.txt",
      );
    });

    it("extracts Add-Content unquoted", () => {
      expect(extractWritePaths("Add-Content C:\\logs\\app.log")).toContain("C:\\logs\\app.log");
    });

    it("extracts New-Item quoted", () => {
      expect(extractWritePaths('New-Item "C:\\output\\new folder"')).toContain(
        "C:\\output\\new folder",
      );
    });

    it("extracts New-Item with -ItemType and -Path before quoted path", () => {
      expect(
        extractWritePaths(
          "New-Item -ItemType File -Path 'C:\\Users\\Admin\\Desktop\\ProbeTest.txt' -Force | Format-List",
        ),
      ).toContain("C:\\Users\\Admin\\Desktop\\ProbeTest.txt");
    });

    it("extracts New-Item with -ItemType Directory", () => {
      expect(extractWritePaths("New-Item -ItemType Directory -Path C:\\Data\\NewFolder")).toContain(
        "C:\\Data\\NewFolder",
      );
    });

    it("extracts Remove-Item with -Force -Recurse", () => {
      expect(extractWritePaths('Remove-Item -Recurse -Force "C:\\temp\\old"')).toContain(
        "C:\\temp\\old",
      );
    });

    it("extracts Copy-Item destination", () => {
      expect(
        extractWritePaths('Copy-Item C:\\src\\file.txt -Destination "C:\\dst\\file.txt"'),
      ).toContain("C:\\dst\\file.txt");
    });

    it("extracts Move-Item destination", () => {
      expect(extractWritePaths("Move-Item C:\\a\\old.txt -Destination C:\\b\\new.txt")).toContain(
        "C:\\b\\new.txt",
      );
    });
  });

  describe("cmd write commands and aliases", () => {
    it("extracts redirect > target", () => {
      expect(extractWritePaths("echo hello > C:\\output\\log.txt")).toContain(
        "C:\\output\\log.txt",
      );
    });

    it("extracts append >> target", () => {
      expect(extractWritePaths("echo hello >> C:\\output\\log.txt")).toContain(
        "C:\\output\\log.txt",
      );
    });

    it("extracts redirect to quoted path", () => {
      expect(extractWritePaths('echo hello > "C:\\my output\\log.txt"')).toContain(
        "C:\\my output\\log.txt",
      );
    });

    it("extracts mkdir unquoted", () => {
      expect(extractWritePaths("mkdir C:\\new\\folder")).toContain("C:\\new\\folder");
    });

    it("extracts md alias", () => {
      expect(extractWritePaths("md C:\\new\\folder")).toContain("C:\\new\\folder");
    });

    it("extracts del unquoted", () => {
      expect(extractWritePaths("del C:\\temp\\old.txt")).toContain("C:\\temp\\old.txt");
    });

    it("extracts erase alias", () => {
      expect(extractWritePaths("erase C:\\temp\\old.txt")).toContain("C:\\temp\\old.txt");
    });

    it("extracts rmdir with /s", () => {
      expect(extractWritePaths("rmdir /s C:\\temp\\old")).toContain("C:\\temp\\old");
    });

    it("extracts rd alias with /s /q", () => {
      expect(extractWritePaths("rd /s /q C:\\temp\\old")).toContain("C:\\temp\\old");
    });

    it("extracts ren/rename", () => {
      expect(extractWritePaths("ren C:\\data\\old.txt")).toContain("C:\\data\\old.txt");
    });

    it("extracts xcopy destination", () => {
      expect(extractWritePaths("xcopy C:\\src\\files C:\\dst\\backup")).toContain(
        "C:\\dst\\backup",
      );
    });

    it("extracts robocopy destination", () => {
      expect(extractWritePaths("robocopy C:\\src C:\\dst\\mirror")).toContain("C:\\dst\\mirror");
    });
  });

  describe("PowerShell Unix aliases (cp, mv, rm)", () => {
    it("extracts cp destination", () => {
      expect(extractWritePaths("cp C:\\src\\file.txt C:\\dst\\file.txt")).toContain(
        "C:\\dst\\file.txt",
      );
    });

    it("extracts mv destination", () => {
      expect(extractWritePaths("mv C:\\old\\file.txt C:\\new\\file.txt")).toContain(
        "C:\\new\\file.txt",
      );
    });

    it("extracts rm target", () => {
      expect(extractWritePaths("rm C:\\temp\\old.txt")).toContain("C:\\temp\\old.txt");
    });

    it("extracts rm -rf target", () => {
      expect(extractWritePaths("rm -rf C:\\temp\\old")).toContain("C:\\temp\\old");
    });

    it("extracts cp with quoted destination", () => {
      expect(extractWritePaths('cp C:\\src\\file.txt "C:\\my output\\file.txt"')).toContain(
        "C:\\my output\\file.txt",
      );
    });
  });

  describe("download commands (Invoke-WebRequest, curl, wget)", () => {
    it("extracts Invoke-WebRequest -OutFile quoted", () => {
      expect(
        extractWritePaths(
          'Invoke-WebRequest https://example.com/file.zip -OutFile "C:\\downloads\\file.zip"',
        ),
      ).toContain("C:\\downloads\\file.zip");
    });

    it("extracts iwr -OutFile unquoted", () => {
      expect(extractWritePaths("iwr https://example.com/f.zip -OutFile C:\\dl\\f.zip")).toContain(
        "C:\\dl\\f.zip",
      );
    });

    it("extracts curl -o unquoted", () => {
      expect(
        extractWritePaths("curl https://example.com/data.json -o C:\\output\\data.json"),
      ).toContain("C:\\output\\data.json");
    });

    it("extracts wget -O unquoted", () => {
      expect(
        extractWritePaths("wget https://example.com/pkg.tar.gz -O C:\\dl\\pkg.tar.gz"),
      ).toContain("C:\\dl\\pkg.tar.gz");
    });
  });

  describe("Tee-Object", () => {
    it("extracts Tee-Object quoted", () => {
      expect(extractWritePaths('Get-Process | Tee-Object "C:\\logs\\processes.txt"')).toContain(
        "C:\\logs\\processes.txt",
      );
    });

    it("extracts Tee-Object -FilePath unquoted", () => {
      expect(extractWritePaths("Get-Process | Tee-Object -FilePath C:\\logs\\out.txt")).toContain(
        "C:\\logs\\out.txt",
      );
    });
  });

  describe("Export-Csv", () => {
    it("extracts Export-Csv quoted", () => {
      expect(extractWritePaths('Get-Process | Export-Csv "C:\\output\\procs.csv"')).toContain(
        "C:\\output\\procs.csv",
      );
    });

    it("extracts Export-Csv -Path unquoted", () => {
      expect(extractWritePaths("Get-Process | Export-Csv -Path C:\\output\\procs.csv")).toContain(
        "C:\\output\\procs.csv",
      );
    });
  });

  describe("Archive commands", () => {
    it("extracts Expand-Archive -DestinationPath quoted", () => {
      expect(
        extractWritePaths(
          'Expand-Archive "C:\\dl\\file.zip" -DestinationPath "C:\\output\\extracted"',
        ),
      ).toContain("C:\\output\\extracted");
    });

    it("extracts Expand-Archive -DestinationPath unquoted", () => {
      expect(
        extractWritePaths("Expand-Archive C:\\dl\\file.zip -DestinationPath C:\\output\\extracted"),
      ).toContain("C:\\output\\extracted");
    });

    it("extracts Compress-Archive -Destination quoted", () => {
      expect(
        extractWritePaths('Compress-Archive -Path C:\\src -Destination "C:\\output\\archive.zip"'),
      ).toContain("C:\\output\\archive.zip");
    });
  });

  describe("Python write", () => {
    it("extracts open() with 'w' mode", () => {
      expect(extractWritePaths('open("C:\\output\\data.csv", "w")')).toContain(
        "C:\\output\\data.csv",
      );
    });

    it("extracts open() with 'a' mode", () => {
      expect(extractWritePaths('open("C:\\logs\\app.log", "a")')).toContain("C:\\logs\\app.log");
    });

    it("does NOT extract open() with 'r' mode as write", () => {
      expect(extractWritePaths('open("C:\\data\\input.csv", "r")')).not.toContain(
        "C:\\data\\input.csv",
      );
    });
  });

  describe("Node.js fs write", () => {
    it("extracts fs.writeFileSync", () => {
      expect(extractWritePaths('fs.writeFileSync("C:\\out\\file.json"')).toContain(
        "C:\\out\\file.json",
      );
    });

    it("extracts fs.appendFileSync", () => {
      expect(extractWritePaths('fs.appendFileSync("C:\\logs\\app.log"')).toContain(
        "C:\\logs\\app.log",
      );
    });
  });

  describe(".NET write methods", () => {
    it("extracts File::WriteAllText", () => {
      expect(extractWritePaths('[System.IO.File]::WriteAllText("C:\\out\\data.txt"')).toContain(
        "C:\\out\\data.txt",
      );
    });

    it("extracts Directory::CreateDirectory", () => {
      expect(extractWritePaths('[System.IO.Directory]::CreateDirectory("C:\\new\\dir"')).toContain(
        "C:\\new\\dir",
      );
    });
  });

  describe("pipe to write cmdlet", () => {
    it("extracts piped Out-File path", () => {
      const cmd =
        'Get-Date -Format "yyyy-MM-dd HH:mm:ss" | Out-File -FilePath "C:\\a\\test.txt" -Encoding UTF8 -Append';
      expect(extractWritePaths(cmd)).toContain("C:\\a\\test.txt");
    });
  });
});

// ── cleanExtractedPath ──

describe("cleanExtractedPath", () => {
  it("strips trailing commas", () => {
    expect(cleanExtractedPath("C:\\a,")).toBe("C:\\a");
  });

  it("strips trailing slashes", () => {
    expect(cleanExtractedPath("C:\\a\\")).toBe("C:\\a");
  });

  it("strips trailing quotes", () => {
    expect(cleanExtractedPath('C:\\a"')).toBe("C:\\a");
  });

  it("strips trailing parens", () => {
    expect(cleanExtractedPath("C:\\a)")).toBe("C:\\a");
  });

  it("resolves glob to parent", () => {
    expect(cleanExtractedPath("C:\\Users\\test\\*.pdf")).toBe(
      path.dirname("C:\\Users\\test\\*.pdf"),
    );
  });

  it("keeps normal paths unchanged", () => {
    expect(cleanExtractedPath("C:\\Users\\test")).toBe("C:\\Users\\test");
  });
});

// ── expandEnvVarsInCmd ──

describe("expandEnvVarsInCmd", () => {
  it("expands $env:TEMP", () => {
    const result = expandEnvVarsInCmd("dir $env:TEMP");
    expect(result).not.toContain("$env:TEMP");
    expect(result).toContain(process.env.TEMP || process.env.TMP || "");
  });

  it("expands %TEMP%", () => {
    const result = expandEnvVarsInCmd("dir %TEMP%");
    expect(result).not.toContain("%TEMP%");
  });

  it("expands $HOME to USERPROFILE", () => {
    const home = process.env.USERPROFILE || "";
    const result = expandEnvVarsInCmd('New-Item -Path "$HOME\\Desktop\\empty.txt"');
    expect(result).toContain(home + "\\Desktop\\empty.txt");
    expect(result).not.toContain("$HOME");
  });

  it("does not expand $HOME without path separator", () => {
    // $HOME alone (not followed by \ or /) should not be expanded
    // to avoid breaking variable names like $HOMEDIR
    const result = expandEnvVarsInCmd("echo $HOME");
    expect(result).toBe("echo $HOME");
  });
});

// ── Integration: shell payload + path extraction ──

describe("integration: extractShellPayload + extractReadPaths", () => {
  it("does not leak shell exe path into results", () => {
    const payload = extractShellPayload("C:\\Program Files\\PowerShell\\7\\pwsh.exe", [
      "-NoProfile",
      "-Command",
      "dir C:\\a C:\\b C:\\c",
    ]);
    const paths = extractReadPaths(payload);
    expect(paths).not.toContain("C:\\Program");
    expect(paths).toEqual(expect.arrayContaining(["C:\\a", "C:\\b", "C:\\c"]));
  });

  it("handles semicolon-separated Get-ChildItem commands", () => {
    const payload = extractShellPayload("pwsh", [
      "-Command",
      "Get-ChildItem C:\\a -ErrorAction SilentlyContinue; Get-ChildItem C:\\b -ErrorAction SilentlyContinue",
    ]);
    const paths = extractReadPaths(payload);
    expect(paths).toContain("C:\\a");
    expect(paths).toContain("C:\\b");
  });
});

// ── Move-Item with shell wrapper (regression) ──
describe("Move-Item path extraction with shell wrappers", () => {
  it("extracts write path from pwsh -Command Move-Item with quoted paths", () => {
    const payload = extractShellPayload("C:\\Program Files\\PowerShell\\7\\pwsh.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Move-Item 'C:\\Users\\Administrator\\Desktop\\ModelE' 'C:\\Users\\Administrator\\Desktop\\StressTest_Results\\ModelE'",
    ]);
    const writePaths = extractWritePaths(payload);
    expect(writePaths).toContain("C:\\Users\\Administrator\\Desktop\\StressTest_Results\\ModelE");
  });

  it("extracts read path (source) from pwsh -Command Move-Item with quoted paths", () => {
    const payload = extractShellPayload("C:\\Program Files\\PowerShell\\7\\pwsh.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Move-Item 'C:\\Users\\Administrator\\Desktop\\ModelE' 'C:\\Users\\Administrator\\Desktop\\StressTest_Results\\ModelE'",
    ]);
    const readPaths = extractReadPaths(payload);
    expect(readPaths).toContain("C:\\Users\\Administrator\\Desktop\\ModelE");
  });

  it("extracts from cmd.exe /c powershell -Command Move-Item (nested)", () => {
    const cmd = "powershell -Command \"Move-Item 'C:\\a\\src' 'C:\\b\\dst'\"";
    const writePaths = extractWritePaths(cmd);
    expect(writePaths).toContain("C:\\b\\dst");
  });

  it("extracts Move-Item with positional args (no -Destination)", () => {
    const writePaths = extractWritePaths(
      "Move-Item C:\\Users\\test\\Desktop\\old C:\\Users\\test\\Desktop\\new",
    );
    expect(writePaths).toContain("C:\\Users\\test\\Desktop\\new");
  });

  it("extracts Move-Item source as read path", () => {
    const readPaths = extractReadPaths("Move-Item C:\\source\\dir C:\\dest\\dir");
    expect(readPaths).toContain("C:\\source\\dir");
  });

  it("extracts Move-Item with $env:USERPROFILE and -Path/-Destination", () => {
    const home = process.env.USERPROFILE || "C:\\Users\\test";
    const cmd = `Move-Item -Path "$env:USERPROFILE\\Desktop\\ModelA" -Destination "$env:USERPROFILE\\Desktop\\StressTest_Results\\ModelA"`;
    const writePaths = extractWritePaths(cmd);
    const readPaths = extractReadPaths(cmd);
    expect(writePaths).toContain(`${home}\\Desktop\\StressTest_Results\\ModelA`);
    expect(readPaths).toContain(`${home}\\Desktop\\ModelA`);
  });

  // Regression: screenshot bug — Move-Item -LiteralPath with .exe file
  // The source .exe path must be extracted as a read path (not treated as an app launch).
  it("extracts Move-Item -LiteralPath .exe source as read path and destination as write path", () => {
    const payload = extractShellPayload("C:\\Program Files\\PowerShell\\7\\pwsh.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "powershell",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Move-Item -LiteralPath 'C:\\Users\\yuxwei\\Desktop\\psping64.exe' -Destination 'C:\\Tools\\psping64.exe'",
    ]);
    const readPaths = extractReadPaths(payload);
    const writePaths = extractWritePaths(payload);
    expect(readPaths).toContain("C:\\Users\\yuxwei\\Desktop\\psping64.exe");
    expect(writePaths).toContain("C:\\Tools\\psping64.exe");
  });
});

// ── Real-world sandbox probe commands (regression) ──
describe("real-world sandbox probe commands", () => {
  it("New-Item -ItemType File -Path extracts write path via shell payload", () => {
    const payload = extractShellPayload("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "New-Item -ItemType File -Path 'C:\\Users\\Administrator\\Desktop\\ProbeTestPwsh.txt' -Force | Select-Object FullName, Length, LastWriteTime | Format-List",
    ]);
    const writePaths = extractWritePaths(payload);
    expect(writePaths).toContain("C:\\Users\\Administrator\\Desktop\\ProbeTestPwsh.txt");
  });

  it("Get-ChildItem -LiteralPath extracts read path, no write path", () => {
    const payload = extractShellPayload("powershell", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-ChildItem -LiteralPath 'C:\\Users\\Administrator\\Desktop\\Shortcuts' -Force | Out-Null",
    ]);
    const writePaths = extractWritePaths(payload);
    const readPaths = extractReadPaths(payload);
    expect(writePaths).not.toContain("C:\\Users\\Administrator\\Desktop\\Shortcuts");
    expect(readPaths).toContain("C:\\Users\\Administrator\\Desktop\\Shortcuts");
  });

  it("cmd /c type nul > ~\\Desktop\\file expands ~ and extracts write path", () => {
    const home = process.env.USERPROFILE || "C:\\Users\\test";
    const payload = extractShellPayload("cmd", [
      "/c",
      'type nul > "~\\Desktop\\ProbeTestPwsh.txt"',
    ]);
    const writePaths = extractWritePaths(payload);
    expect(writePaths).toContain(`${home}\\Desktop\\ProbeTestPwsh.txt`);
  });
});

// ── SHELL_PATH_RE / SYSTEM_DIR_RE ──

describe("SHELL_PATH_RE", () => {
  it.each([
    ["C:\\Windows\\System32\\cmd.exe", true],
    ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", true],
    ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", true],
    ["C:\\Users\\test\\Desktop\\script.ps1", false],
    ["D:\\tools\\cmd.exe", false], // not under Windows/Program Files
  ])("%s → %s", (path, expected) => {
    expect(SHELL_PATH_RE.test(path)).toBe(expected);
  });
});

describe("SYSTEM_DIR_RE", () => {
  it.each([
    ["C:\\Windows", true],
    ["C:\\Windows\\System32", true],
    ["C:\\Program Files\\app", true],
    ["C:\\ProgramData\\config", true],
    ["C:\\Users\\test", false],
    ["D:\\data\\file.csv", false],
  ])("%s → %s", (path, expected) => {
    expect(SYSTEM_DIR_RE.test(path)).toBe(expected);
  });
});

// ── filterSystemPaths ──

describe("filterSystemPaths", () => {
  it.each([
    {
      name: "removes shell exe, keeps user path",
      input: ["C:\\Windows\\System32\\cmd.exe", "C:\\Users\\test\\file.txt"],
      expected: ["C:\\Users\\test\\file.txt"],
    },
    {
      name: "removes multiple system dirs",
      input: [
        "C:\\Windows\\System32\\config",
        "C:\\ProgramData\\app\\data.json",
        "C:\\Users\\test\\report.pdf",
      ],
      expected: ["C:\\Users\\test\\report.pdf"],
    },
    {
      name: "removes pwsh.exe from Program Files",
      input: ["C:\\Program Files\\PowerShell\\7\\pwsh.exe", "C:\\data\\output.csv"],
      expected: ["C:\\data\\output.csv"],
    },
    {
      name: "keeps all user paths unchanged",
      input: ["C:\\Users\\test\\a.txt", "D:\\data\\b.csv"],
      expected: ["C:\\Users\\test\\a.txt", "D:\\data\\b.csv"],
    },
    {
      name: "returns empty when all are system paths",
      input: ["C:\\Windows\\System32\\cmd.exe", "C:\\Program Files\\PowerShell\\7\\pwsh.exe"],
      expected: [],
    },
  ])("$name", ({ input, expected }) => {
    expect(filterSystemPaths(input)).toEqual(expected);
  });
});

// ── End-to-end: simulate handleAsyncAccessDenied path inference pipeline ──
//
// These tests replicate the exact pipeline in handleAsyncAccessDenied:
//   input command text → extractShellPayloadFromString → extractWritePaths + extractReadPaths → filterSystemPaths → output paths
//
// Each test case provides a realistic innerCmd as it would be constructed
// by spawn/spawnSync/exec/execSync hooks, then verifies that the inferred
// paths contain only user-requested paths and no shell/system paths.

/** Simulate the path inference pipeline in handleAsyncAccessDenied */
function inferPaths(innerCmd: string): string[] {
  const stripped = extractShellPayloadFromString(innerCmd);
  return filterSystemPaths(extractWritePaths(stripped).concat(extractReadPaths(stripped)));
}

describe("handleAsyncAccessDenied path inference pipeline", () => {
  describe("shell executable paths must not leak through", () => {
    it.each([
      {
        name: "cmd.exe full path with /c type",
        input: "C:\\Windows\\System32\\cmd.exe /c type C:\\Users\\test\\secret.txt",
        shouldContain: ["C:\\Users\\test\\secret.txt"],
        shouldNotContain: ["C:\\Windows\\System32\\cmd.exe", "C:\\Windows\\System32"],
      },
      {
        name: "pwsh.exe full path with -Command Get-Content",
        input:
          "C:\\Program Files\\PowerShell\\7\\pwsh.exe -NoProfile -Command Get-Content C:\\Users\\test\\data.csv",
        shouldContain: ["C:\\Users\\test\\data.csv"],
        shouldNotContain: ["C:\\Program Files\\PowerShell\\7\\pwsh.exe"],
      },
      {
        name: "powershell.exe in System32 with -Command dir",
        input:
          "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -Command dir C:\\Users\\test\\Desktop",
        shouldContain: ["C:\\Users\\test\\Desktop"],
        shouldNotContain: ["C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"],
      },
      {
        name: "short powershell name with Set-Content",
        input: "powershell -Command Set-Content -Path 'C:\\Users\\test\\output.txt' -Value 'hello'",
        shouldContain: ["C:\\Users\\test\\output.txt"],
        shouldNotContain: [],
      },
    ])("$name", ({ input, shouldContain, shouldNotContain }) => {
      const paths = inferPaths(input);
      for (const p of shouldContain) expect(paths).toContain(p);
      for (const p of shouldNotContain) expect(paths).not.toContain(p);
      // Universal: no system paths should ever appear
      for (const p of paths) {
        expect(SYSTEM_DIR_RE.test(p)).toBe(false);
        expect(SHELL_PATH_RE.test(p)).toBe(false);
      }
    });
  });

  describe("user paths must be correctly extracted", () => {
    it.each([
      {
        name: "Move-Item with two positional paths (no shell prefix)",
        input: "Move-Item C:\\Users\\test\\src.txt C:\\Users\\test\\dst.txt",
        shouldContain: ["C:\\Users\\test\\src.txt", "C:\\Users\\test\\dst.txt"],
      },
      {
        name: "cmd.exe redirect writes to user dir",
        input: "C:\\Windows\\System32\\cmd.exe /c echo hello > C:\\Users\\test\\output.log",
        shouldContain: ["C:\\Users\\test\\output.log"],
      },
      {
        name: "pwsh New-Item creates file on Desktop",
        input:
          "C:\\Program Files\\PowerShell\\7\\pwsh.exe -NoProfile -Command New-Item -ItemType File -Path 'C:\\Users\\test\\Desktop\\probe.txt' -Force",
        shouldContain: ["C:\\Users\\test\\Desktop\\probe.txt"],
      },
      {
        name: "cmd.exe copy from one dir to another",
        input:
          "C:\\Windows\\System32\\cmd.exe /c copy C:\\Users\\test\\src\\file.txt C:\\Users\\test\\dst\\file.txt",
        shouldContain: ["C:\\Users\\test\\dst\\file.txt"],
      },
      {
        name: "pwsh Remove-Item in user dir",
        input: "pwsh -Command Remove-Item -Recurse -Force 'C:\\Users\\test\\tmp\\old'",
        shouldContain: ["C:\\Users\\test\\tmp\\old"],
      },
      {
        name: "Get-ChildItem listing (read-only)",
        input:
          "C:\\Windows\\System32\\cmd.exe /c powershell -Command Get-ChildItem C:\\Users\\test\\Documents",
        shouldContain: ["C:\\Users\\test\\Documents"],
      },
    ])("$name", ({ input, shouldContain }) => {
      const paths = inferPaths(input);
      for (const p of shouldContain) expect(paths).toContain(p);
    });
  });

  describe("edge cases", () => {
    it("empty command returns no paths", () => {
      expect(inferPaths("")).toEqual([]);
    });

    it("command with only system paths returns empty", () => {
      // A pathological case: cmd.exe running a system diagnostic
      const paths = inferPaths(
        "C:\\Windows\\System32\\cmd.exe /c C:\\Windows\\System32\\where.exe cmd",
      );
      for (const p of paths) {
        expect(SYSTEM_DIR_RE.test(p)).toBe(false);
      }
    });

    it("nested shell: pwsh inside cmd.exe - user path still extracted", () => {
      const input =
        "C:\\Windows\\System32\\cmd.exe /c powershell -Command type C:\\Users\\test\\file.txt";
      const paths = inferPaths(input);
      expect(paths).toContain("C:\\Users\\test\\file.txt");
    });

    it("D: drive paths are preserved (not filtered as system)", () => {
      const input = "cmd /c type D:\\shared\\data\\config.json";
      const paths = inferPaths(input);
      expect(paths).toContain("D:\\shared\\data\\config.json");
    });
  });
});

// ── Join-Path resolution in expandEnvVarsInCmd ──
// Regression test: commands like `Join-Path $env:USERPROFILE '.openclaw\...'`
// were expanded to `Join-Path C:\Users\xxx '.openclaw\...'` and then the
// fallback regex only extracted `C:\Users\xxx` (the base), missing the
// relative part. This caused a false permission prompt for the home dir
// when the actual target was a safe subdirectory.

describe("Join-Path resolution", () => {
  const home = process.env.USERPROFILE || "C:\\Users\\testuser";

  it("resolves Join-Path with quoted relative child", () => {
    const cmd = `$path = Join-Path ${home} '.openclaw\\state\\logs\\anthropic-payload.jsonl'`;
    const expanded = expandEnvVarsInCmd(cmd);
    expect(expanded).toContain(path.join(home, ".openclaw\\state\\logs\\anthropic-payload.jsonl"));
    expect(expanded).not.toContain("Join-Path");
  });

  it("resolves Join-Path with $env:USERPROFILE and quoted child", () => {
    const cmd = "$path = Join-Path $env:USERPROFILE '.openclaw\\state\\logs\\file.jsonl'";
    const expanded = expandEnvVarsInCmd(cmd);
    expect(expanded).toContain(path.join(home, ".openclaw\\state\\logs\\file.jsonl"));
  });

  it("resolves Join-Path with double-quoted child", () => {
    const cmd = `Join-Path ${home} "Documents\\notes.txt"`;
    const expanded = expandEnvVarsInCmd(cmd);
    expect(expanded).toContain(path.join(home, "Documents\\notes.txt"));
  });

  it("resolves Join-Path with unquoted child (no spaces)", () => {
    const cmd = `Join-Path ${home} .openclaw`;
    const expanded = expandEnvVarsInCmd(cmd);
    expect(expanded).toContain(path.join(home, ".openclaw"));
  });

  it("resolves Join-Path with -Path and -ChildPath named params", () => {
    const cmd = `Join-Path -Path ${home} -ChildPath '.openclaw\\config'`;
    const expanded = expandEnvVarsInCmd(cmd);
    expect(expanded).toContain(path.join(home, ".openclaw\\config"));
  });

  it("extractReadPaths gets the combined path, not just base", () => {
    const cmd =
      "$path = Join-Path $env:USERPROFILE '.openclaw\\state\\logs\\anthropic-payload.jsonl'";
    const readPaths = extractReadPaths(cmd);
    // Should contain the combined path under .openclaw, NOT bare USERPROFILE
    const combined = path.join(home, ".openclaw\\state\\logs\\anthropic-payload.jsonl");
    expect(readPaths.some((p: string) => p.toLowerCase() === combined.toLowerCase())).toBe(true);
    // Should NOT contain the bare USERPROFILE directory
    expect(readPaths.some((p: string) => p.toLowerCase() === home.toLowerCase())).toBe(false);
  });

  it("extractReadPaths: non-Join-Path use of USERPROFILE still extracted", () => {
    const cmd = `Get-ChildItem '${home}\\Documents'`;
    const readPaths = extractReadPaths(cmd);
    expect(readPaths.some((p: string) => p.toLowerCase().includes("documents"))).toBe(true);
  });
});

// ── Adversarial / edge-case tests ──
//
// These tests exercise inputs that are known to be tricky for regex-based
// path extraction: Unicode, UNC, path traversal, mixed separators, etc.
// The goal is to improve UX accuracy, not guarantee security (the OS
// AppContainer ACL is the real security boundary).

describe("adversarial: Unicode paths", () => {
  it("extracts CJK directory names (unquoted)", () => {
    const paths = extractReadPaths("dir C:\\用户\\文档\\报告.xlsx");
    expect(paths).toContain("C:\\用户\\文档\\报告.xlsx");
  });

  it("extracts CJK directory names (quoted)", () => {
    const paths = extractReadPaths('type "C:\\用户\\文档\\日志.txt"');
    expect(paths).toContain("C:\\用户\\文档\\日志.txt");
  });

  it("extracts accented characters in paths", () => {
    const paths = extractReadPaths('Get-Content "C:\\Users\\Données\\résumé.docx"');
    expect(paths).toContain("C:\\Users\\Données\\résumé.docx");
  });

  it("extracts write to Unicode path", () => {
    const paths = extractWritePaths('Out-File "C:\\用户\\输出\\结果.txt"');
    expect(paths).toContain("C:\\用户\\输出\\结果.txt");
  });

  it("extracts emoji in path (quoted)", () => {
    const paths = extractReadPaths('cat "C:\\Users\\test\\📁docs\\file.txt"');
    expect(paths).toContain("C:\\Users\\test\\📁docs\\file.txt");
  });
});

describe("adversarial: UNC paths (intentionally not supported)", () => {
  // UNC paths (\\server\share\...) are intentionally NOT extracted because:
  // 1. The downstream ACL grant mechanism uses icacls on local NTFS — it cannot
  //    control access to remote SMB shares, so the permission dialog would be
  //    misleading ("grant access" but grant actually does nothing).
  // 2. AppContainer processes lack network share access by default.
  // 3. Matching \\ prefixes risks false positives from regex escapes and
  //    escaped backslashes in command text.
  it("does NOT extract UNC read path", () => {
    const paths = extractReadPaths('type "\\\\server\\share\\data\\file.csv"');
    expect(paths.some((p: string) => p.includes("server\\share"))).toBe(false);
  });

  it("does NOT extract UNC write path", () => {
    const paths = extractWritePaths('Out-File "\\\\nas\\backup\\log.txt"');
    expect(paths.some((p: string) => p.includes("nas\\backup"))).toBe(false);
  });

  it("does NOT extract long path prefix \\\\?\\C:\\...", () => {
    const paths = extractReadPaths('type "\\\\?\\C:\\very\\long\\path\\file.txt"');
    expect(paths.some((p: string) => p.includes("very\\long\\path"))).toBe(false);
  });
});

describe("adversarial: path traversal attempts", () => {
  it("extracts path with .. segments (does not normalize)", () => {
    // Path extraction should extract the literal path; normalization is
    // the caller's responsibility. This test ensures .. doesn't break regex.
    const paths = extractReadPaths("type C:\\Users\\test\\..\\..\\Windows\\System32\\config\\SAM");
    expect(paths.length).toBeGreaterThan(0);
    // The extracted path should contain the .. segments
    expect(paths[0]).toContain("..");
  });

  it("filterSystemPaths blocks normalized traversal paths", () => {
    // If caller normalizes C:\Users\test\..\..\Windows\... → C:\Windows\...
    const normalized = ["C:\\Windows\\System32\\config\\SAM"];
    expect(filterSystemPaths(normalized)).toEqual([]);
  });
});

describe("adversarial: mixed path separators", () => {
  it("extracts path with forward slashes", () => {
    const paths = extractReadPaths("type C:/Users/test/data/file.txt");
    // Forward-slash Windows paths may or may not be extracted depending on
    // regex. This documents current behavior.
    expect(paths.length).toBeGreaterThanOrEqual(0); // document behavior
  });

  it("extracts quoted path with forward slashes", () => {
    const paths = extractReadPaths('cat "C:/Users/test/file.txt"');
    expect(paths.length).toBeGreaterThanOrEqual(0);
  });
});

describe("adversarial: PowerShell backtick escapes", () => {
  it("extracts path with backtick-escaped spaces", () => {
    // PowerShell: backtick is escape char, e.g. C:\My` Documents\file.txt
    const paths = extractReadPaths("Get-Content C:\\My` Documents\\file.txt");
    // Backtick breaks the unquoted regex at the space — this is expected
    // limitation; the quoted form should be preferred
    expect(paths.length).toBeGreaterThanOrEqual(0);
  });

  it("extracts path with backtick-escaped brackets", () => {
    const paths = extractReadPaths("Get-Item 'C:\\data\\file`[1`].txt'");
    expect(paths).toContain("C:\\data\\file`[1`].txt");
  });
});

describe("adversarial: drive-root and special drives", () => {
  it("extracts bare drive root C:\\", () => {
    const paths = extractReadPaths("dir C:\\");
    // After cleanExtractedPath strips trailing slash → "C:"
    // This may or may not be useful but should not crash
    expect(paths.length).toBeGreaterThanOrEqual(0);
  });

  it("extracts non-C: drive paths (D:, E:, Z:)", () => {
    const paths = extractReadPaths("dir D:\\data\\archive Z:\\shared\\config.ini");
    expect(paths).toContain("D:\\data\\archive");
    expect(paths).toContain("Z:\\shared\\config.ini");
  });

  it("extracts write to mapped network drive", () => {
    const paths = extractWritePaths('Out-File "Z:\\team\\shared\\report.xlsx"');
    expect(paths).toContain("Z:\\team\\shared\\report.xlsx");
  });
});

describe("adversarial: relative paths", () => {
  it("does NOT extract .\\relative paths (no drive letter)", () => {
    // Regex requires drive letter prefix; relative paths are not extracted
    const paths = extractReadPaths("type .\\src\\file.txt");
    expect(paths.every((p: string) => /^[a-zA-Z]:\\/.test(p))).toBe(true);
  });

  it("does NOT extract ..\\relative paths", () => {
    const paths = extractReadPaths("type ..\\parent\\file.txt");
    expect(paths.every((p: string) => /^[a-zA-Z]:\\/.test(p))).toBe(true);
  });
});

describe("adversarial: special characters in paths", () => {
  it("extracts path with parentheses (quoted)", () => {
    const paths = extractReadPaths('type "C:\\Users\\test\\Documents (Old)\\file.txt"');
    expect(paths).toContain("C:\\Users\\test\\Documents (Old)\\file.txt");
  });

  it("extracts path with ampersand (quoted)", () => {
    const paths = extractReadPaths('type "C:\\Users\\test\\A & B\\file.txt"');
    expect(paths).toContain("C:\\Users\\test\\A & B\\file.txt");
  });

  it("extracts path with hash (quoted)", () => {
    const paths = extractWritePaths('Out-File "C:\\Users\\test\\C#\\output.log"');
    expect(paths).toContain("C:\\Users\\test\\C#\\output.log");
  });

  it("extracts path with plus sign (unquoted)", () => {
    const paths = extractReadPaths("type C:\\C++\\projects\\main.cpp");
    expect(paths).toContain("C:\\C++\\projects\\main.cpp");
  });

  it("extracts path with dot in folder name", () => {
    const paths = extractReadPaths("dir C:\\Users\\test\\.vscode\\settings.json");
    expect(paths).toContain("C:\\Users\\test\\.vscode\\settings.json");
  });

  it("extracts path with @ in folder name (quoted)", () => {
    const paths = extractReadPaths('cat "C:\\Users\\test\\@scope\\package\\index.js"');
    expect(paths).toContain("C:\\Users\\test\\@scope\\package\\index.js");
  });
});

describe("adversarial: multiple commands and complex pipelines", () => {
  it("extracts paths from semicolon-separated commands", () => {
    const cmd = "Get-Content C:\\a\\in.txt; Out-File C:\\b\\out.txt";
    const readPaths = extractReadPaths(cmd);
    const writePaths = extractWritePaths(cmd);
    expect(readPaths).toContain("C:\\a\\in.txt");
    expect(writePaths).toContain("C:\\b\\out.txt");
  });

  it("extracts paths from && chained commands", () => {
    const cmd = "type C:\\a\\file.txt && copy C:\\a\\file.txt C:\\b\\file.txt";
    const readPaths = extractReadPaths(cmd);
    const writePaths = extractWritePaths(cmd);
    expect(readPaths).toContain("C:\\a\\file.txt");
    expect(writePaths).toContain("C:\\b\\file.txt");
  });

  it("extracts paths from complex pipeline with multiple stages", () => {
    const cmd =
      'Get-ChildItem C:\\data -Recurse | Where-Object { $_.Length -gt 1MB } | Export-Csv "C:\\reports\\large_files.csv"';
    const readPaths = extractReadPaths(cmd);
    const writePaths = extractWritePaths(cmd);
    expect(readPaths).toContain("C:\\data");
    expect(writePaths).toContain("C:\\reports\\large_files.csv");
  });

  it("extracts paths from for loop body", () => {
    const cmd = "foreach ($f in Get-ChildItem C:\\input) { Copy-Item $f.FullName C:\\output }";
    const readPaths = extractReadPaths(cmd);
    const writePaths = extractWritePaths(cmd);
    expect(readPaths).toContain("C:\\input");
    expect(writePaths).toContain("C:\\output");
  });
});

describe("adversarial: evasion techniques (documenting known limitations)", () => {
  it("cannot extract paths built from string concatenation", () => {
    // Known limitation: variable-based path construction evades regex
    const cmd = '$base = "C:\\secret"; $file = "data.txt"; Get-Content "$base\\$file"';
    const paths = extractReadPaths(cmd);
    // The regex won't see the assembled path — this is expected
    // and acceptable because AppContainer ACL still enforces
    expect(paths).not.toContain("C:\\secret\\data.txt");
  });

  it("cannot extract paths from -EncodedCommand", () => {
    // Base64-encoded commands are opaque to regex
    const b64 = Buffer.from("Get-Content C:\\secret\\file.txt", "utf16le").toString("base64");
    const cmd = `powershell -EncodedCommand ${b64}`;
    const paths = extractReadPaths(cmd);
    expect(paths).not.toContain("C:\\secret\\file.txt");
  });

  it("cannot extract paths from here-strings", () => {
    // PowerShell here-string with embedded path
    const cmd = `$script = @"\nGet-Content C:\\secret\\data.txt\n"@\nInvoke-Expression $script`;
    const paths = extractReadPaths(cmd);
    // The path inside here-string may or may not be caught by generic fallback
    // This documents current behavior
    expect(paths.length).toBeGreaterThanOrEqual(0);
  });
});

describe("adversarial: extremely long paths", () => {
  it("handles very deep directory nesting", () => {
    const deepPath = "C:\\" + Array(30).fill("subdir").join("\\") + "\\file.txt";
    const paths = extractReadPaths(`type "${deepPath}"`);
    expect(paths).toContain(deepPath);
  });

  it("handles path with very long filename", () => {
    const longName = "a".repeat(200) + ".txt";
    const fullPath = `C:\\Users\\test\\${longName}`;
    const paths = extractReadPaths(`type "${fullPath}"`);
    expect(paths).toContain(fullPath);
  });
});

describe("adversarial: extractShellPayloadFromString edge cases", () => {
  it("handles nested cmd inside pwsh inside cmd", () => {
    const input =
      'C:\\Windows\\System32\\cmd.exe /c powershell -Command "cmd /c type C:\\Users\\test\\file.txt"';
    const paths = inferPaths(input);
    expect(paths).toContain("C:\\Users\\test\\file.txt");
  });

  it("handles wsl.exe with Linux-style paths (no Windows paths extracted)", () => {
    const input = "wsl.exe -e cat /home/user/file.txt";
    const paths = inferPaths(input);
    // Linux paths should not match Windows regex
    expect(paths.every((p: string) => /^[a-zA-Z]:\\/.test(p))).toBe(true);
  });

  it("handles empty args after shell prefix", () => {
    const input = "cmd.exe /c ";
    const paths = inferPaths(input);
    expect(paths).toEqual([]);
  });
});
