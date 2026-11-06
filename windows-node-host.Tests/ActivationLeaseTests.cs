using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using MicroClaw.WindowsNodeHost;

namespace MicroClaw.WindowsNodeHost.Tests;

public sealed class ActivationLeaseTests : IDisposable
{
    private readonly string _root = Path.Combine(
        Path.GetTempPath(),
        $"microclaw-activation-lease-{Guid.NewGuid():N}");

    public ActivationLeaseTests()
    {
        Directory.CreateDirectory(_root);
    }

    [Fact]
    public async Task SameScopeRenewalRevalidatesSystemRunAndActiveCapabilities()
    {
        var leasePath = Path.Combine(_root, "activation.json");
        var secret = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));
        var initialExpiry = DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeMilliseconds();
        var renewedExpiry = initialExpiry + 60_000;
        var guard = new ActivationLeaseGuard(leasePath, secret, "gateway-1", "policy-1");
        var argv = new[] { Path.Combine(Environment.SystemDirectory, "hostname.exe") };

        await WriteLease(
            leasePath,
            secret,
            ActivationLeaseMode.Active,
            "gateway-1",
            "policy-1",
            initialExpiry);
        var validatedSystemRun = guard.Validate(argv);
        var validatedActive = guard.ValidateActive();

        await WriteLease(
            leasePath,
            secret,
            ActivationLeaseMode.Active,
            "gateway-1",
            "policy-1",
            renewedExpiry);

        validatedSystemRun = guard.Revalidate(validatedSystemRun, argv);
        validatedActive = guard.RevalidateActive(validatedActive);
        Assert.Equal(renewedExpiry, validatedSystemRun.ExpiresAtUnixMs);
        Assert.Equal(renewedExpiry, validatedActive.ExpiresAtUnixMs);
    }

    [Fact]
    public async Task ReplayedShorterLeaseFailsAfterRenewal()
    {
        var leasePath = Path.Combine(_root, "activation.json");
        var secret = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));
        var initialExpiry = DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeMilliseconds();
        var renewedExpiry = initialExpiry + 60_000;
        var guard = new ActivationLeaseGuard(leasePath, secret, "gateway-1", "policy-1");
        var argv = new[] { Path.Combine(Environment.SystemDirectory, "hostname.exe") };

        await WriteLease(
            leasePath,
            secret,
            ActivationLeaseMode.Active,
            "gateway-1",
            "policy-1",
            initialExpiry);
        var validated = guard.Validate(argv);

        await WriteLease(
            leasePath,
            secret,
            ActivationLeaseMode.Active,
            "gateway-1",
            "policy-1",
            renewedExpiry);
        validated = guard.Revalidate(validated, argv);

        await WriteLease(
            leasePath,
            secret,
            ActivationLeaseMode.Active,
            "gateway-1",
            "policy-1",
            initialExpiry);
        var error = Assert.Throws<HostPolicyException>(() => guard.Revalidate(validated, argv));
        Assert.Equal("activation-lease-changed", error.Code);
    }

    [Theory]
    [InlineData(
        ActivationLeaseMode.Diagnostic,
        "gateway-1",
        "policy-1",
        "activation-lease-active-required")]
    [InlineData(
        ActivationLeaseMode.Active,
        "gateway-2",
        "policy-1",
        "activation-lease-generation")]
    [InlineData(
        ActivationLeaseMode.Active,
        "gateway-1",
        "policy-2",
        "activation-lease-policy")]
    public async Task ScopeChangesFailRevalidation(
        ActivationLeaseMode currentMode,
        string currentGeneration,
        string currentPolicy,
        string expectedCode)
    {
        var leasePath = Path.Combine(_root, "activation.json");
        var secret = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));
        var initialExpiry = DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeMilliseconds();
        var guard = new ActivationLeaseGuard(leasePath, secret, "gateway-1", "policy-1");

        await WriteLease(
            leasePath,
            secret,
            ActivationLeaseMode.Active,
            "gateway-1",
            "policy-1",
            initialExpiry);
        var validated = guard.ValidateActive();

        await WriteLease(
            leasePath,
            secret,
            currentMode,
            currentGeneration,
            currentPolicy,
            initialExpiry + 60_000);

        var error = Assert.Throws<HostPolicyException>(() => guard.RevalidateActive(validated));
        Assert.Equal(expectedCode, error.Code);
    }

    [Fact]
    public async Task InvalidSignatureFailsBeforeRenewalComparison()
    {
        var leasePath = Path.Combine(_root, "activation.json");
        var secret = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));
        var initialExpiry = DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeMilliseconds();
        var guard = new ActivationLeaseGuard(leasePath, secret, "gateway-1", "policy-1");

        await WriteLease(
            leasePath,
            secret,
            ActivationLeaseMode.Active,
            "gateway-1",
            "policy-1",
            initialExpiry);
        var validated = guard.ValidateActive();
        await WriteLease(
            leasePath,
            secret,
            ActivationLeaseMode.Active,
            "gateway-1",
            "policy-1",
            initialExpiry + 60_000,
            signature: new string('0', 64));

        var error = Assert.Throws<HostPolicyException>(() => guard.RevalidateActive(validated));
        Assert.Equal("activation-lease-signature", error.Code);
    }

    [Fact]
    public async Task DeletedOrExpiredRenewalFailsClosed()
    {
        var leasePath = Path.Combine(_root, "activation.json");
        var secret = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));
        var initialExpiry = DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeMilliseconds();
        var guard = new ActivationLeaseGuard(leasePath, secret, "gateway-1", "policy-1");

        await WriteLease(
            leasePath,
            secret,
            ActivationLeaseMode.Active,
            "gateway-1",
            "policy-1",
            initialExpiry);
        var validated = guard.ValidateActive();

        File.Delete(leasePath);
        var deleted = Assert.Throws<HostPolicyException>(() => guard.RevalidateActive(validated));
        Assert.Equal("activation-lease-unavailable", deleted.Code);

        await WriteLease(
            leasePath,
            secret,
            ActivationLeaseMode.Active,
            "gateway-1",
            "policy-1",
            DateTimeOffset.UtcNow.AddMilliseconds(-1).ToUnixTimeMilliseconds());
        var expired = Assert.Throws<HostPolicyException>(() => guard.RevalidateActive(validated));
        Assert.Equal("activation-lease-expired", expired.Code);
    }

    private static Task WriteLease(
        string path,
        string secret,
        ActivationLeaseMode mode,
        string gatewayGeneration,
        string policyFingerprint,
        long expiresAtUnixMs,
        string? signature = null)
    {
        var record = new ActivationLeaseRecord(
            ActivationLeaseContract.Version,
            mode,
            gatewayGeneration,
            policyFingerprint,
            expiresAtUnixMs,
            signature
                ?? ActivationLeaseGuard.ComputeSignature(
                    secret,
                    mode,
                    gatewayGeneration,
                    policyFingerprint,
                    expiresAtUnixMs));
        var options = new JsonSerializerOptions();
        options.Converters.Add(new JsonStringEnumConverter());
        return File.WriteAllTextAsync(path, JsonSerializer.Serialize(record, options));
    }

    public void Dispose()
    {
        try
        {
            if (Directory.Exists(_root))
                Directory.Delete(_root, recursive: true);
        }
        catch
        {
            // Best-effort cleanup for antivirus/indexer races in temporary test directories.
        }
    }
}
