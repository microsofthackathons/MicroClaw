using MicroClaw.WindowsNodeHost;
using System.Net;
using System.Net.Sockets;
using Xunit;

namespace MicroClaw.WindowsNodeHost.Tests;

public sealed class CwdPolicyTests : IDisposable
{
    private readonly string _root = Path.Combine(Path.GetTempPath(), "microclaw-cwd-tests-" + Guid.NewGuid().ToString("N"));

    public CwdPolicyTests()
    {
        Directory.CreateDirectory(_root);
    }

    [Fact]
    public void OmittedCwdUsesBoundScratchSemantic()
    {
        var policy = Policy([new ApprovedRoot(_root, FolderAccess.ReadOnly)]);

        var result = policy.ResolveCwd(null);

        Assert.Equal(CwdPolicyContract.ScratchBinding, result.ApprovalBinding);
        Assert.Equal(FolderAccess.ReadWrite, result.Access);
    }

    [Theory]
    [InlineData(@"\\server\share")]
    [InlineData(@"\\?\C:\Windows")]
    [InlineData(@"\??\C:\Windows")]
    [InlineData(@"\Device\HarddiskVolume1")]
    public void RejectsNonLocalPathNamespaces(string path)
    {
        var error = Assert.Throws<HostPolicyException>(() => WindowsPathCanonicalizer.CanonicalizeDirectory(path));
        Assert.Equal("path-nonlocal", error.Code);
    }

    [Fact]
    public void CanonicalizesDotSegmentsAndInheritsExactRootAccess()
    {
        var child = Directory.CreateDirectory(Path.Combine(_root, "approved", "child")).FullName;
        var approved = Path.Combine(_root, "approved");
        var policy = Policy([new ApprovedRoot(WindowsPathCanonicalizer.CanonicalizeDirectory(approved), FolderAccess.ReadOnly)]);

        var result = policy.ResolveCwd(Path.Combine(child, "..", "child"));

        Assert.Equal(WindowsPathCanonicalizer.CanonicalizeDirectory(child), result.LaunchPath, ignoreCase: true);
        Assert.Equal(FolderAccess.ReadOnly, result.Access);
    }

    [Fact]
    public void PreservesDriveRootAsFullyQualified()
    {
        var root = Path.GetPathRoot(_root)!;

        var canonical = WindowsPathCanonicalizer.CanonicalizeDirectory(root);

        Assert.Equal(root, canonical, ignoreCase: true);
        Assert.True(Path.IsPathFullyQualified(canonical));
    }

    [Fact]
    public void DeniesOutsideAndSensitiveRoots()
    {
        var approved = Directory.CreateDirectory(Path.Combine(_root, "approved")).FullName;
        var sensitive = Directory.CreateDirectory(Path.Combine(approved, "secrets")).FullName;
        var outside = Directory.CreateDirectory(Path.Combine(_root, "outside")).FullName;
        var policy = Policy(
            [new ApprovedRoot(WindowsPathCanonicalizer.CanonicalizeDirectory(approved), FolderAccess.ReadWrite)],
            [WindowsPathCanonicalizer.CanonicalizeDirectory(sensitive)]);

        Assert.Equal("cwd-sensitive-root", Assert.Throws<HostPolicyException>(() => policy.ResolveCwd(sensitive)).Code);
        Assert.Equal("cwd-outside-approved-roots", Assert.Throws<HostPolicyException>(() => policy.ResolveCwd(outside)).Code);
    }

    [Fact]
    public void RejectsJunctionComponent()
    {
        var target = Directory.CreateDirectory(Path.Combine(_root, "target")).FullName;
        var link = Path.Combine(_root, "link");
        Directory.CreateSymbolicLink(link, target);

        var error = Assert.Throws<HostPolicyException>(() => WindowsPathCanonicalizer.CanonicalizeDirectory(link));

        Assert.Equal("path-reparse-point", error.Code);
    }

    [Fact]
    public void LaunchRevalidationRejectsChangedCwdBinding()
    {
        var first = Directory.CreateDirectory(Path.Combine(_root, "first")).FullName;
        var second = Directory.CreateDirectory(Path.Combine(_root, "second")).FullName;
        var policy = Policy([new ApprovedRoot(WindowsPathCanonicalizer.CanonicalizeDirectory(_root), FolderAccess.ReadWrite)]);
        var approved = policy.ResolveCwd(first);

        var error = Assert.Throws<HostPolicyException>(() => policy.RevalidateCwd(second, approved.ApprovalBinding));

        Assert.Equal("cwd-binding-changed", error.Code);
    }

    [Fact]
    public void DirectoryLeaseBlocksCwdReplacementThroughLaunchWindow()
    {
        var cwd = Directory.CreateDirectory(Path.Combine(_root, "leased-cwd")).FullName;
        var replacement = Path.Combine(_root, "moved-cwd");
        using (DirectoryPathLease.Acquire([cwd]))
        {
            Assert.Throws<IOException>(() => Directory.Move(cwd, replacement));
        }
        Directory.Move(cwd, replacement);
        Assert.True(Directory.Exists(replacement));
    }

    [Fact]
    public void DurableApprovalBindsExecutableArgsAndCwd()
    {
        var executable = Path.Combine(Environment.SystemDirectory, "hostname.exe");
        var first = WindowsPathCanonicalizer.CanonicalizeDirectory(_root);
        var second = Directory.CreateDirectory(Path.Combine(_root, "second")).FullName;
        var approval = DurableApprovalIdentity.Create(executable, ["--example"], first);

        Assert.True(DurableApprovalIdentity.Matches(approval, executable, ["--example"], first));
        Assert.False(DurableApprovalIdentity.Matches(approval, executable, ["--other"], first));
        Assert.False(DurableApprovalIdentity.Matches(approval, executable, ["--example"], second));
        Assert.False(DurableApprovalIdentity.Matches(approval with { SchemaVersion = 1, CwdBinding = "" }, executable, ["--example"], first));
    }

    [Fact]
    public void ApprovalIdentityDetectsExecutableReplacement()
    {
        var executable = Path.Combine(_root, "replaceable.exe");
        File.Copy(Path.Combine(Environment.SystemDirectory, "hostname.exe"), executable);
        var approved = DurableApprovalIdentity.Create(executable, [], CwdPolicyContract.ScratchBinding);
        File.AppendAllText(executable, "changed");
        var current = DurableApprovalIdentity.Create(executable, [], CwdPolicyContract.ScratchBinding);

        Assert.False(DurableApprovalIdentity.Matches(approved, current));
    }

    [Fact]
    public void ExecutableLeaseBlocksReplacementThroughLaunchWindow()
    {
        var executable = Path.Combine(_root, "locked.exe");
        File.Copy(Path.Combine(Environment.SystemDirectory, "hostname.exe"), executable);
        using var lease = ExecutableApprovalLease.Acquire(executable);
        var approved = lease.Capture([], CwdPolicyContract.ScratchBinding);

        Assert.Throws<IOException>(() => File.AppendAllText(executable, "changed"));
        Assert.True(
            DurableApprovalIdentity.Matches(
                approved,
                lease.Capture([], CwdPolicyContract.ScratchBinding)));
    }

    [Fact]
    public void GatewayOwnershipRequiresCurrentLoopbackListenerProcess()
    {
        using var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        var port = ((IPEndPoint)listener.LocalEndpoint).Port;

        Assert.True(GatewayListenerOwnership.IsLoopbackListenerOwnedBy(port, Environment.ProcessId));
        Assert.False(GatewayListenerOwnership.IsLoopbackListenerOwnedBy(port, Environment.ProcessId + 1));
        listener.Stop();
        Assert.False(GatewayListenerOwnership.IsLoopbackListenerOwnedBy(port, Environment.ProcessId));
    }

    [Fact]
    public void AttestationRequiresEverySecurityProperty()
    {
        var attestation = CwdPolicyAttestation.Current;

        Assert.Equal("microclaw.windows-cwd.v1", attestation.Contract);
        Assert.True(attestation.ApprovedRootOnly);
        Assert.True(attestation.CanonicalFinalPath);
        Assert.True(attestation.RejectsReparseComponents);
        Assert.True(attestation.DurableApprovalBindsCwd);
        Assert.True(attestation.LaunchTimeRevalidation);
        Assert.True(attestation.OmittedCwdUsesIsolatedScratch);
        Assert.True(attestation.HostFallbackAbsent);
    }

    [Fact]
    public void AttestationUsesTheVersionedCamelCaseWireContract()
    {
        using var document = System.Text.Json.JsonDocument.Parse(
            System.Text.Json.JsonSerializer.Serialize(CwdPolicyAttestation.Current));
        var root = document.RootElement;

        Assert.Equal("microclaw.windows-cwd.v1", root.GetProperty("contract").GetString());
        Assert.True(root.GetProperty("approvedRootOnly").GetBoolean());
        Assert.True(root.GetProperty("canonicalFinalPath").GetBoolean());
        Assert.True(root.GetProperty("rejectsReparseComponents").GetBoolean());
        Assert.True(root.GetProperty("durableApprovalBindsCwd").GetBoolean());
        Assert.True(root.GetProperty("launchTimeRevalidation").GetBoolean());
        Assert.True(root.GetProperty("omittedCwdUsesIsolatedScratch").GetBoolean());
        Assert.True(root.GetProperty("hostFallbackAbsent").GetBoolean());
        Assert.False(root.TryGetProperty("Contract", out _));
    }

    [Fact]
    public async Task LoadsElectronPolicyWithNamedFolderAccess()
    {
        var wxc = Path.Combine(Environment.SystemDirectory, "hostname.exe");
        var policyPath = Path.Combine(_root, "policy.json");
        await File.WriteAllTextAsync(
            policyPath,
            $$"""
            {
              "approvedRoots": [
                { "path": {{System.Text.Json.JsonSerializer.Serialize(_root)}}, "access": "ReadOnly" }
              ],
              "deniedRoots": [],
              "wxcExecPath": {{System.Text.Json.JsonSerializer.Serialize(wxc)}},
              "networkAllowed": false,
              "allowWindowsUi": true,
              "clipboard": "none",
              "inputInjection": false,
              "strictNoHostFallback": true
            }
            """,
            TestContext.Current.CancellationToken);

        var policy = await HostPolicy.LoadAsync(policyPath);

        Assert.Equal(FolderAccess.ReadOnly, Assert.Single(policy.ApprovedRoots).Access);
    }

    [Fact]
    public async Task RejectsUnknownFolderAccessAsMalformedPolicy()
    {
        var policyPath = Path.Combine(_root, "invalid-policy.json");
        await File.WriteAllTextAsync(
            policyPath,
            $$"""
            {
              "approvedRoots": [
                { "path": {{System.Text.Json.JsonSerializer.Serialize(_root)}}, "access": "Owner" }
              ]
            }
            """,
            TestContext.Current.CancellationToken);

        var error = await Assert.ThrowsAsync<HostPolicyException>(() => HostPolicy.LoadAsync(policyPath));

        Assert.Equal("malformed-policy", error.Code);
    }

    [Fact]
    public async Task MissingProtectedRootRemainsDeniedIfCreatedLater()
    {
        var protectedRoot = Path.Combine(_root, "future-credentials");
        var approvedRoot = Directory.CreateDirectory(Path.Combine(_root, "approved")).FullName;
        var wxc = Path.Combine(Environment.SystemDirectory, "hostname.exe");
        var policyPath = Path.Combine(_root, "protected-policy.json");
        await File.WriteAllTextAsync(
            policyPath,
            $$"""
            {
              "approvedRoots": [
                { "path": {{System.Text.Json.JsonSerializer.Serialize(approvedRoot)}}, "access": "ReadWrite" }
              ],
              "deniedRoots": [{{System.Text.Json.JsonSerializer.Serialize(protectedRoot)}}],
              "wxcExecPath": {{System.Text.Json.JsonSerializer.Serialize(wxc)}},
              "networkAllowed": false,
              "allowWindowsUi": true,
              "clipboard": "none",
              "inputInjection": false,
              "strictNoHostFallback": true
            }
            """,
            TestContext.Current.CancellationToken);
        var policy = await HostPolicy.LoadAsync(policyPath);
        Directory.CreateDirectory(protectedRoot);

        var error = Assert.Throws<HostPolicyException>(() => policy.ResolveCwd(protectedRoot));

        Assert.Equal("cwd-sensitive-root", error.Code);
    }

    [Fact]
    public async Task RejectsBroadGrantContainingProtectedRoot()
    {
        var protectedRoot = Path.Combine(_root, "credentials");
        var wxc = Path.Combine(Environment.SystemDirectory, "hostname.exe");
        var policyPath = Path.Combine(_root, "overlapping-policy.json");
        await File.WriteAllTextAsync(
            policyPath,
            $$"""
            {
              "approvedRoots": [
                { "path": {{System.Text.Json.JsonSerializer.Serialize(_root)}}, "access": "ReadWrite" }
              ],
              "deniedRoots": [{{System.Text.Json.JsonSerializer.Serialize(protectedRoot)}}],
              "wxcExecPath": {{System.Text.Json.JsonSerializer.Serialize(wxc)}},
              "networkAllowed": false,
              "allowWindowsUi": true,
              "clipboard": "none",
              "inputInjection": false,
              "strictNoHostFallback": true
            }
            """,
            TestContext.Current.CancellationToken);

        var error = await Assert.ThrowsAsync<HostPolicyException>(() => HostPolicy.LoadAsync(policyPath));

        Assert.Equal("approved-root-overlaps-sensitive-root", error.Code);
    }

    public void Dispose()
    {
        if (Directory.Exists(_root))
            Directory.Delete(_root, recursive: true);
    }

    private static HostPolicy Policy(IReadOnlyList<ApprovedRoot> roots, IReadOnlyList<string>? denied = null)
        => new()
        {
            ApprovedRoots = roots,
            DeniedRoots = denied ?? [],
            WxcExecPath = Path.Combine(Environment.SystemDirectory, "hostname.exe"),
            AllowWindowsUi = true,
            StrictNoHostFallback = true,
        };
}
