$ErrorActionPreference = 'Stop'
$taskPaths = @(
  'workers/enrichment-worker.ts', 'workers/enrichment-runtime.test.ts', 'patches/rivetkit@2.3.10.patch', 'bun.lock',
  'node_modules/@rivetkit/rivetkit-wasm/pkg/rivetkit_wasm.js', 'node_modules/rivetkit/dist/tsup/mod.js',
  'node_modules/@rivetkit/rivetkit-wasm/pkg/rivetkit_wasm_bg.wasm',
  'src-tauri/binaries/lumen-enrichment-x86_64-pc-windows-msvc.exe',
  'src-tauri/binaries/lumen-rivet-engine-x86_64-pc-windows-msvc.exe'
)
$taskFiles = foreach ($taskPath in $taskPaths) {
  $taskFull = (Resolve-Path -LiteralPath $taskPath).Path
  $taskStream = [IO.File]::OpenRead($taskFull)
  try { $taskDigest = [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($taskStream)).Replace('-','').ToLowerInvariant() } finally { $taskStream.Dispose() }
  [pscustomobject]@{path=$taskPath;bytes=(Get-Item -LiteralPath $taskFull).Length;sha256=$taskDigest}
}
$taskOwned = @(Get-CimInstance Win32_Process | Where-Object {
  $_.ExecutablePath -like '*3505*Lumen*' -or $_.ExecutablePath -like '*CodexBuilds*Lumen*production-readiness*'
} | Select-Object ProcessId,ParentProcessId,Name,CreationDate,ExecutablePath)
$taskListeners = @(Get-NetTCPConnection -LocalPort 1420,26460,26461,26462,26463,26470 -State Listen -ErrorAction SilentlyContinue | Select-Object LocalPort,LocalAddress,OwningProcess)
$taskHeavy = @(Get-CimInstance Win32_Process | Where-Object { $_.Name -in @('cargo.exe','rustc.exe','cl.exe','link.exe','bun.exe','lumen.exe','lumen-enrichment-x86_64-pc-windows-msvc.exe','lumen-rivet-engine-x86_64-pc-windows-msvc.exe') } | Select-Object ProcessId,ParentProcessId,Name,CreationDate,ExecutablePath)
$taskHost = Get-CimInstance Win32_OperatingSystem | Select-Object Caption,Version,BuildNumber,OSArchitecture,FreePhysicalMemory,TotalVisibleMemorySize
$taskVolumes = Get-Volume -DriveLetter C,D | Select-Object DriveLetter,Size,SizeRemaining
[pscustomobject]@{at=[DateTime]::UtcNow.ToString('o');host=$taskHost;volumes=$taskVolumes;owned=$taskOwned;heavy=$taskHeavy;listeners=$taskListeners;files=$taskFiles} | ConvertTo-Json -Depth 7
