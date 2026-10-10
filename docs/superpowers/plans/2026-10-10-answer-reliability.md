# AI answer reliability implementation plan

> **For agentic workers:** Use systematic-debugging, test-driven-development, parallel-agent investigation, and requesting-code-review. Track evidence and review findings here; preserve the user-authorized autonomous execution through PR creation.

**Goal:** Complete and verify the existing answer pipeline without mixed attempts, corrupt tokens, stale UI, leaked requests, or indefinite waits.

**Architecture:** Keep the existing typed `AnswerService`/Tauri channel and Rust gateway. Isolate incremental SSE framing from HTTP deadlines, normalize errors, and retain ownership until the request finishes.

**Tech stack:** Bun, React 19, Tauri 2, Tokio, reqwest, Vitest, installed Edge/Playwright.

## Global constraints

- Credentials and execution stay in Rust. No new framework or general provider abstraction.
- Retain runtime preferences, persisted cloud consent, and source citations.
- Native loops and buffers are bounded. Cancelled requests never fall back.
- Quality gates and performance thresholds retain their existing assertions.
- Work on `codex/harden-answer-streaming` against latest `main`; create a PR and do not merge.

### Task 1: Native framing, transport and ownership

Files: `src-tauri/src/gateway/answer.rs`, focused sibling parser and native test modules, `src-tauri/src/lib.rs`.

- [x] Add real HTTP loopback tests using the production request and `AnswerEvent` channel. Assert a CRLF/no-space/multiline stream yields the literal `Hello 🌍` and a single completion; force UTF-8 byte fragmentation. Watch failures against main.
- [x] Implement bounded byte framing and recognized-event validation. Test invalid JSON/UTF-8, absent/incomplete completion, oversized lines/events/output, provider failures and abrupt termination.
- [x] Add cancellation tests whose servers acknowledge request arrival before withholding headers or tokens. Assert cancellation drops the owned response and returns within 250 ms without another provider request.
- [x] Add header/inactivity/total deadline tests using short private test limits; implement production deadlines and safe status/error classification.
- [x] Add ownership, drop-cleanup, repeated-failure, fallback cancellation and shutdown regressions. Make each provider attempt emit `started` before work and a terminal event exactly once.
- [x] Run focused Rust tests, record time-to-token and cancellation samples, review the change.

### Task 2: Frontend lifecycle and protocol admission

Files: `src/features/answer/useAnswerController.ts`, its tests, `src/services/answer/tauri-answer-service.ts`, typed schemas and tests.

- [x] Reproduce cloud `started` → `delta('obsolete')` → `usage` → local `started` → `delta('success')` → `completed`. Assert final text is `success`, attribution local, stale usage absent, sources retained.
- [x] Test Stop before debounce/headers/tokens, Retry, rapid replacements, unmount, duplicate/late terminal events, premature EOF, already-aborted signals, rejected cancellation and invalid native payloads.
- [x] Implement strict request fences, bounded channel queues, validated events and safe generic invocation errors. Keep `waiting` until actual tokens and terminal states stable.
- [x] Measure burst-token render/update overhead before optimizing; preserve final token flush and Stop responsiveness.
- [x] Run focused Vitest tests and request independent review.

### Task 3: Restore meaningful latest-main CI

Files: scoped to verified regression causes in gateway enrichment and search freshness tests/runtime.

- [x] Investigate all six CI failures. Reproduce locally and establish whether socket timing, test-hook cross-talk, or production behavior causes them.
- [x] Correct causes without removing assertions, skipping tests, or relaxing thresholds. Run affected suites and the full Rust gate.
- [x] Correct the obsolete `AGENTS.md` claim that no CI exists.

### Task 4: Integration, evidence, documentation and PR

Files: native/Edge integration harness, `artifacts/performance`, `docs/architecture`, `docs/reports`.

- [x] Use production Rust transport to generate/stream typed events into the real frontend controller/panel; assert successful-attempt-only rendered content and rapid replacement/Stop/Retry behavior in installed Edge.
- [x] Record first-token latency, cancellation latency, output/parser bounds, repeated failures, JS update overhead and React commits. Mark fixture vs live evidence explicitly.
- [x] Run typecheck, lint, complete Vitest, complete installed-Edge e2e, Rust fmt, Clippy, all-features Rust tests, and full Tauri release build.
- [x] Regenerate required UI/performance artifacts, document verified boundaries, independently review the complete diff and resolve material findings.
- [ ] Fetch latest main again, commit, push, create/attach focused PR, and verify GitHub Actions on the final commit. Do not merge or declare complete with mandatory failures outstanding.

## Progress

- Investigation complete: PR #22 merged; latest main and failing CI checked. Native parser/cancellation and fallback state defects identified for red/green reproduction.
- Native, frontend and integration corrections are implemented and independently reviewed. All required local gates, final evidence regeneration, release packaging and the existing isolated installer smoke passed. The complete Rust gate passed 263 unit and 25 integration tests, with 15 explicit fixture/external acceptance cases ignored. PR creation and final hosted CI verification remain pending; see [the verification report](../../reports/2026-10-10-answer-reliability.md) for gate boundaries.
