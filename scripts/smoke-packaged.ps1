param(
    [string]$InstallerPath = "src-tauri\target\release\bundle\nsis\Lumen_0.1.0_x64-setup.exe",
    [string]$EvidencePath = "artifacts\packaged\packaged-smoke.json",
    [switch]$PreflightOnly
)

$ErrorActionPreference = "Stop"
$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$installer = (Resolve-Path (Join-Path $repositoryRoot $InstallerPath)).Path
$evidence = [IO.Path]::GetFullPath((Join-Path $repositoryRoot $EvidencePath))
$temporaryBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
$smokeRoot = Join-Path $temporaryBase ("lumen-packaged-smoke-" + [Guid]::NewGuid().ToString("N"))
$installRoot = Join-Path $smokeRoot "install"
$isolatedAppData = Join-Path $smokeRoot "appdata"
$isolatedLocalAppData = Join-Path $smokeRoot "localappdata"
$originalAppData = $env:APPDATA
$originalLocalAppData = $env:LOCALAPPDATA
$originalSmoke = $env:LUMEN_PACKAGED_SMOKE
$originalSmokeAppData = $env:LUMEN_SMOKE_APP_DATA
$originalWebViewData = $env:WEBVIEW2_USER_DATA_FOLDER
$appProcess = $null
$uninstaller = $null
$uninstalled = $false
$cleanProfilePreflight = $false
$profileCleanup = $false

function Assert-SmokeTarget([string]$Path) {
    $resolved = [IO.Path]::GetFullPath($Path)
    if (-not $resolved.StartsWith($temporaryBase, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to clean a packaged-smoke path outside the temporary directory: $resolved"
    }
}

function Get-SmokeSha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $digest = [Security.Cryptography.SHA256]::Create()
    try { return ($digest.ComputeHash($stream) | ForEach-Object { $_.ToString('x2') }) -join '' }
    finally { $stream.Dispose(); $digest.Dispose() }
}

function Assert-ComputerUseRuntime([string]$ApplicationDirectory) {
    $inventoryPath = Join-Path $repositoryRoot 'workers\computer-use-preview\.build\staged-runtime-inventory.json'
    $inventory = Get-Content -LiteralPath $inventoryPath -Raw | ConvertFrom-Json
    if ($inventory.version -ne 1) { throw 'The staged Computer Use inventory is unavailable.' }
    $expectedFiles = @()
    foreach ($entry in $inventory.files.PSObject.Properties) {
        $relativeFile = if ($entry.Name -eq 'lumen-computer-use-x86_64-pc-windows-msvc.exe') { 'lumen-computer-use.exe' } else { $entry.Name }
        $file = Join-Path $ApplicationDirectory $relativeFile
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { throw 'An installed Computer Use resource is missing.' }
        $info = Get-Item -LiteralPath $file
        if (($info.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $info.Length -ne $entry.Value.size -or (Get-SmokeSha256 $file) -ne $entry.Value.sha256) {
            throw 'An installed Computer Use resource differs from the staged checksummed inventory.'
        }
        $expectedFiles += $relativeFile.Replace('\', '/')
    }
    $actualFiles = @('lumen-computer-use.exe') + @(Get-ChildItem -LiteralPath (Join-Path $ApplicationDirectory 'computer-use-runtime') -File -Recurse | ForEach-Object {
        $_.FullName.Substring($ApplicationDirectory.Length + 1).Replace('\', '/')
    })
    if (@(Compare-Object ($expectedFiles | Sort-Object) ($actualFiles | Sort-Object)).Count) {
        throw 'The installed Computer Use runtime contains unexpected resources.'
    }
    return $expectedFiles.Count
}

function Get-LumenProfileState {
    $uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Lumen"
    $productKey = "HKCU:\Software\bridgehammer\Lumen"
    $runItem = Get-ItemProperty -LiteralPath "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
    $runProperty = $runItem.PSObject.Properties["Lumen"]
    $runValue = if ($runProperty) { $runProperty.Value } else { $null }
    $startMenu = Get-ChildItem -LiteralPath (Join-Path $env:APPDATA "Microsoft\Windows\Start Menu\Programs") -Recurse -Filter "Lumen.lnk" -ErrorAction SilentlyContinue
    $desktop = Get-ChildItem -LiteralPath ([Environment]::GetFolderPath("Desktop")) -Filter "Lumen.lnk" -ErrorAction SilentlyContinue
    $processes = Get-Process -Name "Lumen" -ErrorAction SilentlyContinue
    [ordered]@{
        uninstallRegistration = Test-Path -LiteralPath $uninstallKey
        productRegistration = Test-Path -LiteralPath $productKey
        autostart = $null -ne $runValue
        shortcuts = @($startMenu).Count + @($desktop).Count
        processes = @($processes).Count
    }
}

function Remove-SmokeRegistration {
    $uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Lumen"
    $productKey = "HKCU:\Software\bridgehammer\Lumen"
    if (Test-Path -LiteralPath $uninstallKey) {
        $uninstallItem = Get-ItemProperty -LiteralPath $uninstallKey
        $installProperty = $uninstallItem.PSObject.Properties["InstallLocation"]
        $registered = if ($installProperty) { $installProperty.Value } else { $null }
        if ($registered -and ([IO.Path]::GetFullPath($registered.Trim('"')) -eq [IO.Path]::GetFullPath($installRoot))) {
            Remove-Item -LiteralPath $uninstallKey -Recurse -Force
        }
    }
    if (Test-Path -LiteralPath $productKey) {
        $registered = (Get-Item -LiteralPath $productKey).GetValue("")
        if ($registered -and ([IO.Path]::GetFullPath($registered) -eq [IO.Path]::GetFullPath($installRoot))) {
            Remove-Item -LiteralPath $productKey -Recurse -Force
        }
    }
    $runItem = Get-ItemProperty -LiteralPath "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
    $runProperty = $runItem.PSObject.Properties["Lumen"]
    $runValue = if ($runProperty) { $runProperty.Value } else { $null }
    if ($runValue -and $runValue.Contains($installRoot, [StringComparison]::OrdinalIgnoreCase)) {
        Remove-ItemProperty -LiteralPath "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "Lumen" -Force
    }
}

try {
    $profileState = Get-LumenProfileState
    if ($profileState.uninstallRegistration -or $profileState.productRegistration -or $profileState.autostart -or $profileState.shortcuts -or $profileState.processes) {
        $profileSummary = $profileState | ConvertTo-Json -Compress
        throw "Packaged smoke requires a clean Windows user profile with no installed, running, registered, or shortcut-linked Lumen instance: $profileSummary"
    }
    $cleanProfilePreflight = $true
    if ($PreflightOnly) {
        [ordered]@{cleanProfilePreflight = $true} | ConvertTo-Json
        return
    }
    New-Item -ItemType Directory -Force -Path $installRoot, $isolatedAppData, $isolatedLocalAppData | Out-Null
    $env:APPDATA = $isolatedAppData
    $env:LOCALAPPDATA = $isolatedLocalAppData
    $env:LUMEN_SMOKE_APP_DATA = $isolatedAppData
    $env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $isolatedLocalAppData "WebView2"

    $install = Start-Process -FilePath $installer -ArgumentList @("/S", "/NS", "/D=$installRoot") -WindowStyle Hidden -Wait -PassThru
    if ($install.ExitCode -ne 0) {
        throw "The NSIS installer exited with code $($install.ExitCode)."
    }

    $application = Get-ChildItem -LiteralPath $installRoot -Recurse -Filter "Lumen.exe" -File | Select-Object -First 1
    if (-not $application) {
        throw "The installed Lumen executable was not found."
    }
    $computerUseRuntimeFiles = Assert-ComputerUseRuntime (Split-Path -Parent $application.FullName)
    $vector = Get-ChildItem -LiteralPath $installRoot -Recurse -Filter "vector.dll" -File | Select-Object -First 1
    if (-not $vector) {
        throw "The packaged sqlite-vector runtime was not found."
    }

    $env:LUMEN_PACKAGED_SMOKE = "1"
    $appProcess = Start-Process -FilePath $application.FullName -WindowStyle Hidden -PassThru
    if (-not $appProcess.WaitForExit(90000)) {
        $appProcess.Kill()
        $checkpoint = Get-Content -LiteralPath (Join-Path $isolatedAppData "startup-checkpoints.log") -ErrorAction SilentlyContinue |
            Where-Object { $_ -match '^(run|plugins-configured|setup|gateway|enrichment|windows-ai|material|checks)$' } | Select-Object -Last 1
        if (-not $checkpoint) { $checkpoint = "before-rust-entry" }
        throw "The installed Lumen smoke run did not finish within 90 seconds; last startup checkpoint: $checkpoint."
    }
    if ($appProcess.ExitCode -ne 0) {
        throw "The installed Lumen smoke run exited with code $($appProcess.ExitCode)."
    }

    $reportFile = Get-ChildItem -LiteralPath $smokeRoot -Recurse -Filter "lumen-packaged-smoke.json" -File | Select-Object -First 1
    if (-not $reportFile) {
        throw "The installed application did not produce its native smoke report."
    }
    $reportText = Get-Content -LiteralPath $reportFile.FullName -Raw
    $report = $reportText | ConvertFrom-Json
    if (-not $report.passed -or -not $report.exactVector -or -not $report.lexicalFallback -or -not $report.windowShowHide -or -not $report.diagnosticsExport -or -not $report.computerUsePackaged) {
        throw "The native packaged smoke report did not pass every required check."
    }
    if ($reportText.Contains("packaged smoke secret") -or $reportText.Contains($smokeRoot)) {
        throw "The native diagnostics report retained a secret or local path."
    }

    $uninstaller = Get-ChildItem -LiteralPath $installRoot -Recurse -File |
        Where-Object { $_.Name -match "(?i)uninstall.*\.exe$" } |
        Select-Object -First 1
    if (-not $uninstaller) {
        throw "The NSIS uninstaller was not found."
    }
    $uninstall = Start-Process -FilePath $uninstaller.FullName -ArgumentList "/S" -WindowStyle Hidden -Wait -PassThru
    if ($uninstall.ExitCode -ne 0) {
        throw "The NSIS uninstaller exited with code $($uninstall.ExitCode)."
    }
    $uninstalled = -not (Test-Path -LiteralPath $application.FullName)
    if (-not $uninstalled) {
        throw "The installed Lumen executable remained after uninstall."
    }
    Remove-SmokeRegistration
    $remainingProfileState = Get-LumenProfileState
    $profileCleanup = -not ($remainingProfileState.uninstallRegistration -or $remainingProfileState.productRegistration -or $remainingProfileState.autostart -or $remainingProfileState.shortcuts -or $remainingProfileState.processes)
    if (-not $profileCleanup) {
        throw "The packaged smoke left Lumen state in the Windows user profile."
    }

    $installerFile = Get-Item -LiteralPath $installer
    $installerHash = Get-SmokeSha256 $installer
    $signatureStatus = if (Get-Command Get-AuthenticodeSignature -ErrorAction SilentlyContinue) {
        (Get-AuthenticodeSignature -LiteralPath $installer).Status.ToString()
    } else { 'Unavailable' }
    $payload = [ordered]@{
        recordedAt = (Get-Date).ToUniversalTime().ToString("o")
        installer = $installerFile.Name
        installerBytes = $installerFile.Length
        installerSha256 = $installerHash
        signatureStatus = $signatureStatus
        cleanProfilePreflight = $cleanProfilePreflight
        exactVector = [bool]$report.exactVector
        vectorVersion = [string]$report.vectorVersion
        lexicalFallback = [bool]$report.lexicalFallback
        windowShowHide = [bool]$report.windowShowHide
        diagnosticsExport = [bool]$report.diagnosticsExport
        computerUsePackaged = [bool]$report.computerUsePackaged
        computerUseNativeStop = [bool]$report.computerUseNativeStop
        computerUseBrowser = [bool]$report.computerUseBrowser
        computerUseDesktop = [bool]$report.computerUseDesktop
        computerUseRuntimeInventoryVerified = $true
        computerUseRuntimeFiles = $computerUseRuntimeFiles
        uninstall = $uninstalled
        profileCleanup = $profileCleanup
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $evidence) | Out-Null
    $payload | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $evidence -Encoding utf8
    $payload | ConvertTo-Json -Depth 4
}
finally {
    try {
        if ($appProcess -and -not $appProcess.HasExited) {
            $appProcess.Kill()
            $appProcess.WaitForExit()
        }
        if (-not $uninstalled) {
            if (-not $uninstaller) {
                $uninstaller = Get-ChildItem -LiteralPath $installRoot -Recurse -Filter "uninstall.exe" -File -ErrorAction SilentlyContinue | Select-Object -First 1
            }
            if ($uninstaller) {
                Start-Process -FilePath $uninstaller.FullName -ArgumentList "/S" -WindowStyle Hidden -Wait | Out-Null
            }
        }
        if ($cleanProfilePreflight) {
            Remove-SmokeRegistration
        }
        Assert-SmokeTarget $smokeRoot
        if (Test-Path -LiteralPath $smokeRoot) {
            Remove-Item -LiteralPath $smokeRoot -Recurse -Force
        }
    }
    finally {
        $env:APPDATA = $originalAppData
        $env:LOCALAPPDATA = $originalLocalAppData
        $env:LUMEN_PACKAGED_SMOKE = $originalSmoke
        $env:LUMEN_SMOKE_APP_DATA = $originalSmokeAppData
        $env:WEBVIEW2_USER_DATA_FOLDER = $originalWebViewData
    }
}
