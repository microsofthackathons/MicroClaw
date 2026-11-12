using OpenClaw.Shared.Commands;

namespace MicroClaw.WindowsNodeHost;

internal static class MxcCmdTransport
{
    internal static IReadOnlyList<string> Prepare(IReadOnlyList<string> argv)
    {
        if (argv.Count != 5
            || !CanonicalCmdCarrier.TryGetTrustedCanonicalPayload(argv, out var payload)
            || !CmdPayloadTokenizer.TryTokenize(payload, out var tokens, out var spans)
            || tokens.Count == 0
            || !Path.IsPathFullyQualified(tokens[0])
            || !CmdPayloadTokenizer.IsSafelyRepresentableToken(tokens[0]))
        {
            return argv;
        }

        // MXC can reject an unquoted absolute child image in cmd's /s /c payload.
        // Only quote a token proven free of cmd syntax; preserve the approved tail.
        var executable = spans[0];
        var result = argv.ToArray();
        result[4] = payload[..executable.Start] + "\"" +
            payload[executable.Start..executable.End] + "\"" + payload[executable.End..];
        return result;
    }
}
