using System.Diagnostics;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using OpenClaw.Shared;
using OpenClaw.Shared.Mxc;

namespace MicroClaw.WindowsNodeHost;

internal sealed class BundledSystemCapability(
    HostPolicy policy,
    string approvalPipeName,
    string approvalsPath) : INodeCapability
{
    private readonly SemaphoreSlim _runGate = new(1, 1);
    private static readonly string[] SupportedCommands =
    [
        "system.run",
        "system.run.prepare",
        "system.which",
        "system.run.cwd-policy",
    ];

    public string Category => "system";
    public IReadOnlyList<string> Commands => SupportedCommands;
    public bool CanHandle(string command) => SupportedCommands.Contains(command, StringComparer.Ordinal);
    public Task<NodeInvokeResponse> ExecuteAsync(NodeInvokeRequest request) =>
        ExecuteAsync(request, CancellationToken.None);

    public async Task<NodeInvokeResponse> ExecuteAsync(
        NodeInvokeRequest request,
        CancellationToken cancellationToken)
    {
        try
        {
            return request.Command switch
            {
                "system.run.cwd-policy" => Success(CwdPolicyAttestation.Current),
                "system.which" => Success(new { bins = ResolveBins(request.Args) }),
                "system.run.prepare" => Success(Prepare(request.Args)),
                "system.run" => await RunAsync(request.Args, cancellationToken),
                _ => Error("Unsupported bundled node command."),
            };
        }
        catch (HostPolicyException ex)
        {
            return Error($"{ex.Code}: {ex.Message}");
        }
        catch (OperationCanceledException)
        {
            return Error("cancelled: The contained invocation was cancelled.");
        }
        catch (Exception ex)
        {
            return Error($"sandbox-failure: {ex.GetType().Name}: {ex.Message}");
        }
    }

    private object Prepare(JsonElement args)
    {
        var request = ParseRun(args);
        var cwd = policy.ResolveCwd(request.Cwd);
        return new
        {
            argv = request.Argv,
            cwd = string.IsNullOrEmpty(cwd.LaunchPath) ? null : cwd.LaunchPath,
            cwdBinding = cwd.ApprovalBinding,
            cwdAccess = cwd.Access.ToString(),
            contract = CwdPolicyContract.Version,
        };
    }

    private async Task<NodeInvokeResponse> RunAsync(JsonElement args, CancellationToken cancellationToken)
    {
        await _runGate.WaitAsync(cancellationToken);
        try
        {
            return await RunExclusiveAsync(args, cancellationToken);
        }
        finally
        {
            _runGate.Release();
        }
    }

    private async Task<NodeInvokeResponse> RunExclusiveAsync(
        JsonElement args,
        CancellationToken cancellationToken)
    {
        var request = ParseRun(args);
        var cwd = policy.ResolveCwd(request.Cwd);
        var executable = ResolveExecutable(request.Argv[0])
            ?? throw new HostPolicyException("executable-not-found", "The requested executable was not found.");
        var exactArgs = request.Argv.Skip(1).ToArray();
        using var executableLease = ExecutableApprovalLease.Acquire(executable);
        executable = executableLease.CanonicalPath;
        var approvedIdentity = executableLease.Capture(exactArgs, cwd.ApprovalBinding);

        var durable = DurableApprovalIdentity.Load(approvalsPath)
            .Any(entry => DurableApprovalIdentity.Matches(entry, approvedIdentity));
        var requireDurableRecheck = durable;
        if (!durable)
        {
            var decision = await ApprovalPipeClient.RequestAsync(
                approvalPipeName,
                new ApprovalRequest(
                    Guid.NewGuid().ToString("N"),
                    executable,
                    exactArgs,
                    request.AgentId,
                    cwd.ApprovalBinding),
                cancellationToken);
            if (decision is ApprovalDecision.Deny)
                return Error("approval-denied: The operator denied this command.");
            if (decision is ApprovalDecision.AllowAlways)
            {
                DurableApprovalFile.Add(approvalsPath, approvedIdentity);
                requireDurableRecheck = true;
            }
        }

        // Re-resolve every security input immediately before process creation.
        var currentCwd = policy.RevalidateCwd(request.Cwd, cwd.ApprovalBinding);
        var currentExecutable = WindowsPathCanonicalizer.CanonicalizeFile(executable);
        var currentIdentity = executableLease.Capture(exactArgs, currentCwd.ApprovalBinding);
        if (!DurableApprovalIdentity.Matches(approvedIdentity, currentIdentity))
            return Error("approval-changed-before-launch: The executable, arguments, or CWD changed after approval.");
        if (requireDurableRecheck && !DurableApprovalIdentity.Load(approvalsPath)
            .Any(entry => DurableApprovalIdentity.Matches(entry, currentIdentity)))
            return Error("approval-changed-before-launch: The durable approval is no longer current.");

        var scratch = Path.Combine(Path.GetTempPath(), "microclaw-mxc-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(scratch);
        try
        {
            using var directoryLease = DirectoryPathLease.Acquire(
                policy.ApprovedRoots.Select(root => root.Path)
                    .Append(currentCwd.LaunchPath)
                    .Append(scratch));
            currentCwd = policy.RevalidateCwd(request.Cwd, cwd.ApprovalBinding);
            var launchCwd = string.IsNullOrEmpty(currentCwd.LaunchPath) ? scratch : currentCwd.LaunchPath;
            var readOnly = policy.ApprovedRoots
                .Where(root => root.Access == FolderAccess.ReadOnly)
                .Select(root => root.Path)
                .ToArray();
            var readWrite = policy.ApprovedRoots
                .Where(root => root.Access == FolderAccess.ReadWrite)
                .Select(root => root.Path)
                .Append(scratch)
                .ToArray();
            var config = new MxcConfig
            {
                Version = "0.7.0-alpha",
                ContainerId = Guid.NewGuid().ToString("N"),
                Process = new MxcProcess
                {
                    CommandLine = WindowsCommandLine.Join([currentExecutable, .. exactArgs]),
                    Cwd = launchCwd,
                    TimeoutMs = request.TimeoutMs,
                },
                ProcessContainer = new MxcProcessContainer
                {
                    LeastPrivilege = false,
                    Capabilities = [],
                    Ui = new MxcBaseProcessUi
                    {
                        Isolation = "desktop",
                        DesktopSystemControl = false,
                        SystemSettings = "none",
                        Ime = false,
                    },
                },
                Filesystem = new MxcFilesystem
                {
                    ReadonlyPaths = readOnly,
                    ReadwritePaths = readWrite,
                },
                Network = new MxcNetwork
                {
                    DefaultPolicy = "block",
                    EnforcementMode = "capabilities",
                },
                Ui = new MxcUi { Disable = false, Clipboard = "none", Injection = false },
                Lifecycle = new MxcLifecycle { DestroyOnExit = true, PreservePolicy = false },
            };
            using var environment = ProcessEnvironmentOverride.Apply(
                new Dictionary<string, string>
                {
                    ["TEMP"] = scratch,
                    ["TMP"] = scratch,
                    ["TMPDIR"] = scratch,
                });
            var result = await new MxcExecutor(
                    policy.WxcExecPath,
                    4 * 1024 * 1024,
                    4 * 1024 * 1024)
                .RunAsync(config, cancellationToken, workingDirectory: launchCwd);
            return Success(new
            {
                stdout = result.Output ?? string.Empty,
                stderr = result.Error ?? string.Empty,
                exitCode = result.ExitCode,
                timedOut = result.TimedOut,
                durationMs = result.DurationMs,
                containment = "mxc",
            });
        }

        finally
        {
            try { Directory.Delete(scratch, recursive: true); } catch { }
        }
    }

    private static RunRequest ParseRun(JsonElement args)
    {
        var hasArgv = args.TryGetProperty("argv", out var argvElement);
        if (!hasArgv) hasArgv = args.TryGetProperty("command", out argvElement);
        if (!hasArgv || argvElement.ValueKind != JsonValueKind.Array)
            throw new HostPolicyException("argv-required", "system.run requires a direct command argv array.");
        var argv = argvElement.EnumerateArray()
            .Select(item => item.ValueKind == JsonValueKind.String ? item.GetString() : null)
            .ToArray();
        if (argv.Length == 0 || argv.Any(string.IsNullOrEmpty))
            throw new HostPolicyException("argv-invalid", "argv must contain non-empty strings.");
        if (args.TryGetProperty("env", out var env) && env.ValueKind == JsonValueKind.Object && env.EnumerateObject().Any())
            throw new HostPolicyException("environment-denied", "Custom command environments are not supported.");

        var cwd = args.TryGetProperty("cwd", out var cwdElement) && cwdElement.ValueKind == JsonValueKind.String
            ? cwdElement.GetString()
            : null;
        var timeout = args.TryGetProperty("timeoutMs", out var timeoutElement) && timeoutElement.TryGetInt32(out var value)
            ? Math.Clamp(value, 1, 600_000)
            : 30_000;
        var agentId = args.TryGetProperty("agentId", out var agentElement) && agentElement.ValueKind == JsonValueKind.String
            ? agentElement.GetString()
            : null;
        return new RunRequest(argv!, cwd, timeout, agentId);
    }

    private static Dictionary<string, string> ResolveBins(JsonElement args)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        if (!args.TryGetProperty("bins", out var bins) || bins.ValueKind != JsonValueKind.Array)
            return result;
        foreach (var item in bins.EnumerateArray())
        {
            var bin = item.GetString();
            if (!string.IsNullOrWhiteSpace(bin) && !bin.Contains('\\') && !bin.Contains('/'))
            {
                var resolved = ResolveExecutable(bin);
                if (resolved is not null) result[bin] = resolved;
            }
        }
        return result;
    }

    private static string? ResolveExecutable(string command)
    {
        if (command.Contains('\\') || command.Contains('/'))
            return File.Exists(command) ? Path.GetFullPath(command) : null;
        foreach (var directory in (Environment.GetEnvironmentVariable("PATH") ?? string.Empty)
            .Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
        {
            foreach (var extension in new[] { "", ".exe", ".cmd", ".bat", ".com" })
            {
                var candidate = Path.Combine(directory, command + extension);
                if (File.Exists(candidate)) return Path.GetFullPath(candidate);
            }
        }
        return null;
    }

    private static NodeInvokeResponse Success(object payload) => new() { Ok = true, Payload = payload };
    private static NodeInvokeResponse Error(string error) => new() { Ok = false, Error = error };
    private sealed record RunRequest(string[] Argv, string? Cwd, int TimeoutMs, string? AgentId);
}

internal sealed class ProcessEnvironmentOverride : IDisposable
{
    private readonly IReadOnlyDictionary<string, string?> _original;

    private ProcessEnvironmentOverride(IReadOnlyDictionary<string, string?> original)
    {
        _original = original;
    }

    public static ProcessEnvironmentOverride Apply(IReadOnlyDictionary<string, string> values)
    {
        var original = values.Keys.ToDictionary(
            key => key,
            Environment.GetEnvironmentVariable,
            StringComparer.OrdinalIgnoreCase);
        foreach (var (key, value) in values)
            Environment.SetEnvironmentVariable(key, value);
        return new ProcessEnvironmentOverride(original);
    }

    public void Dispose()
    {
        foreach (var (key, value) in _original)
            Environment.SetEnvironmentVariable(key, value);
    }
}

internal enum ApprovalDecision { Deny, AllowOnce, AllowAlways }
internal sealed record ApprovalRequest(string Id, string Executable, IReadOnlyList<string> Arguments, string? Agent, string CanonicalCwd);

internal static class ApprovalPipeClient
{
    public static async Task<ApprovalDecision> RequestAsync(
        string pipeName,
        ApprovalRequest request,
        CancellationToken cancellationToken)
    {
        if (string.IsNullOrWhiteSpace(pipeName))
            return ApprovalDecision.Deny;
        using var pipe = new NamedPipeClientStream(".", pipeName, PipeDirection.InOut, PipeOptions.Asynchronous);
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromMinutes(5));
        await pipe.ConnectAsync(timeout.Token);
        using var writer = new StreamWriter(pipe, new UTF8Encoding(false), leaveOpen: true) { AutoFlush = true };
        using var reader = new StreamReader(pipe, Encoding.UTF8, leaveOpen: true);
        await writer.WriteLineAsync(JsonSerializer.Serialize(request).AsMemory(), timeout.Token);
        var responseLine = await reader.ReadLineAsync(timeout.Token);
        var response = JsonSerializer.Deserialize<ApprovalResponse>(responseLine ?? "{}");
        return response?.Decision switch
        {
            "allow-once" => ApprovalDecision.AllowOnce,
            "allow-always" => ApprovalDecision.AllowAlways,
            _ => ApprovalDecision.Deny,
        };
    }

    private sealed class ApprovalResponse
    {
        public string Decision { get; init; } = "deny";
    }
}

internal static class DurableApprovalFile
{
    public static void Add(string path, DurableApproval approval)
    {
        var directory = Path.GetDirectoryName(path)
            ?? throw new HostPolicyException("approval-path-invalid", "Approval file path has no directory.");
        SecureStateDirectory.Ensure(directory);
        var approvals = DurableApprovalIdentity.Load(path).Append(approval).ToArray();
        var temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
        File.WriteAllText(temp, JsonSerializer.Serialize(approvals));
        File.Move(temp, path, overwrite: true);
    }
}

internal static class WindowsCommandLine
{
    public static string Join(IReadOnlyList<string> argv) => string.Join(" ", argv.Select(Quote));

    private static string Quote(string value)
    {
        if (value.Length > 0 && !value.Any(char.IsWhiteSpace) && !value.Contains('"'))
            return value;
        var output = new StringBuilder("\"");
        var slashes = 0;
        foreach (var ch in value)
        {
            if (ch == '\\') { slashes++; continue; }
            if (ch == '"')
            {
                output.Append('\\', slashes * 2 + 1).Append('"');
                slashes = 0;
                continue;
            }
            output.Append('\\', slashes).Append(ch);
            slashes = 0;
        }
        return output.Append('\\', slashes * 2).Append('"').ToString();
    }
}
