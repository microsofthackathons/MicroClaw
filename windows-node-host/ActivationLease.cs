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
    private static readonly string[] HostnameSmoke =
    [
        @"C:\Windows\System32\cmd.exe",
        "/d",
        "/s",
        "/c",
        @"C:\Windows\System32\hostname.exe && echo MICROCLAW_MXC_HOSTNAME_OK",
    ];

    private static readonly string[] PowerShellSmoke =
    [
        @"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe",
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "[Console]::Out.Write('MICROCLAW_MXC_POWERSHELL_OK')",
    ];

    private readonly byte[] _secret = DecodeSecret(secretBase64);

    public ValidatedActivationLease Validate(IReadOnlyList<string> argv)
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

        if (lease.Mode is ActivationLeaseMode.Diagnostic
            && !Matches(argv, HostnameSmoke)
            && !Matches(argv, PowerShellSmoke))
        {
            throw new HostPolicyException(
                "activation-lease-diagnostic-scope",
                "The diagnostic activation lease permits only MicroClaw's fixed contained smokes.");
        }

        return new ValidatedActivationLease(
            lease.Mode,
            lease.GatewayGeneration,
            lease.PolicyFingerprint,
            lease.ExpiresAtUnixMs,
            lease.Signature);
    }

    public void Revalidate(ValidatedActivationLease expected, IReadOnlyList<string> argv)
    {
        var current = Validate(argv);
        if (current != expected)
            throw new HostPolicyException(
                "activation-lease-changed",
                "The MicroClaw activation lease changed before process launch.");
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

    private static bool Matches(IReadOnlyList<string> actual, IReadOnlyList<string> expected) =>
        actual.Count == expected.Count
        && actual.Select((value, index) =>
                string.Equals(
                    value,
                    expected[index],
                    index == 0 ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
            .All(matches => matches);

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
