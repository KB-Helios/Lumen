# Computer Use boundary

Lumen's Windows-first Computer Use controls a fresh Microsoft Edge session or one selected, non-elevated Windows window. React depends on the existing `ComputerUseService`; Rust owns providers, policy, target identity, input admission, verification, approvals, cancellation, and the executor Job Object. The local executor receives bounded operations and no provider credentials.

## Execution and consent

The user explicitly selects a provider, Fast or Background mode, a target, and Run. Typing or agent URI activation only creates a draft. Browser tasks keep their existing recorded cloud consent. Desktop control and desktop cloud observations require two additional recorded grants, both disabled on migration. Answer-generation consent grants neither. Revocation stops active control and invalidates a warm executor.

Fast uses background routes first and can request one foreground action. Background refuses unsupported delivery with `backgroundUnavailable` and never changes modes. Browser sessions use installed `msedge` in a fresh context, headless by default; a visible launch requires an explicit UI choice and native one-time approval. Existing browser profiles and non-HTTP(S) navigation are excluded.

Desktop discovery resolves an opaque frontend target ID to PID, executable, process creation time, HWND, owner, session and DPI. Rust checks that identity before each action. The fixed Cua backend supplies UI Automation and supported exact-window message delivery. Semantic refs originate in a single observation; subsequent actions are rebound only to an unambiguous current semantic match. Coordinates require a matching screenshot and geometry. Changed targets, stale approvals and ambiguous observations refuse input.

For the pinned Windows backend, background value changes have passed exact-window acceptance. Invoke and click refuse before SDK dispatch because a fixture invocation changed window order. Native keyboard, selection, scroll and other pixel gestures also remain unavailable in Background. Fast can request a single Rust foreground action after refusal. These restrictions are explicit availability boundaries and preserve the user's desktop. Browser visual typing resolves focus to an editable node in the current snapshot, preserves frame and selection identity, and refuses protected or newly appeared controls.

## Native coordinator

`src-tauri/src/computer_use/` separates protocol, gate, policy, executor, target discovery, foreground input, Stop, provider and coordinator responsibilities. The Rust InputGate admits one action at a time. Rust assigns run UUIDs, generations and action UUIDs; approvals include the target and snapshot identity and cannot be replayed. Worker responses are strictly parsed in Rust and frontend events are Zod parsed.

Ctrl+Alt+Esc runs on a dedicated Windows message thread. Stop closes admission and advances the generation before aborting HTTP requests, invalidating approvals and terminating the executor Job Object. It bypasses executor stdin and action admission locks. A short native ledger releases only keys/buttons successfully pressed by Lumen, including partial Unicode delivery. Stop during startup fences a late executor. Take Over ends the run and never resumes automatically. Already-dispatched input can remain uncertain; Stop provides no rollback.

Planners propose at most five bounded actions. Rust executes them sequentially with fresh target checks and postconditions, ending a batch on navigation, approval, changed state or uncertain delivery. A task has at most 4,000 Unicode characters, 60 provider turns and 60 dispatched input actions. Uncertain input is never blindly replayed. Successful delivery alone cannot confirm an application result.

Completion requires an explicit `lumen_actions` finish and one to ten bounded postconditions. Rust refreshes the selected target and checks exact URL, title, uniquely identified control values, or positive accessible element names (`nameEquals`, useful for status/heading/text results) before emitting Completed. Checks must hold in both the proposal and a distinct fresh, nondegraded observation. Prose, refusals, partial provider responses and missing checks cannot complete a task. The planner chooses postconditions to express its interpretation of the task; native checks prove those stated application conditions, not arbitrary claims about the task. Safety and foreground approval both refresh and compare the approved state after the human wait.

Unverified input ends its batch and permits one read-only provider outcome review, with one additional `needsVision` transition when vision was not already enabled. No further input or waits are admitted during review. Completion also requires a checked postcondition demonstrably different from the known pre-input state. Element changes require a unique stable automation identity or role/bounds match; an element absent from a bounded earlier snapshot cannot prove change. Unchanged titles, degraded observations, concurrent changes between the proposal and fresh capture, or unavailable bounded checks fail without retry. Delivery uncertainty remains recorded in `uncertain` and `outcomeReviews`; independently verified task postconditions do not increase `verifiedActions` or erase Stop uncertainty.

Foreground focus and input share a short, gated native synchronization boundary drained by Stop. Mouse points must fit the selected capture and their actual root window must match the selected HWND immediately before delivery; occluding windows cause refusal. Background SDK escalation or malformed post-input receipts are uncertain outcomes and cannot authorize a foreground retry.

## Providers and data

The selected Gemini or OpenAI provider stays fixed for a run. Rust reads the key from Windows Credential Manager and sends requests through its existing HTTP infrastructure. Keys are never returned to React, placed in executor environment variables, or written into staging output. Semantic function tools are the default; OpenAI schemas are strict and parallel calls are disabled. Visual fallback retains screenshots, provider call IDs, original conversation metadata and safety confirmations. Model-written scripts and generic Cua dispatch are excluded.

Task content, selected-target observations and optional screenshots are cloud data only after the corresponding consent. Routine diagnostics record durations, provider usage, route counts, screenshot counts and verification outcomes, without task text, values, URLs, screenshots or credentials. Provider latency, local execution and human approval wait are measured separately.

`startupWallMs` is total startup wall time, including model availability checks and any visible-browser approval. It is separate from local execution measurements and from `approvalWaitMs`.

## Packaging

`bun run stage:computer-use` uses a pinned Python 3.11 environment and fully hashed dependencies, including `cua-driver==0.34.0`, its published Windows wheel checksum and matching native resource hashes. PyInstaller produces a fixed executable beside `computer-use-runtime/`; Tauri packages both. Staging verifies executable/runtime inventory before reuse. Third-party licenses and source provenance accompany the executor. Source and packaged health and application-state tests are separate acceptance checks.

A warm executor is reusable only in the same immutable provider/target permission scope. It admits no input between tasks, creates a fresh Edge context for each browser run, and expires after two idle minutes. Stop, scope changes and consent revocation terminate it. Pool epochs prevent a late completion from returning a stopped executor to the cache.

See [executor protocol](computer-use-protocol.md), [frontend contract](computer-use-ui-contract.md), and [implementation plan](../superpowers/plans/2026-10-06-efficient-computer-use.md). Hyper-V workspaces, UFO workflows and Office COM adapters remain deferred to v1.1. Local tests, packaged checks and provider availability checks do not establish a live cloud task result; the acceptance report records those boundaries separately.
