# Performance continuation, 2026-10-15

**Task 4 remains failed/pending.** This continuation fixes ownership of the native profiling window service and completes a valid corrected native UI fixture capture. It does not achieve the ordinary React or strict 240 Hz budgets. Both attempted frontend optimizations were rejected and restored.

The source base is `27c9742d50b5859e9a07819ccbd870f3c733573c`. The retained change affects only the native fixture module, its test and its driver. Ordinary product UI, Rust, measurement workloads, sample admission, StrictMode, assertions, deadlines and budgets are unchanged. The root-owned plan and ignored working reports are excluded from the commit.

## Native lifecycle correction

The driver previously hid through a newly created `TauriWindowService`, then asked the fixture's existing service to show. The existing coordinator still had confirmed visible state and therefore coalesced the show request without invoking the native show command. In the first current capture all three frontend show markers became true while all three actual native visibility samples stayed false. Query and caret preservation alone did not establish a successful reversal.

The fixture now exports its existing module-scoped window service, and the driver uses that exact object for typed hide. The existing real fixture regression uses the same default service and checks backend visibility becomes false and then true, alongside the existing query/caret checks. The normal window coordinator and Rust implementation are unchanged.

The corrected native run completed all captured phases with `captureValid: true`: all three actual native hide/show cycles passed, `report` and caret `6..6` survived every cycle, initial/end visibility passed, and the sampled foreground stayed unchanged. Its exit code is still 1 because performance budgets fail. The earlier failed lifecycle summary is retained separately.

## Measurements

All original browser ordinary phases retain 146 commits. Each native run retains every captured ordinary commit; the corrected repeated first `report` produces zero new commits. No failed sample was removed and no unchanged capture was retried to seek passing metrics.

| Capture | Ordinary React p95 / count | Ordinary Long Tasks >=50 ms | Input next callback p95 | Selection callback p95 | Cadence p95 | Result |
| --- | ---: | --- | ---: | ---: | ---: | --- |
| Retained source, installed Edge baseline | 6.2 ms / 146 | None | 4.9 ms | 4.5 ms | 4.9 ms | Ordinary <3 ms and hover fail; strict 240 false |
| Rejected action dispatcher | 9.0 ms / 146 | None | 10.1 ms | 4.8 ms | 8.5 ms | Rejected; strict 240 false |
| Rejected composer callback admission | 18.8 ms / 146 | 50, 72, 69, 52, 72, 54, 65, 62, 55 ms | 4.2 ms | 7.5 ms | 33.4 ms | Rejected; strict 240 false |
| Native before shared-service correction | 6.8 ms / 160 | None | 4.5 ms | 4.5 ms | 4.7 ms | Capture invalid: all three actual native shows failed |
| Native after shared-service correction | 9.3 ms / 161 | None | 5.4 ms | 5.1 ms | 8.3 ms | Capture valid; ordinary <3 ms and strict 240 fail |

Browser cadence-aware checks use the original formula and are distinct from strict frame budgets. In particular the composer's slower cadence yields permissive input/selection/hover allowances; those checks passing does not rescue its React and Long Task failures. Browser hover p95 is 4.6 ms in the retained baseline and rejected action capture, and 7.3 ms in the rejected composer capture. All 80 readiness samples, 30 rapid input/selection samples, one selected row, zero alignment error and zero settled/hidden row measurements remain present in the respective browser summaries.

The separate instrumented composer comparison confirms its narrow mechanism: inclusive `LauncherComposer` ordinary observations fell from 106 ms across 86 observations to 0.1 ms across one. Other ordinary boundaries inflated: diagnostic root 469.6 ms/149 observations became 943.1 ms/151. Inclusive nested durations overlap and are not added. These diagnostics are not untraced acceptance. The broader slowdown's cause is unestablished, so the targeted elimination did not justify retaining the candidate with worse original gate results. The action dispatcher likewise has no demonstrated accepted timing benefit. Both rejected source/test snapshots are archived for reproducibility.

## Provenance and isolation

The frozen current debug executable is `D:/CodexBuilds/Lumen/production-readiness/debug/lumen.exe`, 39,770,112 bytes, SHA-256 `94824234de4ab9d0aa089c40f80c9591ae47722f60949bbf3526a7db9c137cb6`. The serial build completed in 4m 08s with exit 0. No Rust change was required for the shared-service correction, so both native captures use that executable.

The corrected capture records source base plus the exact dirty source patch, all 12 driver/fixture/Rust/service hashes and executable hash. These were independently read back after capture and matched. The raw patch is `native-shared-source.diff`, SHA-256 `4b333bda4e7bdc864bfdbe7ae8c1b15059be2e796d7fe7822f15e9e56333103f`. It contains the three retained source/test changes, before documentation and artifact archival.

Actual WebView2 is 155.0.4283.45. Native physical client size is 1200×810, logical viewport 800×540, DPR 1.5. The read-only physical inventory reports AMD Radeon 890M, 2560×1600 at 240 Hz, driver 32.0.31041.1004. No display mode, OS focus, ordinary app, credential slot, index, provider, installer or Docker state was changed. The early debug fixture bootstrap excludes ordinary Rust startup and frontend App effects; the fixture uses memory search and typed unavailable services.

Preflight records preserve actual host load. Baseline CPU was 21%; action candidate preflight was 11% with 21,149 pages input/sec; composer capture began after settling at CPU 14%, zero pages input/sec, about 10.6 GiB available, 42% commit. Post-composer CPU was 6%; a separate read-only process delta is retained and does not establish what caused timed-phase load. The first native preflight was CPU 2%, about 11.7 GiB available, 41% commit; corrected native preflight was CPU 5%, zero pages input/sec, about 12.1 GiB available, 42% commit. No selected competing build/capacity workload or port listener was present. Pre/post probes are not continuous isolation proof, and no unowned process was changed.

The driver owns a fresh strict-1420 server, fresh admitted root, exact executable PID tree and its CDP listener. It cleaned its own tree/server after each capture. Follow-up inventory found no Task 4 native/build/profile/server owner or 1420 listener. The owned temporary roots and ignored raw captures remain preserved.

## Verification and evidence

The retained fixture/presentation covering run passed 26 tests in two files. The command also named nonexistent `src/platform/window/tauri-window-service.test.ts`; it was not run or counted. The real default-fixture backend visibility/query/caret regression is among those 26. The prior focused RED had two passes and one failure because the shared exported service did not exist and typed hide returned false; the actual native visibility failure above is the behavioral RED.

Driver/server checks passed 7/7, including the expected deliberate competing-port bind failure. Typecheck and scoped ESLint with zero allowed warnings passed after the retained correction. No full lint, full frontend suite, e2e, release build, gallery or recording refresh is claimed by these focused results. Rejected candidates separately passed 42 and 26 covering tests; those do not establish accepted performance changes.

Commands used the existing RTK/Windows PowerShell wrappers, Bun and installed Edge. The underlying retained checks were:

```powershell
rtk proxy bun run test -- src/test/NativePerformanceFixture.test.tsx src/platform/window/tauri-window-service.test.ts src/features/launcher/useLauncherPresentation.test.tsx
rtk proxy bun run node --test scripts/native-performance-profile.test.mjs scripts/lib/lumen-dev-server.test.mjs
rtk proxy bun run typecheck
rtk proxy bun x eslint scripts/native-performance-profile.mjs src/test/NativePerformanceFixture.tsx src/test/NativePerformanceFixture.test.tsx --max-warnings 0
rtk proxy powershell.exe -NoProfile -File .superpowers/run-native.ps1 build --manifest-path src-tauri/Cargo.toml -j 1
# Native runner sets the frozen LUMEN_NATIVE_PERFORMANCE_EXE and a fresh output directory:
rtk proxy bun run node scripts/native-performance-profile.mjs
```

The build wrapper fixes `CARGO_TARGET_DIR` to the owned D: target, incremental off, debug info off and `-j 1`. No build/test/other browser/native capacity workload overlapped timed captures.

Archived exact-byte records and SHA-256/size manifest are in [the dated evidence directory](../../artifacts/performance/production-readiness-2026-10-15/manifest.json). Principal records are [retained Edge baseline](../../artifacts/performance/production-readiness-2026-10-15/edge-baseline.json), [rejected actions](../../artifacts/performance/production-readiness-2026-10-15/rejected-actions-edge.json), [rejected composer](../../artifacts/performance/production-readiness-2026-10-15/rejected-composer-edge.json), [failed native lifecycle](../../artifacts/performance/production-readiness-2026-10-15/native-failed-lifecycle-summary.json) and [corrected native summary](../../artifacts/performance/production-readiness-2026-10-15/native-summary.json). Raw command logs are copied as `.txt` without transforming their original encoding; provenance and timed arrays are separate files. A narrowly scoped `-text` attribute preserves these evidence bytes across Windows checkouts. Larger local CPU/timeline/interaction traces remain in the ignored Task 4 directories named by the working report and are not represented as committed trace attachments.

## Remaining gates

Ordinary React <3 ms and strict nominal 240 Hz remain failed. The corrected native driver explicitly retains `fullGateMeasured: false`: its valid query/input/selection/lifecycle subset does not measure native hover, rapid bursts, idle, compositor presentation, other physical refresh modes, the ordinary production runtime or real indexing/provider work. rAF endpoints occur before presentation. Native selection React p95 is 0.4 ms, but it does not substitute for ordinary commits or presented frames.

Task 14 still owns full verification and final gallery/recording refresh, alongside the separately queued native indexing/capacity and live/packaged/manual acceptance work. Docker acceptance is explicitly deferred. This source/evidence milestone is ready for independent review; it is not full Task 4 or production acceptance.
