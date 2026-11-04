using System.Diagnostics;
using System.Text;
using OpenClaw.Shared;

namespace MicroClaw.WindowsNodeHost;

internal static class MxcProcessRunner
{
    private const int OutputLimit = 4 * 1024 * 1024;

    internal static ProcessStartInfo CreateStartInfo(
        string executable, string configPath, string workingDirectory, string scratch)
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = executable,
            WorkingDirectory = workingDirectory,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        startInfo.ArgumentList.Add("--config");
        startInfo.ArgumentList.Add(configPath);
        startInfo.Environment["TEMP"] = scratch;
        startInfo.Environment["TMP"] = scratch;
        startInfo.Environment["TMPDIR"] = scratch;
        return startInfo;
    }

    internal static Task<CommandResult> RunAsync(
        string executable, string configPath, string workingDirectory, string scratch,
        CancellationToken cancellationToken) =>
        ChildProcessCapture.RunAsync(
            CreateStartInfo(executable, configPath, workingDirectory, scratch),
            0, cancellationToken, OutputLimit, returnCancelledResult: true, trimOutput: true);
}
