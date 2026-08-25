using System.Collections.Concurrent;
using System.Text.Json;
using MicroClaw.WindowsNodeHost;
using Xunit;

namespace MicroClaw.WindowsNodeHost.Tests;

public sealed class ReadinessProofTests
{
    private const long IssuedAtUnixMs = 1_735_689_600_000;
    private const string Generation = "generation-test-001";
    private const string TransitionId = "12345678-1234-4234-8234-123456789abc";
    private static readonly string Secret = Convert.ToBase64String(
        Enumerable.Range(0, 32).Select(value => (byte)value).ToArray());
    private static readonly string PolicyFingerprint = new('a', 64);
    private static readonly string NodeId = new('b', 64);
    private static readonly string[] Argv = ReadinessProbeContract.Probes["hostname"];
    private static readonly DurableApproval CurrentIdentity = new(
        DurableApprovalIdentity.SchemaVersion,
        Argv[0],
        Argv.Skip(1).ToArray(),
        CwdPolicyContract.ScratchBinding,
        [],
        new string('c', 64));

    [Fact]
    public void AcceptsExactProbeOnceAndRejectsReplay()
    {
        var verifier = Verifier();
        var args = Args();
        var proof = Sign(UnsignedProof(args));
        args = Args(proof);

        var validated = verifier.ValidateAndConsume(args, CurrentIdentity);
        var replay = Assert.Throws<HostPolicyException>(
            () => verifier.ValidateAndConsume(args, CurrentIdentity));

        Assert.Equal("hostname", validated.ProbeKind);
        Assert.Equal(
            "1cf9d0658d325540aba0d944d8d00937b2c86626a6a814cbc9017a2ab63c2c45",
            validated.PlanSha256);
        Assert.Equal(
            "7c964f4e5c2c0f169eb295185edf317f609cbdfe105b29ec29980bebb577744d",
            proof.Signature);
        Assert.Equal("readiness-proof-replayed", replay.Code);
    }

    [Fact]
    public async Task ConcurrentConsumptionAllowsExactlyOneProbe()
    {
        var verifier = Verifier();
        var proof = Sign(UnsignedProof(Args()));
        var args = Args(proof);
        var results = new ConcurrentBag<string>();

        await Task.WhenAll(
            Enumerable.Range(0, 24).Select(_ =>
                Task.Run(() =>
                {
                    try
                    {
                        verifier.ValidateAndConsume(args, CurrentIdentity);
                        results.Add("valid");
                    }
                    catch (HostPolicyException ex)
                    {
                        results.Add(ex.Code);
                    }
                })));

        Assert.Single(results, result => result == "valid");
        Assert.Equal(23, results.Count(result => result == "readiness-proof-replayed"));
    }

    [Theory]
    [InlineData("transition", "readiness-proof-transition-mismatch")]
    [InlineData("generation", "readiness-proof-generation-mismatch")]
    [InlineData("policy", "readiness-proof-policy-mismatch")]
    [InlineData("node", "readiness-proof-node-mismatch")]
    public void RejectsWrongLifecycleBinding(string binding, string expectedCode)
    {
        var verifier = binding switch
        {
            "transition" => new ReadinessProofVerifier(
                Secret, Generation, PolicyFingerprint, NodeId,
                "12345678-1234-4234-8234-123456789abe", () => IssuedAtUnixMs),
            "generation" => new ReadinessProofVerifier(
                Secret, "wrong", PolicyFingerprint, NodeId, TransitionId, () => IssuedAtUnixMs),
            "policy" => new ReadinessProofVerifier(
                Secret, Generation, new string('d', 64), NodeId, TransitionId, () => IssuedAtUnixMs),
            _ => new ReadinessProofVerifier(
                Secret, Generation, PolicyFingerprint, new string('d', 64), TransitionId, () => IssuedAtUnixMs),
        };
        var args = Args();
        var proof = Sign(UnsignedProof(args));

        AssertCode(expectedCode, () => verifier.ValidateAndConsume(Args(proof), CurrentIdentity));
    }

    [Fact]
    public void RejectsExpiredAlteredAndDeclarationBearingProofs()
    {
        var baseArgs = Args();
        var proof = Sign(UnsignedProof(baseArgs));
        AssertCode(
            "readiness-proof-stale",
            () => new ReadinessProofVerifier(
                Secret,
                Generation,
                PolicyFingerprint,
                NodeId,
                TransitionId,
                () => IssuedAtUnixMs + 20_000)
                .ValidateAndConsume(Args(proof), CurrentIdentity));
        AssertCode(
            "readiness-proof-signature-invalid",
            () => Verifier().ValidateAndConsume(
                Args(proof with { Signature = new string('0', 64) }),
                CurrentIdentity));
        AssertCode(
            "readiness-proof-kind-mismatch",
            () => Verifier().ValidateAndConsume(Args(proof, probeKind: "powershell"), CurrentIdentity));

        var declaredIdentity = CurrentIdentity with
        {
            DeclaredAccess = [new DurableApprovalAccess("ro", @"C:\Work")],
        };
        AssertCode(
            "readiness-proof-scope-invalid",
            () => Verifier().ValidateAndConsume(Args(proof), declaredIdentity));
        AssertCode(
            "readiness-proof-scope-invalid",
            () => Verifier().ValidateAndConsume(Args(proof, cwd: @"C:\Windows"), CurrentIdentity));
        AssertCode(
            "readiness-proof-scope-invalid",
            () => Verifier().ValidateAndConsume(Args(proof, agentId: "main"), CurrentIdentity));
    }

    [Fact]
    public void RejectsAlteredArgvExecutableHashAndPlan()
    {
        var proof = Sign(UnsignedProof(Args()));
        var alteredIdentity = CurrentIdentity with { Arguments = [.. CurrentIdentity.Arguments, "extra"] };
        AssertCode(
            "readiness-proof-scope-invalid",
            () => Verifier().ValidateAndConsume(Args(proof), alteredIdentity));
        var alteredHash = CurrentIdentity with { ExecutableSha256 = new string('d', 64) };
        AssertCode(
            "approval-proof-executable-mismatch",
            () => Verifier().ValidateAndConsume(Args(proof), alteredHash));
        AssertCode(
            "approval-proof-plan-mismatch",
            () => Verifier().ValidateAndConsume(Args(proof, rawCommand: "altered"), CurrentIdentity));
    }

    private static ReadinessProofVerifier Verifier() =>
        new(Secret, Generation, PolicyFingerprint, NodeId, TransitionId, () => IssuedAtUnixMs);

    private static JsonElement Args(
        object? proof = null,
        string probeKind = "hostname",
        string? cwd = null,
        string? agentId = ReadinessProbeContract.AgentId,
        string? rawCommand = null)
    {
        var commandText = string.Join(' ', Argv);
        return JsonSerializer.SerializeToElement(new
        {
            command = Argv,
            cwd,
            rawCommand = rawCommand ?? commandText,
            agentId,
            sessionKey = ReadinessProbeContract.SessionKey(TransitionId),
            probeKind,
            systemRunPlan = new
            {
                argv = Argv,
                cwd = (string?)null,
                commandText,
                commandPreview = (string?)null,
                agentId = ReadinessProbeContract.AgentId,
                sessionKey = ReadinessProbeContract.SessionKey(TransitionId),
                executablePath = CurrentIdentity.ExecutablePath,
                executableSha256 = CurrentIdentity.ExecutableSha256,
                cwdBinding = CurrentIdentity.CwdBinding,
                declaredAccess = Array.Empty<object>(),
            },
            microclawReadinessProof = proof,
        });
    }

    private static ReadinessProofRecord UnsignedProof(JsonElement args) =>
        new(
            ReadinessProbeContract.Version,
            TransitionId,
            "12345678-1234-4234-8234-123456789abd",
            Generation,
            PolicyFingerprint,
            NodeId,
            "hostname",
            ApprovalProofVerifier.ComputePlanSha256(args, CurrentIdentity),
            IssuedAtUnixMs,
            IssuedAtUnixMs + 15_000,
            string.Empty);

    private static ReadinessProofRecord Sign(ReadinessProofRecord proof) =>
        proof with { Signature = ReadinessProofVerifier.ComputeSignature(Secret, proof) };

    private static void AssertCode(string expected, Action action)
    {
        var error = Assert.Throws<HostPolicyException>(action);
        Assert.Equal(expected, error.Code);
    }
}
