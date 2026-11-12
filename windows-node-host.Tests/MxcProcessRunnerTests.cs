using System.Diagnostics;
using Microsoft.Mxc.Sdk.V1;
using MicroClaw.WindowsNodeHost;

namespace MicroClaw.WindowsNodeHost.Tests;

public sealed class MxcProcessRunnerTests
{
    [Fact]
    public async Task TrackerRequiresACompletedWaitAndDisposal()
    {
        var tracker = new MxcProcessTracker(_ => Task.FromResult<IMxcProcess>(new FakeProcess()));
        var process = await tracker.SpawnAsync(new ContainerRequest("test"));
        Assert.Equal("mxc-process-uncertain", Assert.Throws<HostPolicyException>(tracker.AssertSettled).Code);
        await process.WaitAsync(TestContext.Current.CancellationToken);
        Assert.Throws<HostPolicyException>(tracker.AssertSettled);
        process.Dispose();
        tracker.AssertSettled();
    }

    [Fact]
    public async Task TrackerPermanentlyBlocksAfterUncertainLaunchOrCleanup()
    {
        var failedSpawn = new MxcProcessTracker(_ => Task.FromException<IMxcProcess>(new IOException("spawn failed")));
        await Assert.ThrowsAsync<IOException>(() => failedSpawn.SpawnAsync(new ContainerRequest("test")));
        Assert.Equal("mxc-process-uncertain", Assert.Throws<HostPolicyException>(failedSpawn.AssertSettled).Code);
        await Assert.ThrowsAsync<HostPolicyException>(() => failedSpawn.SpawnAsync(new ContainerRequest("test")));

        var failedCleanup = new MxcProcessTracker(_ => Task.FromResult<IMxcProcess>(new FakeProcess()));
        var process = await failedCleanup.SpawnAsync(new ContainerRequest("test"));
        process.Dispose();
        Assert.Equal("mxc-process-uncertain", Assert.Throws<HostPolicyException>(failedCleanup.AssertSettled).Code);
    }

    [Fact]
    public async Task ProcessCaptureRetainsTheMxcOutputLimit()
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = Path.Combine(Environment.SystemDirectory, "cmd.exe"),
            Arguments = "/d /s /c \"echo 123456789\"",
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        var result = await ChildProcessCapture.RunAsync(
            startInfo, 10_000, TestContext.Current.CancellationToken, outputLimit: 5, trimOutput: true);

        Assert.Equal(0, result.ExitCode);
        Assert.StartsWith("12345\n\n... [TRUNCATED", result.Stdout);
    }

    [Fact]
    public async Task ProcessCaptureReturnsCancelledMxcExecution()
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = Path.Combine(Environment.SystemDirectory, "cmd.exe"),
            Arguments = "/d /s /c \"ping -n 30 127.0.0.1 >nul\"",
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        using var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(300));
        var result = await ChildProcessCapture.RunAsync(
            startInfo, 0, cancellation.Token, returnCancelledResult: true);

        Assert.True(result.TimedOut);
        Assert.Equal(-1, result.ExitCode);
        Assert.Equal("Execution was cancelled.", result.Stderr);
    }

    private sealed class FakeProcess : IMxcProcess
    {
        public uint Id => 0;
        public Stream? StandardInput => null;
        public Stream? StandardOutput => null;
        public Stream? StandardError => null;
        public IMxcStreamCloser? StandardOutputCloser => null;
        public IMxcStreamCloser? StandardErrorCloser => null;
        public IReadOnlyList<string> Warnings => [];
        public ExecutionMetadata? OutputMetadata => null;
        public WaitResult Wait() => new() { ExitCode = 0 };
        public Task<WaitResult> WaitAsync(CancellationToken cancellationToken = default) => Task.FromResult(Wait());
        public bool TryGetExitCode(out int exitCode) { exitCode = 0; return true; }
        public Task<(WaitResult Result, byte[] Stdout, byte[] Stderr)> WaitForExitWithOutputAsync(
            CancellationToken cancellationToken = default) =>
            Task.FromResult((Wait(), Array.Empty<byte>(), Array.Empty<byte>()));
        public void Kill() { }
        public void Dispose() { }
    }
}
