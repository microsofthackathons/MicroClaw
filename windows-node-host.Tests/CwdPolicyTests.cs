using MicroClaw.WindowsNodeHost;
using OpenClaw.Shared;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
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
        var readAccess = new[]
        {
            new DurableApprovalAccess("ro", Path.Combine(_root, "documents")),
        };
        var writeAccess = new[]
        {
            new DurableApprovalAccess("rw", Path.Combine(_root, "documents")),
        };
        var approval = DurableApprovalIdentity.Create(executable, ["--example"], first, readAccess);

        Assert.True(DurableApprovalIdentity.Matches(approval, executable, ["--example"], first, readAccess));
        Assert.False(DurableApprovalIdentity.Matches(approval, executable, ["--other"], first, readAccess));
        Assert.False(DurableApprovalIdentity.Matches(approval, executable, ["--example"], second, readAccess));
        Assert.False(DurableApprovalIdentity.Matches(approval, executable, ["--example"], first, writeAccess));
        Assert.False(DurableApprovalIdentity.Matches(
            approval with { SchemaVersion = 2 },
            executable,
            ["--example"],
            first,
            readAccess));
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
        Assert.True(attestation.DurableApprovalBindsDeclaredAccess);
        Assert.True(attestation.LaunchTimeRevalidation);
        Assert.True(attestation.OmittedCwdUsesIsolatedScratch);
        Assert.True(attestation.HostFallbackAbsent);
        Assert.Equal("microclaw.windows-activation.v1", attestation.ActivationLeaseContract);
        Assert.True(attestation.GenerationBoundActivation);
        Assert.True(attestation.PolicyBoundActivation);
        Assert.True(attestation.LaunchTimeLeaseRevalidation);
        Assert.False(attestation.DurableApprovalsPresent);
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
        Assert.True(root.GetProperty("durableApprovalBindsDeclaredAccess").GetBoolean());
        Assert.True(root.GetProperty("launchTimeRevalidation").GetBoolean());
        Assert.True(root.GetProperty("omittedCwdUsesIsolatedScratch").GetBoolean());
        Assert.True(root.GetProperty("hostFallbackAbsent").GetBoolean());
        Assert.Equal(
            "microclaw.windows-activation.v1",
            root.GetProperty("activationLeaseContract").GetString());
        Assert.True(root.GetProperty("generationBoundActivation").GetBoolean());
        Assert.True(root.GetProperty("policyBoundActivation").GetBoolean());
        Assert.True(root.GetProperty("launchTimeLeaseRevalidation").GetBoolean());
        Assert.False(root.GetProperty("durableApprovalsPresent").GetBoolean());
        Assert.False(root.TryGetProperty("Contract", out _));
    }

    [Fact]
    public async Task LoadedPolicyMustMatchTheBootstrapFingerprint()
    {
        var policyPath = Path.Combine(_root, "verified-policy.json");
        var json = System.Text.Json.JsonSerializer.Serialize(new
        {
            approvedRoots = new[] { new { path = _root, access = "ReadOnly" } },
            deniedRoots = Array.Empty<string>(),
            wxcExecPath = Path.Combine(Environment.SystemDirectory, "hostname.exe"),
            networkAllowed = false,
            allowWindowsUi = true,
            clipboard = "none",
            inputInjection = false,
            strictNoHostFallback = true,
        });
        await File.WriteAllTextAsync(policyPath, json, TestContext.Current.CancellationToken);
        var fingerprint = Convert.ToHexString(
            SHA256.HashData(Encoding.UTF8.GetBytes(json))).ToLowerInvariant();

        var policy = await HostPolicy.LoadVerifiedAsync(policyPath, fingerprint);

        Assert.True(policy.StrictNoHostFallback);
        await File.AppendAllTextAsync(policyPath, " ", TestContext.Current.CancellationToken);
        var error = await Assert.ThrowsAsync<HostPolicyException>(
            () => HostPolicy.LoadVerifiedAsync(policyPath, fingerprint));
        Assert.Equal("policy-fingerprint-mismatch", error.Code);
    }

    [Fact]
    public async Task ActivationLeaseIsGenerationPolicyExpiryAndSignatureBound()
    {
        var leasePath = Path.Combine(_root, "activation.json");
        var secret = Convert.ToBase64String(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32));
        var expiresAt = DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeMilliseconds();
        await WriteActivationLease(
            leasePath,
            secret,
            ActivationLeaseMode.Active,
            "gateway-1",
            "policy-1",
            expiresAt);
        var guard = new ActivationLeaseGuard(leasePath, secret, "gateway-1", "policy-1");
        var argv = new[] { Path.Combine(Environment.SystemDirectory, "hostname.exe") };

        var validated = guard.Validate(argv);

        Assert.Equal(ActivationLeaseMode.Active, validated.Mode);
        Assert.Equal(
            "activation-lease-generation",
            Assert.Throws<HostPolicyException>(
                () => new ActivationLeaseGuard(leasePath, secret, "gateway-2", "policy-1").Validate(argv)).Code);
        Assert.Equal(
            "activation-lease-policy",
            Assert.Throws<HostPolicyException>(
                () => new ActivationLeaseGuard(leasePath, secret, "gateway-1", "policy-2").Validate(argv)).Code);
        await File.AppendAllTextAsync(leasePath, " ", TestContext.Current.CancellationToken);
        var record = System.Text.Json.JsonSerializer.Deserialize<ActivationLeaseRecord>(
            await File.ReadAllTextAsync(leasePath, TestContext.Current.CancellationToken),
            new System.Text.Json.JsonSerializerOptions
            {
                PropertyNameCaseInsensitive = true,
                Converters = { new System.Text.Json.Serialization.JsonStringEnumConverter() },
            })!;
        await File.WriteAllTextAsync(
            leasePath,
            System.Text.Json.JsonSerializer.Serialize(record with { Signature = new string('0', 64) }),
            TestContext.Current.CancellationToken);
        Assert.Equal(
            "activation-lease-signature",
            Assert.Throws<HostPolicyException>(() => guard.Validate(argv)).Code);
    }

    [Fact]
    public async Task DiagnosticLeasePermitsOnlyTheFixedSmokesAndRevalidatesBeforeLaunch()
    {
        var leasePath = Path.Combine(_root, "diagnostic-activation.json");
        var secret = Convert.ToBase64String(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32));
        var expiresAt = DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeMilliseconds();
        await WriteActivationLease(
            leasePath,
            secret,
            ActivationLeaseMode.Diagnostic,
            "gateway-1",
            "policy-1",
            expiresAt);
        var guard = new ActivationLeaseGuard(leasePath, secret, "gateway-1", "policy-1");
        var smoke = new[]
        {
            @"C:\Windows\System32\cmd.exe",
            "/d",
            "/s",
            "/c",
            @"C:\Windows\System32\hostname.exe && echo MICROCLAW_MXC_HOSTNAME_OK",
        };
        var validated = guard.Validate(smoke);

        Assert.Equal(
            "activation-lease-diagnostic-scope",
            Assert.Throws<HostPolicyException>(
                () => guard.Validate([Path.Combine(Environment.SystemDirectory, "hostname.exe")])).Code);
        await WriteActivationLease(
            leasePath,
            secret,
            ActivationLeaseMode.Active,
            "gateway-1",
            "policy-1",
            expiresAt);
        Assert.Equal(
            "activation-lease-changed",
            Assert.Throws<HostPolicyException>(() => guard.Revalidate(validated, smoke)).Code);
    }

    [Fact]
    public async Task MissingAndExpiredActivationLeasesFailClosed()
    {
        var leasePath = Path.Combine(_root, "expired-activation.json");
        var secret = Convert.ToBase64String(System.Security.Cryptography.RandomNumberGenerator.GetBytes(32));
        var guard = new ActivationLeaseGuard(leasePath, secret, "gateway-1", "policy-1");
        var argv = new[] { Path.Combine(Environment.SystemDirectory, "hostname.exe") };

        Assert.Equal(
            "activation-lease-unavailable",
            Assert.Throws<HostPolicyException>(() => guard.Validate(argv)).Code);
        await WriteActivationLease(
            leasePath,
            secret,
            ActivationLeaseMode.Active,
            "gateway-1",
            "policy-1",
            DateTimeOffset.UtcNow.AddSeconds(-1).ToUnixTimeMilliseconds());
        Assert.Equal(
            "activation-lease-expired",
            Assert.Throws<HostPolicyException>(() => guard.Validate(argv)).Code);
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

    [Fact]
    public async Task RunPrepareReturnsPinnedOpenClawApprovalPlan()
    {
        var policy = Policy([new ApprovedRoot(_root, FolderAccess.ReadWrite)]);
        var capability = Capability(policy);
        var args = Parse(
            """
            {
              "command": ["cmd.exe", "/d", "/s", "/c", "echo hello"],
              "rawCommand": "echo hello",
              "agentId": "main",
              "sessionKey": "agent:main:approval-regression"
            }
            """);

        var response = await capability.ExecuteAsync(
            new NodeInvokeRequest
            {
                Command = "system.run.prepare",
                Args = args,
            },
            TestContext.Current.CancellationToken);

        Assert.True(response.Ok);
        var payload = JsonSerializer.SerializeToElement(response.Payload);
        var plan = payload.GetProperty("plan");
        Assert.Equal(
            ["cmd.exe", "/d", "/s", "/c", "echo hello"],
            plan.GetProperty("argv").EnumerateArray().Select(value => value.GetString()!).ToArray());
        Assert.Equal(
            WindowsCommandLine.Join(["cmd.exe", "/d", "/s", "/c", "echo hello"]),
            plan.GetProperty("commandText").GetString());
        Assert.Equal("echo hello", plan.GetProperty("commandPreview").GetString());
        Assert.Equal("main", plan.GetProperty("agentId").GetString());
        Assert.Equal("agent:main:approval-regression", plan.GetProperty("sessionKey").GetString());
        Assert.Equal(plan.GetProperty("commandText").GetString(), payload.GetProperty("cmdText").GetString());
    }

    [Fact]
    public async Task RunPrepareValidatesDeclaredReadAndWriteAccess()
    {
        var child = Directory.CreateDirectory(Path.Combine(_root, "child")).FullName;
        var policy = Policy([new ApprovedRoot(_root, FolderAccess.ReadWrite)]);
        var rawCommand = $"# [declare-access]ro:{_root}\\.;rw:{child}\\.[/declare-access]\necho hello";
        var capability = Capability(policy);

        var response = await capability.ExecuteAsync(
            new NodeInvokeRequest
            {
                Command = "system.run.prepare",
                Args = Parse(JsonSerializer.Serialize(new
                {
                    command = new[] { "cmd.exe", "/d", "/s", "/c", rawCommand },
                    rawCommand,
                })),
            },
            TestContext.Current.CancellationToken);

        Assert.True(response.Ok);
        var payload = JsonSerializer.SerializeToElement(response.Payload);
        var access = payload.GetProperty("declaredAccess").EnumerateArray().ToArray();
        Assert.Equal(2, access.Length);
        Assert.Contains(access, item =>
            item.GetProperty("access").GetString() == "ro"
            && string.Equals(item.GetProperty("path").GetString(), _root, StringComparison.OrdinalIgnoreCase));
        Assert.Contains(access, item =>
            item.GetProperty("access").GetString() == "rw"
            && string.Equals(item.GetProperty("path").GetString(), child, StringComparison.OrdinalIgnoreCase));
        var plan = payload.GetProperty("plan");
        var expectedPreview = $"# [declare-access]ro:{_root};rw:{child}[/declare-access]\necho hello";
        Assert.Equal(expectedPreview, plan.GetProperty("commandPreview").GetString());
        Assert.Equal(
            "echo hello",
            plan.GetProperty("argv").EnumerateArray().Last().GetString());
        Assert.DoesNotContain("declare-access", plan.GetProperty("commandText").GetString());
    }

    [Theory]
    [InlineData("# [declare-access]rw:C:\\Temp")]
    [InlineData("# [declare-access][/declare-access]")]
    [InlineData("# [declare-access]execute:C:\\Temp[/declare-access]")]
    [InlineData("# [declare-access]rw:[/declare-access]")]
    public async Task RunPrepareRejectsMalformedDeclarations(string rawCommand)
    {
        var capability = Capability(Policy([new ApprovedRoot(_root, FolderAccess.ReadWrite)]));

        var response = await capability.ExecuteAsync(
            new NodeInvokeRequest
            {
                Command = "system.run.prepare",
                Args = Parse(JsonSerializer.Serialize(new
                {
                    command = new[] { "cmd.exe", "/d", "/s", "/c", rawCommand },
                    rawCommand,
                })),
            },
            TestContext.Current.CancellationToken);

        Assert.False(response.Ok);
        Assert.Contains("declare-access-", response.Error);
    }

    [Fact]
    public async Task RunPrepareRejectsOutOfRootAndReadWriteEscalation()
    {
        var outside = Directory.CreateDirectory(Path.Combine(Path.GetTempPath(), Guid.NewGuid().ToString("N"))).FullName;
        try
        {
            var capability = Capability(Policy([new ApprovedRoot(_root, FolderAccess.ReadOnly)]));
            var outsideResponse = await PrepareDeclared(capability, "ro", outside);
            var escalationResponse = await PrepareDeclared(capability, "rw", _root);

            Assert.False(outsideResponse.Ok);
            Assert.Contains("declare-access-outside-approved-roots", outsideResponse.Error);
            Assert.False(escalationResponse.Ok);
            Assert.Contains("declare-access-exceeds-approved-root", escalationResponse.Error);
        }
        finally
        {
            Directory.Delete(outside);
        }
    }

    [Fact]
    public async Task DeclaredDesktopCommandReachesAttendedPromptAndDenyStopsExecution()
    {
        var desktop = Directory.CreateDirectory(Path.Combine(_root, "Desktop")).FullName;
        var leasePath = Path.Combine(_root, "active-lease.json");
        var approvalsPath = Path.Combine(_root, "approvals.json");
        var secret = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));
        const string generation = "prepare-regression";
        const string fingerprint = "policy-fingerprint";
        await WriteActivationLease(
            leasePath,
            secret,
            ActivationLeaseMode.Active,
            generation,
            fingerprint,
            DateTimeOffset.UtcNow.AddMinutes(5).ToUnixTimeMilliseconds());
        var pipeName = "microclaw-approval-test-" + Guid.NewGuid().ToString("N");
        using var server = new System.IO.Pipes.NamedPipeServerStream(
            pipeName,
            System.IO.Pipes.PipeDirection.InOut,
            1,
            System.IO.Pipes.PipeTransmissionMode.Byte,
            System.IO.Pipes.PipeOptions.Asynchronous);
        var observedRequest = ReadApprovalAndRespond(server, "deny");
        var capability = new BundledSystemCapability(
            Policy([new ApprovedRoot(desktop, FolderAccess.ReadWrite)]),
            pipeName,
            approvalsPath,
            new ActivationLeaseGuard(leasePath, secret, generation, fingerprint));
        var rawCommand = $"# [declare-access]rw:{desktop}[/declare-access]\necho test";
        var command = new[] { Path.Combine(Environment.SystemDirectory, "cmd.exe"), "/d", "/s", "/c", "echo test" };
        var commandText = WindowsCommandLine.Join(command);

        var response = await capability.ExecuteAsync(
            new NodeInvokeRequest
            {
                Command = "system.run",
                Args = Parse(JsonSerializer.Serialize(new
                {
                    command,
                    rawCommand = commandText,
                    agentId = "main",
                    sessionKey = "agent:main:approval-regression",
                    systemRunPlan = new
                    {
                        argv = command,
                        commandText,
                        commandPreview = rawCommand,
                        agentId = "main",
                        sessionKey = "agent:main:approval-regression",
                    },
                })),
            },
            TestContext.Current.CancellationToken);
        var approval = await observedRequest;

        Assert.False(response.Ok);
        Assert.Contains("approval-denied", response.Error);
        Assert.Equal(1, approval.GetProperty("declaredAccess").GetArrayLength());
        Assert.Equal("rw", approval.GetProperty("declaredAccess")[0].GetProperty("access").GetString());
        Assert.Equal(desktop, approval.GetProperty("declaredAccess")[0].GetProperty("path").GetString(), ignoreCase: true);
        Assert.Equal("echo test", approval.GetProperty("arguments").EnumerateArray().Last().GetString());
        Assert.False(File.Exists(approvalsPath));
    }

    [Fact]
    public async Task RunPrepareRejectsDeclarationAfterExecutableContent()
    {
        var rawCommand = $"echo before\n# [declare-access]rw:{_root}[/declare-access]\necho after";
        var capability = Capability(Policy([new ApprovedRoot(_root, FolderAccess.ReadWrite)]));

        var response = await capability.ExecuteAsync(
            new NodeInvokeRequest
            {
                Command = "system.run.prepare",
                Args = Parse(JsonSerializer.Serialize(new
                {
                    command = new[] { "cmd.exe", "/d", "/s", "/c", rawCommand },
                    rawCommand,
                })),
            },
            TestContext.Current.CancellationToken);

        Assert.False(response.Ok);
        Assert.Contains("declare-access-position-invalid", response.Error);
    }

    [Fact]
    public async Task RunReplayRejectsDeclarationAfterExecutableContent()
    {
        var rawCommand = $"echo before\n# [declare-access]rw:{_root}[/declare-access]\necho after";
        var command = new[] { "cmd.exe", "/d", "/s", "/c", "echo before\necho after" };
        var commandText = WindowsCommandLine.Join(command);
        var capability = Capability(Policy([new ApprovedRoot(_root, FolderAccess.ReadWrite)]));

        var response = await capability.ExecuteAsync(
            new NodeInvokeRequest
            {
                Command = "system.run",
                Args = Parse(JsonSerializer.Serialize(new
                {
                    command,
                    rawCommand = commandText,
                    agentId = "main",
                    sessionKey = "agent:main:approval-regression",
                    systemRunPlan = new
                    {
                        argv = command,
                        commandText,
                        commandPreview = rawCommand,
                        agentId = "main",
                        sessionKey = "agent:main:approval-regression",
                    },
                })),
            },
            TestContext.Current.CancellationToken);

        Assert.False(response.Ok);
        Assert.Contains("declare-access-position-invalid", response.Error);
    }

    [Theory]
    [InlineData("deny", "Deny")]
    [InlineData("allow-once", "AllowOnce")]
    [InlineData("allow-always", "AllowAlways")]
    public async Task ApprovalPipePreservesAttendedDecision(
        string responseDecision,
        string expectedDecision)
    {
        var pipeName = "microclaw-approval-decision-" + Guid.NewGuid().ToString("N");
        using var server = new System.IO.Pipes.NamedPipeServerStream(
            pipeName,
            System.IO.Pipes.PipeDirection.InOut,
            1,
            System.IO.Pipes.PipeTransmissionMode.Byte,
            System.IO.Pipes.PipeOptions.Asynchronous);
        var serverTask = ReadApprovalAndRespond(server, responseDecision);
        var decision = await ApprovalPipeClient.RequestAsync(
            pipeName,
            new ApprovalRequest(
                "request",
                Path.Combine(Environment.SystemDirectory, "hostname.exe"),
                [],
                "main",
                CwdPolicyContract.ScratchBinding,
                []),
            TestContext.Current.CancellationToken);
        await serverTask;

        Assert.Equal(expectedDecision, decision.ToString());
    }

    [Fact]
    public void DurableAllowAlwaysIdentityRemainsBoundToCanonicalCwd()
    {
        var approvalsPath = Path.Combine(_root, "durable", "approvals.json");
        var first = Directory.CreateDirectory(Path.Combine(_root, "first-cwd")).FullName;
        var second = Directory.CreateDirectory(Path.Combine(_root, "second-cwd")).FullName;
        var executable = Path.Combine(Environment.SystemDirectory, "hostname.exe");
        var access = new[]
        {
            new DurableApprovalAccess("rw", Path.Combine(_root, "Desktop")),
        };
        var approval = DurableApprovalIdentity.Create(executable, [], first, access);

        DurableApprovalFile.Add(approvalsPath, approval);
        var loaded = Assert.Single(DurableApprovalIdentity.Load(approvalsPath));

        Assert.True(DurableApprovalIdentity.Matches(loaded, executable, [], first, access));
        Assert.False(DurableApprovalIdentity.Matches(loaded, executable, [], second, access));
        Assert.False(DurableApprovalIdentity.Matches(
            loaded,
            executable,
            [],
            first,
            [new DurableApprovalAccess("ro", Path.Combine(_root, "Desktop"))]));
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

    private BundledSystemCapability Capability(HostPolicy policy) =>
        new(
            policy,
            string.Empty,
            Path.Combine(_root, "approvals-v2.json"),
            new ActivationLeaseGuard(
                Path.Combine(_root, "unused-lease.json"),
                Convert.ToBase64String(RandomNumberGenerator.GetBytes(32)),
                "unused-generation",
                "unused-fingerprint"));

    private static JsonElement Parse(string json) => JsonDocument.Parse(json).RootElement.Clone();

    private static Task<NodeInvokeResponse> PrepareDeclared(
        BundledSystemCapability capability,
        string access,
        string path)
    {
        var rawCommand = $"# [declare-access]{access}:{path}[/declare-access]\necho test";
        return capability.ExecuteAsync(
            new NodeInvokeRequest
            {
                Command = "system.run.prepare",
                Args = Parse(JsonSerializer.Serialize(new
                {
                    command = new[] { "cmd.exe", "/d", "/s", "/c", rawCommand },
                    rawCommand,
                })),
            },
            TestContext.Current.CancellationToken);
    }

    private static async Task<JsonElement> ReadApprovalAndRespond(
        System.IO.Pipes.NamedPipeServerStream server,
        string decision)
    {
        await server.WaitForConnectionAsync(TestContext.Current.CancellationToken);
        using var reader = new StreamReader(server, Encoding.UTF8, leaveOpen: true);
        using var writer = new StreamWriter(server, new UTF8Encoding(false), leaveOpen: true)
        {
            AutoFlush = true,
        };
        var line = await reader.ReadLineAsync(TestContext.Current.CancellationToken);
        await writer.WriteLineAsync(
            JsonSerializer.Serialize(new { decision }).AsMemory(),
            TestContext.Current.CancellationToken);
        return JsonDocument.Parse(line ?? "{}").RootElement.Clone();
    }

    private static Task WriteActivationLease(
        string path,
        string secret,
        ActivationLeaseMode mode,
        string gatewayGeneration,
        string policyFingerprint,
        long expiresAtUnixMs)
    {
        var record = new ActivationLeaseRecord(
            ActivationLeaseContract.Version,
            mode,
            gatewayGeneration,
            policyFingerprint,
            expiresAtUnixMs,
            ActivationLeaseGuard.ComputeSignature(
                secret,
                mode,
                gatewayGeneration,
                policyFingerprint,
                expiresAtUnixMs));
        var options = new System.Text.Json.JsonSerializerOptions();
        options.Converters.Add(new System.Text.Json.Serialization.JsonStringEnumConverter());
        return File.WriteAllTextAsync(path, System.Text.Json.JsonSerializer.Serialize(record, options));
    }
}
