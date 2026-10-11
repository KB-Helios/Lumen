# UI completion and motion refinement

Date: 2026-10-11. Branch: `codex/ui-completion-motion`. Approved baseline: `4e12b66209f2c313c084109ca0212bd364b11099`.

The branch completes the scoped UI operations and refines existing materials/motion while retaining Rust ownership of credentials, fixed provider writers, consent, cancellation and native geometry. Production acceptance remains incomplete: source-final scratch hover and ordinary React budgets fail, strict-240 fails, and final committed-source/package/manual evidence is pending. Publication must remain a draft while required acceptance is incomplete; no merge is requested.

## Completed views and operations

All eleven settings pages are covered: General, Appearance, Indexed roots, Search, Local AI, AgentGateway, Providers, Computer Use, Activity, Privacy and Diagnostics. The first-run flow has four actual steps: Welcome, Indexed folder, Shortcut and Answer choices. `src/features/gallery/scenarios.ts` currently defines 86 states using production components, including full settings shells, every onboarding step, Add/Edit/Remove profile dialogs, empty/error/unavailable providers, AI cancel/retry, provisioning error/cancel and Computer Use unavailable/denied/target-lost/cancel/error/approval. This is the source registry count; checked-in screenshots/manifest have not yet been regenerated for this source. Fixture services are explicitly simulated and DEV-gated; they do not write user configuration, store provider keys, download models or execute live providers.

Before this work, onboarding could leave before durable completion, indexing admission could appear Ready, stale native operations/copy could mark newer state successful, and confirmation failure could dismiss its feedback. Completion now awaits successful persistence/admission; roots consume typed status with stale-observation fences, async confirmations close only after success, and native/provisioning/credential/copy operations retain bounded pending ownership and reject obsolete completions. Failure preserves choices or newer input and exposes retry feedback. Appearance and settings save failures share one recoverable notice. Search availability finishes checking and offers retry. General/Activity/Gateway operations reject duplicates and retain safe error feedback.

Selected-result actions follow the latest ID, provenance, pin state and supported kind without moving the uncontrolled composer input. Keyboard selection paints attributes synchronously and coalesces scrolling to the latest intent; indexed lookups and virtualization preserve 10,000-result behavior. Streaming updates one stable answer region; cancellation, copying and retry do not recreate it per token. Existing main answer streaming/fallback/cancellation and desktop Computer Use security contracts are retained.

## Supported provider management

The Providers page supports five existing fixed targets: exclusive Claude/Codex/Gemini and additive OpenCode/OpenClaw. Add/Edit saves metadata and the credential; explicit Switch/Enable activates the stored profile through the existing native atomic fixed-path writer. Removing from live configuration leaves the saved profile available. Unsupported presets remain unavailable. OAuth Authorization and Usage remain separate sidecar features; linked OAuth cannot satisfy a missing API-key profile requirement.

`ProvidersService` validates inputs and Zod-parses non-secret native responses. Rust validates the fixed target enum, bounded single-line fields and absolute HTTP(S) base URL, stores metadata atomically in application data, and keeps credentials in UUID slots under Windows Credential Manager namespace `com.bridgehammer.lumen.tool-profiles`, separate from gateway credential IDs. Blank/omitted Edit keys retain the stored key. Responses contain metadata and active/enabled state only; keys are neither returned nor logged. UI-supplied paths, arbitrary commands and provider execution are excluded. Existing journals/backups/recovery, unrelated configuration preservation and failed-update rollback remain intact.

Isolated injected tests cover all five writers, invalid input, redacted responses, key retention, metadata/credential failures and recovery. The actual Windows adapter test passed one fresh synthetic UUID-slot round trip and verified exact NoEntry cleanup; it is credential-store fixture evidence, not live provider authentication.

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

Full raw comparison, sampling definitions and historical limits are in [high-refresh-performance.md](high-refresh-performance.md). Host: AMD Radeon 890M, driver 32.0.31041.1004, 2560 × 1600 configured at 240 Hz; installed Edge 155.0.4283.45, WebView2 154.0.4258.62. Read-only Win32 inventory advertises 60/240 Hz at this resolution. 60 Hz is unmeasured; 120/144/165 Hz are unavailable in the inventory. No display mode changed.

Revised unchanged-UI baseline: 8.7 ms ordinary React p95 over 163 meaningful samples, hover 4.7 ms against 4.3 ms, idle 0.111%, strict-240 failed. The original profiler's empty React samples reported zero, which is not a measured React pass. The final Task 5 scratch run (`%TEMP%/lumen-ui-audit-d61a/task-5-final/profile-summary.json`, `2026-10-11T01:25:04.659Z`) reports SHA `1fce4d51029acb42165c8c22845d79c12a33d43c` with dirty Task 5 source: warm 6.3 ms, synchronous input 0.1 ms, input-to-callback 4.3 ms, selection-to-callback 5.9 ms, hover 4.9 ms against 4.3 ms (fail), ordinary React 7.4 ms over 146 samples against 3 ms (fail), idle 0.138%, heap 31.905 MiB. Direct 30-event input/selection bursts are 0.6/2.1 ms; no >=50 ms browser Long Tasks occur. Settled capsule alignment is 0 px, and settled/hidden animations, activity indicators and selection measurements are zero. This source snapshot is not the final committed-source profile.

The observer fix removed pre-fix sustained idle work (13.882% to 0.131% in the observer-only run). Sample-count and latency differences across these isolated snapshots do not establish a guaranteed speedup. No threshold or sample filter changed. Hover uses actual surrounding callback endpoints plus independent computed-style readiness; input-response is synchronous handler time. Input-next-frame/selection/hover end at rAF callbacks before presentation. Raw callback cadence estimates 238 Hz with 4.2 ms median/4.4 ms p95; browser GPU status is Edge process evidence. A computed strict-120 result on this host does not establish an actual 120 Hz panel test. Native compositor presentation and native React timings are not measured.

## Accessibility and responsive coverage

Task 5's installed-Edge run passed 107/107 tests (one worker, no retries) across all eleven settings pages, four onboarding scenes and required launcher/gallery/provider-dialog states. The matrix uses 100/125/150/175/200% CSS text scales and dark/light/opaque/reduced-effects/reduced-motion/forced-colors, Rust default/minimum/maximum logical dimensions and a 520 × 340 stress viewport. It checks <=1 px horizontal overflow, contained/reachable actions, accessible controls, focus restoration, virtualized latest-keyboard selection, input/caret/composition and stable streaming. DEV fixture dimensions remove only the browser host's default cap; production descendants are unchanged.

These are browser renderer and component checks, not proof of native HWND geometry, Windows DPI/text settings, multi-monitor transitions, live authentication or Narrator speech. [Accessibility](accessibility.md) and [DPI validation](dpi-validation.md) preserve historical native smoke separately. No current manual Narrator pass is claimed.

## Verification and evidence status

| Gate / evidence | Verified result / remaining work |
| --- | --- |
| Task 5 focused source checks | Typecheck and zero-warning lint exit 0; final gallery/runtime focused 44/44 and runtime 11/11 pass |
| Task 5 serial installed Edge | 107/107 pass, exit 0; final root rerun pending |
| Full serial frontend unit gate with Python 3.11 | 700/700 pass across 81 files, exit 0, 280.26 s after fixture-only `63f4763`; initial 699 pass/1 fail retained and diagnosed as undefined mocked provisioning response. No assertion, timeout or production behavior changed |
| Final frontend typecheck/lint/build | Typecheck and zero-warning lint exit 0; frontend build pending |
| Native fmt / all-targets all-features Clippy `-D warnings` | Exit 0 on unchanged native source `1fce4d5` |
| Native all-feature serial tests | 304 pass, 16 ignored, exit 0; ignored tests are not passes |
| Explicit native Stop fixture | Held-admission + blocked-stdin Job Object fixture, 20 samples pass; independent admission closure, not UI/live-provider proof |
| Staged executor fresh installed Edge fixture | Wire/warm-pool verification pass; fresh fixture context, not existing user profile/live provider |
| Credential backend | Actual owned Windows slot 1 pass; injected suite 8 pass/1 ignored |
| Checksum-pinned sidecar staging | Earlier staging exit 0; final package gate pending |
| Normal full Tauri release/NSIS smoke | Pending root build and isolated normal-package smoke |
| Separate identifier-isolated native provider UI fixture | Prepared only; no build/launch/UI acceptance result yet |
| Final profile/gallery/recordings | Pending final committed-source regeneration and visual inspection |
| Independent review / publication | Task 5 review reports no additional blocking functional defect; hover/React/strict-240 performance finding remains open. Whole-branch review/publication pending; draft PR required while acceptance remains incomplete |

Runtime changes are committed as `9ccedbc51af31fd2c94e8d199312552b937a8178`; baseline/native Stop evidence is preserved in `7a170b6`, and independently approved test-only fixture correction in `63f4763`. The first serial unit run's 699 pass/1 fail is retained in the ignored gate ledger as `final-units-initial.log`/exit 1; the repaired fixture provides a valid typed provisioning response while retaining the original no-alert assertion. The earlier concurrent 687 pass/7 fail was a failed run and is not counted as verification. Checked-in baseline evidence is `artifacts/performance/ui-audit-original-baseline.json`, `ui-audit-revised-baseline.json` and `ui-display-inventory.json`. Final evidence belongs in `artifacts/performance/profile-summary.json`, `artifacts/screenshots/manifest.json` and `artifacts/recordings/manifest.json`; their source SHA/dirty flag must be read as recorded rather than inferred from an evidence-only commit. A proposed native 60 Hz calibration strategy is prepared only and has not been performed.

## Remaining acceptance

Required performance failures remain visible: hover <paired 4.3 ms and ordinary React p95 <3 ms, plus aggregate strict-240. Final serial/source/package checks and independent review must complete before publication claims are updated. Live provider requests, actual current-source Narrator speech, native compositor/input-to-presentation evidence, measured 60 Hz and unavailable 120/144/165 Hz contexts, physical mixed-DPI/multi-monitor transitions and broader assistive-technology studies remain unverified. Browser fixtures, actual native fixtures, normal packaged startup and live/manual acceptance must stay separate. This report does not call the branch production-ready.
