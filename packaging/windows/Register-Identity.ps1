param(
    [Parameter(Mandatory)][string]$PackagePath,
    [Parameter(Mandatory)][string]$InstallDirectory
)

$ErrorActionPreference = "Stop"
$package = (Resolve-Path -LiteralPath $PackagePath).Path
$install = (Resolve-Path -LiteralPath $InstallDirectory).Path
if (-not (Test-Path -LiteralPath (Join-Path $install "lumen.exe") -PathType Leaf) -or
    -not (Test-Path -LiteralPath (Join-Path $install "windows-ai\lumen-windows-ai.exe") -PathType Leaf)) {
    throw "Select the Lumen installation directory containing the main executable and staged Windows AI helper."
}
$signature = Get-AuthenticodeSignature -LiteralPath $package
if ($signature.Status -ne "Valid" -or $signature.SignerCertificate.Subject -ne "CN=Bridgehammer") {
    throw "The identity package must have a valid signature from the existing trusted Bridgehammer certificate."
}
Add-Type -AssemblyName System.IO.Compression.FileSystem
$archive = [IO.Compression.ZipFile]::OpenRead($package)
try {
    $entry = $archive.GetEntry("AppxManifest.xml")
    if (-not $entry -or $entry.Length -gt 65536) { throw "The identity package manifest is missing or invalid." }
    $reader = [IO.StreamReader]::new($entry.Open())
    try { [xml]$manifest = $reader.ReadToEnd() } finally { $reader.Dispose() }
    if ($manifest.Package.Identity.Name -ne "Bridgehammer.Lumen" -or
        $manifest.Package.Identity.Publisher -ne "CN=Bridgehammer") { throw "Select the Lumen sparse identity package." }
} finally { $archive.Dispose() }
Add-AppxPackage -Path $package -ExternalLocation $install
$registered = Get-AppxPackage -Name "Bridgehammer.Lumen"
if (-not $registered) { throw "Windows did not report the Lumen identity package after registration." }
$registered | Select-Object Name, PackageFamilyName, Version
Write-Output "Restart Lumen to probe main and helper identity. Agent Launcher registration still requires the explicit Lumen setting."
