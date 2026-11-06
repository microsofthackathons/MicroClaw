using MicroClaw.WindowsNodeHost;
using Xunit;

namespace MicroClaw.WindowsNodeHost.Tests;

public sealed class AmbientAccessAssessmentTests : IDisposable
{
    private static readonly string[] RequiredCategories =
    [
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
    ];

    private readonly string _root =
        Path.Combine(Path.GetTempPath(), "microclaw-ambient-tests-" + Guid.NewGuid().ToString("N"));

    public AmbientAccessAssessmentTests()
    {
        Directory.CreateDirectory(_root);
    }

    [Fact]
    public async Task CoversEveryCategorySequentiallyWithDeterministicOrderingAndDiagnostics()
    {
        var cancellationToken = TestContext.Current.CancellationToken;
        var wxcExecPath = Path.Combine(_root, "wxc-exec.exe");
        await File.WriteAllTextAsync(wxcExecPath, "", cancellationToken);
        var scratchRoot = Directory.CreateDirectory(Path.Combine(_root, "scratch")).FullName;
        var active = 0;
        var maxActive = 0;
        var seen = new List<string>();
        var diagnostics = new List<string>();

        var result = await AmbientAccessAssessment.RunAsync(
            new AmbientAccessAssessmentRequest(
                wxcExecPath,
                scratchRoot,
                RequiredCategories
                    .Reverse()
                    .Select(category => new AmbientAccessTarget(category, $@"C:\Ambient\{category}"))
                    .ToArray()),
            (_, _) => Task.CompletedTask,
            async (target, _, _, cancellationToken) =>
            {
                var current = Interlocked.Increment(ref active);
                maxActive = Math.Max(maxActive, current);
                seen.Add(target.Category);
                try
                {
                    await Task.Delay(20, cancellationToken);
                    return "denied";
                }
                finally
                {
                    Interlocked.Decrement(ref active);
                }
            },
            diagnostics.Add,
            cancellationToken);

        Assert.Equal(RequiredCategories.Order(StringComparer.Ordinal), seen.Order(StringComparer.Ordinal));
        Assert.Equal(RequiredCategories.Order(StringComparer.Ordinal), result.Entries.Select(entry => entry.Category));
        Assert.All(result.Entries, entry => Assert.Equal("denied", entry.Status));
        Assert.Equal(1, maxActive);
        Assert.Equal(0, active);
        Assert.Equal(19, diagnostics.Count);
        Assert.Contains(diagnostics, entry => entry.Contains("complete categories=18 elapsedMs="));
    }

    public void Dispose()
    {
        Directory.Delete(_root, recursive: true);
    }
}
