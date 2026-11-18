using System.Diagnostics;
using System.Text;
using Microsoft.Mxc.Sdk.V1;
using MicroClaw.WindowsNodeHost;
using OpenClaw.Shared;
using OpenClaw.Shared.Mxc;
using OpenClaw.Shared.Telemetry;

namespace MicroClaw.WindowsNodeHost.Tests;

public sealed class MxcProcessRunnerTests
{
    public static bool NativeAvailable => CwdPolicyTests.NativeMxcAvailable;

    [Fact]
    public void MxcNoTimeoutWorkloadDisablesTheExecutorDeadline()
    {
        var workload = new MxcNoTimeoutRunner.UnboundedCommand(new CommandRequest());

        Assert.Equal(0, workload.TimeoutMs);
        Assert.Equal(Timeout.Infinite, workload.ExecutionTimeout(600_000));
    }

    [Fact]
    public async Task NoTimeoutOutlivesConfiguredDeadlineAndCompletesWithinSandbox()
    {
        using var fixture = new ExecutorFixture();
        var process = new ControlledProcess("sandbox output");
        ContainerRequest? submitted = null;
        var tracker = new MxcProcessTracker(request =>
        {
            submitted = request;
            return Task.FromResult<IMxcProcess>(process);
        });
        using var executor = fixture.CreateExecutor(tracker);
        var run = MxcNoTimeoutRunner.RunAsync(executor, fixture.Command(), TestContext.Current.CancellationToken);

        try
        {
            await process.Started.Task.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
            await Task.Delay(1_000, TestContext.Current.CancellationToken);
            Assert.False(run.IsCompleted);
            Assert.False(process.Killed);
            process.Complete();
            var result = await run.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
            await executor.WaitForOwnedOperationsAsync(TestContext.Current.CancellationToken);

            Assert.Equal(NodeToolExecutionMode.Sandbox, result.ExecutionMode);
            Assert.Equal(0, result.ExitCode);
            Assert.False(result.TimedOut);
            Assert.Equal("sandbox output", result.Stdout);
            Assert.True(process.Disposed);
            Assert.False(process.Killed);
            Assert.NotNull(submitted);
            Assert.Null(submitted.TimeoutMs);
            Assert.IsType<Containment.ProcessContainer>(submitted.Containment);
            Assert.Equal(NetworkAction.Deny, submitted.Network!.Egress!.Default);
            Assert.Equal(NetworkAction.Deny, submitted.Network.Ingress!.HostLoopback);
            Assert.Contains(fixture.DeniedPath, submitted.Filesystem!.DeniedPaths);
            tracker.AssertSettled();
            Assert.Empty(Directory.GetDirectories(fixture.Runs));
        }
        finally
        {
            process.Complete();
            await executor.WaitForOwnedOperationsAsync(TestContext.Current.CancellationToken);
        }
    }

    [Fact]
    public async Task NoTimeoutCommandStillEnforcesOutputBudget()
    {
        using var fixture = new ExecutorFixture();
        var process = new ControlledProcess(new string('x', 100));
        var tracker = new MxcProcessTracker(_ => Task.FromResult<IMxcProcess>(process));
        using var executor = fixture.CreateExecutor(tracker, outputBudget: 24);
        var run = MxcNoTimeoutRunner.RunAsync(executor, fixture.Command(), TestContext.Current.CancellationToken);
        try
        {
            await process.Started.Task.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
            process.Complete();
            var result = await run.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
            await executor.WaitForOwnedOperationsAsync(TestContext.Current.CancellationToken);

            Assert.EndsWith("\n[truncated]", result.Stdout);
            Assert.True(Encoding.UTF8.GetByteCount(result.Stdout) <= 24);
            tracker.AssertSettled();
        }
        finally
        {
            process.Complete();
            await executor.WaitForOwnedOperationsAsync(TestContext.Current.CancellationToken);
        }
    }

    [Fact]
    public async Task CancelledNoTimeoutCommandKillsAndSettlesItsOwnedProcess()
    {
        using var fixture = new ExecutorFixture();
        var process = new ControlledProcess("partial output");
        var tracker = new MxcProcessTracker(_ => Task.FromResult<IMxcProcess>(process));
        using var executor = fixture.CreateExecutor(tracker);
        using var cancel = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
        var run = MxcNoTimeoutRunner.RunAsync(executor, fixture.Command(), cancel.Token);

        try
        {
            await process.Started.Task.WaitAsync(TimeSpan.FromSeconds(10), TestContext.Current.CancellationToken);
            cancel.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => run);
            await executor.WaitForOwnedOperationsAsync(TestContext.Current.CancellationToken);

            Assert.True(process.Killed);
            Assert.True(process.Disposed);
            tracker.AssertSettled();
            Assert.Empty(Directory.GetDirectories(fixture.Runs));
        }
        finally
        {
            cancel.Cancel();
            process.Complete();
            await executor.WaitForOwnedOperationsAsync(TestContext.Current.CancellationToken);
        }
    }

    [Fact]
    public async Task FiniteMxcCommandStillHonorsConfiguredDeadline()
    {
        using var fixture = new ExecutorFixture();
        var process = new ControlledProcess("output");
        var tracker = new MxcProcessTracker(_ => Task.FromResult<IMxcProcess>(process));
        using var executor = fixture.CreateExecutor(tracker);
        var request = fixture.Command();
        request.TimeoutMs = 10_000;

        var result = await new MxcCommandRunner(executor).RunAsync(request, TestContext.Current.CancellationToken);
        await executor.WaitForOwnedOperationsAsync(TestContext.Current.CancellationToken);

        Assert.True(result.TimedOut);
        Assert.True(process.Killed);
        Assert.True(process.Disposed);
        tracker.AssertSettled();
        Assert.Empty(Directory.GetDirectories(fixture.Runs));
    }

    [Fact(SkipUnless = nameof(NativeAvailable), Skip = "Requires a verified native SDK and isolated test scratch.")]
    public async Task NativeNoTimeoutCommandCompletesAndCancellationSettlesProcess()
    {
        var availability = MxcAvailability.Probe();
        Assert.True(availability.CanRunSystemRunSandbox,
            string.Join(" ", availability.SystemRunSandboxUnsupportedReasons));
        using var fixture = new ExecutorFixture();
        var spawned = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var runtime = new Stopwatch();
        var tracker = new MxcProcessTracker(async request =>
        {
            var process = await MxcContainer.SpawnAsync(request,
                new SpawnOptions { Telemetry = new TelemetryConfig { Enabled = false } }, CancellationToken.None);
            runtime.Restart();
            spawned.TrySetResult();
            return process;
        });
        using var executor = fixture.CreateNativeExecutor(tracker);
        using var cancel = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
        var command = fixture.Command();
        command.Argv = [Path.Combine(Environment.SystemDirectory, "cmd.exe"),
            "/d", "/s", "/c", "ping -n 3 127.0.0.1 >nul & echo completed"];
        try
        {
            var result = await MxcNoTimeoutRunner.RunAsync(executor, command, cancel.Token)
                .WaitAsync(TimeSpan.FromSeconds(30), TestContext.Current.CancellationToken);
            await executor.WaitForOwnedOperationsAsync(TestContext.Current.CancellationToken);
            Assert.Equal(NodeToolExecutionMode.Sandbox, result.ExecutionMode);
            Assert.Equal(0, result.ExitCode);
            Assert.False(result.TimedOut);
            Assert.Contains("completed", result.Stdout);
            Assert.True(runtime.ElapsedMilliseconds > 300);
            tracker.AssertSettled();

            spawned = new(TaskCreationOptions.RunContinuationsAsynchronously);
            command.Argv = [Path.Combine(Environment.SystemDirectory, "cmd.exe"),
                "/d", "/s", "/c", "ping -n 30 127.0.0.1 >nul"];
            var run = MxcNoTimeoutRunner.RunAsync(executor, command, cancel.Token);
            await spawned.Task.WaitAsync(TimeSpan.FromSeconds(30), TestContext.Current.CancellationToken);
            cancel.Cancel();
            await Assert.ThrowsAnyAsync<OperationCanceledException>(() => run);
            await executor.WaitForOwnedOperationsAsync(TestContext.Current.CancellationToken);
            tracker.AssertSettled();
            Assert.Empty(Directory.GetDirectories(fixture.Runs));
        }
        finally
        {
            cancel.Cancel();
            await executor.WaitForOwnedOperationsAsync(CancellationToken.None)
                .WaitAsync(TimeSpan.FromSeconds(30), TestContext.Current.CancellationToken);
        }
    }

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

    private sealed class ExecutorFixture : IDisposable
    {
        private readonly string _root = Path.Combine(
            Environment.GetEnvironmentVariable("MICROCLAW_MXC_NATIVE_TEST_SCRATCH") ?? Path.GetTempPath(),
            "microclaw-mxc-timeout-" + Guid.NewGuid().ToString("N"));
        private readonly MxcRequestContext _context;
        public string Runs => Path.Combine(_root, "runs");
        public string DeniedPath => Path.Combine(_root, "profile", ".ssh");

        public ExecutorFixture()
        {
            var profile = Path.Combine(_root, "profile");
            var folders = new[]
            {
                new MxcUserFolder("Profile", profile),
                new MxcUserFolder("Documents", Path.Combine(profile, "Documents")),
                new MxcUserFolder("Desktop", Path.Combine(profile, "Desktop")),
                new MxcUserFolder("Downloads", Path.Combine(_root, "downloads")),
                new MxcUserFolder("OneDrive", Path.Combine(_root, "onedrive"), IsOptional: true),
            };
            foreach (var folder in folders) Directory.CreateDirectory(folder.Path!);
            Directory.CreateDirectory(DeniedPath);
            _context = new MxcRequestContext
            {
                WindowsDirectory = Environment.GetFolderPath(Environment.SpecialFolder.Windows),
                SystemDirectory = Environment.SystemDirectory,
                UserFolders = folders,
                ProtectedPaths = [DeniedPath],
            };
        }

        public CommandRequest Command() => new()
        {
            Argv = [Path.Combine(Environment.SystemDirectory, "whoami.exe")],
            TimeoutMs = 0,
        };

        public NodeSandboxExecutor CreateExecutor(MxcProcessTracker tracker, long outputBudget = 4 * 1024 * 1024) =>
            new(new NodeSandboxPolicyStore(new SettingsData
                { SandboxTimeoutMs = 300, SandboxMaxOutputBytes = outputBudget }),
                () => Path.Combine(_root, "settings"),
                () => new MxcAvailability(true, false, true, [],
                    isolationTier: "base-container", supportsProtectedPathDenies: true),
                spawn: tracker.SpawnAsync,
                probe: _ => new ProbeOutput
                {
                    Tier = IsolationTier.BaseContainer,
                    NeedsDaclAugmentation = false,
                    Probes = new()
                    {
                        BaseContainerApiPresent = true,
                        BaseContainerSupportsDenyPaths = true,
                        UiCapabilities = new(),
                    },
                },
                scratchRoot: Runs,
                contextProvider: () => _context);

        public NodeSandboxExecutor CreateNativeExecutor(MxcProcessTracker tracker) =>
            new(new NodeSandboxPolicyStore(new SettingsData { SandboxTimeoutMs = 300 }),
                () => Path.Combine(_root, "settings"),
                spawn: tracker.SpawnAsync,
                scratchRoot: Runs,
                contextProvider: () => _context);

        public void Dispose()
        {
            if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
        }
    }

    private sealed class ControlledProcess(string output) : IMxcProcess
    {
        private readonly TaskCompletionSource<WaitResult> _exit = new(TaskCreationOptions.RunContinuationsAsynchronously);
        private readonly MemoryStream _input = new();
        private readonly MemoryStream _output = new(Encoding.UTF8.GetBytes(output));
        private readonly MemoryStream _error = new();
        private int _killed;
        public TaskCompletionSource Started { get; } = new(TaskCreationOptions.RunContinuationsAsynchronously);
        public bool Killed => Volatile.Read(ref _killed) != 0;
        public bool Disposed { get; private set; }
        public uint Id => 0;
        public Stream? StandardInput => _input;
        public Stream? StandardOutput => _output;
        public Stream? StandardError => _error;
        public IMxcStreamCloser? StandardOutputCloser => null;
        public IMxcStreamCloser? StandardErrorCloser => null;
        public IReadOnlyList<string> Warnings => [];
        public ExecutionMetadata? OutputMetadata => null;
        public void Complete() => _exit.TrySetResult(new WaitResult { ExitCode = 0 });
        public WaitResult Wait() => _exit.Task.GetAwaiter().GetResult();
        public Task<WaitResult> WaitAsync(CancellationToken cancellationToken = default) => _exit.Task;
        public bool TryGetExitCode(out int exitCode)
        {
            Started.TrySetResult();
            exitCode = 0;
            return _exit.Task.IsCompleted;
        }
        public Task<(WaitResult Result, byte[] Stdout, byte[] Stderr)> WaitForExitWithOutputAsync(
            CancellationToken cancellationToken = default) => throw new NotSupportedException();
        public void Kill()
        {
            Interlocked.Exchange(ref _killed, 1);
            Complete();
        }
        public void Dispose()
        {
            Disposed = true;
            _input.Dispose();
            _output.Dispose();
            _error.Dispose();
        }
    }
}
