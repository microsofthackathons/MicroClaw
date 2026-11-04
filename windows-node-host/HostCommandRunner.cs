using System.ComponentModel;
using System.Diagnostics;
using System.Text;
using OpenClaw.Shared;

namespace MicroClaw.WindowsNodeHost;

internal static class HostCommandRunner
{
    public static Task<CommandResult> RunAsync(CommandRequest request, CancellationToken cancellationToken)
    {
        var argv = request.Argv;
        if (argv is { Count: 5 }
            && string.Equals(Path.GetFileName(argv[0]), "cmd.exe", StringComparison.OrdinalIgnoreCase)
            && string.Equals(argv[1], "/d", StringComparison.OrdinalIgnoreCase)
            && string.Equals(argv[2], "/s", StringComparison.OrdinalIgnoreCase)
            && string.Equals(argv[3], "/c", StringComparison.OrdinalIgnoreCase))
            return RunCanonicalCmdAsync(request, argv, cancellationToken);

        return new LocalCommandRunner().RunAsync(request, cancellationToken);
    }

    private static Task<CommandResult> RunCanonicalCmdAsync(
        CommandRequest request, IReadOnlyList<string> argv, CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!Path.IsPathFullyQualified(argv[0]))
            throw new HostPolicyException("executable-path-invalid", "The approved CMD executable must be an absolute path.");
        if (argv[4].Contains('\0'))
            throw new HostPolicyException("argv-invalid", "A command cannot contain a NUL character.");

        var startInfo = new ProcessStartInfo
        {
            FileName = argv[0],
            // CMD parses /S /C itself; ProcessStartInfo.ArgumentList uses Win32 argv quoting instead.
            Arguments = $"{argv[1]} {argv[2]} {argv[3]} \"{argv[4]}\"",
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        if (!string.IsNullOrEmpty(request.Cwd)) startInfo.WorkingDirectory = request.Cwd;
        if (request.Env is not null)
            foreach (var (key, value) in request.Env) startInfo.Environment[key] = value;

        return ChildProcessCapture.RunAsync(startInfo, request.TimeoutMs, cancellationToken);
    }
}

internal static class ChildProcessCapture
{
    internal static async Task<CommandResult> RunAsync(
        ProcessStartInfo startInfo,
        int timeoutMs,
        CancellationToken cancellationToken,
        int? outputLimit = null,
        bool returnCancelledResult = false,
        bool trimOutput = false)
    {
        cancellationToken.ThrowIfCancellationRequested();
        using var process = new Process { StartInfo = startInfo, EnableRaisingEvents = true };
        var exited = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var stdoutClosed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var stderrClosed = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
        var stdout = new StringBuilder();
        var stderr = new StringBuilder();
        var gate = new object();
        process.Exited += (_, _) => exited.TrySetResult();
        process.OutputDataReceived += (_, e) =>
        {
            if (e.Data is null) stdoutClosed.TrySetResult();
            else lock (gate) Append(stdout, e.Data, outputLimit);
        };
        process.ErrorDataReceived += (_, e) =>
        {
            if (e.Data is null) stderrClosed.TrySetResult();
            else lock (gate) Append(stderr, e.Data, outputLimit);
        };

        var timer = Stopwatch.StartNew();
        process.Start();
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();
        if (process.HasExited) exited.TrySetResult();
        var timedOut = false;
        var cancelled = false;
        try
        {
            using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            if (timeoutMs > 0) timeout.CancelAfter(timeoutMs);
            try
            {
                await exited.Task.WaitAsync(timeout.Token);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                timedOut = true;
                StopProcess(process);
                await exited.Task.WaitAsync(TimeSpan.FromSeconds(5), CancellationToken.None);
            }
        }
        catch (OperationCanceledException) when (returnCancelledResult && cancellationToken.IsCancellationRequested)
        {
            cancelled = true;
            StopProcess(process);
            await exited.Task.WaitAsync(TimeSpan.FromSeconds(5), CancellationToken.None);
        }
        catch (OperationCanceledException)
        {
            StopProcess(process);
            throw;
        }

        var drain = Task.WhenAll(stdoutClosed.Task, stderrClosed.Task);
        if (await Task.WhenAny(drain, Task.Delay(500, CancellationToken.None)) != drain)
            Console.Error.WriteLine("[host-command] Output drain timed out; a child process may hold a pipe open.");

        lock (gate)
            return new CommandResult
            {
                Stdout = Capture(stdout, outputLimit, trimOutput),
                Stderr = cancelled ? "Execution was cancelled." : Capture(stderr, outputLimit, trimOutput),
                ExitCode = timedOut || cancelled ? -1 : process.ExitCode,
                TimedOut = timedOut || cancelled,
                DurationMs = timer.ElapsedMilliseconds,
            };
    }

    private static void Append(StringBuilder builder, string value, int? limit)
    {
        if (limit is null || builder.Length < limit.Value * 2) builder.AppendLine(value);
    }

    private static string Capture(StringBuilder builder, int? limit, bool trim)
    {
        var text = trim ? builder.ToString().Trim() : builder.ToString().TrimEnd();
        return limit is not null && text.Length > limit.Value
            ? text[..limit.Value] + $"\n\n... [TRUNCATED \u2014 showing first {limit.Value} of {text.Length} chars]"
            : text;
    }

    private static void StopProcess(Process process)
    {
        try
        {
            if (!process.HasExited) process.Kill(entireProcessTree: true);
        }
        catch (InvalidOperationException) when (process.HasExited) { }
        catch (Win32Exception) when (process.HasExited) { }
    }
}
