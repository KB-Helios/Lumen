param([Parameter(Mandatory=$true)][ValidateSet('resume','dead','hung','improvement','consumer')][string]$Gate)
$ErrorActionPreference='Stop'
$taskTests = @{
 resume='gateway::enrichment::tests::rivet_worker_resumes_without_duplicate_jobs'
 dead='gateway::enrichment::tests::rivet_worker_replaces_dead_engine_and_stops_owned_children'
 hung='gateway::enrichment::tests::rivet_worker_replaces_hung_owned_engine_without_false_readiness'
 improvement='gateway::enrichment::tests::improvement_worker_recovers_crash_and_fences_old_generation'
 consumer='search::indexing::freshness_tests::compiled_enrichment_consumer_indexes_scanned_pdf_image_audio_video_and_cancels_stop'
}
$taskDirectory=(Resolve-Path -LiteralPath '.superpowers/callback-recovery').Path
$taskEvidence=Join-Path $taskDirectory 'evidence'
$taskLabel="native-$Gate"
$taskPrefix=Join-Path $taskEvidence $taskLabel
if (Test-Path -LiteralPath "$taskPrefix.started.json") { throw 'refusing repeated native gate' }
function TaskHash([string]$Path) {
 $taskStream=[IO.File]::OpenRead((Resolve-Path -LiteralPath $Path).Path)
 try { [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($taskStream)).Replace('-','').ToLowerInvariant() } finally { $taskStream.Dispose() }
}
$taskPreflightText=& powershell.exe -NoProfile -File .superpowers/callback-recovery/preflight.ps1
if ($LASTEXITCODE -ne 0) { throw 'preflight failed' }
$taskPreflightText | Set-Content -LiteralPath "$taskPrefix.preflight.json" -Encoding UTF8
$taskPreflight=($taskPreflightText -join "`n") | ConvertFrom-Json
if (@($taskPreflight.owned).Count -or @($taskPreflight.heavy).Count -or @($taskPreflight.listeners).Count) { throw 'preflight process/port conflict' }
$taskExpected=Get-Content -LiteralPath '.superpowers/callback-recovery/preparation-preflight.json' -Raw | ConvertFrom-Json
foreach ($taskFile in $taskExpected.files) {
 if (@($taskPreflight.files | Where-Object { $_.path -eq $taskFile.path -and $_.sha256 -eq $taskFile.sha256 }).Count -ne 1) { throw "staging/dependency/source identity mismatch: $($taskFile.path)" }
}
$taskInventory=Get-Content -LiteralPath '.superpowers/sdd/2026-10-12-production-readiness/task14c-evidence/native-inventory-binary.json' -Raw | ConvertFrom-Json
if ((TaskHash $taskInventory.binary) -ne '313ed3e6a94151fda08d710612054f9285c51f7b292bd0da4ac103b83b94799c') { throw 'exact native binary hash mismatch' }
$taskSources=Get-Content -LiteralPath 'artifacts/verification/final-windows-gates/product-source-hashes.json' -Raw | ConvertFrom-Json
$taskTracked=@(& rtk proxy git ls-files src-tauri/src)
$taskArchived=@($taskSources.files | Where-Object { $_.path -like 'src-tauri/src/*' } | ForEach-Object { $_.path })
if (@(Compare-Object $taskTracked $taskArchived).Count) { throw 'native source inventory coverage differs from tracked files' }
$taskVerified=0
foreach ($taskFile in $taskSources.files | Where-Object { $_.path -like 'src-tauri/src/*' -or $_.path -in @('src-tauri/Cargo.toml','src-tauri/Cargo.lock','src-tauri/build.rs') }) {
 if ((TaskHash $taskFile.path) -ne $taskFile.sha256) { throw "compiled native source bytes changed: $($taskFile.path)" }
 $taskVerified++
}
if ($taskVerified -ne ($taskTracked.Count + 3)) { throw 'native source/Cargo/build identity coverage is incomplete' }
$taskHead=(& rtk proxy git rev-parse HEAD).Trim()
if ($taskHead -ne 'ae412fb5587f87aa4914ff429cf0abf8e11dbee1') { throw 'source BASE drift' }
if ($env:LUMEN_RELEASE_BUILD) { throw 'release marker must be absent' }
$taskTemp=Join-Path $taskDirectory "native-fixture-$Gate"
if (Test-Path -LiteralPath $taskTemp) { throw 'native fixture root already exists' }
New-Item -ItemType Directory -Path $taskTemp | Out-Null
$taskLogs=Join-Path $taskEvidence "$taskLabel-logs"
New-Item -ItemType Directory -Path $taskLogs | Out-Null
$taskArgs=@($taskTests[$Gate],'--ignored','--exact','--test-threads=1','--nocapture')
$taskReceipt=[ordered]@{gate=$Gate;test=$taskTests[$Gate];started=[DateTime]::UtcNow.ToString('o');head=$taskHead;binary=$taskInventory.binary;binarySha256=$taskInventory.sha256;compiledSource=$taskInventory.source;nativeSourceFilesVerified=$taskVerified;normalStagedWorkerSha256='4a02bdfe85051badd0d98e52067c4dad0b16c20bfe237cf0d21b6a34727d7dc0';args=$taskArgs;fixtureRoot=$taskTemp;releaseMarker=$env:LUMEN_RELEASE_BUILD;originalStandaloneStagedGate='FAILED_OPEN';runnerPid=$PID}
$taskReceipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "$taskPrefix.started.json" -Encoding UTF8
$taskPriorTemp=$env:TEMP; $taskPriorTmp=$env:TMP
$taskLinks=@{}
try {
 $env:TEMP=$taskTemp; $env:TMP=$taskTemp
 $taskProcess=Start-Process -FilePath $taskInventory.binary -ArgumentList $taskArgs -WorkingDirectory (Get-Location).Path -WindowStyle Hidden -RedirectStandardOutput "$taskPrefix.stdout.log" -RedirectStandardError "$taskPrefix.stderr.log" -PassThru
 $null=$taskProcess.Handle
 $taskReceipt.pid=$taskProcess.Id
 $taskReceipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "$taskPrefix.started.json" -Encoding UTF8
 while (-not $taskProcess.HasExited) {
  # Hard-link only owned fixture log files so test teardown cannot remove failure evidence.
  foreach ($taskLog in Get-ChildItem -LiteralPath $taskTemp -Recurse -File -Filter 'rivet-*.log' -ErrorAction SilentlyContinue) {
   if (-not $taskLinks.ContainsKey($taskLog.FullName)) {
    $taskName=($taskLog.FullName.Substring($taskTemp.Length).TrimStart('\') -replace '[\\/:]','_')
    try { New-Item -ItemType HardLink -Path (Join-Path $taskLogs $taskName) -Target $taskLog.FullName -ErrorAction Stop | Out-Null; $taskLinks[$taskLog.FullName]=$taskName } catch { $_ | Out-String | Add-Content -LiteralPath "$taskPrefix.log-link-errors.log" }
   }
  }
  $null=$taskProcess.WaitForExit(100)
 }
 $taskProcess.WaitForExit()
 $taskReceipt.ended=[DateTime]::UtcNow.ToString('o')
 $taskReceipt.exitCode=$taskProcess.ExitCode
 $taskOutput=Get-Content -LiteralPath "$taskPrefix.stdout.log" -Raw
 $taskReceipt.matchedOneActualPass=($taskReceipt.exitCode -eq 0 -and $taskOutput -match 'test result: ok\. 1 passed; 0 failed; 0 ignored;')
 $taskReceipt.retainedLogs=$taskLinks.Values
 $taskReceipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "$taskPrefix.receipt.json" -Encoding UTF8
} finally { $env:TEMP=$taskPriorTemp; $env:TMP=$taskPriorTmp }
$taskCleanupText=& powershell.exe -NoProfile -File .superpowers/callback-recovery/preflight.ps1
if ($LASTEXITCODE -ne 0) { throw 'cleanup read failed' }
$taskCleanupText | Set-Content -LiteralPath "$taskPrefix.cleanup.json" -Encoding UTF8
$taskCleanup=($taskCleanupText -join "`n") | ConvertFrom-Json
if (@($taskCleanup.owned).Count -or @($taskCleanup.heavy).Count -or @($taskCleanup.listeners).Count) { throw 'postgate owned process/listener remains; no further gate admitted' }
Get-Content -LiteralPath "$taskPrefix.stdout.log"
Get-Content -LiteralPath "$taskPrefix.stderr.log"
$taskReceipt | ConvertTo-Json -Depth 5
if (-not $taskReceipt.matchedOneActualPass) { if ($taskReceipt.exitCode -ne 0) { exit $taskReceipt.exitCode }; throw 'gate did not match exactly one actual passing test' }
