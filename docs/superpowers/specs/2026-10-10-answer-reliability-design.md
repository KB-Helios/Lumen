# AI answer reliability

The authorized scope is the user's streaming, fallback, cancellation, timeout, integration, performance, documentation, and PR request. Preserve the Tauri 2/React 19 architecture and existing local-engine preferences. Rust owns credentials and provider execution; cloud requires both request and persisted consent. Do not merge the PR.

Use the existing `started` event as the provider-attempt boundary. Clear text, usage, errors, and obsolete attribution on each attempt while retaining source citations. Terminal events stop further updates. Abort and query replacement fence old events, including scheduled UI updates. Batch token updates only if measured overhead justifies it.

Replace per-chunk lossy decoding with a byte-oriented SSE parser. Support fragmented UTF-8, LF/CRLF/CR, optional field whitespace, and multiline data. Parse JSON only after a complete event. Reject malformed recognized events, invalid UTF-8, missing/failed/incomplete completion, oversized events and output. Ignore protocol comments and well-formed informational events. Finish on a valid completion without waiting for socket EOF.

Apply connection/header, total-request, and stream inactivity deadlines. Cancellation wins before starting a request and at every asynchronous boundary, including fallback and shutdown. Drop owned HTTP futures and responses promptly. Do not consume error bodies: classify HTTP status and provider error codes into allowlisted messages. Do not emit upstream response text, request URLs, keys, or credentials in errors.

Request ownership must survive reused request IDs: completion of an older request cannot remove or cancel its replacement. Cleanup runs on every return path and when an owned future is dropped. Auto mode may fall back from authorized cloud to local; local/cloud explicit modes retain their selected route.

Acceptance combines native loopback HTTP streaming/cancellation tests, typed frontend lifecycle tests, installed-Edge rendered-answer verification using events produced by the native transport, and a release build. Record latency, bounded memory, rendering/update overhead and repeated-failure cleanup. Distinguish deterministic loopback providers from live model services and from packaged WebView verification.

Latest-main investigation: `28925d37e127f20edabd7b1a854c3b8a7ad4fb18`, merged PR #22. CI run `37977650752` has six native failures (gateway enrichment socket timeout and five indexing freshness tests); determine their causes before comprehensive acceptance and preserve their assertions.
