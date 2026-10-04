using System.Text;
using System.Text.Json;
using System.Threading.Channels;

namespace Lumen.WindowsAi;

internal sealed class HelperServer : IDisposable
{
    private readonly WindowsHost host = new();
    private readonly WindowsModels models = new();
    private readonly AionAdapter aion = new();
    private readonly PublicContentIndex index = new();
    private readonly AgentRegistry agents;
    private readonly RequestRegistry requests = new();
    private readonly CancellationTokenSource shutdown = new();
    private readonly object outputGate = new();
    private readonly SemaphoreSlim sessionGate = new(1, 1);
    private readonly Timer idleTimer;
    private readonly Channel<(Request request, CancellationTokenSource cancellation)> queue = Channel.CreateBounded<(Request, CancellationTokenSource)>(16);
    private static readonly string[] featureIds = ["languageModel", "aion", "summarize", "rewrite", "ocr", "imageDescription", "appContentSearch", "agentDiscovery", "agentInvocation", "agentRegistration"];
    public HelperServer()
    {
        agents = new(host);
        idleTimer = new Timer(_ =>
        {
            if (!sessionGate.Wait(0)) return;
            try { models.ReleaseIdle(); aion.ReleaseIdle(); } catch { }
            finally { sessionGate.Release(); }
        }, null, TimeSpan.FromSeconds(10), TimeSpan.FromSeconds(10));
    }
    public async Task Run()
    {
        var consumer = Consume();
        try
        {
            await foreach (var line in Lines(Console.OpenStandardInput(), shutdown.Token))
            {
                var id = "invalid-request";
                try
                {
                    if (line is null) throw new HelperFault("input_limit");
                    try
                    {
                        using var envelope = JsonDocument.Parse(line);
                        if (envelope.RootElement.ValueKind == JsonValueKind.Object && envelope.RootElement.TryGetProperty("id", out var candidate) && candidate.ValueKind == JsonValueKind.String && Protocol.IsRequestId(candidate.GetString())) id = candidate.GetString()!;
                    }
                    catch { }
                    var request = Protocol.Parse(line); id = request.Id;
                    if (request.Operation == "cancel")
                    {
                        Protocol.ClosedObject(request.Payload, ["requestId"]);
                        var target = Protocol.String(request.Payload, "requestId", 80);
                        if (!Protocol.IsRequestId(target)) throw new HelperFault("invalid_request");
                        var cancelled = requests.Cancel(target);
                        Result(id, new OperationResult(true, cancelled ? "Cancellation was requested." : "The request is no longer active."));
                        continue;
                    }
                    var source = requests.Add(id);
                    if (!queue.Writer.TryWrite((request, source))) { requests.Remove(id); throw new HelperFault("busy"); }
                }
                catch (Exception error) { Error(id, WindowsHost.Map(error)); }
            }
        }
        catch (OperationCanceledException) { }
        finally { queue.Writer.TryComplete(); }
        await consumer;
    }
    private async Task Consume()
    {
        await foreach (var (request, cancellation) in queue.Reader.ReadAllAsync())
        {
            await sessionGate.WaitAsync();
            try
            {
                cancellation.Token.ThrowIfCancellationRequested();
                models.ReleaseIdle();
                var data = await Dispatch(request, cancellation.Token);
                cancellation.Token.ThrowIfCancellationRequested();
                Result(request.Id, data);
                if (request.Operation == "shutdown") shutdown.Cancel();
            }
            catch (Exception error) { Error(request.Id, WindowsHost.Map(error)); }
            finally { requests.Remove(request.Id); sessionGate.Release(); }
        }
    }
    private object Snapshot(Preferences preferences, string token)
    {
        var features = featureIds.Select(id => host.Feature(id, preferences, token)).ToArray();
        return new { version = 1, host = new { osBuild = Environment.OSVersion.Version.ToString(), architecture = host.Architecture, packageIdentity = host.Identity, runtimeVersion = host.RuntimeVersion,
            npuProviders = host.Providers().Where(p => p.Name is "QNNExecutionProvider" or "VitisAIExecutionProvider" or "OpenVINOExecutionProvider").Select(p => $"{p.Name} ({p.Certification}, {p.ReadyState})").Take(32).Select(p => p[..Math.Min(p.Length, 200)]).ToArray() },
            features, preferences, agents = agents.Cached, appIndex = index.Status(preferences.Enabled("appContentSearch"), features.Any(f => f.Id == "appContentSearch" && f.Availability == "ready")), accessTokenConfigured = !string.IsNullOrEmpty(token) };
    }
    private async Task<object> Dispatch(Request request, CancellationToken cancellation)
    {
        var p = request.Payload;
        if (request.Operation == "shutdown") { Protocol.ClosedObject(p, []); models.Dispose(); aion.Dispose(); return new OperationResult(true, "The helper shut down."); }
        var preferences = Preferences.Read(p);
        var token = Protocol.String(p, "accessToken", 4096, optional:true);
        switch (request.Operation)
        {
            case "status":
                Protocol.ClosedObject(p, ["preferences", "accessToken"]);
                if (!preferences.WindowsEnabled) { models.Dispose(); aion.Unload(); }
                return Snapshot(preferences, token);
            case "prepare":
            {
                Protocol.ClosedObject(p, ["featureId", "preferences", "accessToken"]);
                var feature = Protocol.String(p, "featureId", 80);
                if (!new[] { "languageModel", "aion", "summarize", "rewrite", "ocr", "imageDescription", "appContentSearch" }.Contains(feature)) throw new HelperFault("invalid_request");
                preferences.Require(preferences.Enabled(feature), download:true);
                var state = host.Feature(feature, preferences, token);
                if (state.Availability is not ("ready" or "downloadable")) host.RequireReady(feature, preferences, token);
                Progress(request.Id, "Preparing local model", null);
                if (feature == "aion") await aion.Prepare(cancellation);
                else if (feature == "appContentSearch") await index.Prepare(value => Progress(request.Id, "Preparing public content search", value), cancellation);
                else await models.Prepare(feature, value => Progress(request.Id, "Preparing local model", value), cancellation);
                cancellation.ThrowIfCancellationRequested();
                var refreshed = host.Feature(feature, preferences, token);
                if (refreshed.Availability != "ready") throw new HelperFault("preparation_failed");
                return Snapshot(preferences, token);
            }
            case "text":
            {
                Protocol.ClosedObject(p, ["requestId", "engine", "task", "text", "preferences", "accessToken"]);
                RequireRequestId(p, request.Id);
                var text = Protocol.String(p, "text", Protocol.MaximumTextBytes);
                var task = Protocol.String(p, "task", 32); var engine = Protocol.String(p, "engine", 32);
                if (!new[] { "answer", "summarize", "rewrite", "write" }.Contains(task) || engine is not ("windows" or "aion")) throw new HelperFault("invalid_request");
                preferences.Require(task == "answer" || preferences.TextToolsEnabled);
                host.RequireReady(engine == "aion" ? "aion" : task is "summarize" or "rewrite" ? task : "languageModel", preferences, token);
                if (engine == "aion")
                {
                    try { return await aion.Generate(task, text, value => Delta(request.Id, value), cancellation); }
                    finally { if (!preferences.KeepWarm) aion.Unload(); }
                }
                return await models.Generate(task, text, preferences.KeepWarm, value => Delta(request.Id, value), cancellation);
            }
            case "image":
            {
                Protocol.ClosedObject(p, ["requestId", "operation", "imageBase64", "preferences", "accessToken"]);
                RequireRequestId(p, request.Id);
                var image = Protocol.Image(p);
                var operation = Protocol.String(p, "operation", 32);
                if (operation is not ("ocr" or "describe")) throw new HelperFault("invalid_request");
                preferences.Require(operation == "ocr" ? preferences.OcrEnabled : preferences.ImageDescriptionsEnabled);
                host.RequireReady(operation == "ocr" ? "ocr" : "imageDescription", preferences, token);
                return await models.Image(image, operation == "describe", preferences.KeepWarm, cancellation);
            }
            case "indexSync":
                Protocol.ClosedObject(p, ["version", "items", "preferences"]); index.Validate(p);
                preferences.Require(preferences.AppContentEnabled); host.RequireReady("appContentSearch", preferences, token);
                return await index.Sync(cancellation);
            case "indexSearch":
                Protocol.ClosedObject(p, ["query", "limit", "preferences"]);
                preferences.Require(preferences.AppContentEnabled); host.RequireReady("appContentSearch", preferences, token);
                if (!p.TryGetProperty("limit", out var limit) || !limit.TryGetInt32(out var size) || size != 20) throw new HelperFault("invalid_request");
                return index.Search(Protocol.String(p, "query", 4096), cancellation);
            case "indexDelete":
                Protocol.ClosedObject(p, ["preferences"]);
                // Deletion remains possible after feature consent is revoked.
                if (!host.Identity) throw new HelperFault("identity_required");
                if (!host.AiRuntimeReady) throw new HelperFault("runtime_required");
                return index.Delete();
            case "agents":
            {
                Protocol.ClosedObject(p, ["preferences", "verifyOwnRegistration"]);
                var ownOnly = false;
                if (p.TryGetProperty("verifyOwnRegistration", out var verify))
                {
                    if (verify.ValueKind != JsonValueKind.True) throw new HelperFault("invalid_request");
                    ownOnly = true;
                }
                if (!ownOnly) preferences.Require(preferences.AgentsEnabled);
                return await agents.Discover(cancellation, ownOnly);
            }
            case "invokeAgent":
                Protocol.ClosedObject(p, ["agent", "prompt", "preferences"]); preferences.Require(preferences.AgentsEnabled);
                return await agents.Invoke(p, cancellation);
            case "registerAgent":
            case "unregisterAgent":
                Protocol.ClosedObject(p, ["preferences", "agentDefinitionPath"]);
                if (request.Operation == "registerAgent") preferences.Require(preferences.AgentsEnabled && preferences.RegisterLumenAgent);
                return await agents.Register(request.Operation == "registerAgent", Protocol.String(p, "agentDefinitionPath", 2048), cancellation);
            default: throw new HelperFault("invalid_request");
        }
    }
    private static void RequireRequestId(JsonElement payload, string id)
    {
        if (Protocol.String(payload, "requestId", 80) != id) throw new HelperFault("invalid_request");
    }
    private void Emit(object message)
    {
        var json = JsonSerializer.Serialize(message, Preferences.JsonOptions);
        if (Encoding.UTF8.GetByteCount(json) > 1024 * 1024) throw new HelperFault("output_limit");
        lock (outputGate) { Console.WriteLine(json); Console.Out.Flush(); }
    }
    private void Result(string id, object data) => Emit(new { id, type = "result", data });
    private void Error(string id, HelperFault fault) => Emit(new { id, type = "error", code = fault.Code, message = fault.SafeMessage });
    private void Delta(string id, string text) => Emit(new { id, type = "delta", text });
    private void Progress(string id, string phase, double? progress) => Emit(new { id, type = "progress", phase, progress });
    private static async IAsyncEnumerable<string?> Lines(Stream input, [System.Runtime.CompilerServices.EnumeratorCancellation] CancellationToken cancellation)
    {
        var buffer = new byte[8192]; using var line = new MemoryStream(); var overlong = false;
        int count;
        while ((count = await input.ReadAsync(buffer, cancellation)) != 0)
        {
            for (var offset = 0; offset < count; offset++)
            {
                var value = buffer[offset];
                if (value == 10)
                {
                    if (overlong) yield return null;
                    else
                    {
                        var bytes = line.ToArray(); string? text;
                        try { text = new UTF8Encoding(false, true).GetString(bytes).TrimEnd('\r'); } catch { text = "{invalid-utf8"; }
                        yield return text;
                    }
                    line.SetLength(0); overlong = false;
                }
                else if (!overlong)
                {
                    if (line.Length >= Protocol.MaximumLineBytes) { overlong = true; line.SetLength(0); }
                    else line.WriteByte(value);
                }
            }
        }
        if (overlong) yield return null;
        else if (line.Length != 0) yield return new UTF8Encoding(false, true).GetString(line.ToArray());
    }
    public void Dispose()
    {
        shutdown.Cancel(); idleTimer.Dispose(); requests.Dispose();
        sessionGate.Wait();
        try { models.Dispose(); aion.Dispose(); host.Dispose(); shutdown.Dispose(); }
        finally { sessionGate.Release(); }
    }
}
