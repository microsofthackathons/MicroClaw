using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using OpenClaw.Shared;
using OpenClaw.Shared.ExecApprovals;

namespace MicroClaw.WindowsNodeHost;

internal sealed record LivePolicySnapshot(
    long Revision,
    string Fingerprint,
    HostPolicy Policy,
    string Payload);

internal sealed class LivePolicyReader(string filePath, string publicKey, string gatewayGeneration)
{
    private LivePolicySnapshot? _current;
    private JsonNode? _runtimePolicy;
    private string? _lastEnvelope;
    private readonly HashSet<Guid> _policyEpochs = [];

    public async Task<LivePolicySnapshot> ReadAsync()
    {
        var text = await File.ReadAllTextAsync(filePath);
        if (_current is not null && _lastEnvelope == text)
            return _current;
        var envelope = JsonNode.Parse(text)
            ?? throw new HostPolicyException("live-policy-invalid", "The live policy is empty.");
        var payload = envelope["payload"]?.GetValue<string>()
            ?? throw new HostPolicyException("live-policy-invalid", "The live policy payload is missing.");
        using var verifier = ECDsa.Create();
        verifier.ImportSubjectPublicKeyInfo(Convert.FromBase64String(publicKey), out _);
        var signature = Convert.FromBase64String(envelope["signature"]?.GetValue<string>() ?? "");
        if (!verifier.VerifyData(Encoding.UTF8.GetBytes(payload), signature,
                HashAlgorithmName.SHA256, DSASignatureFormat.IeeeP1363FixedFieldConcatenation))
            throw new HostPolicyException("live-policy-signature", "The live policy signature is invalid.");
        var value = JsonNode.Parse(payload)
            ?? throw new HostPolicyException("live-policy-invalid", "The live policy payload is empty.");
        var revision = value["revision"]?.GetValue<long>() ?? 0;
        if (value["contract"]?.GetValue<string>() != "microclaw.windows-node-live-policy.v1"
            || value["gatewayGeneration"]?.GetValue<string>() != gatewayGeneration
            || revision <= (_current?.Revision ?? 0))
            throw new HostPolicyException("live-policy-stale", "The live policy generation or revision is invalid.");
        var policyJson = value["policyJson"]?.GetValue<string>()
            ?? throw new HostPolicyException("live-policy-invalid", "The sandbox policy is missing.");
        var fingerprint = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(policyJson)))
            .ToLowerInvariant();
        if (value["policyFingerprint"]?.GetValue<string>() != fingerprint)
            throw new HostPolicyException("live-policy-fingerprint", "The live policy fingerprint is invalid.");
        var runtimePolicy = JsonNode.Parse(policyJson)?.AsObject()
            ?? throw new HostPolicyException("live-policy-invalid", "The sandbox policy is invalid.");
        var epochText = runtimePolicy["livePolicyEpoch"]?.GetValue<string>();
        Guid? epoch = null;
        if (epochText is not null)
        {
            if (!Guid.TryParseExact(epochText, "D", out var parsedEpoch) || _policyEpochs.Contains(parsedEpoch))
                throw new HostPolicyException("live-policy-epoch", "The live policy epoch is invalid or reused.");
            epoch = parsedEpoch;
        }
        else if (_current is not null)
            throw new HostPolicyException("live-policy-epoch", "A new live policy epoch is required.");
        if (_current is not null && runtimePolicy["commandConsentMode"]?.GetValue<string>()
            is not (CommandConsent.AskWhenNeeded or CommandConsent.AllowAlways))
            throw new HostPolicyException("consent-mode-invalid", "A valid command consent mode is required.");
        runtimePolicy.Remove("approvedRoots");
        runtimePolicy.Remove("commandConsentMode");
        runtimePolicy.Remove("livePolicyEpoch");
        runtimePolicy.Remove("requestedStrength");
        runtimePolicy.Remove("effectiveTier");
        if (_runtimePolicy is not null && !JsonNode.DeepEquals(_runtimePolicy, runtimePolicy))
            throw new HostPolicyException("live-policy-runtime-change", "Only sandbox mode, folder grants and command consent may change in a live policy.");
        var policy = HostPolicy.Parse(Encoding.UTF8.GetBytes(policyJson));
        if (_current is not null && policy.CommandConsentMode != _current.Policy.CommandConsentMode
            && value["approval"] is not null)
            throw new HostPolicyException("live-policy-consent-approval", "A command consent update cannot bridge a previous approval.");
        if (_current is not null && policy.RequestedStrength != _current.Policy.RequestedStrength
            && value["approval"] is not null)
            throw new HostPolicyException("live-policy-mode-approval", "A sandbox mode update cannot bridge a previous approval.");
        _runtimePolicy ??= runtimePolicy;
        if (epoch.HasValue) _policyEpochs.Add(epoch.Value);
        _current = new LivePolicySnapshot(revision, fingerprint, policy, payload);
        _lastEnvelope = text;
        return _current;
    }
}

internal sealed class LivePolicyCapabilities : IDisposable
{
    private readonly HostBootstrap _bootstrap;
    private readonly LivePolicyReader _reader;
    private readonly ProcessTreeJob _processTreeJob;
    private readonly SemaphoreSlim _updateGate = new(1, 1);
    private readonly object _gate = new();
    private readonly HashSet<Task> _running = [];
    private CancellationTokenSource _generationCancellation = new();
    private LivePolicySnapshot? _snapshot;
    private BundledSystemCapability? _system;
    private bool _locked = true;
    private ExecApprovalsStore? _consentStore;
    private CommandConsent? _consent;
    private string? _appliedConsentMode;

    public LivePolicyCapabilities(HostBootstrap bootstrap, ProcessTreeJob processTreeJob)
    {
        _bootstrap = bootstrap;
        _reader = new LivePolicyReader(
            bootstrap.LivePolicyPath, bootstrap.LivePolicyPublicKey, bootstrap.GatewayGeneration);
        _processTreeJob = processTreeJob;
    }

    public async Task InitializeAsync()
    {
        var initial = await _reader.ReadAsync();
        if (initial.Fingerprint != _bootstrap.PolicyFingerprint)
            throw new HostPolicyException("live-policy-bootstrap", "The initial live policy does not match bootstrap.");
        var consentDirectory = Path.Combine(Path.GetDirectoryName(_bootstrap.ApprovalsPath)!, "command-consent");
        SecureStateDirectory.Ensure(consentDirectory);
        _consentStore = new ExecApprovalsStore(consentDirectory, NullLogger.Instance);
        if (!string.Equals(ExecApprovalsStore.ResolveFilePath(consentDirectory),
                Path.Combine(consentDirectory, "exec-approvals.json"), StringComparison.OrdinalIgnoreCase))
            throw new HostPolicyException("consent-path-invalid", "The command consent store must remain app-owned.");
        _consent = new CommandConsent(_consentStore, NullLogger.Instance);
        await SynchronizeAsync();
    }

    public INodeCapability System => new Proxy(this, "system",
        ["system.run", ReadinessProbeContract.Command, "system.run.prepare", "system.which", "system.run.cwd-policy"]);

    private async Task SynchronizeAsync()
    {
        await _updateGate.WaitAsync();
        try
        {
            var next = await _reader.ReadAsync();
            if (_snapshot?.Revision == next.Revision)
                return;
            Task[] running;
            lock (_gate)
            {
                _locked = true;
                running = _running.ToArray();
            }
            await _generationCancellation.CancelAsync();
            // A revoked grant must not survive in an already-created container.
            await Task.WhenAll(running).WaitAsync(TimeSpan.FromSeconds(30));
            if (_system is not null)
                await _system.WaitForOwnedOperationsAsync().WaitAsync(TimeSpan.FromSeconds(30));
            await _processTreeJob.EnsureNoChildProcessesAsync();
            _system?.Dispose();
            _generationCancellation.Dispose();
            _generationCancellation = new CancellationTokenSource();
            if (_appliedConsentMode != next.Policy.CommandConsentMode)
            {
                _appliedConsentMode = null;
                await (_consent ?? throw new HostPolicyException(
                    "consent-unavailable", "The command consent store is unavailable."))
                    .SetModeAsync(next.Policy.CommandConsentMode);
                _appliedConsentMode = next.Policy.CommandConsentMode;
            }
            var lease = new ActivationLeaseGuard(
                _bootstrap.ActivationLeasePath, _bootstrap.ActivationLeaseSecret,
                _bootstrap.GatewayGeneration, next.Fingerprint);
            _system = new BundledSystemCapability(
                next.Policy, _bootstrap.ApprovalPipeName, _bootstrap.ApprovalsPath, lease,
                _bootstrap.UiLocale,
                new ApprovalProofVerifier(_bootstrap.ApprovalProofSecret,
                    _bootstrap.GatewayGeneration, next.Fingerprint, _bootstrap.NodeId),
                new ReadinessProofVerifier(_bootstrap.ApprovalProofSecret,
                    _bootstrap.GatewayGeneration, next.Fingerprint, _bootstrap.NodeId,
                    _bootstrap.ReadinessTransitionId),
                policyFingerprint: next.Fingerprint,
                commandConsent: _consent);
            lock (_gate)
            {
                _snapshot = next;
                _locked = false;
            }
        }
        catch
        {
            lock (_gate)
            {
                _locked = true;
            }
            await _generationCancellation.CancelAsync();
            throw;
        }
        finally
        {
            _updateGate.Release();
        }
    }

    private async Task<NodeInvokeResponse> ExecuteAsync(
        NodeInvokeRequest request, CancellationToken cancellationToken)
    {
        try
        {
            await SynchronizeAsync();
            Task<NodeInvokeResponse> task;
            CancellationTokenSource linked;
            lock (_gate)
            {
                if (_locked)
                    throw new HostPolicyException("live-policy-locked", "The folder policy update has not completed.");
                if (request.Command == "system.run.cwd-policy"
                    && request.Args.ValueKind == JsonValueKind.Object
                    && request.Args.TryGetProperty("livePolicyStatus", out var status)
                    && status.ValueKind == JsonValueKind.True)
                    return new NodeInvokeResponse
                    {
                        Ok = true,
                        Payload = new { revision = _snapshot!.Revision, policyFingerprint = _snapshot.Fingerprint },
                    };
                linked = CancellationTokenSource.CreateLinkedTokenSource(
                    cancellationToken, _generationCancellation.Token);
                task = _system!.ExecuteAsync(request, linked.Token);
                _running.Add(task);
            }
            try { return await task; }
            finally
            {
                lock (_gate) _running.Remove(task);
                linked.Dispose();
            }
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"live-policy: {ex.GetType().Name}: {ex.Message}");
            return new NodeInvokeResponse { Ok = false, Error = $"live-policy-locked: {ex.Message}" };
        }
    }

    public void Dispose()
    {
        _generationCancellation.Cancel();
        _system?.Dispose();
        _consentStore?.Dispose();
    }

    private sealed class Proxy(
        LivePolicyCapabilities owner, string category, IReadOnlyList<string> commands) : INodeCapability
    {
        public string Category => category;
        public IReadOnlyList<string> Commands => commands;
        public bool CanHandle(string command) => Commands.Contains(command, StringComparer.Ordinal);
        public Task<NodeInvokeResponse> ExecuteAsync(NodeInvokeRequest request) =>
            ExecuteAsync(request, CancellationToken.None);
        public Task<NodeInvokeResponse> ExecuteAsync(NodeInvokeRequest request, CancellationToken cancellationToken) =>
            owner.ExecuteAsync(request, cancellationToken);
    }
}
