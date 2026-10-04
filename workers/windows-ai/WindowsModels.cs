using System.Text;
using Microsoft.Graphics.Imaging;
using Microsoft.Windows.AI;
using Microsoft.Windows.AI.ContentSafety;
using Microsoft.Windows.AI.Imaging;
using Microsoft.Windows.AI.Text;
using Windows.Foundation;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;

namespace Lumen.WindowsAi;

internal sealed class WindowsModels : IDisposable
{
    private LanguageModel? language;
    private TextRecognizer? recognizer;
    private ImageDescriptionGenerator? descriptions;
    private DateTime lastUsed = DateTime.UtcNow;
    private bool keepWarm;
    public async Task Prepare(string feature, Action<double?> progress, CancellationToken cancellation)
    {
        var operation = feature switch
        {
            "ocr" => TextRecognizer.EnsureReadyAsync(),
            "imageDescription" => ImageDescriptionGenerator.EnsureReadyAsync(),
            _ => LanguageModel.EnsureReadyAsync(),
        };
        operation.Progress = (_, value) => progress(double.IsFinite(value) && value >= 0 && value <= 1 ? value : null);
        using var cancel = cancellation.Register(operation.Cancel);
        try
        {
            var result = await operation; cancellation.ThrowIfCancellationRequested();
            if (result.Status != AIFeatureReadyResultState.Success || result.ExtendedError is not null) throw new HelperFault("preparation_failed");
        }
        finally { operation.Progress = null; }
    }
    public async Task<TextResult> Generate(string task, string text, bool warm, Action<string> delta, CancellationToken cancellation)
    {
        Touch(warm);
        if (language is null)
        {
            var creation = LanguageModel.CreateAsync();
            using var cancelCreate = cancellation.Register(creation.Cancel);
            language = await creation;
        }
        var prompt = task == "write" ? "Write a clear, useful draft from the following request or notes. Return only the draft:\n" + text : text;
        if ((ulong)prompt.Length > language.GetUsablePromptLength(prompt)) throw new HelperFault("context_limit");
        var operation = task switch
        {
            "summarize" => new TextSummarizer(language).SummarizeAsync(text),
            "rewrite" => new TextRewriter(language).RewriteAsync(text),
            _ => language.GenerateResponseAsync(prompt),
        };
        var bounded = new BoundedDeltas(delta, operation.Cancel);
        operation.Progress = (_, token) => bounded.Append(token);
        using var cancel = cancellation.Register(operation.Cancel);
        try
        {
            var result = await operation;
            cancellation.ThrowIfCancellationRequested(); bounded.Check();
            if (result.Status != LanguageModelResponseStatus.Complete || result.ExtendedError is not null)
                throw new HelperFault(result.Status switch { LanguageModelResponseStatus.PromptLargerThanContext => "context_limit", LanguageModelResponseStatus.BlockedByPolicy or LanguageModelResponseStatus.PromptBlockedByContentModeration or LanguageModelResponseStatus.ResponseBlockedByContentModeration => "blocked_by_policy", _ => "generation_failed" });
            if (Encoding.UTF8.GetByteCount(result.Text) > Protocol.MaximumResponseBytes) throw new HelperFault("output_limit");
            return new(result.Text, "windows", string.IsNullOrEmpty(language.ModelName) ? null : language.ModelName[..Math.Min(language.ModelName.Length, 160)], []);
        }
        finally { operation.Progress = null; bounded.Close(); Touch(warm); }
    }
    public async Task<TextResult> Image(byte[] bytes, bool describe, bool warm, CancellationToken cancellation)
    {
        Touch(warm);
        using var stream = new InMemoryRandomAccessStream();
        using (var writer = new DataWriter(stream.GetOutputStreamAt(0))) { writer.WriteBytes(bytes); await writer.StoreAsync().AsTask(cancellation); }
        stream.Seek(0);
        var decoder = await BitmapDecoder.CreateAsync(stream).AsTask(cancellation);
        // A compressed image under 4 MiB may still be a decompression bomb.
        if (decoder.PixelWidth == 0 || decoder.PixelHeight == 0 || decoder.PixelWidth > 8192 || decoder.PixelHeight > 8192 || (ulong)decoder.PixelWidth * decoder.PixelHeight > 16_777_216) throw new HelperFault("input_limit");
        using var bitmap = await decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Premultiplied).AsTask(cancellation);
        using var image = ImageBuffer.CreateForSoftwareBitmap(bitmap);
        string text;
        if (describe)
        {
            if (descriptions is null) descriptions = await ImageDescriptionGenerator.CreateAsync().AsTask(cancellation);
            var result = await descriptions.DescribeAsync(image, ImageDescriptionKind.BriefDescription, new ContentFilterOptions()).AsTask(cancellation);
            if (result.Status != ImageDescriptionResultStatus.Complete) throw new HelperFault("image_description_failed");
            text = result.Description;
        }
        else
        {
            if (recognizer is null) recognizer = await TextRecognizer.CreateAsync().AsTask(cancellation);
            var result = await recognizer.RecognizeTextFromImageAsync(image).AsTask(cancellation);
            var output = new StringBuilder();
            foreach (var line in result.Lines)
            {
                cancellation.ThrowIfCancellationRequested();
                output.AppendLine(line.Text);
                if (Encoding.UTF8.GetByteCount(output.ToString()) > Protocol.MaximumResponseBytes) throw new HelperFault("output_limit");
            }
            text = output.ToString();
        }
        if (Encoding.UTF8.GetByteCount(text) > Protocol.MaximumResponseBytes) throw new HelperFault("output_limit");
        Touch(warm);
        return new(text, "windows", null, []);
    }
    private void Touch(bool warm) { lastUsed = DateTime.UtcNow; keepWarm = warm; }
    public void ReleaseIdle()
    {
        if (DateTime.UtcNow - lastUsed > TimeSpan.FromSeconds(keepWarm ? 300 : 30)) Dispose();
    }
    public void Dispose() { language?.Dispose(); language = null; recognizer?.Dispose(); recognizer = null; descriptions?.Dispose(); descriptions = null; }
}
