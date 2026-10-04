$ErrorActionPreference = "Stop"
Get-AppxPackage -Name "Bridgehammer.Lumen" | ForEach-Object { Remove-AppxPackage -Package $_.PackageFullName }
if (Get-AppxPackage -Name "Bridgehammer.Lumen") { throw "Windows still reports the Lumen identity package." }
Write-Output "The optional current-user Lumen identity package has been removed."
