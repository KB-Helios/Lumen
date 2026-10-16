# Production profiling qualification

On 2026-10-16 the owner selected production profiling for the existing performance budget, with the same workload and limits and continued development functional coverage. Commit `a8e8eea` implements that decision.

## What changed

- `bun run test:e2e` retains all 130 existing development functional cases and adds one renderer-admission regression.
- `bun run test:performance` runs the original four performance cases in installed Edge, serially, without retries. The only limit change is the owner's later explicit approval of the 2 ms cadence-aware hover allowance described below. Sample counts, query workload, readiness checks, measurement endpoints and all other limits are retained.
- The dedicated Vite configuration shares the application's plugins and chunk configuration, aliases `react-dom/client` to the documented `react-dom/profiling` entry point, and uses production React/JSX. Fixture routes and diagnostics remain enabled only in this separate test build under `node_modules/.cache/lumen-performance`; it is not Tauri's release output.
- Each benchmark page checks the renderer's own DevTools registration. A development renderer is rejected. Every registration is retained, so production registration cannot conceal a development renderer. The existing nonempty ordinary-query Profiler sample assertion also rejects a standard production renderer without profiling.
- CI requires production performance before the longer development functional run. Both remain inside the protected **Verify and package** check; native, worker, signing-admission and installer checks are retained.
- `bun run profile` uses the same dedicated build and an owned, strict loopback preview on port 1424. It closes the server in `finally`, including after a failed qualification. A DEV-only hide diagnostic replaces a source-module import so the existing hidden-row measurement works in the static bundle without clearing the query.

React's [production profiling documentation](https://react.dev/reference/dev-tools/react-performance-tracks#using-profiling-builds) describes the special renderer and bundler alias. The existing ordinary `reactCommit` field records Profiler render duration (`actualDuration`); its historical name does not imply total commit or physical paint latency.

## Verification

| Check | Evidence |
| --- | --- |
| Renderer admission | Observed failing against Vite development (`bundleType: 1`) and passing against production (`0`). The mixed-registration regression was also observed failing before its fix and passing afterward. |
| Diagnostics lifecycle | New regression failed with the missing hide method, then passed. Hiding preserves the current query. |
| Typecheck, zero-warning lint, normal production build | Passed. Searching normal `dist/assets` found none of `hideLauncher`, `__LUMEN_DIAGNOSTICS__` or `diagnostics-show-launcher`. |
| Full unit suite | **753 passed**, 89 files, Python 3.11 selected. |
| Bridge/tooling tests | **14 passed**. |
| Production performance suite | Initial run: **2 passed / 1 failed / 1 not run**. Ordinary-interaction assertions pass; strict hover fails at **4.7 ms vs 4.3 ms**, all 80 state/color samples ready. |
| Production browser profile | Clean product revision `a8e8eea`, React **19.2.8**, production renderer `0`. Ordinary render p95 **1.5 ms vs <3 ms**. Hover p95 **4.6 ms vs 4.3 ms** is the only failed cadence-aware check. Overall and strict-240-Hz acceptance remain **false**. Preview listener verified closed afterward. |
| Full development functional run | **131 passed**, 32.4 minutes, including all original functional cases and the new mixed-renderer regression. |
| Hosted qualification before scheduling allowance | All four performance cases passed in the [run on a8e8eea](https://github.com/KB-Helios/Lumen/actions/runs/38889233151): hover p95 **16.0 ms vs 16.7 ms**, all 80 ready. That whole run was superseded by the evidence commit. The [run on 3409bf8](https://github.com/KB-Helios/Lumen/actions/runs/38889949185) then passed ordinary interactions but failed hover: **18.3 ms vs 16.734 ms**, all 80 ready, callback-offset-growth p95 **1.666 ms**. This is a failed required check; the earlier step pass does not erase it. |

The [raw browser profile](../../../artifacts/performance/profile-summary.json) and separate interaction trace preserve the failed result. Earlier development-renderer failures remain in Git history and the [merge blocker report](2026-10-15-pr25-merge-blockers.md). Existing screenshots and recordings at `8d68e41` are visual evidence for the unchanged UI; this follow-up changes qualification and DEV diagnostics, not product layout or motion.

## Remaining boundary

The hover sampler measures pointer dispatch to the next **actual** rAF callback and independently checks the intended hover state/color. Its strict bound uses paired **nominal** rendering timestamps. Callback offset growth can contribute to a miss; the samples do not by themselves separate application work, browser scheduling and host contention or prove compositor paint time.

Production profiling repairs the renderer mismatch for the ordinary budget. It does not itself erase the hover failure or establish native WebView2, live-provider, installed-application, signing or other production acceptance. The PR remains blocked until the complete required check passes.

## Approved scheduling allowance

After the inconsistent hosted hover results, the owner explicitly approved adding the existing **2 ms scheduling allowance** to cadence-aware hover, matching the input/selection lanes. This is a deliberate change from the earlier zero-allowance hover gate: at the observed hosted cadence the ceiling changes from **16.734 ms to 18.734 ms**; locally it changes from **4.3 ms to 6.3 ms**. The <3 ms ordinary render budget and all other limits are retained.

All 80 fresh hover transitions must still achieve the intended state and token color at the first callback. Synchronous work must still remain below 16 ms, long-task checks remain, and no retries are added. `strict120Hz` and `strict240Hz` diagnostics receive **no** scheduling allowance and remain independent acceptance results. Both the Edge test and evidence profiler use the same approved cadence-aware bound.

The original `testInfo.attach({body})` kept raw samples only in reporter memory; the dot/list console reporters did not save them to the failure directory. A JSON reporter now preserves the attachment body, and CI uploads that report immediately after qualification on success or failure, before functional-test output cleanup can remove it.

## Follow-up local results after the approved allowance

The full production performance run still failed ordinary rendering: **1 passed / 1 failed / 2 not run**, p95 **3.7 ms vs <3 ms**. Adding observation-only per-query attachments reproduced that failure at **3.5 ms**. The [raw 24-query render samples](../../../artifacts/performance/ordinary-render-failure.json) retain the latter result; the largest spikes occur when reopening results after an empty query. These attachments do not change query work, assertions or limits.

The regenerated clean-source [profile on e5b9c05](../../../artifacts/performance/profile-summary.json) also exits **1**: ordinary render p95 **3.9 ms vs <3 ms** and warm launcher p95 **21.3 ms vs <20 ms**. Hover passes its approved cadence-aware bound in that profile, with all 80 ready. Overall and strict-120/240-Hz acceptance remain **false**. These later failures are preserved alongside the earlier 1.5 ms observation; the cause of the local variation is not established.

A separate focused run reached the two cases skipped by the full run: **2 passed**, including hover p95 **6.3 ms vs 6.4 ms**, all 80 ready, bounded idle CPU/heap and the static answer-region check. The JSON report was decoded and verified to contain all 80 raw hover samples. Those focused passes do not erase the failed full workload.

The owner-approved allowance is committed as `e5b9c05`. Final hosted qualification remains necessary; no complete required-check pass is claimed from these local results.

## Selection measurement follow-up

The [required run on 5158f5a](https://github.com/KB-Helios/Lumen/actions/runs/38893922644) failed selection p95 at **19.9 ms vs <18.8 ms**, before reaching hover. Its preserved ordinary-render samples measured **2.1 ms**; the ordinary assertion was not reached, so this is not a passed complete interaction case.

Tracing selection in the production build found **240 capsule measurements for 120 selections**. Each newly observed row received an initial ResizeObserver notification after it had already been measured, queuing a redundant frame. Commit `2123aba` skips that notification only when its reported border-box dimensions exactly match the last measured dimensions. Real size changes, unavailable box data and transformed-size mismatches still schedule measurement. A regression failed before the fix and passes for both row growth and shrinkage afterward. The diagnostic then recorded **120 measurements for 120 selections**; its selection p95 remained 4.1 ms, so that trace alone does not prove the hosted deadline is fixed.

Verification on the fix: **754 unit tests**, typecheck, zero-warning lint and **20 focused development Edge cases** pass, including virtual-row scrolling, large text, high contrast, preview geometry and rapid selection. A fresh full production performance run passes **all four cases**, without retries: ordinary render p95 **1.2 ms vs <3 ms**, selection **3.6 ms vs <6.5 ms**, hover **4.8 ms vs 6.3 ms**, all 80 hover samples ready. The JSON report now also preserves raw input/selection samples before their assertions.

The clean-source profile on `2123aba` passes all cadence-aware checks: ordinary render **1.5 ms**, warm launcher **4.0 ms**, input-next-frame **5.3 ms**, selection **4.0 ms**, hover **4.7 ms**, zero long tasks, zero settled/hidden measurements and zero settled alignment error. Strict **120 Hz passes** for this observation; strict **240 Hz fails**. This later pass does not erase the earlier failures or replace complete hosted qualification.

Sidecar staging and the compiled enrichment fixture also passed locally (**1 test / 185 assertions**, Python 3.11). That fixture result does not establish broader worker recovery reliability or live-provider acceptance.

All **86 gallery states** and **six interaction recordings** were regenerated at `2123aba`. The vendor-signature positive/tampered-negative check and all **19 unsigned sparse-identity metadata/ordering cases** also pass. These checks neither sign Lumen nor establish signed installer/MSIX acceptance.

The [required run on f36aa07](https://github.com/KB-Helios/Lumen/actions/runs/38896479987) still fails selection: **19.7 ms vs <18.8 ms**, with **1 performance case passed / 1 failed / 2 not run**. Ordinary samples again measure 2.1 ms, with their assertion not reached. The [120 raw selection samples](../../../artifacts/performance/selection-frame-failure.json) preserve this failure. Removing duplicate measurements has not established a fix for the hosted deadline.

The next observation-only change adds the existing start time, rAF queue time, nominal frame timestamp and actual callback time to each frame sample. The measured duration still ends at the same actual callback, and workload, limits and assertions are unchanged. Its regression verifies a 20 ms actual latency remains 20 ms even when the nominal frame timestamp is earlier. All 26 diagnostic unit tests and all four local production performance cases pass with this metadata. The superseded local full development run was stopped after 56 cases; it is not a completed pass.

## Current-head native follow-up

The [required run on 8b8a1ea](https://github.com/KB-Helios/Lumen/actions/runs/38897489210) passed all four production performance cases: ordinary render p95 **2.2 ms vs <3 ms**, selection **17.2 ms vs <18.7 ms**, hover **16.1 ms vs 18.734 ms**, all 80 hover samples ready. Synchronous selection handling measured **0.2 ms p95**. The new timestamps preserve frame waiting and callback offset without attributing either entirely to application work. This observation does not erase the preceding hosted failures.

The complete development functional suite passed both hosted and locally (**131 cases**, local duration 30.7 minutes). All **755 local unit tests**, typecheck, zero-warning frontend lint and the normal production build pass. Normal release assets contain none of the diagnostic hook/hide entry points. CodeQL passed for all five languages/workflows.

Hosted staging, vendor-signature checks, sparse-identity admission, compiled Gateway checksum admission, pinned-worker integrity, compiled enrichment recovery and Rust formatting also passed. The required job then failed Clippy under **Rust 1.99.0**: `useless_borrows_in_formatting` flagged an unnecessary reference to the lowercase drive-letter string in the ignored Docker confinement fixture. The follow-up removes that reference; fixture behavior and all lint/test gates are retained. The local default Rust 1.95 did not report this newer lint, so verification uses a separately installed 1.99.0 toolchain without changing the default.

Rust tests, remaining compiled-native fixtures, native answers and installers were skipped after that lint failure. No complete required-check pass or installer acceptance is claimed from this run.

The local **Rust 1.99.0** `cargo clippy --all-targets --all-features -- -D warnings` and `cargo fmt --all -- --check` both pass after the one-reference fix. Full native tests and packaging continue separately; their pending status is not a pass.
