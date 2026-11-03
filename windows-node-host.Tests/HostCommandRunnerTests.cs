using MicroClaw.WindowsNodeHost;
using OpenClaw.Shared;

namespace MicroClaw.WindowsNodeHost.Tests;

public sealed class HostCommandRunnerTests : IDisposable
{
    private readonly string _root = Directory.CreateDirectory(
        Path.Combine(Environment.GetEnvironmentVariable("MICROCLAW_MXC_NATIVE_TEST_SCRATCH") ?? Path.GetTempPath(),
            "microclaw-cmd-" + Guid.NewGuid().ToString("N"))).FullName;

    private CommandRequest Cmd(string payload, int timeoutMs = 10_000) => new()
    {
        Argv = [Path.Combine(Environment.SystemDirectory, "cmd.exe"), "/d", "/s", "/c", payload],
        Cwd = _root,
        TimeoutMs = timeoutMs,
    };

    [Theory]
    [InlineData("echo one & echo two", "one \r\ntwo")]
    [InlineData("echo one ^& two", "one & two")]
    [InlineData("echo alpha | findstr /C:ph", "alpha")]
    [InlineData("echo \"red & blue\"", "\"red & blue\"")]
    public async Task CanonicalCmdPreservesShellSyntax(string payload, string expected)
    {
        var result = await HostCommandRunner.RunAsync(Cmd(payload), TestContext.Current.CancellationToken);

        Assert.Equal(0, result.ExitCode);
        Assert.Equal(expected, result.Stdout);
        Assert.Equal(string.Empty, result.Stderr);
    }

    [Fact]
    public async Task CanonicalCmdLaunchesAnExecutableWhosePathContainsSpaces()
    {
        var executable = Path.Combine(_root, "host name.exe");
        File.Copy(Path.Combine(Environment.SystemDirectory, "hostname.exe"), executable);

        var result = await HostCommandRunner.RunAsync(
            Cmd($"\"{executable}\" & echo completed"), TestContext.Current.CancellationToken);

        Assert.Equal(0, result.ExitCode);
        Assert.Contains(Environment.MachineName, result.Stdout, StringComparison.OrdinalIgnoreCase);
        Assert.EndsWith("completed", result.Stdout);
    }

    [Fact]
    public async Task CanonicalCmdPreservesWorkingDirectoryAndEnvironment()
    {
        var request = Cmd("echo %MICROCLAW_CMD_TEST% & cd");
        request.Env = new Dictionary<string, string> { ["MICROCLAW_CMD_TEST"] = "value with spaces" };

        var result = await HostCommandRunner.RunAsync(request, TestContext.Current.CancellationToken);

        Assert.Equal(0, result.ExitCode);
        Assert.Equal($"value with spaces \r\n{_root}", result.Stdout, ignoreCase: true);
    }

    [Fact]
    public async Task CanonicalCmdPreservesStderrAndExitCode()
    {
        var result = await HostCommandRunner.RunAsync(
            Cmd("echo expected-error 1>&2 & exit /b 17"), TestContext.Current.CancellationToken);

        Assert.Equal(17, result.ExitCode);
        Assert.Equal("expected-error", result.Stderr);
        Assert.Equal(string.Empty, result.Stdout);
    }

    [Fact]
    public async Task CanonicalCmdTimesOutAndStopsItsProcessTree()
    {
        var result = await HostCommandRunner.RunAsync(
            Cmd("ping -n 30 127.0.0.1 >nul", timeoutMs: 300), TestContext.Current.CancellationToken);

        Assert.True(result.TimedOut);
        Assert.Equal(-1, result.ExitCode);
        Assert.InRange(result.DurationMs, 1, 10_000);
    }

    [Fact]
    public async Task CancellationStopsCanonicalCmd()
    {
        using var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(300));
        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            HostCommandRunner.RunAsync(Cmd("ping -n 30 127.0.0.1 >nul"), cancellation.Token));
    }

    [Fact]
    public async Task PreCancelledCommandDoesNotStart()
    {
        var marker = Path.Combine(_root, "should-not-exist.txt");
        using var cancellation = new CancellationTokenSource();
        cancellation.Cancel();

        await Assert.ThrowsAnyAsync<OperationCanceledException>(() =>
            HostCommandRunner.RunAsync(Cmd($"echo started > \"{marker}\""), cancellation.Token));
        Assert.False(File.Exists(marker));
    }

    [Fact]
    public async Task NonCanonicalCommandsStillUseTheUpstreamRunner()
    {
        var request = new CommandRequest
        {
            Argv = [Path.Combine(Environment.SystemDirectory, "hostname.exe")],
            Cwd = _root,
            TimeoutMs = 10_000,
        };

        var result = await HostCommandRunner.RunAsync(request, TestContext.Current.CancellationToken);

        Assert.Equal(0, result.ExitCode);
        Assert.Contains(Environment.MachineName, result.Stdout, StringComparison.OrdinalIgnoreCase);
    }

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }
}
