using System.Runtime.InteropServices;
using Microsoft.Windows.AI;
using Microsoft.Windows.AI.Imaging;
using Microsoft.Windows.AI.Text;
using Microsoft.Windows.AI.MachineLearning;
using Microsoft.Windows.ApplicationModel.DynamicDependency;
using Microsoft.Windows.Search.AppContentIndex;
using Windows.AI.Actions;
using Windows.ApplicationModel;
using Windows.Foundation.Metadata;
using Windows.Management.Deployment;

namespace Lumen.WindowsAi;

internal sealed class WindowsHost : IDisposable
{
    public bool Identity { get; }
    public bool AiRuntimeReady { get; }
    public string? RuntimeVersion { get; }
    public string Architecture => RuntimeInformation.ProcessArchitecture switch { System.Runtime.InteropServices.Architecture.X64 => "x64", System.Runtime.InteropServices.Architecture.Arm64 => "arm64", System.Runtime.InteropServices.Architecture.X86 => "x86", _ => "unknown" };
    private bool bootstrapped;
    private Task<(string availability, string reason)>? actionsProbe;
    private DateTime actionsProbeStarted;
    public string? PackageFamily { get; }
    public WindowsHost()
    {
        try { var package = Package.Current; Identity = package.Id.Name == "Bridgehammer.Lumen" && package.Id.Publisher == "CN=Bridgehammer"; PackageFamily = Identity ? package.Id.FamilyName : null; } catch { Identity = false; }
        try
        {
            var minVersion = new Microsoft.Windows.ApplicationModel.DynamicDependency.PackageVersion(0x0002000500040000);
            // The exact release constants shipped by Microsoft.WindowsAppSDK.Runtime
            // 2.5.4-experimental/include/WindowsAppSDK-VersionInfo.cs.
            if (Identity)
            {
                // OnPackageIdentity_NOOP reports success without loading a
                // framework. Inspect the declared package graph instead.
                AiRuntimeReady = Package.Current.Dependencies.Any(p => p.Id.FamilyName == "Microsoft.WindowsAppRuntime.2-experimentalF_8wekyb3d8bbwe" &&
                    new Version(p.Id.Version.Major, p.Id.Version.Minor, p.Id.Version.Build, p.Id.Version.Revision) >= new Version(2, 5, 4, 0));
            }
            else
            {
                AiRuntimeReady = Bootstrap.TryInitialize(0x00020005, "experimentalF", minVersion, Bootstrap.InitializeOptions.None, out _);
                bootstrapped = AiRuntimeReady;
            }
            // Provider enumeration can use an installed stable runtime without claiming
            // that the separately pinned experimental AI contracts are available.
            if (!bootstrapped && !Identity)
                bootstrapped = Bootstrap.TryInitialize(0x00020000, "", minVersion, Bootstrap.InitializeOptions.None, out _) || Bootstrap.TryInitialize(0x00010008, "", minVersion, Bootstrap.InitializeOptions.None, out _);
            var packages = new PackageManager().FindPackagesForUser("")
                .Where(p => p.Id.Name.StartsWith("Microsoft.WindowsAppRuntime.", StringComparison.Ordinal))
                .OrderByDescending(p => RuntimeRelease(p.Id.Name)).ThenByDescending(p => p.Id.Version.Build).ToArray();
            RuntimeVersion = packages.FirstOrDefault() is { } runtime ? $"{runtime.Id.Name} {runtime.Id.Version.Major}.{runtime.Id.Version.Minor}.{runtime.Id.Version.Build}.{runtime.Id.Version.Revision}" : null;
        }
        catch { AiRuntimeReady = false; }
    }
    private static Version RuntimeRelease(string name)
    {
        var match = System.Text.RegularExpressions.Regex.Match(name, "\\AMicrosoft\\.WindowsAppRuntime\\.(\\d+(?:\\.\\d+)*)");
        var value = match.Success ? match.Groups[1].Value : "0";
        return Version.TryParse(value.Contains('.') ? value : value + ".0", out var release) ? release : new Version();
    }
    public IReadOnlyList<ExecutionProvider> Providers()
    {
        try { return ExecutionProviderCatalog.GetDefault().FindAllProviders().Take(32).ToArray(); } catch { return []; }
    }
    public bool AionFrameworkPresent()
    {
        if (Architecture != "arm64") return false;
        try { return new PackageManager().FindPackagesForUser("").Any(p => p.Id.FamilyName == AionAdapter.FamilyName && p.Id.Version.Major >= 1); } catch { return false; }
    }
    public bool LanguageAccess(string token)
    {
        try
        {
            var appId = PackageFamily ?? "Bridgehammer.Lumen";
            var result = LimitedAccessFeatures.TryUnlockFeature("com.microsoft.windows.ai.languagemodel", token,
                $"{appId} has registered their use of com.microsoft.windows.ai.languagemodel with Microsoft and agrees to the terms of use.");
            return result.Status == LimitedAccessFeatureStatus.AvailableWithoutToken || (!string.IsNullOrEmpty(token) && result.Status == LimitedAccessFeatureStatus.Available);
        }
        catch { return false; }
    }
    public Feature Feature(string id, Preferences preferences, string token)
    {
        var label = id switch { "languageModel" => "Windows language model", "aion" => "Aion Instruct preview", "summarize" => "Summarize", "rewrite" => "Rewrite", "ocr" => "Text recognition", "imageDescription" => "Image description", "appContentSearch" => "App content search", "agentDiscovery" => "Windows agent discovery", "agentInvocation" => "Windows agent invocation", _ => "Lumen agent registration" };
        var enabled = preferences.Enabled(id);
        Feature State(string availability, string reason, string? detail = null) => new(id, "windows", label, availability, reason, detail, enabled, null);
        if (id == "aion")
        {
            if (Architecture != "arm64") return State("unsupported", "aion_arm64_only", "The pinned Aion preview supports ARM64 Snapdragon/QNN hosts only.");
            if (!AionFrameworkPresent()) return State("runtimeRequired", "aion_framework_missing", "Install the Microsoft-signed Aion ARM64 framework through its documented setup before preparing the model.");
            if (!Providers().Any(p => p.Name == "QNNExecutionProvider" && p.Certification == ExecutionProviderCertification.Certified && p.ReadyState == ExecutionProviderReadyState.Ready)) return State("unsupported", "aion_certified_npu_required", "Aion requires a certified ready QNN NPU provider; provider installation is a separate setup step.");
            return State("ready", "aion_framework_and_qnn_ready", "The framework and certified QNN provider are installed. Model loading is checked when a request begins.");
        }
        if (id == "agentDiscovery") return AgentRegistry.FindOdr() is null ? State("unavailable", "odr_unavailable") : State("ready", "odr_present");
        if (id == "agentRegistration")
        {
            if (!Identity) return State("identityRequired", "package_identity_missing");
            if (AgentRegistry.FindOdr() is null) return State("unavailable", "odr_unavailable");
            return State("ready", "identity_and_odr_present");
        }
        if (id == "agentInvocation")
        {
            if (actionsProbe is null || (actionsProbe.IsCompleted && DateTime.UtcNow - actionsProbeStarted > TimeSpan.FromSeconds(30)))
            {
                actionsProbeStarted = DateTime.UtcNow;
                actionsProbe = Task.Run(ProbeActions);
            }
            // Windows may synchronously wait on its action catalogue service. Status
            // stays bounded; only one passive probe can be outstanding per helper.
            if (!actionsProbe.Wait(TimeSpan.FromMilliseconds(750))) return State("unavailable", "actions_probe_pending", "Windows has not answered the passive App Actions catalogue probe yet. Refresh availability after a moment.");
            var result = actionsProbe.Result;
            return State(result.availability, result.reason, result.availability == "ready" ? "Windows App Actions can be queried. Invocation still requires a currently discovered agent and a successful terminal action result." : null);
        }
        if (id == "appContentSearch" && !Identity) return State("identityRequired", "package_identity_missing");
        if (!AiRuntimeReady) return State("runtimeRequired", "windows_ai_runtime_missing", "This helper is pinned to Windows App Runtime 2.5 experimentalF; an older installed runtime does not establish API readiness.");
        try
        {
            if (id == "appContentSearch")
            {
                var capability = AppContentIndexer.GetIndexCapabilitiesOfCurrentSystem().GetIndexCapabilityStatus(IndexCapability.TextSemantic);
                return capability switch { IndexCapabilityOfCurrentSystemStatus.Ready => State("ready", "index_semantic_ready"), IndexCapabilityOfCurrentSystemStatus.NotReady => State("downloadable", "index_semantic_not_ready"), IndexCapabilityOfCurrentSystemStatus.DisabledByPolicy => State("disabled", "index_disabled_by_policy"), _ => State("unsupported", "index_not_supported") };
            }
            if (id is "languageModel" or "summarize" or "rewrite" && !LanguageAccess(token)) return State("accessRequired", "limited_access_token_required");
            var ready = id switch { "ocr" => TextRecognizer.GetReadyState(), "imageDescription" => ImageDescriptionGenerator.GetReadyState(), _ => LanguageModel.GetReadyState() };
            return ready switch
            {
                AIFeatureReadyState.Ready => State("ready", "model_ready"),
                AIFeatureReadyState.NotReady => State("downloadable", "model_not_ready"),
                AIFeatureReadyState.DisabledByUser => State("disabled", "windows_ai_disabled"),
                AIFeatureReadyState.CapabilityMissing => State("identityRequired", "systemaimodels_capability_missing"),
                AIFeatureReadyState.OSUpdateNeeded => State("runtimeRequired", "windows_update_required"),
                _ => State("unsupported", "unsupported_system"),
            };
        }
        catch (Exception error) { var fault = Map(error); return State(fault.Code == "runtime_required" ? "runtimeRequired" : fault.Code == "access_required" ? "accessRequired" : "failed", fault.Code); }
    }
    private static (string availability, string reason) ProbeActions()
    {
        try
        {
            if (!OperatingSystem.IsWindowsVersionAtLeast(10, 0, 26100) || !ApiInformation.IsTypePresent("Windows.AI.Actions.ActionRuntime") || !ApiInformation.IsTypePresent("Windows.AI.Actions.Hosting.ActionCatalog")) return ("unsupported", "actions_api_missing");
            using var runtime = ActionRuntime.GetDefault();
            using var catalog = runtime.ActionCatalog;
            _ = catalog.GetAllActions().Length;
            return ("ready", "actions_catalog_accessible");
        }
        catch (Exception error) { var fault = Map(error); return (fault.Code == "access_required" ? "accessRequired" : fault.Code == "runtime_required" ? "runtimeRequired" : "failed", fault.Code); }
    }
    public void RequireReady(string feature, Preferences preferences, string token)
    {
        var state = Feature(feature, preferences, token);
        if (state.Availability != "ready") throw new HelperFault(state.Availability switch { "identityRequired" => "identity_required", "runtimeRequired" => "runtime_required", "accessRequired" => "access_required", "downloadable" => "model_not_ready", "disabled" => "blocked_by_policy", "unsupported" => "unsupported", _ => state.ReasonCode });
    }
    public static HelperFault Map(Exception error) => error switch
    {
        HelperFault fault => fault,
        OperationCanceledException => new("cancelled"),
        System.Text.Json.JsonException => new("invalid_request"),
        _ when error.HResult == unchecked((int)0x80040154) || error is DllNotFoundException or TypeLoadException or EntryPointNotFoundException => new("runtime_required"),
        _ when error.HResult == unchecked((int)0x80070005) => new("access_required"),
        _ => new("operation_failed"),
    };
    public void Dispose() { if (bootstrapped) Bootstrap.Shutdown(); }
}
