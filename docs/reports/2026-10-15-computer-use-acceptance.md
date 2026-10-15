# Computer Use acceptance: local evidence and installed runbook

Date: 2026-10-15. Tested source: `00bb9b902e773245be8df1badb3da2508022e8f0` on `codex/production-readiness`. At the start, no tracked files were dirty; an unrelated untracked production-readiness plan was present and excluded. This pass changes documentation and refreshes the existing content-free Stop timing artifact. It changes no product behavior, assertions, deadlines, grants or budgets.

**Installed-app, live Gemini/OpenAI tasks, native selected-window execution and physical Ctrl+Alt+Esc acceptance remain pending.** Local fixture successes below do not close those gates. No ordinary Lumen startup or native provider health command was invoked. Fixed provider credential slots were neither read nor changed, and no provider inference was requested. Docker remains deferred and was not operated.

## Fresh evidence

| Layer | Result and scope |
| --- | --- |
| Rust Computer Use unit/native fixtures | 36 passed, 6 ignored. Covers denied/replayed approvals, stale state, independent completion checks, exactly 60 turns/actions, stopped admission, startup fencing, cancellation of an owned loopback HTTP response, blocked-stdin Job teardown and synthetic native Stop thread message. No physical keypress. |
| Persisted consent fixture | 1 passed. UUID-owned temporary settings fail closed, require actual booleans, and preserve independent browser/control/desktop-cloud grants. No ordinary settings file was read. |
| Source executor and staging inventory | 28 passed. Installed Edge with fresh headless contexts and synthetic loopback pages; value/selection read-back, frame identity, stale snapshot refusal, duplicate command fencing, uncertainty, protected fields, strict manifests and inventory tamper detection. Native Background refusal checks use mocks and assert no SDK call. |
| Cached staged runtime | Source fingerprint and all 275 inventory entries verified by the existing staging command; cached runtime reused. Source and binary worker health agreed. Worker health has no provider integration; this is distinct from native `computer_use_health`. |
| Rust to staged executor / Edge | 1 explicitly ignored test run separately and passed. Two begins independently observe an empty field, verify a synthetic value, and end the context. Warm worker reuse is asserted; pool invalidation rejects late recaching and independently checks worker exit within the unchanged one-second bound. |
| Direct native Stop fixture | 1 explicitly ignored test run separately and passed, 20 samples. Each owns a hidden sleeping process in a Job, blocks stdin, holds an admission permit, calls native Stop directly, rejects new admission and checks process exit/writer failure. See [raw timing samples](../../artifacts/performance/computer-use-stop.json). |
| Typed native service / UI fixtures | 39 passed in 4 files. Mocked IPC, typed event validation, 4,000 Unicode character boundary, approval/Stop retry, cleanup acknowledgment and independent consent persistence. No installed IPC or provider. |
| Browser keyboard UX | 1 installed-Edge E2E passed. `service=memory&computerUse=memory` covers action focus order, approval, Take Over, denial and a new run. Keyboard events are confined to headless browser automation; no physical OS hotkey was synthesized. |

Stop timing: p95 admission closure **0 microseconds at the recorded timer resolution**, p95 process teardown **3,241 microseconds** across 20 samples. The unchanged gates are 50,000 and 1,000,000 microseconds respectively. These measurements exclude physical hotkey delivery, provider latency and human approval wait. A zero recorded duration is not a claim of zero physical latency.

Environment: Windows `10.0.26300.0`, Bun `1.3.14`, Python `3.11.15`, installed Edge `155.0.4283.45`, Visual Studio developer shell `18.9.3`. Native commands used one build job and one test thread with `CARGO_TARGET_DIR=D:/CodexBuilds/Lumen/production-readiness`, incremental compilation off and dev/test debug information off. No installed Lumen/WebView2 acceptance inventory was collected.

Staged executor SHA-256: `1d0f1703bde0a41bbbbcf6e664a1cbea390e274c92363805e9a0ac26be1a8ed4` (3,534,890 bytes). Staging build fingerprint: `16b821901bac0046021d4fb2ea071e272e1388cdae8f029fd6142e82d545321f`. The wire test launched the repository's `src-tauri/binaries/lumen-computer-use-x86_64-pc-windows-msvc.exe`, **not an installed application**. Both locations report binary mode as `packaged`; that label alone cannot establish installation provenance.

## Reproduce the isolated local subset

Run from the repository root on Windows with the checked-in dependencies installed. Every shell invocation uses RTK, explicit `powershell.exe` and a non-login shell. The local `.superpowers/run-native.ps1` wrapper initializes MSVC and the D-drive target directory; in another checkout use the same developer environment and serial settings. Pass cargo's `--` through `powershell.exe -File` rather than invoking the wrapper inside a `-Command` expression, which can consume the separator.

These commands were run and exited 0:

```powershell
rtk proxy powershell.exe -NoProfile -File .superpowers/run-native.ps1 test --all-features --manifest-path src-tauri/Cargo.toml -j 1 computer_use:: -- --test-threads=1
rtk proxy powershell.exe -NoProfile -File .superpowers/run-native.ps1 test --all-features --manifest-path src-tauri/Cargo.toml -j 1 consent:: -- --test-threads=1
rtk proxy powershell.exe -NoProfile -Command "bun run stage:computer-use"
rtk proxy powershell.exe -NoProfile -File .superpowers/run-native.ps1 test --all-features --manifest-path src-tauri/Cargo.toml -j 1 computer_use::executor::tests::rust_executor_wire_and_warm_pool_verify_real_edge_state -- --ignored --exact --test-threads=1
rtk proxy powershell.exe -NoProfile -File .superpowers/run-native.ps1 test --all-features --manifest-path src-tauri/Cargo.toml -j 1 computer_use::coordinator::tests::native_stop_twenty_blocked_worker_samples -- --ignored --exact --test-threads=1
rtk proxy powershell.exe -NoProfile -Command "bun run test -- src/services/computer-use/tauri-computer-use-service.test.ts src/features/computer-use/useComputerUseController.test.tsx src/features/computer-use/useComputerUseController.cleanup.test.tsx src/features/settings/settings.computer-use.test.ts"
```

From `workers/computer-use-preview`, the selected Python modules exclude interactive native window fixtures:

```powershell
rtk proxy powershell.exe -NoProfile -Command ".venv/Scripts/python.exe -m unittest -v test_executor test_stage"
```

Before the E2E run, port 1420 had no listening process. The runner then started and stopped its own Vite process; installed Edge and strict port 1420 were retained. Do not reuse an unverified server for new evidence:

```powershell
rtk proxy powershell.exe -NoProfile -Command '& { if (Get-NetTCPConnection -LocalPort 1420 -State Listen -ErrorAction SilentlyContinue) { throw "Port 1420 is occupied; no reused server allowed for this evidence." }; bun run test:e2e -- tests/e2e/computer-use-keyboard.spec.ts; exit $LASTEXITCODE }'
```

The current nonignored Rust suite includes a hit-test fixture that briefly shows only owned, nonactivating topmost windows and destroys them. It sends no input and changes no foreground/cursor setting. Review fixture admission before rerunning on a shared desktop. The source worker health test starts a private bounded Cua availability probe with an empty application list and desktop display disabled; it observes no window contents.

## Explicitly ignored and unstarted cases

| Case | Current status |
| --- | --- |
| `native_stop_twenty_blocked_worker_samples` | Ignored in the normal suite; explicitly run separately and passed. Direct Stop only. |
| `rust_executor_wire_and_warm_pool_verify_real_edge_state` | Ignored in the normal suite; explicitly run separately and passed against the verified staged binary. |
| `live_provider_availability` | Ignored and not started. Reads fixed credential slots and may make provider network requests. Its assertion permits unavailable results, so a passing exit could not establish live completion anyway. |
| `a_lost_window_instance_marker_invalidates_selection_without_process_changes` | Ignored and not started. Existing harness uses desktop-wide discovery. Requires an isolated non-elevated desktop containing only owned fixtures. |
| `unmarked_windows_are_never_admitted` | Ignored and not started for the same discovery/isolation prerequisite. |
| `pruning_stale_metadata_preserves_the_current_window_marker` | Ignored and not started for the same prerequisite. |
| Python `test_window` and native/staged benchmarks | Not started. Existing fixtures include shared-desktop enumeration/raw mouse diagnostics; selected-window acceptance prerequisites were not established. No full `unittest discover` was substituted. |
| Installer smoke, ordinary installed startup and native health | Not started. No isolated Windows credential account or traceable installed acceptance build was provided. `APPDATA`, WebView2 user-data or `LUMEN_TEST_HOME` overrides do not isolate fixed Windows credential slots. |
| Both providers, both actual targets, physical Stop | Not started. Account/model grants, isolated installed app and owner-operated desktop are unavailable for this pass. |

## Owner-operated installed/live acceptance

This section is a future runbook, not execution evidence. Use a disposable, non-elevated Windows account with no personal windows, ordinary browser profiles or unrelated indexed data. Before opening Lumen, establish the owner's approved provider credentials and cloud grants in that account. Health can check **both** providers using service `com.bridgehammer.lumen.providers`, regardless of the selected provider or app-data override. Do not inspect, replace or remove another account's slots.

Record the source revision/dirty state, signed installer and installed executable hashes, exact installed executor/runtime inventory, OS/WebView2/Edge versions and actual executable paths in a restricted local record. Keep public reports to sanitized provenance/outcomes. Verify the installed files against the staged inventory and record that they came from the installer. A staged executable's `packaged` mode and successful health are insufficient. Run the existing package smoke only in this isolated account after reviewing its exact install/uninstall targets. It remains a narrower gate than the interactive cases below.

Use only the source-configured provider/model IDs in `src-tauri/src/computer_use/protocol.rs`; record the model actually available to the approved account. If unavailable, retain that row pending. Do not silently substitute a new model. A health result is not a completed task.

Prepare an owned loopback HTTP form and the existing disposable `workers/computer-use-preview/native_fixture.py` in the isolated desktop. The browser page can reuse the synthetic `FIXTURE`/`Handler` in `test_executor.py`; start an owned server bound to `127.0.0.1` only and retain its handle for exact cleanup. Never publish it or navigate to ordinary sites. Native fixture output supplies its exact PID/HWND/executable; record process creation identity and the Rust-selected window instance marker locally. Select only that exact current fixture in Lumen. Restarted fixtures require a new selection; never select by title alone. The existing native fixture's protected value is synthetic. Its global raw mouse diagnostics are appropriate only on the isolated owner desktop.

In Settings > Computer Use, configure each provider through the existing credential UI. Grant **Browser task requests** explicitly for the browser rows. For native rows, grant **Selected-window control** and **Desktop cloud observations** independently through their review dialogs. Browser or answer consent grants neither desktop permission. Set the loopback start page through **Computer Use start page**, and use the existing target selector and Run controls.

Run every row below separately for **Gemini and OpenAI**, on fresh **Edge and the explicitly selected owned native fixture**, recording any inapplicable route with its reason. Preserve 4,000 task characters, 60 provider turns/actions, a maximum five-action batch, 60-second approval expiry and all existing observation/action deadlines.

| Case | Required independent observation |
| --- | --- |
| Verified synthetic task | Ask to change only the owned field to a fixed synthetic value. Read that field independently from the HTTP/Win32 fixture and require a fresh matching observation/completion check. Provider prose or a delivery receipt cannot establish success. Record provider/model and provider latency separately from local execution/human wait. |
| Denial and new-run retry | On a provider safety or Fast foreground approval, choose **Deny and stop**. Check stopped state, closed admission and no proposed input. Start a new run explicitly; any subsequent approval must belong to its current action/target/snapshot. A run that never requests approval does not satisfy this row. |
| Stale/expired approval | Change only the owned target after approval is proposed, or let the unchanged 60-second deadline expire. Old approval must not authorize input. Retain the exact source fixture checks for wrong/replayed IDs; do not add arbitrary IPC into the installed product for this exercise. |
| Target loss / replacement | Close only the owned fixture while a run/approval is pending; independently confirm the exact process/window exit. Create a replacement, attempt no automatic reselection, and verify the stale target refuses. Select the replacement explicitly for a new run. Actual HWND reuse is not guaranteed; record it only if demonstrated. The marker-loss Rust fixture is separate evidence and needs its isolated desktop. |
| Background refusal | Request an unsupported native invoke/click/keyboard/scroll action in **Background**. Require `backgroundUnavailable` before SDK dispatch and unchanged owned state, foreground, cursor and relative window order. Do not switch mode to make it pass. Browser semantic actions can succeed; they do not prove native availability. |
| Fast one-time approval | Only on the isolated owner desktop, a definite local pre-dispatch refusal may request one foreground action. Approval must match the fresh target/action/snapshot and refresh state after the human wait. Uncertain delivery must not replay. This pass did not exercise foreground input. |
| Browser consent revocation | Revoke **Browser task requests** during provider wait, approval and execution in separate bounded runs. Confirm terminal Stop, closed admission and owned worker exit; desktop grants must not be inferred or changed. |
| Each desktop grant revocation | With an owned selected window, independently revoke **Selected-window control**, then restore only by explicit owner action for another run and independently revoke **Desktop cloud observations**. Each must stop that scope and invalidate its warm worker. Record persistence failure as failure; local UI withdrawal alone does not prove native closure. |
| Stop / Take Over | Use the product controls during provider wait, pending approval and input. Independently confirm native admission closure, no later task input, exact owned executor/helper exit and no late events replacing the stopped state. Acknowledgment alone is insufficient. Keep already-dispatched input uncertain rather than claiming rollback. |
| Physical Ctrl+Alt+Esc | The owner physically presses the chord while the installed app is busy in each phase above. No simulated OS hotkey or posted message substitutes for physical delivery. Record registration and measured delivery/admission/teardown separately. Confirm exact owned process cleanup and no further input. Do not run concurrent desktop automation during this test. |
| Restart / fresh context | Close/reopen the installed app in the isolated account, retain only explicitly persisted grants, reselect the native fixture, and prove the next Edge run has an empty fresh form/context. No ordinary profile attachment. |

Keep the old run's identity and any uncertain delivery in the record. For cleanup, retain exact handles/PIDs/process creation times and owned temporary directories from setup; close the owned fixture/server, stop the task, and independently verify executor/helper exit. Preserve ordinary user processes and configuration. Remove only test credentials/settings created in the disposable account, then dispose of that account through the owner's established procedure. Do not run Docker as part of this checklist.

For each case record: provider/model, target kind, installed provenance, scope/grants (booleans only), run outcome, failure classification, independent postcondition, exact owned cleanup result and whether physical input was involved. Exclude keys, authorization URLs, raw task text/values, screenshots, ordinary window titles and personal paths from routine diagnostics. Any missing prerequisite, timeout, unavailable route or ignored case stays pending/failed; it is never converted to a production-readiness pass.
