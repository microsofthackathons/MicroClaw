using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace MicroClaw.WindowsNodeHost;

internal static class ApprovalProofContract
{
    public const string Version = "microclaw.windows-node-approval.v1";
    public const string PlanVersion = "microclaw.windows-node-approval-plan.v2";
    public const int MaximumLifetimeMs = 30_000;
    public const int MaximumClockSkewMs = 5_000;
}

internal sealed record ApprovalProofRecord(
    [property: JsonPropertyName("contract")] string Contract,
    [property: JsonPropertyName("approvalId")] string ApprovalId,
    [property: JsonPropertyName("nonce")] string Nonce,
    [property: JsonPropertyName("gatewayGeneration")] string GatewayGeneration,
    [property: JsonPropertyName("policyFingerprint")] string PolicyFingerprint,
    [property: JsonPropertyName("nodeId")] string NodeId,
    [property: JsonPropertyName("planSha256")] string PlanSha256,
    [property: JsonPropertyName("issuedAtUnixMs")] long IssuedAtUnixMs,
    [property: JsonPropertyName("expiresAtUnixMs")] long ExpiresAtUnixMs,
    [property: JsonPropertyName("signature")] string Signature);

internal sealed record ValidatedApprovalProof(
    string ApprovalId,
    string Nonce,
    string PlanSha256,
    long ExpiresAtUnixMs);

internal sealed class ApprovalProofVerifier
{
    private readonly byte[] _secret;
    private readonly string _gatewayGeneration;
    private readonly string _policyFingerprint;
    private readonly string _nodeId;
    private readonly Func<long> _nowUnixMs;
    private readonly object _consumeGate = new();
    private readonly Dictionary<string, long> _consumedApprovalIds = new(StringComparer.Ordinal);
    private readonly Dictionary<string, long> _consumedNonces = new(StringComparer.Ordinal);

    public ApprovalProofVerifier(
        string secretBase64,
        string gatewayGeneration,
        string policyFingerprint,
        string nodeId,
        Func<long>? nowUnixMs = null)
    {
        if (string.IsNullOrEmpty(secretBase64))
            throw new HostPolicyException(
                "approval-proof-secret-invalid",
                "The approval proof secret must contain exactly 256 bits.");
        try
        {
            _secret = Convert.FromBase64String(secretBase64);
        }
        catch (FormatException ex)
        {
            throw new HostPolicyException(
                "approval-proof-secret-invalid",
                $"The approval proof secret is malformed: {ex.GetType().Name}");
        }
        if (_secret.Length != 32
            || !string.Equals(Convert.ToBase64String(_secret), secretBase64, StringComparison.Ordinal))
            throw new HostPolicyException(
                "approval-proof-secret-invalid",
                "The approval proof secret must contain exactly 256 bits.");
        _gatewayGeneration = RequireBootstrapValue(gatewayGeneration, "gateway generation");
        _policyFingerprint = RequireHexSha256(policyFingerprint, "policy fingerprint");
        _nodeId = RequireHexSha256(nodeId, "node identity");
        _nowUnixMs = nowUnixMs ?? (() => DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    }

    public ValidatedApprovalProof ValidateAndConsume(JsonElement args, DurableApproval currentIdentity)
    {
        if (!args.TryGetProperty("microclawApprovalProof", out var proofElement)
            || proofElement.ValueKind != JsonValueKind.Object)
            throw new HostPolicyException(
                "approval-proof-required",
                "A Gateway-approved MicroClaw command proof is required.");

        ApprovalProofRecord proof;
        try
        {
            proof = JsonSerializer.Deserialize<ApprovalProofRecord>(proofElement.GetRawText())
                ?? throw new JsonException("Approval proof is empty.");
        }
        catch (JsonException ex)
        {
            throw new HostPolicyException(
                "approval-proof-malformed",
                $"The Gateway approval proof is malformed: {ex.GetType().Name}");
        }

        if (!string.Equals(proof.Contract, ApprovalProofContract.Version, StringComparison.Ordinal))
            throw new HostPolicyException(
                "approval-proof-contract-invalid",
                "The Gateway approval proof contract is unsupported.");
        if (string.IsNullOrWhiteSpace(proof.ApprovalId) || proof.ApprovalId.Length > 256
            || string.IsNullOrWhiteSpace(proof.Nonce) || proof.Nonce.Length > 128
            || !Guid.TryParse(proof.Nonce, out _))
            throw new HostPolicyException(
                "approval-proof-malformed",
                "The Gateway approval proof identity is malformed.");
        if (!IsHexSha256(proof.PolicyFingerprint)
            || !IsHexSha256(proof.NodeId)
            || !IsHexSha256(proof.PlanSha256)
            || !IsHexSha256(proof.Signature))
            throw new HostPolicyException(
                "approval-proof-malformed",
                "The Gateway approval proof hashes are malformed.");
        if (!string.Equals(proof.GatewayGeneration, _gatewayGeneration, StringComparison.Ordinal))
            throw new HostPolicyException(
                "approval-proof-generation-mismatch",
                "The Gateway approval proof belongs to another Gateway generation.");
        if (!string.Equals(proof.PolicyFingerprint, _policyFingerprint, StringComparison.Ordinal))
            throw new HostPolicyException(
                "approval-proof-policy-mismatch",
                "The Gateway approval proof belongs to another sandbox policy.");
        if (!string.Equals(proof.NodeId, _nodeId, StringComparison.OrdinalIgnoreCase))
            throw new HostPolicyException(
                "approval-proof-node-mismatch",
                "The Gateway approval proof belongs to another Windows node.");

        var now = _nowUnixMs();
        var lifetime = proof.ExpiresAtUnixMs - proof.IssuedAtUnixMs;
        if (lifetime <= 0 || lifetime > ApprovalProofContract.MaximumLifetimeMs
            || proof.IssuedAtUnixMs > now + ApprovalProofContract.MaximumClockSkewMs
            || proof.ExpiresAtUnixMs <= now)
            throw new HostPolicyException(
                "approval-proof-stale",
                "The Gateway approval proof is expired or outside its allowed lifetime.");

        var planSha256 = ComputePlanSha256(args, currentIdentity);
        if (!FixedTimeHexEquals(proof.PlanSha256, planSha256))
            throw new HostPolicyException(
                "approval-proof-plan-mismatch",
                "The Gateway approval proof does not match the prepared command plan.");
        var expectedSignature = ComputeSignature(_secret, proof with { Signature = string.Empty });
        if (!FixedTimeHexEquals(proof.Signature, expectedSignature))
            throw new HostPolicyException(
                "approval-proof-signature-invalid",
                "The Gateway approval proof signature is invalid.");

        lock (_consumeGate)
        {
            foreach (var key in _consumedApprovalIds
                .Where(entry => entry.Value <= now)
                .Select(entry => entry.Key)
                .ToArray())
                _consumedApprovalIds.Remove(key);
            foreach (var key in _consumedNonces
                .Where(entry => entry.Value <= now)
                .Select(entry => entry.Key)
                .ToArray())
                _consumedNonces.Remove(key);
            if (_consumedApprovalIds.ContainsKey(proof.ApprovalId)
                || _consumedNonces.ContainsKey(proof.Nonce))
                throw new HostPolicyException(
                    "approval-proof-replayed",
                    "The Gateway approval proof has already been consumed.");
            _consumedApprovalIds.Add(proof.ApprovalId, proof.ExpiresAtUnixMs);
            _consumedNonces.Add(proof.Nonce, proof.ExpiresAtUnixMs);
        }

        return new ValidatedApprovalProof(
            proof.ApprovalId,
            proof.Nonce,
            planSha256,
            proof.ExpiresAtUnixMs);
    }

    public static string ComputePlanSha256(JsonElement args, DurableApproval currentIdentity)
    {
        if (!args.TryGetProperty("systemRunPlan", out var plan)
            || plan.ValueKind != JsonValueKind.Object)
            throw new HostPolicyException(
                "approval-proof-plan-invalid",
                "The Gateway approval proof requires the approved system.run plan.");
        var planArgv = ReadStringArray(plan, "argv");
        var requestArgv = args.TryGetProperty("argv", out var argv)
            ? ReadStringArray(argv)
            : args.TryGetProperty("command", out var command)
                ? ReadStringArray(command)
                : throw new HostPolicyException(
                    "approval-proof-plan-invalid",
                    "The approved command argv is missing.");
        if (!planArgv.SequenceEqual(requestArgv, StringComparer.Ordinal))
            throw new HostPolicyException(
                "approval-proof-plan-mismatch",
                "The approved command argv changed before node execution.");

        var cwd = ReadNullableString(plan, "cwd", required: true);
        var commandText = ReadRequiredString(plan, "commandText");
        var commandPreview = ReadNullableString(plan, "commandPreview", required: false);
        var agentId = ReadNullableString(plan, "agentId", required: true);
        var sessionKey = ReadRequiredString(plan, "sessionKey");
        var executablePath = ReadRequiredString(plan, "executablePath");
        var executableSha256 = ReadRequiredString(plan, "executableSha256").ToLowerInvariant();
        var cwdBinding = ReadRequiredString(plan, "cwdBinding");
        var declaredAccess = ReadDeclaredAccess(plan);
        if (!string.Equals(ReadNullableString(args, "cwd", required: false), cwd, StringComparison.Ordinal)
            || !string.Equals(ReadNullableString(args, "agentId", required: false), agentId, StringComparison.Ordinal)
            || !string.Equals(ReadRequiredString(args, "sessionKey"), sessionKey, StringComparison.Ordinal)
            || !string.Equals(ReadRequiredString(args, "rawCommand"), commandText, StringComparison.Ordinal))
            throw new HostPolicyException(
                "approval-proof-plan-mismatch",
                "The approved command context changed before node execution.");
        if (!string.Equals(executablePath, currentIdentity.ExecutablePath, StringComparison.OrdinalIgnoreCase)
            || !FixedTimeHexEquals(executableSha256, currentIdentity.ExecutableSha256)
            || !string.Equals(cwdBinding, currentIdentity.CwdBinding, StringComparison.OrdinalIgnoreCase)
            || declaredAccess.Count != currentIdentity.DeclaredAccess.Count
            || !declaredAccess.Zip(currentIdentity.DeclaredAccess).All(pair =>
                string.Equals(pair.First.Access, pair.Second.Access, StringComparison.Ordinal)
                && string.Equals(pair.First.Path, pair.Second.Path, StringComparison.OrdinalIgnoreCase)))
            throw new HostPolicyException(
                "approval-proof-executable-mismatch",
                "The approved executable, hash, CWD, or declared access changed before node execution.");

        var fields = new List<string>
        {
            ApprovalProofContract.PlanVersion,
            $"argv={planArgv.Count}",
        };
        fields.AddRange(planArgv.Select(argument => EncodeField("arg", argument)));
        fields.Add(EncodeNullableField("cwd", cwd));
        fields.Add(EncodeField("commandText", commandText));
        fields.Add(EncodeNullableField("commandPreview", commandPreview));
        fields.Add(EncodeNullableField("agentId", agentId));
        fields.Add(EncodeField("sessionKey", sessionKey));
        fields.Add(EncodeField("executablePath", executablePath));
        fields.Add(EncodeField("executableSha256", executableSha256));
        fields.Add(EncodeField("cwdBinding", cwdBinding));
        fields.Add($"declaredAccess={declaredAccess.Count}");
        foreach (var entry in declaredAccess)
        {
            fields.Add(EncodeField("access", entry.Access));
            fields.Add(EncodeField("path", entry.Path));
        }
        return Convert.ToHexString(
            SHA256.HashData(Encoding.UTF8.GetBytes(string.Join('\n', fields)))).ToLowerInvariant();
    }

    public static string ComputeSignature(string secretBase64, ApprovalProofRecord proof) =>
        ComputeSignature(Convert.FromBase64String(secretBase64), proof);

    private static string ComputeSignature(byte[] secret, ApprovalProofRecord proof)
    {
        var fields = new[]
        {
            ApprovalProofContract.Version,
            EncodeField("approvalId", proof.ApprovalId),
            EncodeField("nonce", proof.Nonce),
            EncodeField("gatewayGeneration", proof.GatewayGeneration),
            EncodeField("policyFingerprint", proof.PolicyFingerprint),
            EncodeField("nodeId", proof.NodeId.ToLowerInvariant()),
            EncodeField("planSha256", proof.PlanSha256.ToLowerInvariant()),
            $"issuedAtUnixMs={proof.IssuedAtUnixMs}",
            $"expiresAtUnixMs={proof.ExpiresAtUnixMs}",
        };
        return Convert.ToHexString(
            HMACSHA256.HashData(secret, Encoding.UTF8.GetBytes(string.Join('\n', fields))))
            .ToLowerInvariant();
    }

    private static IReadOnlyList<string> ReadStringArray(JsonElement parent, string property)
    {
        if (!parent.TryGetProperty(property, out var value))
            throw new HostPolicyException(
                "approval-proof-plan-invalid",
                $"The approved plan is missing {property}.");
        return ReadStringArray(value);
    }

    private static IReadOnlyList<string> ReadStringArray(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Array)
            throw new HostPolicyException(
                "approval-proof-plan-invalid",
                "The approved command argv is malformed.");
        var result = value.EnumerateArray()
            .Select(item => item.ValueKind == JsonValueKind.String ? item.GetString() : null)
            .ToArray();
        if (result.Length == 0 || result.Any(string.IsNullOrEmpty))
            throw new HostPolicyException(
                "approval-proof-plan-invalid",
                "The approved command argv is malformed.");
        return result.Select(item => item!).ToArray();
    }

    private static string ReadRequiredString(JsonElement parent, string property)
    {
        if (!parent.TryGetProperty(property, out var value)
            || value.ValueKind != JsonValueKind.String
            || string.IsNullOrEmpty(value.GetString()))
            throw new HostPolicyException(
                "approval-proof-plan-invalid",
                $"The approved plan has an invalid {property}.");
        return value.GetString()!;
    }

    private static string? ReadNullableString(JsonElement parent, string property, bool required)
    {
        if (!parent.TryGetProperty(property, out var value))
        {
            if (!required) return null;
            throw new HostPolicyException(
                "approval-proof-plan-invalid",
                $"The approved plan is missing {property}.");
        }
        if (value.ValueKind == JsonValueKind.Null) return null;
        if (value.ValueKind != JsonValueKind.String || string.IsNullOrEmpty(value.GetString()))
            throw new HostPolicyException(
                "approval-proof-plan-invalid",
                $"The approved plan has an invalid {property}.");
        return value.GetString();
    }

    private static IReadOnlyList<DurableApprovalAccess> ReadDeclaredAccess(JsonElement plan)
    {
        if (!plan.TryGetProperty("declaredAccess", out var value)
            || value.ValueKind != JsonValueKind.Array)
            throw new HostPolicyException(
                "approval-proof-plan-invalid",
                "The approved plan has invalid declared access.");
        var entries = new List<DurableApprovalAccess>();
        foreach (var item in value.EnumerateArray())
        {
            if (item.ValueKind != JsonValueKind.Object)
                throw new HostPolicyException(
                    "approval-proof-plan-invalid",
                    "The approved plan has invalid declared access.");
            var access = ReadRequiredString(item, "access").ToLowerInvariant();
            var declaredPath = ReadRequiredString(item, "path");
            if (access is not ("ro" or "rw"))
                throw new HostPolicyException(
                    "approval-proof-plan-invalid",
                    "The approved plan has invalid declared access.");
            entries.Add(new DurableApprovalAccess(access, declaredPath));
        }
        return entries
            .OrderBy(entry => entry.Path, StringComparer.Ordinal)
            .ToArray();
    }

    private static string EncodeField(string name, string value) =>
        $"{name}={Encoding.UTF8.GetByteCount(value)}:{value}";

    private static string EncodeNullableField(string name, string? value) =>
        value is null ? $"{name}=-1:" : EncodeField(name, value);

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

    private static string RequireBootstrapValue(string value, string label)
    {
        if (string.IsNullOrWhiteSpace(value))
            throw new HostPolicyException(
                "approval-proof-bootstrap-invalid",
                $"The approval proof {label} is missing.");
        return value;
    }

    private static string RequireHexSha256(string value, string label)
    {
        if (value is null || value.Length != 64 || value.Any(character => !Uri.IsHexDigit(character)))
            throw new HostPolicyException(
                "approval-proof-bootstrap-invalid",
                $"The approval proof {label} is invalid.");
        return value.ToLowerInvariant();
    }

    private static bool IsHexSha256(string? value) =>
        value is { Length: 64 } && value.All(Uri.IsHexDigit);
}
