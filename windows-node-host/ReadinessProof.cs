using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace MicroClaw.WindowsNodeHost;

internal static class ReadinessProbeContract
{
    public const string Version = "microclaw.windows-node-readiness.v1";
    public const string Command = "system.run.readiness";
    public const string AgentId = "__microclaw_mxc_readiness__";
    public const int MaximumLifetimeMs = 30_000;
    public const int MaximumClockSkewMs = 5_000;

    public static readonly IReadOnlyDictionary<string, string[]> Probes =
        new Dictionary<string, string[]>(StringComparer.Ordinal)
        {
            ["hostname"] =
            [
                @"C:\Windows\System32\cmd.exe",
                "/d",
                "/s",
                "/c",
                @"C:\Windows\System32\hostname.exe && echo MICROCLAW_MXC_HOSTNAME_OK",
            ],
            ["powershell"] =
            [
                @"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "[Console]::Out.Write('MICROCLAW_MXC_POWERSHELL_OK')",
            ],
        };

    public static string SessionKey(string transitionId) =>
        $"microclaw:readiness:{transitionId.ToLowerInvariant()}";

    public static bool Matches(IReadOnlyList<string> actual, IReadOnlyList<string> expected) =>
        actual.Count == expected.Count
        && actual.Select((value, index) =>
                string.Equals(
                    value,
                    expected[index],
                    index == 0 ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
            .All(matches => matches);
}

internal sealed record ReadinessProofRecord(
    [property: JsonPropertyName("contract")] string Contract,
    [property: JsonPropertyName("transitionId")] string TransitionId,
    [property: JsonPropertyName("nonce")] string Nonce,
    [property: JsonPropertyName("gatewayGeneration")] string GatewayGeneration,
    [property: JsonPropertyName("policyFingerprint")] string PolicyFingerprint,
    [property: JsonPropertyName("nodeId")] string NodeId,
    [property: JsonPropertyName("probeKind")] string ProbeKind,
    [property: JsonPropertyName("planSha256")] string PlanSha256,
    [property: JsonPropertyName("issuedAtUnixMs")] long IssuedAtUnixMs,
    [property: JsonPropertyName("expiresAtUnixMs")] long ExpiresAtUnixMs,
    [property: JsonPropertyName("signature")] string Signature);

internal sealed record ValidatedReadinessProof(
    string TransitionId,
    string Nonce,
    string ProbeKind,
    string PlanSha256,
    long ExpiresAtUnixMs);

internal sealed class ReadinessProofVerifier
{
    private readonly byte[] _secret;
    private readonly string _gatewayGeneration;
    private readonly string _policyFingerprint;
    private readonly string _nodeId;
    private readonly string _transitionId;
    private readonly Func<long> _nowUnixMs;
    private readonly object _consumeGate = new();
    private readonly Dictionary<string, long> _consumedNonces = new(StringComparer.Ordinal);
    private readonly HashSet<string> _consumedProbeKinds = new(StringComparer.Ordinal);

    public ReadinessProofVerifier(
        string secretBase64,
        string gatewayGeneration,
        string policyFingerprint,
        string nodeId,
        string transitionId,
        Func<long>? nowUnixMs = null)
    {
        _secret = DecodeSecret(secretBase64);
        _gatewayGeneration = RequireValue(gatewayGeneration, "gateway generation");
        _policyFingerprint = RequireSha256(policyFingerprint, "policy fingerprint");
        _nodeId = RequireSha256(nodeId, "node identity");
        _transitionId = RequireGuid(transitionId, "transition");
        _nowUnixMs = nowUnixMs ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    }

    public ValidatedReadinessProof ValidateAndConsume(
        JsonElement args,
        DurableApproval currentIdentity)
    {
        if (!args.TryGetProperty("microclawReadinessProof", out var proofElement)
            || proofElement.ValueKind != JsonValueKind.Object)
            throw new HostPolicyException(
                "readiness-proof-required",
                "A transition-bound MicroClaw readiness proof is required.");

        ReadinessProofRecord proof;
        try
        {
            proof = JsonSerializer.Deserialize<ReadinessProofRecord>(proofElement.GetRawText())
                ?? throw new JsonException("Readiness proof is empty.");
        }
        catch (JsonException ex)
        {
            throw new HostPolicyException(
                "readiness-proof-malformed",
                $"The MicroClaw readiness proof is malformed: {ex.GetType().Name}");
        }

        ValidateEnvelope(proof);
        ValidateExactProbe(args, currentIdentity, proof.ProbeKind);
        var planSha256 = ApprovalProofVerifier.ComputePlanSha256(args, currentIdentity);
        if (!FixedTimeHexEquals(proof.PlanSha256, planSha256))
            throw new HostPolicyException(
                "readiness-proof-plan-mismatch",
                "The readiness proof does not match the prepared command plan.");
        var expectedSignature = ComputeSignature(_secret, proof with { Signature = string.Empty });
        if (!FixedTimeHexEquals(proof.Signature, expectedSignature))
            throw new HostPolicyException(
                "readiness-proof-signature-invalid",
                "The readiness proof signature is invalid.");

        var now = _nowUnixMs();
        lock (_consumeGate)
        {
            foreach (var key in _consumedNonces
                .Where(entry => entry.Value <= now)
                .Select(entry => entry.Key)
                .ToArray())
                _consumedNonces.Remove(key);
            if (_consumedNonces.ContainsKey(proof.Nonce)
                || _consumedProbeKinds.Contains(proof.ProbeKind))
                throw new HostPolicyException(
                    "readiness-proof-replayed",
                    "This readiness probe authorization has already been consumed.");
            _consumedNonces.Add(proof.Nonce, proof.ExpiresAtUnixMs);
            _consumedProbeKinds.Add(proof.ProbeKind);
        }

        return new ValidatedReadinessProof(
            proof.TransitionId,
            proof.Nonce,
            proof.ProbeKind,
            planSha256,
            proof.ExpiresAtUnixMs);
    }

    public static string ComputeSignature(string secretBase64, ReadinessProofRecord proof) =>
        ComputeSignature(DecodeSecret(secretBase64), proof);

    private void ValidateEnvelope(ReadinessProofRecord proof)
    {
        if (!string.Equals(proof.Contract, ReadinessProbeContract.Version, StringComparison.Ordinal))
            throw new HostPolicyException(
                "readiness-proof-contract-invalid",
                "The readiness proof contract is unsupported.");
        RequireGuid(proof.TransitionId, "transition");
        RequireGuid(proof.Nonce, "nonce");
        if (!ReadinessProbeContract.Probes.ContainsKey(proof.ProbeKind)
            || !IsSha256(proof.PolicyFingerprint)
            || !IsSha256(proof.NodeId)
            || !IsSha256(proof.PlanSha256)
            || !IsSha256(proof.Signature))
            throw new HostPolicyException(
                "readiness-proof-malformed",
                "The readiness proof identity or hashes are malformed.");
        if (!string.Equals(proof.TransitionId, _transitionId, StringComparison.OrdinalIgnoreCase))
            throw new HostPolicyException(
                "readiness-proof-transition-mismatch",
                "The readiness proof belongs to another lifecycle transition.");
        if (!string.Equals(proof.GatewayGeneration, _gatewayGeneration, StringComparison.Ordinal))
            throw new HostPolicyException(
                "readiness-proof-generation-mismatch",
                "The readiness proof belongs to another Gateway generation.");
        if (!string.Equals(proof.PolicyFingerprint, _policyFingerprint, StringComparison.OrdinalIgnoreCase))
            throw new HostPolicyException(
                "readiness-proof-policy-mismatch",
                "The readiness proof belongs to another sandbox policy.");
        if (!string.Equals(proof.NodeId, _nodeId, StringComparison.OrdinalIgnoreCase))
            throw new HostPolicyException(
                "readiness-proof-node-mismatch",
                "The readiness proof belongs to another Windows node.");

        var now = _nowUnixMs();
        var lifetime = proof.ExpiresAtUnixMs - proof.IssuedAtUnixMs;
        if (lifetime <= 0 || lifetime > ReadinessProbeContract.MaximumLifetimeMs
            || proof.IssuedAtUnixMs > now + ReadinessProbeContract.MaximumClockSkewMs
            || proof.ExpiresAtUnixMs <= now)
            throw new HostPolicyException(
                "readiness-proof-stale",
                "The readiness proof is expired or outside its allowed lifetime.");
    }

    private void ValidateExactProbe(
        JsonElement args,
        DurableApproval identity,
        string probeKind)
    {
        if (!args.TryGetProperty("probeKind", out var kindElement)
            || kindElement.ValueKind != JsonValueKind.String
            || !string.Equals(kindElement.GetString(), probeKind, StringComparison.Ordinal))
            throw new HostPolicyException(
                "readiness-proof-kind-mismatch",
                "The readiness probe kind changed before execution.");
        var expected = ReadinessProbeContract.Probes[probeKind];
        var identityArgv = new[] { identity.ExecutablePath }.Concat(identity.Arguments).ToArray();
        if (!ReadinessProbeContract.Matches(identityArgv, expected)
            || !string.Equals(identity.CwdBinding, CwdPolicyContract.ScratchBinding, StringComparison.Ordinal)
            || identity.DeclaredAccess.Count != 0)
            throw new HostPolicyException(
                "readiness-proof-scope-invalid",
                "The readiness proof permits only the exact built-in probe in isolated scratch.");
        if (args.TryGetProperty("cwd", out var cwd) && cwd.ValueKind != JsonValueKind.Null)
            throw new HostPolicyException(
                "readiness-proof-scope-invalid",
                "The readiness probe cannot request a working directory.");
        if (!args.TryGetProperty("agentId", out var agent)
            || agent.ValueKind != JsonValueKind.String
            || !string.Equals(agent.GetString(), ReadinessProbeContract.AgentId, StringComparison.Ordinal)
            || !args.TryGetProperty("sessionKey", out var session)
            || session.ValueKind != JsonValueKind.String
            || !string.Equals(
                session.GetString(),
                ReadinessProbeContract.SessionKey(_transitionId),
                StringComparison.Ordinal))
            throw new HostPolicyException(
                "readiness-proof-scope-invalid",
                "The readiness probe is not owned by the current MicroClaw lifecycle.");
        if (!args.TryGetProperty("systemRunPlan", out var plan)
            || plan.ValueKind != JsonValueKind.Object
            || !plan.TryGetProperty("commandPreview", out var preview)
            || preview.ValueKind != JsonValueKind.Null
            || !plan.TryGetProperty("declaredAccess", out var access)
            || access.ValueKind != JsonValueKind.Array
            || access.GetArrayLength() != 0)
            throw new HostPolicyException(
                "readiness-proof-scope-invalid",
                "The readiness probe plan contains unsupported declarations or preview content.");
    }

    private static string ComputeSignature(byte[] secret, ReadinessProofRecord proof)
    {
        var fields = new[]
        {
            ReadinessProbeContract.Version,
            EncodeField("transitionId", proof.TransitionId.ToLowerInvariant()),
            EncodeField("nonce", proof.Nonce.ToLowerInvariant()),
            EncodeField("gatewayGeneration", proof.GatewayGeneration),
            EncodeField("policyFingerprint", proof.PolicyFingerprint.ToLowerInvariant()),
            EncodeField("nodeId", proof.NodeId.ToLowerInvariant()),
            EncodeField("probeKind", proof.ProbeKind),
            EncodeField("planSha256", proof.PlanSha256.ToLowerInvariant()),
            $"issuedAtUnixMs={proof.IssuedAtUnixMs}",
            $"expiresAtUnixMs={proof.ExpiresAtUnixMs}",
        };
        return Convert.ToHexString(
            HMACSHA256.HashData(secret, Encoding.UTF8.GetBytes(string.Join('\n', fields))))
            .ToLowerInvariant();
    }

    private static string EncodeField(string name, string value) =>
        $"{name}={Encoding.UTF8.GetByteCount(value)}:{value}";

    private static byte[] DecodeSecret(string value)
    {
        try
        {
            var secret = Convert.FromBase64String(value);
            if (secret.Length != 32 || !string.Equals(Convert.ToBase64String(secret), value, StringComparison.Ordinal))
                throw new HostPolicyException(
                    "readiness-proof-secret-invalid",
                    "The readiness proof secret must contain exactly 256 bits.");
            return secret;
        }
        catch (FormatException)
        {
            throw new HostPolicyException(
                "readiness-proof-secret-invalid",
                "The readiness proof secret is malformed.");
        }
    }

    private static string RequireValue(string value, string label)
    {
        if (string.IsNullOrWhiteSpace(value))
            throw new HostPolicyException(
                "readiness-proof-bootstrap-invalid",
                $"The readiness proof {label} is missing.");
        return value;
    }

    private static string RequireSha256(string value, string label)
    {
        if (!IsSha256(value))
            throw new HostPolicyException(
                "readiness-proof-bootstrap-invalid",
                $"The readiness proof {label} is invalid.");
        return value.ToLowerInvariant();
    }

    private static string RequireGuid(string value, string label)
    {
        if (!Guid.TryParse(value, out var parsed))
            throw new HostPolicyException(
                "readiness-proof-bootstrap-invalid",
                $"The readiness proof {label} is invalid.");
        return parsed.ToString();
    }

    private static bool IsSha256(string? value) =>
        value is { Length: 64 } && value.All(Uri.IsHexDigit);

    private static bool FixedTimeHexEquals(string supplied, string expected)
    {
        try
        {
            var suppliedBytes = Convert.FromHexString(supplied);
            var expectedBytes = Convert.FromHexString(expected);
            return suppliedBytes.Length == expectedBytes.Length
                && CryptographicOperations.FixedTimeEquals(suppliedBytes, expectedBytes);
        }
        catch (ArgumentException)
        {
            return false;
        }
    }
}
