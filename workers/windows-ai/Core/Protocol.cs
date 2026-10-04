using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace Lumen.WindowsAi;

internal static class Protocol
{
    public const int MaximumLineBytes = 6 * 1024 * 1024;
    public const int MaximumImageBytes = 4 * 1024 * 1024;
    public const int MaximumTextBytes = 64 * 1024;
    public const int MaximumResponseBytes = 256 * 1024;
    public static bool IsRequestId(string? value) => value is not null && Regex.IsMatch(value, "\\A[A-Za-z0-9._:-]{1,80}\\z");
    public static bool IsBoundedText(string? value, int maximum) => value is not null && !string.IsNullOrWhiteSpace(value) && Encoding.UTF8.GetByteCount(value) <= maximum;

    public static Request Parse(string line)
    {
        if (Encoding.UTF8.GetByteCount(line) > MaximumLineBytes) throw new HelperFault("input_limit");
        using var document = JsonDocument.Parse(line, new JsonDocumentOptions { MaxDepth = 32 });
        var root = document.RootElement;
        if (root.ValueKind != JsonValueKind.Object) throw new HelperFault("invalid_request");
        ClosedObject(root, ["id", "operation", "payload"]);
        var id = String(root, "id", 80);
        var operation = String(root, "operation", 32);
        if (!IsRequestId(id) || !Operations.Contains(operation)) throw new HelperFault("invalid_request");
        if (!root.TryGetProperty("payload", out var payload) || payload.ValueKind != JsonValueKind.Object) throw new HelperFault("invalid_request");
        return new Request(id, operation, payload.Clone());
    }

    public static readonly HashSet<string> Operations = ["status", "prepare", "text", "image", "indexSync", "indexSearch", "indexDelete", "agents", "invokeAgent", "registerAgent", "unregisterAgent", "shutdown", "cancel"];
    public static string String(JsonElement value, string property, int limit, bool optional = false)
    {
        if (!value.TryGetProperty(property, out var element))
        {
            if (optional) return "";
            throw new HelperFault("invalid_request");
        }
        if (element.ValueKind != JsonValueKind.String) throw new HelperFault("invalid_request");
        var text = element.GetString()!;
        if (Encoding.UTF8.GetByteCount(text) > limit) throw new HelperFault("input_limit");
        if (!optional && string.IsNullOrWhiteSpace(text)) throw new HelperFault("invalid_request");
        return text;
    }
    public static void ClosedObject(JsonElement value, string[] allowed)
    {
        if (value.ValueKind != JsonValueKind.Object) throw new HelperFault("invalid_request");
        var found = new HashSet<string>();
        foreach (var property in value.EnumerateObject())
            if (!allowed.Contains(property.Name) || !found.Add(property.Name)) throw new HelperFault("invalid_request");
    }
    public static byte[] Image(JsonElement payload)
    {
        var encoded = String(payload, "imageBase64", (MaximumImageBytes + 2) / 3 * 4 + 4);
        byte[] bytes;
        try { bytes = Convert.FromBase64String(encoded); }
        catch (FormatException) { throw new HelperFault("invalid_image"); }
        if (bytes.Length == 0 || bytes.Length > MaximumImageBytes) throw new HelperFault("input_limit");
        return bytes;
    }
}

internal sealed record Request(string Id, string Operation, JsonElement Payload);
internal sealed class HelperFault(string code) : Exception
{
    public string Code { get; } = code;
    public string SafeMessage => Code switch
    {
        "consent_required" => "Enable the feature and its required consent before starting this operation.",
        "input_limit" => "The request exceeds Lumen's text or image size limit.",
        "output_limit" => "The result exceeds Lumen's response size limit.",
        "cancelled" => "The operation was cancelled. A Windows-owned download may continue in Windows Update.",
        "identity_required" => "This operation requires Lumen's trusted package identity.",
        "runtime_required" => "The pinned Windows App Runtime preview is not available to the helper.",
        "access_required" => "A valid Microsoft limited-access token is required for the Windows language model.",
        "unsupported" => "This feature is not supported by the current Windows host.",
        "model_not_ready" => "Prepare the supported local model before running this operation.",
        "context_limit" => "The text exceeds the model context. Start a shorter request.",
        "odr_unavailable" => "Windows On Device Registry is not installed in a trusted Windows location.",
        "invalid_catalogue" => "Only Lumen's shipped public catalogue can be indexed.",
        "agent_not_found" => "The discovered agent or its Windows App Action is no longer available.",
        "blocked_by_policy" => "Windows blocked this operation under its current policy or content moderation.",
        "busy" => "The helper request queue is full.",
        "invalid_image" => "The selected image cannot be decoded safely.",
        "invalid_request" => "The helper request is invalid.",
        _ => "The Windows AI operation failed. Refresh availability before retrying.",
    };
}
