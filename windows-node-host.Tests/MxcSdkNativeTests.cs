using MicroClaw.WindowsNodeHost;
using OpenClaw.Shared;
using OpenClaw.Shared.Mxc;
using OpenClaw.Shared.Telemetry;
using Xunit;

namespace MicroClaw.WindowsNodeHost.Tests;

public sealed class MxcSdkNativeTests
{
    public static bool NativeAvailable => CwdPolicyTests.NativeMxcAvailable;
    public static bool NativeGitAvailable => NativeAvailable &&
        File.Exists(Environment.GetEnvironmentVariable("MICROCLAW_MXC_NATIVE_TEST_GIT_EXE"));

    [Fact]
    public void CmdTransportQuotesOnlyStaticAbsoluteExecutableTokens()
    {
        var executable = Path.Combine(Environment.SystemDirectory, "cmd.exe");
        var inner = Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
        string[] original = [executable, "/d", "/s", "/c", $"  {inner}  -Command Get-Date"];
        var prepared = MxcCmdTransport.Prepare(original);
        Assert.Equal($"  \"{inner}\"  -Command Get-Date", prepared[4]);
        Assert.Equal($"  {inner}  -Command Get-Date", original[4]);
        Assert.Equal(original.Take(4), prepared.Take(4));

        foreach (var payload in new[]
        {
            "powershell -Command Get-Date",
            $"{inner} -Command Get-Date & echo changed",
            $"{inner} -Command \"%PATH%\"",
            $"\"{inner}\" -Command Get-Date",
            $"{inner}\r\necho changed",
        })
        {
            string[] unsafeToRewrite = [executable, "/d", "/s", "/c", payload];
            Assert.Equal(unsafeToRewrite, MxcCmdTransport.Prepare(unsafeToRewrite));
        }
        string[] untrustedCarrier = [Path.Combine(Path.GetTempPath(), "cmd.exe"), "/d", "/s", "/c",
            $"{inner} -Command Get-Date"];
        Assert.Equal(untrustedCarrier, MxcCmdTransport.Prepare(untrustedCarrier));
    }

    [Theory(SkipUnless = nameof(NativeAvailable), Skip = "Requires a verified native SDK and isolated test scratch.")]
    [InlineData(true)]
    [InlineData(false)]
    public async Task ReadinessProbeCanLaunchAChildFromScratchAndApprovedFolders(bool isolatedScratch)
    {
        var root = Directory.CreateDirectory(Path.Combine(
            Environment.GetEnvironmentVariable("MICROCLAW_MXC_NATIVE_TEST_SCRATCH")!,
            "sdk-powershell-child-" + Guid.NewGuid().ToString("N"))).FullName;
        var cwd = Directory.CreateDirectory(Path.Combine(root, "approved")).FullName;
        var consentDir = Directory.CreateDirectory(Path.Combine(root, "consent")).FullName;
        var policy = new HostPolicy
        {
            ApprovedRoots = [new(cwd, FolderAccess.ReadWrite)],
            RequestedStrength = "full", EffectiveTier = "base-container", NetworkAllowed = false,
        };
        var context = MxcSdkRunner.CreateExecutor(policy, Path.Combine(consentDir, "approvals.json"));
        using var executor = context.Executor;
        var runner = new MxcCommandRunner(executor);
        try
        {
            var result = await runner.RunAsync(new CommandRequest
            {
                Argv = ReadinessProbeContract.Probes["execution"],
                Cwd = isolatedScratch ? null : cwd,
                TimeoutMs = 20_000,
            }, TestContext.Current.CancellationToken);
            await executor.WaitForOwnedOperationsAsync(TestContext.Current.CancellationToken);
            context.Processes.AssertSettled();
            Assert.Equal(NodeToolExecutionMode.Sandbox, result.ExecutionMode);
            Assert.True(result.ExitCode == 0, result.Stderr);
            Assert.Contains("MICROCLAW_MXC_EXECUTION_OK", result.Stdout);

            if (isolatedScratch)
            {
                var hostname = Path.Combine(Environment.SystemDirectory, "hostname.exe");
                var bootstrap = "New-PSDrive -Name MicroClawCwd -PSProvider FileSystem -Root ([Environment]::CurrentDirectory) " +
                    "-Scope Script -ErrorAction Stop | Out-Null; Set-Location -LiteralPath 'MicroClawCwd:\\' " +
                    $"-ErrorAction Stop; & '{hostname}'";
                var documented = await runner.RunAsync(new CommandRequest
                {
                    Argv = [Path.Combine(Environment.SystemDirectory, "cmd.exe"), "/d", "/s", "/c",
                        $"powershell.exe -NoProfile -Command \"{bootstrap}\""],
                    Cwd = null,
                    TimeoutMs = 20_000,
                }, TestContext.Current.CancellationToken);
                await executor.WaitForOwnedOperationsAsync(TestContext.Current.CancellationToken);
                context.Processes.AssertSettled();
                Assert.Equal(NodeToolExecutionMode.Sandbox, documented.ExecutionMode);
                Assert.True(documented.ExitCode == 0, documented.Stderr);
                Assert.False(string.IsNullOrWhiteSpace(documented.Stdout));
            }
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Fact(SkipUnless = nameof(NativeAvailable), Skip = "Requires a verified native SDK and isolated test scratch.")]
    public async Task CmdCanResolveAndStartPowerShellInARealContainer()
    {
        var root = Directory.CreateDirectory(Path.Combine(
            Environment.GetEnvironmentVariable("MICROCLAW_MXC_NATIVE_TEST_SCRATCH")!,
            "sdk-powershell-" + Guid.NewGuid().ToString("N"))).FullName;
        var cwd = Directory.CreateDirectory(Path.Combine(root, "allowed folder")).FullName;
        var consentDir = Directory.CreateDirectory(Path.Combine(root, "consent")).FullName;
        var cmd = Path.Combine(Environment.SystemDirectory, "cmd.exe");
        var powershell = Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
        var policy = new HostPolicy
        {
            ApprovedRoots = [new(cwd, FolderAccess.ReadWrite)],
            RequestedStrength = "full", EffectiveTier = "base-container", NetworkAllowed = false,
        };
        var context = MxcSdkRunner.CreateExecutor(policy, Path.Combine(consentDir, "approvals.json"));
        using var executor = context.Executor;
        var runner = new MxcCommandRunner(executor);
        var target = Path.Combine(cwd, "created by powershell.txt").Replace("'", "''");
        var cases = new (string Name, string Payload)[]
        {
            ("bare", "powershell -NoProfile -NonInteractive -Command \"Write-Output 'MXC_OK'\""),
            ("extension", "powershell.exe -NoProfile -NonInteractive -Command \"Write-Output 'MXC_OK'\""),
            ("absolute", $"\"{powershell}\" -NoProfile -NonInteractive -Command \"Write-Output 'MXC_OK'\""),
            ("compound", "echo ready & powershell -NoProfile -NonInteractive -Command \"Write-Output 'MXC_OK'\""),
            ("new-item", $"powershell -Command New-Item -Path '{target}' -ItemType File -Force"),
            ("absolute-new-item", $"{powershell} -Command New-Item -Path '{target}' -ItemType File -Force"),
            ("quoted-absolute-new-item", $"\"{powershell}\" -Command New-Item -Path '{target}' -ItemType File -Force"),
        };
        var results = new List<(string Name, CommandResult Result)>();
        try
        {
            foreach (var (name, payload) in cases)
            {
                var result = await runner.RunAsync(new CommandRequest
                {
                    Argv = MxcCmdTransport.Prepare([cmd, "/d", "/s", "/c", payload]),
                    Cwd = cwd,
                    TimeoutMs = 20_000,
                }, TestContext.Current.CancellationToken);
                await executor.WaitForOwnedOperationsAsync();
                context.Processes.AssertSettled();
                results.Add((name, result));
            }
            using (DirectoryPathLease.Acquire([cwd, Path.GetDirectoryName(cmd)!]))
            using (ExecutableApprovalLease.Acquire(cmd))
            {
                var result = await runner.RunAsync(new CommandRequest
                {
                    Argv = [cmd, "/d", "/s", "/c",
                        $"powershell -Command New-Item -Path '{target}' -ItemType File -Force"],
                    Cwd = cwd,
                    TimeoutMs = 20_000,
                }, TestContext.Current.CancellationToken);
                await executor.WaitForOwnedOperationsAsync();
                context.Processes.AssertSettled();
                results.Add(("approval-and-directory-leases", result));
            }
            Assert.True(results.All(entry => entry.Result.ExitCode == 0),
                string.Join(Environment.NewLine, results.Select(entry =>
                    $"{entry.Name}: exit={entry.Result.ExitCode}; stdout={entry.Result.Stdout}; stderr={entry.Result.Stderr}")));
            Assert.True(File.Exists(target));
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Fact(SkipUnless = nameof(NativeAvailable), Skip = "Requires a verified native SDK and isolated test scratch.")]
    public async Task FullContainmentPreservesReadWriteReadOnlyAndUngrantedBoundaries()
    {
        var root = Directory.CreateDirectory(Path.Combine(
            Environment.GetEnvironmentVariable("MICROCLAW_MXC_NATIVE_TEST_SCRATCH")!,
            "sdk-boundaries-" + Guid.NewGuid().ToString("N"))).FullName;
        var rw = Directory.CreateDirectory(Path.Combine(root, "rw")).FullName;
        var ro = Directory.CreateDirectory(Path.Combine(root, "ro")).FullName;
        var outside = Directory.CreateDirectory(Path.Combine(root, "outside")).FullName;
        var rwFile = Path.Combine(rw, "owned.txt");
        var roFile = Path.Combine(ro, "protected.txt");
        var outsideFile = Path.Combine(outside, "private.txt");
        await File.WriteAllTextAsync(roFile, "preserve", TestContext.Current.CancellationToken);
        await File.WriteAllTextAsync(outsideFile, "secret", TestContext.Current.CancellationToken);
        var executable = Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
        var policy = new HostPolicy
        {
            ApprovedRoots = [new(rw, FolderAccess.ReadWrite), new(ro, FolderAccess.ReadOnly)],
            RequestedStrength = "full", EffectiveTier = "base-container", NetworkAllowed = false,
        };
        var consentDir = Directory.CreateDirectory(Path.Combine(root, "consent")).FullName;
        var context = MxcSdkRunner.CreateExecutor(policy, Path.Combine(consentDir, "approvals.json"));
        using var executor = context.Executor;
        var runner = new MxcCommandRunner(executor);
        async Task<CommandResult> Run(string script)
        {
            var result = await runner.RunAsync(new CommandRequest
            {
                Argv = [executable, "-NoProfile", "-NonInteractive", "-Command", script],
                Cwd = rw,
                TimeoutMs = 20_000,
            }, TestContext.Current.CancellationToken);
            await executor.WaitForOwnedOperationsAsync();
            context.Processes.AssertSettled();
            Assert.Equal(NodeToolExecutionMode.Sandbox, result.ExecutionMode);
            return result;
        }

        try
        {
            var create = await Run($"[IO.File]::WriteAllText('{rwFile}', 'created')");
            Assert.True(create.ExitCode == 0, create.Stderr);
            Assert.Equal("created", await File.ReadAllTextAsync(rwFile, TestContext.Current.CancellationToken));
            var readOnly = await Run($"[IO.File]::ReadAllText('{roFile}')");
            Assert.True(readOnly.ExitCode == 0 && readOnly.Stdout.Contains("preserve"), readOnly.Stderr);
            var denyWrite = await Run($"$ErrorActionPreference='Stop'; [IO.File]::WriteAllText('{roFile}', 'changed')");
            Assert.NotEqual(0, denyWrite.ExitCode);
            var denyRead = await Run($"$ErrorActionPreference='Stop'; [IO.File]::ReadAllText('{outsideFile}')");
            Assert.NotEqual(0, denyRead.ExitCode);
            Assert.DoesNotContain("secret", denyRead.Stdout);
            Assert.Equal("preserve", await File.ReadAllTextAsync(roFile, TestContext.Current.CancellationToken));
            Assert.Equal("secret", await File.ReadAllTextAsync(outsideFile, TestContext.Current.CancellationToken));
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Theory(SkipUnless = nameof(NativeAvailable), Skip = "Requires a verified native SDK and isolated test scratch.")]
    [InlineData(FolderAccess.ReadWrite, FolderAccess.ReadOnly)]
    [InlineData(FolderAccess.ReadOnly, FolderAccess.ReadWrite)]
    public async Task FullContainmentHonorsExplicitNestedFolderAccess(FolderAccess parentAccess, FolderAccess childAccess)
    {
        var root = Directory.CreateDirectory(Path.Combine(
            Environment.GetEnvironmentVariable("MICROCLAW_MXC_NATIVE_TEST_SCRATCH")!,
            "sdk-nested-folders-" + Guid.NewGuid().ToString("N"))).FullName;
        var parent = Directory.CreateDirectory(Path.Combine(root, "parent")).FullName;
        var child = Directory.CreateDirectory(Path.Combine(parent, "child")).FullName;
        var parentFile = Path.Combine(parent, "parent.txt");
        var childFile = Path.Combine(child, "child.txt");
        await File.WriteAllTextAsync(parentFile, "original", TestContext.Current.CancellationToken);
        await File.WriteAllTextAsync(childFile, "original", TestContext.Current.CancellationToken);
        var consentDir = Directory.CreateDirectory(Path.Combine(root, "consent")).FullName;
        var policy = new HostPolicy
        {
            ApprovedRoots = [new(parent, parentAccess), new(child, childAccess)],
            RequestedStrength = "full", EffectiveTier = "base-container", NetworkAllowed = false,
        };
        var context = MxcSdkRunner.CreateExecutor(policy, Path.Combine(consentDir, "approvals.json"));
        using var executor = context.Executor;
        var runner = new MxcCommandRunner(executor);
        var executable = Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");

        async Task<CommandResult> Write(string file)
        {
            var escaped = file.Replace("'", "''");
            var result = await runner.RunAsync(new CommandRequest
            {
                Argv = [executable, "-NoProfile", "-NonInteractive", "-Command",
                    $"$ErrorActionPreference='Stop'; [IO.File]::WriteAllText('{escaped}', 'changed')"],
                Cwd = parent,
                TimeoutMs = 20_000,
            }, TestContext.Current.CancellationToken);
            await executor.WaitForOwnedOperationsAsync(TestContext.Current.CancellationToken);
            context.Processes.AssertSettled();
            Assert.Equal(NodeToolExecutionMode.Sandbox, result.ExecutionMode);
            return result;
        }

        try
        {
            var parentResult = await Write(parentFile);
            var childResult = await Write(childFile);
            Assert.Equal(parentAccess == FolderAccess.ReadWrite, parentResult.ExitCode == 0);
            Assert.Equal(childAccess == FolderAccess.ReadWrite, childResult.ExitCode == 0);
            Assert.Equal(parentAccess == FolderAccess.ReadWrite ? "changed" : "original",
                await File.ReadAllTextAsync(parentFile, TestContext.Current.CancellationToken));
            Assert.Equal(childAccess == FolderAccess.ReadWrite ? "changed" : "original",
                await File.ReadAllTextAsync(childFile, TestContext.Current.CancellationToken));
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Fact(SkipUnless = nameof(NativeGitAvailable), Skip = "Requires native MXC and an explicitly configured Git executable.")]
    public async Task ExplicitProfileGrantEnablesSyntheticGitConfigButPreservesUpstreamDenials()
    {
        var root = Directory.CreateDirectory(Path.Combine(
            Environment.GetEnvironmentVariable("MICROCLAW_MXC_NATIVE_TEST_SCRATCH")!,
            "sdk-profile-" + Guid.NewGuid().ToString("N"))).FullName;
        var profile = Directory.CreateDirectory(Path.Combine(root, "profile")).FullName;
        var workspace = Directory.CreateDirectory(Path.Combine(profile, "workspace")).FullName;
        var settings = Directory.CreateDirectory(Path.Combine(profile, "node-settings")).FullName;
        var aws = Directory.CreateDirectory(Path.Combine(profile, ".aws")).FullName;
        var gitExe = Environment.GetEnvironmentVariable("MICROCLAW_MXC_NATIVE_TEST_GIT_EXE")!;
        var gitRoot = Directory.GetParent(Path.GetDirectoryName(gitExe)!)!.FullName;
        var config = Path.Combine(profile, ".gitconfig");
        var extraFile = Path.Combine(aws, "fixture.txt");
        var protectedFile = Path.Combine(settings, "fixture.txt");
        await File.WriteAllTextAsync(config, "[microclaw]\n\tfixture = SYNTHETIC_GIT_OK\n",
            TestContext.Current.CancellationToken);
        await File.WriteAllTextAsync(extraFile, "EXTRA_FOLDER_OK", TestContext.Current.CancellationToken);
        await File.WriteAllTextAsync(protectedFile, "PROTECTED_MARKER", TestContext.Current.CancellationToken);
        var approvals = Path.Combine(settings, "approvals.json");
        var commonRoots = new[]
        {
            new ApprovedRoot(workspace, FolderAccess.ReadWrite),
            new ApprovedRoot(gitRoot, FolderAccess.ReadOnly),
        };
        var before = new HostPolicy { ApprovedRoots = commonRoots, RequestedStrength = "full", EffectiveTier = "base-container" };
        var after = new HostPolicy
        {
            ApprovedRoots = [.. commonRoots, new ApprovedRoot(profile, FolderAccess.ReadOnly)],
            RequestedStrength = "full", EffectiveTier = "base-container",
        };
        var cmd = Path.Combine(Environment.SystemDirectory, "cmd.exe");
        var powershell = Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
        var gitCommand = $"set \"HOME={profile}\"&& set \"USERPROFILE={profile}\"&& " +
            $"set \"XDG_CONFIG_HOME=\"&& set \"GIT_CONFIG_GLOBAL=\"&& set \"GIT_CONFIG_NOSYSTEM=1\"&& " +
            $"\"{gitExe}\" config --global --get microclaw.fixture";
        async Task<CommandResult> Run(HostPolicy policy, IReadOnlyList<string> argv)
        {
            var context = MxcSdkRunner.CreateExecutor(policy, approvals);
            using var executor = context.Executor;
            var runner = new MxcCommandRunner(executor);
            var result = await runner.RunAsync(new CommandRequest
            {
                Argv = argv,
                Cwd = workspace,
                TimeoutMs = 30_000,
            }, TestContext.Current.CancellationToken);
            await executor.WaitForOwnedOperationsAsync(TestContext.Current.CancellationToken);
            context.Processes.AssertSettled();
            Assert.Equal(NodeToolExecutionMode.Sandbox, result.ExecutionMode);
            return result;
        }

        try
        {
            var deniedGit = await Run(before, [cmd, "/d", "/s", "/c", gitCommand]);
            Assert.NotEqual(0, deniedGit.ExitCode);
            Assert.DoesNotContain("SYNTHETIC_GIT_OK", deniedGit.Stdout);

            MxcSdkRunner.ValidatePolicy(after, approvals);
            var allowedGit = await Run(after, [cmd, "/d", "/s", "/c", gitCommand]);
            Assert.True(allowedGit.ExitCode == 0, allowedGit.Stderr);
            Assert.Contains("SYNTHETIC_GIT_OK", allowedGit.Stdout);

            var extra = await Run(after, [powershell, "-NoProfile", "-NonInteractive", "-Command",
                $"$ErrorActionPreference='Stop'; [IO.File]::ReadAllText('{extraFile.Replace("'", "''")}')"]);
            Assert.True(extra.ExitCode == 0, extra.Stderr);
            Assert.Contains("EXTRA_FOLDER_OK", extra.Stdout);
            var protectedRead = await Run(after, [powershell, "-NoProfile", "-NonInteractive", "-Command",
                $"$ErrorActionPreference='Stop'; [IO.File]::ReadAllText('{protectedFile.Replace("'", "''")}')"]);
            Assert.NotEqual(0, protectedRead.ExitCode);
            Assert.DoesNotContain("PROTECTED_MARKER", protectedRead.Stdout);
        }
        finally { Directory.Delete(root, recursive: true); }
    }
}
