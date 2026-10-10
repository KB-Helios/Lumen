# Native answer integration worklog

The test harness renders the production `TauriAnswerService`, Tauri JavaScript `Channel`, `useAnswerController`, and `AnswerPanel` in the installed Microsoft Edge. Its isolated development HTML entrypoint is `tests/answer-native.html`; it is not a product route or release entrypoint.

The frontend uses Tauri's documented test IPC hook to replace only command transport. A private loopback HTTP bridge forwards fixed answer test scenarios to an explicitly enabled ignored Rust test process. Rust supplies `AnswerEvent` records using the production HTTP transport and attempt orchestration. There are no new product IPC commands, provider URLs, credentials, process arguments, shell permissions, dependencies, or production capability grants.

## Protocol and command

The ignored native entrypoint is `gateway::answer::transport_tests::native_bridge`. Set `LUMEN_ANSWER_NATIVE_BINARY` to its compiled `lumen_lib-<hash>.exe` when more than one binary exists. The lookup directory is `debug/deps` beneath `CARGO_TARGET_DIR`, or `src-tauri/target` by default. The runner passes fixed libtest flags and `LUMEN_ANSWER_BRIDGE=1`.

Run `bun run test:answer-native` after compiling `cargo test --all-features`, and `bun run test:answer-bridge` for socket checks. Their Node `.mjs` entrypoints follow the existing project profiling and e2e script pattern; package installation and application development commands retain Bun. Both gates are included in Windows CI.

Native stdin accepts `{command:"start",request:{requestId,query,mode,cloudConsent}}` and `{command:"cancel",requestId}`. Native stdout emits `{requestId,event}` and `{requestId,done:true,error?}` on separate lines. Libtest headings are ignored. The bridge admits only fixed fixture scenario names, requires a random private token, listens on `127.0.0.1`, bounds concurrent requests and buffers, and cancels abandoned response sockets.

## Checks and evidence boundary

- Fallback: literal final answer `Local fixture answer 🌍`, local provider/model/route, preserved source citation, no stale usage, and exact rendered final content.
- Stop and Retry: a real native stalled response supplies partial tokens; UI Stop becomes cancelled; native cancellation finishes within 250 ms; Retry returns its independently specified final text.
- Replacement: a stalled native request is replaced with a successful second request; old partial text cannot become the final answer.
- Burst: 1,000 native token events produce all 1,000 final characters. React Profiler commits/render time, channel callback duration, and native/rendered first-token latency are recorded.
- Repeated failure: 35 failing requests in the same native process, no bridge requests retained after each completion, and six post-warmup native working-set samples. Memory growth is reported, not inferred to prove a native ownership invariant.

The fallback obsolete-usage event is an explicit test-only metadata precondition. Production transport publishes successful usage on completion; injecting stale usage before the failed attempt exercises frontend reset admission without changing provider protocol. Native provider attempts and text events still come from production transport.

Results are written to `artifacts/performance/answer-native-integration.json` after all rendered assertions pass. The artifact marks loopback-native-transport/installed-Edge evidence and explicitly marks live-provider and packaged-WebView verification false. It is not a packaged Tauri/WebView or live model acceptance claim.

## Current validation

The three bridge socket tests pass using Node. The native/rendered fixture passed on Windows in installed Edge: fallback produced exactly the local answer, Stop/Retry and replacement completed, the burst retained 1,000 characters, and 35 failed requests left no bridge requests active. The first recorded run measured 41.64 ms rendered Stop, 6.61 ms native Stop cancellation, 6.02 ms replacement cancellation, and 24,576 bytes working-set growth between six post-warmup samples. Final measurements and complete project gates are recorded in [the reliability report](2026-10-10-answer-reliability.md) and the regenerated JSON artifact.

The runner owns its native process, HTTP bridge and Edge browser from creation, including setup failures. Nested cleanup still closes the bridge and process if browser cleanup fails. The private bridge never becomes a product capability.

Final independent review found that the Rust provider fixture's blocking accept or unfinished request read could prevent Drop from joining promptly. Both no-client and accepted-incomplete cleanup tests failed their unchanged 250 ms bounds before correction. Socket shutdown did not promptly interrupt the pending read on this Windows host. The final fixture owns a stop token, uses stop-aware nonblocking accept and request admission with separate three-second absolute deadlines, and restores accepted sockets to blocking three-second I/O before the unchanged provider handler. Both regressions passed together in 0.01 seconds; independent follow-up review found no material remaining ownership issue.

Bun 1.3.14 did not deliver the client-close event through its `node:http` compatibility layer in the abandoned-socket regression. The same test passes under Node, which matches the existing project's `.mjs` profiling and e2e runners. Cancellation assertions and the 250 ms native limit are unchanged.
