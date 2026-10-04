// Dynamic dependency binding is adapted from Microsoft's MIT-licensed
// Aion-Instruct-Preview-Sample/unpackaged-console/FrameworkDependency.cs.
// See THIRD_PARTY.md and licenses/Aion-Sample-MIT.txt.
using System.Runtime.InteropServices;
using System.Text;
#if AION_ARM64
using AionInstructPreview.Text;
#endif

namespace Lumen.WindowsAi;

internal sealed class AionAdapter : IDisposable
{
    public const string FamilyName = "Microsoft.AionInstructPreview.Framework.1.0_8wekyb3d8bbwe";
    private IntPtr dependencyContext;
    private IntPtr dependencyId;
    private DateTime lastUsed = DateTime.UtcNow;
#if AION_ARM64
    private LanguageModel? model;
#endif
    [DllImport("kernelbase.dll", CharSet = CharSet.Unicode, ExactSpelling = true)]
    private static extern int TryCreatePackageDependency(IntPtr user, string packageFamilyName, ulong minVersion, int architectures, int lifetimeKind, string? lifetimeArtifact, int options, out IntPtr id);
    [DllImport("kernelbase.dll", ExactSpelling = true)]
    private static extern int AddPackageDependency(IntPtr id, int rank, int options, out IntPtr context, out IntPtr fullName);
    [DllImport("kernelbase.dll", ExactSpelling = true)]
    private static extern void RemovePackageDependency(IntPtr context);
    [DllImport("kernelbase.dll", ExactSpelling = true)]
    private static extern int DeletePackageDependency(IntPtr id);
    [DllImport("kernel32.dll", ExactSpelling = true)]
    private static extern IntPtr GetProcessHeap();
    [DllImport("kernel32.dll", ExactSpelling = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool HeapFree(IntPtr heap, uint flags, IntPtr pointer);

    public async Task Prepare(CancellationToken cancellation)
    {
#if AION_ARM64
        if (dependencyContext == IntPtr.Zero)
        {
            if (TryCreatePackageDependency(IntPtr.Zero, FamilyName, 1UL << 48, 0x10, 0, null, 0, out dependencyId) != 0) throw new HelperFault("runtime_required");
            if (AddPackageDependency(dependencyId, 0, 0, out dependencyContext, out var fullName) != 0) throw new HelperFault("runtime_required");
            if (fullName != IntPtr.Zero) HeapFree(GetProcessHeap(), 0, fullName);
        }
        if (model is null)
        {
            var operation = LanguageModel.CreateAsync();
            using var cancel = cancellation.Register(operation.Cancel);
            model = await operation;
        }
        cancellation.ThrowIfCancellationRequested(); lastUsed = DateTime.UtcNow;
#else
        await Task.CompletedTask;
        throw new HelperFault("unsupported");
#endif
    }
    public async Task<TextResult> Generate(string task, string text, Action<string> delta, CancellationToken cancellation)
    {
#if AION_ARM64
        await Prepare(cancellation);
        var prompt = task switch { "summarize" => "Summarize this text faithfully and concisely:\n" + text, "rewrite" => "Rewrite this text for clarity, preserving its meaning:\n" + text, "write" => "Write a clear, useful draft from the following request or notes. Return only the draft:\n" + text, _ => text };
        using var context = model!.CreateContext();
        var operation = model.GenerateResponseAsync(context, prompt);
        var bounded = new BoundedDeltas(delta, operation.Cancel);
        operation.Progress = (_, token) => bounded.Append(token);
        using var cancel = cancellation.Register(operation.Cancel);
        try
        {
            var result = await operation;
            cancellation.ThrowIfCancellationRequested(); bounded.Check();
            if (result.Status != LanguageModelResponseStatus.Complete) throw new HelperFault(result.Status == LanguageModelResponseStatus.PromptLargerThanContext ? "context_limit" : "generation_failed");
            if (Encoding.UTF8.GetByteCount(result.Text) > Protocol.MaximumResponseBytes) throw new HelperFault("output_limit");
            return new(result.Text, "aion", "Aion Instruct preview 1.0.0", []);
        }
        finally { operation.Progress = null; bounded.Close(); lastUsed = DateTime.UtcNow; }
#else
        await Task.CompletedTask;
        throw new HelperFault("unsupported");
#endif
    }
    public void Unload()
    {
#if AION_ARM64
        model?.Dispose(); model = null;
#endif
    }
    public void ReleaseIdle() { if (DateTime.UtcNow - lastUsed > TimeSpan.FromMinutes(5)) Unload(); }
    public void Dispose()
    {
        Unload();
        if (dependencyContext != IntPtr.Zero) { RemovePackageDependency(dependencyContext); dependencyContext = IntPtr.Zero; }
        if (dependencyId != IntPtr.Zero) { DeletePackageDependency(dependencyId); HeapFree(GetProcessHeap(), 0, dependencyId); dependencyId = IntPtr.Zero; }
    }
}

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
