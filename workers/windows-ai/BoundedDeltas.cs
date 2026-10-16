using System.Text;

namespace Lumen.WindowsAi;

internal sealed class BoundedDeltas(Action<string> emit, Action cancel)
{
    private int bytes;
    private bool exceeded;
    private bool closed;
    private readonly object gate = new();
    public void Append(string delta)
    {
        lock (gate)
        {
            if (closed || exceeded || string.IsNullOrEmpty(delta)) return;
            var size = Encoding.UTF8.GetByteCount(delta);
            if (size > Protocol.MaximumTextBytes || bytes + size > Protocol.MaximumResponseBytes) { exceeded = true; cancel(); return; }
            bytes += size; emit(delta);
        }
    }
    public void Check() { if (exceeded) throw new HelperFault("output_limit"); }
    public void Close() { lock (gate) closed = true; }
}
