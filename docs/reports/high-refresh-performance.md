# High-refresh performance report

## UI refinement measurement, 2026-10-11

**Status:** incomplete acceptance. The source-final scratch profile fails hover, ordinary React and aggregate strict-240 checks. Final committed-source regeneration is pending; the dated [UI completion report](2026-10-11-ui-completion-motion.md) tracks final gates and native evidence separately.

The host is 2560 × 1600 configured at 240 Hz, AMD Radeon 890M driver 32.0.31041.1004, installed Edge 155.0.4283.45 and WebView2 154.0.4258.62. Win32 inventory in `artifacts/performance/ui-display-inventory.json` advertises only 60/240 Hz at this resolution: 60 Hz has not been measured and 120/144/165 Hz are unavailable in that inventory. Browser estimation of approximately 238 Hz is callback cadence, not presented frames.

The revised profiler records synchronous input response separately from input-to-next-rAF callback, retains unsorted raw intervals and actual hover callback endpoints with independent computed-style readiness, and samples ordinary React commits over 24 representative query changes. It requires 60 complete positive cadence intervals; missing cadence stays unavailable, and observation stops on hide, timeout or unmount. Timed phases exclude tracing/screenshots; the interaction trace is a separate study. Legacy `*ToPaint` field names refer to a callback before presentation, not compositor paint. Browser GPU compositing status describes the measured Edge process only.

| Measurement | Original raw baseline | Revised unchanged-UI baseline | Source-final Task 5 scratch |
| --- | ---: | ---: | ---: |
| Warm visible p95 | 2.4 ms | 3.5 ms | 6.3 ms |
| Synchronous input p95 | 0.1 ms | 0.1 ms | 0.1 ms |
| Input-to-next-callback p95 | Not sampled | 5.2 ms | 4.3 ms |
| Selection-to-callback p95 | 4.2 ms | 3.2 ms | 5.9 ms |
| Hover-to-callback p95 / paired budget | 6.9 / 10.2 ms | 4.7 / 4.3 ms, fail | 4.9 / 4.3 ms, fail |
| Ordinary React p95 / sample count | Empty sampling; reported 0 is not evidence | 8.7 ms / 163, fail | 7.4 ms / 146, fail |
| Idle renderer CPU | 0.327% | 0.111% | 0.138% |
| Post-GC JS heap | 31.429 MiB | 31.497 MiB | 31.905 MiB |
| Aggregate strict 240 Hz | Fail | Fail | Fail |

Original raw: `artifacts/performance/ui-audit-original-baseline.json`, generated `2026-10-10T14:40:23.798Z`, SHA `4e12b66209f2c313c084109ca0212bd364b11099`. Revised raw: `artifacts/performance/ui-audit-revised-baseline.json`, generated `2026-10-10T15:12:46.824Z`, SHA `2002b80f387f4e34e5213546e88b90beb9fe76d3`, dirty worktree. Task 5 scratch: `%TEMP%/lumen-ui-audit-d61a/task-5-final/profile-summary.json`, generated `2026-10-11T01:25:04.659Z`, SHA `1fce4d51029acb42165c8c22845d79c12a33d43c`, dirty worktree containing Task 5 changes. These snapshots have different instrumentation/source states; differences are observations, not a guaranteed latency improvement. Earlier first-pass hover observations in the plan are separate from these preserved raw captures.

The Task 5 scratch run passes warm <20 ms, cadence-aware input/selection (6.4 ms budget), direct 30-event input/selection bursts (0.6/2.1 ms, each <16 ms), no browser Long Tasks >=50 ms, idle <2%, heap <100 MiB, 0 px settled selection error and zero settled/hidden animations, activity indicators and row measurements. Its hover has all 80 readiness samples, but 4.9 ms exceeds 4.3 ms; ordinary React 7.4 ms exceeds 3 ms. Aggregate `passed` and strict-240 remain false. A calculated strict-120 pass on this 240 Hz host does not constitute a measured physical 120 Hz context. Hidden lifecycle samples use the launcher visibility store on a fresh browser page, 100 ms observations after 500 ms settling; native/document observer cleanup also has component regressions. This does not measure native HWND hiding.

The observer fix removed sustained idle work observed at 13.882% before the fix; the subsequent observer-only run measured 0.131%. No tolerance, callback endpoint, sample filter, GPU flag or permanent promotion was added to obtain a pass. Actual WebView2 presentation, alternate display captures, live providers and manual Narrator remain separate acceptance requirements.

## Historical baseline, 2026-07-31 and refresh, 2026-08-09

The following snapshot predates the current refinement. Its empty ordinary-React sample value and “to paint” labels must not be used as current performance acceptance; the revised method and failures above govern the new work.

**Original baseline:** 2026-07-31; Windows 11 build 26200, NVIDIA GeForce RTX 5070 Ti, 2560 × 1440 at 150 percent scale; driver-reported 500 Hz; Edge 150  
**Task 12 refresh:** 2026-08-09; AMD Radeon 890M, 2560 × 1600 at 240 Hz; Edge 151.0.4129.72  
**Historical result:** That cadence-aware profile passed its then-current sampling and retained the raw strict-240 failure separately. Lumen does not claim a fixed 240 FPS output.

## Method

`bun run profile` launches a non-background-throttled Edge context at 800 × 540 against the deterministic development adapter. It warms lazy routes and input work, records 24 launcher round trips, 30 paced input samples, 120 paced selection samples, 80 hover samples paired with their directly surrounding animation-frame intervals, and two unpaced 30-event renderer-side burst guards. It then samples React Profiler commits, browser Long Tasks, active animations, one second of idle task time, garbage-collected JavaScript heap, and 120 animation-frame intervals. A Playwright trace is saved with the JSON summary.

Isolated p95 samples are paced so they measure response latency rather than whole-query replacements overlapping their own deferred work. The input burst is one renderer-side synchronous callback containing 30 native input-value updates and bubbled input events, not 30 awaited automation calls. The selection burst similarly dispatches 30 bubbled keyboard events in one renderer callback. Their directly measured synchronous durations must each remain below 16 ms while sample count, final-state correctness, and one selected row are asserted independently.

The nominal target remains `1000 / 240 = 4.1667 ms`. Raw input, selection, and hover results against that strict target are recorded under `strict240Hz`. The release check compares input and selection with `max(nominal target, observed p95 frame interval) + 2 ms`; the explicit tolerance covers browser scheduling at the automation-to-animation-frame boundary. Hover is paired with its actual surrounding frame interval and uses the equivalent contemporaneous p95 maximum. Both cadence measurements must be available. Hover dispatch has a separate direct synchronous maximum below 16 ms, and both rapid bursts have direct synchronous totals below 16 ms, so observed frame cadence cannot excuse slow handler work.

The browser Long Tasks API is a separate coarse signal: by definition it reports tasks of at least 50 ms, not tasks over 16 ms. The profile therefore records those entries as `*BrowserLongTasksOver50Ms`, budgets them at 50 ms, and requires none in the rapid-input, rapid-selection, paced-selection, or hover windows. It does not use that API to substantiate the independent 16 ms synchronous-work guards.

## Budgets and repeatability

| Metric | Release budget | Current result |
| --- | ---: | ---: |
| Warm launcher visible p95 | < 20 ms | 4.1 ms |
| Input to paint p95 | < observed frame + 2 ms | 0.1 ms |
| Arrow selection to paint p95 | < observed frame + 2 ms | 2.3 ms |
| Hover to paint p95 | < 13.8 ms paired frame | 10.7 ms |
| Raw strict-240 input / selection / hover | < 4.1667 ms each | true / true / false |
| Ordinary React commit p95 | < 3 ms | 0 ms |
| Direct synchronous input/selection bursts and hover dispatch | < 16 ms | 1.0 / 1.9 / 1.3 ms |
| Browser Long Tasks | none >= 50 ms | none |
| Active animations after settle | 0 | 0 |
| Idle UI CPU | < 2 percent | 0.77 percent |
| JavaScript heap after GC | < 100 MB | 27.53 MB |
| Unpaced input/selection bursts | correct final state, direct synchronous duration < 16 ms | 1.0 / 1.9 ms; passed |

The machine-readable result for source commit `4d384c75b4ca265c27801ae927560347bfe650ca` is `artifacts/performance/profile-summary.json`; `interaction-trace.zip` contains the correlated trace. The JSON records that exact source SHA, browser build, samples, budgets, checks, and observed cadence. A later evidence-only commit may contain these generated files without changing the source SHA they identify.

## Render-path findings

- The search input is uncontrolled, so visible typing is not gated on global React state.
- Direct input response is measured independently; debounced query work aborts or ignores stale searches by request ID.
- Keyboard selection intent and the capsule paint directly; selection-dependent React and preview work settle afterward.
- Preview selection is coalesced and stale preview work is abortable.
- Result-row accessibility selection attributes are updated with the same selection intent.
- 10,000-result collections remain virtualized with a small mounted-row count.
- Pointer movement is not connected to synchronous global React renders.
- Continuous visual work uses opacity/transform; no idle animation loop remains.

## Interpretation and limits

The original host's observed browser cadence was lower than its driver-reported 500 Hz and varied between 250, 256, and 476 Hz. The current host is driver-configured for 240 Hz while Edge estimated 238 Hz with a 4.2 ms median and 4.3 ms p95 frame interval. The report therefore preserves nominal and observed values rather than inferring a fixed rate. Browser automation is not GPU-present instrumentation, and the Tauri WebView2 compositor was spot-checked visually rather than captured with PresentMon. A future release gate should repeat this profile on representative 60, 120, 144, 165, and 240 Hz panels and add native present/ETW evidence.
