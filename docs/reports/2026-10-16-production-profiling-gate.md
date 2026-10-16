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
| Full development functional run | In progress at report creation. |
| Hosted qualification before scheduling allowance | All four performance cases passed in the [run on a8e8eea](https://github.com/KB-Helios/Lumen/actions/runs/38889233151): hover p95 **16.0 ms vs 16.7 ms**, all 80 ready. That whole run was superseded by the evidence commit. The [run on 3409bf8](https://github.com/KB-Helios/Lumen/actions/runs/38889949185) then passed ordinary interactions but failed hover: **18.3 ms vs 16.734 ms**, all 80 ready, callback-offset-growth p95 **1.666 ms**. This is a failed required check; the earlier step pass does not erase it. |

The [raw browser profile](../../../artifacts/performance/profile-summary.json) and separate interaction trace preserve the failed result. Earlier development-renderer failures remain in Git history and the [merge blocker report](2026-10-15-pr25-merge-blockers.md). Existing screenshots and recordings at `8d68e41` are visual evidence for the unchanged UI; this follow-up changes qualification and DEV diagnostics, not product layout or motion.

## Remaining boundary

The hover sampler measures pointer dispatch to the next **actual** rAF callback and independently checks the intended hover state/color. Its strict bound uses paired **nominal** rendering timestamps. Callback offset growth can contribute to a miss; the samples do not by themselves separate application work, browser scheduling and host contention or prove compositor paint time.

Production profiling repairs the renderer mismatch for the ordinary budget. It does not itself erase the hover failure or establish native WebView2, live-provider, installed-application, signing or other production acceptance. The PR remains blocked until the complete required check passes.

## Approved scheduling allowance

After the inconsistent hosted hover results, the owner explicitly approved adding the existing **2 ms scheduling allowance** to cadence-aware hover, matching the input/selection lanes. This is a deliberate change from the earlier zero-allowance hover gate: at the observed hosted cadence the ceiling changes from **16.734 ms to 18.734 ms**; locally it changes from **4.3 ms to 6.3 ms**. The <3 ms ordinary render budget and all other limits are retained.

All 80 fresh hover transitions must still achieve the intended state and token color at the first callback. Synchronous work must still remain below 16 ms, long-task checks remain, and no retries are added. `strict120Hz` and `strict240Hz` diagnostics receive **no** scheduling allowance and remain independent acceptance results. Both the Edge test and evidence profiler use the same approved cadence-aware bound.

The original `testInfo.attach({body})` kept raw samples only in reporter memory; the dot/list console reporters did not save them to the failure directory. A JSON reporter now preserves the attachment body, and CI uploads that report immediately after qualification on success or failure, before functional-test output cleanup can remove it.
