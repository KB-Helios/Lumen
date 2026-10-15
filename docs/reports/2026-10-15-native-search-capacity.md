# Native search capacity and recovery evidence

Task 13 is **not accepted**. The final source passed native correctness verification and one complete 1,000-file functional workload. Full 50,000-file and 250,000 accepted-record workloads are **PENDING_HOST_RESOURCES**. The 1,000-file timings below are resource-bound observations, not isolated performance acceptance. Installed UI, release/package performance and general production capacity remain unverified.

The checked-in [sanitized evidence](../../artifacts/search-capacity/2026-10-15-native-capacity.json) preserves phase events, all five 30-sample query families, source/runner and native binary hashes, continuous host observations, sampled owned-native resources, exit receipt and post-run memory pressure. Absolute corpus/executable/user paths are removed. Local raw logs and owned corpora remain preserved; no cleanup or unrelated process action was performed.

## Source and verification

Full Task 13 review starts at `fc18b5a333077b33954802b6884505b677da1de9`. It includes the capacity/recovery milestone `9b3e3750069d663bcd24dad4b35e4f9b48ed5509` and retry-status repair `69dfa316dfcad96fe3efdada344af58c0d346f1f`. The latter is the frozen source used by the new 1,000-file run. Only an existing untracked planning document was present during measurement; no source was changed during the run.

The status repair removes a full pending-map traversal after every successful content commit. An actual 40-file worker regression first failed with 820 status retry candidates, independently of ordered selection; after the fix it observes zero. `PendingQueue` maintains the number of retrying entries across insertion/replacement, first/repeated retry, success/terminal/policy removal, retain and clear. A deadline-only test helper replaces unrestricted mutable pending-value access. Normal-worker tests verify pause, same-signature retry-to-success and revocation status; existing bounded terminal-failure assertions remain intact. The source finding establishes quadratic aggregate work in the old status path, not its percentage of earlier elapsed time.

Final checks for `69dfa316`:

| Gate | Actual result |
| --- | --- |
| Covering native `search::`, all features, one job/thread | 146 passed, 0 failed, 3 explicitly ignored; 279.94 s; build 2.93 s |
| Strict Clippy, all targets/features, one job, `-D warnings` | Exit 0; 1m01s |
| Rust format check; Git whitespace check | Exit 0 |
| Runner sharing self-check | Concurrent compatible read/append succeeds; incompatible sharing fails after bounded retries; no duplicate append |

A preceding covering run had 145 passes and one failure in a newly added test that manually removed its worker but still expected a reconciliation obligation to clear. The test was corrected to observe the normal worker, keeping `ready` assertions and existing four-second waits. It then passed alone in 0.38 s and in the final covering run. This was a test-fixture correction, not a product readiness fix or a weakened assertion.

The wider review range also contains actual same-native-connection SQLite FULL inventory/content recovery, interrupted schema 0–4 migrations, and interrupted derived-vector reset coverage. FULL faults retain authoritative documents, lexical hits, pins and access/query history; restoring logical allocation permits real retry and reopen with integrity/foreign-key checks. The derived-vector table replacement is transactional. Unchanged metadata makes no SQLite changes or WAL rewrite; verified FTS point lookup retains the legacy fallback. Bounded batches, ordered pending selection and reconciliation completion clocks have operation/real-worker regressions. These are owned native fixtures, not live-provider acceptance.

## Final 1,000-file functional run

Raw receipt family: `20261015-084558-1000-native.log*`. Cargo/native test passed in **67.85 s**; wrapper exit **0** was recorded at `2026-10-15T08:54:11.7953983Z`. Build took 6m52s outside workload clocks. The normal harness completed Stop/drop/joins, both cancellation probes and the final `complete` event with `teardown_joined: true` and corpus preservation.

Profile: test, Lumen crate optimization level 3, dependencies unoptimized, debug assertions enabled; debug information disabled by the recorded build environment. The harness's ownership event says `debug`; the actual Cargo configuration is the authority for optimization. This is not a release or packaged profile. Native binary SHA-256: `fe1f298c9460018ba233e3eb81241c253b0f43a050f4ffb27955e6d6b33a9ad9`.

The owned real filesystem corpus contained 1,000 96-byte text files plus one directory: 1,001 accepted inventory records, 96,000 source bytes, and an excluded canary. Corpus creation is outside workload clocks; OS caches were not flushed. Missing vector extension and disabled cloud enrichment keep this lexical-only. Inventory and extraction use normal `IndexRuntime` workers/admission, not SQL-seeded capacity.

| Phase | Observed result |
| --- | --- |
| Cold inventory | 2,992.3516 ms; 1,001 records |
| Initial full content | 10,842.8335 ms; 1,000 commits; pending 0; ready |
| Same-size/same-mtime watcher edits, ordinals 1 / 500 / 999 | Old content invalidated in 206.9059 / 204.1371 / 200.0268 ms; replacement content in 260.9073 / 240.6245 / 231.7125 ms |
| Actual watcher rename / delete | 212.8150 / 3,189.0211 ms; 999 files remain |
| Settled observation | Full 35 s, including periodic maintenance; no claim of maintenance-free idle |
| Initial Stop admission / owned joins | 0.6655 / 68.7114 ms |
| Reopen before admission | 78.3367 ms; zero scans; saved lexical/pin/history/integrity checks pass |
| Re-admitted inventory / full content | 2,114.6115 / 7,471.0827 ms; 999 content commits |
| Stop during inventory | 103 real metadata commits before Stop; admission 5.1091 ms; joins 31.9723 ms; no late commit |
| Stop before content commit | Admission 0.0123 ms; joins 27.2880 ms; no late content; concurrent query at extraction barrier 2.6583 ms |

At initial content completion, cumulative counters show selection 3.5394 ms/1,000 candidates, extraction 323.9713 ms, complete content-upsert span 2,661.9995 ms, pre/post content admission 2,456.9624 ms, status 88.6861 ms and zero status retry candidates. Maximum commits between retained rests: eight. Sleep includes inventory/idle periods; these accumulated counters are not mutually exclusive end-to-end latency measurements. Admission includes its lock waits and boundary checks; status timing includes its existing SQL counts. New metrics are test-only. No speedup percentage is inferred.

Each warm family has one separately reported first query followed by 30 admitted samples. Percentiles use nearest rank `ceil(q*N)-1`: sorted positions 15 and 29. Every family observed scan delta zero, including maintenance, across its query window. There was no query-triggered recursive traversal.

| Query family | p50 / p95, ms |
| --- | --- |
| Exact filename | 3.8404 / 6.1203 |
| Sparse content | 2.4724 / 4.9289 |
| No match | 2.3489 / 3.4751 |
| Common content, limit five | 21.7660 / 32.5409 |
| Extension filter | 28.5971 / 32.2745 |

## Host suitability and supported limits

Windows 11, AMD Ryzen AI 9 HX 370, 24 logical processors, about 32 GiB physical RAM; D: NTFS on the recorded NVMe device. The owned parent is compressed and was checked for reparse ancestors. Before this run, D: had 340,892,794,880 free bytes and physical memory was 2,103,264 KiB free. Total CPU samples across build/run ranged 1–87%; memory pressure became severe.

During compilation, a host sample reported 163,612 KiB physical memory free. The exact owned compiler ancestry's 53 samples peaked at about 1.90 GB private bytes and 1.31 GB working set; its final sample was about 287 MB private. At the first pressure check, compilation ended while the snapshot was collected and the native fixture had already launched. That multi-call snapshot is not atomic. It recorded about 97% system commit and heavy paging.

After all owned build/native work finished, the fresh OS-only observation at `08:55:05.966` / `08:55:07.544 UTC` still showed 299,976 KiB free physical memory, 91,997,048,832 / 93,348,233,216 committed/limit bytes (98%), and 61,332 pages input per second. Pressure persisted without the compiler/native fixture, so the owned build does not account for the dominant system commitment. Unrelated applications, Docker and OS settings were left untouched. No 50,000-file or cap run was started under these conditions.

Across nine native resource samples, peak working set/private bytes were about 16.81 / 7.71 MB. Five samples inside the 35-second settled interval span 29.605 s, with 0.375 s process CPU increase; they include normal maintenance. The tiny text corpus, sampled peaks, active paging and core-only host prevent treating these numbers as installed-app memory/idle acceptance.

The result demonstrates this 1,000-file functional scenario under the recorded conditions. It establishes no general mixed-document, 50,000-file or traversal-cap production capacity. Full 50,000-file and 249,750-file + 250-directory + one-sentinel workloads remain **PENDING_HOST_RESOURCES**, with the original 250,000 accepted-record cap unchanged. No caps, sample admission, waits, deadlines, 25 ms rests/eight-job batches, 30 s maintenance, 5 s retry or 150 ms debounce were relaxed. Root/path reparse/canonical checks at both extraction boundaries, generation/admission tokens, consent and Stop remain intact.

## Earlier incomplete evidence

The earlier full 50,000-file run used source `9b3e375`, not the final retry repair. Root interrupted only its verified owned native PID for diagnosis. Last snapshot: content 721.1631086 s, 5,253 commits, 44,747 pending, six scans/six completions. Full content, warm-query families, propagation, settled interval and reopen did not complete. It is **INTERRUPTED_BY_ROOT_FOR_DIAGNOSIS**, not a capacity pass or a harness watchdog failure. Rust Stop/drop/joins and database integrity after that process stop are unknown; no join/integrity claim is made. Corpus/database/raw evidence were preserved and never reused here.

Its wrapper also failed on a resource-log sharing violation and did not write a normal exit receipt. The original identity receipt contains a JSON prefix plus plaintext status lines, not one valid JSON document; its saved `[true]` is one aggregate check result. No replacement exit or thirteen-check receipt was fabricated. The ignored runner now uses explicit shared read/write streams; only open-time sharing/lock errors receive four 50 ms waits before propagation. Uncertain writes are not replayed, and logging failures remain failures.

Older default-debug attribution runs, deliberately incomplete 15-second diagnostics and earlier 1,000-file baselines are separate evidence. None substitutes for the missing final large workloads or supports a cross-profile speedup claim.

## Reproduction after planning-file cleanup

Use a Visual Studio x64 developer PowerShell with the repository's normal pinned dependencies. The checked-in native harness creates a new marker-checked owned D-drive corpus/database for every run and retains it. Record source/dirty state, exact command/environment, binary SHA-256, hardware, continuous host CPU/available memory/commit/paging, owned PID/start/executable and process resources before accepting another measurement. Do not start large workloads during severe pressure; do not stop unrelated processes to obtain favorable samples.

```powershell
$env:CARGO_TARGET_DIR = 'D:/CodexBuilds/Lumen/production-readiness'
$env:CARGO_INCREMENTAL = '0'
$env:CARGO_PROFILE_DEV_DEBUG = '0'
$env:CARGO_PROFILE_TEST_DEBUG = '0'
$env:LUMEN_TASK13_ATTRIBUTION_ONLY = '0'
$env:LUMEN_TASK13_FILES = '1000' # repeat separately with 50000, then 249750
rtk proxy cargo test --manifest-path src-tauri/Cargo.toml --all-features -j 1 --lib --config profile.test.package.lumen.opt-level=3 native_filesystem_capacity -- --ignored --test-threads=1 --nocapture
```

Keep original watchdogs: initial/re-admitted inventory two hours each, initial/reopened full content four hours each; all other original fixture deadlines remain unchanged. Capture raw `TASK13` JSON lines, stdout/stderr and actual exit, retaining failures and workload progress. A final `complete` event and successful exit establish this functional harness result; they do not independently establish host suitability, installed UI performance or full Task 13 acceptance. The evidence artifact retains the source/runner hashes and exact historical command even if local planning scripts are removed.
