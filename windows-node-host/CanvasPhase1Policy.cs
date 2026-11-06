using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace MicroClaw.WindowsNodeHost;

public static class CanvasPhase1Policy
{
    public const string Contract = "microclaw.windows-node-mxc.canvas.v1";
    public const string Renderer = "native-a2ui";
    public static readonly IReadOnlyList<string> Commands =
    [
        "canvas.present",
        "canvas.hide",
        "canvas.snapshot",
        "canvas.caps",
        "canvas.a2ui.push",
        "canvas.a2ui.pushJSONL",
        "canvas.a2ui.reset",
        "canvas.a2ui.dump",
    ];
    public static readonly IReadOnlyList<string> Actions =
    [
        "cancel",
        "click",
        "confirm",
        "submit",
    ];

    public static void ValidateCommand(string command, JsonElement args)
    {
        if (!Commands.Contains(command, StringComparer.Ordinal))
            throw new HostPolicyException(
                "canvas-command-denied",
                "Canvas command is outside the reviewed Phase 1 allowlist.");
        switch (command)
        {
            case "canvas.present":
                ValidatePresent(args);
                break;
            case "canvas.a2ui.push":
            case "canvas.a2ui.pushJSONL":
                ValidateInlineJsonl(args);
                break;
            case "canvas.snapshot":
                ValidateSnapshot(args);
                break;
        }
    }

    public static void ValidateAction(string action)
    {
        if (!Actions.Contains(action, StringComparer.Ordinal))
            throw new HostPolicyException(
                "canvas-action-denied",
                "Canvas action is outside the reviewed Phase 1 allowlist.");
    }

    private static void ValidatePresent(JsonElement args)
    {
        if (args.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null) return;
        if (args.ValueKind != JsonValueKind.Object)
            throw new HostPolicyException(
                "canvas-present-invalid",
                "Canvas present parameters must be an object.");
        if (args.EnumerateObject().Any())
            throw new HostPolicyException(
                "canvas-present-trusted-origin-only",
                "Phase 1 present opens only the managed native A2UI shell.");
    }

    private static void ValidateInlineJsonl(JsonElement args)
    {
        if (args.ValueKind != JsonValueKind.Object)
            throw new HostPolicyException(
                "canvas-a2ui-invalid",
                "A2UI parameters must be an object.");
        if (args.TryGetProperty("jsonlPath", out _))
            throw new HostPolicyException(
                "canvas-local-file-denied",
                "Phase 1 rejects local A2UI files.");
        if (!args.TryGetProperty("jsonl", out var value) || value.ValueKind != JsonValueKind.String)
            throw new HostPolicyException("canvas-a2ui-invalid", "Inline jsonl is required.");
        var jsonl = value.GetString() ?? string.Empty;
        if (Encoding.UTF8.GetByteCount(jsonl) > 4 * 1024 * 1024)
            throw new HostPolicyException("canvas-a2ui-too-large", "A2UI JSONL is too large.");
        var lines = jsonl.Split(['\r', '\n'], StringSplitOptions.RemoveEmptyEntries);
        if (lines.Length > 4096)
            throw new HostPolicyException("canvas-a2ui-too-many-lines", "A2UI JSONL has too many lines.");
        foreach (var line in lines)
        {
            JsonNode node;
            try { node = JsonNode.Parse(line) ?? throw new JsonException(); }
            catch (JsonException)
            {
                throw new HostPolicyException("canvas-a2ui-invalid", "A2UI JSONL contains invalid JSON.");
            }
            ValidateNode(node);
        }
    }

    private static void ValidateSnapshot(JsonElement args)
    {
        if (args.ValueKind is JsonValueKind.Undefined or JsonValueKind.Null) return;
        if (args.ValueKind != JsonValueKind.Object)
            throw new HostPolicyException(
                "canvas-snapshot-invalid",
                "Canvas snapshot parameters must be an object.");
        foreach (var property in args.EnumerateObject())
        {
            if (property.Name != "format")
                throw new HostPolicyException(
                    "canvas-snapshot-invalid",
                    "Canvas snapshot accepts only a format.");
            var format = property.Value.ValueKind == JsonValueKind.String
                ? property.Value.GetString()?.ToLowerInvariant()
                : null;
            if (format is not ("png" or "jpeg" or "jpg"))
                throw new HostPolicyException(
                    "canvas-snapshot-format",
                    "Canvas snapshot supports png or jpeg only.");
        }
    }

    private static void ValidateNode(JsonNode node)
    {
        switch (node)
        {
            case JsonObject obj:
                foreach (var (name, value) in obj)
                {
                    if (value is null) continue;
                    if (IsMediaProperty(name)) ValidateMediaValue(value);
                    else ValidateNode(value);
                }
                break;
            case JsonArray array:
                foreach (var value in array)
                    if (value is not null) ValidateNode(value);
                break;
        }
    }

    private static bool IsMediaProperty(string name) =>
        name.Equals("url", StringComparison.OrdinalIgnoreCase)
        || name.Equals("src", StringComparison.OrdinalIgnoreCase)
        || name.Equals("uri", StringComparison.OrdinalIgnoreCase);

    private static void ValidateMediaValue(JsonNode node)
    {
        if (node is JsonValue direct && direct.TryGetValue<string>(out var directText))
        {
            ValidateMediaReference(directText);
            return;
        }
        if (node is JsonObject value)
        {
            if (value["path"] is not null)
                throw new HostPolicyException(
                    "canvas-media-binding-denied",
                    "Phase 1 Canvas media must use a bounded inline literal.");
            if (value["literalString"] is JsonValue literal
                && literal.TryGetValue<string>(out var literalText))
            {
                ValidateMediaReference(literalText);
                return;
            }
        }
        throw new HostPolicyException(
            "canvas-media-reference-denied",
            "Canvas media reference is not approved.");
    }

    private static void ValidateMediaReference(string value)
    {
        var trimmed = value.Trim();
        if (IsApprovedInlineImage(trimmed)) return;
        if (Uri.TryCreate(trimmed, UriKind.Absolute, out var uri))
        {
            var code = uri.Scheme.Equals(Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)
                ? "canvas-media-host-not-allowed"
                : "canvas-media-scheme-denied";
            throw new HostPolicyException(code, "Canvas media reference is not approved.");
        }
        throw new HostPolicyException(
            "canvas-local-file-denied",
            "Local and relative Canvas media references are denied.");
    }

    private static bool IsApprovedInlineImage(string value)
    {
        if (!value.StartsWith("data:", StringComparison.OrdinalIgnoreCase)) return false;
        var comma = value.IndexOf(',');
        if (comma < 0) return false;
        var metadata = value[5..comma].Split(';', StringSplitOptions.RemoveEmptyEntries);
        if (metadata.Length < 2 || !metadata.Skip(1).Contains("base64", StringComparer.OrdinalIgnoreCase))
            return false;
        return metadata[0].Equals("image/png", StringComparison.OrdinalIgnoreCase)
            || metadata[0].Equals("image/jpeg", StringComparison.OrdinalIgnoreCase)
            || metadata[0].Equals("image/webp", StringComparison.OrdinalIgnoreCase);
    }
}
