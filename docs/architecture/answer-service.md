# AI answer streaming

React consumes the existing `AnswerService` async iterable. `TauriAnswerService` validates every native event before the controller reads it; the Windows AI adapter retains the same contract. Rust owns credentials, route selection, local runtime preparation, provider requests, and cancellation. The answer panel never calls a provider directly.

## Attempts and frontend state

The controller uses a monotonic request identity and a separate effect fence. Query, service, runtime preference, consent, Retry, Stop, and unmount invalidate the old effect. It checks that fence both while consuming events and inside queued React state updates. Terminal events close the iterator; late events cannot reopen a completed, failed, or cancelled answer.

Each provider attempt emits `started` before preparation or HTTP work. This resets text and usage, replaces attribution, and leaves admitted source citations intact. The panel stays `waiting` until a text delta arrives. Only the successful attempt emits usage and completion. A stopped answer retains its partial text and exposes Retry; a failure remains visible beside any partial text. Empty waiting and stopped states have explicit accessible status text.

Tauri command resolution and Channel callbacks are separate delivery paths. `start_answer` returns a strict `{eventCount}` acknowledgement counting successful serialized channel sends; the public `AnswerService` iterable remains unchanged. The adapter drains ordered callbacks through the acknowledged count rather than treating the command promise as EOF. A terminal event closes the stream immediately. Delivery still lacking a terminal after all acknowledged events fails closed, as do invalid acknowledgements. Missing delivery is bounded to five seconds after acknowledgement and 125 seconds from frontend admission (the native 120-second deadline plus delivery allowance). Stop and disposal clear both deadlines.

Local mode selects only the local route. Cloud mode requires both request and persisted consent plus a configured credential and selects only cloud. Auto uses available cloud then local when authorized, and local otherwise. An unavailable optional cloud route does not block Auto's local route. Cancellation and the overall deadline terminate the attempt sequence immediately. Other classified provider failures may enter the next configured attempt; no HTTP client retry is enabled. Immediately before dispatch, Rust rechecks persisted cloud consent and the complete applied route, including a custom endpoint. Settings application and dispatch do not share an atomic transaction; an already accepted provider request keeps its original attribution.

## Native HTTP and framing

The transport owns a loopback request to AgentGateway's fixed endpoint. It bypasses environment proxies, refuses redirects, disables implicit retries and idle connection pooling, and drops the response on completion, failure, deadline, or cancellation. Non-success HTTP status is classified from headers; untrusted error bodies are never read or exposed.

The incremental decoder buffers bytes until a complete line, then validates UTF-8. It accepts LF, CRLF, CR, a leading BOM, comments, `data:` with an optional leading space, multiline data, and network fragmentation at any byte. It dispatches a frame only at a blank line, following the [SSE parsing algorithm](https://html.spec.whatwg.org/multipage/server-sent-events.html#parsing-an-event-stream). JSON is parsed after framing. Malformed JSON, a present non-string type, invalid delta data, and invalid completion/usage shape fail the attempt. Well-formed informational Responses events are ignored. A named SSE event can supply an omitted JSON type.

Success requires `response.completed` with a completed response status. EOF, `[DONE]` without that event, `response.incomplete`, or an incomplete response status cannot become success. Valid completion returns immediately even when the provider keeps the socket open. Error codes from ordinary or nested [Responses streaming events](https://developers.openai.com/api/reference/resources/responses/streaming-events) map to a small fixed classification; upstream messages, keys, URLs, and source context never enter frontend errors. Rate-limit counters must fit JavaScript's safe integer range, and reset headers admit only bounded numeric duration characters.

| Native boundary | Limit |
| --- | --- |
| Query | 4,000 Unicode characters |
| HTTP connect | 5 seconds |
| Response headers / stream inactivity | 30 seconds each |
| Overall preparation and attempts | 120 seconds shared across fallback |
| SSE line/frame data | 64 KiB |
| Wire data / output text per attempt | 4 MiB / 1 MiB |
| Dispatched data events per attempt | 32,768 |
| Local version probe | 5 seconds; 16 KiB stdout and stderr each |
| Newly owned local server readiness | 8 seconds within the overall deadline |

The Tauri answer adapter independently caps 1 MiB output per attempt, 4 MiB admitted event data and 32,768 events per request, and a 4,096-event/1 MiB pending queue. The Windows AI adapter separately bounds output, event count and its pending queue, without a cumulative admitted-byte counter. Overflow cancels the owned native request or Windows AI session. Individual native event fields are Zod-bounded. These limits protect malformed or unexpectedly fast producers without adding a render loop or timer-based batching.

## Ownership and Stop

`AnswerRuntime` keeps an identity-checked RAII guard for each active command. Reusing an ID cancels its previous owner; old cleanup can remove only its own token. Stop signals the token but retains active ownership until cleanup ends. Application exit cancels the parent admission token, so existing work stops and later admission is already cancelled.

Tauri schedules the async start command separately from synchronous Stop. A shared request mutex retains the most recent 256 distinct cancellation IDs that arrive before registration; `begin` consumes its matching cancellation before admitting work. Active cancellation and owner cleanup use that same mutex. The bounded queue covers the existing main-webview flow without retaining arbitrary cancellation IDs indefinitely; eviction affects only older unregistered IDs, never an active request token.

Biased Tokio selects prioritize cancellation over ready tokens and bound attempt preparation, headers, and stream reads. Local answer startup uses asynchronous, hidden, Job-contained version probes, bounded pipe reads, explicit kill/reap, and serialized startup. A newly spawned server remains owned by the preparation future until readiness; cancellation or future drop kills that PID. Preparation rechecks cached child liveness after asynchronous waits. Management startup and cold Cloud stop share nonblocking startup admission: an in-progress preparation returns a fixed busy failure instead of registering a competing child or acknowledging a stop before adoption. Existing healthy owned runtime processes remain available for other users. External listeners still pass pinned-version admission.

App and Local AI settings catch runtime application failures and share transient result ownership. A current failure appears in the existing Local AI callout with fixed safe guidance and Retry; selected preferences remain saved. Older, changed-preference or unmounted operations cannot overwrite a newer result. Retry reapplies the saved mode and warm preference, and application notices are never persisted.

Context search runs on the existing bounded native indexing lane. Cancellation stops waiting and aborts queued context work; a synchronous read already executing may finish in the blocking pool, without emitting an answer or entering a provider attempt. This does not claim forced cancellation of synchronous SQLite work.

## Evidence and reproduction

`cargo test --all-features` includes real loopback HTTP tests for byte fragmentation, grammar, provider errors, bounds, deadlines, ownership, and fallback cancellation. The ignored `native_bridge` is an interactive fixture entry point compiled only under `cfg(test)`; it exposes no product IPC or configurable production endpoint.

After compiling native tests, `bun run test:answer-native` launches that executable and installed Edge. An authenticated, temporary bridge forwards the production Rust transport's serialized Tauri Channel events to the real answer service, controller, and panel. It verifies cloud partial failure → local-only final output, retained citations, cleared obsolete usage, Stop/Retry, replacement, a 1,000-token burst, delayed large-message delivery after acknowledgement, and 35 repeated HTTP failures. The delayed-message fixture uses the real JavaScript Channel to buffer later terminal/end indices; its delay models IPC scheduling rather than executing packaged WebView IPC. The runner closes native stdin, waits for the fixture's cancellation/task-join assertions and verifies a zero exit status before publishing success evidence. Shutdown times out after five seconds, kills only the owned process, and fails acceptance. `CARGO_TARGET_DIR` or `LUMEN_ANSWER_NATIVE_BINARY` selects a non-default native build location. `bun run test:answer-bridge` verifies socket cleanup, matching native completion records and clean/bounded child shutdown. Both checks run in Windows CI.

The measured artifact is `artifacts/performance/answer-native-integration.json`. It explicitly identifies loopback fixture and installed-Edge evidence; it does not establish live provider/model availability or packaged WebView answer acceptance. The obsolete usage precondition is a test-only injection because production usage is emitted only at successful completion. See the dated answer reliability report for fresh gate results, measurements, and remaining evidence boundaries.
