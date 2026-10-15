param(
    [Parameter(Mandatory)][ValidateSet('List','Extract')][string]$Action,
    [Parameter(Mandatory)][string]$Installer,
    [string]$Destination
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$tool = $env:LUMEN_7ZIP
if (-not $tool) { $tool = (Get-Command 7z.exe -CommandType Application -ErrorAction Stop).Source }
$arguments = if ($Action -eq 'List') { @('l','-slt','-ba','-sccUTF-8',$Installer) } else {
    if (-not $Destination -or -not (Test-Path -LiteralPath $Destination -PathType Container)) { throw 'A fresh owned extraction directory is required.' }
    @('x','-y','-sccUTF-8',"-o$Destination",$Installer)
}
& $tool @arguments
if ($LASTEXITCODE -ne 0) { throw "Archive $Action failed ($LASTEXITCODE)." }
