using System.Linq;
using System.Text;

namespace AppContainerLauncher;

/// <summary>
/// CLI entry point for AppContainer management.
///
/// Commands:
///   check                                         Check OS support (outputs JSON)
///   sid --name NAME                               Get/create profile, output SID
///   run --name NAME --exe PATH [--] [ARGS...]     Run process in AppContainer
///   grant --name NAME --dir PATH [--access rw|r]  Grant directory access
///   revoke --name NAME --dir PATH                 Revoke directory access
///   delete --name NAME                            Delete AppContainer profile
/// </summary>
internal class Program
{
    static int Main(string[] args)
    {
        // Ensure stdout/stderr use UTF-8 so CJK characters are not mangled
        Console.OutputEncoding = Encoding.UTF8;
        Console.InputEncoding = Encoding.UTF8;

        if (args.Length == 0)
        {
            PrintUsage();
            return 1;
        }

        // COMSPEC mode: Node.js exec() invokes COMSPEC as either:
        //   cmd.exe-style:  AppContainerLauncher.exe /d /s /c "command"
        //   unix-style:     AppContainerLauncher.exe -c "command"
        // Node.js uses unix-style when COMSPEC doesn't match /cmd(\.exe)?$/i
        if (args[0].StartsWith("/") || args[0] == "-c")
        {
            return CmdShell(args);
        }

        try
        {
            return args[0].ToLowerInvariant() switch
            {
                "check"    => CmdCheck(),
                "sid"      => CmdSid(args.AsSpan(1)),
                "run"      => CmdRun(args.AsSpan(1)),
                "grant"    => CmdGrant(args.AsSpan(1)),
                "revoke"   => CmdRevoke(args.AsSpan(1)),
                "delete"   => CmdDelete(args.AsSpan(1)),
                "setup"    => CmdSetup(args.AsSpan(1)),
                "loopback" => CmdLoopback(args.AsSpan(1)),
                "check-acl" => CmdCheckAcl(args.AsSpan(1)),
                "scan-acl"  => CmdScanAcl(args.AsSpan(1)),
                "shield"    => CmdShield(args.AsSpan(1)),
                "unshield"  => CmdUnshield(args.AsSpan(1)),
                "--help" or "-h" => (PrintUsage(), 0).Item2,
                _ => (PrintUsage(), 1).Item2,
            };
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"ERROR: {ex.Message}");
            if (ex.InnerException != null)
                Console.Error.WriteLine($"  Inner: {ex.InnerException.Message}");
            return 1;
        }
    }

    static (int, int) PrintUsage()
    {
        Console.Error.WriteLine("""
            AppContainerLauncher — Run processes in Windows AppContainer sandbox

            Usage:
              AppContainerLauncher check
              AppContainerLauncher sid --name <name>
              AppContainerLauncher run --name <name> --exe <path> [--cap <capability>]... [--no-window] [--workdir <path>] [--] [child args...]
              AppContainerLauncher grant --name <name> --dir <path> [--access rw|r]
              AppContainerLauncher revoke --name <name> --dir <path>
              AppContainerLauncher delete --name <name>

            COMSPEC mode (tool execution sandbox):
              Set COMSPEC=AppContainerLauncher.exe, then child_process.exec() calls are sandboxed.
              Configure via env vars: OPENCLAW_SANDBOX_BYPASS, OPENCLAW_SANDBOX_NAME,
              OPENCLAW_SANDBOX_CAPS, OPENCLAW_SANDBOX_DIRS_RW, OPENCLAW_SANDBOX_DIRS_RO

            Capabilities: internetClient, internetClientServer, privateNetworkClientServer,
                         picturesLibrary, videosLibrary, musicLibrary, documentsLibrary,
                         enterpriseAuthentication, sharedUserCertificates, removableStorage,
                         appointments, contacts

              AppContainerLauncher shield --name <name> --dir <path>             Shield sensitive subdirs (break inheritance, remove SID)
              AppContainerLauncher unshield --name <name> --dir <path>           Restore inheritance on a shielded dir
              AppContainerLauncher setup --name <name>                           One-time admin setup: grants traverse ACL on C:\ and C:\Users
              AppContainerLauncher loopback --name <name> [--remove]             Add/remove loopback network exemption
            """);
        return (0, 0);
    }

    // ── Commands ───────────────────────────────────────────────────────────

    static int CmdCheck()
    {
        var (supported, build) = ContainerManager.CheckSupport();
        Console.WriteLine($"{{\"supported\":{(supported ? "true" : "false")},\"build\":{build}}}");
        return supported ? 0 : 1;
    }

    /// <summary>
    /// COMSPEC-compatible shell mode: runs cmd.exe inside AppContainer.
    /// Called when Node.js exec() invokes COMSPEC as:
    ///   cmd.exe-style:  AppContainerLauncher.exe /d /s /c "command" (WindowsVerbatimArguments)
    ///   unix-style:     AppContainerLauncher.exe -c "command"
    ///
    /// Node.js uses cmd.exe-style when COMSPEC matches /cmd(\.exe)?$/i,
    /// otherwise falls back to unix-style ("-c command").
    ///
    /// Sandbox is configured via environment variables:
    ///   OPENCLAW_SANDBOX_BYPASS=1    → pass through to real cmd.exe (no sandbox)
    ///   OPENCLAW_SANDBOX_NAME        → AppContainer profile name (default: MicroClaw)
    ///   OPENCLAW_SANDBOX_CAPS        → comma-separated capabilities (default: internetClient)
    ///   OPENCLAW_SANDBOX_DIRS_RW     → comma-separated dirs to grant RW access
    ///   OPENCLAW_SANDBOX_DIRS_RO     → comma-separated dirs to grant RO access
    /// </summary>
    static int CmdShell(string[] args)
    {
        // Normalize args: convert unix-style "-c command" to cmd.exe-style "/d /s /c command"
        string[] cmdArgs;
        if (args[0] == "-c" && args.Length >= 2)
        {
            // Unix-style: -c "command string"
            cmdArgs = new[] { "/d", "/s", "/c", string.Join(" ", args.Skip(1)) };
        }
        else
        {
            // Already cmd.exe-style: /d /s /c "command"
            cmdArgs = args;
        }

        // Bypass mode: delegate to real cmd.exe
        if (Environment.GetEnvironmentVariable("OPENCLAW_SANDBOX_BYPASS") == "1")
        {
            // Restore original COMSPEC for the child so nested calls also bypass
            string originalComspec = Environment.GetEnvironmentVariable("OPENCLAW_ORIGINAL_COMSPEC")
                ?? Path.Combine(Environment.SystemDirectory, "cmd.exe");
            var psi = new System.Diagnostics.ProcessStartInfo
            {
                FileName = originalComspec,
                UseShellExecute = false,
            };
            foreach (var arg in cmdArgs) psi.ArgumentList.Add(arg);
            var proc = System.Diagnostics.Process.Start(psi)!;
            proc.WaitForExit();
            return proc.ExitCode;
        }

        // Sandbox mode: run cmd.exe inside AppContainer
        string containerName = Environment.GetEnvironmentVariable("OPENCLAW_SANDBOX_NAME")
            ?? "MicroClaw";
        string capsStr = Environment.GetEnvironmentVariable("OPENCLAW_SANDBOX_CAPS")
            ?? "internetClient";
        string[] capabilities = capsStr.Split(',', StringSplitOptions.RemoveEmptyEntries |
            StringSplitOptions.TrimEntries);

        // NOTE: Directory ACLs are NOT granted here. ACL management is handled
        // by explicit grant/revoke commands from the Electron main process.
        // Previously this code granted ACLs from OPENCLAW_SANDBOX_DIRS_RW/RO env
        // vars on every run, which caused deleted permissions to be silently
        // re-added because env vars don't update after process start.

        string cmdExe = Path.Combine(Environment.SystemDirectory, "cmd.exe");
        string workDir = Directory.GetCurrentDirectory();

        // Prepend chcp 65001 so cmd.exe outputs UTF-8 inside AppContainer
        // (default OEM code page on CJK Windows would produce garbled CJK text)
        for (int i = 0; i < cmdArgs.Length; i++)
        {
            if (string.Equals(cmdArgs[i], "/c", StringComparison.OrdinalIgnoreCase) && i + 1 < cmdArgs.Length)
            {
                cmdArgs[i + 1] = "chcp 65001 >nul & " + cmdArgs[i + 1];
                break;
            }
        }

        return ContainerManager.Run(containerName, cmdExe, cmdArgs, workDir, capabilities, noWindow: true, quiet: true);
    }

    static int CmdSid(ReadOnlySpan<string> args)
    {
        string? name = null;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--name" && i + 1 < args.Length) name = args[++i];
        }
        if (name == null) { Console.Error.WriteLine("Missing --name"); return 1; }

        string sid = ContainerManager.GetSid(name);
        Console.WriteLine(sid);
        return 0;
    }

    static int CmdRun(ReadOnlySpan<string> args)
    {
        string? name = null, exe = null, workDir = null;
        var capabilities = new List<string>();
        bool noWindow = false;
        bool quiet = false;
        bool skipSetup = false;
        var childArgs = new List<string>();
        bool pastSeparator = false;

        for (int i = 0; i < args.Length; i++)
        {
            if (pastSeparator)
            {
                childArgs.Add(args[i]);
                continue;
            }

            switch (args[i])
            {
                case "--":
                    pastSeparator = true;
                    break;
                case "--name":
                    if (i + 1 < args.Length) name = args[++i];
                    break;
                case "--exe":
                    if (i + 1 < args.Length) exe = args[++i];
                    break;
                case "--workdir":
                    if (i + 1 < args.Length) workDir = args[++i];
                    break;
                case "--cap":
                    if (i + 1 < args.Length) capabilities.Add(args[++i]);
                    break;
                case "--no-window":
                    noWindow = true;
                    break;
                case "--quiet":
                    quiet = true;
                    break;
                case "--skip-setup":
                    skipSetup = true;
                    break;
                default:
                    Console.Error.WriteLine($"Unknown option: {args[i]}");
                    return 1;
            }
        }

        if (name == null) { Console.Error.WriteLine("Missing --name"); return 1; }
        if (exe == null) { Console.Error.WriteLine("Missing --exe"); return 1; }

        return ContainerManager.Run(name, exe, childArgs.ToArray(), workDir, capabilities.ToArray(), noWindow, quiet, skipSetup);
    }

    static int CmdGrant(ReadOnlySpan<string> args)
    {
        string? name = null, dir = null, access = "rw";
        bool grantChildren = false;
        bool shieldSensitive = false;

        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--name":
                    if (i + 1 < args.Length) name = args[++i];
                    break;
                case "--dir":
                    if (i + 1 < args.Length) dir = args[++i];
                    break;
                case "--access":
                    if (i + 1 < args.Length) access = args[++i];
                    break;
                case "--children":
                    grantChildren = true;
                    break;
                case "--shield-sensitive":
                    shieldSensitive = true;
                    break;
            }
        }

        if (name == null) { Console.Error.WriteLine("Missing --name"); return 1; }
        if (dir == null) { Console.Error.WriteLine("Missing --dir"); return 1; }

        bool readOnly = access.Equals("r", StringComparison.OrdinalIgnoreCase);
        ContainerManager.GrantAccess(name, dir, readOnly);
        Console.Error.WriteLine($"Granted {(readOnly ? "read-only" : "read-write")} access to: {dir}");

        // Only grant protected children when explicitly requested (user-initiated grants).
        // Startup provisioning does NOT pass --children to avoid re-creating ACLs
        // on child directories the user may have intentionally removed.
        if (grantChildren && Directory.Exists(dir))
        {
            try { ContainerManager.GrantProtectedChildren(name, dir, readOnly); }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[grant] Warning: protected children for {dir}: {ex.Message}");
            }
        }

        // Shield sensitive subdirectories after grant (CLI-level composition,
        // not integrated into GrantAccess itself).
        if (shieldSensitive && Directory.Exists(dir))
        {
            var shielded = ContainerManager.ShieldSensitivePaths(name, dir);
            foreach (var s in shielded)
                Console.Error.WriteLine($"[grant] Shielded sensitive dir: {s}");
        }
        return 0;
    }

    static int CmdShield(ReadOnlySpan<string> args)
    {
        string? name = null, dir = null;
        var extra = new List<string>();

        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--name": if (i + 1 < args.Length) name = args[++i]; break;
                case "--dir": if (i + 1 < args.Length) dir = args[++i]; break;
                case "--extra": if (i + 1 < args.Length) extra.AddRange(args[++i].Split(',')); break;
            }
        }

        if (name == null) { Console.Error.WriteLine("Missing --name"); return 1; }
        if (dir == null) { Console.Error.WriteLine("Missing --dir"); return 1; }

        var shielded = ContainerManager.ShieldSensitivePaths(name, dir,
            extra.Count > 0 ? extra.ToArray() : null);
        Console.Error.WriteLine($"Shielded {shielded.Count} sensitive dir(s) under: {dir}");
        return 0;
    }

    static int CmdUnshield(ReadOnlySpan<string> args)
    {
        string? name = null, dir = null;

        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--name": if (i + 1 < args.Length) name = args[++i]; break;
                case "--dir": if (i + 1 < args.Length) dir = args[++i]; break;
            }
        }

        if (name == null) { Console.Error.WriteLine("Missing --name"); return 1; }
        if (dir == null) { Console.Error.WriteLine("Missing --dir"); return 1; }

        ContainerManager.UnshieldPath(dir);
        Console.Error.WriteLine($"Unshielded: {dir}");
        return 0;
    }

    static int CmdRevoke(ReadOnlySpan<string> args)
    {
        string? name = null, dir = null;

        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--name":
                    if (i + 1 < args.Length) name = args[++i];
                    break;
                case "--dir":
                    if (i + 1 < args.Length) dir = args[++i];
                    break;
            }
        }

        if (name == null) { Console.Error.WriteLine("Missing --name"); return 1; }
        if (dir == null) { Console.Error.WriteLine("Missing --dir"); return 1; }

        ContainerManager.RevokeAccess(name, dir);
        Console.Error.WriteLine($"Revoked access to: {dir}");
        return 0;
    }

    static int CmdDelete(ReadOnlySpan<string> args)
    {
        string? name = null;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--name" && i + 1 < args.Length) name = args[++i];
        }
        if (name == null) { Console.Error.WriteLine("Missing --name"); return 1; }

        ContainerManager.DeleteProfile(name);
        Console.Error.WriteLine($"Deleted profile: {name}");
        return 0;
    }

    static int CmdSetup(ReadOnlySpan<string> args)
    {
        string? name = null;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--name" && i + 1 < args.Length) name = args[++i];
        }
        if (name == null) { Console.Error.WriteLine("Missing --name"); return 1; }

        ContainerManager.SetupDriveTraverse(name);
        return 0;
    }

    static int CmdLoopback(ReadOnlySpan<string> args)
    {
        string? name = null;
        bool remove = false;
        for (int i = 0; i < args.Length; i++)
        {
            if (args[i] == "--name" && i + 1 < args.Length) name = args[++i];
            if (args[i] == "--remove") remove = true;
        }
        if (name == null) { Console.Error.WriteLine("Missing --name"); return 1; }

        ContainerManager.SetLoopbackExemption(name, !remove);
        return 0;
    }

    static int CmdCheckAcl(ReadOnlySpan<string> args)
    {
        string? name = null, dir = null, access = "r";
        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--name": if (i + 1 < args.Length) name = args[++i]; break;
                case "--dir": if (i + 1 < args.Length) dir = args[++i]; break;
                case "--access": if (i + 1 < args.Length) access = args[++i]; break;
            }
        }
        if (name == null) { Console.Error.WriteLine("Missing --name"); return 1; }
        if (dir == null) { Console.Error.WriteLine("Missing --dir"); return 1; }

        bool readOnly = access.Equals("r", StringComparison.OrdinalIgnoreCase);
        string json = ContainerManager.CheckAccess(name, dir, readOnly);
        Console.WriteLine(json);
        return 0;
    }

    static int CmdScanAcl(ReadOnlySpan<string> args)
    {
        string? name = null;
        int depth = 2;
        var knownDirs = new HashSet<string>(StringComparer.OrdinalIgnoreCase);

        for (int i = 0; i < args.Length; i++)
        {
            switch (args[i])
            {
                case "--name": if (i + 1 < args.Length) name = args[++i]; break;
                case "--depth": if (i + 1 < args.Length) depth = int.Parse(args[++i]); break;
                case "--known": if (i + 1 < args.Length) knownDirs.Add(args[++i].TrimEnd('\\', '/')); break;
            }
        }
        if (name == null) { Console.Error.WriteLine("Missing --name"); return 1; }

        ContainerManager.ScanStaleAcls(name, knownDirs, depth);
        return 0;
    }
}
