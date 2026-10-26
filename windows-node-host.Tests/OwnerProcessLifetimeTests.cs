using System.Diagnostics;
using MicroClaw.WindowsNodeHost;
using Xunit;

namespace MicroClaw.WindowsNodeHost.Tests;

public sealed class OwnerProcessLifetimeTests
{
    [Fact]
    public async Task WaitForExitAsync_TracksTheOpenedOwnerProcess()
    {
        using var owner = Process.Start(new ProcessStartInfo(
            "cmd.exe",
            "/d /c ping 127.0.0.1 -n 30 >nul")
        {
            CreateNoWindow = true,
            UseShellExecute = false,
        }) ?? throw new InvalidOperationException("Could not start owner test process.");

        var lifetime = OwnerProcessLifetime.WaitForExitAsync(owner.Id);
        Assert.False(lifetime.IsCompleted);

        owner.Kill(entireProcessTree: true);
        await lifetime.WaitAsync(TimeSpan.FromSeconds(5), TestContext.Current.CancellationToken);
    }

    [Fact]
    public async Task WaitForExitAsync_RejectsMissingOwnerIdentity()
    {
        var error = await Assert.ThrowsAsync<HostPolicyException>(
            () => OwnerProcessLifetime.WaitForExitAsync(0));

        Assert.Equal("owner-process-missing", error.Code);
    }
}
