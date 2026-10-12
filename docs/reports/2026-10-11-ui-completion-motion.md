# UI completion and motion refinement

Evidence date: 2026-10-11; documentation finalized 2026-10-12. Branch: `codex/ui-completion-motion`. Approved baseline: `4e12b66209f2c313c084109ca0212bd364b11099`. Final production UI source: `f0e6b6edc19879b0701088b254a9a3423e7c1fd8`.

The branch completes the scoped UI operations and refines existing materials/motion while retaining Rust ownership of credentials, fixed provider writers, consent, cancellation and native geometry. Final unit/source/build/package and isolated native provider integration checks pass. Required performance acceptance remains failed: final browser hover, ordinary React, ordinary-query Long Tasks and strict-240 fail, and the full Edge run is not a pass. Live/manual/presentation acceptance remains unverified. Publication must remain a draft; no merge is requested.

## Completed views and operations

All eleven settings pages are covered: General, Appearance, Indexed roots, Search, Local AI, AgentGateway, Providers, Computer Use, Activity, Privacy and Diagnostics. The first-run flow has four actual steps: Welcome, Indexed folder, Shortcut and Answer choices. `src/features/gallery/scenarios.ts` defines 86 states using production components, including full settings shells, every onboarding step, Add/Edit/Remove profile dialogs, empty/error/unavailable providers, AI cancel/retry, provisioning error/cancel and Computer Use unavailable/denied/target-lost/cancel/error/approval. The regenerated screenshot manifest contains all 86 captures at `c58a669f9a3e872527e3df8531c8adbe52d7628f`; six recordings identify production source `f0e6b6e`. Capture-only readiness corrections did not change production UI. Gallery/recording frames were inspected, including fully visible Answer choices, a loaded provider row and approval state. Fixture services are explicitly simulated and DEV-gated; they do not write user configuration, store provider keys, download models or execute live providers.

Before this work, onboarding could leave before durable completion, indexing admission could appear Ready, stale native operations/copy could mark newer state successful, and confirmation failure could dismiss its feedback. Completion now awaits successful persistence/admission; roots consume typed status with stale-observation fences, async confirmations close only after success, and native/provisioning/credential/copy operations retain bounded pending ownership and reject obsolete completions. Failure preserves choices or newer input and exposes retry feedback. Appearance and settings save failures share one recoverable notice. Search availability finishes checking and offers retry. General/Activity/Gateway operations reject duplicates and retain safe error feedback.

Selected-result actions follow the latest ID, provenance, pin state and supported kind without moving the uncontrolled composer input. Keyboard selection paints attributes synchronously and coalesces scrolling to the latest intent; indexed lookups and virtualization preserve 10,000-result behavior. Streaming updates one stable answer region; cancellation, copying and retry do not recreate it per token. Existing main answer streaming/fallback/cancellation and desktop Computer Use security contracts are retained.

## Supported provider management

The Providers page supports five existing fixed targets: exclusive Claude/Codex/Gemini and additive OpenCode/OpenClaw. Add/Edit saves metadata and the credential; explicit Switch/Enable activates the stored profile through the existing native atomic fixed-path writer. Removing from live configuration leaves the saved profile available. Unsupported presets remain unavailable. OAuth Authorization and Usage remain separate sidecar features; linked OAuth cannot satisfy a missing API-key profile requirement.

`ProvidersService` validates inputs and Zod-parses non-secret native responses. Rust validates the fixed target enum, bounded single-line fields and absolute HTTP(S) base URL, stores metadata atomically in application data, and keeps credentials in UUID slots under Windows Credential Manager namespace `com.bridgehammer.lumen.tool-profiles`, separate from gateway credential IDs. Blank/omitted Edit keys retain the stored key. Responses contain metadata and active/enabled state only; keys are neither returned nor logged. UI-supplied paths, arbitrary commands and provider execution are excluded. Existing journals/backups/recovery, unrelated configuration preservation and failed-update rollback remain intact.

Isolated injected tests cover all five writers, invalid input, redacted responses, key retention, metadata/credential failures and recovery. The actual Windows adapter test passed one fresh synthetic UUID-slot round trip and verified exact NoEntry cleanup; it is credential-store fixture evidence, not live provider authentication.

The final identifier-isolated release exercised the actual production Providers UI and real Windows Credential Manager for all five targets: Add/Edit, blank-key retention, activation, owned configuration readback, unrelated-field preservation, full process reopen and removal from live while retaining the saved profile/key all pass. A real invalid-metadata native failure retains its dialog and retry; retry succeeds. Only synthetic keys and owned fixture homes/application data were used. Final cleanup deleted five exact UUID credentials with NoEntry verified, exited every recorded process, removed guarded owned fixture paths, restored the normal executable hash and preserved the original 240 Hz display. Ordinary tool configurations and user credentials were neither modified nor enumerated. This establishes native fixture integration, not live authentication.

## Materials and motion ownership

Glass intensity applies only to decorative specular/luminosity/noise layers; 72 preserves the prior appearance. Foreground opacity is unchanged, and opaque/reduced-effects/forced-colors overrides take precedence. The single System/Full/Reduced preference drives the shared motion policy; the obsolete synchronization switch/field is removed.

| Owner | Motion and cleanup |
| --- | --- |
| Motion | Launcher/workspace, preview, onboarding/settings and stable answer container; complete transform strings, generation-fenced exits, immediate reduced geometry |
| Native mini / WAAPI | Capsule spring from visible position and one bounded result-set opacity cascade; coalesced row geometry, latest selection, cancel/disconnect on hidden/unmount |
| CSS / React Aria | Controls and overlays; opacity-only reduced keyframes <=80 ms, focus semantics and functional virtualizer/slider transforms preserved |
| GSAP | Brief activity-wrapper entrance only; scoped context reverts and clears temporary properties |
| Lottie | Inner active-work SVG only; interpolated subframes, active + launcher-visible + document-visible gates, destroy/static fallback |

Each property has one owner. Native expansion finishes allocating Rust bounds before workspace reveal; collapse retains workspace/footer through exit and signals the presentation hook before Rust collapses. Typing interrupts obsolete exit completion. The input DOM, caret and IME composition survive mode/result changes. Result-set replacement resets React Aria selection while scrolling/policy toggles cannot replay a consumed cascade. A retained selected-row observer eliminates the initial ResizeObserver notification loop; hidden surfaces disconnect row/style/content observation and cancel pending frames. Preview shimmer is one bounded sweep. Structural radius snaps; blur, shadows and textures never animate. No idle loop or permanent `will-change` is added. Stop/cancel/approval never waits for an animation.

No shader engine, WebGPU integration, Canvas/WebGL background, new animation framework, added dependency, GPU flag or unrelated backend rewrite is included.

## Performance evidence

Full raw comparison, sampling definitions and historical limits are in [high-refresh-performance.md](high-refresh-performance.md). Host: AMD Radeon 890M, driver 32.0.31041.1004, 2560 × 1600 configured at 240 Hz; installed Edge 155.0.4283.45, WebView2 154.0.4258.62. Win32 inventory advertises 60/240 Hz at this resolution. Both 60 Hz and original-mode `CDS_TEST` validations return 0, but actual 60 Hz capture is unperformed: the independent watchdog reported inside a Job Object, preventing any display mutation. 120/144/165 Hz are unavailable at the current resolution. Final display readback is unchanged at 240 Hz.

Revised unchanged-UI baseline: 8.7 ms ordinary React p95 over 163 meaningful samples, hover 4.7 ms against 4.3 ms, idle 0.111%, strict-240 failed. The original profiler's empty React samples reported zero, which is not a measured React pass. The earlier Task 5 scratch snapshot at dirty SHA `1fce4d5` measured React 7.4 ms/146 and hover 4.9/4.3 ms, both failed; it is an intermediate result, not the final clean-source artifact.

The final `artifacts/performance/profile-summary.json` is generated `2026-10-11T14:30:51.732Z` at SHA `a22df58fd6808c1546278eefa6fb3b3df6baeb7a`, `sourceWorktreeDirty: false`. It measures warm 4.5 ms, synchronous input 0.1 ms, input-to-callback 3.3 ms, selection-to-callback 7.3 ms, hover 5.1 ms against 4.334 ms (fail), ordinary React 20 ms/146 samples against 3 ms (fail), and ordinary-query Long Tasks 61/69/62/57 ms (fail). Direct 30-event input/selection bursts are 0.6/1.4 ms, with no rapid-input/selection/hover >=50 ms tasks. Idle is 0.215%, post-GC heap 31.827 MiB, capsule alignment 0 px and all settled/hidden animation/activity/selection-measurement counts zero. Raw cadence is median 4.2 ms/p95 12.5 ms/estimate 238 Hz. The unchanged cadence-aware formula yields a 14.5 ms input/selection allowance for this capture; overall acceptance, strict-120 and strict-240 remain false and the profile exits 1.

The observer fix removed pre-fix sustained idle work (13.882% to 0.131% in the observer-only run). Sample-count, cadence and latency differences across isolated snapshots do not establish a guaranteed speedup. No threshold or sample filter changed. Hover uses actual surrounding callback endpoints plus independent computed-style readiness; input-response is synchronous handler time. Input-next-frame/selection/hover end at rAF callbacks before presentation. Browser GPU status is Edge process evidence; calculated refresh budgets do not establish a physical display-mode test.

Actual native WebView2 fixture sampling at the independently read-back 240 Hz setting records 120 callbacks, median 4.2 ms/p95 4.3 ms. The p95 exceeds 4.1667 ms strict-240; this is not a native frame-budget pass. Production native React timings and compositor/input-to-presentation timing are Not measured.

## Accessibility and responsive coverage

Task 5's installed-Edge run passed 107/107 tests (one worker, no retries) across all eleven settings pages, four onboarding scenes and required launcher/gallery/provider-dialog states. The matrix uses 100/125/150/175/200% CSS text scales and dark/light/opaque/reduced-effects/reduced-motion/forced-colors, Rust default/minimum/maximum logical dimensions and a 520 × 340 stress viewport. It checks <=1 px horizontal overflow, contained/reachable actions, accessible controls, focus restoration, virtualized latest-keyboard selection, input/caret/composition and stable streaming. DEV fixture dimensions remove only the browser host's default cap; production descendants are unchanged.

The later full root Edge run at `57fa37d` is 130 pass/1 fail/2 did not run, exit 1: ordinary React p95 6.4 ms exceeds 3 ms. Both skipped cases pass separately at `f0e6b6e`; the separate hover result 7.2 ms versus 8.2 ms allowance is cadence-aware only. The full run remains failed. Browser renderer/component checks do not establish Windows DPI/text settings, physical IME candidate behavior, multi-monitor transitions, live authentication or Narrator speech.

The isolated native fixture verifies settings at 880 × 600 logical pixels, DPR 1.5, and a 700 × 66 launcher without horizontal overflow. Three rapid Enter/Escape reversals retain the input DOM/caret and settle at collapsed bounds. These are bounded current-source native observations, separate from the browser matrix and package startup. [Accessibility](accessibility.md) and [DPI validation](dpi-validation.md) retain earlier native smoke as historical evidence. No current manual Narrator or physical IME pass is claimed.

## Verification and evidence status

| Gate / evidence | Verified result / remaining work |
| --- | --- |
| Task 5 focused source checks | Typecheck and zero-warning lint exit 0; final gallery/runtime focused 44/44 and runtime 11/11 pass |
| Task 5 serial installed Edge | Earlier functional matrix 107/107 pass, exit 0 |
| Root full installed Edge | 130 pass/1 fail/2 did not run, exit 1 at `57fa37d`; React 6.4 ms >3 ms. Two skipped cases separately pass at `f0e6b6e`; full run remains failed |
| Final full serial frontend units with Python 3.11 | 704/704 pass across 82 files, exit 0, 412.40 s at `f0e6b6e`; earlier 700/81 pass and diagnosed 699/1 fixture failure preserved |
| Final frontend typecheck/lint/build | All exit 0 at `f0e6b6e`; publication lint exit 0 at `a22df58` |
| Native fmt / all-targets all-features Clippy `-D warnings` | Exit 0 on unchanged native source `1fce4d5` |
| Native all-feature serial tests | 304 pass, 16 ignored, exit 0; ignored tests are not passes |
| Explicit native Stop fixture | Held-admission + blocked-stdin Job Object fixture, 20 samples pass; independent admission closure, not UI/live-provider proof |
| Staged executor fresh installed Edge fixture | Wire/warm-pool verification pass; fresh fixture context, not existing user profile/live provider |
| Credential backend | Actual owned Windows slot 1 pass; injected suite 8 pass/1 ignored |
| Checksum-pinned sidecars | Staging exit 0; packaged runtime inventory verified by installed smoke |
| Normal full Tauri release/NSIS | Exit 0 at `f0e6b6e`; installer 203,053,501 bytes, signature status Unavailable |
| Normal installed package smoke | Exit 0; exact-vector/lexical fallback, show/hide, sanitized export, packaged runtime inventory/defaults, uninstall and profile cleanup pass. Ordinary Roaming app-data hash unchanged |
| Identifier-isolated native provider UI | Actual five-target flows/real WCM/failure+retry pass; exact credential/path/process/binary cleanup verified; no live authentication |
| Native display contexts | Actual 240 Hz callbacks captured, p95 4.3 ms >4.1667 ms; React/presentation Not measured. 60 Hz validated only/unperformed; 120/144/165 unavailable |
| Final profile/gallery/recordings | Profile exit 1 with failed metrics retained; gallery 86 captures and six studies regenerated/inspected, exit 0 |
| Evidence generator contracts | Six existing contracts pass, exit 0 after capture-only correction |
| Independent review / publication | Whole-source review complete; two destructive confirmation callers corrected at `f0e6b6e`, scoped re-review approved. Final evidence/docs review approved at `3dd0642`; performance remains open and draft publication is required |

Runtime coverage/selection changes are committed as `9ccedbc51af31fd2c94e8d199312552b937a8178`; final production source is `f0e6b6e`. The first serial unit run's 699 pass/1 fail is retained in the ignored gate ledger as `final-units-initial.log`/exit 1; a valid typed provisioning fixture retains the original no-alert assertion. The earlier concurrent 687 pass/7 fail is not counted as verification. Native source is verified unchanged from `1fce4d5` through final source; ignored tests remain ignored.

The [verification manifest](../../artifacts/verification/ui-completion-motion/manifest.json) preserves 21 raw gate outputs with command, source, boundary, exit, byte count and SHA-256, plus 16 sanitized native JSON/PNG artifacts. [Native integration summary](../../artifacts/verification/ui-completion-motion/native-ui-acceptance-summary.json) records exact provider/display/cleanup results. Historical harness launch/CDP/route/JSON-normalization failures were corrected in ignored harnesses before the successful product operations; they are not represented as product passes. Published evidence excludes fixture keys/configuration, profile credential slots and ownership runtime data.

Normal package startup and the identifier-isolated interactive native fixture are distinct. `Lumen_0.1.0_x64-setup.exe` SHA-256 is `a4ba9cc94deb839e8f1109c465b57c25599f4b0973aecd275c80cb635cfdf0e7`. The native fixture restores the normal executable SHA-256 `4D363A340EA2C5CB03B9187E121E41C8E5162C4DBD90BD39458CFFC519E0A9EA`; cleanup verifies five exact credential NoEntry results, all recorded processes exited and unchanged display. Neither package smoke nor synthetic native provider success proves live provider behavior.

Baseline evidence remains `artifacts/performance/ui-audit-original-baseline.json`, `ui-audit-revised-baseline.json` and `ui-display-inventory.json`. Final profile, gallery and recording manifests record their own SHA/dirty provenance; an evidence-only commit does not change the runtime source they identify. Timed profiles exclude tracing/screenshots; `interaction-trace.zip` is a separate study.

## Remaining acceptance

Required failures remain visible: final hover 5.1 ms >paired 4.334 ms, ordinary React p95 20 ms >3 ms, ordinary-query Long Tasks 61/69/62/57 ms, full Edge failure and aggregate strict-240 failure. Native 240 Hz callback p95 also exceeds the nominal budget. Live provider requests, current-source Narrator speech, physical IME candidate behavior, native compositor/input-to-presentation evidence, actual 60 Hz capture, unavailable 120/144/165 Hz contexts, physical mixed-DPI/multi-monitor transitions and broader assistive-technology studies remain unverified. Browser fixtures, actual native fixtures, normal packaged startup and live/manual acceptance stay separate. Final evidence/docs review is approved; failed acceptance requires draft publication. This report does not call the branch production-ready.
