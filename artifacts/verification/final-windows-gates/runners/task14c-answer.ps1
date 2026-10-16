$ErrorActionPreference = 'Stop'
$env:LUMEN_ANSWER_NATIVE_BINARY = '[native-target]/debug/deps/lumen_lib-4843514622e33193.exe'
$env:CARGO_TARGET_DIR = '[native-target]'
$taskExpected = Get-Content -LiteralPath '.superpowers/sdd/2026-10-12-production-readiness/task14c-evidence/native-inventory-binary.json' -Raw | ConvertFrom-Json
$taskHasher = [Security.Cryptography.SHA256]::Create()
try { $taskHash = [BitConverter]::ToString($taskHasher.ComputeHash([IO.File]::ReadAllBytes($env:LUMEN_ANSWER_NATIVE_BINARY))).Replace('-','').ToLowerInvariant() }
finally { $taskHasher.Dispose() }
if ($taskHash -cne $taskExpected.sha256) { throw 'Explicit final native binary differs from refreshed inventory.' }
[pscustomobject]@{binary=$env:LUMEN_ANSWER_NATIVE_BINARY;sha256=$taskHash;source=$taskExpected.source;bytes=$taskExpected.bytes} | ConvertTo-Json
& bun run test:answer-native
exit $LASTEXITCODE
