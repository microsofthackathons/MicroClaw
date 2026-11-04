using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace MicroClaw.WindowsNodeHost;

internal static class MxcIsolationTierGuard
{
    private static readonly HashSet<string> ExactFilesystemIsolationTiers =
        new(StringComparer.OrdinalIgnoreCase) { "base-container", "appcontainer-bfs" };
    private const string LimitedDaclTier = "appcontainer-dacl";
    private const string WxcExecX64Sha256 =
        "db0a3422be9e1b396cc1b2547c70ff16b27412438a31c10a45abf370cac86ae2";
    private const string WxcExecArm64Sha256 =
        "e430d0e4f44f616e91db684f8d825a6dc93e06a1262b8d00bcaac7522a317aab";

    public static async Task EnsureExactFilesystemIsolationAsync(
        string wxcExecPath,
        CancellationToken cancellationToken = default)
        => await EnsureFilesystemIsolationAsync(
            wxcExecPath,
            "full",
            expectedTier: null,
            cancellationToken);

    public static async Task<string> EnsureFilesystemIsolationAsync(
        string wxcExecPath,
        string requestedStrength,
        string? expectedTier,
        CancellationToken cancellationToken = default)
    {
        var parentDirectory = Path.GetDirectoryName(wxcExecPath)
            ?? throw new HostPolicyException(
                "mxc-path-invalid",
                "The pinned MXC runtime path has no parent directory.");
        using var directoryLease = DirectoryPathLease.Acquire([parentDirectory]);
        using var executableLease = ExecutableApprovalLease.Acquire(wxcExecPath);
        return await EnsureFilesystemIsolationAsync(
            executableLease,
            requestedStrength,
            expectedTier,
            cancellationToken);
    }

    internal static async Task EnsureExactFilesystemIsolationAsync(
        ExecutableApprovalLease executableLease,
        CancellationToken cancellationToken = default)
        => await EnsureFilesystemIsolationAsync(
            executableLease,
            "full",
            expectedTier: null,
            cancellationToken);

    internal static async Task<string> EnsureFilesystemIsolationAsync(
        ExecutableApprovalLease executableLease,
        string requestedStrength,
        string? expectedTier,
        CancellationToken cancellationToken = default)
    {
        executableLease.VerifySha256(ExpectedWxcExecSha256());
        var startInfo = new ProcessStartInfo
        {
            FileName = executableLease.CanonicalPath,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        startInfo.ArgumentList.Add("--probe");

        using var process = new Process { StartInfo = startInfo };
        try
        {
            if (!process.Start())
                throw new HostPolicyException(
                    "mxc-probe-launch-failed",
                    "The pinned MXC runtime probe could not be started.");
        }
        catch (HostPolicyException)
        {
            throw;
        }
        catch (Exception ex) when (ex is System.ComponentModel.Win32Exception or InvalidOperationException)
        {
            throw new HostPolicyException(
                "mxc-probe-launch-failed",
                $"The pinned MXC runtime probe could not be started: {ex.Message}");
        }

        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(15));
        var stdoutTask = process.StandardOutput.ReadToEndAsync(timeout.Token);
        var stderrTask = process.StandardError.ReadToEndAsync(timeout.Token);
        try
        {
            await process.WaitForExitAsync(timeout.Token);
        }
        catch (OperationCanceledException)
        {
            try { process.Kill(entireProcessTree: true); } catch (InvalidOperationException) { }
            cancellationToken.ThrowIfCancellationRequested();
            throw new HostPolicyException(
                "mxc-probe-timeout",
                "The pinned MXC runtime probe timed out.");
        }

        return ValidateProbeResult(
            process.ExitCode,
            await stdoutTask,
            await stderrTask,
            requestedStrength,
            expectedTier);
    }

    private static string ExpectedWxcExecSha256() =>
        RuntimeInformation.ProcessArchitecture switch
        {
            Architecture.X64 => WxcExecX64Sha256,
            Architecture.Arm64 => WxcExecArm64Sha256,
            _ => throw new HostPolicyException(
                "mxc-architecture-unsupported",
                $"The pinned MXC runtime does not support {RuntimeInformation.ProcessArchitecture}."),
        };

    internal static string ValidateProbeResult(int exitCode, string stdout, string stderr)
        => ValidateProbeResult(exitCode, stdout, stderr, "full", expectedTier: null);

    internal static string ValidateProbeResult(
        int exitCode,
        string stdout,
        string stderr,
        string requestedStrength,
        string? expectedTier)
    {
        if (exitCode != 0)
            throw new HostPolicyException(
                "mxc-probe-failed",
                $"The pinned MXC runtime probe exited with code {exitCode}: {stderr.Trim()}");

        try
        {
            using var document = JsonDocument.Parse(stdout);
            var root = document.RootElement;
            if (root.TryGetProperty("error", out var error)
                && error.ValueKind == JsonValueKind.String)
                throw new HostPolicyException(
                    "mxc-probe-failed",
                    error.GetString() ?? "The pinned MXC runtime reported an error.");
            if (root.TryGetProperty("supported", out var supported)
                && supported.ValueKind == JsonValueKind.False)
                throw new HostPolicyException(
                    "mxc-probe-unsupported",
                    "The pinned MXC runtime is not supported on this host.");

            var tier = root.TryGetProperty("tier", out var tierElement)
                && tierElement.ValueKind == JsonValueKind.String
                    ? tierElement.GetString()?.Trim()
                    : null;
            var needsDaclAugmentation =
                root.TryGetProperty("needsDaclAugmentation", out var dacl)
                && dacl.ValueKind == JsonValueKind.True;
            if (string.IsNullOrEmpty(tier))
                throw new HostPolicyException(
                    "mxc-filesystem-isolation-insufficient",
                    "MXC did not attest a filesystem isolation tier.");
            if (!string.IsNullOrWhiteSpace(expectedTier)
                && !string.Equals(tier, expectedTier, StringComparison.OrdinalIgnoreCase))
                throw new HostPolicyException(
                    "mxc-filesystem-isolation-drift",
                    $"MXC isolation tier drifted from {expectedTier} to {tier}.");
            if (string.Equals(requestedStrength, "full", StringComparison.Ordinal))
            {
                if (needsDaclAugmentation || !ExactFilesystemIsolationTiers.Contains(tier))
                    throw new HostPolicyException(
                        "mxc-filesystem-isolation-insufficient",
                        $"MXC isolation tier {tier} cannot enforce configured filesystem roots exactly; base-container or appcontainer-bfs is required.");
            }
            else if (string.Equals(requestedStrength, "limited-dacl", StringComparison.Ordinal))
            {
                if (!string.Equals(tier, LimitedDaclTier, StringComparison.OrdinalIgnoreCase))
                    throw new HostPolicyException(
                        "mxc-filesystem-isolation-insufficient",
                        $"Limited containment requires appcontainer-dacl, but MXC attested {tier}.");
            }
            else
            {
                throw new HostPolicyException(
                    "mxc-containment-strength-invalid",
                    $"Unsupported containment strength: {requestedStrength}.");
            }
            return tier;
        }
        catch (HostPolicyException)
        {
            throw;
        }
        catch (JsonException)
        {
            throw new HostPolicyException(
                "mxc-probe-invalid",
                "The pinned MXC runtime probe returned invalid JSON.");
        }
    }
}
