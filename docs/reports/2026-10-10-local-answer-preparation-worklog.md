# Answer reliability: cancellable local runtime preparation

Date: 2026-10-10. This follow-up was delegated after the frontend Task 2 work and independent integration review. Production changes are confined to `src-tauri/src/gateway/local_runtime.rs`; subprocess regressions are in its new sibling `local_runtime_answer_tests.rs`. The parent owns answer transport, route integration, full native gates, and packaging. No dependencies, shell permissions, production process arguments, staging, commits, or branch changes were introduced by this worker.

## Observed failure and correction

The initial `prepare_answer` wrapper retained the blocking preparation behavior. A regression starts the current test executable as an explicitly ignored, hidden version helper; the helper writes its PID before withholding its version response for 1.5 seconds. A separate thread waits for that acknowledgement and cancels the request. This avoids cancelling before the child exists or confusing executable startup latency with cancellation latency.

Before the fix, `cancellation_kills_and_reaps_an_acknowledged_owned_version_probe` failed its 250 ms cancellation bound: preparation took **1.5400287 seconds** after cancellation. The failure was observed before replacing the blocking behavior. The first focused green run passed that same test; the expanded fresh run measured **5.3544 ms** and independently checked that its acknowledged PID was no longer alive.

The new async preparation method accepts the request's existing cancellation token and absolute Tokio deadline. It serializes answer startup with a cancellation-aware mutex, probes fixed Lemonade and optional FLM binaries through hidden Tokio children, bounds each captured stdout/stderr stream at 16 KiB, and applies a five-second probe bound within the overall request deadline. Failed, cancelled, expired, or oversized probes are killed and reaped. A Windows kill-on-close Job Object also confines each version probe.

Readiness remains the existing local TCP admission check, performed asynchronously with a 150 ms connect bound. A newly spawned fixed runtime stays locally owned until readiness succeeds; its existing Job Object and `RuntimeProcess` cleanup kill and reap it on cancellation, failure, or dropped preparation futures. Startup readiness is bounded by eight seconds and the request deadline. The successful process is transferred to the supervisor only after rechecking cancellation/deadline and ownership.

A healthy previously owned process retains the existing version admission and returns without another CLI probe. An external listening runtime still has to pass pinned version checks. Cancellation while an existing process is still becoming ready preserves that PID. Concurrent answer startup is serialized; a cancelled waiter cannot launch another probe. A process started concurrently through the existing management path is preserved rather than overwritten.

Only static codes leave this method: `cancelled`, `request_timeout`, and `local_runtime_unavailable`. Executable paths and raw subprocess or I/O errors are not returned. Existing settings/health/start commands are retained; the parent connects answer requests to the new preparation method and owns the 120-second total answer deadline.

## Fresh focused verification

```powershell
rtk proxy rustfmt --edition 2024 src-tauri/src/gateway/local_runtime.rs src-tauri/src/gateway/local_runtime_answer_tests.rs
# Exit 0; only these two Rust files formatted.

rtk proxy .superpowers/run-native.cmd cargo test --manifest-path src-tauri/Cargo.toml --all-features gateway::local_runtime -- --nocapture --test-threads=1
# 14 passed; 0 failed; 2 ignored subprocess helpers; 2.61 seconds test execution.
# Compilation completed in 1 minute 5 seconds with no warnings.
# Acknowledged owned version-probe cancellation: 5.3544 ms.
# Acknowledged newly owned readiness-server cancellation: 4.079 ms.

rtk proxy git diff --check -- src-tauri/src/gateway/local_runtime.rs src-tauri/src/gateway/local_runtime_answer_tests.rs
# Exit 0 (Git's existing LF-to-CRLF notice is informational).
```

The eleven new regressions cover acknowledged version-probe cancellation/reaping; pre-cancelled and expired admission; version-probe deadline cleanup; oversized stderr admission; pinned-version checks for an external listener; newly owned readiness cancellation; cached healthy ownership retention; successful ready-process adoption; cleanup when the preparation future is dropped; preservation of a preexisting unready process; and cancellation of a serialized startup waiter. The three existing profile/version tests also passed.

The helper executables and alternate addresses/arguments exist only under `cfg(test)`. Production continues to use the existing detected fixed binaries, fixed local port, fixed runtime arguments, and process containment. Tests check real Windows process PIDs and cleanup, while using deterministic version/listener fixtures. They do not establish live Lemonade/FLM hardware startup or provider answer acceptance. The parent was notified that the shared native binary was ready and the Cargo slot released before full answer/integration verification.

Context7 documentation was resolved and queried for Tokio child cancellation, `kill_on_drop`, `kill`/`wait`, Windows raw process handles, and asynchronous bounded pipe reads. No new dependency was required.

## Exact follow-up files changed

1. `src-tauri/src/gateway/local_runtime.rs`
2. `src-tauri/src/gateway/local_runtime_answer_tests.rs` (new)
3. `docs/reports/2026-10-10-local-answer-preparation-worklog.md` (new)

The earlier frontend scope and its 81 passing focused tests are documented separately in `2026-10-10-answer-frontend-worklog.md`.
