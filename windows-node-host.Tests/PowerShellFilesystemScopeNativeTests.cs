using MicroClaw.WindowsNodeHost;
using OpenClaw.Shared.Mxc;
using System.Security.AccessControl;
using System.Security.Cryptography;
using System.Text.Json;
using Xunit;

namespace MicroClaw.WindowsNodeHost.Tests;

public sealed class PowerShellFilesystemScopeNativeTests
{
    public static bool NativeAvailable => CwdPolicyTests.NativeMxcAvailable;

    [Fact(SkipUnless = nameof(NativeAvailable), Skip = "Requires a verified native SDK and isolated test scratch.")]
    public async Task FullContainmentCreatesUpdatesAndDeletesAcrossContainersWithoutBroadeningGrants()
    {
        var runtime = Environment.GetEnvironmentVariable("MICROCLAW_MXC_NATIVE_TEST_RUNTIME")!;
        var root = Directory.CreateDirectory(Path.Combine(
            Environment.GetEnvironmentVariable("MICROCLAW_MXC_NATIVE_TEST_SCRATCH")!,
            "full-provider-" + Guid.NewGuid().ToString("N"))).FullName;
        var rw = Directory.CreateDirectory(Path.Combine(root, "rw")).FullName;
        var ro = Directory.CreateDirectory(Path.Combine(root, "ro")).FullName;
        var sibling = Directory.CreateDirectory(Path.Combine(root, "outside")).FullName;
        var file = Path.Combine(rw, "owned.txt");
        var protectedFile = Path.Combine(ro, "protected.txt");
        await File.WriteAllTextAsync(protectedFile, "preserve", TestContext.Current.CancellationToken);
        var executable = Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
        var policy = new HostPolicy
        {
            ApprovedRoots = [new(rw, FolderAccess.ReadWrite), new(ro, FolderAccess.ReadOnly)],
            DeniedRoots = [], WxcExecPath = runtime,
            Canvas = new CanvasHostPolicy(executable, new string('0', 64), new string('1', 64),
                CanvasPhase1Policy.Commands, CanvasPhase1Policy.Actions),
            RequestedStrength = "full", EffectiveTier = "base-container", NetworkAllowed = false,
        };
        async Task Run(string script, bool prepare = false)
        {
            var request = new BundledSystemCapability.RunRequest(
                [executable, "-NoProfile", "-NonInteractive", "-Command", script],
                rw, 20_000, "main", "test", script, null, [new("rw", rw)]);
            if (prepare)
            {
                request = PowerShellFilesystemScope.Prepare(request, policy);
                Assert.NotNull(request.ProviderInitialization);
            }
            var config = BundledSystemCapability.BuildMxcConfig(policy, executable,
                request.Argv.Skip(1).ToArray(), rw, rw, 20_000);
            var configPath = Path.Combine(root, "config.json");
            await File.WriteAllTextAsync(configPath,
                BundledSystemCapability.SerializeMxcConfig(config, allowDaclMutation: false),
                TestContext.Current.CancellationToken);
            var result = await new MxcExecutor(runtime).RunWithConfigFileAsync(
                configPath, TestContext.Current.CancellationToken, workingDirectory: rw);
            Assert.True(result.Success, $"Contained command failed: {result.ExitCode}; {result.Error}; {result.Output}");
            Assert.Equal(0, result.ExitCode);
        }
        try
        {
            await Run($"[IO.File]::WriteAllText('{file}', 'first')");
            Assert.Equal("first", await File.ReadAllTextAsync(file, TestContext.Current.CancellationToken));
            await Run($"[IO.File]::WriteAllText('{file}', 'updated')");
            Assert.Equal("updated", await File.ReadAllTextAsync(file, TestContext.Current.CancellationToken));
            await Run($"Remove-Item -Path '{file}' -Force", prepare: true);
            Assert.False(File.Exists(file));
            const string denied = "catch { if ($_.Exception.InnerException -isnot [UnauthorizedAccessException]) { throw } };";
            await Run($"try {{ [IO.File]::Delete('{protectedFile}'); exit 90 }} " + denied +
                $"try {{ [IO.File]::WriteAllText('{protectedFile}', 'no'); exit 91 }} " + denied +
                $"try {{ [IO.File]::WriteAllText('{sibling}\\forbidden.txt', 'no'); exit 92 }} " + denied + "exit 0");
            Assert.Equal("preserve", await File.ReadAllTextAsync(protectedFile, TestContext.Current.CancellationToken));
            Assert.False(File.Exists(Path.Combine(sibling, "forbidden.txt")));
        }
        finally { Directory.Delete(root, recursive: true); }
    }

    [Fact(SkipUnless = nameof(NativeAvailable), Skip = "Requires a verified native SDK and isolated test scratch.")]
    public async Task ScopedProviderPreservesReadOnlyAndUngrantSiblingDenials()
    {
        var runtime = Environment.GetEnvironmentVariable("MICROCLAW_MXC_NATIVE_TEST_RUNTIME")!;
        var root = Directory.CreateDirectory(Path.Combine(
            Environment.GetEnvironmentVariable("MICROCLAW_MXC_NATIVE_TEST_SCRATCH")!,
            "native-scope-denials-" + Guid.NewGuid().ToString("N"))).FullName;
        var rw = Directory.CreateDirectory(Path.Combine(root, "rw")).FullName;
        var ro = Directory.CreateDirectory(Path.Combine(root, "ro")).FullName;
        var roChild = Directory.CreateDirectory(Path.Combine(ro, "child")).FullName;
        var sibling = Directory.CreateDirectory(Path.Combine(root, "ungranted-sibling")).FullName;
        var scratch = Directory.CreateDirectory(Path.Combine(root, "scratch")).FullName;
        var state = Directory.CreateDirectory(Path.Combine(root, "sdk-state")).FullName;
        var roFile = Path.Combine(ro, "marker.txt");
        var siblingFile = Path.Combine(sibling, "marker.txt");
        await File.WriteAllTextAsync(roFile, "read-only-marker", TestContext.Current.CancellationToken);
        await File.WriteAllTextAsync(siblingFile, "ungranted-marker", TestContext.Current.CancellationToken);
        var ancestors = new Dictionary<string, string>();
        for (var directory = Directory.GetParent(root); directory is not null; directory = directory.Parent)
            ancestors[directory.FullName] = Convert.ToHexString(SHA256.HashData(
                directory.GetAccessControl(AccessControlSections.Access).GetSecurityDescriptorBinaryForm()));
        using var environment = ProcessEnvironmentOverride.Apply(
            new Dictionary<string, string> { ["MXC_DACL_STATE_DIR"] = state });
        var executable = Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe");
        var pidPath = Path.Combine(scratch, "child.pid");
        var releasePath = Path.Combine(scratch, "release");
        var probeAssembly = Path.Combine(scratch, "DeleteDenialProbe.dll");
        var probeSource = """
            using System.Runtime.InteropServices;
            public static class DeleteDenialProbe {
              [DllImport("kernel32.dll", EntryPoint="RemoveDirectoryW", CharSet=CharSet.Unicode, SetLastError=true)]
              private static extern bool RemoveDirectory(string path);
              public static int ErrorCode(string path) {
                return RemoveDirectory(path) ? 0 : Marshal.GetLastWin32Error();
              }
            }
            """;
        var compiler = new System.Diagnostics.ProcessStartInfo(executable)
        {
            UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true,
        };
        compiler.ArgumentList.Add("-NoProfile");
        compiler.ArgumentList.Add("-Command");
        compiler.ArgumentList.Add($"Add-Type -TypeDefinition '{probeSource}' -OutputAssembly '{probeAssembly}' -ErrorAction Stop");
        using (var process = System.Diagnostics.Process.Start(compiler)!)
        {
            var output = process.StandardOutput.ReadToEndAsync(TestContext.Current.CancellationToken);
            var error = process.StandardError.ReadToEndAsync(TestContext.Current.CancellationToken);
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(TestContext.Current.CancellationToken);
            timeout.CancelAfter(TimeSpan.FromSeconds(15));
            try { await process.WaitForExitAsync(timeout.Token); }
            catch (OperationCanceledException) { process.Kill(entireProcessTree: true); throw; }
            Assert.Equal(0, process.ExitCode);
            Assert.Empty(await error);
            Assert.Empty(await output);
        }
        var script = PowerShellFilesystemScope.Initializer + $$"""
            Add-Type -Path '{{probeAssembly}}' -ErrorAction Stop;
            [IO.File]::WriteAllText('{{pidPath}}', [string]$PID);
            $deadline=[DateTime]::UtcNow.AddSeconds(10);
            while(-not [IO.File]::Exists('{{releasePath}}') -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 20 }
            $script:unexpected=0;
            function Assert-Denied($operation) {
              try { & $operation; $script:unexpected++ }
              catch {
                $e=$_.Exception; while($e.InnerException) { $e=$e.InnerException }
                if($e.HResult -ne -2147024891 -and
                  -not ($e -is [ComponentModel.Win32Exception] -and $e.NativeErrorCode -eq 5)) {
                  throw ('Unexpected denial exception type=' + $e.GetType().FullName + '; hresult=' + $e.HResult)
                }
              }
            }
            if([IO.File]::ReadAllText('{{roFile}}') -ne 'read-only-marker') { exit 90 }
            Assert-Denied { [IO.File]::WriteAllText('{{roFile}}', 'must-not-write') };
            if([DeleteDenialProbe]::ErrorCode('{{roChild}}') -ne 5) { exit 92 };
            Assert-Denied { [IO.File]::ReadAllText('{{siblingFile}}') | Out-Null };
            Assert-Denied { [IO.File]::WriteAllText('{{sibling}}\must-not-exist', 'must-not-write') };
            if([DeleteDenialProbe]::ErrorCode('{{sibling}}') -ne 5) { exit 93 };
            if($script:unexpected -ne 0) { exit 91 }
            """;
        var policy = new HostPolicy
        {
            ApprovedRoots = [new ApprovedRoot(rw, FolderAccess.ReadWrite), new ApprovedRoot(ro, FolderAccess.ReadOnly)],
            DeniedRoots = [], WxcExecPath = runtime,
            Canvas = new CanvasHostPolicy(executable, new string('0', 64), new string('1', 64),
                CanvasPhase1Policy.Commands, CanvasPhase1Policy.Actions),
            RequestedStrength = "limited-dacl", EffectiveTier = "appcontainer-dacl", NetworkAllowed = false,
        };
        using var lease = DirectoryPathLease.Acquire([rw, ro, scratch]);
        var config = BundledSystemCapability.BuildMxcConfig(
            policy, executable, ["-NoProfile", "-NonInteractive", "-Command", script], scratch, scratch, 20_000);
        var configurationPath = Path.Combine(scratch, "config.json");
        await File.WriteAllTextAsync(configurationPath,
            BundledSystemCapability.SerializeMxcConfig(config, allowDaclMutation: true),
            TestContext.Current.CancellationToken);
        var controlsPassed = false;
        try
        {
            var execution = new MxcExecutor(runtime).RunWithConfigFileAsync(
                configurationPath, TestContext.Current.CancellationToken, workingDirectory: scratch);
            NativeProbeToken? token = null;
            try
            {
                var deadline = DateTime.UtcNow.AddSeconds(10);
                while (!File.Exists(pidPath) && !execution.IsCompleted && DateTime.UtcNow < deadline)
                    await Task.Delay(20, TestContext.Current.CancellationToken);
                Assert.True(File.Exists(pidPath), "The contained child must reach the token inspection barrier");
                token = NativeProbeToken.Inspect(int.Parse(
                    await File.ReadAllTextAsync(pidPath, TestContext.Current.CancellationToken)), executable);
            }
            finally { await File.WriteAllTextAsync(releasePath, "release", TestContext.Current.CancellationToken); }
            var result = await execution;
            Assert.NotNull(token);
            Assert.True(token.IsAppContainer && token.ImageMatches);
            Assert.Equal(NativeProbeToken.ContainerSid(config.ContainerId!), token.AppContainerSid);
            Assert.Equal("S-1-16-4096", token.IntegritySid);
            Assert.True(result.Success, $"Scoped denial controls failed: exit={result.ExitCode}; {result.Error}");
            Assert.Equal(0, result.ExitCode);
            Assert.Equal("read-only-marker", await File.ReadAllTextAsync(roFile, TestContext.Current.CancellationToken));
            Assert.Equal("ungranted-marker", await File.ReadAllTextAsync(siblingFile, TestContext.Current.CancellationToken));
            Assert.True(Directory.Exists(roChild) && Directory.Exists(sibling));
            Assert.False(File.Exists(Path.Combine(sibling, "must-not-exist")));
            controlsPassed = true;
        }
        finally
        {
            Assert.Empty(Directory.EnumerateFiles(state, "*", SearchOption.AllDirectories));
            foreach (var (path, before) in ancestors)
                Assert.Equal(before, Convert.ToHexString(SHA256.HashData(new DirectoryInfo(path)
                    .GetAccessControl(AccessControlSections.Access).GetSecurityDescriptorBinaryForm())));
            var evidencePath = Environment.GetEnvironmentVariable("MICROCLAW_MXC_NATIVE_TEST_EVIDENCE");
            if (!string.IsNullOrEmpty(evidencePath))
                await File.WriteAllTextAsync(evidencePath, JsonSerializer.Serialize(new
                {
                    controlsPassed, deniedOperations = controlsPassed ? 5 : 0,
                    ancestorCount = ancestors.Count, privateStateEmpty = true,
                }), TestContext.Current.CancellationToken);
            lease.Dispose();
            Directory.Delete(root, recursive: true);
        }
    }
}
