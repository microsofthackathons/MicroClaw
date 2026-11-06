using MicroClaw.WindowsNodeHost;

namespace MicroClaw.WindowsNodeHost.Tests;

public sealed class GatewayProcessIdentityTests
{
    [Fact]
    public void ExactLiveProcessIdentityMatches()
    {
        Assert.True(
            GatewayProcessIdentity.MatchesPinnedProcess(
                hasExited: false,
                observedProcessId: 1234,
                expectedProcessId: 1234,
                observedStartTimeUtcTicks: 5678,
                expectedStartTimeUtcTicks: 5678));
    }

    [Fact]
    public void ReusedPidFailsWhenPinnedProcessHandleHasExited()
    {
        Assert.False(
            GatewayProcessIdentity.MatchesPinnedProcess(
                hasExited: true,
                observedProcessId: 1234,
                expectedProcessId: 1234,
                observedStartTimeUtcTicks: 5678,
                expectedStartTimeUtcTicks: 5678));
    }

    [Fact]
    public void DifferentPidOrStartTimeFailsClosed()
    {
        Assert.False(
            GatewayProcessIdentity.MatchesPinnedProcess(
                hasExited: false,
                observedProcessId: 9999,
                expectedProcessId: 1234,
                observedStartTimeUtcTicks: 5678,
                expectedStartTimeUtcTicks: 5678));
        Assert.False(
            GatewayProcessIdentity.MatchesPinnedProcess(
                hasExited: false,
                observedProcessId: 1234,
                expectedProcessId: 1234,
                observedStartTimeUtcTicks: 9999,
                expectedStartTimeUtcTicks: 5678));
    }
}
