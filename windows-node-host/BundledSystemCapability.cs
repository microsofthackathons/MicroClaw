using System.Diagnostics;
using System.IO.Pipes;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;
using OpenClaw.Shared;
using OpenClaw.Shared.Mxc;

namespace MicroClaw.WindowsNodeHost;

internal sealed class BundledSystemCapability(
    HostPolicy policy,
    string approvalPipeName,
    string approvalsPath,
    ActivationLeaseGuard activationLease) : INodeCapability
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
                "system.run.cwd-policy" => Success(
                    CwdPolicyAttestation.Current with
                    {
                        DurableApprovalsPresent = DurableApprovalIdentity.Load(approvalsPath).Count > 0,
                    }),
                "system.which" => Success(new { bins = ResolveBins(request.Args) }),
                "system.run.prepare" => Success(Prepare(request)),
                "system.run" => await RunAsync(request, cancellationToken),
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

    private object Prepare(NodeInvokeRequest request)
    {
        var run = ParseRun(request.Args);
        var cwd = policy.ResolveCwd(run.Cwd);
        var commandText = WindowsCommandLine.Join(run.Argv);
        var commandPreview = BuildApprovalCommandPreview(run, commandText);
        return new
        {
            cmdText = commandText,
            plan = new
            {
                argv = run.Argv,
                cwd = string.IsNullOrEmpty(cwd.LaunchPath) ? null : cwd.LaunchPath,
                commandText,
                commandPreview,
                agentId = run.AgentId,
                sessionKey = run.SessionKey,
            },
            cwdBinding = cwd.ApprovalBinding,
            cwdAccess = cwd.Access.ToString(),
            contract = CwdPolicyContract.Version,
            declaredAccess = run.DeclaredAccess,
        };
    }

    private static string? BuildApprovalCommandPreview(RunRequest run, string commandText)
    {
        if (run.DeclaredAccess.Count == 0)
            return string.Equals(run.CommandPreview, commandText, StringComparison.Ordinal)
                ? null
                : run.CommandPreview;
        if (string.IsNullOrWhiteSpace(run.RawCommand))
            throw new HostPolicyException(
                "declare-access-command-empty",
                "Declared access requires a clean executable command.");
        var declaration = string.Join(
            ';',
            run.DeclaredAccess.Select(entry => $"{entry.Access}:{entry.Path}"));
        return $"# [declare-access]{declaration}[/declare-access]\n{run.RawCommand}";
    }

    private async Task<NodeInvokeResponse> RunAsync(
        NodeInvokeRequest request,
        CancellationToken cancellationToken)
    {
        await _runGate.WaitAsync(cancellationToken);
        try
        {
            return await RunExclusiveAsync(request.Args, cancellationToken);
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
        var validatedActivation = activationLease.Validate(request.Argv);
        var executable = ResolveExecutable(request.Argv[0])
            ?? throw new HostPolicyException("executable-not-found", "The requested executable was not found.");
        var exactArgs = request.Argv.Skip(1).ToArray();
        var declaredApprovalAccess = request.DeclaredAccess
            .Select(entry => new DurableApprovalAccess(entry.Access, entry.Path))
            .ToArray();
        using var executableLease = ExecutableApprovalLease.Acquire(executable);
        executable = executableLease.CanonicalPath;
        var approvedIdentity = executableLease.Capture(
            exactArgs,
            cwd.ApprovalBinding,
            declaredApprovalAccess);

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
                    cwd.ApprovalBinding,
                    request.DeclaredAccess),
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
        var currentIdentity = executableLease.Capture(
            exactArgs,
            currentCwd.ApprovalBinding,
            declaredApprovalAccess);
        if (!DurableApprovalIdentity.Matches(approvedIdentity, currentIdentity))
            return Error("approval-changed-before-launch: The executable, arguments, CWD, or declared access changed after approval.");
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
            activationLease.Revalidate(validatedActivation, request.Argv);
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

    private RunRequest ParseRun(JsonElement args)
    {
        var hasArgv = args.TryGetProperty("argv", out var argvElement);
        if (!hasArgv) hasArgv = args.TryGetProperty("command", out argvElement);
        if (!hasArgv || argvElement.ValueKind != JsonValueKind.Array)
            throw new HostPolicyException("argv-required", "system.run requires a direct command argv array.");
        var parsedArgv = argvElement.EnumerateArray()
            .Select(item => item.ValueKind == JsonValueKind.String ? item.GetString() : null)
            .ToArray();
        if (parsedArgv.Length == 0 || parsedArgv.Any(string.IsNullOrEmpty))
            throw new HostPolicyException("argv-invalid", "argv must contain non-empty strings.");
        var argv = parsedArgv.Select(argument => argument!).ToArray();
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
        var sessionKey = args.TryGetProperty("sessionKey", out var sessionKeyElement)
            && sessionKeyElement.ValueKind == JsonValueKind.String
                ? sessionKeyElement.GetString()
                : null;
        var rawCommand = args.TryGetProperty("rawCommand", out var rawCommandElement)
            && rawCommandElement.ValueKind == JsonValueKind.String
                ? rawCommandElement.GetString()
                : null;
        var commandPreview = GetSystemRunPlanCommandPreview(args) ?? rawCommand;
        var declaredAccess = DeclaredAccessParser.ParseAndValidate(commandPreview, policy);
        var executableArgv = argv;
        var executableRawCommand = rawCommand;
        if (declaredAccess.Count > 0)
        {
            if (string.Equals(commandPreview, rawCommand, StringComparison.Ordinal))
            {
                executableRawCommand = DeclaredAccessParser.StripLeadingDeclarations(rawCommand!);
                var matchingArguments = executableArgv
                    .Select((argument, index) => (argument, index))
                    .Where(item => string.Equals(item.argument, rawCommand, StringComparison.Ordinal))
                    .ToArray();
                if (matchingArguments.Length != 1)
                    throw new HostPolicyException(
                        "declare-access-command-mismatch",
                        "The declared-access command did not match exactly one shell payload.");
                executableArgv = [.. executableArgv];
                executableArgv[matchingArguments[0].index] = executableRawCommand;
            }
            else
            {
                var executablePreview = DeclaredAccessParser.StripLeadingDeclarations(commandPreview!);
                if (executableArgv.Count(argument =>
                    string.Equals(argument, executablePreview, StringComparison.Ordinal)) != 1)
                    throw new HostPolicyException(
                        "declare-access-command-mismatch",
                        "The declared-access command did not match exactly one approved shell payload.");
                ValidatePreparedPlanBinding(args, executableArgv, rawCommand);
            }
        }
        return new RunRequest(
            executableArgv,
            cwd,
            timeout,
            agentId,
            sessionKey,
            executableRawCommand,
            commandPreview,
            declaredAccess);
    }

    private static string? GetSystemRunPlanCommandPreview(JsonElement args)
    {
        if (!args.TryGetProperty("systemRunPlan", out var plan)
            || plan.ValueKind != JsonValueKind.Object
            || !plan.TryGetProperty("commandPreview", out var preview)
            || preview.ValueKind != JsonValueKind.String)
            return null;
        var value = preview.GetString();
        return string.IsNullOrWhiteSpace(value) ? null : value;
    }

    private static void ValidatePreparedPlanBinding(
        JsonElement args,
        IReadOnlyList<string> argv,
        string? rawCommand)
    {
        if (!args.TryGetProperty("systemRunPlan", out var plan)
            || plan.ValueKind != JsonValueKind.Object
            || !plan.TryGetProperty("argv", out var planArgv)
            || planArgv.ValueKind != JsonValueKind.Array
            || !plan.TryGetProperty("commandText", out var planCommandText)
            || planCommandText.ValueKind != JsonValueKind.String)
            throw new HostPolicyException(
                "declare-access-plan-invalid",
                "Declared-access replay requires the approved system.run plan.");
        var approvedArgv = planArgv.EnumerateArray()
            .Select(item => item.ValueKind == JsonValueKind.String ? item.GetString() : null)
            .ToArray();
        if (approvedArgv.Length != argv.Count
            || approvedArgv.Where((argument, index) =>
                !string.Equals(argument, argv[index], StringComparison.Ordinal)).Any()
            || !string.Equals(planCommandText.GetString(), rawCommand, StringComparison.Ordinal))
            throw new HostPolicyException(
                "declare-access-plan-mismatch",
                "Declared-access metadata did not match the approved system.run plan.");
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
    private sealed record RunRequest(
        string[] Argv,
        string? Cwd,
        int TimeoutMs,
        string? AgentId,
        string? SessionKey,
        string? RawCommand,
        string? CommandPreview,
        IReadOnlyList<DeclaredAccess> DeclaredAccess);
}

internal sealed record DeclaredAccess(
    [property: JsonPropertyName("access")] string Access,
    [property: JsonPropertyName("path")] string Path);

internal static partial class DeclaredAccessParser
{
    [GeneratedRegex(
        @"\[declare-access\](.*?)\[/declare-access\]",
        RegexOptions.IgnoreCase | RegexOptions.Singleline | RegexOptions.CultureInvariant)]
    private static partial Regex DeclarationPattern();

    [GeneratedRegex(
        @"\A[ \t]*(?:(?:#|::|REM\b)[ \t]*)?\[declare-access\](.*?)\[/declare-access\][ \t]*(?:\r\n|\n|\r|$)",
        RegexOptions.IgnoreCase | RegexOptions.Singleline | RegexOptions.CultureInvariant)]
    private static partial Regex LeadingDeclarationPattern();

    public static IReadOnlyList<DeclaredAccess> ParseAndValidate(string? rawCommand, HostPolicy policy)
    {
        if (string.IsNullOrEmpty(rawCommand))
            return [];

        var matches = DeclarationPattern().Matches(rawCommand);
        var unmatched = DeclarationPattern().Replace(rawCommand, string.Empty);
        if (unmatched.Contains("[declare-access]", StringComparison.OrdinalIgnoreCase)
            || unmatched.Contains("[/declare-access]", StringComparison.OrdinalIgnoreCase))
            throw new HostPolicyException(
                "declare-access-malformed",
                "The declare-access tag is incomplete or nested.");

        var declarations = new Dictionary<string, DeclaredAccess>(StringComparer.OrdinalIgnoreCase);
        foreach (Match match in matches)
        {
            var payload = match.Groups[1].Value;
            if (string.IsNullOrWhiteSpace(payload))
                throw new HostPolicyException(
                    "declare-access-malformed",
                    "The declare-access tag must contain at least one access:path entry.");

            foreach (var entry in payload.Split(';', StringSplitOptions.TrimEntries))
            {
                var separator = entry.IndexOf(':');
                if (separator <= 0 || separator == entry.Length - 1)
                    throw new HostPolicyException(
                        "declare-access-malformed",
                        "Each declare-access entry must use ro:<absolute-path> or rw:<absolute-path>.");
                var access = entry[..separator].Trim().ToLowerInvariant();
                var requestedPath = entry[(separator + 1)..].Trim();
                if (access is not ("ro" or "rw"))
                    throw new HostPolicyException(
                        "declare-access-malformed",
                        "Declare-access supports only ro and rw access.");
                if (!Path.IsPathFullyQualified(requestedPath)
                    || Path.GetPathRoot(requestedPath)?.Length != 3)
                    throw new HostPolicyException(
                        "declare-access-path-invalid",
                        "Declared access paths must be absolute local drive paths.");

                var canonical = WindowsPathCanonicalizer.CanonicalizeDirectory(requestedPath);
                if (policy.DeniedRoots.Any(root =>
                    WindowsPathCanonicalizer.IsEqualOrNested(canonical, root)))
                    throw new HostPolicyException(
                        "declare-access-sensitive-root",
                        "Declared access overlaps a protected root.");
                var approved = policy.ApprovedRoots
                    .Where(root => WindowsPathCanonicalizer.IsEqualOrNested(canonical, root.Path))
                    .OrderByDescending(root => root.Path.Length)
                    .FirstOrDefault()
                    ?? throw new HostPolicyException(
                        "declare-access-outside-approved-roots",
                        "Declared access is outside the globally approved folder policy.");
                if (access == "rw" && approved.Access != FolderAccess.ReadWrite)
                    throw new HostPolicyException(
                        "declare-access-exceeds-approved-root",
                        "Declared read-write access exceeds the globally approved folder policy.");

                if (!declarations.TryGetValue(canonical, out var existing)
                    || (existing.Access == "ro" && access == "rw"))
                    declarations[canonical] = new DeclaredAccess(access, canonical);
            }
        }
        return declarations.Values
            .OrderBy(declaration => declaration.Path, StringComparer.OrdinalIgnoreCase)
            .ToArray();
    }

    public static string StripLeadingDeclarations(string rawCommand)
    {
        var executable = rawCommand;
        while (true)
        {
            var match = LeadingDeclarationPattern().Match(executable);
            if (!match.Success)
                break;
            executable = executable[match.Length..];
        }
        if (DeclarationPattern().IsMatch(executable))
            throw new HostPolicyException(
                "declare-access-position-invalid",
                "Declare-access metadata must appear on leading metadata lines.");
        if (string.IsNullOrWhiteSpace(executable))
            throw new HostPolicyException(
                "declare-access-command-empty",
                "Declare-access metadata must be followed by a command.");
        return executable;
    }
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
internal sealed record ApprovalRequest(
    [property: JsonPropertyName("id")] string Id,
    [property: JsonPropertyName("executable")] string Executable,
    [property: JsonPropertyName("arguments")] IReadOnlyList<string> Arguments,
    [property: JsonPropertyName("agent")] string? Agent,
    [property: JsonPropertyName("canonicalCwd")] string CanonicalCwd,
    [property: JsonPropertyName("declaredAccess")] IReadOnlyList<DeclaredAccess> DeclaredAccess);

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
        [JsonPropertyName("decision")]
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
