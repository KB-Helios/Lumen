# Answer reliability: frontend lifecycle and protocol admission

Date: 2026-10-10. Scope: Task 2 of `docs/superpowers/plans/2026-10-10-answer-reliability.md`, plus the parent-authorized AnswerPanel state wording and error visibility corrections. Work stayed in the shared `codex/harden-answer-streaming` checkout; no branch, staging, commit, server, full e2e, or native-code changes were made by this worker.

## Reproductions and red/green evidence

The original controller failed eight focused assertions: it entered streaming before any tokens, retained obsolete text/usage/model on a fallback `started`, allowed late events to mutate cancelled output, changed completed/failed states to cancelled on Stop, stayed streaming after premature EOF, displayed raw thrown service errors, and reused request IDs across controller instances. The literal fallback reproduction was citation → cloud started → `obsolete` → usage → local started → `success` → completed. Its passing result is exactly `success`, local attribution, no obsolete usage/model, and the retained source citation.

The initial Tauri service test run had 17 failures among 19 cases. These reproduced invocation despite pre-abort, waiting indefinitely after an actual terminal channel event while invocation remained open, accepting EOF without a terminal event, exposing rejected invocation text, admitting malformed/oversized native values, showing raw failed-event text, and admitting unbounded event/output bursts. Cancellation-rejection and consumer-close tests also exercise the native invocation boundary and run without unhandled rejections after the fix. The first invalid-payload parameter titles printed large fixture text; they were replaced with descriptive labels to keep test output bounded.

Windows answer tests initially had seven failures, including two fixture timing failures. The harness was corrected to wait on acknowledgement that the text operation started rather than assuming one microtask was enough. Rerunning before implementation produced five genuine failures: pre-aborted requests still emitted started, abort between started and invocation still started work, failed/cancelled worker events waited indefinitely for a result, and queued tokens had no bound. These are green after the lifecycle correction. Existing text reconciliation, source delivery, selected-engine routing, and safe inconsistent-result handling remain covered.

Three panel tests failed before their implementation: waiting claimed the query was still settling, cancellation with no tokens continued to show preparation, and an error message disappeared whenever partial text existed. All three now pass while source controls and runtime details remain available.

The follow-up safe native code mapping had 15 failing cases before implementation and now retains recognized native codes with fixed frontend messages. Upstream message text is always discarded. Unknown codes, including `constructor`, use generic safe guidance. A further failing test demonstrated that draining a bounded queue still allowed source metadata to grow past 4 MiB; total admitted event bytes are now capped as well. A valid Windows result with an empty optional model label exposed a compatibility regression from stricter event admission; its red/green fix uses `Local model` as the fallback label.

## Implementation

- `started` is an attempt boundary: clear text, usage, errors, and old attribution; preserve citations. Waiting lasts until a nonempty delta.
- Keep terminal states stable and close iteration after the first terminal event. Treat nonterminal EOF as a safe failure.
- Fence event reducers, EOF reducers, and error reducers with both the per-request sequence and abort state. Retry fences and aborts the old request immediately; replacement, Stop, debounce cancellation, and unmount are covered.
- Allocate native request IDs from a shared monotonic safe-integer counter seeded from time, independently of each controller's local sequence. Multiple mounted controller instances no longer collide.
- Treat native channel messages as unknown values. Zod strict discriminated schemas bound strings, enforce safe nonnegative token counts and finite timestamps, and reject unknown types/fields and malformed nested values.
- Cap each native answer attempt at 1 MiB of UTF-8 text, the pending queue at 1 MiB or 4,096 events, the complete admitted event stream at 4 MiB, and the event count at 32,768. Limit individual delta strings to 65,536 UTF-16 code units. These are frontend admission limits; native SSE/wire bounds are separately implemented and verified by Task 1.
- Ignore channel input after terminal, failure, abort, or disposal. Clear queued values and replace the channel callback on disposal. Consume invocation and cancellation rejection; raw exceptions do not enter UI state.
- The Windows adapter retains the existing explicit engine and cloud routing rules. It checks abort before work and after the yielded started event, bounds local queue/output/event counts, admits matching-request deltas, ends immediately on failed/cancelled worker events, reconciles a validated result and its citations, and ignores callbacks after disposal. Native cancellation remains idempotent at this adapter boundary.
- Panel waiting text says preparation; empty cancellation says Stopped. A partial answer keeps its text and exposes its safe error through a visible status paragraph.

## Measurements

The retained controller performance probe uses React Profiler, the real hook, and MemoryAnswerService in jsdom. It emits 1,000 one-character tokens followed by completed within a single asynchronous `act` burst and asserts exact final text and completion. This measures same-turn burst processing and React batching; it does not establish installed-Edge/WebView cadence or separate-task IPC rendering behavior.

| Probe | React commits | Render duration | Total update duration |
| --- | ---: | ---: | ---: |
| Before controller implementation | 1 | 0.9215 ms | 7.7924 ms |
| After implementation, repeated probe | 1 | 1.0430 ms | 7.7544 ms |
| Native adapter validation/admission/drain, 1,000 tokens | n/a | n/a | 7.2782 ms |

The native adapter probe uses the real TauriAnswerService and mocks only the external Channel/invoke boundary; it validates and drains 1,000 events and asserts exact output. Existing React batching was retained. No scheduled token flushes or frame callbacks were added, so Stop and terminal delivery do not depend on a deferred flush.

## Fresh focused verification

Executed after all scoped production changes:

```powershell
rtk bun run test -- src/features/answer src/services/answer
# 5 files passed; 81 tests passed; 24.10 s total, 797 ms test bodies.

rtk bun run typecheck
# Exit 0.

rtk bunx eslint src/features/answer src/services/answer --max-warnings 0
# Exit 0.

rtk git diff --check
# Exit 0.
```

The initial safe mapping used `Object.hasOwn`, which the repository's TypeScript lib target does not expose. Typecheck caught TS2550; switching to `Object.prototype.hasOwnProperty.call` restored compatibility. No TypeScript configuration change was made.

Context7 documentation was resolved and queried for Zod 4 safeParse/strict bounded schemas, Tauri 2 JavaScript Channel and invoke, and React useEffect cleanup/Profiler. No new dependencies were introduced.

## Exact files owned and changed

1. `src/features/answer/useAnswerController.ts`
2. `src/features/answer/useAnswerController.test.tsx`
3. `src/features/answer/useAnswerController.performance.test.tsx` (new)
4. `src/features/answer/AnswerPanel.tsx`
5. `src/features/answer/AnswerPanel.test.tsx`
6. `src/services/answer/answer.types.ts`
7. `src/services/answer/tauri-answer-service.ts`
8. `src/services/answer/tauri-answer-service.test.ts` (new)
9. `src/services/answer/windows-ai-answer-service.ts`
10. `src/services/answer/windows-ai-answer-service.test.ts`
11. `docs/reports/2026-10-10-answer-frontend-worklog.md` (new)

Independent review has been requested from the parent coordinator; all four agent slots were occupied during this worker's final verification. Complete Vitest, lint, installed-Edge integration/e2e, screenshots/performance artifacts, native gates, release build, and final PR/hosted checks remain owned by the parent and other workers. These focused local results are not live provider or packaged WebView acceptance evidence.
