using MicroClaw.WindowsNodeHost;
using OpenClaw.Shared;

namespace MicroClaw.WindowsNodeHost.Tests;

public sealed class MxcCmdSerializerTests
{
    private static readonly string Cmd = Path.Combine(Environment.SystemDirectory, "cmd.exe");
    private static readonly string PowerShell =
        Path.Combine(Environment.SystemDirectory, @"WindowsPowerShell\v1.0\powershell.exe");

    [Fact]
    public async Task QuotingPinnedExecutablePreservesTheCommandAndArguments()
    {
        var payload = $" \t{PowerShell}\t-NoProfile -NonInteractive -Command Write-Output 'two words' alpha";
        string[] approved = [Cmd, "/d", "/s", "/c", payload];

        var serialized = MxcCmdSerializer.ForContainer(approved);

        Assert.Equal($" \t\"{PowerShell}\"\t-NoProfile -NonInteractive -Command Write-Output 'two words' alpha", serialized[4]);
        Assert.Equal(payload, approved[4]);
        var originalResult = await Run(approved);
        var quotedResult = await Run(serialized);
        Assert.Equal(0, originalResult.ExitCode);
        Assert.Equal(0, quotedResult.ExitCode);
        Assert.Equal(originalResult.Stdout, quotedResult.Stdout);
        Assert.Equal(originalResult.Stderr, quotedResult.Stderr);
        Assert.Contains("two words", quotedResult.Stdout);
    }

    [Theory]
    [InlineData("{exe} alpha & echo changed")]
    [InlineData("{exe} \"quoted argument\"")]
    [InlineData("{exe} %PATH%")]
    [InlineData("{exe} escaped^")]
    [InlineData("{exe} function()")]
    [InlineData("{exe} trailing\\")]
    [InlineData("{exe}\r\necho changed")]
    [InlineData("{exe} \u00a0argument")]
    [InlineData("echo builtin")]
    [InlineData("powershell -Command Get-Date")]
    public void NonStaticPayloadsAndBareCommandsAreUnchanged(string template)
    {
        var payload = template.Replace("{exe}", PowerShell);
        string[] approved = [Cmd, "/d", "/s", "/c", payload];
        Assert.Same(approved, MxcCmdSerializer.ForContainer(approved));
    }

    [Fact]
    public void UntrustedOrNonCanonicalCarriersAreUnchanged()
    {
        var payload = $"{PowerShell} -Command Get-Date";
        string[] untrusted = [Path.Combine(Path.GetTempPath(), "cmd.exe"), "/d", "/s", "/c", payload];
        string[] nonCanonical = [Cmd, "/c", payload];
        Assert.Same(untrusted, MxcCmdSerializer.ForContainer(untrusted));
        Assert.Same(nonCanonical, MxcCmdSerializer.ForContainer(nonCanonical));
    }

    private static Task<CommandResult> Run(IReadOnlyList<string> argv) =>
        HostCommandRunner.RunAsync(new CommandRequest
        {
            Argv = argv,
            Cwd = Environment.SystemDirectory,
            TimeoutMs = 10_000,
        }, TestContext.Current.CancellationToken);
}
