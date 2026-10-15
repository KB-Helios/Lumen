# Task 11: bounded native document previews

Date: 2026-10-15. Base: `4c30aa0e1539d82ce27d68f9a180ace26629c9cb` on `codex/production-readiness`. This is source/native-fixture and jsdom evidence; packaged/native UI, live-provider, full release and performance/gallery acceptance are not claimed. Docker acceptance remains pending by user instruction. No Docker lifecycle/staging, ordinary app/bootstrap, credentials, provider, focus or installation operations were performed.

Source lineage: the preview byte-cutoff fix is `589c057cdd9824755cc88bfb60731bcc67b39c65`; the bounded-preview implementation is `0315374536ca12afb06aa444de5e406082230ae7`; and the reviewed XLSX value correction is `57d57f1d75c23ed8e475ba0b4070eb06d7f3d861`. This preserves the validated historical report and its source/fix provenance without broadening its acceptance claims.

## Result and ownership

The existing native preview command now receives `IndexRuntime`, stays on the blocking lane and checks preview privacy before work and again before delivery. PDF/DOCX/PPTX reuse a bounded first indexed excerpt, never a selection-time PDF/Office parse. Missing, pending, metadata-only, legacy-version, changed, oversized or revoked content stays passive. Existing service abort, known-file/root grant and controller selection fences are preserved.

Admission validates the original root/path chain for symlinks and Windows reparse points before canonicalization, then checks confinement and current configured local root policy. The index owns generation/Stop, stable path/root, source SHA-256, file and chunk hash/revision, and final-record equality checks. Source reads are capped at 64 MiB and occur outside the short index commit guard. Freshness checks are not an atomic filesystem snapshot. SQLite hydrates at most 65,536 text characters (at most 256 KiB), and native code retains at most 65,536 UTF-8 bytes at a character boundary. No cloud grant is needed for local preview.

Office and PDF extraction now consume the exact captured buffer used for their hash, rather than reopening the pathname. `lumen-extract-v2` is required for cached text previews. A legacy v1 record is passive; ordinary root admission in a fresh worker re-extracts it under v2, preserving stable IDs, pins and open history. There is no schema migration, index deletion or history deletion. This does not bound expanded PDF streams or total output in the pre-existing background PDF parser.

XLSX decoding lives in the shared extraction owner and consumes captured bytes. It reads only `xl/sharedStrings.xml` and `xl/worksheets/sheet1.xml`; the visible label identifies `sheet1.xml`, A1:L40 and cached values. It preserves shared/inline rich strings, sparse coordinates, numeric/boolean/error/date strings and cached formula values. It does not evaluate formulas or follow relationships/links/macros. Limits are 40 rows, 12 columns, 64 KiB aggregate UTF-8 body including headings, 16 MiB actual aggregate decompressed XML, 64 levels of XML nesting and 65,536 shared strings. Invalid references/XML/ZIP/DTD, size mismatches and oversize bodies fail to a passive state. ZIP entries are never extracted to disk.

The native DTO adds optional nullable rows/columns. Native-adapter and public Zod schemas share dimensions, per-value and aggregate UTF-8 checks. Document excerpts and table strings use escaped React text. Existing no-content placeholders remain. Text keeps its entire valid 64 KiB prefix, with truncation metadata and a visible notice outside the body budget. Task 12's incomplete trailing UTF-8 decoder correction is deliberately not included.

## TDD and failed attempts

All shell commands used explicit `powershell.exe`, `login:false` and RTK after initial required instruction reads. Native commands used `.superpowers/run-native.ps1`, D-target `D:/CodexBuilds/Lumen/production-readiness`, `-j 1`; no unrelated process was stopped. Initial unrelated `cargo test --workspace` processes (PIDs 33180/7644) were observed and preserved. C/D free space was checked before builds (118.9/342.2 GB), and later remained 119.4/342.1 GB.

1. `rtk bun run test -- src/features/preview/PreviewContent.test.tsx`: exit 1, `Test Files 1 failed (1); Tests 4 failed (4)`. Three literal document strings were absent because placeholders ignored text; the aggregate UTF-8 table payload was wrongly accepted. These recovered tests were preserved.
2. `rtk proxy powershell.exe -NoProfile -File .superpowers/run-native.ps1 test --manifest-path src-tauri/Cargo.toml --all-features -j 1 search::preview::tests::text_preview_is_bounded -- --exact --nocapture`: exit 1, `test result: FAILED. 0 passed; 1 failed; 364 filtered out`. The existing text body contained its appended truncation notice, violating the exact retained-prefix assertion.
3. Test-first document/extraction API run (`rtk proxy powershell.exe -NoProfile -File .superpowers/run-native.ps1 test --manifest-path src-tauri/Cargo.toml --all-features -j 1 document_preview -- --nocapture`): exit 1, missing `get_indexed_preview`, `capture_document_preview`, `document_preview_is_current`, `xlsx_preview`, `read_office_xml`. This established the new seams were absent before implementation.
4. First frontend green snapshot: `rtk bun run test -- src/features/preview/PreviewContent.test.tsx src/features/preview/PreviewPane.test.tsx src/services/search/development-file-search-service.test.ts`, exit 0, 78 tests/3 files. Extra contract/abort cases were added afterward; this is not the final snapshot.
5. Added frontend mocks initially returned preview data for root/status commands and left one admission unresolved: exit 1, 12 failures/81 passes. Fixed only test command routing; assertions and timeouts unchanged. Subsequent final runs passed 93/93.
6. Legacy-version regression (`rtk proxy powershell.exe -NoProfile -File .superpowers/run-native.ps1 test --manifest-path src-tauri/Cargo.toml --all-features -j 1 legacy_extraction_records_cannot_supply_document_preview_bodies -- --nocapture`): exit 1, `assertion failed: preview.text.is_none()`. Required captured-buffer extraction and v2-only preview admission; later legacy passive-to-worker-refresh/pin/history assertions pass.
7. One test compile attempt failed on `format!("{:x}", Sha256::digest(...))` because this pinned digest array has no `LowerHex`; test digest formatting now follows the existing byte formatting pattern.
8. Earlier search run: exit 1, `119 passed; 1 failed; 2 ignored`. Real PPTX escaping exposed shared XML extraction inserting spaces around entity fragments. The literal `<script>` assertion was retained and shared joining corrected. Real PDF, Office and reparse/admission tests then passed.
9. Chunk provenance regression (`rtk proxy powershell.exe -NoProfile -File .superpowers/run-native.ps1 test --manifest-path src-tauri/Cargo.toml --all-features -j 1 cached_document_body_is_bounded_in_utf8_and_refuses_mismatched_chunk_provenance -- --nocapture`): exit 1, `assertion failed: preview.text.is_none()`. Preview query now requires chunk hash and revision to match its file, with a separate bound before hydration. Hash and revision rejection are both asserted.
10. Pinned quick-xml 0.41 initially warned that `decode_and_unescape_value` is deprecated; replaced with its documented `decoded_and_normalized_value(XmlVersion::Implicit1_0, decoder)`. Strict Clippy then found three new `collapsible_if` warnings; corrected with let-chains, without suppressions.
11. A nested PowerShell `-Command`/pipeline log attempt lost the harness `--` delimiter: exit 1, `error: unexpected argument '--nocapture' found`. The final invocation uses direct `-File`, without the unnecessary harness argument. A `Get-FileHash` evidence attempt reported the cmdlet unavailable; source hashes were obtained successfully using .NET SHA-256. No acceptance is drawn from either failed evidence command.

## Final verification

Final frozen-source native command and raw result:

```text
rtk proxy powershell.exe -NoProfile -File .superpowers/run-native.ps1 test --manifest-path src-tauri/Cargo.toml --all-features -j 1 search::
test result: ok. 127 passed; 0 failed; 2 ignored; 0 measured; 252 filtered out; finished in 47.68s
src/main.rs, cliproxy_client.rs and file_switch.rs: 0 matching tests (15 and 10 integration tests filtered out)
exit 0
```

Full captured stdout/stderr is in the local ignored `task-11-native-frozen.log` alongside this report. It supersedes the earlier 127-pass run (31.58s) before the final direct-production privacy test and additional chunk revision assertion. No source changed after the final run began.

Final strict Clippy ran after that frozen-source native run:

```text
rtk proxy powershell.exe -NoProfile -File .superpowers/run-native.ps1 clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -j 1 -- -D warnings
Checking lumen v0.1.0 (C:\Users\kevin\.codex\worktrees\3505\Lumen\src-tauri)
Finished `dev` profile [unoptimized] target(s) in 2m 45s
no diagnostics; exit 0
```

The earlier strict Clippy pass (20.92s) preceded the last test-only SQL revision assertion and is superseded by this final pass. Final `rtk git diff --cached --check`: no diagnostics, exit 0.

The focused frontend final command is:

```text
rtk bun run test -- src/features/preview/PreviewContent.test.tsx src/features/preview/PreviewPane.test.tsx src/services/search/development-file-search-service.test.ts
Test Files  3 passed (3)
Tests       93 passed (93)
Duration    19.97s
exit 0
```

Fresh `rtk bun run typecheck`: `$ tsc --noEmit`, exit 0. Scoped `rtk bun x eslint --max-warnings 0 src/features/preview/PreviewContent.tsx src/features/preview/PreviewContent.test.tsx src/services/search/search.types.ts src/services/search/development-file-search-service.ts src/services/search/development-file-search-service.test.ts`: no diagnostics, exit 0.

Scoped formatting command (both formatting and `--check` used):

```text
rtk proxy powershell.exe -NoProfile -Command 'rustfmt --check --edition 2024 --config skip_children=true src-tauri/src/search/extraction.rs src-tauri/src/search/index.rs src-tauri/src/search/indexing.rs src-tauri/src/search/mod.rs src-tauri/src/search/preview.rs src-tauri/src/search/types.rs src-tauri/src/search/document_preview_tests.rs'
no diagnostics; exit 0
```

The source tests include real ZIP Office/XLSX and valid small PDF fixture bytes; captured PDF/Office parsing after pathname replacement; v1 passive-to-v2 refresh with durable pins/history; same-size/same-mtime source replacement; file/chunk provenance, revoked root, generation/index deletion, preview privacy at actual production admission; Windows original-path symlinks and inside/outside junctions; absent content; exact 4 MiB image limit; unchanged legacy passive formats; sparse/rich/shared/boolean/cached formula table decoding; malformed, oversized and forged-size archives; and passive rendering, DTO dimensions/aggregate UTF-8 and in-flight abort/grant/selection fences.

Two explicitly ignored native tests remain unaccepted: `search::embedding::tests::local_http_proxy_probe_embedding` (isolated proxy regression only) and `search::indexing::freshness_tests::compiled_enrichment_consumer_indexes_scanned_pdf_image_audio_video_and_cancels_stop` (explicit compiled integration after sidecar staging). This task does not stage or invoke them.

Full frontend suites, whole-tree formatting/ESLint baselines, installed-Edge e2e, gallery/recording/performance regeneration, Tauri release/package build and live/native UI acceptance remain Task 14 gates. No production-ready claim is made. No provider, permissions, grants or ordinary user data were changed. The root's untracked production-readiness plan is excluded from the commit.

## Frozen source SHA-256

SHA-256 over exact working-tree bytes (Windows checkout line endings); obtained successfully using `[Security.Cryptography.SHA256]::Create().ComputeHash([IO.File]::ReadAllBytes(...))`, exit 0:

```text
docs/architecture/search-service.md 4857dc4b2ef52945915a35af99c69347242a142406afdecd8c55df96d8c884f3
src-tauri/src/search/extraction.rs bf8fc568b8ad90d013418ab9c4fcfeddfae41898cc65b7588ee102cbaaa3ba2a
src-tauri/src/search/index.rs ac5b430b3f1e3cb83c318ddb4533cae366cf02e792ee56c949b8b8b8a9cb102d
src-tauri/src/search/indexing.rs 0522ef1381ebe3828e514834f1a6b057118e70bb53db49a3ba138147104ebb8b
src-tauri/src/search/mod.rs 963b219adfe29d76e0b8e934bacd19ae4206991711d44bfc65e2a5e5f2be9376
src-tauri/src/search/preview.rs 864c54ec113134c1adf847daac36f5fad8c4bb6633549c0994fc178533a60997
src-tauri/src/search/types.rs 7aca6d7326f7c468fbbb9886c8cbcd713e485d4cef1ed2ceb06b5383f8ed958a
src-tauri/src/search/document_preview_tests.rs 568306f02541aa4b4d7fe17d27f6c40c51fa4e6628c9217bb392d7aa1b8f6add
src/features/preview/PreviewContent.tsx dcc6695ba722a7738651ec4845732cf05b02d9af4180437749402a1eaad56262
src/features/preview/PreviewContent.test.tsx 002ce22adb14adfe11b599741a2812bba41c7cc968b77a3cfa58db10a7603805
src/services/search/search.types.ts 44360433b9f60cdaa80301b551b6b32d96655db68eea9ed8ebd4ba5aa5c47bc0
src/services/search/development-file-search-service.ts 969d8a9c7cfd44347415e328b31ee9702135c6550f11f1e4db79493d4cf079d4
src/services/search/development-file-search-service.test.ts 4ef0cca548c91cc7ec42702cc84d06d24d882a59ac15d3e5d2533b91fb3588de
```

## Fix round 1: XLSX value fidelity

2026-10-15; fix base `0315374536ca12afb06aa444de5e406082230ae7`. Both Important findings in `task-11-review.md` were verified against the decoder and real ZIP fixtures before product changes. Only `src-tauri/src/search/extraction.rs` and this existing tracked report change in this round. The original snapshot above remains historical evidence.

Shared and inline string readers now track phonetic-subtree ancestry and exclude `<rPh>` text from the cell's plain/rich base value. This follows the distinction between base strings and pronunciation annotations in Microsoft's [PhoneticRun documentation](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.spreadsheet.phoneticrun?view=openxml-3.0.1). Worksheet cells separately track whether a `<v>` or supported inline `<is>` exists: absent results are blank before type dispatch, while present empty/malformed boolean/shared-index values still reject. Formula text is never evaluated; [CellValue documentation](https://learn.microsoft.com/en-us/dotnet/api/documentformat.openxml.spreadsheet.cellvalue?view=openxml-3.0.1) distinguishes the stored last calculation result from the formula itself.

Four real ZIP regressions assert: shared plain/rich strings with phonetic hints retain exactly `東京`; inline plain/rich strings retain the same exact value; typed boolean/shared formulas and empty shared cells without cached results remain blank beside numeric neighbor `7`; present empty/invalid boolean and empty/non-numeric/out-of-range shared indices still reject the whole sheet. Assertions, limits and deadlines were not weakened.

Observed RED before either production fix:

```text
rtk proxy powershell.exe -NoProfile -File .superpowers/run-native.ps1 test --manifest-path src-tauri/Cargo.toml --all-features -j 1 review_xlsx -- --nocapture
Finished `test` profile [unoptimized] target(s) in 2m 09s
running 4 tests
called `Result::unwrap()` on an `Err` value: Failed { ... message: "Invalid boolean value" }
shared and inline assertion output:
  left: ["東京とうきょう", "東京とうきょう"]
 right: ["東京", "東京"]
review_xlsx_present_malformed_typed_values_still_reject_the_sheet ... ok
test result: FAILED. 1 passed; 3 failed; 0 ignored; 0 measured; 381 filtered out; finished in 0.01s
exit 1
```

After only the phonetic correction, its focused GREEN command/result was:

```text
rtk proxy powershell.exe -NoProfile -File .superpowers/run-native.ps1 test --manifest-path src-tauri/Cargo.toml --all-features -j 1 phonetic_hints -- --nocapture
Finished `test` profile [unoptimized] target(s) in 2m 06s
test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 383 filtered out; finished in 0.01s
exit 0
```

After both corrections and scoped formatting, the frozen amended source passed:

```text
rtk proxy powershell.exe -NoProfile -File .superpowers/run-native.ps1 test --manifest-path src-tauri/Cargo.toml --all-features -j 1 search::extraction::tests
Finished `test` profile [unoptimized] target(s) in 1m 39s
test result: ok. 13 passed; 0 failed; 0 ignored; 0 measured; 372 filtered out; finished in 0.71s
exit 0

rtk proxy powershell.exe -NoProfile -File .superpowers/run-native.ps1 test --manifest-path src-tauri/Cargo.toml --all-features -j 1 search::indexing::document_preview_tests
Finished `test` profile [unoptimized] target(s) in 1.11s
test result: ok. 8 passed; 0 failed; 0 ignored; 0 measured; 377 filtered out; finished in 0.34s
exit 0

rtk proxy powershell.exe -NoProfile -File .superpowers/run-native.ps1 clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -j 1 -- -D warnings
Finished `dev` profile [unoptimized] target(s) in 43.11s
no diagnostics; exit 0

rtk proxy powershell.exe -NoProfile -Command 'rustfmt --check --edition 2024 --config skip_children=true src-tauri/src/search/extraction.rs; git diff --check'
no formatting/whitespace errors; exit 0
```

The source SHA-256 after formatting, before these final covering checks, is `6cdbc5916867086473c82246811e930ec047783664f63ec1b9ed2297e671412b` for `src-tauri/src/search/extraction.rs`, obtained successfully using .NET SHA-256 over exact working-tree bytes (exit 0). No source changed afterward. Native checks ran serially through the existing D-target wrapper. Initial unrelated `cargo build -p ws-embed` processes were observed and left untouched; initial C/D free space was 118.5/341.5 GB.

Existing 16 MiB actual XML/decompression, depth/shared-string, 40-by-12, 64 KiB UTF-8 and source bounds remain unchanged. Source-v2/root/hash/revision/generation/Stop/privacy admission and passive rendering are unchanged. This round's fresh evidence is 21 focused native tests plus strict Clippy/scoped formatting; it does not restate the earlier 127-test or 93-frontend snapshot as a new run. Unchanged frontend/full suites and release/UI/live acceptance were deliberately not repeated. Task 12, the two ignored integration probes, Task 14 and Docker acceptance remain pending. No provider/bootstrap/OS/install/permission operations, push or new force-added internal files were performed.
