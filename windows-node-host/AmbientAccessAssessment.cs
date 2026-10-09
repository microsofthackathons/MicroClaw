using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using OpenClaw.Shared.Mxc;

namespace MicroClaw.WindowsNodeHost;

public static class AmbientAccessAssessmentContract
{
    public const string Version = "microclaw.windows-node-mxc-ambient-access.v1";
}

public sealed record AmbientAccessTarget(string Category, string Path);

public sealed record AmbientAccessEntry(string Category, string Status, string Path);

public sealed record AmbientAccessAssessmentResult(
    string Contract,
    string Hash,
    string CheckedAt,
    IReadOnlyList<AmbientAccessEntry> Entries);

public sealed record AmbientAccessAssessmentRequest(
    string WxcExecPath,
    string ScratchRoot,
    IReadOnlyList<AmbientAccessTarget> Targets);

public sealed record AmbientAccessPolicy(
    string Contract,
    string Hash,
    IReadOnlyList<AmbientAccessEntry> Entries);

internal static class AmbientAccessAssessment
{
    private static readonly HashSet<string> RequiredCategories =
        new(StringComparer.Ordinal)
        {
            "desktop",
            "documents",
            "downloads",
            "microclaw-state",
            "openclaw-state",
            "openclaw-roaming-state",
            "ssh",
            "gnupg",
            "aws",
            "azure",
            "kube",
            "gcloud",
            "windows-credentials",
            "powershell-history",
            "browser-chrome",
            "browser-edge",
            "browser-brave",
            "browser-firefox",
        };

    private static readonly HashSet<string> SensitiveCategories =
        new(StringComparer.Ordinal)
        {
            "microclaw-state",
            "openclaw-state",
            "openclaw-roaming-state",
            "ssh",
            "gnupg",
            "aws",
            "azure",
            "kube",
            "gcloud",
            "windows-credentials",
            "powershell-history",
            "browser-chrome",
            "browser-edge",
            "browser-brave",
            "browser-firefox",
        };

    public static async Task<AmbientAccessAssessmentResult> RunAsync(
        AmbientAccessAssessmentRequest request,
        CancellationToken cancellationToken = default)
    {
        if (request.Targets.Count == 0)
            throw new HostPolicyException(
                "ambient-assessment-targets-missing",
                "The Limited containment ambient-access assessment has no targets.");
        var wxcExecPath = WindowsPathCanonicalizer.CanonicalizeFile(request.WxcExecPath);
        var scratchRoot = WindowsPathCanonicalizer.CanonicalizeDirectory(request.ScratchRoot);
        await MxcIsolationTierGuard.EnsureFilesystemIsolationAsync(
            wxcExecPath,
            "limited-dacl",
            "appcontainer-dacl",
            cancellationToken);

        var entries = new List<AmbientAccessEntry>();
        var categories = new HashSet<string>(StringComparer.Ordinal);
        foreach (var target in request.Targets.OrderBy(entry => entry.Category, StringComparer.Ordinal))
        {
            if (!categories.Add(target.Category)
                || string.IsNullOrWhiteSpace(target.Category)
                || target.Category.Any(ch => !char.IsAsciiLetterOrDigit(ch) && ch != '-'))
                throw new HostPolicyException(
                    "ambient-assessment-target-invalid",
                    "The Limited containment ambient-access assessment target is invalid.");
            var targetPath = NormalizeAssessmentPath(target.Path);
            var status = await AssessTargetAsync(
                wxcExecPath,
                scratchRoot,
                targetPath,
                cancellationToken);
            entries.Add(new AmbientAccessEntry(target.Category, status, targetPath));
        }
        if (!categories.SetEquals(RequiredCategories))
            throw new HostPolicyException(
                "ambient-assessment-categories-invalid",
                "The Limited containment ambient-access assessment must cover every required path category.");

        return new AmbientAccessAssessmentResult(
            AmbientAccessAssessmentContract.Version,
            ComputeHash(entries),
            DateTimeOffset.UtcNow.ToString("O"),
            entries);
    }

    public static async Task RevalidateAsync(
        HostPolicy policy,
        CancellationToken cancellationToken = default)
    {
        if (!string.Equals(policy.RequestedStrength, "limited-dacl", StringComparison.Ordinal))
            return;
        var expected = policy.AmbientAccess
            ?? throw new HostPolicyException(
                "ambient-assessment-required",
                "Limited containment requires a current ambient-access assessment.");
        var current = await RunAsync(
            new AmbientAccessAssessmentRequest(
                policy.WxcExecPath,
                policy.AmbientAssessmentScratchRoot,
                expected.Entries.Select(entry =>
                    new AmbientAccessTarget(entry.Category, entry.Path)).ToArray()),
            cancellationToken);
        if (!string.Equals(current.Hash, expected.Hash, StringComparison.Ordinal)
            || !current.Entries.Select(entry => (entry.Category, entry.Status))
                .SequenceEqual(
                    expected.Entries
                        .OrderBy(entry => entry.Category, StringComparer.Ordinal)
                        .Select(entry => (entry.Category, entry.Status))))
            throw new HostPolicyException(
                "ambient-assessment-drift",
                "Limited containment ambient filesystem access changed; a fresh explicit activation is required.");
        EnsureSensitiveCategoriesDenied(current.Entries);
    }

    public static string ComputeHash(IEnumerable<AmbientAccessEntry> entries)
    {
        var fields = new List<string> { AmbientAccessAssessmentContract.Version };
        foreach (var entry in entries.OrderBy(entry => entry.Category, StringComparer.Ordinal))
        {
            fields.Add(EncodeField("category", entry.Category));
            fields.Add(EncodeField("status", entry.Status));
        }
        return Convert.ToHexString(
            SHA256.HashData(Encoding.UTF8.GetBytes(string.Join('\n', fields))))
            .ToLowerInvariant();
    }

    public static void ValidatePolicy(AmbientAccessPolicy policy)
    {
        if (!string.Equals(policy.Contract, AmbientAccessAssessmentContract.Version, StringComparison.Ordinal)
            || !IsSha256(policy.Hash)
            || policy.Entries.Count == 0
            || policy.Entries.Any(entry =>
                entry.Status is not ("denied" or "read" or "read-write")
                || string.IsNullOrWhiteSpace(entry.Category)
                || string.IsNullOrWhiteSpace(entry.Path))
            || policy.Entries.Select(entry => entry.Category).Distinct(StringComparer.Ordinal).Count()
                != policy.Entries.Count
            || !policy.Entries.Select(entry => entry.Category).ToHashSet(StringComparer.Ordinal)
                .SetEquals(RequiredCategories)
            || !string.Equals(ComputeHash(policy.Entries), policy.Hash, StringComparison.Ordinal))
            throw new HostPolicyException(
                "ambient-assessment-invalid",
                "The Limited containment ambient-access assessment is invalid.");
        EnsureSensitiveCategoriesDenied(policy.Entries);
    }

    private static async Task<string> AssessTargetAsync(
        string wxcExecPath,
        string scratchRoot,
        string targetPath,
        CancellationToken cancellationToken)
    {
        var encodedPath = Convert.ToBase64String(Encoding.Unicode.GetBytes(targetPath));
        var sentinelName = $".microclaw-ambient-{Guid.NewGuid():N}.tmp";
        var script =
            "$ErrorActionPreference='Stop';"
            + $"$p=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('{encodedPath}'));"
            + "if (-not [IO.Directory]::Exists($p)) {"
            + "$q=[IO.DirectoryInfo]::new($p).Parent; while ($null -ne $q -and -not $q.Exists) { $q=$q.Parent };"
            + "if ($null -eq $q) { [Console]::Out.Write('denied'); exit 0 };"
            + $"$s=[IO.Path]::Combine($q.FullName,'{sentinelName}.dir');"
            + "try { [IO.Directory]::CreateDirectory($s) | Out-Null; [IO.Directory]::Delete($s); [Console]::Out.Write('read-write') }"
            + "catch { try { if ([IO.Directory]::Exists($s)) { [IO.Directory]::Delete($s) } } catch {}; [Console]::Out.Write('denied') };"
            + "exit 0 };"
            + "try { $e=[IO.Directory]::EnumerateFileSystemEntries($p).GetEnumerator(); try { $null=$e.MoveNext() } finally { if ($e -is [IDisposable]) { $e.Dispose() } } }"
            + "catch { [Console]::Out.Write('read'); exit 0 };"
            + $"$s=[IO.Path]::Combine($p,'{sentinelName}');"
            + "try { $f=[IO.File]::Open($s,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None); $f.Dispose(); [IO.File]::Delete($s); [Console]::Out.Write('read-write') }"
            + "catch { try { if ([IO.File]::Exists($s)) { [IO.File]::Delete($s) } } catch {}; [Console]::Out.Write('read') }";
        var powershell = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.Windows),
            "System32",
            "WindowsPowerShell",
            "v1.0",
            "powershell.exe");
        var scratch = Path.Combine(scratchRoot, $"ambient-{Guid.NewGuid():N}");
        Directory.CreateDirectory(scratch);
        try
        {
            var config = new MxcConfig
            {
                Version = "0.7.0-alpha",
                ContainerId = Guid.NewGuid().ToString("N"),
                Process = new MxcProcess
                {
                    CommandLine = WindowsCommandLine.Join(
                        [powershell, "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script]),
                    Cwd = scratch,
                    TimeoutMs = 30_000,
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
                    ReadonlyPaths = [],
                    ReadwritePaths = [scratch],
                },
                Network = new MxcNetwork
                {
                    DefaultPolicy = "block",
                    EnforcementMode = "capabilities",
                },
                Ui = new MxcUi { Disable = false, Clipboard = "none", Injection = false },
                Lifecycle = new MxcLifecycle { DestroyOnExit = true, PreservePolicy = false },
            };
            var configPath = Path.Combine(scratch, "ambient-config.json");
            await File.WriteAllTextAsync(
                configPath,
                BundledSystemCapability.SerializeMxcConfig(config, allowDaclMutation: true),
                new UTF8Encoding(encoderShouldEmitUTF8Identifier: false),
                cancellationToken);
            var result = await new MxcExecutor(wxcExecPath, 4096, 4096)
                .RunWithConfigFileAsync(configPath, cancellationToken, workingDirectory: scratch);
            var status = result.Output?.Trim();
            if (result.ExitCode != 0
                || result.TimedOut
                || status is not ("denied" or "read" or "read-write"))
                throw new HostPolicyException(
                    "ambient-assessment-failed",
                    "The Limited containment ambient-access assessment did not complete safely.");
            return status;
        }
        finally
        {
            try { Directory.Delete(scratch, recursive: true); } catch { }
        }
    }

    private static void EnsureSensitiveCategoriesDenied(IEnumerable<AmbientAccessEntry> entries)
    {
        var accessible = entries
            .Where(entry =>
                SensitiveCategories.Contains(entry.Category)
                && !string.Equals(entry.Status, "denied", StringComparison.Ordinal))
            .Select(entry => entry.Category)
            .OrderBy(value => value, StringComparer.Ordinal)
            .ToArray();
        if (accessible.Length > 0)
            throw new HostPolicyException(
                "ambient-sensitive-access",
                $"Limited containment can access sensitive path categories: {string.Join(", ", accessible)}.");
    }

    private static string NormalizeAssessmentPath(string value)
    {
        if (string.IsNullOrWhiteSpace(value) || !Path.IsPathFullyQualified(value))
            throw new HostPolicyException(
                "ambient-assessment-target-invalid",
                "The Limited containment ambient-access assessment target is invalid.");
        var normalized = Path.GetFullPath(value);
        if (normalized.Length < 3 || normalized[1] != ':' || normalized[2] != '\\')
            throw new HostPolicyException(
                "ambient-assessment-target-invalid",
                "The Limited containment ambient-access assessment target must be a local drive path.");
        return normalized.TrimEnd('\\');
    }

    private static string EncodeField(string name, string value) =>
        $"{name}={Encoding.UTF8.GetByteCount(value)}:{value}";

    private static bool IsSha256(string? value) =>
        value is { Length: 64 } && value.All(ch => char.IsAsciiHexDigit(ch));
}
