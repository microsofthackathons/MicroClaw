using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace MicroClaw.WindowsNodeHost;

public static class ActivationLeaseContract
{
    public const string Version = "microclaw.windows-activation.v1";
}

public enum ActivationLeaseMode
{
    Diagnostic,
    Active,
}

public sealed record ActivationLeaseRecord(
    [property: JsonPropertyName("contract")] string Contract,
    [property: JsonPropertyName("mode")] ActivationLeaseMode Mode,
    [property: JsonPropertyName("gatewayGeneration")] string GatewayGeneration,
    [property: JsonPropertyName("policyFingerprint")] string PolicyFingerprint,
    [property: JsonPropertyName("expiresAtUnixMs")] long ExpiresAtUnixMs,
    [property: JsonPropertyName("signature")] string Signature);

public sealed record ValidatedActivationLease(
    ActivationLeaseMode Mode,
    string GatewayGeneration,
    string PolicyFingerprint,
    long ExpiresAtUnixMs,
    string Signature);

public sealed class ActivationLeaseGuard(
    string leasePath,
    string secretBase64,
    string expectedGatewayGeneration,
    string expectedPolicyFingerprint)
{
    private readonly byte[] _secret = DecodeSecret(secretBase64);

    public ValidatedActivationLease Validate(IReadOnlyList<string> argv)
    {
        var lease = ValidateCore();
        if (lease.Mode is ActivationLeaseMode.Diagnostic
            && !ReadinessProbeContract.Probes.Values.Any(expected =>
                ReadinessProbeContract.Matches(argv, expected)))
        {
            throw new HostPolicyException(
                "activation-lease-diagnostic-scope",
                "The diagnostic activation lease permits only MicroClaw's fixed contained smokes.");
        }

        return lease;
    }

    public ValidatedActivationLease ValidateActive()
    {
        var lease = ValidateCore();
        if (lease.Mode is not ActivationLeaseMode.Active)
            throw new HostPolicyException(
                "activation-lease-active-required",
                "This capability is available only while MXC is Active.");
        return lease;
    }

    public ValidatedActivationLease RevalidateActive(ValidatedActivationLease expected)
    {
        var current = ValidateActive();
        if (!IsSameScopeMonotonicRenewal(expected, current))
            throw new HostPolicyException(
                "activation-lease-changed",
                "The MicroClaw activation lease changed before capability execution.");
        return current;
    }

    public ValidatedActivationLease Revalidate(
        ValidatedActivationLease expected,
        IReadOnlyList<string> argv)
    {
        var current = Validate(argv);
        if (!IsSameScopeMonotonicRenewal(expected, current))
            throw new HostPolicyException(
                "activation-lease-changed",
                "The MicroClaw activation lease changed before process launch.");
        return current;
    }

    private static bool IsSameScopeMonotonicRenewal(
        ValidatedActivationLease expected,
        ValidatedActivationLease current) =>
        current.Mode == expected.Mode
        && string.Equals(
            current.GatewayGeneration,
            expected.GatewayGeneration,
            StringComparison.Ordinal)
        && string.Equals(
            current.PolicyFingerprint,
            expected.PolicyFingerprint,
            StringComparison.Ordinal)
        && current.ExpiresAtUnixMs >= expected.ExpiresAtUnixMs;

    private ValidatedActivationLease ValidateCore()
    {
        ActivationLeaseRecord lease;
        try
        {
            var json = File.ReadAllText(leasePath);
            var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
            options.Converters.Add(new JsonStringEnumConverter());
            lease = JsonSerializer.Deserialize<ActivationLeaseRecord>(json, options)
                ?? throw new HostPolicyException(
                    "activation-lease-invalid",
                    "The MicroClaw activation lease is empty.");
        }
        catch (HostPolicyException)
        {
            throw;
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            throw new HostPolicyException(
                "activation-lease-unavailable",
                $"A current MicroClaw activation lease is required: {ex.GetType().Name}");
        }

        if (!string.Equals(lease.Contract, ActivationLeaseContract.Version, StringComparison.Ordinal))
            throw new HostPolicyException(
                "activation-lease-contract",
                "The MicroClaw activation lease contract is unsupported.");
        if (!string.Equals(
                lease.GatewayGeneration,
                expectedGatewayGeneration,
                StringComparison.Ordinal))
            throw new HostPolicyException(
                "activation-lease-generation",
                "The activation lease belongs to a different Gateway generation.");
        if (!string.Equals(
                lease.PolicyFingerprint,
                expectedPolicyFingerprint,
                StringComparison.Ordinal))
            throw new HostPolicyException(
                "activation-lease-policy",
                "The activation lease belongs to a different sandbox policy.");
        if (lease.ExpiresAtUnixMs <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())
            throw new HostPolicyException(
                "activation-lease-expired",
                "The MicroClaw activation lease expired.");

        byte[] actualSignature;
        try
        {
            actualSignature = Convert.FromHexString(lease.Signature);
        }
        catch (FormatException)
        {
            throw new HostPolicyException(
                "activation-lease-signature",
                "The activation lease signature is malformed.");
        }
        var expectedSignature = Sign(
            _secret,
            lease.Mode,
            lease.GatewayGeneration,
            lease.PolicyFingerprint,
            lease.ExpiresAtUnixMs);
        if (!CryptographicOperations.FixedTimeEquals(actualSignature, expectedSignature))
            throw new HostPolicyException(
                "activation-lease-signature",
                "The activation lease signature is invalid.");

        return new ValidatedActivationLease(
            lease.Mode,
            lease.GatewayGeneration,
            lease.PolicyFingerprint,
            lease.ExpiresAtUnixMs,
            lease.Signature);
    }

    public static string ComputeSignature(
        string secretBase64,
        ActivationLeaseMode mode,
        string gatewayGeneration,
        string policyFingerprint,
        long expiresAtUnixMs) =>
        Convert.ToHexString(
            Sign(
                DecodeSecret(secretBase64),
                mode,
                gatewayGeneration,
                policyFingerprint,
                expiresAtUnixMs))
            .ToLowerInvariant();

    private static byte[] Sign(
        byte[] secret,
        ActivationLeaseMode mode,
        string gatewayGeneration,
        string policyFingerprint,
        long expiresAtUnixMs)
    {
        var payload = string.Join(
            "\n",
            ActivationLeaseContract.Version,
            mode.ToString().ToLowerInvariant(),
            gatewayGeneration,
            policyFingerprint,
            expiresAtUnixMs.ToString(System.Globalization.CultureInfo.InvariantCulture));
        return HMACSHA256.HashData(secret, Encoding.UTF8.GetBytes(payload));
    }

    private static byte[] DecodeSecret(string secretBase64)
    {
        try
        {
            var secret = Convert.FromBase64String(secretBase64);
            if (secret.Length != 32)
                throw new HostPolicyException(
                    "activation-secret-invalid",
                    "The activation lease secret must contain exactly 256 bits.");
            return secret;
        }
        catch (FormatException)
        {
            throw new HostPolicyException(
                "activation-secret-invalid",
                "The activation lease secret is malformed.");
        }
    }
}
