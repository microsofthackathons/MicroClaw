namespace MicroClaw.WindowsNodeHost.Tests;

internal sealed class ProcessEnvironmentOverride : IDisposable
{
    private readonly IReadOnlyDictionary<string, string?> _original;

    private ProcessEnvironmentOverride(IReadOnlyDictionary<string, string?> original)
    {
        _original = original;
    }

    public static ProcessEnvironmentOverride Apply(IReadOnlyDictionary<string, string> values)
    {
        var original = values.Keys.ToDictionary(
            key => key, Environment.GetEnvironmentVariable, StringComparer.OrdinalIgnoreCase);
        foreach (var (key, value) in values)
            Environment.SetEnvironmentVariable(key, value);
        return new ProcessEnvironmentOverride(original);
    }

    public void Dispose()
    {
        foreach (var (key, value) in _original)
            Environment.SetEnvironmentVariable(key, value);
    }
}
