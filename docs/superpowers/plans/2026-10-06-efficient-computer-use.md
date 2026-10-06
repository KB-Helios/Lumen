# Efficient Windows-first Computer Use implementation

Approved user plan, 2026-10-06. Windows 11 x64, host-first. Both Gemini and OpenAI; Edge, Notepad and Windows fixtures. Hyper-V, UFO, Office COM adapters and existing browser-profile attachment are excluded from v1.

## Constraints

- Rust owns the planner loop, credentials, policy, verification, input admission and cancellation. The fixed Python executor has no credentials and accepts only the protocol in `docs/architecture/computer-use-protocol.md`.
- Typed Tauri services and Zod events only; no shell permission or arbitrary model-written code.
- Separate persisted browser cloud, desktop control and desktop cloud consent. Desktop consent defaults off.
- One run; 4,000 characters; 60 planner turns and 60 input actions. Batches of at most five sequential actions, interrupted by navigation, approval or uncertain/unexpected state.
- Exact target identity and snapshot-bound references. Background never escalates to foreground. Foreground needs one-time approval.
- Ctrl+Alt+Esc is a native message-thread stop independent of React, provider I/O and worker stdin. Close input admission, increment generation, invalidate approvals, abort HTTP, terminate executor job and release only owned input.
- Default Fast mode, new Gemini configuration `gemini-3.8-flash`, OpenAI `gpt-6.1-sol`. Preserve supported saved selection, report unsupported selections.

## Tasks

1. Shared protocol and native gate: add Rust protocol, consent checks, budgets, race/approval validation and cancellation tests.
2. Fixed executor: Cua 0.34.0 UIA/background Windows execution and fresh Edge semantic Playwright, snapshots and postconditions, pinned packaging, Python tests.
3. Native coordinator: exact native target discovery, process identity, foreground input ledger, job lifecycle, native Stop, Tauri commands and generation-safe events.
4. Rust providers: semantic function tools and bounded visual fallback for both providers, strict schemas, required conversation metadata and safety acknowledgments, mocked HTTP boundary tests.
5. Frontend: service/types/controller/settings migration, modes/providers/targets/consent/approvals, Stop/Take Over acknowledgment, deterministic keyboard tests.
6. Integration review: fix cross-subsystem issues and review security, cancellation and genuine postconditions.
7. Verification and evidence: local gates in order, Rust fmt/clippy/tests, native fixtures and twenty warm benchmark repetitions, sidecar/release build and packaged smoke; gallery, recordings, profiler; separately record live-provider availability and checks.

## Acceptance

Verify application-owned state and background focus/z-order/cursor preservation. Test stale IDs, duplicate input, late replies, startup cancellation, hung executors, revoked consent, refused gestures, closed/recycled/elevated targets and DPI changes. Target >=50% lower local action overhead, zero screenshots for semantic fixtures, >=50% fewer planner turns on a multi-field fixture. Native gate <=50 ms and executor teardown <=1 s at p95. Report measured results and remaining acceptance gates explicitly.
