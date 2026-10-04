param(
    [Parameter(Mandatory)][string]$PackagePath,
    [Parameter(Mandatory)][ValidatePattern('^[A-Fa-f0-9]{40}$')][string]$CertificateThumbprint,
    [string]$SignToolPath
)

$ErrorActionPreference = "Stop"
$package = (Resolve-Path -LiteralPath $PackagePath).Path
if ([IO.Path]::GetExtension($package) -ne ".msix") { throw "Select Lumen's built .msix identity package." }
$certificate = Get-Item -LiteralPath ("Cert:\CurrentUser\My\" + $CertificateThumbprint)
if ($certificate.Subject -ne "CN=Bridgehammer" -or -not $certificate.HasPrivateKey) {
    throw "Select an existing signing certificate with subject CN=Bridgehammer and a private key."
}
if (-not $SignToolPath) {
    $sdkBin = Join-Path ${env:ProgramFiles(x86)} "Windows Kits\10\bin"
    $SignToolPath = Get-ChildItem -LiteralPath $sdkBin -Directory -ErrorAction SilentlyContinue |
        Sort-Object Name -Descending | ForEach-Object { Join-Path $_.FullName "x64\signtool.exe" } |
        Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } | Select-Object -First 1
}
if (-not $SignToolPath -or -not (Test-Path -LiteralPath $SignToolPath -PathType Leaf)) {
    throw "Windows SDK SignTool.exe is unavailable. Supply -SignToolPath from an installed SDK."
}
rtk proxy $SignToolPath sign /fd SHA256 /sha1 $CertificateThumbprint $package
if ($LASTEXITCODE -ne 0) { throw "SignTool did not sign the identity package." }
rtk proxy $SignToolPath verify /pa $package
if ($LASTEXITCODE -ne 0) { throw "The identity signature did not verify against the existing trust store." }
