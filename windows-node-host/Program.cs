using System.Text;
using System.Text.Json;
using OpenClaw.Shared;
using OpenClaw.Shared.ExecApprovals;
using OpenClaw.Shared.Mxc;

namespace MicroClaw.WindowsNodeHost;

internal static class Program
{
    private static ProcessTreeJob? processTreeJob;

    private static async Task<int> Main(string[] args)
    {
        if (args is ["--remember-command", var consentDirectory])
        {
            try
            {
                SecureStateDirectory.Ensure(consentDirectory);
                using var store = new ExecApprovalsStore(consentDirectory, NullLogger.Instance);
                if (!string.Equals(ExecApprovalsStore.ResolveFilePath(consentDirectory),
                        Path.Combine(consentDirectory, "exec-approvals.json"), StringComparison.OrdinalIgnoreCase))
                    throw new HostPolicyException("consent-path-invalid", "Unexpected command consent store.");
                using var document = JsonDocument.Parse(await Console.In.ReadLineAsync() ?? "");
                var request = new NodeInvokeRequest
                {
                    Id = Guid.NewGuid().ToString("N"),
                    Command = "system.run",
                    Args = document.RootElement.Clone(),
                };
                var agent = request.Args.TryGetProperty("agentId", out var value) && value.ValueKind == JsonValueKind.String
                    ? value.GetString() : null;
                var defaults = store.ResolveReadOnly(agent).Defaults;
                if (defaults.Security != ExecSecurity.Allowlist || defaults.Ask != ExecAsk.OnMiss)
                    throw new HostPolicyException("consent-policy-changed", "Ask when needed is no longer active.");
                var consent = new CommandConsent(store, NullLogger.Instance);
                await consent.AuthorizeAsync(request, "allow-always");
                if ((await consent.PrepareAsync(request)).Preview.Required)
                    throw new HostPolicyException("consent-not-saved", "Windows Node did not persist a matching allowlist entry.");
                Console.WriteLine("remembered");
                return 0;
            }
            catch (Exception ex) when (ex is HostPolicyException or JsonException or IOException)
            {
                Console.Error.WriteLine(ex.Message);
                return 2;
            }
        }

        if (args is ["--attestation"])
        {
            Console.WriteLine(JsonSerializer.Serialize(CwdPolicyAttestation.Current));
            return 0;
        }

        if (args is ["--mxc-probe"])
        {
            var probe = MxcAvailability.Probe(new StderrLogger());
            Console.WriteLine(JsonSerializer.Serialize(new
            {
                contract = "microclaw.mxc-sdk-probe.v1",
                supported = probe.CanRunSystemRunSandbox,
                windowsUnsupported = probe.IsWindowsUnsupported,
                probeErrored = probe.ProbeErrored,
                tier = probe.IsolationTier,
                needsDaclAugmentation = probe.NeedsDaclAugmentation,
                supportsProtectedPathDenies = probe.SupportsProtectedPathDenies,
                warnings = probe.Warnings,
                reasons = probe.SystemRunSandboxUnsupportedReasons,
            }));
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

        if (args is ["--validate-folders", var approvalsPath])
        {
            try
            {
                Console.OutputEncoding = Encoding.UTF8;
                using var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false, true));
                var json = await input.ReadToEndAsync();
                if (string.IsNullOrWhiteSpace(json))
                    throw new HostPolicyException("malformed-policy", "Policy input is missing.");
                var policy = HostPolicy.Parse(Encoding.UTF8.GetBytes(json));
                if (policy.RequestedStrength != "full")
                    throw new HostPolicyException("containment-strength-invalid", "Folder validation requires MXC.");
                MxcSdkRunner.ValidatePolicy(policy, approvalsPath);
                Console.WriteLine("validated");
                return 0;
            }
            catch (Exception ex) when (ex is HostPolicyException or NotSupportedException
                or IOException or UnauthorizedAccessException or ArgumentException)
            {
                Console.Error.WriteLine(ex.Message);
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
                "This helper is managed by MicroClaw. Supported diagnostics: --attestation, --validate-config <path>, --validate-folders <approvals-path>, --mxc-probe.");
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
            using var gatewayIdentity = GatewayProcessIdentity.Capture(bootstrap.GatewayProcessId);

            var policy = await HostPolicy.LoadVerifiedAsync(
                bootstrap.PolicyPath,
                bootstrap.PolicyFingerprint);
            if (policy.RequestedStrength != "off")
            {
                await MxcIsolationTierGuard.EnsureFilesystemIsolationAsync(
                    policy.RequestedStrength,
                    policy.EffectiveTier);
            }
            SecureStateDirectory.Ensure(bootstrap.IdentityDirectory);
            var approvalDirectory = Path.GetDirectoryName(bootstrap.ApprovalsPath)
                ?? throw new HostPolicyException(
                    "approval-path-invalid",
                    "The durable approval store has no parent directory.");
            SecureStateDirectory.Ensure(approvalDirectory);
            Task<ReconnectAuthorizationResult> AuthorizeGatewayAsync(CancellationToken _) =>
                Task.FromResult(
                    gatewayIdentity.IsCurrentLoopbackListenerOwner(gatewayUri.Port)
                        ? ReconnectAuthorizationResult.AllowedResult
                        : new ReconnectAuthorizationResult(
                            false,
                            GatewayErrorKind.LocalPortConflict,
                            "The expected MicroClaw Gateway process does not own the loopback listener."));
            var logger = new StderrLogger();
            var identity = new DeviceIdentity(bootstrap.IdentityDirectory, logger);
            identity.Initialize();
            if (!string.Equals(identity.DeviceId, bootstrap.NodeId, StringComparison.OrdinalIgnoreCase))
                throw new HostPolicyException(
                    "node-identity-mismatch",
                    "The persisted bundled node identity does not match the configured MicroClaw node.");

            var recovery = new NodeDeviceTokenRecovery();
            using var liveCapabilities = new LivePolicyCapabilities(
                bootstrap,
                processTreeJob);
            await liveCapabilities.InitializeAsync();
            while (true)
            {
                GatewayErrorKind failureKind;
                {
                    var tokenMismatch = new TaskCompletionSource<GatewayErrorKind>(
                        TaskCreationOptions.RunContinuationsAsynchronously);
                    using var connection = new WindowsNodeClient(
                        gatewayUrl: gatewayUri.ToString(),
                        token: bootstrap.GatewayToken,
                        dataPath: bootstrap.IdentityDirectory,
                        logger: logger);
                    connection.HandshakeAuthorizationAsync = AuthorizeGatewayAsync;
                    connection.ReconnectAuthorizationAsync = AuthorizeGatewayAsync;
                    connection.ConnectionFailure += (_, kind) =>
                    {
                        Console.Error.WriteLine($"node-connection-failure: {kind}");
                        if (kind == GatewayErrorKind.DeviceTokenMismatch)
                            tokenMismatch.TrySetResult(kind);
                    };
                    connection.RegisterCapability(liveCapabilities.System);

                    var connect = connection.ConnectAsync();
                    if (await Task.WhenAny(connect, ownerLifetime) == ownerLifetime)
                    {
                        await ownerLifetime;
                        return 0;
                    }
                    await connect;
                    if (await Task.WhenAny(ownerLifetime, tokenMismatch.Task) == ownerLifetime)
                    {
                        await ownerLifetime;
                        return 0;
                    }

                    failureKind = await tokenMismatch.Task;
                }
                if (!recovery.TryRecover(
                        failureKind,
                        bootstrap.IdentityDirectory,
                        bootstrap.NodeId,
                        () => gatewayIdentity.IsCurrentLoopbackListenerOwner(gatewayUri.Port),
                        logger,
                        out var rejectionReason))
                {
                    throw new HostPolicyException(
                        "node-device-token-recovery-rejected",
                        $"The bundled node could not recover its stale credential: {rejectionReason}.");
                }
                Console.Error.WriteLine(
                    "node-device-token-recovery: cleared the exact bundled node token and reconnecting");
            }
        }
        catch (HostPolicyException ex)
        {
            Console.Error.WriteLine($"{ex.Code}: {ex.Message}");
            return 2;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine(
                $"host-unhandled: {ex.GetType().Name}: {TokenSanitizer.Sanitize(ex.Message)}");
            return 3;
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
    public string LivePolicyPath { get; init; } = string.Empty;
    public string LivePolicyPublicKey { get; init; } = string.Empty;
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
