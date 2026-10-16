param(
    [Parameter(Mandatory)][string]$PackagePath,
    [Parameter(Mandatory)][ValidatePattern('^[A-Fa-f0-9]{40}$')][string]$CertificateThumbprint,
    [Parameter(Mandatory)][string]$TimestampUrl,
    [ValidateSet('CurrentUser','LocalMachine')][string]$CertificateStore = 'CurrentUser',
    [string]$SignToolPath
)

$ErrorActionPreference = "Stop"
$package = (Resolve-Path -LiteralPath $PackagePath).Path
if ([IO.Path]::GetExtension($package) -ne ".msix") { throw "Select Lumen's built .msix identity package." }
[xml]$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'AppxManifest.xml') -Raw
$subject = $manifest.Package.Identity.Publisher
foreach ($fusion in @('lumen.manifest','helper.manifest')) {
    [xml]$document = Get-Content -LiteralPath (Join-Path $PSScriptRoot $fusion) -Raw
    if ($document.assembly.msix.publisher -cne $subject) { throw 'Sparse identity and both executable fusion publishers must agree before building/signing.' }
}
$names = @('LUMEN_SIGN_CERT_SHA1','LUMEN_SIGN_CERT_SUBJECT','LUMEN_SIGN_CERT_STORE','LUMEN_SIGN_TIMESTAMP_URL','LUMEN_SIGNTOOL')
$saved = @{}
foreach ($name in $names) { $saved[$name] = [Environment]::GetEnvironmentVariable($name) }
try {
    $env:LUMEN_SIGN_CERT_SHA1 = $CertificateThumbprint.ToUpperInvariant()
    $env:LUMEN_SIGN_CERT_SUBJECT = $subject
    $env:LUMEN_SIGN_CERT_STORE = $CertificateStore
    $env:LUMEN_SIGN_TIMESTAMP_URL = $TimestampUrl
    $env:LUMEN_SIGNTOOL = $SignToolPath
    & powershell.exe -NoProfile -File (Join-Path $PSScriptRoot '../../scripts/sign-release.ps1') -Action Sign -Path $package
    if ($LASTEXITCODE -ne 0) { throw 'Identity signing/signature validation failed.' }
} finally {
    foreach ($name in $names) { [Environment]::SetEnvironmentVariable($name,$saved[$name]) }
}
