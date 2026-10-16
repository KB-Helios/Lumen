param(
  [ValidateSet('build','runtime')][string]$Mode,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{40}$')][string]$ExpectedBase
)
$ErrorActionPreference = 'Stop'
$taskDirectory = (Resolve-Path -LiteralPath '.superpowers/callback-recovery').Path
$taskEvidence = Join-Path $taskDirectory 'evidence'
New-Item -ItemType Directory -Path $taskEvidence -Force | Out-Null
$taskPrefix = Join-Path $taskEvidence $Mode
if (Test-Path -LiteralPath "$taskPrefix.started.json") { throw 'refusing repeated admitted command' }
$taskPreflightText = & powershell.exe -NoProfile -File .superpowers/callback-recovery/preflight.ps1
if ($LASTEXITCODE -ne 0) { throw 'preflight failed' }
$taskPreflightText | Set-Content -LiteralPath "$taskPrefix.preflight.json" -Encoding UTF8
$taskPreflight = ($taskPreflightText -join "`n") | ConvertFrom-Json
if (@($taskPreflight.owned).Count -ne 0 -or @($taskPreflight.heavy).Count -ne 0 -or @($taskPreflight.listeners).Count -ne 0) { throw 'owned/heavy/listener conflict; no launch' }
if ($env:LUMEN_RELEASE_BUILD) { throw 'release marker must be absent' }
$taskHead = (& rtk proxy git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or $taskHead -ne $ExpectedBase) { throw 'BASE drift; refresh source admission' }
if ($Mode -eq 'runtime') {
  $taskRestored = Get-Content -LiteralPath (Join-Path $taskEvidence 'dependency-restore.json') -Raw | ConvertFrom-Json
  if (-not $taskRestored.success) { throw 'no successful restored diagnostic build' }
  foreach ($taskRestore in $taskRestored.files) {
    $taskCurrent = @($taskPreflight.files | Where-Object { $_.path -eq $taskRestore.path })
    if ($taskCurrent.Count -ne 1 -or $taskCurrent[0].sha256 -ne $taskRestore.originalSha256 -or $taskRestore.restoredSha256 -ne $taskRestore.originalSha256) { throw 'dependency restore mismatch before runtime' }
  }
  $taskWorker = @($taskPreflight.files | Where-Object { $_.path -eq 'src-tauri/binaries/lumen-enrichment-x86_64-pc-windows-msvc.exe' })
  if ($taskWorker.Count -ne 1 -or $taskWorker[0].sha256 -ne $taskRestored.stagedSha256) { throw 'normal staging drift before runtime' }
}
$taskArgs = if ($Mode -eq 'build') { @('.superpowers/callback-recovery/build.ts') } else { @('test','./.superpowers/callback-recovery/diagnostic-runtime.test.ts') }
$taskReceipt = [ordered]@{mode=$Mode;at=[DateTime]::UtcNow.ToString('o');head=$taskHead;command=@('bun')+$taskArgs;releaseMarker=$env:LUMEN_RELEASE_BUILD;diagnosticOnly=$true;runnerPid=$PID}
$taskReceipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "$taskPrefix.started.json" -Encoding UTF8
$taskPrior = $env:LUMEN_COMPILED_ENRICHMENT_TEST
try {
  if ($Mode -eq 'runtime') { $env:LUMEN_COMPILED_ENRICHMENT_TEST='1' }
  $taskBun = (Get-Command bun).Source
  $taskProcess = Start-Process -FilePath $taskBun -ArgumentList $taskArgs -WorkingDirectory (Get-Location).Path -WindowStyle Hidden -RedirectStandardOutput "$taskPrefix.stdout.log" -RedirectStandardError "$taskPrefix.stderr.log" -PassThru
  $null = $taskProcess.Handle
  $taskReceipt.pid = $taskProcess.Id
  $taskReceipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "$taskPrefix.started.json" -Encoding UTF8
  $taskProcess.WaitForExit()
  $taskExit = $taskProcess.ExitCode
  if ($null -eq $taskExit) { throw 'missing actual exit code' }
  $taskReceipt.ended = [DateTime]::UtcNow.ToString('o')
  $taskReceipt.exitCode = $taskExit
  $taskReceipt | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath "$taskPrefix.receipt.json" -Encoding UTF8
  Get-Content -LiteralPath "$taskPrefix.stdout.log"
  Get-Content -LiteralPath "$taskPrefix.stderr.log"
  $taskReceipt | ConvertTo-Json -Depth 5
} finally {
  $env:LUMEN_COMPILED_ENRICHMENT_TEST = $taskPrior
}
exit $taskExit
