$ErrorActionPreference='Stop'
$env:LUMEN_COMPILED_ENRICHMENT_TEST='1'
& bun test ./.superpowers/task14c-diagnostic-runtime.test.ts
exit $LASTEXITCODE
