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
    private static readonly DurableApproval CurrentIdentity = new(
        DurableApprovalIdentity.SchemaVersion,
        Argv[0],
        Argv.Skip(1).ToArray(),
        @"C:\Users\Test\Work",
        [new DurableApprovalAccess("rw", @"C:\Users\Test\Work")],
        new string('c', 64));

    [Fact]
    public void MatchesJavaScriptCrossLanguageVectorAndConsumesOnce()
    {
        var verifier = Verifier(IssuedAtUnixMs);
        var proof = VectorProof();

        var validated = verifier.ValidateAndConsume(Args(proof), CurrentIdentity);
        var replay = Assert.Throws<HostPolicyException>(() => verifier.ValidateAndConsume(Args(proof), CurrentIdentity));

        Assert.Equal("approval-001", validated.ApprovalId);
        Assert.Equal(
            "121d69569e93b8e70445e4d8815cf9d72fd68d5065fa11106c4f204f4c78b661",
            validated.PlanSha256);
        Assert.Equal("approval-proof-replayed", replay.Code);
    }

    [Fact]
    public void RejectsSameApprovalIdWithAnotherValidNonce()
    {
        var verifier = Verifier(IssuedAtUnixMs);
        var first = VectorProof();
        var second = Sign(first with { Nonce = "12345678-1234-4234-8234-123456789abd" });

        verifier.ValidateAndConsume(Args(first), CurrentIdentity);
        var replay = Assert.Throws<HostPolicyException>(() => verifier.ValidateAndConsume(Args(second), CurrentIdentity));

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
                        verifier.ValidateAndConsume(Args(VectorProof()), CurrentIdentity);
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
        AssertCode("approval-proof-required", () => Verifier(IssuedAtUnixMs).ValidateAndConsume(Args(null), CurrentIdentity));
        AssertCode(
            "approval-proof-contract-invalid",
            () => Verifier(IssuedAtUnixMs).ValidateAndConsume(Args(new { contract = "wrong" }), CurrentIdentity));
        AssertCode(
            "approval-proof-stale",
            () => Verifier(IssuedAtUnixMs + 20_000).ValidateAndConsume(Args(VectorProof()), CurrentIdentity));
        AssertCode(
            "approval-proof-stale",
            () => Verifier(IssuedAtUnixMs - 10_000).ValidateAndConsume(Args(VectorProof()), CurrentIdentity));
        var overlong = Sign(VectorProof() with { ExpiresAtUnixMs = IssuedAtUnixMs + 30_001 });
        AssertCode(
            "approval-proof-stale",
            () => Verifier(IssuedAtUnixMs).ValidateAndConsume(Args(overlong), CurrentIdentity));
        var invalidSignature = VectorProof() with { Signature = new string('z', 64) };
        AssertCode(
            "approval-proof-malformed",
            () => Verifier(IssuedAtUnixMs).ValidateAndConsume(Args(invalidSignature), CurrentIdentity));
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

        AssertCode(expectedCode, () => verifier.ValidateAndConsume(Args(VectorProof()), CurrentIdentity));
    }

    [Fact]
    public void RejectsAlteredPlanAndSignature()
    {
        AssertCode(
            "approval-proof-plan-mismatch",
            () => Verifier(IssuedAtUnixMs).ValidateAndConsume(Args(VectorProof(), rawCommand: "echo altered"), CurrentIdentity));
        AssertCode(
            "approval-proof-plan-mismatch",
            () => Verifier(IssuedAtUnixMs).ValidateAndConsume(Args(VectorProof(), argv: ["whoami.exe"]), CurrentIdentity));
        var alteredSignature = VectorProof() with { Signature = new string('0', 64) };
        AssertCode(
            "approval-proof-signature-invalid",
            () => Verifier(IssuedAtUnixMs).ValidateAndConsume(Args(alteredSignature), CurrentIdentity));
    }

    [Fact]
    public void UsesCultureInvariantOrdinalDeclarationOrdering()
    {
        var current = CurrentIdentity with
        {
            Arguments = [],
            CwdBinding = @"C:\Work",
            DeclaredAccess =
            [
                new DurableApprovalAccess("rw", @"C:\z"),
                new DurableApprovalAccess("ro", @"C:\ä"),
            ],
        };
        var args = JsonSerializer.SerializeToElement(new
        {
            argv = new[] { "cmd.exe" },
            cwd = @"C:\Work",
            rawCommand = "cmd.exe",
            agentId = "main",
            sessionKey = "agent:main:test",
            systemRunPlan = new
            {
                argv = new[] { "cmd.exe" },
                cwd = @"C:\Work",
                commandText = "cmd.exe",
                commandPreview = (string?)null,
                agentId = "main",
                sessionKey = "agent:main:test",
                executablePath = current.ExecutablePath,
                executableSha256 = current.ExecutableSha256,
                cwdBinding = current.CwdBinding,
                declaredAccess = new[]
                {
                    new { access = "ro", path = @"C:\ä" },
                    new { access = "rw", path = @"C:\z" },
                },
            },
        });

        Assert.Equal(
            "c2d61960908c9c4c8cd9792bb5e1096e0f1e3136ab0fc1994f853361b197eb93",
            ApprovalProofVerifier.ComputePlanSha256(args, current));
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
            executablePath = CurrentIdentity.ExecutablePath,
            executableSha256 = CurrentIdentity.ExecutableSha256,
            cwdBinding = CurrentIdentity.CwdBinding,
            declaredAccess = CurrentIdentity.DeclaredAccess.Select(entry => new
            {
                access = entry.Access,
                path = entry.Path,
            }),
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
            "121d69569e93b8e70445e4d8815cf9d72fd68d5065fa11106c4f204f4c78b661",
            IssuedAtUnixMs,
            IssuedAtUnixMs + 15_000,
            "1167c6b0eeea3c385e252110d22bb87fa8e54f881a0f954d9f684289c1e48caa");

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
