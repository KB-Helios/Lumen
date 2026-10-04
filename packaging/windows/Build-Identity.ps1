param(
    [string]$MakeAppxPath,
    [string]$OutputPath = (Join-Path $PSScriptRoot "output\Lumen.Identity.msix"),
    [switch]$ValidateOnly
)

$ErrorActionPreference = "Stop"
$manifestPath = Join-Path $PSScriptRoot "AppxManifest.xml"
[xml]$manifest = Get-Content -LiteralPath $manifestPath -Raw
[xml]$main = Get-Content -LiteralPath (Join-Path $PSScriptRoot "lumen.manifest") -Raw
[xml]$helper = Get-Content -LiteralPath (Join-Path $PSScriptRoot "helper.manifest") -Raw
$identity = $manifest.Package.Identity
if ($main.assembly.dependency.dependentAssembly.assemblyIdentity.name -ne "Microsoft.Windows.Common-Controls" -or
    $main.assembly.dependency.dependentAssembly.assemblyIdentity.version -ne "6.0.0.0") {
    throw "The main executable must preserve Tauri's Common Controls v6 dependency."
}
foreach ($entry in @(@{ Manifest = $main; Id = "Lumen" }, @{ Manifest = $helper; Id = "WindowsAiHelper" })) {
    if ($entry.Manifest.assembly.msix.packageName -ne $identity.Name -or
        $entry.Manifest.assembly.msix.publisher -ne $identity.Publisher -or
        $entry.Manifest.assembly.msix.applicationId -ne $entry.Id -or
        @($manifest.Package.Applications.Application | Where-Object Id -eq $entry.Id).Count -ne 1) {
        throw "Executable and sparse-package identities do not match."
    }
}
$actions = Get-Content -LiteralPath (Join-Path $PSScriptRoot "Assets\actions.json") -Raw | ConvertFrom-Json
$agent = Get-Content -LiteralPath (Join-Path $PSScriptRoot "Assets\agentRegistration.json") -Raw | ConvertFrom-Json
if ($actions.version -ne 3 -or $actions.actions.Count -ne 1 -or
    $actions.actions[0].id -ne "LumenBrowserAgent" -or $agent.name -ne "lumen.browser" -or
    $agent.action_id -ne $actions.actions[0].id -or
    $actions.actions[0].invocation.uri -cne 'lumen:agent?agentName=${agentName.Text}&prompt=${prompt.Text}') {
    throw "The fixed browser agent and action definitions are inconsistent."
}
if ($manifest.OuterXml.Contains('com.microsoft.windows.ai.agentInfo')) {
    throw "Lumen Agent Launcher registration must remain an explicit runtime opt-in."
}
if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot "Assets\Lumen.png") -PathType Leaf)) {
    throw "The package logo is missing."
}
if ($ValidateOnly) {
    Write-Output "Lumen identity manifests and fixed action assets are consistent. MSIX SDK validation is a separate build step."
    exit 0
}
if (-not $MakeAppxPath) {
    $sdkBin = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
    $MakeAppxPath = Get-ChildItem -LiteralPath $sdkBin -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | ForEach-Object { Join-Path $_.FullName "x64\makeappx.exe" } |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
if (-not $MakeAppxPath -or -not (Test-Path -LiteralPath $MakeAppxPath -PathType Leaf)) {
    throw "Windows SDK MakeAppx.exe is unavailable. Supply -MakeAppxPath from an installed SDK."
}
$output = [IO.Path]::GetFullPath($OutputPath)
if ([IO.Path]::GetExtension($output) -ne ".msix") { throw "Identity output must be an .msix file." }
[IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($output)) | Out-Null
$temporaryBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$stage = Join-Path $temporaryBase ("lumen-identity-" + [Guid]::NewGuid().ToString("N"))
[IO.Directory]::CreateDirectory($stage) | Out-Null
try {
    Copy-Item -LiteralPath $manifestPath -Destination (Join-Path $stage "AppxManifest.xml")
    Copy-Item -LiteralPath (Join-Path $PSScriptRoot "Assets") -Destination (Join-Path $stage "Assets") -Recurse
    # Sparse packages reference external executables; /nv is required by Microsoft.
    rtk proxy $MakeAppxPath pack /o /nv /d $stage /p $output
    if ($LASTEXITCODE -ne 0) { throw "MakeAppx failed to build the sparse identity package." }
    Write-Output "Built unsigned identity package: $output"
} finally {
    $resolvedStage = [IO.Path]::GetFullPath($stage)
    if (-not $resolvedStage.StartsWith($temporaryBase, [StringComparison]::OrdinalIgnoreCase) -or
        $resolvedStage -eq $temporaryBase) { throw "Refusing to remove an unexpected identity staging path." }
    Remove-Item -LiteralPath $resolvedStage -Recurse -Force
}
