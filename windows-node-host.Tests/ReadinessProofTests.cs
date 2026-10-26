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
    private static readonly string[] Argv = ReadinessProbeContract.Probes["execution"];
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

        Assert.Equal("execution", validated.ProbeKind);
        Assert.Equal(
            "35fc1fc5eb08a374a0247f7dde073db0ca0578d26158bbd6fdc5110ac6e50bda",
            validated.PlanSha256);
        Assert.Equal(
            "223e2c971807546fe05478ebf9e28790b3b6339a92504e7f9fd6a559aab167c7",
            proof.Signature);
        Assert.Equal("readiness-proof-replayed", replay.Code);
    }

    [Fact]
    public void FreshProofsPermitRepeatedExecutionProbeButEachNonceRemainsOneUse()
    {
        var verifier = Verifier();
        var first = Sign(UnsignedProof(Args()));
        var second = Sign(UnsignedProof(Args()) with
        {
            Nonce = "12345678-1234-4234-8234-123456789abe",
        });

        Assert.Equal("execution", verifier.ValidateAndConsume(Args(first), CurrentIdentity).ProbeKind);
        Assert.Equal("execution", verifier.ValidateAndConsume(Args(second), CurrentIdentity).ProbeKind);
        AssertCode(
            "readiness-proof-replayed",
            () => verifier.ValidateAndConsume(Args(second), CurrentIdentity));
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

    [Fact]
    public void RevalidationRejectsProofThatExpiresBeforeLaunch()
    {
        var now = IssuedAtUnixMs;
        var verifier = new ReadinessProofVerifier(
            Secret,
            Generation,
            PolicyFingerprint,
            NodeId,
            TransitionId,
            () => now);
        var args = Args();
        var validated = verifier.ValidateAndConsume(
            Args(Sign(UnsignedProof(args))),
            CurrentIdentity);

        now = validated.ExpiresAtUnixMs;
        var error = Assert.Throws<HostPolicyException>(() => verifier.Revalidate(validated));

        Assert.Equal("readiness-proof-stale", error.Code);
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
            () => Verifier().ValidateAndConsume(Args(proof, probeKind: "hostname"), CurrentIdentity));

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
        string probeKind = "execution",
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
            "execution",
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

    [Fact]
    public void ReadinessPreparationIsFreshBoundAndOneUse()
    {
        var now = IssuedAtUnixMs;
        var guard = new ReadinessPreparationGuard(() => now);
        guard.Record("execution", CurrentIdentity);
        now += ReadinessPreparationGuard.MaximumAgeMs - 1;

        Assert.Equal(
            ReadinessPreparationGuard.MaximumAgeMs - 1,
            guard.ValidateAndConsume("execution", CurrentIdentity));
        AssertCode(
            "readiness-preparation-required",
            () => guard.ValidateAndConsume("execution", CurrentIdentity));
    }

    [Fact]
    public void ReadinessPreparationRejectsStaleOrChangedLaunch()
    {
        var now = IssuedAtUnixMs;
        var guard = new ReadinessPreparationGuard(() => now);
        guard.Record("execution", CurrentIdentity);
        now += ReadinessPreparationGuard.MaximumAgeMs + 1;
        AssertCode(
            "readiness-preparation-stale",
            () => guard.ValidateAndConsume("execution", CurrentIdentity));

        guard.Record("execution", CurrentIdentity);
        AssertCode(
            "readiness-preparation-mismatch",
            () => guard.ValidateAndConsume(
                "execution",
                CurrentIdentity with { ExecutableSha256 = new string('d', 64) }));
    }
}
