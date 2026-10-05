namespace Lumen.WindowsAi;

internal sealed class RequestRegistry : IDisposable
{
    private readonly Dictionary<string, CancellationTokenSource> requests = new();
    private readonly object gate = new();
    public CancellationTokenSource Add(string id)
    {
        lock (gate)
        {
            if (requests.ContainsKey(id)) throw new HelperFault("invalid_request");
            var source = new CancellationTokenSource();
            requests.Add(id, source);
            return source;
        }
    }
    public void Remove(string id)
    {
        lock (gate) if (requests.Remove(id, out var source)) source.Dispose();
    }
    public bool Cancel(string id)
    {
        lock (gate)
        {
            if (!requests.TryGetValue(id, out var source)) return false;
            source.Cancel();
            return true;
        }
    }
    public void Dispose()
    {
        lock (gate)
        {
            foreach (var source in requests.Values) { source.Cancel(); source.Dispose(); }
            requests.Clear();
        }
    }
}
