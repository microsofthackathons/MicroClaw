using OpenClaw.Shared;

namespace MicroClaw.WindowsNodeHost;

internal sealed class NodeDeviceTokenRecovery
{
    private bool attempted;

    public bool TryRecover(
        GatewayErrorKind failureKind,
        string identityDirectory,
        string expectedNodeId,
        Func<bool> gatewayOwnershipValid,
        IOpenClawLogger logger,
        out string rejectionReason)
    {
        rejectionReason = string.Empty;
        if (failureKind != GatewayErrorKind.DeviceTokenMismatch)
        {
            rejectionReason = $"connection failure {failureKind} is not recoverable";
            return false;
        }
        if (attempted)
        {
            rejectionReason = "node device-token recovery was already attempted for this host generation";
            return false;
        }
        attempted = true;

        if (!gatewayOwnershipValid())
        {
            rejectionReason = "the expected MicroClaw Gateway no longer owns the loopback listener";
            return false;
        }

        var identity = new DeviceIdentity(identityDirectory, logger);
        identity.Initialize();
        if (!string.Equals(identity.DeviceId, expectedNodeId, StringComparison.OrdinalIgnoreCase))
        {
            rejectionReason = "the persisted bundled node identity does not match the configured node";
            return false;
        }
        if (!DeviceIdentity.TryClearDeviceTokenForRole(identityDirectory, "node", logger))
        {
            rejectionReason = "the exact bundled identity had no stale node device token to clear";
            return false;
        }
        if (!gatewayOwnershipValid())
        {
            rejectionReason = "the expected MicroClaw Gateway changed while clearing the stale node token";
            return false;
        }

        return true;
    }
}
