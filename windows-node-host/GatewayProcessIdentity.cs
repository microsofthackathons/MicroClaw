using System.Diagnostics;

namespace MicroClaw.WindowsNodeHost;

internal sealed class GatewayProcessIdentity : IDisposable
{
    private readonly Process process;
    private readonly long startTimeUtcTicks;

    private GatewayProcessIdentity(Process process, long startTimeUtcTicks)
    {
        this.process = process;
        this.startTimeUtcTicks = startTimeUtcTicks;
    }

    public static GatewayProcessIdentity Capture(int processId)
    {
        if (processId <= 0)
            throw new HostPolicyException(
                "gateway-process-missing",
                "The app-owned Gateway process identity is missing.");

        try
        {
            var process = Process.GetProcessById(processId);
            _ = process.Handle;
            var startTimeUtcTicks = process.StartTime.ToUniversalTime().Ticks;
            if (process.HasExited)
            {
                process.Dispose();
                throw new HostPolicyException(
                    "gateway-process-exited",
                    "The app-owned Gateway exited before the bundled node started.");
            }
            return new GatewayProcessIdentity(process, startTimeUtcTicks);
        }
        catch (HostPolicyException)
        {
            throw;
        }
        catch (Exception ex) when (
            ex is ArgumentException
                or InvalidOperationException
                or System.ComponentModel.Win32Exception
                or NotSupportedException)
        {
            throw new HostPolicyException(
                "gateway-process-unavailable",
                $"The app-owned Gateway process identity could not be pinned: {ex.Message}");
        }
    }

    public bool IsCurrentLoopbackListenerOwner(int port)
    {
        try
        {
            return MatchesPinnedProcess(
                    process.HasExited,
                    process.Id,
                    process.Id,
                    process.StartTime.ToUniversalTime().Ticks,
                    startTimeUtcTicks)
                && GatewayListenerOwnership.IsLoopbackListenerOwnedBy(port, process.Id);
        }
        catch (Exception ex) when (
            ex is InvalidOperationException
                or System.ComponentModel.Win32Exception
                or NotSupportedException)
        {
            return false;
        }
    }

    internal static bool MatchesPinnedProcess(
        bool hasExited,
        int observedProcessId,
        int expectedProcessId,
        long observedStartTimeUtcTicks,
        long expectedStartTimeUtcTicks) =>
        !hasExited
        && observedProcessId == expectedProcessId
        && observedStartTimeUtcTicks == expectedStartTimeUtcTicks;

    public void Dispose() => process.Dispose();
}
