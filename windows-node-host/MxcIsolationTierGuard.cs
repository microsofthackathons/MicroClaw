using OpenClaw.Shared.Mxc;

namespace MicroClaw.WindowsNodeHost;

internal static class MxcIsolationTierGuard
{
    internal static MxcAvailability RequireAvailability(string? expectedTier)
    {
        var availability = MxcAvailability.Probe(new StderrLogger());
        ValidateAvailability(availability, expectedTier);
        return availability;
    }

    internal static void ValidateAvailability(MxcAvailability availability, string? expectedTier)
    {
        if (availability.ProbeErrored || availability.IsWindowsUnsupported || !availability.CanRunSystemRunSandbox)
            throw new HostPolicyException(
                availability.IsWindowsUnsupported ? "mxc-windows-unsupported" : "mxc-probe-failed",
                availability.SystemRunSandboxUnsupportedReasons.Count > 0
                    ? string.Join(" ", availability.SystemRunSandboxUnsupportedReasons)
                    : "MXC availability is contradictory or the platform probe failed.");
        if (expectedTier is not null &&
            !string.Equals(expectedTier, availability.IsolationTier, StringComparison.OrdinalIgnoreCase))
            throw new HostPolicyException(
                "mxc-filesystem-isolation-drift",
                $"MXC isolation tier changed from {expectedTier} to {availability.IsolationTier}.");
    }

    internal static Task EnsureFilesystemIsolationAsync(
        string requestedStrength, string? expectedTier, CancellationToken cancellationToken = default)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (requestedStrength != "full")
            throw new HostPolicyException(
                "mxc-containment-strength-invalid",
                $"Unsupported containment strength: {requestedStrength}.");
        _ = RequireAvailability(expectedTier);
        cancellationToken.ThrowIfCancellationRequested();
        return Task.CompletedTask;
    }
}
