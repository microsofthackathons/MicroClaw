using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text.Json;
using System.Text.Json.Serialization;
using Microsoft.Win32.SafeHandles;

namespace MicroClaw.WindowsNodeHost;

public static class CwdPolicyContract
{
    public const string Version = "microclaw.windows-cwd.v1";
    public const string ScratchBinding = "isolated-scratch:v1";
}

public sealed record CwdPolicyAttestation(
    [property: JsonPropertyName("contract")] string Contract,
    [property: JsonPropertyName("approvedRootOnly")] bool ApprovedRootOnly,
    [property: JsonPropertyName("canonicalFinalPath")] bool CanonicalFinalPath,
    [property: JsonPropertyName("rejectsReparseComponents")] bool RejectsReparseComponents,
    [property: JsonPropertyName("durableApprovalBindsCwd")] bool DurableApprovalBindsCwd,
    [property: JsonPropertyName("durableApprovalBindsDeclaredAccess")] bool DurableApprovalBindsDeclaredAccess,
    [property: JsonPropertyName("launchTimeRevalidation")] bool LaunchTimeRevalidation,
    [property: JsonPropertyName("omittedCwdUsesIsolatedScratch")] bool OmittedCwdUsesIsolatedScratch,
    [property: JsonPropertyName("hostFallbackAbsent")] bool HostFallbackAbsent,
    [property: JsonPropertyName("activationLeaseContract")] string ActivationLeaseContract,
    [property: JsonPropertyName("generationBoundActivation")] bool GenerationBoundActivation,
    [property: JsonPropertyName("policyBoundActivation")] bool PolicyBoundActivation,
    [property: JsonPropertyName("launchTimeLeaseRevalidation")] bool LaunchTimeLeaseRevalidation,
    [property: JsonPropertyName("approvalProofContract")] string ApprovalProofContract,
    [property: JsonPropertyName("activeRunsRequireApprovalProof")] bool ActiveRunsRequireApprovalProof,
    [property: JsonPropertyName("approvalProofBindsPreparedPlan")] bool ApprovalProofBindsPreparedPlan,
    [property: JsonPropertyName("approvalProofPlanContract")] string ApprovalProofPlanContract,
    [property: JsonPropertyName("approvalProofBindsExecutableContent")] bool ApprovalProofBindsExecutableContent,
    [property: JsonPropertyName("approvalProofBindsActivation")] bool ApprovalProofBindsActivation,
    [property: JsonPropertyName("approvalProofOneUse")] bool ApprovalProofOneUse,
    [property: JsonPropertyName("launchTimeApprovalProofRevalidation")] bool LaunchTimeApprovalProofRevalidation,
    [property: JsonPropertyName("readinessProofContract")] string ReadinessProofContract,
    [property: JsonPropertyName("readinessProofBindsTransition")] bool ReadinessProofBindsTransition,
    [property: JsonPropertyName("readinessProofBindsPreparedPlan")] bool ReadinessProofBindsPreparedPlan,
    [property: JsonPropertyName("readinessProofExactBuiltInsOnly")] bool ReadinessProofExactBuiltInsOnly,
    [property: JsonPropertyName("readinessProofOneUse")] bool ReadinessProofOneUse,
    [property: JsonPropertyName("launchTimeReadinessProofRevalidation")] bool LaunchTimeReadinessProofRevalidation,
    [property: JsonPropertyName("exactFilesystemIsolationRequired")] bool ExactFilesystemIsolationRequired,
    [property: JsonPropertyName("degradedIsolationTierRejected")] bool DegradedIsolationTierRejected,
    [property: JsonPropertyName("durableApprovalStoreProtected")] bool DurableApprovalStoreProtected,
    [property: JsonPropertyName("durableApprovalsPresent")] bool DurableApprovalsPresent,
    [property: JsonPropertyName("requestedContainmentStrength")] string RequestedContainmentStrength,
    [property: JsonPropertyName("folderPolicyIsExclusiveBoundary")] bool FolderPolicyIsExclusiveBoundary,
    [property: JsonPropertyName("durableApprovalsAllowed")] bool DurableApprovalsAllowed,
    [property: JsonPropertyName("ambientAssessmentBound")] bool AmbientAssessmentBound,
    [property: JsonPropertyName("outboundNetworkEnabled")] bool OutboundNetworkEnabled)
{
    public static readonly CwdPolicyAttestation Current = new(
        CwdPolicyContract.Version,
        ApprovedRootOnly: true,
        CanonicalFinalPath: true,
        RejectsReparseComponents: true,
        DurableApprovalBindsCwd: true,
        DurableApprovalBindsDeclaredAccess: true,
        LaunchTimeRevalidation: true,
        OmittedCwdUsesIsolatedScratch: true,
        HostFallbackAbsent: true,
        ActivationLeaseContract: global::MicroClaw.WindowsNodeHost.ActivationLeaseContract.Version,
        GenerationBoundActivation: true,
        PolicyBoundActivation: true,
        LaunchTimeLeaseRevalidation: true,
        ApprovalProofContract: global::MicroClaw.WindowsNodeHost.ApprovalProofContract.Version,
        ActiveRunsRequireApprovalProof: true,
        ApprovalProofBindsPreparedPlan: true,
        ApprovalProofPlanContract: global::MicroClaw.WindowsNodeHost.ApprovalProofContract.PlanVersion,
        ApprovalProofBindsExecutableContent: true,
        ApprovalProofBindsActivation: true,
        ApprovalProofOneUse: true,
        LaunchTimeApprovalProofRevalidation: true,
        ReadinessProofContract: global::MicroClaw.WindowsNodeHost.ReadinessProbeContract.Version,
        ReadinessProofBindsTransition: true,
        ReadinessProofBindsPreparedPlan: true,
        ReadinessProofExactBuiltInsOnly: true,
        ReadinessProofOneUse: true,
        LaunchTimeReadinessProofRevalidation: true,
        ExactFilesystemIsolationRequired: true,
        DegradedIsolationTierRejected: true,
        DurableApprovalStoreProtected: true,
        DurableApprovalsPresent: false,
        RequestedContainmentStrength: "full",
        FolderPolicyIsExclusiveBoundary: true,
        DurableApprovalsAllowed: true,
        AmbientAssessmentBound: false,
        OutboundNetworkEnabled: true);

    public static CwdPolicyAttestation ForPolicy(HostPolicy policy) =>
        Current with
        {
            ExactFilesystemIsolationRequired =
                string.Equals(policy.RequestedStrength, "full", StringComparison.Ordinal),
            DegradedIsolationTierRejected =
                string.Equals(policy.RequestedStrength, "full", StringComparison.Ordinal),
            RequestedContainmentStrength = policy.RequestedStrength,
            FolderPolicyIsExclusiveBoundary =
                string.Equals(policy.RequestedStrength, "full", StringComparison.Ordinal),
            DurableApprovalsAllowed = policy.DurableApprovalsAllowed,
            AmbientAssessmentBound = policy.AmbientAccess is not null,
        };
}

public enum FolderAccess
{
    ReadOnly,
    ReadWrite,
}

public sealed record ApprovedRoot(string Path, FolderAccess Access);

public sealed record CanonicalCwd(
    string LaunchPath,
    string ApprovalBinding,
    FolderAccess Access,
    string? MatchedRoot);

public sealed class HostPolicyException(string code, string message) : Exception(message)
{
    public string Code { get; } = code;
}

public sealed class HostPolicy
{
    public required IReadOnlyList<ApprovedRoot> ApprovedRoots { get; init; }
    public required IReadOnlyList<string> DeniedRoots { get; init; }
    public required string WxcExecPath { get; init; }
    public bool NetworkAllowed { get; init; }
    public bool AllowWindowsUi { get; init; }
    public string Clipboard { get; init; } = "none";
    public bool InputInjection { get; init; }
    public bool StrictNoHostFallback { get; init; }
    public string RequestedStrength { get; init; } = "full";
    public string EffectiveTier { get; init; } = "base-container";
    public AmbientAccessPolicy? AmbientAccess { get; init; }
    public string AmbientAssessmentScratchRoot { get; init; } = Path.GetTempPath();
    public bool DurableApprovalsAllowed =>
        string.Equals(RequestedStrength, "full", StringComparison.Ordinal);
    public CwdPolicyAttestation Attestation => CwdPolicyAttestation.ForPolicy(this);

    public static async Task<HostPolicy> LoadAsync(string path)
    {
        var json = await File.ReadAllBytesAsync(path);
        return Parse(json);
    }

    public static async Task<HostPolicy> LoadVerifiedAsync(string path, string expectedSha256)
    {
        var json = await File.ReadAllBytesAsync(path);
        var actualSha256 = Convert.ToHexString(SHA256.HashData(json)).ToLowerInvariant();
        if (!string.Equals(actualSha256, expectedSha256, StringComparison.Ordinal))
            throw new HostPolicyException(
                "policy-fingerprint-mismatch",
                "The loaded sandbox policy does not match MicroClaw's activation fingerprint.");
        return Parse(json);
    }

    private static HostPolicy Parse(ReadOnlySpan<byte> json)
    {
        HostPolicyInput input;
        try
        {
            var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
            options.Converters.Add(new JsonStringEnumConverter());
            input = JsonSerializer.Deserialize<HostPolicyInput>(json, options)
                ?? throw new HostPolicyException("malformed-policy", "Policy is empty.");
        }
        catch (JsonException ex)
        {
            throw new HostPolicyException("malformed-policy", $"Policy JSON is invalid: {ex.Message}");
        }

        if (!input.StrictNoHostFallback)
            throw new HostPolicyException("host-fallback-enabled", "Strict no-host-fallback must be enabled.");
        if (!input.AllowWindowsUi)
            throw new HostPolicyException("windows-ui-disabled", "allowWindowsUi must be enabled for MXC 0.7.");
        if (!input.NetworkAllowed)
            throw new HostPolicyException(
                "outbound-network-disabled",
                "Contained outbound network access must be enabled.");
        if (input.InputInjection || !string.Equals(input.Clipboard, "none", StringComparison.Ordinal))
            throw new HostPolicyException(
                "unsafe-capability",
                "Clipboard and input injection must remain disabled.");
        if (input.RequestedStrength is not ("full" or "limited-dacl"))
            throw new HostPolicyException(
                "containment-strength-invalid",
                "The requested containment strength is invalid.");
        if (string.IsNullOrWhiteSpace(input.EffectiveTier))
            throw new HostPolicyException(
                "containment-tier-missing",
                "The effective MXC tier is missing.");
        if (input.RequestedStrength == "full"
            && input.EffectiveTier is not ("base-container" or "appcontainer-bfs"))
            throw new HostPolicyException(
                "containment-tier-mismatch",
                "Full containment requires base-container or appcontainer-bfs.");
        if (input.RequestedStrength == "limited-dacl"
            && !string.Equals(input.EffectiveTier, "appcontainer-dacl", StringComparison.Ordinal))
            throw new HostPolicyException(
                "containment-tier-mismatch",
                "Limited containment requires appcontainer-dacl.");
        if (input.RequestedStrength == "limited-dacl")
        {
            if (input.AmbientAccess is null)
                throw new HostPolicyException(
                    "ambient-assessment-required",
                    "Limited containment requires an ambient-access assessment.");
            AmbientAccessAssessment.ValidatePolicy(input.AmbientAccess);
        }
        else if (input.AmbientAccess is not null)
        {
            throw new HostPolicyException(
                "ambient-assessment-unexpected",
                "Full containment must not carry a Limited-mode ambient-access assessment.");
        }

        var approved = (input.ApprovedRoots ?? [])
            .Select(root => new ApprovedRoot(
                WindowsPathCanonicalizer.CanonicalizeDirectory(root.Path),
                root.Access))
            .ToArray();
        var denied = (input.DeniedRoots ?? [])
            .Select(WindowsPathCanonicalizer.CanonicalizeProtectedDirectory)
            .ToArray();
        if (approved.Any(root => denied.Any(protectedRoot =>
            WindowsPathCanonicalizer.IsEqualOrNested(root.Path, protectedRoot)
            || WindowsPathCanonicalizer.IsEqualOrNested(protectedRoot, root.Path))))
        {
            throw new HostPolicyException(
                "approved-root-overlaps-sensitive-root",
                "Approved folders must not contain or be contained by a protected root.");
        }
        var wxc = WindowsPathCanonicalizer.CanonicalizeFile(input.WxcExecPath);
        var ambientScratch =
            input.RequestedStrength == "limited-dacl"
                ? WindowsPathCanonicalizer.CanonicalizeDirectory(
                    input.AmbientAssessmentScratchRoot)
                : Path.GetFullPath(input.AmbientAssessmentScratchRoot);

        return new HostPolicy
        {
            ApprovedRoots = approved,
            DeniedRoots = denied,
            WxcExecPath = wxc,
            NetworkAllowed = true,
            AllowWindowsUi = true,
            Clipboard = "none",
            InputInjection = false,
            StrictNoHostFallback = true,
            RequestedStrength = input.RequestedStrength,
            EffectiveTier = input.EffectiveTier.ToLowerInvariant(),
            AmbientAccess = input.AmbientAccess,
            AmbientAssessmentScratchRoot = ambientScratch,
        };
    }

    public CanonicalCwd ResolveCwd(string? requestedCwd)
    {
        if (string.IsNullOrWhiteSpace(requestedCwd))
            return new CanonicalCwd(
                string.Empty,
                CwdPolicyContract.ScratchBinding,
                FolderAccess.ReadWrite,
                MatchedRoot: null);

        var canonical = WindowsPathCanonicalizer.CanonicalizeDirectory(requestedCwd);
        if (DeniedRoots.Any(root => WindowsPathCanonicalizer.IsEqualOrNested(canonical, root)))
            throw new HostPolicyException("cwd-sensitive-root", "The requested working directory overlaps a protected root.");

        var grant = ApprovedRoots
            .Where(root => WindowsPathCanonicalizer.IsEqualOrNested(canonical, root.Path))
            .OrderByDescending(root => root.Path.Length)
            .FirstOrDefault()
            ?? throw new HostPolicyException("cwd-outside-approved-roots", "The requested working directory is not within an approved folder.");

        return new CanonicalCwd(canonical, canonical, grant.Access, grant.Path);
    }

    public CanonicalCwd RevalidateCwd(string? requestedCwd, string approvalBinding)
    {
        var current = ResolveCwd(requestedCwd);
        if (!string.Equals(current.ApprovalBinding, approvalBinding, StringComparison.OrdinalIgnoreCase))
            throw new HostPolicyException("cwd-binding-changed", "The canonical working directory no longer matches the approval.");
        return current;
    }

    private sealed class HostPolicyInput
    {
        public List<ApprovedRootInput>? ApprovedRoots { get; init; }
        public List<string>? DeniedRoots { get; init; }
        public string WxcExecPath { get; init; } = string.Empty;
        public bool NetworkAllowed { get; init; }
        public bool AllowWindowsUi { get; init; }
        public string Clipboard { get; init; } = "none";
        public bool InputInjection { get; init; }
        public bool StrictNoHostFallback { get; init; }
        public string RequestedStrength { get; init; } = "full";
        public string EffectiveTier { get; init; } = "base-container";
        public AmbientAccessPolicy? AmbientAccess { get; init; }
        public string AmbientAssessmentScratchRoot { get; init; } = Path.GetTempPath();
    }

    private sealed class ApprovedRootInput
    {
        public string Path { get; init; } = string.Empty;
        public FolderAccess Access { get; init; }
    }
}

public static class WindowsPathCanonicalizer
{
    public static string CanonicalizeDirectory(string path) => Canonicalize(path, expectDirectory: true);
    public static string CanonicalizeFile(string path) => Canonicalize(path, expectDirectory: false);
    public static string CanonicalizeProtectedDirectory(string path) =>
        Canonicalize(path, expectDirectory: true, allowMissing: true);

    public static bool IsEqualOrNested(string path, string root)
    {
        if (string.Equals(path, root, StringComparison.OrdinalIgnoreCase))
            return true;
        return path.StartsWith(root.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase);
    }

    private static string Canonicalize(string path, bool expectDirectory, bool allowMissing = false)
    {
        if (!OperatingSystem.IsWindows())
            throw new PlatformNotSupportedException("Windows path policy requires Windows.");
        if (string.IsNullOrWhiteSpace(path))
            throw new HostPolicyException("path-empty", "A path is required.");
        if (path.StartsWith(@"\\", StringComparison.Ordinal)
            || path.StartsWith(@"\\?\", StringComparison.Ordinal)
            || path.StartsWith(@"\??\", StringComparison.Ordinal)
            || path.StartsWith(@"\Device\", StringComparison.OrdinalIgnoreCase))
            throw new HostPolicyException("path-nonlocal", "UNC, device, and NT object-manager paths are denied.");

        var full = Path.GetFullPath(path);
        if (!Path.IsPathFullyQualified(full) || Path.GetPathRoot(full)?.Length != 3)
            throw new HostPolicyException("path-nonlocal", "Only local drive-qualified paths are allowed.");
        full = TrimTrailingSeparatorsPreservingRoot(full);

        RejectReparseComponents(full);
        var exists = expectDirectory ? Directory.Exists(full) : File.Exists(full);
        if (!exists && allowMissing)
            return full;
        if (expectDirectory && !exists)
            throw new HostPolicyException("cwd-not-found", "The working directory does not exist.");
        if (!expectDirectory && !exists)
            throw new HostPolicyException("file-not-found", "The required file does not exist.");

        using var handle = CreateFile(
            full,
            0,
            FileShare.ReadWrite | FileShare.Delete,
            IntPtr.Zero,
            FileMode.Open,
            0x02000000,
            IntPtr.Zero);
        if (handle.IsInvalid)
            throw new HostPolicyException("path-final-resolution-failed", "Windows could not open the path for final-target validation.");
        var final = GetFinalPath(handle);
        if (final.StartsWith(@"\\?\", StringComparison.Ordinal))
            final = final[4..];
        final = TrimTrailingSeparatorsPreservingRoot(final);
        if (!string.Equals(full, final, StringComparison.OrdinalIgnoreCase))
            throw new HostPolicyException("path-final-target-changed", "The final path differs from the validated path.");
        return final;
    }

    private static string TrimTrailingSeparatorsPreservingRoot(string path)
    {
        var root = Path.GetPathRoot(path);
        return string.Equals(path, root, StringComparison.OrdinalIgnoreCase)
            ? root!
            : path.TrimEnd('\\');
    }

    private static void RejectReparseComponents(string fullPath)
    {
        var root = Path.GetPathRoot(fullPath)!;
        var current = root;
        foreach (var component in fullPath[root.Length..].Split('\\', StringSplitOptions.RemoveEmptyEntries))
        {
            current = Path.Combine(current, component);
            if (!File.Exists(current) && !Directory.Exists(current))
                break;
            if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                throw new HostPolicyException("path-reparse-point", $"Reparse-point path components are denied: {current}");
        }
    }

    private static string GetFinalPath(SafeFileHandle handle)
    {
        var buffer = new char[32768];
        var length = GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Length, 0);
        if (length == 0 || length >= buffer.Length)
            throw new HostPolicyException("path-final-resolution-failed", "Windows could not resolve the final path.");
        return new string(buffer, 0, (int)length);
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(
        SafeFileHandle hFile,
        [Out] char[] lpszFilePath,
        uint cchFilePath,
        uint dwFlags);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(
        string lpFileName,
        uint dwDesiredAccess,
        FileShare dwShareMode,
        IntPtr lpSecurityAttributes,
        FileMode dwCreationDisposition,
        uint dwFlagsAndAttributes,
        IntPtr hTemplateFile);
}

public sealed class DirectoryPathLease : IDisposable
{
    private readonly IReadOnlyList<SafeFileHandle> _handles;

    private DirectoryPathLease(IReadOnlyList<SafeFileHandle> handles)
    {
        _handles = handles;
    }

    public static DirectoryPathLease Acquire(IEnumerable<string> paths)
    {
        var canonicalPaths = paths
            .Where(path => !string.IsNullOrWhiteSpace(path))
            .Select(WindowsPathCanonicalizer.CanonicalizeDirectory)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        var componentPaths = canonicalPaths
            .SelectMany(EnumerateComponents)
            .Distinct(StringComparer.OrdinalIgnoreCase)
            .ToArray();
        var handles = new List<SafeFileHandle>(componentPaths.Length);
        try
        {
            foreach (var componentPath in componentPaths)
            {
                var handle = CreateFile(
                    componentPath,
                    0x00000001,
                    FileShare.ReadWrite,
                    IntPtr.Zero,
                    FileMode.Open,
                    0x02000000,
                    IntPtr.Zero);
                if (handle.IsInvalid)
                {
                    handle.Dispose();
                    throw new HostPolicyException(
                        "directory-lock-failed",
                        $"A validated directory component could not be locked against replacement: {componentPath}");
                }
                handles.Add(handle);
            }

            foreach (var canonicalPath in canonicalPaths)
            {
                var revalidated = WindowsPathCanonicalizer.CanonicalizeDirectory(canonicalPath);
                if (!string.Equals(canonicalPath, revalidated, StringComparison.OrdinalIgnoreCase))
                    throw new HostPolicyException(
                        "directory-path-changed",
                        "A validated directory changed while acquiring its launch lease.");
            }
            return new DirectoryPathLease(handles);
        }
        catch
        {
            foreach (var handle in handles)
                handle.Dispose();
            throw;
        }
    }

    public void Dispose()
    {
        foreach (var handle in _handles)
            handle.Dispose();
    }

    private static IEnumerable<string> EnumerateComponents(string path)
    {
        var root = Path.GetPathRoot(path)!;
        yield return root;
        var current = root;
        foreach (var component in path[root.Length..].Split('\\', StringSplitOptions.RemoveEmptyEntries))
        {
            current = Path.Combine(current, component);
            yield return current;
        }
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(
        string lpFileName,
        uint dwDesiredAccess,
        FileShare dwShareMode,
        IntPtr lpSecurityAttributes,
        FileMode dwCreationDisposition,
        uint dwFlagsAndAttributes,
        IntPtr hTemplateFile);
}
