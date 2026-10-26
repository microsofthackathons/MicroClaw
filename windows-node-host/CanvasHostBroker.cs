using System.Diagnostics;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace MicroClaw.WindowsNodeHost;

internal sealed class CanvasHostBroker : IDisposable
{
    private readonly HostPolicy _policy;
    private readonly string _leasePath;
    private readonly string _leaseSecret;
    private readonly string _generation;
    private readonly string _policyFingerprint;
    private readonly string _nodeId;
    private readonly string _uiLocale;
    private readonly Func<JsonObject, Task<bool>> _deliverAction;
    private readonly ActivationLeaseGuard _activationLease;
    private readonly string _commandPipeName = $"microclaw-canvas-command-{Guid.NewGuid():N}";
    private readonly string _actionPipeName = $"microclaw-canvas-action-{Guid.NewGuid():N}";
    private readonly string _ipcToken = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));
    private readonly SemaphoreSlim _commandGate = new(1, 1);
    private readonly CancellationTokenSource _shutdown = new();
    private Process? _process;
    private Task? _actionServer;

    public CanvasHostBroker(
        HostPolicy policy,
        string leasePath,
        string leaseSecret,
        string generation,
        string policyFingerprint,
        string nodeId,
        string uiLocale,
        ActivationLeaseGuard activationLease,
        Func<JsonObject, Task<bool>> deliverAction)
    {
        _policy = policy;
        _leasePath = leasePath;
        _leaseSecret = leaseSecret;
        _generation = generation;
        _policyFingerprint = policyFingerprint;
        _nodeId = nodeId;
        _uiLocale = uiLocale;
        _activationLease = activationLease;
        _deliverAction = deliverAction;
    }

    public async Task<object?> ExecuteAsync(
        string command,
        JsonElement args,
        ValidatedActivationLease lease,
        ActivationLeaseGuard leaseGuard,
        CancellationToken cancellationToken)
    {
        await _commandGate.WaitAsync(cancellationToken);
        try
        {
            CanvasPhase1Policy.ValidateCommand(command, args);
            lease = leaseGuard.RevalidateActive(lease);
            await EnsureHostAsync(cancellationToken);
            lease = leaseGuard.RevalidateActive(lease);
            using var pipe = new NamedPipeClientStream(
                ".",
                _commandPipeName,
                PipeDirection.InOut,
                PipeOptions.Asynchronous,
                System.Security.Principal.TokenImpersonationLevel.Identification);
            await pipe.ConnectAsync(5_000, cancellationToken);
            using var reader = new StreamReader(pipe, Encoding.UTF8, false, 64 * 1024, leaveOpen: true);
            using var writer = new StreamWriter(pipe, new UTF8Encoding(false), 64 * 1024, leaveOpen: true)
            {
                AutoFlush = true,
            };
            await writer.WriteLineAsync(JsonSerializer.Serialize(new
            {
                contract = CanvasPhase1Policy.Contract,
                token = _ipcToken,
                gatewayGeneration = _generation,
                policyFingerprint = _policyFingerprint,
                nodeId = _nodeId,
                command,
                args,
            }));
            var line = await reader.ReadLineAsync(cancellationToken)
                ?? throw new HostPolicyException(
                    "canvas-host-disconnected",
                    "The managed Canvas host disconnected before returning a result.");
            var response = JsonNode.Parse(line)?.AsObject()
                ?? throw new HostPolicyException("canvas-host-response", "The Canvas host response is invalid.");
            if (response["ok"]?.GetValue<bool>() != true)
            {
                throw new HostPolicyException(
                    "canvas-command-rejected",
                    response["error"]?.GetValue<string>() ?? "The Canvas command was rejected.");
            }
            leaseGuard.RevalidateActive(lease);
            return response["payload"]?.DeepClone();
        }
        finally
        {
            _commandGate.Release();
        }
    }

    private async Task EnsureHostAsync(CancellationToken cancellationToken)
    {
        if (_process is { HasExited: false }) return;
        VerifyCanvasHost();
        _process?.Dispose();
        _process = Process.Start(new ProcessStartInfo
        {
            FileName = _policy.Canvas.HostPath,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardInput = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WorkingDirectory = Path.GetDirectoryName(_policy.Canvas.HostPath)!,
        }) ?? throw new HostPolicyException("canvas-host-start", "The managed Canvas host did not start.");
        _process.EnableRaisingEvents = true;
        _process.ErrorDataReceived += (_, eventArgs) =>
        {
            if (!string.IsNullOrWhiteSpace(eventArgs.Data))
                Console.Error.WriteLine($"[canvas-host] {eventArgs.Data}");
        };
        _process.BeginErrorReadLine();
        await _process.StandardInput.WriteLineAsync(JsonSerializer.Serialize(new
        {
            contract = CanvasPhase1Policy.Contract,
            commandPipeName = _commandPipeName,
            actionPipeName = _actionPipeName,
            ipcToken = _ipcToken,
            activationLeasePath = _leasePath,
            activationLeaseSecret = _leaseSecret,
            gatewayGeneration = _generation,
            policyFingerprint = _policyFingerprint,
            nodeId = _nodeId,
            parentProcessId = Environment.ProcessId,
            parentProcessStartTimeUtcTicks = Process.GetCurrentProcess().StartTime.ToUniversalTime().Ticks,
            uiLocale = _uiLocale,
        }));
        await _process.StandardInput.FlushAsync(cancellationToken);
        _actionServer ??= RunActionServerAsync(_shutdown.Token);
    }

    private void VerifyCanvasHost()
    {
        using var stream = new FileStream(
            _policy.Canvas.HostPath,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read);
        var hash = Convert.ToHexString(SHA256.HashData(stream)).ToLowerInvariant();
        if (!string.Equals(hash, _policy.Canvas.HostSha256, StringComparison.Ordinal))
            throw new HostPolicyException(
                "canvas-host-hash",
                "The managed Canvas host does not match the fingerprinted executable.");
        var treeHash = ComputeDirectoryTreeHash(Path.GetDirectoryName(_policy.Canvas.HostPath)!);
        if (!string.Equals(treeHash, _policy.Canvas.HostTreeSha256, StringComparison.Ordinal))
            throw new HostPolicyException(
                "canvas-host-tree-hash",
                "The managed Canvas host files do not match the fingerprinted resource tree.");
    }

    internal static string ComputeDirectoryTreeHash(string root)
    {
        using var hash = IncrementalHash.CreateHash(HashAlgorithmName.SHA256);
        foreach (var file in EnumerateFiles(root).OrderBy(
            file => Path.GetRelativePath(root, file).Replace('\\', '/'),
            StringComparer.Ordinal))
        {
            var relative = Path.GetRelativePath(root, file).Replace('\\', '/');
            var info = new FileInfo(file);
            hash.AppendData(Encoding.UTF8.GetBytes($"{relative}\0{info.Length}\0"));
            using var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read);
            var buffer = new byte[128 * 1024];
            int read;
            while ((read = stream.Read(buffer, 0, buffer.Length)) > 0)
                hash.AppendData(buffer.AsSpan(0, read));
            hash.AppendData([0]);
        }
        return Convert.ToHexString(hash.GetHashAndReset()).ToLowerInvariant();
    }

    private static IEnumerable<string> EnumerateFiles(string root)
    {
        var pending = new Stack<string>();
        pending.Push(root);
        while (pending.Count > 0)
        {
            var directory = pending.Pop();
            foreach (var entry in new DirectoryInfo(directory).EnumerateFileSystemInfos())
            {
                if ((entry.Attributes & FileAttributes.ReparsePoint) != 0)
                    throw new HostPolicyException(
                        "canvas-host-tree-reparse",
                        "The managed Canvas host resource tree contains a reparse point.");
                if (entry is DirectoryInfo child) pending.Push(child.FullName);
                else if (entry is FileInfo file) yield return file.FullName;
            }
        }
    }

    private async Task RunActionServerAsync(CancellationToken cancellationToken)
    {
        while (!cancellationToken.IsCancellationRequested)
        {
            try
            {
                using var pipe = new NamedPipeServerStream(
                    _actionPipeName,
                    PipeDirection.InOut,
                    1,
                    PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                await pipe.WaitForConnectionAsync(cancellationToken);
                using var reader = new StreamReader(pipe, Encoding.UTF8, false, 64 * 1024, leaveOpen: true);
                using var writer = new StreamWriter(pipe, new UTF8Encoding(false), 64 * 1024, leaveOpen: true)
                {
                    AutoFlush = true,
                };
                var response = await HandleActionAsync(await reader.ReadLineAsync(cancellationToken));
                await writer.WriteLineAsync(JsonSerializer.Serialize(response));
            }
            catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
            {
                return;
            }
            catch (Exception ex)
            {
                Console.Error.WriteLine($"[canvas-action] rejected: {ex.GetType().Name}: {ex.Message}");
            }
        }
    }

    private async Task<object> HandleActionAsync(string? json)
    {
        try
        {
            var request = JsonNode.Parse(json ?? string.Empty)?.AsObject()
                ?? throw new HostPolicyException("canvas-action-invalid", "Canvas action request is empty.");
            ValidateActionIdentity(request);
            var activeLease = _activationLease.ValidateActive();
            var action = request["action"]?["action"]?.AsObject()
                ?? throw new HostPolicyException("canvas-action-invalid", "Canvas action envelope is invalid.");
            var name = action["name"]?.GetValue<string>() ?? string.Empty;
            CanvasPhase1Policy.ValidateAction(name);
            var sessionKey = request["sessionKey"]?.GetValue<string>()?.Trim();
            if (string.IsNullOrEmpty(sessionKey)
                || sessionKey.Length > 256
                || !sessionKey.All(character =>
                    char.IsLetterOrDigit(character) || character is '_' or '-' or ':' or '.'))
            {
                throw new HostPolicyException(
                    "canvas-action-session",
                    "Canvas action session binding is invalid.");
            }
            var actionId = request["key"]?.GetValue<string>();
            if (string.IsNullOrWhiteSpace(actionId) || !Guid.TryParse(actionId, out _))
                throw new HostPolicyException("canvas-action-id", "Canvas action id is invalid.");
            var contextJson = action["context"]?.ToJsonString();
            var message = FormatAgentMessage(
                name,
                sessionKey,
                action["surfaceId"]?.GetValue<string>() ?? string.Empty,
                action["sourceComponentId"]?.GetValue<string>() ?? string.Empty,
                Environment.MachineName,
                _nodeId,
                contextJson);
            activeLease = _activationLease.RevalidateActive(activeLease);
            var sent = await _deliverAction(new JsonObject
            {
                ["message"] = message,
                ["sessionKey"] = sessionKey,
                ["thinking"] = "low",
                ["deliver"] = false,
                ["key"] = actionId,
            });
            _activationLease.RevalidateActive(activeLease);
            if (!sent)
                throw new HostPolicyException("canvas-action-gateway", "Gateway rejected the Canvas action.");
            return new { ok = true };
        }
        catch (HostPolicyException ex)
        {
            return new { ok = false, error = $"{ex.Code}: {ex.Message}" };
        }
    }

    private void ValidateActionIdentity(JsonObject request)
    {
        byte[] actualToken;
        try { actualToken = Convert.FromBase64String(request["token"]?.GetValue<string>() ?? string.Empty); }
        catch (FormatException)
        {
            throw new HostPolicyException("canvas-action-token", "Canvas action token is malformed.");
        }
        if (!CryptographicOperations.FixedTimeEquals(actualToken, Convert.FromBase64String(_ipcToken))
            || request["contract"]?.GetValue<string>() != CanvasPhase1Policy.Contract
            || request["gatewayGeneration"]?.GetValue<string>() != _generation
            || request["policyFingerprint"]?.GetValue<string>() != _policyFingerprint
            || request["nodeId"]?.GetValue<string>() != _nodeId)
        {
            throw new HostPolicyException("canvas-action-identity", "Canvas action identity is stale or invalid.");
        }
    }

    private static string FormatAgentMessage(
        string actionName,
        string sessionKey,
        string surfaceId,
        string sourceComponentId,
        string host,
        string instanceId,
        string? contextJson)
    {
        var parts = new List<string>
        {
            "CANVAS_A2UI",
            $"action={SanitizeTagValue(actionName)}",
            $"session={SanitizeTagValue(sessionKey)}",
            $"surface={SanitizeTagValue(surfaceId)}",
            $"component={SanitizeTagValue(sourceComponentId)}",
            $"host={SanitizeTagValue(host)}",
            $"instance={SanitizeTagValue(instanceId)}",
            "default=update_canvas",
        };
        if (!string.IsNullOrWhiteSpace(contextJson)) parts.Add($"ctx={contextJson}");
        return string.Join(" ", parts);
    }

    private static string SanitizeTagValue(string? value)
    {
        var trimmed = (value ?? string.Empty).Trim();
        if (trimmed.Length == 0) return "-";
        return new string(trimmed
            .Replace(' ', '_')
            .Select(character =>
                char.IsLetterOrDigit(character) || character is '_' or '-' or '.' or ':'
                    ? character
                    : '_')
            .ToArray());
    }

    public void Dispose()
    {
        _shutdown.Cancel();
        try
        {
            if (_process is { HasExited: false }) _process.Kill(entireProcessTree: true);
        }
        catch (InvalidOperationException)
        {
        }
        _process?.Dispose();
        _shutdown.Dispose();
        _commandGate.Dispose();
    }
}
