# AI answer reliability verification

Date: 2026-10-10. Base: `28925d37e127f20edabd7b1a854c3b8a7ad4fb18`, latest `main` after merged PR #22. The final base refresh still resolved to this commit. Scope is the existing typed answer pipeline, its local preparation, and the six verified native CI regressions. No new framework, provider abstraction, dependency version, cloud grant, or product capability was added.

## Confirmed problems and corrections

The initial native loopback suite reproduced twelve defects before implementation: fragmented UTF-8 corruption, unsupported SSE framing, false success on incomplete/absent completion, unsafe malformed/error payload handling, completion waiting on an open connection, stalled HTTP error-body reads, and incorrect cleanup after transport failure. The replacement transport decodes complete UTF-8 lines incrementally, applies the SSE field/blank-line grammar, validates recognized Responses event shapes, and requires an explicit completed response. HTTP errors are classified without reading their bodies. Every failure, cancellation, deadline, and completion drops the owned response.

The controller and adapters retained obsolete text, usage and attribution on fallback, admitted late events after terminal states, treated premature EOF as active streaming, and exposed raw rejected invocation/provider text. Focused red/green runs reproduced eight controller, seventeen native adapter, five Windows adapter, and three panel failures. Each `started` event now establishes a fresh attempt while retaining source citations. Request/effect fences are checked again inside queued React reducers. Stop, Retry, replacement and unmount close iteration and abort the owned request; terminal states remain stable. Strict bounded Zod admission and fixed error-code messages protect the UI from malformed or sensitive native data.

Native request ownership now lasts through cleanup. Identity-checked RAII removes only the matching request token, cancellation never initiates fallback, and shutdown cancels the parent admission token. Review also reproduced cancellation of a non-cooperative preparation future and additional token delivery within one already-received chunk; biased outer selects and per-delta checks close those gaps. Route dispatch rechecks persisted cloud consent and the full applied route, including the configured endpoint. Local-only and cloud-only preferences remain intact; Auto can use a configured local route when optional cloud configuration is absent.

The async Tauri command can be scheduled after a synchronous Stop has already arrived. A native regression failed before the final correction because `begin` forgot that cancellation. The shared request mutex now retains and consumes the most recent 256 distinct unregistered cancellation IDs. Deduplication, eviction, unrelated identities, active ownership and shutdown are checked separately. This is a finite retention bound for the existing main-webview request flow, not indefinite storage of arbitrary cancellation IDs.

Local answer preparation previously blocked Stop while waiting for a CLI version response. An acknowledged real Windows child fixture measured **1,540.03 ms** after cancellation before the fix, failing the unchanged 250 ms assertion. Async hidden Job-contained probes, bounded output reads and explicit kill/reap reduced the focused measurement to **5.35 ms**; newly owned server readiness cancellation measured **4.08 ms**. Preparation serializes answer startup, transfers ownership only after readiness, and preserves a preexisting healthy or still-starting owned runtime.

Latest-main CI failed five search freshness cases because Windows short ancestor names such as `RUNNER~1` did not match canonical admitted roots. A new real 8.3-alias regression failed before correction; bounded spelling expansion of a checked existing ancestor now preserves deleted suffixes without admitting reparse or external routes. All five original cases passed under a short-name temporary path, and all 38 freshness cases passed with ordinary parallel test scheduling. The sixth failure was Winsock 10035 in a test server whose accepted socket inherited nonblocking mode; explicitly making that accepted socket blocking preserves its existing read deadline and request-count assertions. [The investigation](2026-10-10-ci-investigation.md) records the exact baseline evidence and its limits.

## Integration and measurement boundary

The native tests use the production loopback HTTP request, parser, deadlines, attempt orchestration and serialized Tauri `AnswerEvent` channel. Owned deterministic providers cover successful and failed streaming, partial cloud failure followed by local output, missing completion, malformed/oversized input, UTF-8 fragmentation, rate limiting, held headers and tokens, abrupt termination, fallback cancellation, reused identity and shutdown. Short private test deadlines accelerate the same production deadline paths.

`bun run test:answer-native` runs a compiled test-only native process and installed Microsoft Edge. Its private authenticated temporary bridge substitutes command transport and forwards the native events into the production `TauriAnswerService`, controller and panel. Literal rendered assertions prove the successful local attempt is the entire final answer, obsolete cloud usage/output is absent, citations survive, and Stop/Retry and rapid replacement behave correctly. A 1,000-token burst and 35 sequential HTTP failures run in that same process. `bun run test:answer-bridge` independently checks completion matching and abandoned-socket cancellation. Both gates are part of Windows CI.

The final native binary run passed in Microsoft Edge 155.0.4283.45 at `2026-10-10T02:29:15Z`. [answer-native-integration.json](../../artifacts/performance/answer-native-integration.json) records the timestamp, per-request token/cancellation timings, React commits, render time, channel callback time and six post-warmup working-set samples. First-token timing includes the first attempt in the fallback case; it is not live model inference latency.

| Final native/rendered fixture | Native first token | First rendered token | React commits | Total React render / channel callback time |
| --- | ---: | ---: | ---: | ---: |
| Partial cloud failure → local completion | 37.50 ms | 67.10 ms | 7 | 24.80 / 6.10 ms |
| Successful rapid replacement | 10.80 ms | 24.60 ms | 5 | 7.40 / 0.30 ms |
| 1,000-token burst (1,003 native events) | 20.48 ms | 35.30 ms | 12 | 19.50 / 12.80 ms |

Native Stop cancellation measured **7.52 ms** and replacement cancellation **5.96 ms**. Rendered Stop, including the browser click and phase observation, measured **61.42 ms**; all unchanged 250 ms bounds passed. Across 35 failures, every request drained before the next submission. Native working set ranged from 15,163,392 to 15,175,680 bytes across six post-warmup samples, a **12,288-byte** first-to-last increase.

| Same-turn jsdom burst probe | Before | After |
| --- | ---: | ---: |
| React commits for 1,000 tokens | 1 | 1 |
| React render duration | 0.9215 ms | 1.0430 ms |
| Complete update duration | 7.7924 ms | 7.7544 ms |

Native adapter validation/admission/drain took 7.2782 ms in the focused jsdom probe. This comparison supports retaining existing React batching; it does not establish a frame-rate improvement. Separate installed-Edge results in the native integration artifact measure actual scheduled channel delivery. No deferred token flush, extra animation loop or rendering framework was added.

The general browser profile initially flagged a 64 ms long task during rapid input while native checking ran. The unchanged 50 ms threshold failed that run. A second run, performed serially after native gates finished, had no long tasks but failed selection timing: 13.9 ms against its 10.4 ms cadence-aware budget. The selection path and profiler are unchanged by this answer work. [All three run outcomes](../../artifacts/performance/answer-profile-runs.json) retain their measured values, budgets and checks. The final serial repeat passed all 16 unchanged cadence-aware checks: warm launcher p95 2.7 ms, input 0.0 ms at the instrumentation's precision, selection 4.3 ms, hover 6.9 ms, no measured long tasks, idle CPU 0.302% and JS heap 31.373 MB. Observed cadence was about 238 Hz; strict nominal 240 Hz selection/hover and aggregate checks remain false. The variation between runs does not establish a cause, a guaranteed frame rate, or a performance improvement from the answer changes.

## Required gates

This host runs Windows 11 Pro build 26300, Bun 1.3.14, Rust 1.95.0 and Microsoft Edge 155.0.4283.45. Commands use Bun and the configured Visual Studio developer environment. Native builds used a target directory on D: and bounded build/test-worker concurrency to avoid exhausting C: or RAM; test assertions and scheduling inside the native suite are unchanged.

| Gate | Fresh result |
| --- | --- |
| `bun install --frozen-lockfile` / `bun run stage:sidecars` | Passed; pinned sidecars staged, including Computer Use and Windows AI helpers. |
| `bun run typecheck` | Passed. |
| `bun run lint` | Passed with zero-warning policy. |
| `bun run test -- --maxWorkers=2` | 70 files, 579 tests passed. |
| `bun run test:e2e` | 61 tests passed in installed Edge; serial, no retries. |
| `bun run test:answer-bridge` | Three real socket tests passed. |
| `cargo fmt --all -- --check` | Passed on the final native sources. |
| `cargo clippy --all-targets --all-features -- -D warnings` | Passed on the final native sources. |
| `cargo test --all-features -j 1` | 263 unit and 25 integration tests passed; 15 explicit fixture/external acceptance tests ignored. Ordinary parallel test scheduling; unit execution 25.01 seconds. |
| `bun run test:answer-native` | Passed on the final native binary in installed Edge; exact fallback/rendered text, Stop/Retry, replacement, 1,000 tokens and 35 failures verified. |
| `bun run capture:gallery` | 57 gallery states and contact sheet regenerated. |
| `bun run record:interactions` | All six recordings regenerated. |
| `bun run profile` | Final serial repeat passed all 16 existing cadence-aware checks. Earlier long-task and selection failures are disclosed above; strict 240 Hz aggregate remains false. |
| `bun run tauri build` | Passed: optimized native build (14m09s) and one NSIS installer, 202,981,741 bytes. Existing Lottie dependency emitted its direct-eval bundler warning; build succeeded. |
| Existing isolated installer smoke | Passed clean-profile preflight, install/resource checks, exact-vector and lexical fallback, native Stop, window lifecycle, diagnostic sanitization, improvement defaults, uninstall and profile cleanup. |

[The installer smoke artifact](../../artifacts/packaged/answer-reliability-smoke.json) records SHA-256 `7ac673379f0804c23d66786290d1c3755de7fd3b3528b8215599b5c373a81bc5` and all successful checks. The D: build output was copied into the ignored checkout helper directory because the existing smoke script accepts a repository-relative installer path. Its signature probe reported `Unavailable`; signing was not verified. This smoke verifies packaged infrastructure and startup, not packaged WebView AI answer acceptance or live Computer Use/provider execution.

## Review and security

Independent native, frontend and integration reviews checked the complete diff and reproduced material findings. Findings covered malformed event type admission, cancellation around non-cooperative preparation, route revalidation, early Stop admission, and cleanup if Edge setup failed. Final review also found an owned test provider whose blocking `accept` and joining Drop could hang when no client connected or a connected client left its request incomplete. Both cleanup regressions failed their unchanged 250 ms bounds before correction. Windows socket shutdown did not promptly interrupt an already-blocked read, so the final fixture uses stop-aware nonblocking accept and request admission with independent three-second deadlines, then restores blocking three-second I/O for the provider handler. Both cleanup tests passed together in 0.01 seconds; independent follow-up review found no remaining material ownership issue.

The first complete Rust rerun passed 260 tests and exposed two fixture failures. The idle-deadline case could hit its equally short header deadline before it reached idle waiting. Its idle phase still has a 60 ms deadline and unchanged 250 ms elapsed assertion; the separate held-header case retains its 60 ms header limit. The other failure was global hotkey contention between a direct synthetic Stop test and the real native Ctrl+Alt+Esc test. A deterministic admission assertion reproduced that conflict. Only the synthetic test now constructs an unregistered, unavailable Stop fixture; production registration and the real native hotkey assertions are unchanged. The ordinary parallel Computer Use subset passed all 36 tests, with six existing ignored acceptance tests.

Credentials remain in Rust and never enter React or the test executor. Production HTTP targets, local binaries/arguments, process containment and consent boundaries are retained. No shell capability, configurable test URL or test-only command is added to release Lumen. Provider bodies, rejected invocation text, subprocess details and credentials are excluded from frontend errors; structured codes use fixed safe messages. Source/index admission still canonicalizes the trust boundary and refuses symlinks/reparse routes. Frontend queues, event streams, native frames/wire/output and local probe streams all have explicit bounds.

See [answer-service.md](../architecture/answer-service.md) for state transitions, production limits, ownership and reproducible commands. The frontend, local preparation and integration worklogs contain the focused red/green evidence.

## Remaining evidence limits

This verifies real Windows processes, loopback sockets, native channel serialization and installed-Edge rendering with deterministic fixtures. It does not establish live cloud credentials/provider availability, installed Lemonade/FLM hardware inference, or packaged WebView answer acceptance. The obsolete usage event is a deliberate test-only precondition; production usage is published on successful completion. Working-set samples and zero retained fixture requests establish the measured run, not a proof of every allocator/resource behavior.

Already-running synchronous SQLite context work may finish in its bounded pool after the request stops waiting; it cannot emit an answer or enter a provider attempt. Existing non-answer management health/start commands retain their synchronous behavior. Settings application and dispatch are separate operations, so an accepted in-flight provider request retains its original attribution. The general browser profile's strict 240 Hz field must be interpreted independently from cadence-aware checks and does not establish packaged compositor performance.

The focused PR targets latest main and must remain unmerged. Final hosted CI status is reported on the attached PR after checking its head revision; local tests do not substitute for that status.
