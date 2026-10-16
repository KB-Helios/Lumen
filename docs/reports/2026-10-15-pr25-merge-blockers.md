# PR #25 merge blocker investigation

PR #25 has no merge conflicts and is current with `main`. Merge protection requires the GitHub Actions **Verify and package** check, with strict branch freshness and administrator enforcement. No protection setting, assertion, timing budget or retry policy was changed during this investigation.

## Repaired release fixtures

The [original hosted run](https://github.com/KB-Helios/Lumen/actions/runs/38777247734) stopped at three release tests: `regularFile` rejected the fixtures as `Release path resolves outside its source`, before signing was invoked. The production check requires canonical input paths and separately rejects symbolic-link ancestors.

The exact three failures were reproduced locally with an existing Windows 8.3 alias in TEMP. Fixture roots created from `tmpdir()` retained that alias, while `realpath` returned its long spelling. Commit `cef5133cc6215b371bffb0598f0c4894cda9bae6` canonicalizes the temporary parent before creating the fixtures. All 11 release tests pass under the reproduced alias, including the added real directory-junction rejection regression. Production release admission is unchanged.

Typecheck, zero-warning lint and 14 Node bridge/tooling tests passed locally. The first full local unit run had 749 passes and three failures: two staging cases used the host's default Python 3.14 instead of the required 3.11, and one gallery Escape case failed. With `LUMEN_PYTHON` selecting the installed Python 3.11 runtime, the next full run had 751 passes and one shortcut-dialog failure. The two staging cases, all 35 gallery tests and all seven keyboard tests subsequently passed in focused runs without changing their assertions or deadlines. These focused passes do not erase the failed full runs.

The [new hosted run on cef5133](https://github.com/KB-Helios/Lumen/actions/runs/38794774193) passed typecheck, lint, the complete unit suite, the native answer bridge tests and tooling tests. It progressed beyond the original blocker and failed at Edge performance.

## Remaining required-check failure

| Gate | Current evidence |
| --- | --- |
| Hosted full Edge | 131 passed, one failed, two not run; 25 minutes. `performance.spec.ts:154` measured input-to-next-rAF p95 **19.5 ms**, above its cadence-aware **18.8 ms** bound. Later assertions in that test were not reached. |
| Local full Edge | 131 passed, one failed, two not run; 31.1 minutes. All preceding functional, accessibility, theme, text-scale, window-size and provider-dialog cases passed. `performance.spec.ts:201` measured ordinary React p95 **12.4 ms**, above the unchanged **<3 ms** bound. |
| Separate local diagnostic | Untraced input/ordinary sampling measured approximately **4.6 ms** input-to-next-rAF and **11.9 ms** ordinary React p95 at approximately **4.3 ms** observed frame cadence. A separate CPU-profile phase showed React element construction and collection work; these measurements are diagnostic and do not pass either failed full gate. |
| Narrow grid-retention trial | Preserving the React Aria grid while the query input owned focus passed 20 result-grid/keyboard tests, including a regression observed failing first. A subsequent diagnostic still measured ordinary p95 **12.8 ms**. The trial and its test change were reverted; no product optimization from this trial is published. |

The profile attributes expensive renders across the launcher composer, workspace, result collection, context actions and workspace remounts after clearing. Avoiding one collection reset did not repair the ordinary-query budget. This does not prove that the hosted frame miss has the same cause.

The subsequent [required run on eebeea0](https://github.com/KB-Helios/Lumen/actions/runs/38800711941) also passed the complete unit suite and failed Edge: input-to-next-rAF p95 **23.8 ms**, above **18.8 ms**. The repeated failure confirms that the first hosted miss cannot be dismissed as a passing qualification.

## Follow-up rendering fix

Commit `8d68e41` retains only three small rendering changes: omit the unused Computer Use submission callback in search mode, memoize the expanded workspace, and keep action-button callbacks stable while forwarding to the latest committed handlers. The action regression was observed failing before the fix and passing afterward; it also verifies eligibility and opening-state changes remain immediate. Independent source review found no correctness issues.

Fresh local verification of this patch:

| Check | Result |
| --- | --- |
| Typecheck and zero-warning lint | Passed. Generated diagnostic bundles were moved into the ignored dependency cache before the clean lint run. |
| Complete unit suite, Python 3.11 selected | **752 passed**, 89 files. |
| Native answer bridge and tooling | **14 passed**. |
| Focused Edge search, shell and Computer Use keyboard cases | **12 passed**, including opening/details/folder actions, narrow layouts, intent switching, safety focus order and 10,000-result selection. |
| Unchanged Edge performance suite | **1 passed / 1 failed / 2 not run**. Ordinary React render p95 improved to **7.7 ms**, still above **<3 ms**. Earlier input and selection assertions passed in this run; that does not replace the failing hosted qualification. |
| Regenerated evidence | **86 gallery states and six recordings** reference `8d68e41`. The [browser profile](../../../artifacts/performance/profile-summary.json) exits **1** with ordinary React render p95 **8.6 ms vs <3 ms**; `passed` and strict-240-Hz acceptance remain **false**. All other cadence-aware profile checks passed in that observation. Source was marked dirty because the report and generated evidence were being refreshed; the product source matches `8d68e41`. |

Broader workspace retention, collection retention, React Aria hook replacement and selection-observer experiments were removed. No dependency, timing threshold, assertion, retry policy or CI configuration change is retained.

### Measurement boundary and unresolved qualification

The ordinary test records React Profiler `actualDuration` from the Vite development renderer with StrictMode. Despite the existing metric's `reactCommit` name, this is render duration, not total commit or physical presentation time. React documents a separate [production profiling build](https://react.dev/reference/dev-tools/react-performance-tracks#using-profiling-builds).

An isolated local diagnostic used that profiling renderer with the same fixture routes, workload and original assertions. Ordinary-interaction qualification passed, but hover qualification failed: dispatch-to-next-actual-callback p95 **4.8 ms**, versus a **4.3 ms** nominal frame budget; all 80 hover state/color samples were ready. This comparison was an unshipped trial build, included a subsequently removed observer experiment, and is not acceptance of `8d68e41` or a substitute for the required development gate.

The hover sampler compares an actual callback endpoint with a nominal rendering-timestamp budget. Callback offset growth contributes to that result. A separate alternating diagnostic measured no-input callback p95 **6.1 ms** at **4.3 ms** nominal cadence, showing that the bound can be exceeded without an input dispatch. This does not attribute every hover miss to the host or establish physical paint latency. Application work, browser scheduling and host contention remain possible contributors.

At the end of that investigation, the qualification decision was still open. On 2026-10-16 the owner selected production profiling with unchanged workload/limits and retained development functional tests. The [follow-up report](2026-10-16-production-profiling-gate.md) records the implemented split and remaining strict hover failure. No failure was normalized into a pass.

The native staging, Rust, compiled-worker and packaging steps after Edge did not run in the new hosted workflow. Their earlier revision-bound reports remain separate evidence. The independently documented compiled enrichment crash and other production release gates remain open.

## PR cleanup and disposition

The PR description no longer incorrectly calls the ready-for-review PR a draft. It now separates the fixture repair, current verification and remaining production acceptance, and links the authoritative reports. Third-party review subscription/usage notices are not required merge checks; no inline review comments were present at investigation time.

**The PR remains blocked.** A complete passing required check is still needed. Next work must establish and verify the input-frame and ordinary-render fixes under the original workload and budgets, then run the complete hosted pipeline. Merging or releasing on the current evidence would bypass an existing failed gate.
