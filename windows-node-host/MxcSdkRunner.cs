using Microsoft.Mxc.Sdk.V1;
using OpenClaw.Shared;
using OpenClaw.Shared.FileTransfer;
using OpenClaw.Shared.Mxc;

namespace MicroClaw.WindowsNodeHost;

internal sealed record MxcExecutionContext(NodeSandboxExecutor Executor, MxcProcessTracker Processes);

internal static class MxcSdkRunner
{
    internal static SettingsData BuildSettings(HostPolicy policy) => new()
    {
        SystemRunFilesystemScope = SystemRunFilesystemScope.SelectedFolders,
        SystemRunAllowOutbound = policy.NetworkAllowed,
        SandboxClipboard = SandboxClipboardMode.None,
        SandboxTimeoutMs = 600_000,
        SandboxCustomFolders = policy.ApprovedRoots.Select(root => new SandboxCustomFolder
        {
            Path = root.Path,
            Access = root.Access == FolderAccess.ReadWrite
                ? SandboxFolderAccess.ReadWrite
                : SandboxFolderAccess.ReadOnly,
        }).ToList(),
    };

    internal static MxcExecutionContext CreateExecutor(
        HostPolicy policy,
        string approvalsPath)
    {
        var settingsDirectory = GetSettingsDirectory(approvalsPath);
        var settings = BuildSettings(policy);
        var processes = new MxcProcessTracker();
        var executor = new NodeSandboxExecutor(
            new NodeSandboxPolicyStore(settings),
            () => settingsDirectory,
            availabilityProvider: () => MxcIsolationTierGuard.RequireAvailability(policy.EffectiveTier),
            logger: new StderrLogger(),
            spawn: processes.SpawnAsync,
            fileWorker: new InstalledFileWorkerResolver(typeof(MxcSdkRunner).Assembly));
        return new MxcExecutionContext(executor, processes);
    }

    internal static void ValidatePolicy(HostPolicy policy, string approvalsPath)
    {
        var settingsDirectory = GetSettingsDirectory(approvalsPath);
        var scratchRoot = NodeSandboxExecutor.GetDefaultScratchRoot(
            Environment.GetEnvironmentVariable("OPENCLAW_TRAY_LOCALAPPDATA_DIR"),
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData));
        var payloadCacheRoot = NodeSandboxExecutor.GetPayloadCacheRoot(scratchRoot);
        using var operation = MxcOwnedOperation.Create(scratchRoot);
        try
        {
            operation.CreateScratch();
            var scratch = MxcPhysicalPaths.ResolveDirectory(
                operation.Scratch, MxcFolderAdmission.ReadMetadata, requireExisting: true);
            var context = MxcRequestContext.Capture(settingsDirectory);
            context = context with
            {
                ExecutorPrivatePaths = [.. context.ExecutorPrivatePaths, scratchRoot, payloadCacheRoot],
            };
            var resources = MxcRequestBuilder.ComposeResources(
                BuildSettings(policy), settingsDirectory, scratch, context,
                MxcFolderAdmission.ReadMetadata);
            ManagedUploadPolicy.ValidateBoundary(
                resources.DataAccess, ManagedUploadPolicy.ResolvePath(scratchRoot, settingsDirectory));
        }
        finally
        {
            operation.Delete();
        }
    }

    private static string GetSettingsDirectory(string approvalsPath) =>
        Path.GetDirectoryName(approvalsPath)
        ?? throw new HostPolicyException(
            "approval-path-invalid", "The command approval store has no parent directory.");
}
