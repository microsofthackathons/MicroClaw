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
    [property: JsonPropertyName("cwd")] string? Cwd,
    [property: JsonPropertyName("commandText")] string CommandText,
    [property: JsonPropertyName("commandPreview")] string? CommandPreview,
    [property: JsonPropertyName("agentId")] string? AgentId,
    [property: JsonPropertyName("sessionKey")] string? SessionKey,
    [property: JsonPropertyName("executablePath")] string ExecutablePath,
    [property: JsonPropertyName("executableSha256")] string ExecutableSha256,
    [property: JsonPropertyName("cwdBinding")] string CwdBinding,
    [property: JsonPropertyName("declaredAccess")] IReadOnlyList<DeclaredAccess> DeclaredAccess,
    [property: JsonPropertyName("providerInitialization")]
    [property: JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    PowerShellFilesystemInitialization? ProviderInitialization);

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

    internal static bool IsLimited(HostPolicy policy) =>
        policy.RequestedStrength == "limited-dacl" && policy.EffectiveTier == "appcontainer-dacl";

    internal static string Preview(IReadOnlyList<DeclaredAccess> access, string payload) =>
        $"# [declare-access]{string.Join(';', access.OrderBy(entry => entry.Path, StringComparer.Ordinal).Select(entry => $"{entry.Access}:{entry.Path}"))}[/declare-access]\n{payload}";

    internal static BundledSystemCapability.RunRequest Prepare(
        BundledSystemCapability.RunRequest run, HostPolicy policy)
    {
        if (run.ProviderInitialization is not null) return run;
        var initialization = IsLimited(policy)
            ? Create(run.Argv, run.DeclaredAccess) : null;
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
        if (access.Count == 0 || argv.Count is < 4 or > 8 ||
            !IsPowerShell(argv[0]) || argv.Any(value => value.Length > 4096) ||
            !ShellFlags(argv.Skip(1).Take(argv.Count - 2).ToArray())) return null;
        var payload = argv[^1];
        var tokens = Tokens(payload);
        if (tokens is null) return null;
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
        var target = Target(operation);
        if (target is null || !access.Any(entry => entry.Access == "rw" && Within(entry.Path, target)))
            return null;
        var initialized = nested is null
            ? Initializer + payload
            : payload[..(nested.Start + 1)] + Initializer + payload[(nested.Start + 1)..];
        var final = argv.ToArray();
        final[^1] = initialized;
        return new(
            Contract, form, Array.AsReadOnly(argv.ToArray()), Preview(access, payload),
            Array.AsReadOnly(final));
    }

    internal static (PowerShellFilesystemInitialization Initialization, IReadOnlyList<DeclaredAccess> Access)
        Validate(JsonElement value, IReadOnlyList<string> argv, string? preview, HostPolicy policy)
    {
        if (!IsLimited(policy)) throw Invalid();
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
        var payload = initialization.OriginalArgv[^1];
        var operation = initialization.Form == "nested" ? Tokens(payload)?[^1].Value : payload;
        var target = operation is not null ? Target(operation) : null;
        if (target is null) throw Invalid();
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
        if (supplied.Contract != Contract || supplied.Form is not ("direct" or "nested") ||
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
        "The Limited PowerShell filesystem initialization does not match its exact prepared literal command.");

    private static bool IsPowerShell(string value) =>
        Path.GetFileName(value).Equals("powershell.exe", StringComparison.OrdinalIgnoreCase) ||
        value.Equals("powershell", StringComparison.OrdinalIgnoreCase);

    private static bool ShellFlags(IReadOnlyList<string> flags)
    {
        if (flags.Count < 2 || !flags[^1].Equals("-command", StringComparison.OrdinalIgnoreCase))
            return false;
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var flag in flags.Take(flags.Count - 1))
            if (!(flag.Equals("-noprofile", StringComparison.OrdinalIgnoreCase) ||
                flag.Equals("-nologo", StringComparison.OrdinalIgnoreCase) ||
                flag.Equals("-noninteractive", StringComparison.OrdinalIgnoreCase)) || !seen.Add(flag))
                return false;
        return seen.Contains("-noprofile");
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

    private static string? Target(string script)
    {
        var tokens = Tokens(script);
        if (tokens is null || tokens.Count < 3 || tokens[0].Quote is not null) return null;
        var create = tokens[0].Value.Equals("new-item", StringComparison.OrdinalIgnoreCase);
        if (!create && !tokens[0].Value.Equals("remove-item", StringComparison.OrdinalIgnoreCase)) return null;
        var values = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var flags = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        for (var index = 1; index < tokens.Count; index++)
        {
            var token = tokens[index];
            if (token.Quote is not null || values.ContainsKey(token.Value) || flags.Contains(token.Value)) return null;
            if (token.Value.Equals("-force", StringComparison.OrdinalIgnoreCase) ||
                (!create && token.Value.Equals("-recurse", StringComparison.OrdinalIgnoreCase)))
                flags.Add(token.Value);
            else if (token.Value.Equals("-path", StringComparison.OrdinalIgnoreCase) ||
                (!create && token.Value.Equals("-literalpath", StringComparison.OrdinalIgnoreCase)) ||
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
        var path = values.GetValueOrDefault("-path") ?? values.GetValueOrDefault("-literalpath");
        return path is not null && LiteralPath(path) ? path : null;
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
