$ErrorActionPreference = 'Stop'
if ($env:LUMEN_RELEASE_BUILD) { throw 'Ordinary build must be marker-free.' }
$taskVsWhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio/Installer/vswhere.exe'
$taskVsPath = & $taskVsWhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $taskVsPath) { throw 'Visual Studio C++ build tools unavailable.' }
Import-Module (Join-Path $taskVsPath 'Common7/Tools/Microsoft.VisualStudio.DevShell.dll')
Enter-VsDevShell -VsInstallPath $taskVsPath -SkipAutomaticLocation -DevCmdArguments '-arch=x64 -host_arch=x64'
$env:CARGO_TARGET_DIR = '[native-target]'
$env:CARGO_INCREMENTAL = '0'
$env:CARGO_PROFILE_DEV_DEBUG = '0'
$env:CARGO_PROFILE_TEST_DEBUG = '0'
$env:CARGO_BUILD_JOBS = '1'
[pscustomobject]@{vs=$taskVsPath;target=$env:CARGO_TARGET_DIR;incremental=$env:CARGO_INCREMENTAL;devDebug=$env:CARGO_PROFILE_DEV_DEBUG;testDebug=$env:CARGO_PROFILE_TEST_DEBUG;jobs=$env:CARGO_BUILD_JOBS;releaseMarker=$env:LUMEN_RELEASE_BUILD;temp=$env:TEMP;tmp=$env:TMP} | ConvertTo-Json
& bun run tauri build
exit $LASTEXITCODE
