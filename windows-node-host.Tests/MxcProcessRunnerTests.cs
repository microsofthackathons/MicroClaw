using System.Diagnostics;
using MicroClaw.WindowsNodeHost;

namespace MicroClaw.WindowsNodeHost.Tests;

public sealed class MxcProcessRunnerTests
{
    [Fact]
    public void ScratchEnvironmentIsScopedToTheMxcChild()
    {
        var originalTemp = Environment.GetEnvironmentVariable("TEMP");
        var originalTmp = Environment.GetEnvironmentVariable("TMP");
        var originalTmpDir = Environment.GetEnvironmentVariable("TMPDIR");
        var scratch = Path.Combine(Path.GetTempPath(), "mxc-scratch");
        var startInfo = MxcProcessRunner.CreateStartInfo(
            @"C:\mxc\wxc-exec.exe", @"C:\mxc\config.json", @"C:\work", scratch);

        Assert.Equal(new[] { "--config", @"C:\mxc\config.json" }, startInfo.ArgumentList);
        Assert.Equal(scratch, startInfo.Environment["TEMP"]);
        Assert.Equal(scratch, startInfo.Environment["TMP"]);
        Assert.Equal(scratch, startInfo.Environment["TMPDIR"]);
        Assert.Equal(originalTemp, Environment.GetEnvironmentVariable("TEMP"));
        Assert.Equal(originalTmp, Environment.GetEnvironmentVariable("TMP"));
        Assert.Equal(originalTmpDir, Environment.GetEnvironmentVariable("TMPDIR"));
    }

    [Fact]
    public async Task ProcessCaptureRetainsTheMxcOutputLimit()
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = Path.Combine(Environment.SystemDirectory, "cmd.exe"),
            Arguments = "/d /s /c \"echo 123456789\"",
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        var result = await ChildProcessCapture.RunAsync(
            startInfo, 10_000, TestContext.Current.CancellationToken, outputLimit: 5, trimOutput: true);

        Assert.Equal(0, result.ExitCode);
        Assert.StartsWith("12345\n\n... [TRUNCATED", result.Stdout);
    }

    [Fact]
    public async Task ProcessCaptureReturnsCancelledMxcExecution()
    {
        var startInfo = new ProcessStartInfo
        {
            FileName = Path.Combine(Environment.SystemDirectory, "cmd.exe"),
            Arguments = "/d /s /c \"ping -n 30 127.0.0.1 >nul\"",
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        using var cancellation = new CancellationTokenSource(TimeSpan.FromMilliseconds(300));
        var result = await ChildProcessCapture.RunAsync(
            startInfo, 0, cancellation.Token, returnCancelledResult: true);

        Assert.True(result.TimedOut);
        Assert.Equal(-1, result.ExitCode);
        Assert.Equal("Execution was cancelled.", result.Stderr);
    }
}
