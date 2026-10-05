using System.Reflection;
using System.Text.Json;
using Microsoft.Windows.Search.AppContentIndex;

namespace Lumen.WindowsAi;

internal sealed class PublicContentIndex
{
    public const string IndexName = "Lumen.PublicHelp.v1";
    private readonly JsonElement catalogue;
    private bool reconciled;
    private string state = "unavailable";
    private int count;
    public PublicContentIndex()
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream("Lumen.WindowsAi.catalogue.json")!;
        using var document = JsonDocument.Parse(stream);
        catalogue = document.RootElement.Clone();
    }
    public object Status(bool enabled, bool capabilityReady)
    {
        if (enabled && capabilityReady)
        {
            try
            {
                // Open only a known existing index while its model is ready.
                // A status request never creates content or prepares a model.
                if (AppContentIndexer.GetExistingIndexes().Contains(IndexName))
                {
                    using var existing = Open(false);
                    ReadStatistics(existing);
                }
                else { state = "unavailable"; count = 0; }
            }
            catch { state = "error"; }
        }
        return new { state = enabled ? state : "disabled", items = count };
    }
    public void Validate(JsonElement payload)
    {
        if (!payload.TryGetProperty("version", out var version) || !version.TryGetInt32(out var number) || number != 1 || !payload.TryGetProperty("items", out var items) || !JsonElement.DeepEquals(items, catalogue.GetProperty("items"))) throw new HelperFault("invalid_catalogue");
    }
    private static AppContentIndexer Open(bool create)
    {
        if (!create && !AppContentIndexer.GetExistingIndexes().Contains(IndexName)) throw new HelperFault("index_missing");
        // Optional image capabilities are disabled; the index contains public text only.
        var options = new GetOrCreateIndexOptions { TextSemanticRequirement = IndexCapabilityRequirement.Required, TextLexicalRequirement = IndexCapabilityRequirement.Required, ImageOcrRequirement = IndexCapabilityRequirement.Suppressed, ImageSemanticRequirement = IndexCapabilityRequirement.Suppressed };
        var result = AppContentIndexer.GetOrCreateIndex(IndexName, options);
        if (!result.Succeeded) throw new HelperFault("index_unavailable");
        return result.Indexer;
    }
    public async Task Prepare(Action<double?> progress, CancellationToken cancellation)
    {
        using var index = Open(true);
        var operation = index.WaitForIndexCapabilitiesAsync();
        operation.Progress = (_, value) => progress(double.IsFinite(value) ? Math.Clamp(value, 0, 1) : null);
        using var cancel = cancellation.Register(operation.Cancel);
        var capabilities = await operation;
        cancellation.ThrowIfCancellationRequested();
        if (capabilities.HasCapabilitiesWithErrors ||
            capabilities.GetCapabilityState(IndexCapability.TextSemantic).InitializationStatus != IndexCapabilityInitializationStatus.Initialized ||
            capabilities.GetCapabilityState(IndexCapability.TextLexical).InitializationStatus != IndexCapabilityInitializationStatus.Initialized)
            throw new HelperFault("preparation_failed");
    }
    private void ReadStatistics(AppContentIndexer index)
    {
        var statistics = index.GetIndexStatistics(); count = Math.Clamp(statistics.ItemCount, 0, 1000);
        state = statistics.ErrorsCount != 0 ? "error" : statistics.IndexingInProgress ? "indexing" : "ready";
    }
    public async Task<OperationResult> Sync(CancellationToken cancellation)
    {
        using var index = Open(true);
        state = "indexing";
        index.RemoveAllContentItems();
        foreach (var item in catalogue.GetProperty("items").EnumerateArray())
        {
            cancellation.ThrowIfCancellationRequested();
            var text = item.GetProperty("title").GetString() + "\n" + item.GetProperty("description").GetString() + "\n" + string.Join(' ', item.GetProperty("keywords").EnumerateArray().Select(v => v.GetString()));
            index.AddOrUpdate(AppManagedIndexableAppContent.CreateFromString(item.GetProperty("id").GetString()!, text));
        }
        var operation = index.WaitForIndexingIdleAsync(TimeSpan.FromSeconds(45));
        using var cancel = cancellation.Register(operation.Cancel);
        var idle = await operation;
        cancellation.ThrowIfCancellationRequested();
        var statistics = index.GetIndexStatistics(); count = Math.Clamp(statistics.ItemCount, 0, 1000);
        if (statistics.ErrorsCount != 0) { state = "error"; throw new HelperFault("index_failed"); }
        state = idle && !statistics.IndexingInProgress ? "ready" : "indexing";
        reconciled = state == "ready";
        return new(true, reconciled ? "Lumen's public help catalogue was indexed." : "Windows is still indexing Lumen's public help catalogue.");
    }
    public object Search(string query, CancellationToken cancellation)
    {
        using var index = Open(false);
        cancellation.ThrowIfCancellationRequested();
        ReadStatistics(index);
        var ids = catalogue.GetProperty("items").EnumerateArray().Select(v => v.GetProperty("id").GetString()).ToHashSet();
        return index.CreateTextQuery(query).GetNextMatches(20).Select(v => v.ContentId).Where(ids.Contains).Distinct(StringComparer.Ordinal).Take(20).Select(id => new { id, source = "semantic" }).ToArray();
    }
    public OperationResult Delete()
    {
        if (AppContentIndexer.GetExistingIndexes().Contains(IndexName))
        {
            var result = AppContentIndexer.DeleteIndex(IndexName, DeleteIndexWhileInUseBehavior.FailIfInUse);
            if (!result.Succeeded) throw new HelperFault("index_delete_failed");
        }
        reconciled = false; count = 0; state = "unavailable";
        return new(true, "Lumen's public help index was deleted.");
    }
}
