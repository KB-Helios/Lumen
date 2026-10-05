using System.Text.Json;
using System.Text.Json.Serialization;

namespace Lumen.WindowsAi;

internal sealed record Preferences
{
    public string LocalEngine { get; init; } = "auto";
    public bool WindowsEnabled { get; init; }
    public bool ModelDownloadsAllowed { get; init; }
    public bool AppContentEnabled { get; init; }
    public bool AgentsEnabled { get; init; }
    public bool RegisterLumenAgent { get; init; }
    public bool TextToolsEnabled { get; init; }
    public bool OcrEnabled { get; init; }
    public bool ImageDescriptionsEnabled { get; init; }
    public bool EdgeEnabled { get; init; }
    public bool DictationEnabled { get; init; }
    public string SourceLanguage { get; init; } = "en";
    public string TargetLanguage { get; init; } = "sv";
    public string SpeechLanguage { get; init; } = "en-US";
    public bool KeepWarm { get; init; }

    public static readonly JsonSerializerOptions JsonOptions = new() { PropertyNamingPolicy = JsonNamingPolicy.CamelCase, UnmappedMemberHandling = JsonUnmappedMemberHandling.Disallow };
    public static Preferences Read(JsonElement payload)
    {
        if (!payload.TryGetProperty("preferences", out var element) || element.ValueKind != JsonValueKind.Object) throw new HelperFault("invalid_request");
        var names = typeof(Preferences).GetProperties().Select(p => JsonNamingPolicy.CamelCase.ConvertName(p.Name)).ToArray();
        Protocol.ClosedObject(element, names);
        var preferences = element.Deserialize<Preferences>(JsonOptions) ?? throw new HelperFault("invalid_request");
        if (!new[] { "auto", "runtime", "windows", "aion", "edge" }.Contains(preferences.LocalEngine)) throw new HelperFault("invalid_request");
        foreach (var language in new[] { preferences.SourceLanguage, preferences.TargetLanguage, preferences.SpeechLanguage })
            if (language is null || language.Length > 35 || !System.Text.RegularExpressions.Regex.IsMatch(language, "\\A[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*\\z")) throw new HelperFault("invalid_request");
        return preferences;
    }
    public void Require(bool feature = true, bool download = false)
    {
        if (!WindowsEnabled || !feature || (download && !ModelDownloadsAllowed)) throw new HelperFault("consent_required");
    }
    public bool Enabled(string feature) => feature switch
    {
        "summarize" or "rewrite" => WindowsEnabled && TextToolsEnabled,
        "ocr" => WindowsEnabled && OcrEnabled,
        "imageDescription" => WindowsEnabled && ImageDescriptionsEnabled,
        "appContentSearch" => WindowsEnabled && AppContentEnabled,
        "agentDiscovery" or "agentInvocation" => WindowsEnabled && AgentsEnabled,
        "agentRegistration" => WindowsEnabled && AgentsEnabled && RegisterLumenAgent,
        _ => WindowsEnabled,
    };
}

internal sealed record Feature(string Id, string Host, string Label, string Availability, string ReasonCode, string? Detail, bool Enabled, string? Model);
internal sealed record Agent(string Id, string Name, string DisplayName, string Description, string PackageFamilyName, string ActionId);
internal sealed record OperationResult(bool Ok, string Message, string? Code = null);
internal sealed record TextResult(string Text, string Engine, string? Model, object[] Citations);
