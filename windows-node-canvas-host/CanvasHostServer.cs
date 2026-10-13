using System.Diagnostics;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using Microsoft.UI.Dispatching;
using OpenClaw.Shared;
using OpenClawTray.A2UI.Actions;
using OpenClawTray.A2UI.Protocol;
using OpenClawTray.A2UI.Rendering;
using OpenClawTray.Windows;

namespace MicroClaw.WindowsNodeCanvasHost;

internal static class CanvasPhase1Policy
{
    public const string Contract = "microclaw.windows-node-mxc.canvas.v1";
    public static readonly IReadOnlySet<string> Commands = new HashSet<string>(
        [
            "canvas.present",
            "canvas.hide",
            "canvas.snapshot",
            "canvas.caps",
            "canvas.a2ui.push",
            "canvas.a2ui.pushJSONL",
            "canvas.a2ui.reset",
            "canvas.a2ui.dump",
        ],
        StringComparer.Ordinal);
    public static readonly IReadOnlySet<string> Actions = new HashSet<string>(
        ["click", "submit", "confirm", "cancel"],
        StringComparer.Ordinal);
}

internal sealed record CanvasHostBootstrap(
    string Contract,
    string CommandPipeName,
    string ActionPipeName,
    string IpcToken,
    string ActivationLeasePath,
    string ActivationLeaseSecret,
    string GatewayGeneration,
    string PolicyFingerprint,
    string NodeId,
    int ParentProcessId,
    long ParentProcessStartTimeUtcTicks,
    string UiLocale)
{
    public static CanvasHostBootstrap Parse(string? json)
    {
        var value = JsonSerializer.Deserialize<CanvasHostBootstrap>(
            json ?? string.Empty,
            new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
            ?? throw new InvalidOperationException("Canvas bootstrap is empty.");
        if (!string.Equals(value.Contract, CanvasPhase1Policy.Contract, StringComparison.Ordinal)
            || string.IsNullOrWhiteSpace(value.CommandPipeName)
            || string.IsNullOrWhiteSpace(value.ActionPipeName)
            || Convert.FromBase64String(value.IpcToken).Length != 32
            || !Guid.TryParse(value.GatewayGeneration, out _)
            || !System.Text.RegularExpressions.Regex.IsMatch(value.PolicyFingerprint, "^[a-f0-9]{64}$")
            || !System.Text.RegularExpressions.Regex.IsMatch(value.NodeId, "^[a-f0-9]{64}$")
            || value.ParentProcessId <= 0
            || value.ParentProcessStartTimeUtcTicks <= 0)
        {
            throw new InvalidOperationException("Canvas bootstrap is invalid.");
        }
        return value;
    }
}

internal sealed class CanvasHostServer
{
    private readonly CanvasHostBootstrap _bootstrap;
    private readonly DispatcherQueue _dispatcher;
    private readonly CanvasLeaseGuard _lease;
    private readonly CancellationTokenSource _shutdown = new();
    private readonly Phase1ActionSink _actions;
    private readonly MediaResolver _media;
    private readonly object _surfaceSessionLock = new();
    private readonly Dictionary<string, string> _surfaceSessions = new(StringComparer.Ordinal);
    private A2UICanvasWindow? _window;

    public CanvasHostServer(CanvasHostBootstrap bootstrap, DispatcherQueue dispatcher)
    {
        _bootstrap = bootstrap;
        _dispatcher = dispatcher;
        _lease = new CanvasLeaseGuard(
            bootstrap.ActivationLeasePath,
            bootstrap.ActivationLeaseSecret,
            bootstrap.GatewayGeneration,
            bootstrap.PolicyFingerprint);
        _actions = new Phase1ActionSink(
            ResolveSurfaceSession,
            SendActionAsync,
            _lease,
            new CanvasLogger());
        _media = new MediaResolver(new CanvasLogger());
    }

    public async Task RunAsync()
    {
        var leaseMonitor = MonitorLeaseAsync(_shutdown.Token);
        var parentMonitor = MonitorParentAsync(_shutdown.Token);
        try
        {
            while (!_shutdown.IsCancellationRequested)
            {
                using var pipe = new NamedPipeServerStream(
                    _bootstrap.CommandPipeName,
                    PipeDirection.InOut,
                    1,
                    PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous | PipeOptions.CurrentUserOnly);
                await pipe.WaitForConnectionAsync(_shutdown.Token);
                using var reader = new StreamReader(pipe, Encoding.UTF8, false, 64 * 1024, leaveOpen: true);
                using var writer = new StreamWriter(pipe, new UTF8Encoding(false), 64 * 1024, leaveOpen: true)
                {
                    AutoFlush = true,
                };
                var line = await reader.ReadLineAsync(_shutdown.Token);
                var response = await HandleRequestAsync(line, _shutdown.Token);
                await writer.WriteLineAsync(JsonSerializer.Serialize(response));
            }
        }
        catch (OperationCanceledException) when (_shutdown.IsCancellationRequested)
        {
        }
        finally
        {
            _shutdown.Cancel();
            try { await leaseMonitor; } catch (OperationCanceledException) { }
            try { await parentMonitor; } catch (OperationCanceledException) { }
            await CloseWindowAsync();
            _media.Dispose();
            _actions.Dispose();
        }
    }

    private async Task<object> HandleRequestAsync(string? json, CancellationToken cancellationToken)
    {
        try
        {
            var request = JsonSerializer.Deserialize<CanvasHostRequest>(
                json ?? string.Empty,
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
                ?? throw new CanvasPolicyException("CANVAS_REQUEST_INVALID", "Canvas request is empty.");
            ValidateRequestIdentity(request);
            if (!CanvasPhase1Policy.Commands.Contains(request.Command))
                throw new CanvasPolicyException("CANVAS_COMMAND_DENIED", "Canvas command is outside the Phase 1 allowlist.");
            var lease = _lease.ValidateActive();
            var payload = await ExecuteAsync(request.Command, request.Args, lease, cancellationToken);
            return new { ok = true, payload };
        }
        catch (CanvasPolicyException ex)
        {
            return new { ok = false, error = $"{ex.Code}: {ex.Message}" };
        }
        catch (Exception ex)
        {
            return new { ok = false, error = $"CANVAS_HOST_FAILURE: {ex.GetType().Name}: {ex.Message}" };
        }
    }

    private async Task<object?> ExecuteAsync(
        string command,
        JsonElement args,
        ValidatedCanvasLease lease,
        CancellationToken cancellationToken)
    {
        switch (command)
        {
            case "canvas.present":
                ValidatePresentArgs(args);
                return await OnUiAsync(() =>
                {
                    _lease.RevalidateActive(lease);
                    EnsureWindow();
                    _window!.Activate();
                    _window.BringToFront(false);
                    return (object)new { presented = true, renderer = "native-a2ui" };
                });
            case "canvas.hide":
                await CloseWindowAsync(lease);
                return new { hidden = true };
            case "canvas.a2ui.push":
            case "canvas.a2ui.pushJSONL":
                {
                    var jsonl = CanvasRequestValidation.ReadInlineJsonl(args);
                    CanvasRequestValidation.ValidateJsonl(jsonl);
                    var sessionKey = ReadSessionKey(args);
                    var plannedSurfaceSessions = PrepareSurfaceSessions(jsonl, sessionKey);
                    return await OnUiAsync(() =>
                    {
                        _lease.RevalidateActive(lease);
                        EnsureWindow();
                        _window!.Push(jsonl);
                        ReplaceSurfaceSessions(plannedSurfaceSessions);
                        _lease.RevalidateActive(lease);
                        return (object)new { pushed = true };
                    });
                }
            case "canvas.a2ui.reset":
                return await OnUiAsync(() =>
                {
                    _lease.RevalidateActive(lease);
                    _window?.Reset();
                    ClearSurfaceSessions();
                    return (object)new { reset = true };
                });
            case "canvas.a2ui.dump":
                return await OnUiAsync(() =>
                {
                    _lease.RevalidateActive(lease);
                    return (object)JsonNode.Parse(
                        _window?.GetStateSnapshot()
                            ?? """{"renderer":"none","a2uiVersion":"0.8","surfaceCount":0,"surfaces":{}}""")!;
                });
            case "canvas.snapshot":
                {
                    var format = CanvasRequestValidation.ReadSnapshotFormat(args);
                    var base64 = await OnUiAsync(async () =>
                    {
                        _lease.RevalidateActive(lease);
                        if (_window is null || _window.IsClosed)
                            throw new CanvasPolicyException("CANVAS_NOT_OPEN", "No managed Canvas surface is open.");
                        var result = await _window.CaptureSnapshotAsync(format);
                        _lease.RevalidateActive(lease);
                        return result;
                    });
                    return new { format, base64, surface = "managed-canvas", storedPath = (string?)null };
                }
            case "canvas.caps":
                return new
                {
                    contract = CanvasPhase1Policy.Contract,
                    renderer = _window is not null && !_window.IsClosed ? "native-a2ui" : "none",
                    eval = false,
                    navigate = false,
                    snapshot = true,
                    screen = false,
                    localFiles = false,
                    commands = CanvasPhase1Policy.Commands.Order().ToArray(),
                    actions = CanvasPhase1Policy.Actions.Order().ToArray(),
                    a2ui = new { version = "0.8", push = true, reset = true, introspect = true },
                };
            default:
                throw new CanvasPolicyException("CANVAS_COMMAND_DENIED", "Canvas command is not supported.");
        }
    }

    private void EnsureWindow()
    {
        if (_window is not null && !_window.IsClosed) return;
        _window = new A2UICanvasWindow(_actions, _media, new CanvasLogger());
        _window.Closed += (_, _) => _window = null;
    }

    private async Task MonitorLeaseAsync(CancellationToken cancellationToken)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(250));
        while (await timer.WaitForNextTickAsync(cancellationToken))
        {
            if (_lease.IsActive()) continue;
            await CloseWindowAsync();
        }
    }

    private async Task MonitorParentAsync(CancellationToken cancellationToken)
    {
        Process parent;
        try
        {
            parent = Process.GetProcessById(_bootstrap.ParentProcessId);
            if (parent.StartTime.ToUniversalTime().Ticks != _bootstrap.ParentProcessStartTimeUtcTicks)
            {
                parent.Dispose();
                _shutdown.Cancel();
                return;
            }
        }
        catch (Exception)
        {
            _shutdown.Cancel();
            return;
        }
        using (parent)
        using (var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(250)))
        {
            while (await timer.WaitForNextTickAsync(cancellationToken))
            {
                if (!parent.HasExited) continue;
                _shutdown.Cancel();
                return;
            }
        }
    }

    private Task CloseWindowAsync(ValidatedCanvasLease? expected = null) =>
        OnUiAsync(() =>
        {
            if (expected is not null) _lease.RevalidateActive(expected);
            if (_window is not null && !_window.IsClosed) _window.Close();
            _window = null;
            ClearSurfaceSessions();
            return true;
        });

    private async Task SendActionAsync(A2UIAction action, string sessionKey)
    {
        var lease = _lease.ValidateActive();
        using var pipe = new NamedPipeClientStream(
            ".",
            _bootstrap.ActionPipeName,
            PipeDirection.InOut,
            PipeOptions.Asynchronous,
            System.Security.Principal.TokenImpersonationLevel.Identification);
        await pipe.ConnectAsync(2_000, _shutdown.Token);
        using var reader = new StreamReader(pipe, Encoding.UTF8, false, 16 * 1024, leaveOpen: true);
        using var writer = new StreamWriter(pipe, new UTF8Encoding(false), 16 * 1024, leaveOpen: true)
        {
            AutoFlush = true,
        };
        _lease.RevalidateActive(lease);
        await writer.WriteLineAsync(JsonSerializer.Serialize(new
        {
            contract = CanvasPhase1Policy.Contract,
            token = _bootstrap.IpcToken,
            gatewayGeneration = _bootstrap.GatewayGeneration,
            policyFingerprint = _bootstrap.PolicyFingerprint,
            nodeId = _bootstrap.NodeId,
            sessionKey,
            key = action.Id,
            action = A2UIActionEnvelope.ToEnvelope(action),
        }));
        var response = await reader.ReadLineAsync(_shutdown.Token);
        if (response is null || !JsonDocument.Parse(response).RootElement.GetProperty("ok").GetBoolean())
            throw new CanvasPolicyException("CANVAS_ACTION_REJECTED", "Gateway rejected the Canvas action.");
    }

    private void ValidateRequestIdentity(CanvasHostRequest request)
    {
        var token = Convert.FromBase64String(request.Token ?? string.Empty);
        var expected = Convert.FromBase64String(_bootstrap.IpcToken);
        if (!CryptographicOperations.FixedTimeEquals(token, expected)
            || !string.Equals(request.Contract, CanvasPhase1Policy.Contract, StringComparison.Ordinal)
            || !string.Equals(request.GatewayGeneration, _bootstrap.GatewayGeneration, StringComparison.Ordinal)
            || !string.Equals(request.PolicyFingerprint, _bootstrap.PolicyFingerprint, StringComparison.Ordinal)
            || !string.Equals(request.NodeId, _bootstrap.NodeId, StringComparison.Ordinal))
        {
            throw new CanvasPolicyException("CANVAS_REQUEST_IDENTITY", "Canvas request identity is stale or invalid.");
        }
    }

    private static void ValidatePresentArgs(JsonElement args)
    {
        if (args.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null) return;
        if (args.ValueKind != JsonValueKind.Object)
            throw new CanvasPolicyException("CANVAS_PRESENT_INVALID", "Canvas present parameters must be an object.");
        if (args.EnumerateObject().Any())
            throw new CanvasPolicyException(
                "CANVAS_PRESENT_TRUSTED_ORIGIN_ONLY",
                "Phase 1 Canvas present opens only the managed native A2UI shell.");
    }

    private static string ReadSessionKey(JsonElement args)
    {
        if (args.ValueKind != JsonValueKind.Object
            || !args.TryGetProperty("props", out var props)
            || props.ValueKind != JsonValueKind.Object
            || !props.TryGetProperty("sessionKey", out var session)
            || session.ValueKind != JsonValueKind.String)
        {
            throw new CanvasPolicyException(
                "CANVAS_SESSION_REQUIRED",
                "Canvas updates require the current agent session binding.");
        }
        var value = session.GetString()?.Trim();
        if (!string.IsNullOrEmpty(value)
            && value.Length <= 256
            && value.All(ch => char.IsLetterOrDigit(ch) || ch is '_' or '-' or ':' or '.'))
        {
            return value;
        }
        throw new CanvasPolicyException("CANVAS_SESSION_INVALID", "Canvas session key is invalid.");
    }

    private Dictionary<string, string> PrepareSurfaceSessions(string jsonl, string sessionKey)
    {
        Dictionary<string, string> planned;
        lock (_surfaceSessionLock)
            planned = new Dictionary<string, string>(_surfaceSessions, StringComparer.Ordinal);
        foreach (var line in jsonl.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries))
        {
            var root = JsonNode.Parse(line)?.AsObject()
                ?? throw new CanvasPolicyException("CANVAS_A2UI_INVALID", "A2UI JSONL contains invalid JSON.");
            foreach (var envelope in new[] { "surfaceUpdate", "beginRendering", "dataModelUpdate" })
            {
                if (root[envelope] is not JsonObject body) continue;
                var surfaceId = ReadSurfaceId(body);
                if (planned.TryGetValue(surfaceId, out var owner)
                    && !string.Equals(owner, sessionKey, StringComparison.Ordinal))
                {
                    throw new CanvasPolicyException(
                        "CANVAS_SURFACE_SESSION_MISMATCH",
                        "Canvas surface belongs to a different agent session.");
                }
                planned[surfaceId] = sessionKey;
            }
            if (root["deleteSurface"] is JsonObject deletion)
            {
                var surfaceId = ReadSurfaceId(deletion);
                if (planned.TryGetValue(surfaceId, out var owner)
                    && !string.Equals(owner, sessionKey, StringComparison.Ordinal))
                {
                    throw new CanvasPolicyException(
                        "CANVAS_SURFACE_SESSION_MISMATCH",
                        "Canvas surface belongs to a different agent session.");
                }
                planned.Remove(surfaceId);
            }
        }
        return planned;
    }

    private static string ReadSurfaceId(JsonObject body)
    {
        var surfaceId = body["surfaceId"]?.GetValue<string>()?.Trim();
        if (string.IsNullOrEmpty(surfaceId)
            || surfaceId.Length > 256
            || surfaceId.Any(char.IsControl))
        {
            throw new CanvasPolicyException("CANVAS_SURFACE_ID_INVALID", "Canvas surface id is invalid.");
        }
        return surfaceId;
    }

    private string? ResolveSurfaceSession(string surfaceId)
    {
        lock (_surfaceSessionLock)
            return _surfaceSessions.GetValueOrDefault(surfaceId);
    }

    private void ReplaceSurfaceSessions(Dictionary<string, string> planned)
    {
        lock (_surfaceSessionLock)
        {
            _surfaceSessions.Clear();
            foreach (var entry in planned)
                _surfaceSessions.Add(entry.Key, entry.Value);
        }
    }

    private void ClearSurfaceSessions()
    {
        lock (_surfaceSessionLock)
            _surfaceSessions.Clear();
    }

    private Task<T> OnUiAsync<T>(Func<T> action)
    {
        var tcs = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        if (!_dispatcher.TryEnqueue(() =>
            {
                try { tcs.TrySetResult(action()); }
                catch (Exception ex) { tcs.TrySetException(ex); }
            }))
        {
            tcs.TrySetException(new CanvasPolicyException(
                "CANVAS_DISPATCHER_UNAVAILABLE",
                "Canvas UI dispatcher is unavailable."));
        }
        return tcs.Task;
    }

    private Task<T> OnUiAsync<T>(Func<Task<T>> action)
    {
        var tcs = new TaskCompletionSource<T>(TaskCreationOptions.RunContinuationsAsynchronously);
        if (!_dispatcher.TryEnqueue(async () =>
            {
                try { tcs.TrySetResult(await action()); }
                catch (Exception ex) { tcs.TrySetException(ex); }
            }))
        {
            tcs.TrySetException(new CanvasPolicyException(
                "CANVAS_DISPATCHER_UNAVAILABLE",
                "Canvas UI dispatcher is unavailable."));
        }
        return tcs.Task;
    }
}

internal sealed record CanvasHostRequest(
    string? Contract,
    string? Token,
    string? GatewayGeneration,
    string? PolicyFingerprint,
    string? NodeId,
    string Command,
    JsonElement Args);

internal sealed class Phase1ActionSink(
    Func<string, string?> resolveSessionKey,
    Func<A2UIAction, string, Task> deliver,
    CanvasLeaseGuard lease,
    IOpenClawLogger logger) : IActionSink, IDisposable
{
    private readonly SemaphoreSlim _gate = new(1, 1);

    public void Raise(A2UIAction action)
    {
        if (!CanvasPhase1Policy.Actions.Contains(action.Name))
        {
            logger.Warn($"[A2UI] blocked action outside Phase 1 allowlist: {action.Name}");
            return;
        }
        _ = DeliverAsync(action);
    }

    private async Task DeliverAsync(A2UIAction action)
    {
        await _gate.WaitAsync();
        try
        {
            var active = lease.ValidateActive();
            var sessionKey = resolveSessionKey(action.SurfaceId);
            if (string.IsNullOrWhiteSpace(sessionKey))
                throw new CanvasPolicyException("CANVAS_ACTION_SESSION", "Canvas action session is unavailable.");
            lease.RevalidateActive(active);
            await deliver(action, sessionKey);
        }
        catch (Exception ex)
        {
            logger.Warn($"[A2UI] action rejected: {ex.Message}");
        }
        finally
        {
            _gate.Release();
        }
    }

    public void Dispose() => _gate.Dispose();
}

internal static class CanvasRequestValidation
{
    private const int MaxJsonlBytes = 4 * 1024 * 1024;
    private const int MaxJsonlLines = 4096;

    public static string ReadInlineJsonl(JsonElement args)
    {
        if (args.ValueKind != JsonValueKind.Object)
            throw new CanvasPolicyException("CANVAS_A2UI_INVALID", "A2UI parameters must be an object.");
        if (args.TryGetProperty("jsonlPath", out _))
            throw new CanvasPolicyException(
                "CANVAS_LOCAL_FILE_DENIED",
                "Phase 1 rejects local A2UI files; provide inline JSONL.");
        if (!args.TryGetProperty("jsonl", out var value) || value.ValueKind != JsonValueKind.String)
            throw new CanvasPolicyException("CANVAS_A2UI_INVALID", "Inline jsonl is required.");
        var jsonl = value.GetString() ?? string.Empty;
        if (Encoding.UTF8.GetByteCount(jsonl) > MaxJsonlBytes)
            throw new CanvasPolicyException("CANVAS_A2UI_TOO_LARGE", "A2UI JSONL exceeds the Phase 1 size limit.");
        if (jsonl.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries).Length > MaxJsonlLines)
            throw new CanvasPolicyException("CANVAS_A2UI_TOO_MANY_LINES", "A2UI JSONL exceeds the Phase 1 line limit.");
        return jsonl;
    }

    public static void ValidateJsonl(string jsonl)
    {
        foreach (var line in jsonl.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries))
        {
            JsonNode root;
            try { root = JsonNode.Parse(line) ?? throw new JsonException(); }
            catch (JsonException)
            {
                throw new CanvasPolicyException("CANVAS_A2UI_INVALID", "A2UI JSONL contains invalid JSON.");
            }
            ValidateNode(root);
        }
    }

    public static string ReadSnapshotFormat(JsonElement args)
    {
        if (args.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null) return "png";
        if (args.ValueKind != JsonValueKind.Object)
            throw new CanvasPolicyException("CANVAS_SNAPSHOT_INVALID", "Snapshot parameters must be an object.");
        if (args.EnumerateObject().Any(property => property.Name != "format"))
            throw new CanvasPolicyException("CANVAS_SNAPSHOT_INVALID", "Snapshot accepts only a format.");
        var format = args.TryGetProperty("format", out var value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()?.ToLowerInvariant()
            : "png";
        if (format is not ("png" or "jpeg" or "jpg"))
            throw new CanvasPolicyException("CANVAS_SNAPSHOT_FORMAT", "Canvas snapshot supports png or jpeg only.");
        return format!;
    }

    private static void ValidateNode(JsonNode node)
    {
        switch (node)
        {
            case JsonObject obj:
                foreach (var (name, value) in obj)
                {
                    if (value is null) continue;
                    if (IsMediaProperty(name)) ValidateMediaValue(value);
                    else ValidateNode(value);
                }
                break;
            case JsonArray array:
                foreach (var value in array)
                {
                    if (value is not null) ValidateNode(value);
                }
                break;
        }
    }

    private static bool IsMediaProperty(string name) =>
        name.Equals("url", StringComparison.OrdinalIgnoreCase)
        || name.Equals("src", StringComparison.OrdinalIgnoreCase)
        || name.Equals("uri", StringComparison.OrdinalIgnoreCase);

    private static void ValidateMediaValue(JsonNode node)
    {
        if (node is JsonValue direct && direct.TryGetValue<string>(out var directText))
        {
            ValidateMediaReference(directText);
            return;
        }
        if (node is JsonObject value)
        {
            if (value["path"] is not null)
                throw new CanvasPolicyException(
                    "CANVAS_MEDIA_BINDING_DENIED",
                    "Phase 1 Canvas media must use a bounded inline literal.");
            if (value["literalString"] is JsonValue literal
                && literal.TryGetValue<string>(out var literalText))
            {
                ValidateMediaReference(literalText);
                return;
            }
        }
        throw new CanvasPolicyException(
            "CANVAS_MEDIA_REFERENCE_DENIED",
            "Canvas media reference is not approved.");
    }

    private static void ValidateMediaReference(string value)
    {
        var trimmed = value.Trim();
        if (IsApprovedInlineImage(trimmed)) return;
        if (trimmed.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
            throw new CanvasPolicyException("CANVAS_MEDIA_DATA_DENIED", "Canvas data media type is not allowed.");
        if (Uri.TryCreate(trimmed, UriKind.Absolute, out var uri))
        {
            if (uri.Scheme.Equals(Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase))
            {
                throw new CanvasPolicyException(
                    "CANVAS_MEDIA_HOST_NOT_ALLOWED",
                    "Phase 1 has no remote media host allowlist.");
            }
            throw new CanvasPolicyException("CANVAS_MEDIA_SCHEME_DENIED", "Canvas media scheme is not allowed.");
        }
        if (Path.IsPathFullyQualified(trimmed)
            || trimmed.StartsWith(@"\\", StringComparison.Ordinal)
            || trimmed.StartsWith("./", StringComparison.Ordinal)
            || trimmed.StartsWith("../", StringComparison.Ordinal)
            || trimmed.StartsWith(@".\", StringComparison.Ordinal)
            || trimmed.StartsWith(@"..\", StringComparison.Ordinal))
        {
            throw new CanvasPolicyException("CANVAS_LOCAL_FILE_DENIED", "Local Canvas media references are denied.");
        }
        throw new CanvasPolicyException("CANVAS_MEDIA_REFERENCE_DENIED", "Canvas media reference is not approved.");
    }

    private static bool IsApprovedInlineImage(string value)
    {
        if (!value.StartsWith("data:", StringComparison.OrdinalIgnoreCase)) return false;
        var comma = value.IndexOf(',');
        if (comma < 0) return false;
        var metadata = value[5..comma].Split(';', StringSplitOptions.RemoveEmptyEntries);
        if (metadata.Length < 2 || !metadata.Skip(1).Contains("base64", StringComparer.OrdinalIgnoreCase))
            return false;
        return metadata[0].Equals("image/png", StringComparison.OrdinalIgnoreCase)
            || metadata[0].Equals("image/jpeg", StringComparison.OrdinalIgnoreCase)
            || metadata[0].Equals("image/webp", StringComparison.OrdinalIgnoreCase);
    }
}

internal sealed record ValidatedCanvasLease(string Signature, long ExpiresAtUnixMs);

internal sealed class CanvasLeaseGuard(
    string path,
    string secretBase64,
    string generation,
    string policyFingerprint)
{
    private readonly byte[] _secret = Convert.FromBase64String(secretBase64);

    public ValidatedCanvasLease ValidateActive()
    {
        CanvasLeaseRecord record;
        try
        {
            record = JsonSerializer.Deserialize<CanvasLeaseRecord>(
                File.ReadAllText(path),
                new JsonSerializerOptions { PropertyNameCaseInsensitive = true })
                ?? throw new JsonException();
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException)
        {
            throw new CanvasPolicyException("CANVAS_LEASE_UNAVAILABLE", "Current Canvas activation lease is unavailable.");
        }
        if (!string.Equals(record.Contract, "microclaw.windows-activation.v1", StringComparison.Ordinal)
            || !string.Equals(record.Mode, "active", StringComparison.OrdinalIgnoreCase)
            || !string.Equals(record.GatewayGeneration, generation, StringComparison.Ordinal)
            || !string.Equals(record.PolicyFingerprint, policyFingerprint, StringComparison.Ordinal)
            || record.ExpiresAtUnixMs <= DateTimeOffset.UtcNow.ToUnixTimeMilliseconds())
        {
            throw new CanvasPolicyException("CANVAS_LEASE_INACTIVE", "Canvas is available only while MXC is Active.");
        }
        var expected = HMACSHA256.HashData(
            _secret,
            Encoding.UTF8.GetBytes(string.Join(
                "\n",
                record.Contract,
                "active",
                generation,
                policyFingerprint,
                record.ExpiresAtUnixMs.ToString(System.Globalization.CultureInfo.InvariantCulture))));
        byte[] actual;
        try { actual = Convert.FromHexString(record.Signature); }
        catch (FormatException)
        {
            throw new CanvasPolicyException("CANVAS_LEASE_SIGNATURE", "Canvas activation lease signature is malformed.");
        }
        if (!CryptographicOperations.FixedTimeEquals(actual, expected))
            throw new CanvasPolicyException("CANVAS_LEASE_SIGNATURE", "Canvas activation lease signature is invalid.");
        return new ValidatedCanvasLease(record.Signature, record.ExpiresAtUnixMs);
    }

    public void RevalidateActive(ValidatedCanvasLease expected)
    {
        if (ValidateActive() != expected)
            throw new CanvasPolicyException("CANVAS_LEASE_CHANGED", "Canvas activation changed before execution.");
    }

    public bool IsActive()
    {
        try { ValidateActive(); return true; }
        catch (CanvasPolicyException) { return false; }
    }
}

internal sealed record CanvasLeaseRecord(
    string Contract,
    string Mode,
    string GatewayGeneration,
    string PolicyFingerprint,
    long ExpiresAtUnixMs,
    string Signature);

internal sealed class CanvasPolicyException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

internal sealed class CanvasLogger : IOpenClawLogger
{
    public void Info(string message) => Console.Error.WriteLine($"[canvas-host][info] {message}");
    public void Debug(string message) { }
    public void Warn(string message) => Console.Error.WriteLine($"[canvas-host][warn] {message}");
    public void Error(string message, Exception? ex = null) =>
        Console.Error.WriteLine($"[canvas-host][error] {message}{(ex is null ? string.Empty : $": {ex.GetType().Name}")}");
}
