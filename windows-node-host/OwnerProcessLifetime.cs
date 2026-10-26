using System.Diagnostics;

namespace MicroClaw.WindowsNodeHost;

internal static class OwnerProcessLifetime
{
    public static async Task WaitForExitAsync(int ownerProcessId)
    {
        if (ownerProcessId <= 0)
            throw new HostPolicyException(
                "owner-process-missing",
                "The MicroClaw owner process identity is missing.");

        Process owner;
        try
        {
            owner = Process.GetProcessById(ownerProcessId);
        }
        catch (ArgumentException)
        {
            throw new HostPolicyException(
                "owner-process-exited",
                "The MicroClaw owner process exited before the bundled node started.");
        }

        using (owner)
            await owner.WaitForExitAsync();
    }
}
