using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace MicroClaw.WindowsNodeHost;

public sealed record DurableApproval(
    int SchemaVersion,
    string ExecutablePath,
    IReadOnlyList<string> Arguments,
    string CwdBinding,
    IReadOnlyList<DurableApprovalAccess> DeclaredAccess,
    string ExecutableSha256);

public sealed record DurableApprovalAccess(string Access, string Path);

public static class DurableApprovalIdentity
{
    public const int SchemaVersion = 3;

    public static DurableApproval Create(
        string executablePath,
        IReadOnlyList<string> arguments,
        string cwdBinding,
        IReadOnlyList<DurableApprovalAccess>? declaredAccess = null) =>
        Create(executablePath, arguments, cwdBinding, declaredAccess ?? [], executableContent: null);

    internal static DurableApproval Create(
        string executablePath,
        IReadOnlyList<string> arguments,
        string cwdBinding,
        IReadOnlyList<DurableApprovalAccess> declaredAccess,
        Stream? executableContent)
    {
        var canonicalExecutable = WindowsPathCanonicalizer.CanonicalizeFile(executablePath);
        string executableSha256;
        if (executableContent is null)
        {
            executableSha256 = Convert.ToHexString(
                SHA256.HashData(File.ReadAllBytes(canonicalExecutable))
            ).ToLowerInvariant();
        }
        else
        {
            executableContent.Position = 0;
            executableSha256 = Convert.ToHexString(SHA256.HashData(executableContent))
                .ToLowerInvariant();
            executableContent.Position = 0;
        }
        return new DurableApproval(
            SchemaVersion,
            canonicalExecutable,
            arguments.ToArray(),
            cwdBinding,
            declaredAccess
                .OrderBy(entry => entry.Path, StringComparer.Ordinal)
                .Select(entry => new DurableApprovalAccess(entry.Access.ToLowerInvariant(), entry.Path))
                .ToArray(),
            executableSha256);
    }

    public static bool Matches(
        DurableApproval approval,
        string executablePath,
        IReadOnlyList<string> arguments,
        string cwdBinding,
        IReadOnlyList<DurableApprovalAccess>? declaredAccess = null) =>
        Matches(approval, Create(executablePath, arguments, cwdBinding, declaredAccess));

    public static bool Matches(DurableApproval approval, DurableApproval current)
    {
        if (approval.SchemaVersion != SchemaVersion
            || string.IsNullOrWhiteSpace(approval.CwdBinding)
            || approval.DeclaredAccess is null)
            return false;
        return string.Equals(approval.ExecutablePath, current.ExecutablePath, StringComparison.OrdinalIgnoreCase)
            && approval.Arguments.SequenceEqual(current.Arguments, StringComparer.Ordinal)
            && string.Equals(approval.CwdBinding, current.CwdBinding, StringComparison.OrdinalIgnoreCase)
            && approval.DeclaredAccess.Count == current.DeclaredAccess.Count
            && approval.DeclaredAccess.Zip(current.DeclaredAccess).All(pair =>
                string.Equals(pair.First.Access, pair.Second.Access, StringComparison.Ordinal)
                && string.Equals(pair.First.Path, pair.Second.Path, StringComparison.OrdinalIgnoreCase))
            && CryptographicOperations.FixedTimeEquals(
                Encoding.ASCII.GetBytes(approval.ExecutableSha256),
                Encoding.ASCII.GetBytes(current.ExecutableSha256));
    }

    public static IReadOnlyList<DurableApproval> Load(string path)
    {
        if (!File.Exists(path))
            return [];
        var entries = JsonSerializer.Deserialize<List<DurableApproval>>(File.ReadAllText(path)) ?? [];
        return entries.Where(entry =>
            entry.SchemaVersion == SchemaVersion
            && !string.IsNullOrWhiteSpace(entry.CwdBinding)
            && entry.DeclaredAccess is not null).ToArray();
    }
}

public sealed class ExecutableApprovalLease : IDisposable
{
    private readonly FileStream _stream;

    private ExecutableApprovalLease(string canonicalPath, FileStream stream)
    {
        CanonicalPath = canonicalPath;
        _stream = stream;
    }

    public string CanonicalPath { get; }

    public static ExecutableApprovalLease Acquire(string executablePath)
    {
        var canonicalPath = WindowsPathCanonicalizer.CanonicalizeFile(executablePath);
        FileStream stream;
        try
        {
            stream = new FileStream(canonicalPath, FileMode.Open, FileAccess.Read, FileShare.Read);
        }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException)
        {
            throw new HostPolicyException(
                "executable-lock-failed",
                "The executable could not be locked against replacement before approval.");
        }

        try
        {
            var revalidatedPath = WindowsPathCanonicalizer.CanonicalizeFile(canonicalPath);
            if (!string.Equals(canonicalPath, revalidatedPath, StringComparison.OrdinalIgnoreCase))
                throw new HostPolicyException(
                    "executable-path-changed",
                    "The executable path changed while acquiring its approval lock.");
            return new ExecutableApprovalLease(canonicalPath, stream);
        }
        catch
        {
            stream.Dispose();
            throw;
        }
    }

    public DurableApproval Capture(
        IReadOnlyList<string> arguments,
        string cwdBinding,
        IReadOnlyList<DurableApprovalAccess>? declaredAccess = null) =>
        DurableApprovalIdentity.Create(
            CanonicalPath,
            arguments,
            cwdBinding,
            declaredAccess ?? [],
            _stream);

    public void Dispose() => _stream.Dispose();
}
