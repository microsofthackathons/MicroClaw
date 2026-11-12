using Microsoft.Mxc.Sdk.V1;

namespace MicroClaw.WindowsNodeHost;

internal sealed class MxcProcessTracker(
    Func<ContainerRequest, Task<IMxcProcess>>? spawn = null)
{
    private readonly object _gate = new();
    private readonly HashSet<TrackedProcess> _processes = [];
    private bool _uncertain;

    internal async Task<IMxcProcess> SpawnAsync(ContainerRequest request)
    {
        lock (_gate)
        {
            if (_uncertain)
                throw new HostPolicyException("mxc-process-uncertain",
                    "A previous MXC launch could not be accounted for. Restart MicroClaw before changing security settings.");
        }

        IMxcProcess process;
        try
        {
            process = await (spawn ?? SpawnSdkProcessAsync)(request).ConfigureAwait(false);
        }
        catch
        {
            lock (_gate) _uncertain = true;
            throw;
        }

        var tracked = new TrackedProcess(this, process);
        lock (_gate) _processes.Add(tracked);
        return tracked;
    }

    internal void AssertSettled()
    {
        lock (_gate)
        {
            if (_uncertain || _processes.Count != 0)
                throw new HostPolicyException("mxc-process-uncertain",
                    "An MXC process could not be confirmed stopped. Restart MicroClaw before changing security settings.");
        }
    }

    private static async Task<IMxcProcess> SpawnSdkProcessAsync(ContainerRequest request) =>
        await MxcContainer.SpawnAsync(
            request, new SpawnOptions { Telemetry = new TelemetryConfig { Enabled = false } },
            CancellationToken.None).ConfigureAwait(false);

    private void Complete(TrackedProcess process, bool settled)
    {
        lock (_gate)
        {
            _processes.Remove(process);
            if (!settled) _uncertain = true;
        }
    }

    private sealed class TrackedProcess(MxcProcessTracker owner, IMxcProcess process) : IMxcProcess
    {
        private bool _waitSucceeded;
        private bool _disposed;

        public uint Id => process.Id;
        public Stream? StandardInput => process.StandardInput;
        public Stream? StandardOutput => process.StandardOutput;
        public Stream? StandardError => process.StandardError;
        public IMxcStreamCloser? StandardOutputCloser => process.StandardOutputCloser;
        public IMxcStreamCloser? StandardErrorCloser => process.StandardErrorCloser;
        public IReadOnlyList<string> Warnings => process.Warnings;
        public ExecutionMetadata? OutputMetadata => process.OutputMetadata;

        public WaitResult Wait()
        {
            var result = process.Wait();
            _waitSucceeded = !result.TimedOut;
            return result;
        }

        public async Task<WaitResult> WaitAsync(CancellationToken cancellationToken)
        {
            var result = await process.WaitAsync(cancellationToken).ConfigureAwait(false);
            _waitSucceeded = !result.TimedOut;
            return result;
        }

        public bool TryGetExitCode(out int exitCode) => process.TryGetExitCode(out exitCode);

        public async Task<(WaitResult, byte[], byte[])> WaitForExitWithOutputAsync(
            CancellationToken cancellationToken)
        {
            var result = await process.WaitForExitWithOutputAsync(cancellationToken).ConfigureAwait(false);
            _waitSucceeded = !result.Item1.TimedOut;
            return result;
        }

        public void Kill() => process.Kill();

        public void Dispose()
        {
            if (_disposed) return;
            _disposed = true;
            var disposed = false;
            try
            {
                process.Dispose();
                disposed = true;
            }
            finally
            {
                owner.Complete(this, _waitSucceeded && disposed);
            }
        }
    }
}
