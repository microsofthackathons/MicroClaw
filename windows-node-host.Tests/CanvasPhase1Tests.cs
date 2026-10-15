using System.Security.Cryptography;
using System.Text.Json;
using MicroClaw.WindowsNodeHost;
using OpenClaw.Shared;
using Xunit;

namespace MicroClaw.WindowsNodeHost.Tests;

public sealed class CanvasPhase1Tests : IDisposable
{
    private readonly string _root = Path.Combine(
        Path.GetTempPath(),
        "microclaw-canvas-tests-" + Guid.NewGuid().ToString("N"));

    public CanvasPhase1Tests() => Directory.CreateDirectory(_root);

    [Fact]
    public void AdvertisesExactReviewedCommandsAndActions()
    {
        Assert.Equal(
            [
                "canvas.present",
                "canvas.hide",
                "canvas.snapshot",
                "canvas.caps",
                "canvas.a2ui.push",
                "canvas.a2ui.pushJSONL",
                "canvas.a2ui.reset",
                "canvas.a2ui.dump",
            ],
            CanvasPhase1Policy.Commands);
        Assert.DoesNotContain("canvas.eval", CanvasPhase1Policy.Commands);
        Assert.DoesNotContain("canvas.navigate", CanvasPhase1Policy.Commands);
        Assert.Equal(["cancel", "click", "confirm", "submit"], CanvasPhase1Policy.Actions);
    }

    [Fact]
    public async Task CanvasHostTreeHashChangesWithAnyResource()
    {
        var hostDirectory = Path.Combine(_root, "canvas-host");
        Directory.CreateDirectory(Path.Combine(hostDirectory, "nested"));
        await File.WriteAllTextAsync(
            Path.Combine(hostDirectory, "host.exe"),
            "apphost",
            TestContext.Current.CancellationToken);
        var dependency = Path.Combine(hostDirectory, "nested", "host.dll");
        await File.WriteAllTextAsync(
            dependency,
            "managed-code",
            TestContext.Current.CancellationToken);
        var original = CanvasHostBroker.ComputeDirectoryTreeHash(hostDirectory);
        Assert.Equal(original, CanvasHostBroker.ComputeDirectoryTreeHash(hostDirectory));
        await File.WriteAllTextAsync(
            dependency,
            "changed-code",
            TestContext.Current.CancellationToken);
        Assert.NotEqual(original, CanvasHostBroker.ComputeDirectoryTreeHash(hostDirectory));
    }

    [Fact]
    public void StandaloneCanvasShellDoesNotLoadPinnedWindowXamlOrTabView()
    {
        var repoRoot = FindRepoRoot();
        var project = File.ReadAllText(
            Path.Combine(
                repoRoot,
                "windows-node-canvas-host",
                "MicroClaw.WindowsNodeCanvasHost.csproj"));
        var compatibilityShell = File.ReadAllText(
            Path.Combine(
                repoRoot,
                "windows-node-canvas-host",
                "A2UICanvasWindow.Compatibility.cs"));
        var projectXml = System.Xml.Linq.XDocument.Parse(project);
        Assert.DoesNotContain(
            projectXml.Descendants().Where(element => element.Name.LocalName == "Page"),
            element => element.Attribute("Include")?.Value.EndsWith(
                "A2UICanvasWindow.xaml",
                StringComparison.OrdinalIgnoreCase) == true);
        Assert.Contains("void InitializeComponent()", compatibilityShell);
        Assert.Contains("private StandaloneTabView MultiSurfaceTabs", compatibilityShell);
        Assert.Contains("internal sealed class TabViewItem : StackPanel", compatibilityShell);
        Assert.DoesNotContain("Microsoft.UI.Xaml.Controls.TabView", compatibilityShell);
    }

    [Theory]
    [InlineData("""{"url":"file:///C:/secret.txt"}""")]
    [InlineData("""{"target":"https://example.com"}""")]
    [InlineData("""{"html":"<h1>unsafe</h1>"}""")]
    [InlineData("""{"path":"C:\\secret.txt"}""")]
    public void PresentRejectsNavigationAndLocalContent(string json)
    {
        var error = Assert.Throws<HostPolicyException>(
            () => CanvasPhase1Policy.ValidateCommand("canvas.present", Parse(json)));
        Assert.Equal("canvas-present-trusted-origin-only", error.Code);
    }

    [Theory]
    [InlineData("file:///C:/secret.png")]
    [InlineData("\\\\server\\share\\secret.png")]
    [InlineData("C:\\secret.png")]
    [InlineData("../secret.png")]
    [InlineData("javascript:alert(1)")]
    [InlineData("data:text/html,unsafe")]
    [InlineData("ftp://example.com/image.png")]
    [InlineData("https://example.com/image.png")]
    public void A2uiRejectsUnapprovedMediaReferences(string reference)
    {
        var jsonl = JsonSerializer.Serialize(new
        {
            surfaceUpdate = new
            {
                surfaceId = "main",
                components = new[] { new { id = "image", component = new { Image = new { url = reference } } } },
            },
        });
        var args = Parse(JsonSerializer.Serialize(new { jsonl }));
        var error = Assert.Throws<HostPolicyException>(
            () => CanvasPhase1Policy.ValidateCommand("canvas.a2ui.push", args));
        Assert.True(
            new[]
            {
                "canvas-local-file-denied",
                "canvas-media-scheme-denied",
                "canvas-media-host-not-allowed",
            }.Contains(error.Code),
            error.Code);
    }

    [Fact]
    public void A2uiAllowsBoundedInlineImageButRejectsJsonlPath()
    {
        var jsonl = """{"surfaceUpdate":{"surfaceId":"main","components":[{"id":"image","component":{"Image":{"url":{"literalString":"data:image/png;base64,AA=="}}}},{"id":"text","component":{"Text":{"text":{"path":"/title"}}}}]}}""";
        CanvasPhase1Policy.ValidateCommand(
            "canvas.a2ui.pushJSONL",
            Parse(JsonSerializer.Serialize(new { jsonl })));
        var error = Assert.Throws<HostPolicyException>(
            () => CanvasPhase1Policy.ValidateCommand(
                "canvas.a2ui.push",
                Parse("""{"jsonlPath":"C:\\payload.jsonl"}""")));
        Assert.Equal("canvas-local-file-denied", error.Code);
    }

    [Theory]
    [InlineData("data:image/svg+xml;base64,PHN2Zy8+")]
    [InlineData("data:image/png-evil;base64,AA==")]
    [InlineData("data:image/png,raw")]
    public void A2uiRejectsUnapprovedInlineImageForms(string reference)
    {
        var jsonl = JsonSerializer.Serialize(new
        {
            surfaceUpdate = new
            {
                surfaceId = "main",
                components = new[]
                {
                    new
                    {
                        id = "image",
                        component = new
                        {
                            Image = new
                            {
                                url = new { literalString = reference },
                            },
                        },
                    },
                },
            },
        });
        var error = Assert.Throws<HostPolicyException>(
            () => CanvasPhase1Policy.ValidateCommand(
                "canvas.a2ui.push",
                Parse(JsonSerializer.Serialize(new { jsonl }))));
        Assert.Equal("canvas-media-scheme-denied", error.Code);
    }

    [Fact]
    public void A2uiRejectsDataModelBoundMedia()
    {
        var jsonl = """{"surfaceUpdate":{"surfaceId":"main","components":[{"id":"image","component":{"Image":{"url":{"path":"/image"}}}}]}}""";
        var error = Assert.Throws<HostPolicyException>(
            () => CanvasPhase1Policy.ValidateCommand(
                "canvas.a2ui.push",
                Parse(JsonSerializer.Serialize(new { jsonl }))));
        Assert.Equal("canvas-media-binding-denied", error.Code);
    }

    [Theory]
    [InlineData("click")]
    [InlineData("submit")]
    [InlineData("confirm")]
    [InlineData("cancel")]
    public void ReviewedActionsAreAllowed(string action) =>
        CanvasPhase1Policy.ValidateAction(action);

    [Theory]
    [InlineData("system.run")]
    [InlineData("read")]
    [InlineData("write")]
    [InlineData("gateway.config.set")]
    [InlineData("cron.add")]
    [InlineData("hooks.run")]
    [InlineData("plugin.install")]
    [InlineData("canvas.eval")]
    public void DangerousActionsAreRejected(string action)
    {
        var error = Assert.Throws<HostPolicyException>(
            () => CanvasPhase1Policy.ValidateAction(action));
        Assert.Equal("canvas-action-denied", error.Code);
    }

    [Fact]
    public async Task DiagnosticLeaseRejectsBeforeCanvasHostLaunch()
    {
        var leasePath = Path.Combine(_root, "lease.json");
        var secret = Convert.ToBase64String(RandomNumberGenerator.GetBytes(32));
        const string generation = "gateway-generation";
        var fingerprint = new string('a', 64);
        var expiresAt = DateTimeOffset.UtcNow.AddMinutes(1).ToUnixTimeMilliseconds();
        await File.WriteAllTextAsync(
            leasePath,
            JsonSerializer.Serialize(new
            {
                contract = ActivationLeaseContract.Version,
                mode = "diagnostic",
                gatewayGeneration = generation,
                policyFingerprint = fingerprint,
                expiresAtUnixMs = expiresAt,
                signature = ActivationLeaseGuard.ComputeSignature(
                    secret,
                    ActivationLeaseMode.Diagnostic,
                    generation,
                    fingerprint,
                    expiresAt),
            }),
            TestContext.Current.CancellationToken);
        var guard = new ActivationLeaseGuard(leasePath, secret, generation, fingerprint);
        var policy = new HostPolicy
        {
            ApprovedRoots = [],
            DeniedRoots = [],
            WxcExecPath = Path.Combine(Environment.SystemDirectory, "hostname.exe"),
            NetworkAllowed = true,
            AllowWindowsUi = true,
            StrictNoHostFallback = true,
            Canvas = new CanvasHostPolicy(
                Path.Combine(_root, "missing-canvas-host.exe"),
                new string('0', 64),
                new string('1', 64),
                CanvasPhase1Policy.Commands,
                CanvasPhase1Policy.Actions),
        };
        using var broker = new CanvasHostBroker(
            policy,
            leasePath,
            secret,
            generation,
            fingerprint,
            new string('b', 64),
            "en-US",
            guard,
            _ => Task.FromResult(true));
        var capability = new BundledCanvasCapability(broker, guard);

        var response = await capability.ExecuteAsync(
            new NodeInvokeRequest
            {
                Command = "canvas.present",
                Args = Parse("{}"),
            },
            TestContext.Current.CancellationToken);

        Assert.False(response.Ok);
        Assert.Contains("activation-lease-active-required", response.Error);
        Assert.False(File.Exists(policy.Canvas.HostPath));
    }

    private static JsonElement Parse(string json) => JsonDocument.Parse(json).RootElement.Clone();

    private static string FindRepoRoot()
    {
        for (var current = new DirectoryInfo(AppContext.BaseDirectory);
             current != null;
             current = current.Parent)
        {
            if ((Directory.Exists(Path.Combine(current.FullName, ".git"))
                    || File.Exists(Path.Combine(current.FullName, ".git")))
                && Directory.Exists(Path.Combine(current.FullName, "windows-node-canvas-host")))
            {
                return current.FullName;
            }
        }

        throw new DirectoryNotFoundException("Could not locate the MicroClaw repository root.");
    }

    public void Dispose()
    {
        if (Directory.Exists(_root)) Directory.Delete(_root, recursive: true);
    }
}
