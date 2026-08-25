using System.Security.AccessControl;
using System.Security.Principal;
using MicroClaw.MxcHostPrep;
using Xunit;

namespace MicroClaw.MxcHostPrep.Tests;

public sealed class SystemDrivePreparationTests : IDisposable
{
    private const int MetadataReadMask = 0x0012_0088;
    private const int ConflictingReadMask = 0x0012_0089;

    private static readonly SecurityIdentifier AllApplicationPackages =
        new("S-1-15-2-1");

    private readonly string root = Path.Combine(
        Path.GetTempPath(),
        $"microclaw-mxc-host-prep-{Guid.NewGuid():N}");

    public SystemDrivePreparationTests()
    {
        Directory.CreateDirectory(root);
    }

    [Fact]
    public void PrepareAndRevokeLeaveExistingChildDaclByteForByteUnchanged()
    {
        var child = Directory.CreateDirectory(Path.Combine(root, "existing-child")).FullName;
        var childBefore = TargetOnlyDacl.ReadDaclBytes(child);

        TargetOnlyDacl.AddExplicitBasicAce(
            root,
            new SecurityIdentifier(WellKnownSidType.WorldSid, null),
            ConflictingReadMask,
            AceQualifier.AccessAllowed,
            AceFlags.ContainerInherit | AceFlags.ObjectInherit);
        Assert.Equal(childBefore, TargetOnlyDacl.ReadDaclBytes(child));

        SystemDrivePreparation.ApplyAll(root);
        Assert.Equal(childBefore, TargetOnlyDacl.ReadDaclBytes(child));

        SystemDrivePreparation.RevokeAll(root);
        Assert.Equal(childBefore, TargetOnlyDacl.ReadDaclBytes(child));
    }

    [Fact]
    public void PrepareAndRevokeAreIdempotent()
    {
        SystemDrivePreparation.ApplyAll(root);
        var afterFirstPrepare = TargetOnlyDacl.ReadDaclBytes(root);

        SystemDrivePreparation.ApplyAll(root);
        Assert.Equal(afterFirstPrepare, TargetOnlyDacl.ReadDaclBytes(root));
        Assert.Single(TargetOnlyDacl.ScanExplicitBasicAces(root, AllApplicationPackages));

        SystemDrivePreparation.RevokeAll(root);
        var afterFirstRevoke = TargetOnlyDacl.ReadDaclBytes(root);

        SystemDrivePreparation.RevokeAll(root);
        Assert.Equal(afterFirstRevoke, TargetOnlyDacl.ReadDaclBytes(root));
        Assert.Empty(TargetOnlyDacl.ScanExplicitBasicAces(root, AllApplicationPackages));
    }

    [Fact]
    public void PrepareRejectsAndPreservesAConflictingAce()
    {
        TargetOnlyDacl.AddExplicitBasicAce(
            root,
            AllApplicationPackages,
            ConflictingReadMask,
            AceQualifier.AccessAllowed,
            AceFlags.None);
        var before = TargetOnlyDacl.ReadDaclBytes(root);

        var exception = Assert.Throws<ConflictingAceException>(
            () => SystemDrivePreparation.ApplyAll(root));

        Assert.Contains("0x00120089", exception.Message, StringComparison.Ordinal);
        Assert.Equal(before, TargetOnlyDacl.ReadDaclBytes(root));
    }

    [Fact]
    public void PreciseRevokePreservesNonMatchingAceForSameSid()
    {
        TargetOnlyDacl.AddExplicitBasicAce(
            root,
            AllApplicationPackages,
            ConflictingReadMask,
            AceQualifier.AccessAllowed,
            AceFlags.None);
        TargetOnlyDacl.AddExplicitBasicAce(
            root,
            AllApplicationPackages,
            MetadataReadMask,
            AceQualifier.AccessAllowed,
            AceFlags.None);

        SystemDrivePreparation.RevokeAll(root);

        var remaining = Assert.Single(
            TargetOnlyDacl.ScanExplicitBasicAces(root, AllApplicationPackages));
        Assert.Equal(ConflictingReadMask, remaining.AccessMask);
        Assert.Equal(AceQualifier.AccessAllowed, remaining.Qualifier);
        Assert.Equal(AceFlags.None, remaining.Flags);
    }

    [Fact]
    public void PrepareAndRevokePreserveCallbackAceForSameSid()
    {
        TargetOnlyDacl.AddExplicitBasicAce(
            root,
            AllApplicationPackages,
            MetadataReadMask,
            AceQualifier.AccessAllowed,
            AceFlags.None,
            isCallback: true);
        var callbackOnly = TargetOnlyDacl.ReadDaclBytes(root);

        SystemDrivePreparation.ApplyAll(root);
        Assert.Single(TargetOnlyDacl.ScanExplicitBasicAces(root, AllApplicationPackages));

        SystemDrivePreparation.RevokeAll(root);
        Assert.Equal(callbackOnly, TargetOnlyDacl.ReadDaclBytes(root));
    }

    [Fact]
    public void ExplicitTargetMustAlreadyBeALiteralDriveRoot()
    {
        Assert.Throws<HostPreparationException>(
            () => SystemDrivePreparation.ResolveAndValidateTarget("C:"));
        Assert.Equal(
            Path.GetFullPath(@"C:\"),
            SystemDrivePreparation.ResolveAndValidateTarget(@"C:\"));
    }

    public void Dispose()
    {
        Directory.Delete(root, recursive: true);
    }
}
