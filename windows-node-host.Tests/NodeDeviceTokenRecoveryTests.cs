using OpenClaw.Shared;

namespace MicroClaw.WindowsNodeHost.Tests;

public sealed class NodeDeviceTokenRecoveryTests : IDisposable
{
    private readonly string identityDirectory =
        Path.Combine(Path.GetTempPath(), $"microclaw-node-recovery-{Guid.NewGuid():N}");

    [Fact]
    public void ExactIdentityAndOwnedGateway_ClearOnlyNodeTokenOnce()
    {
        var identity = CreateIdentity();
        identity.StoreDeviceTokenForRole("operator", "operator-token", ["operator.read"]);
        identity.StoreDeviceTokenForRole("node", "stale-node-token", ["node"]);
        var expectedId = identity.DeviceId;
        var recovery = new NodeDeviceTokenRecovery();

        var recovered = recovery.TryRecover(
            GatewayErrorKind.DeviceTokenMismatch,
            identityDirectory,
            expectedId,
            () => true,
            NullLogger.Instance,
            out var rejectionReason);

        Assert.True(recovered);
        Assert.Empty(rejectionReason);
        Assert.Equal(
            "operator-token",
            DeviceIdentity.TryReadStoredDeviceTokenForRole(
                identityDirectory,
                "operator",
                NullLogger.Instance));
        Assert.Null(
            DeviceIdentity.TryReadStoredDeviceTokenForRole(
                identityDirectory,
                "node",
                NullLogger.Instance));
        var persisted = new DeviceIdentity(identityDirectory, NullLogger.Instance);
        persisted.Initialize();
        Assert.Equal(expectedId, persisted.DeviceId);

        persisted.StoreDeviceTokenForRole("node", "new-node-token", ["node"]);
        Assert.False(
            recovery.TryRecover(
                GatewayErrorKind.DeviceTokenMismatch,
                identityDirectory,
                expectedId,
                () => true,
                NullLogger.Instance,
                out rejectionReason));
        Assert.Contains("already attempted", rejectionReason);
        Assert.Equal(
            "new-node-token",
            DeviceIdentity.TryReadStoredDeviceTokenForRole(
                identityDirectory,
                "node",
                NullLogger.Instance));
    }

    [Fact]
    public void ForeignIdentityFailsClosedWithoutClearingToken()
    {
        var identity = CreateIdentity();
        identity.StoreDeviceTokenForRole("node", "stale-node-token", ["node"]);
        var recovery = new NodeDeviceTokenRecovery();

        Assert.False(
            recovery.TryRecover(
                GatewayErrorKind.DeviceTokenMismatch,
                identityDirectory,
                new string('f', 64),
                () => true,
                NullLogger.Instance,
                out var rejectionReason));

        Assert.Contains("does not match", rejectionReason);
        Assert.Equal(
            "stale-node-token",
            DeviceIdentity.TryReadStoredDeviceTokenForRole(
                identityDirectory,
                "node",
                NullLogger.Instance));
    }

    [Fact]
    public void GatewayOwnershipChangeFailsClosedWithoutClearingToken()
    {
        var identity = CreateIdentity();
        identity.StoreDeviceTokenForRole("node", "stale-node-token", ["node"]);
        var recovery = new NodeDeviceTokenRecovery();

        Assert.False(
            recovery.TryRecover(
                GatewayErrorKind.DeviceTokenMismatch,
                identityDirectory,
                identity.DeviceId,
                () => false,
                NullLogger.Instance,
                out var rejectionReason));

        Assert.Contains("no longer owns", rejectionReason);
        Assert.Equal(
            "stale-node-token",
            DeviceIdentity.TryReadStoredDeviceTokenForRole(
                identityDirectory,
                "node",
                NullLogger.Instance));
    }

    [Theory]
    [InlineData(GatewayErrorKind.Auth)]
    [InlineData(GatewayErrorKind.ScopeMismatch)]
    [InlineData(GatewayErrorKind.TokenDrift)]
    [InlineData(GatewayErrorKind.PairingRequired)]
    public void OtherConnectionFailuresNeverClearNodeToken(GatewayErrorKind failureKind)
    {
        var identity = CreateIdentity();
        identity.StoreDeviceTokenForRole("node", "stale-node-token", ["node"]);
        var recovery = new NodeDeviceTokenRecovery();

        Assert.False(
            recovery.TryRecover(
                failureKind,
                identityDirectory,
                identity.DeviceId,
                () => true,
                NullLogger.Instance,
                out var rejectionReason));

        Assert.Contains("not recoverable", rejectionReason);
        Assert.Equal(
            "stale-node-token",
            DeviceIdentity.TryReadStoredDeviceTokenForRole(
                identityDirectory,
                "node",
                NullLogger.Instance));
    }

    public void Dispose()
    {
        if (Directory.Exists(identityDirectory))
            Directory.Delete(identityDirectory, recursive: true);
    }

    private DeviceIdentity CreateIdentity()
    {
        Directory.CreateDirectory(identityDirectory);
        var identity = new DeviceIdentity(identityDirectory, NullLogger.Instance);
        identity.Initialize();
        return identity;
    }
}
