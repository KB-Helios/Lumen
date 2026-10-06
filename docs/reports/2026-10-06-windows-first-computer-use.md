# Windows-first Computer Use verification

Reference host: Windows 11 x64, AMD Ryzen AI 9 HX 370, OS build 26300, installed Microsoft Edge 154.0.4258.62, Bun 1.3.14, Python 3.11.15, Playwright worker 1.62.0, Cua Driver 0.34.0, Rust 1.95 MSVC. Source commit: `70fc9e67c0bd8ac3479ea62f1bcaf1e13ceb0b54`, based on `7e2bd8b36d7cd2a12a07bf96781216119c20118d`, branch `codex/windows-first-computer-use`.

The existing Computer Use service now supports provider, mode, fresh Edge or selected native target, separate desktop grants, scoped approvals, Stop and Take Over. Rust owns provider requests, keys, target identity, action admission, postconditions, native Stop and executor lifecycle. The worker is fixed, typed and credential free. Existing browser consent is preserved; migrated desktop permissions remain off.

## Local checks

| Check | Result |
| --- | --- |
| `bun run typecheck` | Passed |
| `bun run lint` | Passed with zero warnings |
| `bun run test` | 416 tests in 58 files passed |
| `bun run test:e2e` | 52 serial installed-Edge tests passed |
| Rust formatting | Passed |
| All-target/all-feature Clippy with `-D warnings` | Passed |
| `cargo test --all-features` | 163 passed; seven explicitly ignored acceptance or pre-existing integration tests |
| Python executor, native fixture and staging tests | 29 passed |
| Explicit Rust staged-executor Edge wire acceptance | Passed |
| Explicit twenty blocked-worker Stop samples | Passed |
| Full Tauri release build | Passed |
| Installed NSIS smoke | Passed, including all 275 Computer Use runtime files, uninstall and profile cleanup |
| Gallery and recordings | 57 states and six WebM studies regenerated |
| UI profiler | Passed its cadence-aware checks; strict 240 Hz aggregate remains false |
| Warm browser executor benchmark | Twenty source and twenty packaged repetitions; all field read-backs passed |

The staged Edge acceptance exercises Rust's actual nullable DTO serialization, headless Edge DOM filling and read-back, zero semantic screenshots, fresh browser contexts during warm reuse, and pool epoch invalidation. The Python fixtures cover iframe identity, snapshot-scoped visual typing and selection, protected controls, stale snapshots, duplicate requests, malformed post-input outcomes, unsupported gestures, immutable manifests and inventory corruption.

Final independent review found two integration defects: SDK-returned refusals could permit foreground retry, and verified inputs could continue a batch across an observed URL change. Both received failing regression tests, corrections, and an approved scoped re-review. Full native verification additionally exposed legitimate typed UIA delivery sentinels (`UNKNOWN` and `NOT_APPLICABLE`); the adapter treats them as no delivery claim and still requires positive independent value read-back. Explicit refusal, escalation, error and malformed receipts remain uncertain. The actual occlusion fixture now waits for bounded owned-window hit-test readiness without activation; production recipient checks are unchanged. Final full suites passed after these corrections.

The native Win32 fixture verifies the actual changed Edit value with zero screenshots, foreground and cursor equality, and the target's relative order among surviving visible windows. Concurrent `WM_CHAR` delivery and read-back succeed in a second owned background Edit. This does not establish uninterrupted physical typing into the user's foreground application, or preservation of unrelated helper windows' ordering.

Modern Notepad returned the actual requested value through UI Automation. That earlier test exposed a focus-changing keyboard cleanup route; the route is now refused before SDK dispatch. Restored user tabs were retained and the owned fixture document was left open. This is positive value-readback evidence, not complete Notepad background gesture acceptance.

## Execution routes

Browser semantic filling and selection verify independent application state. Visual typing resolves a retained focused node from the current snapshot, preserves its frame and text selection, and refuses protected or newly appeared controls. Browser semantic actions do not require screenshots. Coordinate actions require the current requested image.

Native background `setValue` passed fixture read-back and desktop invariants. Native invoke and click changed target window order during acceptance before restriction; they now refuse before Cua dispatch. Keyboard, selection, scroll and remaining native pixel gestures also refuse in Background. Fast can request one Rust foreground action after a definite pre-dispatch refusal and a fresh scoped approval. SDK escalation, post-dispatch uncertainty and malformed receipts cannot permit a replay. Unsupported background operations remain explicit capability refusals.

Unverified input ends the batch. A bounded read-only provider outcome review can check changed application postconditions, but admits no subsequent input. Completion never treats successful input delivery as proof of task success, and independent completion does not erase historical delivery uncertainty.

## Stop and efficiency evidence

[Stop samples](../../artifacts/performance/computer-use-stop.json) measure native gate closure and Job Object teardown with blocked worker stdin and an admission permit held. Across twenty warm samples, p95 gate closure was one microsecond and p95 executor teardown was 5.343 ms, below the 50 ms and one-second thresholds. Gate durations below one microsecond are recorded as zero at the timer's integer resolution. A synthetic `WM_HOTKEY` message exercises the dedicated native Stop thread; physical Ctrl+Alt+Esc delivery remains a separate interactive acceptance check.

[Execution measurements](../../artifacts/performance/computer-use-execution.json) compare twenty warm repetitions of five field changes in installed headless Edge, with one warm-up excluded. Each semantic executor completed 100 independent field read-backs and used zero screenshots.

| Local executor | Median five-field time | p95 | Median reduction from baseline |
| --- | --- | --- | --- |
| Reproduced screenshot loop | 3,708.12 ms | 3,813.24 ms | Baseline |
| Semantic source executor | 331.64 ms | 358.24 ms | 91.06% |
| Semantic packaged executor | 392.39 ms | 444.52 ms | 89.42% |

The reproduced baseline includes coordinate input, repeated load waits, the fixed 500 ms sleep and a PNG after each change. It excludes the old implementation's extra modifier screenshots, so it is a conservative comparison. Measurements cover the fixed executor protocol and application read-back; they exclude startup, provider latency, human approval and the complete Rust planner loop. A packaged native value change took 2,967.19 ms and passed read-back with zero screenshots; that single sample does not establish a native twenty-repetition efficiency improvement. Five operations in one semantic proposal are supported; live planner round-trip savings require an actual provider run.

The refreshed [UI profile](../../artifacts/performance/profile-summary.json) records 3.3 ms warm launcher p95, 0.1 ms input p95, 4.2 ms selection-to-paint p95, 12 ms hover-to-paint p95 and no browser tasks over 50 ms in the measured interactions. Its cadence-aware checks pass. Observed browser cadence was approximately 238 Hz, while the recorded strict 240 Hz aggregate remains false. This is installed-Edge renderer evidence, not a packaged WebView2 or guaranteed 240 FPS result.

## Packaging and remaining acceptance

Cua's Windows wheel and its three matching native resources are checksum pinned. The onedir executor and complete runtime inventory are staged together and verified before reuse. Installed smoke additionally checks every installed Computer Use file against that inventory and tests native health, Stop availability, window lifecycle and sanitized diagnostics before uninstall and profile cleanup.

The corrected full release and [installed NSIS smoke](../../artifacts/packaged/packaged-smoke.json) passed on the reference host. The installer is 202,496,453 bytes with SHA-256 `f28b57d0d62952040e15942c1b478c99e2f251c4004fdcd86bbda0cb609e8686`. All 275 installed Computer Use runtime files matched their staged checksums; packaged execution, native Stop, browser and desktop health were available. Exact vector search, lexical fallback, window show/hide and diagnostics export also passed. The isolated installation was uninstalled and its profile cleaned. Authenticode status is unavailable from this host's smoke toolchain, so signature validation was not established.

The required CLIProxyAPI source was found in a separate local checkout, clean revision `a4acc9f752bd46571f737a10c04bf413656ab06b`. Its Go 1.26.3 sidecar was built into this worktree without changing that checkout. The existing staging script uses `../CLIProxyAPI`; on this host it skips rebuilding and the release reuses the locally built executable. Build outputs remain untracked.

The frontend release build retains the existing `lottie-web` direct-eval and plugin-timing notices. ESLint passed with zero warnings. The staged executor's optional-module packaging notices did not identify missing required runtime files; the installed inventory and native health checks provide the packaging evidence.

Neither Gemini nor OpenAI credentials are configured on this host. Both availability probes correctly return unavailable. Live cloud task completion, current model availability, provider latency/usage and the requested 50% planner-round-trip reduction remain unverified. Physical hotkey delivery and real concurrent foreground keyboard input also remain open. Hyper-V workspaces, UFO workflows, dedicated Office COM adapters and attachment to existing browser profiles remain outside v1.

The implementation and local evidence are ready for PR review. `origin/main` was refreshed and still matches the base commit above. Source and evidence diffs pass `git diff --check`. The branch has not been pushed and no PR has been created.
