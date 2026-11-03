using MicroClaw.WindowsNodeHost;
using OpenClaw.Shared;
using OpenClaw.Shared.ExecApprovals;
using System.Diagnostics;
using Xunit;

namespace MicroClaw.WindowsNodeHost.Tests;

public sealed class CommandConsentTests : IDisposable
{
    private readonly string _root = Path.Combine(
        Environment.GetEnvironmentVariable("MICROCLAW_MXC_NATIVE_TEST_SCRATCH") ?? Path.GetTempPath(),
        "microclaw-consent-" + Guid.NewGuid().ToString("N"));
    private readonly ExecApprovalsStore _store;
    private readonly CommandConsent _consent;

    public CommandConsentTests()
    {
        _store = new ExecApprovalsStore(_root, NullLogger.Instance);
        _consent = new CommandConsent(_store, NullLogger.Instance);
    }

    private NodeInvokeRequest Request(params string[] argv) =>
        CommandConsent.Request(argv, _root, 10_000, "main", "agent:main:test");

    [Fact]
    public async Task PreparationDoesNotRememberAndPolicyCannotApproveAMiss()
    {
        await _consent.SetModeAsync(CommandConsent.AskWhenNeeded);
        var request = Request(Path.Combine(Environment.SystemDirectory, "hostname.exe"));
        var first = await _consent.PrepareAsync(request);
        Assert.True(first.Preview.Required);
        Assert.True(first.Preview.AllowAlwaysAvailable);
        Assert.True((await _consent.PrepareAsync(request)).Preview.Required);
        await Assert.ThrowsAsync<HostPolicyException>(() => _consent.AuthorizeAsync(request, "policy"));
        await _consent.AuthorizeAsync(request, "allow-once");
        Assert.True((await _consent.PrepareAsync(request)).Preview.Required);
    }

    [Fact]
    public async Task RememberingUsesUpstreamAllowlistAndBoundArguments()
    {
        await _consent.SetModeAsync(CommandConsent.AskWhenNeeded);
        var executable = Path.Combine(Environment.SystemDirectory, "hostname.exe");
        var request = Request(executable);
        await _consent.AuthorizeAsync(request, "allow-always");
        Assert.False((await _consent.PrepareAsync(request)).Preview.Required);
        var execution = await _consent.AuthorizeAsync(request, "policy");
        await _consent.RevalidateAsync(execution, TestContext.Current.CancellationToken);
        Assert.True((await _consent.PrepareAsync(Request(executable, "changed"))).Preview.Required);
        var snapshot = await _store.GetSnapshotAsync();
        snapshot.File.Agents = new();
        Assert.NotNull(await _store.ReplaceAsync(snapshot.Hash, snapshot.File));
        await Assert.ThrowsAsync<HostPolicyException>(() => _consent.AuthorizeAsync(request, "policy"));
    }

    [Fact]
    public async Task FullPolicyApprovesWithoutPromptButCanReturnToOnMiss()
    {
        var request = Request(Path.Combine(Environment.SystemDirectory, "cmd.exe"), "/d", "/s", "/c", "echo consent");
        await _consent.SetModeAsync(CommandConsent.AllowAlways);
        Assert.False((await _consent.PrepareAsync(request)).Preview.Required);
        await _consent.AuthorizeAsync(request, "policy");
        await _consent.SetModeAsync(CommandConsent.AskWhenNeeded);
        Assert.True((await _consent.PrepareAsync(request)).Preview.Required);
        await Assert.ThrowsAsync<HostPolicyException>(() => _consent.AuthorizeAsync(request, "policy"));
    }

    [Fact]
    public async Task CanonicalCmdIsPreservedAndEligibleInnerExecutableCanBeRemembered()
    {
        await _consent.SetModeAsync(CommandConsent.AskWhenNeeded);
        var cmd = Path.Combine(Environment.SystemDirectory, "cmd.exe");
        var payload = Path.Combine(Environment.SystemDirectory, "hostname.exe");
        var request = Request(cmd, "/d", "/s", "/c", payload);
        var prepared = await _consent.PrepareAsync(request);
        Assert.True(prepared.Preview.AllowAlwaysAvailable);
        Assert.Equal(cmd, prepared.Execution.Argv[0], ignoreCase: true);
        Assert.Equal(new[] { "/d", "/s", "/c" }, prepared.Execution.Argv.Skip(1).Take(3));
        await _consent.AuthorizeAsync(request, "allow-always");
        Assert.False((await _consent.PrepareAsync(request)).Preview.Required);
    }

    [Fact]
    public async Task CanonicalCmdCanRememberAnExecutableWithFixedArguments()
    {
        await _consent.SetModeAsync(CommandConsent.AskWhenNeeded);
        var cmd = Path.Combine(Environment.SystemDirectory, "cmd.exe");
        var executable = Path.Combine(Environment.SystemDirectory, "hostname.exe");
        var request = Request(cmd, "/d", "/s", "/c", $"{executable} status");
        Assert.True((await _consent.PrepareAsync(request)).Preview.AllowAlwaysAvailable);
        await _consent.AuthorizeAsync(request, "allow-always");
        Assert.False((await _consent.PrepareAsync(request)).Preview.Required);
        Assert.True((await _consent.PrepareAsync(
            Request(cmd, "/d", "/s", "/c", $"{executable} other"))).Preview.Required);
    }

    [Fact]
    public async Task UnquotedPowerShellInsideCanonicalCmdCanBeRemembered()
    {
        await _consent.SetModeAsync(CommandConsent.AskWhenNeeded);
        var request = Request(Path.Combine(Environment.SystemDirectory, "cmd.exe"),
            "/d", "/s", "/c", "powershell -Command Get-Date");
        var preview = (await _consent.PrepareAsync(request)).Preview;
        Assert.True(preview.Required);
        Assert.True(preview.AllowAlwaysAvailable);
        await _consent.AuthorizeAsync(request, "allow-always");
        Assert.False((await _consent.PrepareAsync(request)).Preview.Required);
        Assert.True((await _consent.PrepareAsync(Request(
            Path.Combine(Environment.SystemDirectory, "cmd.exe"),
            "/d", "/s", "/c", "powershell -Command Get-Process"))).Preview.Required);
    }

    [Fact]
    public async Task UpstreamAllowlistCurrentlyNormalizesSlashVariants()
    {
        await _consent.SetModeAsync(CommandConsent.AskWhenNeeded);
        var cmd = Path.Combine(Environment.SystemDirectory, "cmd.exe");
        var forward = Request(cmd, "/d", "/s", "/c", "powershell -Command Write-Output 'a/b'");
        var back = Request(cmd, "/d", "/s", "/c", @"powershell -Command Write-Output 'a\b'");
        Assert.True((await _consent.PrepareAsync(forward)).Preview.AllowAlwaysAvailable);
        await _consent.AuthorizeAsync(forward, "allow-always");
        Assert.False((await _consent.PrepareAsync(back)).Preview.Required);
    }

    [Fact]
    public async Task CmdBuiltinsAndInlinePowerShellRemainOneUse()
    {
        await _consent.SetModeAsync(CommandConsent.AskWhenNeeded);
        var requests = new[]
        {
            Request(Path.Combine(Environment.SystemDirectory, "cmd.exe"), "/d", "/s", "/c", @"type C:\work\notes.txt"),
            Request(Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe"), "-NoProfile", "-Command", "Get-Date"),
            Request(Path.Combine(Environment.SystemDirectory, "cmd.exe"), "/d", "/s", "/c",
                @"powershell -Command ""New-Item -Path 'C:\Users\Alice\Desktop\test.txt' -ItemType File -Force"""),
        };
        foreach (var request in requests)
        {
            var prepared = await _consent.PrepareAsync(request);
            Assert.True(prepared.Preview.Required);
            Assert.False(prepared.Preview.AllowAlwaysAvailable);
            await Assert.ThrowsAsync<HostPolicyException>(() => _consent.AuthorizeAsync(request, "allow-always"));
            await _consent.AuthorizeAsync(request, "allow-once");
        }
    }

    [Fact]
    public async Task HostRunnerReadsAFileWhosePathContainsSpaces()
    {
        await _consent.SetModeAsync(CommandConsent.AskWhenNeeded);
        var file = Path.Combine(_root, "notes with spaces.txt");
        await File.WriteAllTextAsync(file, "consent-file-content", TestContext.Current.CancellationToken);
        var request = Request(Path.Combine(Environment.SystemDirectory, "cmd.exe"),
            "/d", "/s", "/c", $"type \"{file}\"");
        var execution = await _consent.AuthorizeAsync(request, "allow-once");
        await _consent.RevalidateAsync(execution, TestContext.Current.CancellationToken);
        var result = await HostCommandRunner.RunAsync(execution.ToCommandRequest(), TestContext.Current.CancellationToken);
        Assert.True(result.ExitCode == 0,
            $"Exit {result.ExitCode}: {result.Stderr}; argv: {string.Join(" | ", execution.Argv)}; cwd: {execution.Cwd}");
        Assert.Equal("consent-file-content", result.Stdout.Trim());
    }

    [Theory]
    [InlineData(true)]
    [InlineData(false)]
    public async Task NativeRememberHelperPersistsAnUpstreamRuleWithoutExecuting(bool hasCwd)
    {
        await _consent.SetModeAsync(CommandConsent.AskWhenNeeded);
        var request = CommandConsent.Request(
            [Path.Combine(Environment.SystemDirectory, "cmd.exe"),
                "/d", "/s", "/c", Path.Combine(Environment.SystemDirectory, "hostname.exe")],
            hasCwd ? _root : null, 10_000, "main", "agent:main:test");
        Assert.Equal("agent:main:test", request.Args.GetProperty("sessionKey").GetString());
        Assert.True((await _consent.PrepareAsync(request)).Preview.Required);

        var startInfo = new ProcessStartInfo
        {
            FileName = Path.Combine(AppContext.BaseDirectory, "microclaw-windows-node-host.exe"),
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        startInfo.ArgumentList.Add("--remember-command");
        startInfo.ArgumentList.Add(_root);
        startInfo.Environment.Remove("OPENCLAW_STATE_DIR");
        startInfo.Environment.Remove("OPENCLAW_HOME");
        using var process = Process.Start(startInfo)!;
        await process.StandardInput.WriteLineAsync(request.Args.GetRawText());
        process.StandardInput.Close();
        var stdout = process.StandardOutput.ReadToEndAsync(TestContext.Current.CancellationToken);
        var stderr = process.StandardError.ReadToEndAsync(TestContext.Current.CancellationToken);
        await process.WaitForExitAsync(TestContext.Current.CancellationToken);

        Assert.True(process.ExitCode == 0, await stderr);
        Assert.Equal("remembered", (await stdout).Trim());
        Assert.False((await _consent.PrepareAsync(request)).Preview.Required);
    }

    public void Dispose()
    {
        _store.Dispose();
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }
}
