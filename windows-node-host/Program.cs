using System.Text.Json;
using OpenClaw.Shared;

namespace MicroClaw.WindowsNodeHost;

internal static class Program
{
    private static ProcessTreeJob? processTreeJob;

    private static async Task<int> Main(string[] args)
    {
        if (args is ["--attestation"])
        {
            Console.WriteLine(JsonSerializer.Serialize(CwdPolicyAttestation.Current));
            return 0;
        }

        if (args is ["--validate-config", var path])
        {
            try
            {
                var policy = await HostPolicy.LoadAsync(path);
                Console.WriteLine(JsonSerializer.Serialize(policy.Attestation));
                return 0;
            }
            catch (HostPolicyException ex)
            {
                Console.Error.WriteLine($"{ex.Code}: {ex.Message}");
                return 2;
            }
        }

        if (args is ["--identity", var identityDirectory])
        {
            SecureStateDirectory.Ensure(identityDirectory);
            var identity = new DeviceIdentity(identityDirectory, NullLogger.Instance);
            identity.Initialize();
            Console.WriteLine(identity.DeviceId);
            return 0;
        }

        if (args.Length != 0)
        {
            Console.Error.WriteLine(
                "This helper is managed by MicroClaw. Supported diagnostics: --attestation, --validate-config <path>.");
            return 2;
        }

        try
        {
            processTreeJob = ProcessTreeJob.CreateForCurrentProcess();
            var bootstrapJson = await Console.In.ReadLineAsync();
            var bootstrap = JsonSerializer.Deserialize<HostBootstrap>(
                bootstrapJson ?? string.Empty,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
                ?? throw new HostPolicyException("bootstrap-empty", "MicroClaw bootstrap input is missing.");
            var ownerLifetime = OwnerProcessLifetime.WaitForExitAsync(bootstrap.OwnerProcessId);
            var gatewayUri = new Uri(bootstrap.GatewayUrl, UriKind.Absolute);
            if (gatewayUri.Scheme is not ("ws" or "wss")
                || !string.Equals(gatewayUri.Host, "127.0.0.1", StringComparison.Ordinal))
                throw new HostPolicyException(
                    "gateway-not-loopback",
                    "The bundled node accepts the app-owned IPv4 loopback Gateway endpoint only.");
            if (bootstrap.GatewayProcessId <= 0)
                throw new HostPolicyException(
                    "gateway-process-missing",
                    "The app-owned Gateway process identity is missing.");
            if (string.IsNullOrWhiteSpace(bootstrap.GatewayToken))
                throw new HostPolicyException("gateway-token-missing", "The app-owned Gateway credential is missing.");

            var policy = await HostPolicy.LoadVerifiedAsync(
                bootstrap.PolicyPath,
                bootstrap.PolicyFingerprint);
            SecureStateDirectory.Ensure(bootstrap.IdentityDirectory);
            var approvalDirectory = Path.GetDirectoryName(bootstrap.ApprovalsPath)
                ?? throw new HostPolicyException(
                    "approval-path-invalid",
                    "The durable approval store has no parent directory.");
            SecureStateDirectory.Ensure(approvalDirectory);
            using var client = new WindowsNodeClient(
                gatewayUrl: gatewayUri.ToString(),
                token: bootstrap.GatewayToken,
                dataPath: bootstrap.IdentityDirectory,
                logger: new StderrLogger());
            Task<ReconnectAuthorizationResult> AuthorizeGatewayAsync(CancellationToken _) =>
                Task.FromResult(
                    GatewayListenerOwnership.IsLoopbackListenerOwnedBy(
                        gatewayUri.Port,
                        bootstrap.GatewayProcessId)
                        ? ReconnectAuthorizationResult.AllowedResult
                        : new ReconnectAuthorizationResult(
                            false,
                            GatewayErrorKind.LocalPortConflict,
                            "The expected MicroClaw Gateway process does not own the loopback listener."));
            client.HandshakeAuthorizationAsync = AuthorizeGatewayAsync;
            client.ReconnectAuthorizationAsync = AuthorizeGatewayAsync;
            client.RegisterCapability(new BundledSystemCapability(
                policy,
                bootstrap.ApprovalPipeName,
                bootstrap.ApprovalsPath,
                new ActivationLeaseGuard(
                    bootstrap.ActivationLeasePath,
                    bootstrap.ActivationLeaseSecret,
                    bootstrap.GatewayGeneration,
                    bootstrap.PolicyFingerprint),
                bootstrap.UiLocale,
                new ApprovalProofVerifier(
                    bootstrap.ApprovalProofSecret,
                    bootstrap.GatewayGeneration,
                    bootstrap.PolicyFingerprint,
                    bootstrap.NodeId),
                new ReadinessProofVerifier(
                    bootstrap.ApprovalProofSecret,
                    bootstrap.GatewayGeneration,
                    bootstrap.PolicyFingerprint,
                    bootstrap.NodeId,
                    bootstrap.ReadinessTransitionId)));
            var connect = client.ConnectAsync();
            if (await Task.WhenAny(connect, ownerLifetime) == ownerLifetime)
                return 0;
            await connect;
            await ownerLifetime;
            return 0;
        }
        catch (HostPolicyException ex)
        {
            Console.Error.WriteLine($"{ex.Code}: {ex.Message}");
            return 2;
        }
    }

}

internal sealed class HostBootstrap
{
    public string GatewayUrl { get; init; } = string.Empty;
    public string GatewayToken { get; init; } = string.Empty;
    public int GatewayProcessId { get; init; }
    public int OwnerProcessId { get; init; }
    public string PolicyPath { get; init; } = string.Empty;
    public string IdentityDirectory { get; init; } = string.Empty;
    public string ApprovalPipeName { get; init; } = string.Empty;
    public string ApprovalsPath { get; init; } = string.Empty;
    public string ActivationLeasePath { get; init; } = string.Empty;
    public string ActivationLeaseSecret { get; init; } = string.Empty;
    public string GatewayGeneration { get; init; } = string.Empty;
    public string PolicyFingerprint { get; init; } = string.Empty;
    public string ApprovalProofSecret { get; init; } = string.Empty;
    public string NodeId { get; init; } = string.Empty;
    public string ReadinessTransitionId { get; init; } = string.Empty;
    public string UiLocale { get; init; } = "en-US";
}

internal sealed class StderrLogger : IOpenClawLogger
{
    public void Info(string message) => Write("info", message);
    public void Debug(string message) { }
    public void Warn(string message) => Write("warn", message);
    public void Error(string message, Exception? ex = null) =>
        Write("error", ex is null ? message : $"{message}: {ex.GetType().Name}");

    private static void Write(string level, string message)
    {
        var safe = message
            .Replace(Environment.UserName, "<user>", StringComparison.OrdinalIgnoreCase)
            .Replace(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "<home>", StringComparison.OrdinalIgnoreCase);
        Console.Error.WriteLine($"[{level}] {safe}");
    }
}
