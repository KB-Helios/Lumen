# Windows AI PR review fixes

Verified locally on 2026-10-05 for [PR #14](https://github.com/KB-Helios/Lumen/pull/14).

## Changes and regressions

| Review finding | Change | Verification |
| --- | --- | --- |
| Undeclared `rtk` build dependency | Helper staging spawns `dotnet` and `bun` directly. Identity build/sign scripts invoke the Windows SDK executables directly; public setup commands require no wrapper. | Reproduced `uv_spawn 'rtk'` with RTK removed from PATH. The same x64 helper publication then passed nine core and eight executable protocol checks. The unsigned sparse identity package also built with RTK absent. Signing script syntax passed; certificate signing was not exercised. |
| Stale external agent recipient | The recipient belongs to the transient launcher store. Consuming a Lumen activation resets it to Lumen, and Run/Enter read the current recipient before dispatch. | An App regression selects an external agent, delivers a warm Lumen activation and presses Enter. The external application receives no prompt and the picker selects Lumen. |
| Overwritten activation drafts | A shared pending-read guard serializes native queue reads. One activation owns the visible draft until it is cleared, agent mode is left, or its explicit Run finishes. Subsequent activations stay queued. Completion only releases its own activation ID. | App regressions reproduce overlapping activation events and verify that clearing or explicitly running the first draft presents the queued second prompt. Incoming activations never auto-run a task. |
| Delayed Edge revocation | The composed service validates and applies pending denials synchronously, then aborts affected Edge work before awaiting native persistence/readiness. New affected operations remain denied during that wait. Older in-flight native status responses cannot restore permissions. | Real Edge adapter tests with injected browser APIs and stalled native responses verify immediate microphone abort, session destruction and preparation cancellation, plus denial of new work. Failed writes retain the last confirmed preferences without restarting stopped work. |

The new tests first reproduced the review failures against the previous implementation. Nine regression cases were added across the App and composed service tests. Native Rust source and helper SDK implementation are unchanged in this revision.

## Fresh verification

| Gate | Result |
| --- | --- |
| `bun run typecheck` | Passed. |
| `bun run lint` | Passed with zero warnings. |
| `bun run test` | 51 files, 369 tests passed. |
| `bun run test:e2e` | All 39 tests passed, serial execution in installed Microsoft Edge. |
| `bun run tauri build` | Full x64 release executable and NSIS installer passed, including helper staging and its core/protocol checks. |
| Installed smoke | Clean-profile installation, exact vector search, lexical fallback, native window show/hide, sanitized diagnostics, uninstall and profile cleanup all passed. |
| UI evidence | All 57 gallery states and six interaction recordings regenerated; contact sheet inspected. |
| `bun run profile` | Existing cadence-aware release gate passed. Warm launcher P95 3.0 ms, selection-to-paint P95 3.4 ms, hover-to-paint P95 9.5 ms. Strict 240 Hz hover bounds and cadence eligibility remain unmet. |
| `git diff --check` | Passed. |

The installed smoke is recorded in [packaged-smoke.json](../../artifacts/packaged/packaged-smoke.json), timestamp `2026-10-05T08:59:40.7281234Z`, installer SHA-256 `4b06cb652e05e10c9958a754abbbf89672dd568ae1f5ff3bebd5908c9ed53671`. The installer is unsigned and is not committed. Gallery, recording and profile metadata identify capture-time parent HEAD `28c31713`; they reflect the modified working tree before the fix commit.

The previous hosted CI run failed at the undeclared RTK spawn, matching the local reproduction. These results establish local verification; the new hosted run must be assessed against the pushed commit separately. Activation regressions use the typed native service boundary with a queued test source, and Edge regressions inject browser API implementations. They do not establish live OS activation delivery, model inference, microphone capture or identity signing on an eligible configured host. The original hardware/runtime limitations remain documented in the [initial integration report](2026-10-04-windows-ai-integrations.md).
