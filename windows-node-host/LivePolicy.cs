using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using OpenClaw.Shared;

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
        runtimePolicy.Remove("approvedRoots");
        if (_runtimePolicy is not null && !JsonNode.DeepEquals(_runtimePolicy, runtimePolicy))
            throw new HostPolicyException("live-policy-runtime-change", "Only folder grants may change in a live policy.");
        var policy = HostPolicy.Parse(Encoding.UTF8.GetBytes(policyJson));
        _runtimePolicy ??= runtimePolicy;
        _current = new LivePolicySnapshot(revision, fingerprint, policy, payload);
        _lastEnvelope = text;
        return _current;
    }
}

internal sealed class LivePolicyCapabilities : IDisposable
{
    private readonly HostBootstrap _bootstrap;
    private readonly LivePolicyReader _reader;
    private readonly Func<JsonObject, Task<bool>> _sendEvent;
    private readonly ProcessTreeJob _processTreeJob;
    private readonly SemaphoreSlim _updateGate = new(1, 1);
    private readonly object _gate = new();
    private readonly HashSet<Task> _running = [];
    private CancellationTokenSource _generationCancellation = new();
    private LivePolicySnapshot? _snapshot;
    private BundledSystemCapability? _system;
    private BundledCanvasCapability? _canvas;
    private CanvasHostBroker? _broker;
    private bool _locked = true;

    public LivePolicyCapabilities(HostBootstrap bootstrap, Func<JsonObject, Task<bool>> sendEvent,
        ProcessTreeJob processTreeJob)
    {
        _bootstrap = bootstrap;
        _reader = new LivePolicyReader(
            bootstrap.LivePolicyPath, bootstrap.LivePolicyPublicKey, bootstrap.GatewayGeneration);
        _sendEvent = sendEvent;
        _processTreeJob = processTreeJob;
    }

    public async Task InitializeAsync()
    {
        var initial = await _reader.ReadAsync();
        if (initial.Fingerprint != _bootstrap.PolicyFingerprint)
            throw new HostPolicyException("live-policy-bootstrap", "The initial live policy does not match bootstrap.");
        await SynchronizeAsync();
    }

    public INodeCapability System => new Proxy(this, "system",
        ["system.run", ReadinessProbeContract.Command, "system.run.prepare", "system.which", "system.run.cwd-policy"]);
    public INodeCapability Canvas => new Proxy(this, "canvas", CanvasPhase1Policy.Commands);

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
            _broker?.Dispose();
            await _processTreeJob.EnsureNoChildProcessesAsync();
            _generationCancellation.Dispose();
            _generationCancellation = new CancellationTokenSource();
            var lease = new ActivationLeaseGuard(
                _bootstrap.ActivationLeasePath, _bootstrap.ActivationLeaseSecret,
                _bootstrap.GatewayGeneration, next.Fingerprint);
            _broker = new CanvasHostBroker(
                next.Policy, _bootstrap.ActivationLeasePath, _bootstrap.ActivationLeaseSecret,
                _bootstrap.GatewayGeneration, next.Fingerprint, _bootstrap.NodeId,
                _bootstrap.UiLocale, lease, _sendEvent);
            _system = new BundledSystemCapability(
                next.Policy, _bootstrap.ApprovalPipeName, _bootstrap.ApprovalsPath, lease,
                _bootstrap.UiLocale,
                new ApprovalProofVerifier(_bootstrap.ApprovalProofSecret,
                    _bootstrap.GatewayGeneration, next.Fingerprint, _bootstrap.NodeId),
                new ReadinessProofVerifier(_bootstrap.ApprovalProofSecret,
                    _bootstrap.GatewayGeneration, next.Fingerprint, _bootstrap.NodeId,
                    _bootstrap.ReadinessTransitionId),
                policyFingerprint: next.Fingerprint);
            _canvas = new BundledCanvasCapability(_broker, lease);
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
        bool canvas, NodeInvokeRequest request, CancellationToken cancellationToken)
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
                task = canvas
                    ? _canvas!.ExecuteAsync(request, linked.Token)
                    : _system!.ExecuteAsync(request, linked.Token);
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
        _broker?.Dispose();
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
            owner.ExecuteAsync(category == "canvas", request, cancellationToken);
    }
}
