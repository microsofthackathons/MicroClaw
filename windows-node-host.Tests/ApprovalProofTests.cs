using System.Collections.Concurrent;
using System.Text.Json;
using MicroClaw.WindowsNodeHost;
using Xunit;

namespace MicroClaw.WindowsNodeHost.Tests;

public sealed class ApprovalProofTests
{
    private const long IssuedAtUnixMs = 1_735_689_600_000;
    private static readonly string Secret = Convert.ToBase64String(
        Enumerable.Range(0, 32).Select(value => (byte)value).ToArray());
    private static readonly string PolicyFingerprint = new('a', 64);
    private static readonly string NodeId = new('b', 64);
    private static readonly string[] Argv =
    [
        @"C:\Windows\System32\cmd.exe",
        "/d",
        "/s",
        "/c",
        "echo café",
    ];

    [Fact]
    public void MatchesJavaScriptCrossLanguageVectorAndConsumesOnce()
    {
        var verifier = Verifier(IssuedAtUnixMs);
        var proof = VectorProof();

        var validated = verifier.ValidateAndConsume(Args(proof));
        var replay = Assert.Throws<HostPolicyException>(() => verifier.ValidateAndConsume(Args(proof)));

        Assert.Equal("approval-001", validated.ApprovalId);
        Assert.Equal(
            "4782770b7a3fa8db392ebaf6d0de8552586af5a251eebce502c6c36ddee9ad53",
            validated.PlanSha256);
        Assert.Equal("approval-proof-replayed", replay.Code);
    }

    [Fact]
    public void RejectsSameApprovalIdWithAnotherValidNonce()
    {
        var verifier = Verifier(IssuedAtUnixMs);
        var first = VectorProof();
        var second = Sign(first with { Nonce = "12345678-1234-4234-8234-123456789abd" });

        verifier.ValidateAndConsume(Args(first));
        var replay = Assert.Throws<HostPolicyException>(() => verifier.ValidateAndConsume(Args(second)));

        Assert.Equal("approval-proof-replayed", replay.Code);
    }

    [Fact]
    public async Task ConcurrentConsumptionAllowsExactlyOneInvocation()
    {
        var verifier = Verifier(IssuedAtUnixMs);
        var results = new ConcurrentBag<string>();

        await Task.WhenAll(
            Enumerable.Range(0, 32).Select(_ =>
                Task.Run(() =>
                {
                    try
                    {
                        verifier.ValidateAndConsume(Args(VectorProof()));
                        results.Add("valid");
                    }
                    catch (HostPolicyException ex)
                    {
                        results.Add(ex.Code);
                    }
                })));

        Assert.Single(results, result => result == "valid");
        Assert.Equal(31, results.Count(result => result == "approval-proof-replayed"));
    }

    [Fact]
    public void RejectsMissingMalformedExpiredFutureAndOverlongProofs()
    {
        AssertCode("approval-proof-required", () => Verifier(IssuedAtUnixMs).ValidateAndConsume(Args(null)));
        AssertCode(
            "approval-proof-contract-invalid",
            () => Verifier(IssuedAtUnixMs).ValidateAndConsume(Args(new { contract = "wrong" })));
        AssertCode(
            "approval-proof-stale",
            () => Verifier(IssuedAtUnixMs + 20_000).ValidateAndConsume(Args(VectorProof())));
        AssertCode(
            "approval-proof-stale",
            () => Verifier(IssuedAtUnixMs - 10_000).ValidateAndConsume(Args(VectorProof())));
        var overlong = Sign(VectorProof() with { ExpiresAtUnixMs = IssuedAtUnixMs + 30_001 });
        AssertCode(
            "approval-proof-stale",
            () => Verifier(IssuedAtUnixMs).ValidateAndConsume(Args(overlong)));
        var invalidSignature = VectorProof() with { Signature = new string('z', 64) };
        AssertCode(
            "approval-proof-malformed",
            () => Verifier(IssuedAtUnixMs).ValidateAndConsume(Args(invalidSignature)));
    }

    [Theory]
    [InlineData("generation", "approval-proof-generation-mismatch")]
    [InlineData("policy", "approval-proof-policy-mismatch")]
    [InlineData("node", "approval-proof-node-mismatch")]
    public void RejectsWrongActivationContext(string binding, string expectedCode)
    {
        var verifier = binding switch
        {
            "generation" => new ApprovalProofVerifier(
                Secret, "wrong", PolicyFingerprint, NodeId, () => IssuedAtUnixMs),
            "policy" => new ApprovalProofVerifier(
                Secret, "generation-test-001", new string('c', 64), NodeId, () => IssuedAtUnixMs),
            _ => new ApprovalProofVerifier(
                Secret, "generation-test-001", PolicyFingerprint, new string('d', 64), () => IssuedAtUnixMs),
        };

        AssertCode(expectedCode, () => verifier.ValidateAndConsume(Args(VectorProof())));
    }

    [Fact]
    public void RejectsAlteredPlanAndSignature()
    {
        AssertCode(
            "approval-proof-plan-mismatch",
            () => Verifier(IssuedAtUnixMs).ValidateAndConsume(Args(VectorProof(), rawCommand: "echo altered")));
        AssertCode(
            "approval-proof-plan-mismatch",
            () => Verifier(IssuedAtUnixMs).ValidateAndConsume(Args(VectorProof(), argv: ["whoami.exe"])));
        var alteredSignature = VectorProof() with { Signature = new string('0', 64) };
        AssertCode(
            "approval-proof-signature-invalid",
            () => Verifier(IssuedAtUnixMs).ValidateAndConsume(Args(alteredSignature)));
    }

    [Theory]
    [InlineData("")]
    [InlineData("not-base64")]
    [InlineData("AA==")]
    public void RejectsMalformedBootstrapSecret(string secret)
    {
        var error = Assert.Throws<HostPolicyException>(() =>
            new ApprovalProofVerifier(
                secret,
                "generation-test-001",
                PolicyFingerprint,
                NodeId));

        Assert.Equal("approval-proof-secret-invalid", error.Code);
    }

    private static ApprovalProofVerifier Verifier(long nowUnixMs) =>
        new(Secret, "generation-test-001", PolicyFingerprint, NodeId, () => nowUnixMs);

    private static JsonElement Args(
        object? proof,
        string? rawCommand = "echo café",
        string[]? argv = null)
    {
        var plan = new
        {
            argv = Argv,
            cwd = @"C:\Users\Test\Work",
            commandText = "echo café",
            commandPreview = @"[declare-access]rw:C:\Users\Test\Work[/declare-access] echo café",
            agentId = "main",
            sessionKey = "agent:main:main",
        };
        return JsonSerializer.SerializeToElement(new
        {
            argv = argv ?? Argv,
            cwd = plan.cwd,
            rawCommand,
            agentId = plan.agentId,
            sessionKey = plan.sessionKey,
            systemRunPlan = plan,
            microclawApprovalProof = proof,
        });
    }

    private static ApprovalProofRecord VectorProof() =>
        new(
            ApprovalProofContract.Version,
            "approval-001",
            "12345678-1234-4234-8234-123456789abc",
            "generation-test-001",
            PolicyFingerprint,
            NodeId,
            "4782770b7a3fa8db392ebaf6d0de8552586af5a251eebce502c6c36ddee9ad53",
            IssuedAtUnixMs,
            IssuedAtUnixMs + 15_000,
            "1011191f87cbd0ecbe947c3f8e965574c6359afa4c2c7c3d220e3127f521e560");

    private static ApprovalProofRecord Sign(ApprovalProofRecord proof) =>
        proof with
        {
            Signature = ApprovalProofVerifier.ComputeSignature(
                Secret,
                proof with { Signature = string.Empty }),
        };

    private static void AssertCode(string expected, Action action)
    {
        var error = Assert.Throws<HostPolicyException>(action);
        Assert.Equal(expected, error.Code);
    }
}
