using System.Diagnostics;
using System.Text;
using System.Text.Json;
using Windows.AI.Actions;
using Windows.Foundation.Metadata;

namespace Lumen.WindowsAi;

internal sealed class AgentRegistry(WindowsHost host)
{
    private Agent[] agents = [];
    public Agent[] Cached => agents;
    public static string? FindOdr()
    {
        var windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        foreach (var relative in new[] { "System32/odr.exe", "SystemApps/MicrosoftWindows.Client.CBS_cw5n1h2txyewy/odr.exe" })
        {
            var path = Path.GetFullPath(Path.Combine(windows, relative));
            if (!File.Exists(path)) continue;
            try
            {
                var cursor = new FileInfo(path) as FileSystemInfo;
                while (cursor is not null)
                {
                    if ((cursor.Attributes & FileAttributes.ReparsePoint) != 0) throw new HelperFault("odr_unavailable");
                    cursor = cursor is FileInfo file ? file.Directory : ((DirectoryInfo)cursor).Parent;
                }
                return path;
            }
            catch { }
        }
        return null;
    }
    private static async Task<JsonElement> Run(string verb, string? definitionPath, CancellationToken cancellation)
    {
        var executable = FindOdr() ?? throw new HelperFault("odr_unavailable");
        var start = new ProcessStartInfo(executable) { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true, WorkingDirectory = Path.GetDirectoryName(executable)! };
        start.ArgumentList.Add("agent-info"); start.ArgumentList.Add(verb);
        if (definitionPath is not null) start.ArgumentList.Add(definitionPath);
        using var process = new Process { StartInfo = start };
        process.Start();
        using var deadline = CancellationTokenSource.CreateLinkedTokenSource(cancellation);
        deadline.CancelAfter(TimeSpan.FromSeconds(15));
        using var kill = deadline.Token.Register(() => { try { if (!process.HasExited) process.Kill(true); } catch { } });
        var output = ReadBounded(process.StandardOutput, deadline.Token);
        var error = ReadBounded(process.StandardError, deadline.Token);
        await process.WaitForExitAsync(deadline.Token);
        var text = await output; await error;
        if (process.ExitCode != 0) throw new HelperFault("agent_registry_failed");
        using var document = JsonDocument.Parse(text, new JsonDocumentOptions { MaxDepth = 16 });
        var root = document.RootElement;
        if (root.ValueKind == JsonValueKind.Object && root.TryGetProperty("extended_error", out var extended) && (!extended.TryGetInt32(out var code) || code != 0)) throw new HelperFault("agent_registry_failed");
        return root.Clone();
    }
    private static async Task<string> ReadBounded(StreamReader reader, CancellationToken cancellation)
    {
        var buffer = new char[4096]; var output = new StringBuilder(); var bytes = 0;
        int count;
        while ((count = await reader.ReadAsync(buffer.AsMemory(), cancellation)) != 0)
        {
            bytes += Encoding.UTF8.GetByteCount(buffer.AsSpan(0, count));
            if (bytes > 256 * 1024) throw new HelperFault("output_limit");
            output.Append(buffer, 0, count);
        }
        return output.ToString();
    }
    public async Task<Agent[]> Discover(CancellationToken cancellation, bool ownRegistrationOnly = false)
    {
        if (ownRegistrationOnly && !host.Identity) throw new HelperFault("identity_required");
        var root = await Run("list", null, cancellation);
        var array = root.ValueKind == JsonValueKind.Array ? root : root.TryGetProperty("agents", out var list) ? list : root.TryGetProperty("agent_infos", out var info) ? info : default;
        if (array.ValueKind != JsonValueKind.Array || array.GetArrayLength() > 128) throw new HelperFault("agent_registry_failed");
        var discovered = array.EnumerateArray().Select(element => new Agent(
            Protocol.String(element, "id", 512), Protocol.String(element, "name", 256),
            Protocol.String(element, "display_name", 160), Protocol.String(element, "description", 600, optional:true),
            Protocol.String(element, "package_family_name", 256), Protocol.String(element, "action_id", 256))).ToArray();
        if (discovered.Select(a => a.Id).Distinct(StringComparer.Ordinal).Count() != discovered.Length) throw new HelperFault("agent_registry_failed");
        // Removal verification remains possible after discovery consent is revoked.
        // It returns only Lumen's own fixed registration and never caches other agents.
        if (ownRegistrationOnly) return discovered.Where(IsOwnRegistration).ToArray();
        agents = discovered;
        return agents;
    }
    private bool IsOwnRegistration(Agent agent) => agent.Name == "lumen.browser" && agent.ActionId == "LumenBrowserAgent" && agent.PackageFamilyName == host.PackageFamily;
    public async Task<OperationResult> Invoke(JsonElement payload, CancellationToken cancellation)
    {
        if (!OperatingSystem.IsWindowsVersionAtLeast(10, 0, 26100)) throw new HelperFault("unsupported");
        if (!payload.TryGetProperty("agent", out var element)) throw new HelperFault("invalid_request");
        var agent = element.Deserialize<Agent>(Preferences.JsonOptions) ?? throw new HelperFault("invalid_request");
        // The supervised helper may be new for every invocation. Resolve a fresh
        // installed tuple rather than relying on an in-process discovery cache.
        if (!(await Discover(cancellation)).Contains(agent)) throw new HelperFault("agent_not_found");
        var prompt = Protocol.String(payload, "prompt", 16000);
        if (prompt.Length > 4000) throw new HelperFault("input_limit");
        if (!ApiInformation.IsTypePresent("Windows.AI.Actions.ActionRuntime")) throw new HelperFault("unsupported");
        using var runtime = ActionRuntime.GetDefault();
        using var catalog = runtime.ActionCatalog;
        Windows.AI.Actions.Hosting.ActionDefinition? action = null;
        foreach (var candidate in catalog.GetAllActions())
            if (candidate.PackageFamilyName == agent.PackageFamilyName && candidate.Id == agent.ActionId) { action = candidate; break; }
        if (action is null || !action.IsCurrentlyAvailable || !action.DisplaysUI) throw new HelperFault("agent_not_found");
        using (action)
        using (var context = runtime.CreateInvocationContext(action.Id))
        {
            Windows.AI.Actions.Hosting.ActionOverload? overload = null;
            foreach (var candidate in action.GetOverloads())
            {
                var inputs = candidate.GetInputs();
                if (inputs.Length != 2) continue;
                var names = new HashSet<string>();
                foreach (var input in inputs) names.Add(input.Name);
                if (names.SetEquals(new[] { "agentName", "prompt" })) { overload = candidate; break; }
            }
            if (overload is null) throw new HelperFault("agent_not_found");
            using (overload)
            {
                context.SetInputEntity("agentName", context.EntityFactory.CreateTextEntity(agent.Name));
                context.SetInputEntity("prompt", context.EntityFactory.CreateTextEntity(prompt));
                var operation = overload.InvokeAsync(context);
                using var cancel = cancellation.Register(operation.Cancel);
                await operation;
                cancellation.ThrowIfCancellationRequested();
                if (context.Result != ActionInvocationResult.Success || context.ExtendedError is not null) throw new HelperFault(context.Result == ActionInvocationResult.UserCanceled ? "cancelled" : "agent_invocation_failed");
            }
        }
        return new(true, "The selected Windows agent was invoked.");
    }
    public async Task<OperationResult> Register(bool enabled, string suppliedPath, CancellationToken cancellation)
    {
        if (!host.Identity) throw new HelperFault("identity_required");
        var expected = new[]
        {
            Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../Assets/agentRegistration.json")),
            Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../packaging/windows/Assets/agentRegistration.json")),
            Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "../../../../../../packaging/windows/Assets/agentRegistration.json")),
        };
        var path = Path.GetFullPath(suppliedPath);
        if (!expected.Contains(path, StringComparer.OrdinalIgnoreCase) || !File.Exists(path) || (File.GetAttributes(path) & FileAttributes.ReparsePoint) != 0) throw new HelperFault("invalid_request");
        using var document = JsonDocument.Parse(await File.ReadAllTextAsync(path, cancellation));
        var root = document.RootElement;
        if (Protocol.String(root, "name", 256) != "lumen.browser" || Protocol.String(root, "action_id", 256) != "LumenBrowserAgent") throw new HelperFault("invalid_request");
        await Run(enabled ? "add" : "remove", path, cancellation);
        var current = await Discover(cancellation, ownRegistrationOnly:true);
        var registered = current.Any(IsOwnRegistration);
        if (registered != enabled) throw new HelperFault("registration_unverified");
        return new(true, enabled ? "Lumen's Windows agent registration was verified." : "Lumen's Windows agent removal was verified.");
    }
}
