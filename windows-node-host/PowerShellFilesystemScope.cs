using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace MicroClaw.WindowsNodeHost;

internal sealed record PowerShellFilesystemInitialization(
    [property: JsonPropertyName("contract")] string Contract,
    [property: JsonPropertyName("form")] string Form,
    [property: JsonPropertyName("originalArgv")] IReadOnlyList<string> OriginalArgv,
    [property: JsonPropertyName("originalCommandPreview")] string OriginalCommandPreview,
    [property: JsonPropertyName("finalArgv")] IReadOnlyList<string> FinalArgv);

internal sealed record PreparedSystemRunPlan(
    [property: JsonPropertyName("argv")] IReadOnlyList<string> Argv,
    [property: JsonPropertyName("cwd")]
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    string? Cwd,
    [property: JsonPropertyName("commandText")] string CommandText,
    [property: JsonPropertyName("commandPreview")]
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    string? CommandPreview,
    [property: JsonPropertyName("agentId")]
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    string? AgentId,
    [property: JsonPropertyName("sessionKey")]
    [property: JsonIgnore(Condition = JsonIgnoreCondition.Never)]
    string? SessionKey,
    [property: JsonPropertyName("executablePath")] string ExecutablePath,
    [property: JsonPropertyName("executableSha256")] string ExecutableSha256,
    [property: JsonPropertyName("cwdBinding")] string CwdBinding,
    [property: JsonPropertyName("declaredAccess")] IReadOnlyList<DeclaredAccess> DeclaredAccess,
    [property: JsonPropertyName("providerInitialization")]
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    PowerShellFilesystemInitialization? ProviderInitialization,
    [property: JsonPropertyName("policyFingerprint")]
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    string? PolicyFingerprint = null,
    [property: JsonPropertyName("commandConsent")]
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    CommandConsentPreview? CommandConsent = null);

internal static class PowerShellFilesystemScope
{
    internal const string Contract = "microclaw.powershell-filesystem-scope.v1";
    internal const string Marker = "[void]'microclaw.powershell-filesystem-scope.";
    internal const string Initializer =
        "[void]'microclaw.powershell-filesystem-scope.v1';" +
        "try{New-PSDrive -Name MicroClawCwd -PSProvider FileSystem -Root ([Environment]::CurrentDirectory) -Scope Script -ErrorAction Stop|Out-Null;" +
        "Set-Location -LiteralPath 'MicroClawCwd:\\' -ErrorAction Stop}" +
        "catch{[Console]::Error.WriteLine('MicroClaw PowerShell filesystem initialization failed; command not executed.');exit 125};";

    private sealed record Token(string Value, char? Quote, int Start, int End);
    private sealed record ScopedCommand(string Form, string Operation, string InitializedPayload);

    internal static bool IsLimited(HostPolicy policy) =>
        policy.RequestedStrength == "limited-dacl" && policy.EffectiveTier == "appcontainer-dacl";

    private static bool SupportsInitialization(HostPolicy policy) =>
        IsLimited(policy) || (policy.RequestedStrength == "full" &&
            policy.EffectiveTier is "base-container" or "appcontainer-bfs");

    internal static string Preview(IReadOnlyList<DeclaredAccess> access, string payload) =>
        $"# [declare-access]{string.Join(';', access.OrderBy(entry => entry.Path, StringComparer.Ordinal).Select(entry => $"{entry.Access}:{entry.Path}"))}[/declare-access]\n{payload}";

    internal static BundledSystemCapability.RunRequest Prepare(
        BundledSystemCapability.RunRequest run, HostPolicy policy, string? resolvedCarrier = null)
    {
        if (run.ProviderInitialization is not null) return run;
        var argv = run.Argv;
        if (argv.Length > 0 && resolvedCarrier is not null &&
            ((argv[0].Equals("cmd.exe", StringComparison.OrdinalIgnoreCase) &&
              MxcCmdSerializer.IsSystemCmd(resolvedCarrier)) ||
             (IsPowerShell(argv[0]) && IsPowerShell(resolvedCarrier))))
            argv = [resolvedCarrier, .. argv.Skip(1)];
        var initialization = SupportsInitialization(policy)
            ? Create(argv, run.DeclaredAccess) : null;
        if (initialization is null) return run;
        ValidateTarget(initialization, run.DeclaredAccess);
        return run with
        {
            Argv = initialization.FinalArgv.ToArray(),
            RawCommand = initialization.FinalArgv[^1],
            CommandPreview = Preview(run.DeclaredAccess, initialization.FinalArgv[^1]),
            ProviderInitialization = initialization,
        };
    }

    internal static PowerShellFilesystemInitialization? Create(
        IReadOnlyList<string> argv, IReadOnlyList<DeclaredAccess> access)
    {
        if (access.Count == 0) return null;
        var command = ParseCommand(argv);
        var targets = command is not null ? Targets(command.Operation) : null;
        if (command is null || targets is null ||
            targets.Any(target => !access.Any(entry => entry.Access == "rw" && Within(entry.Path, target))))
            return null;
        var final = argv.ToArray();
        final[^1] = command.InitializedPayload;
        if (final[^1].Length > 4096) return null;
        return new(
            Contract, command.Form, Array.AsReadOnly(argv.ToArray()), Preview(access, argv[^1]),
            Array.AsReadOnly(final));
    }

    private static ScopedCommand? ParseCommand(IReadOnlyList<string> argv)
    {
        if (argv.Count is < 4 or > 8 || argv.Any(value => value.Length > 4096)) return null;
        var payload = argv[^1];
        var tokens = Tokens(payload);
        if (tokens is null) return null;
        if (argv.Count == 5 && MxcCmdSerializer.IsSystemCmd(argv[0]) &&
            argv[1].Equals("/d", StringComparison.OrdinalIgnoreCase) &&
            argv[2].Equals("/s", StringComparison.OrdinalIgnoreCase) &&
            argv[3].Equals("/c", StringComparison.OrdinalIgnoreCase))
        {
            if (tokens.Count < 3 || tokens[0].Quote == '\'' ||
                !IsCommandPowerShell(tokens[0].Value) || payload.IndexOfAny(['%', '!', '^']) >= 0)
                return null;
            var commandIndex = tokens.FindIndex(1,
                token => token.Value.Equals("-command", StringComparison.OrdinalIgnoreCase));
            if (commandIndex < 1 || commandIndex + 1 >= tokens.Count ||
                tokens.Skip(1).Take(commandIndex).Any(token => token.Quote is not null) ||
                !ShellFlags(tokens.Skip(1).Take(commandIndex).Select(token => token.Value).ToArray(),
                    requireNoProfile: false))
                return null;
            var script = tokens[commandIndex + 1];
            string cmdOperation;
            string cmdInitialized;
            if (script.Quote == '"' && commandIndex + 2 == tokens.Count)
            {
                cmdOperation = script.Value;
                cmdInitialized = payload[..(script.Start + 1)] + Initializer + payload[(script.Start + 1)..];
            }
            else if (script.Quote is null && !payload[script.Start..].Contains('"'))
            {
                cmdOperation = payload[script.Start..];
                cmdInitialized = payload[..script.Start] + "\"" + Initializer + cmdOperation + "\"";
            }
            else return null;
            if (Tokens(cmdOperation) is not { Count: > 0 } operationTokens ||
                !(operationTokens[0].Value.Equals("remove-item", StringComparison.OrdinalIgnoreCase) ||
                  operationTokens[0].Value.Equals("move-item", StringComparison.OrdinalIgnoreCase) ||
                  operationTokens[0].Value.Equals("rename-item", StringComparison.OrdinalIgnoreCase)))
                return null;
            return new("cmd", cmdOperation, cmdInitialized);
        }
        if (!IsPowerShell(argv[0]) ||
            !ShellFlags(argv.Skip(1).Take(argv.Count - 2).ToArray())) return null;
        var form = "direct";
        var operation = payload;
        Token? nested = null;
        if (tokens.Count >= 4 &&
            (tokens[0].Value.Equals("powershell", StringComparison.OrdinalIgnoreCase) ||
                tokens[0].Value.Equals("powershell.exe", StringComparison.OrdinalIgnoreCase)) &&
            tokens[0].Quote is null &&
            ShellFlags(tokens.Skip(1).Take(tokens.Count - 2).Select(token => token.Value).ToArray()) &&
            tokens.Skip(1).Take(tokens.Count - 2).All(token => token.Quote is null) &&
            tokens[^1].Quote == '"')
        {
            form = "nested";
            nested = tokens[^1];
            operation = nested.Value;
        }
        var initialized = nested is null
            ? Initializer + payload
            : payload[..(nested.Start + 1)] + Initializer + payload[(nested.Start + 1)..];
        return new(form, operation, initialized);
    }

    internal static (PowerShellFilesystemInitialization Initialization, IReadOnlyList<DeclaredAccess> Access)
        Validate(JsonElement value, IReadOnlyList<string> argv, string? preview, HostPolicy policy)
    {
        if (!SupportsInitialization(policy)) throw Invalid();
        var supplied = Read(value);
        var access = DeclaredAccessParser.ParseAndValidate(supplied.OriginalCommandPreview, policy);
        var expected = Create(supplied.OriginalArgv, access);
        if (expected is null || supplied.Form != expected.Form ||
            supplied.OriginalCommandPreview != expected.OriginalCommandPreview ||
            !supplied.FinalArgv.SequenceEqual(expected.FinalArgv, StringComparer.Ordinal) ||
            !argv.SequenceEqual(expected.FinalArgv, StringComparer.Ordinal) ||
            preview != Preview(access, expected.FinalArgv[^1]))
            throw Invalid();
        ValidateTarget(expected, access);
        return (expected, access);
    }

    internal static void ValidateTarget(
        PowerShellFilesystemInitialization? initialization, IReadOnlyList<DeclaredAccess> access)
    {
        if (initialization is null) return;
        var command = ParseCommand(initialization.OriginalArgv);
        var targets = command is not null ? Targets(command.Operation) : null;
        if (targets is null) throw Invalid();
        foreach (var target in targets) ValidatePath(target, access);
        if (targets.Length == 2 && Tokens(command!.Operation)![0].Value.Equals("move-item", StringComparison.OrdinalIgnoreCase) &&
            Directory.Exists(targets[1]))
            ValidatePath(Path.Combine(targets[1], Path.GetFileName(targets[0])), access);
    }

    private static void ValidatePath(string target, IReadOnlyList<DeclaredAccess> access)
    {
        var root = access.Where(entry => entry.Access == "rw" && Within(entry.Path, target))
            .OrderByDescending(entry => entry.Path.Length).FirstOrDefault()?.Path;
        if (root is null) throw Invalid();
        var current = root;
        var paths = new List<string> { root };
        var relative = Path.GetRelativePath(root, target);
        if (relative != ".")
            foreach (var segment in relative.Split('\\'))
                paths.Add(current = Path.Combine(current, segment));
        foreach (var path in paths)
        {
            FileAttributes attributes;
            try { attributes = File.GetAttributes(path); }
            catch (FileNotFoundException) { return; }
            catch (DirectoryNotFoundException) { return; }
            catch (Exception error) when (error is UnauthorizedAccessException or IOException)
            {
                throw new HostPolicyException("powershell-initialization-target-unavailable",
                    "The exact literal filesystem target could not be checked before initialization.");
            }
            if ((attributes & FileAttributes.ReparsePoint) != 0)
                throw new HostPolicyException("powershell-initialization-target-reparse",
                    "The literal filesystem target traverses a reparse point; no initialized command was launched.");
        }
    }

    internal static PowerShellFilesystemInitialization Read(JsonElement value)
    {
        if (value.ValueKind != JsonValueKind.Object ||
            value.EnumerateObject().Count() != 5 ||
            value.EnumerateObject().Select(property => property.Name).Distinct(StringComparer.Ordinal).Count() != 5)
            throw Invalid();
        PowerShellFilesystemInitialization supplied;
        try
        {
            supplied = value.Deserialize<PowerShellFilesystemInitialization>(new JsonSerializerOptions
            {
                UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow,
            }) ?? throw Invalid();
        }
        catch (JsonException) { throw Invalid(); }
        if (supplied.Contract != Contract || supplied.Form is not ("direct" or "nested" or "cmd") ||
            supplied.OriginalArgv is null ||
            supplied.FinalArgv is null || supplied.OriginalCommandPreview is null ||
            supplied.OriginalCommandPreview.Length is 0 or > 8192 ||
            supplied.OriginalArgv.Count is < 4 or > 8 || supplied.FinalArgv.Count is < 4 or > 8 ||
            supplied.OriginalArgv.Concat(supplied.FinalArgv).Any(argument => string.IsNullOrEmpty(argument) || argument.Length > 4096))
            throw Invalid();
        return supplied with
        {
            OriginalArgv = Array.AsReadOnly(supplied.OriginalArgv.ToArray()),
            FinalArgv = Array.AsReadOnly(supplied.FinalArgv.ToArray()),
        };
    }

    internal static bool ContainsMarker(IEnumerable<string> argv) =>
        argv.Any(argument => argument.Contains(Marker, StringComparison.Ordinal));

    private static HostPolicyException Invalid() => new(
        "powershell-initialization-invalid",
        "The contained PowerShell filesystem initialization does not match its exact prepared literal command.");

    internal static bool IsPowerShell(string value) =>
        Path.GetFileName(value).Equals("powershell.exe", StringComparison.OrdinalIgnoreCase) ||
        value.Equals("powershell", StringComparison.OrdinalIgnoreCase);

    private static bool IsCommandPowerShell(string value) =>
        value.Equals("powershell", StringComparison.OrdinalIgnoreCase) ||
        value.Equals("powershell.exe", StringComparison.OrdinalIgnoreCase) ||
        new[]
        {
            Environment.GetFolderPath(Environment.SpecialFolder.System),
            Environment.GetFolderPath(Environment.SpecialFolder.SystemX86),
        }.Where(directory => !string.IsNullOrEmpty(directory))
         .Any(directory => value.Equals(
             Path.Combine(directory, "WindowsPowerShell", "v1.0", "powershell.exe"),
             StringComparison.OrdinalIgnoreCase));

    private static bool ShellFlags(IReadOnlyList<string> flags, bool requireNoProfile = true)
    {
        if (flags.Count < 1 || !flags[^1].Equals("-command", StringComparison.OrdinalIgnoreCase))
            return false;
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var flag in flags.Take(flags.Count - 1))
            if (!(flag.Equals("-noprofile", StringComparison.OrdinalIgnoreCase) ||
                flag.Equals("-nologo", StringComparison.OrdinalIgnoreCase) ||
                flag.Equals("-noninteractive", StringComparison.OrdinalIgnoreCase)) || !seen.Add(flag))
                return false;
        return !requireNoProfile || seen.Contains("-noprofile");
    }

    private static List<Token>? Tokens(string text)
    {
        if (text.Length is 0 or > 2048 ||
            text.Any(value => "$`;\r\n|&<>#(){}[]".Contains(value) || (char.IsControl(value) && value != '\t')))
            return null;
        var tokens = new List<Token>();
        for (var index = 0; index < text.Length;)
        {
            while (index < text.Length && text[index] is ' ' or '\t') index++;
            if (index == text.Length) break;
            var start = index;
            char? quote = text[index] is '\'' or '"' ? text[index++] : null;
            var content = index;
            while (index < text.Length && (quote is null
                ? text[index] is not (' ' or '\t') : text[index] != quote))
            {
                if (quote is null && text[index] is '\'' or '"') return null;
                index++;
            }
            var end = index;
            if (quote is not null && (index == text.Length ||
                (++index < text.Length && text[index] is not (' ' or '\t')))) return null;
            tokens.Add(new(text[content..end], quote, start, index));
            if (tokens.Count > 16) return null;
        }
        return tokens;
    }

    private static string[]? Targets(string script)
    {
        var tokens = Tokens(script);
        if (tokens is null || tokens.Count < 3 || tokens[0].Quote is not null) return null;
        var create = tokens[0].Value.Equals("new-item", StringComparison.OrdinalIgnoreCase);
        var move = tokens[0].Value.Equals("move-item", StringComparison.OrdinalIgnoreCase);
        var rename = tokens[0].Value.Equals("rename-item", StringComparison.OrdinalIgnoreCase);
        if (!create && !move && !rename && !tokens[0].Value.Equals("remove-item", StringComparison.OrdinalIgnoreCase)) return null;
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var flags = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (var index = 1; index < tokens.Count; index++)
        {
            var token = tokens[index];
            if (token.Quote is not null || values.ContainsKey(token.Value) || flags.Contains(token.Value)) return null;
            if (token.Value.Equals("-force", StringComparison.OrdinalIgnoreCase) ||
                (!create && !move && !rename && token.Value.Equals("-recurse", StringComparison.OrdinalIgnoreCase)))
                flags.Add(token.Value);
            else if (token.Value.Equals("-path", StringComparison.OrdinalIgnoreCase) ||
                (!create && token.Value.Equals("-literalpath", StringComparison.OrdinalIgnoreCase)) ||
                (move && token.Value.Equals("-destination", StringComparison.OrdinalIgnoreCase)) ||
                (rename && token.Value.Equals("-newname", StringComparison.OrdinalIgnoreCase)) ||
                token.Value.Equals("-erroraction", StringComparison.OrdinalIgnoreCase) ||
                (create && token.Value.Equals("-itemtype", StringComparison.OrdinalIgnoreCase)))
            {
                if (++index == tokens.Count || (tokens[index].Quote is null && tokens[index].Value.StartsWith('-')))
                    return null;
                values.Add(token.Value, tokens[index].Value);
            }
            else return null;
        }
        if (create && (!values.TryGetValue("-itemtype", out var type) ||
            !type.Equals("directory", StringComparison.OrdinalIgnoreCase))) return null;
        if (values.ContainsKey("-path") && values.ContainsKey("-literalpath")) return null;
        if (values.TryGetValue("-erroraction", out var errorAction) &&
            !errorAction.Equals("stop", StringComparison.OrdinalIgnoreCase)) return null;
        var path = values.GetValueOrDefault("-path") ?? values.GetValueOrDefault("-literalpath");
        if (path is null || !LiteralPath(path)) return null;
        if (rename)
        {
            var name = values.GetValueOrDefault("-newname");
            if (string.IsNullOrEmpty(name) || name.IndexOfAny(['\\', '/', ':']) >= 0) return null;
            var renamed = Path.Combine(Path.GetDirectoryName(path)!, name);
            return LiteralPath(renamed) ? [path, renamed] : null;
        }
        if (!move) return [path];
        var destination = values.GetValueOrDefault("-destination");
        return destination is not null && LiteralPath(destination) ? [path, destination] : null;
    }

    private static bool LiteralPath(string path) =>
        Regex.IsMatch(path, @"\A[A-Za-z]:\\") &&
        path[3..].Split('\\').All(segment => segment.Length is > 0 and <= 80 &&
            Regex.IsMatch(segment, @"\A[A-Za-z0-9_ .-]+\z") &&
            segment is not ("." or "..") && !segment.EndsWith('.') && !segment.EndsWith(' ') &&
            !Regex.IsMatch(segment, @"\A(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|\z)", RegexOptions.IgnoreCase));

    private static bool Within(string root, string target)
    {
        if (!LiteralPath(root)) return false;
        var relative = Path.GetRelativePath(root, target);
        return relative == "." || (!relative.StartsWith("..", StringComparison.Ordinal) && !Path.IsPathRooted(relative));
    }
}
