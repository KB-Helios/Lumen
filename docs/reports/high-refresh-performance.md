# High-refresh performance report

**Verified:** 2026-10-05, Windows 11, AMD Radeon 890M, driver
32.0.31041.1004, 2560 × 1600 at a driver-reported 240 Hz, 150 percent desktop
scale, Edge/WebView2 154.0.4258.53.

Lumen's motion follows the display cadence, with hardware-accelerated transform
animation verified in its visible native WebView2 window. The cadence-aware
browser release profile passes. The strict aggregate 120/240 Hz checks do not
pass; these results do not establish a fixed 120 or 240 FPS presentation rate.

## Implementation

- Launcher, preview, shimmer, settings, and onboarding movement use full
  transform strings so Motion can delegate suitable animations to WAAPI.
- The selection capsule uses Motion's native mini WAAPI spring with the existing
  quiet spring tokens. Keyboard selection intent and accessibility attributes
  update immediately; row measurement and animation retargeting coalesce to one
  requested display frame. Interrupted movement commits its current style.
- Capsule geometry includes virtual-row transforms and scroll offsets. Late
  collection mounts are observed. Reduced motion and environments without native
  animation snap directly. Queued frames, observers, and animations are cleaned up.
- The active three-dot Lottie mark interpolates its authored 60 fps artwork on
  every animation frame. Idle, reduced-motion, and forced-color states remain
  static. No per-frame React updates or permanent GPU layers were added.
- Refresh diagnostics sample complete intervals on demand, support rates above
  360 Hz, start as unmeasured, and cancel stalled/hidden sampling. Input handler
  duration is distinguished from the next animation-frame callback.

These choices preserve the existing tight, subtle motion and timing tokens. See
the [motion contract](../architecture/motion-system.md) and Motion's
[performance guidance](https://motion.dev/docs/performance).

## Browser profile

Run `bun run profile -- --headed` for the recorded configuration. It uses the
deterministic development search adapter at an 800 × 540 viewport. Browser screen
dimensions in the JSON are emulated context values; native desktop dimensions
are recorded separately. No GPU or vsync overrides are applied.

The profiler warms lazy routes, records 24 launcher round trips, 30 paced input
samples, 120 paced selection samples, and 80 hover samples paired with their
surrounding frame intervals. Two 30-event synchronous input/selection bursts
assert final state and sample counts. It also measures React commits, browser
Long Tasks, settled animation counts, one second of idle renderer task time,
garbage-collected heap, and 120 complete animation-frame intervals.

Timing runs without Playwright tracing, DOM snapshots, screenshots, or video.
Tracing during the timed phase produced occasional input p95 delays around
16–17 ms; an isolated untraced experiment measured 2.2 ms. The final sample below
is retained, including its variation. `interaction-trace.zip` is a separate
visual interaction study recorded after measurements, not a correlated timing
trace. Gallery screenshots and six motion-enabled recordings are also refreshed.
Recordings warm the development route before capture and demonstrate interaction
flow. The launcher clip includes initial browser loading before the interface
appears; it is not a startup benchmark. Their 25 fps encoding does not measure a
high-refresh display's frame rate.

| Metric | Release budget | Final result |
| --- | ---: | ---: |
| Warm launcher visible p95 | < 20 ms | 3.7 ms |
| Synchronous input handler p95 | < observed frame + 2 ms | 0.1 ms |
| Input to next frame p95 | < 6.3 ms | 2.2 ms |
| Selection to next frame p95 | < 6.3 ms | 4.9 ms |
| Hover to next frame p95 | < paired frame p95, 10.2 ms | 6.8 ms |
| Ordinary React commit p95 | < 3 ms | 0 ms |
| Synchronous 30-event input / selection bursts | < 16 ms each | 0.9 / 3.1 ms |
| Synchronous hover dispatch maximum | < 16 ms | 1.2 ms |
| Browser Long Tasks | none ≥ 50 ms | none |
| Active animations / indicators after settling | 0 / 0 | 0 / 0 |
| Idle renderer task time | < 2 percent | 0.11 percent |
| JavaScript heap after GC | < 100 MB | 29.51 MB |
| Idle frame interval median / p95 | recorded without forcing cadence | 4.2 / 4.3 ms |

All 16 cadence-aware release checks pass. Direct synchronous work is bounded
independently of observed frame latency; the Long Tasks API's 50 ms threshold
cannot establish a 16 ms or 4.167 ms work bound.

Strict target checks preserve the nominal 8.333 ms (120 Hz) and 4.167 ms (240 Hz)
budgets. Cadence permits one 0.1 ms timestamp quantum; work budgets remain strict.
At 120 Hz all interaction/work checks pass, while the hover-paired cadence p95
exceeds its target. At 240 Hz selection, hover, and cadence checks miss
their targets; input and synchronous-work checks pass. Both aggregate `passed`
values are **false**. Raw chronological
intervals and individual samples remain in
[profile-summary.json](../../artifacts/performance/profile-summary.json).

## Native hardware verification

The existing Rust shell was compiled with `cargo build --locked` in an x64
Visual Studio developer shell, then launched with isolated temporary Windows app
data and a fresh WebView2 data folder. A process-local
`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223` enabled the
[documented CDP connection](https://playwright.dev/docs/webview2). No persistent
browser flag, driver, registry, GPU, or vsync setting was changed. The test process,
debugging endpoint, and temporary profile were cleaned up afterward.

The Lumen window was visible and responding with a real native window handle.
It used development search fixtures through the normal typed service boundary.
CDP reported `gpu_compositing: enabled` and an AMD Direct3D11 ANGLE renderer.
The capsule's layer had the `ActiveTransformAnimation` compositing reason and a
running native transform keyframe animation with the shared spring easing.

| Native WebView2 measurement | Result |
| --- | ---: |
| Desktop logical size / scale | 1707 × 1067 / 150 percent |
| Tested content viewport | 800 × 540 logical pixels |
| 180 complete frame intervals, median / p95 | 4.2 / 4.4 ms |
| Refresh estimate from median | 238 Hz |
| Input handler / next-frame p95, 30 samples | 0.1 / 15.4 ms |
| Selection next-frame p95, 120 samples | 5.4 ms |
| Capsule settled top / height error | 0 / 0 pixels |
| Running animations after settling | 0 |

The machine-readable native evidence is
[native-webview-summary.json](../../artifacts/performance/native-webview-summary.json),
with a [WebView content capture](../../artifacts/performance/native-webview.png).
WebView2 retains its normal GPU-enabled configuration; actual acceleration is
verified for this host and run.

The refreshed native input next-frame p95 exceeds both nominal frame targets.
The small synchronous handler duration does not establish that the subsequent
browser/window scheduling fits a frame budget. Native timing variation remains
visible in the retained samples rather than being replaced by the faster browser
profile. The probe waits for Tauri's initial navigation before loading its test
URL; connecting as soon as the debugging endpoint appeared previously allowed
that navigation to replace the query parameters.

## Validation and evidence boundary

Typecheck, zero-warning lint, 53 unit/component files with **387 passing tests**,
all **54 installed-Edge e2e tests**, the frontend production build, and **14 script
contract/budget tests** pass. The native development binary and sidecars were
built and staged earlier the same day; their Rust source is unchanged by this
integration. Staging ran its existing Windows AI helper checks.
The current registry produced **57 screenshots** and **six recordings**; the
contact sheet, ordinary/virtualized selection, native capture, and forced colors
were inspected. Code review found no remaining issues in the native animation
or frame batching changes.

The implementation was rebased onto `517f4e5` to preserve the current theme,
responsive layouts, immediate accessible settings panels, and selected virtual
row style-change observation. A focused regression test verifies that transform
changes on a mounted selected row reposition the capsule through the same frame
batch. Final review found no required integration fixes.

An earlier complete Edge run missed the input next-frame assertion: 8 ms p95
against a 6.4 ms observed-frame budget. The isolated four performance tests and
the complete 54-test rerun passed with identical product and test source. No
threshold or retry setting was changed. This intermittent miss is part of the
timing evidence, not a claim that variability was fixed.

Both refreshed profiles identify implementation commit
`925700ce013744218af70ea6b08445cf03ac4f20`. Product source matches that commit;
`sourceWorktreeDirty` records the regenerated evidence files during the runs.
The report and refreshed artifacts are saved in a subsequent documentation
commit.
The original fresh baseline's selection capsule did not reliably position or
remain visible, so raw before/after selection timings are not equivalent visual
workloads. During implementation, per-event animation interruption caused a
57.8 ms selection burst; frame batching removed that failure, with 4.1 ms before
integration and 3.1 ms in the refreshed browser run.

Animation-frame callbacks occur before physical presentation. GPU feature
status and an accelerated animation layer establish the rendering path, not
photon timing or every delivered display frame. No ETW/PresentMon capture,
physical 120 Hz panel run, packaged release presentation measurement, or live
backend workload benchmark is claimed. The implementation follows the host
display automatically instead of introducing a fixed 60/120/240 Hz timer.
