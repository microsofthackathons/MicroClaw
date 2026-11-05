namespace MicroClaw.WindowsNodeHost;

internal static class MxcCmdSerializer
{
    internal static IReadOnlyList<string> ForContainer(IReadOnlyList<string> argv)
    {
        if (argv.Count != 5
            || !IsSystemCmd(argv[0])
            || !string.Equals(argv[1], "/d", StringComparison.OrdinalIgnoreCase)
            || !string.Equals(argv[2], "/s", StringComparison.OrdinalIgnoreCase)
            || !string.Equals(argv[3], "/c", StringComparison.OrdinalIgnoreCase))
            return argv;

        var payload = argv[4];
        if (string.IsNullOrWhiteSpace(payload)
            || payload.TrimEnd(' ', '\t').EndsWith('\\')
            || payload.Any(ch =>
                ch is '"' or '&' or '|' or '<' or '>' or '^' or '%' or '!' or '(' or ')'
                || (char.IsControl(ch) && ch != '\t')
                || (char.IsWhiteSpace(ch) && ch is not (' ' or '\t'))))
            return argv;

        var start = 0;
        while (start < payload.Length && payload[start] is ' ' or '\t') start++;
        var end = start;
        while (end < payload.Length && payload[end] is not (' ' or '\t')) end++;
        var executable = payload[start..end];
        if (!Path.IsPathFullyQualified(executable)
            || !Path.GetExtension(executable).Equals(".exe", StringComparison.OrdinalIgnoreCase)
            || executable.IndexOfAny([',', ';', '=']) >= 0
            || !File.Exists(executable))
            return argv;

        // Quoting only a static, already-pinned executable preserves the approved
        // command while allowing CMD to start absolute paths in MXC containers.
        var result = argv.ToArray();
        result[4] = payload[..start] + "\"" + executable + "\"" + payload[end..];
        return result;
    }

    internal static bool IsSystemCmd(string executable) =>
        new[]
        {
            Environment.GetFolderPath(Environment.SpecialFolder.System),
            Environment.GetFolderPath(Environment.SpecialFolder.SystemX86),
        }.Where(directory => !string.IsNullOrEmpty(directory))
         .Any(directory => string.Equals(
             executable, Path.Combine(directory, "cmd.exe"), StringComparison.OrdinalIgnoreCase));
}
