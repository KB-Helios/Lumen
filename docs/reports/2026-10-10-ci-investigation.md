# Native CI failure investigation, 2026-10-10

Investigation of CI run [37977650752](https://github.com/KB-Helios/Lumen/actions/runs/37977650752), on `28925d37e127f20edabd7b1a854c3b8a7ad4fb18`. Remote `main` was checked through the GitHub API and still pointed to that same commit. No subsequent main fix was available during this investigation.

CI passed frontend typecheck, lint, unit tests, Edge E2E, sidecar staging, Rust formatting and Clippy. Rust tests ended with 215 passed, six failed and 12 ignored. Installer build and verification were skipped. The baseline `AGENTS.md` said there was no CI, but the checked-in `.github/workflows/ci.yml` and actual run established that this statement was stale; the correction is recorded below.

The initial investigation was read-only. The parent subsequently authorized focused corrections in event-path admission, scoped freshness tests, the socket test harness, and the stale AGENTS statement. No Cargo suite was run while the parent prepared the native environment. The hypotheses below need focused local reproduction before implementation is claimed complete.

## Five search failures share the event-path boundary

`SearchFixture::new` (`src-tauri/src/search/mod.rs`) builds its paths directly from `std::env::temp_dir()`. `configure_roots` (`indexing.rs:861`) canonicalizes those roots. `refresh_paths` (`indexing.rs:1350`) first calls `index_worker::event_path`; a rejected event silently skips the root and still reaches successful completion.

`event_path` (`index_worker.rs:305`) strips verbatim prefixes, converts separators, and compares lowercase strings. It does not expand Windows 8.3 path aliases. The CI log contains the concrete staging temp path `c:\Users\RUNNER~1\AppData\Local\Temp\tmplkdpthp6`. A fixture path under this short alias differs lexically from a canonical `runneradmin` root even though it names the same directory. This explains all five failures with one admission defect; exact Rust fixture path spelling was not printed by the CI tests, so this remains a strongly supported hypothesis pending reproduction.

| Failed assertion | Consequence of rejected raw fixture event |
| --- | --- |
| `directory_removal_cancels_pending_descendant_extractions`, freshness_tests.rs:1038 | `refresh_paths` does not enter subtree deletion or prune pending descendants; pending remains one. |
| `dirty_same_signature_event_fences_an_already_extracted_stale_body`, :1192 | Dirty event never creates a new admission token or invalidates old body; held extraction can commit the old text. |
| `mixed_directory_file_batch_defers_when_generation_changes_before_file_admission`, :244 | Initial hook runs before path matching, so generation deferral works; retried raw directory/file paths remain rejected and old text survives. |
| `permanent_invalid_utf8_has_bounded_retries_and_truthful_metadata_only_state`, :433 | Explicit dirty event never clears failed signature or admits a fresh pending extraction. |
| `directory_batch_defers_when_generation_changes_after_delegated_reconciliation`, :225 | Root event is rejected before `directory_changed` is set; delegated-reconciliation hook is never invoked and receiver times out. |

The hooks are instance-owned `Arc<Mutex<Option<...>>>` fields on `IndexRuntime`/`WorkState`, not global test hooks. Manual fixtures drop and join their owned worker before controlled calls. The two controlled refresh variants use the same fixture label but a per-fixture PID/time nonce; they do not deliberately share paths or database state. There is no code evidence of global hook cross-talk.

The existing generation, pending admission token, failed-signature retry, subtree deletion and policy checks are present at the relevant production boundaries. Changing those mechanisms or weakening these assertions would miss the common pre-admission failure.

Recommended patch boundary: `event_path` and focused Windows event-path tests. Resolve legitimate Windows path aliases without establishing a new trusted root. Deleted leaves require expanding an existing ancestor and retaining the missing suffix. Preserve lexical symlink/reparse refusals and existing admitted-root/policy revalidation; blindly canonicalizing a live event and discarding its original route can conceal a symlink. Windows `GetLongPathNameW` is a candidate for spelling expansion; validate its behavior before choosing it. A test-fixture canonicalization alone can make CI green while hiding real production alias handling.

Also verify multi-component suffix reconstruction: `root.join(suffix)` currently joins a string whose components were recombined with `/`. Rust's Windows `PathBuf::push` may already normalize these separators, so this is a check rather than a confirmed defect. Retain existing drive-root, UNC, Unicode, sibling-root and symlink tests. Add alias cases for an existing direct file, nested file, removed directory and missing descendant, plus outside-root rejection.

## Gateway failure is an accepted-socket mode assumption

`queue_transport_failure_reports_stop_before_another_submission` (`enrichment.rs:422`) puts its loopback listener in nonblocking mode, accepts a stream, sets a one-second read timeout, and immediately unwraps a read (`:446`). CI reported Winsock error 10035 (`WouldBlock`) from that read, followed by the parent test panicking while joining its server thread (`:472`).

Windows accepted sockets retain properties of their listener; this is documented by [Microsoft's accept reference](https://learn.microsoft.com/en-us/windows/win32/api/winsock2/nf-winsock2-accept). A read timeout does not turn a nonblocking socket into a blocking socket. The server can accept before the client has delivered the HTTP request, making the current assertion scheduling-dependent.

Recommended minimal change: call `stream.set_nonblocking(false).unwrap()` before applying the existing bounded read timeout. Keep the failed-one-request/healthy-two-requests assertions and the caller-visible outcome assertion. Neither production `sync_jobs` behavior nor lifecycle dispatch needs changing on this evidence. Merely lengthening a timeout or serializing the suite does not resolve immediate nonblocking reads.

## Focused verification and environment

The repository requires a Visual Studio developer shell. `vswhere` currently selects `C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools`; both `Common7\Tools\Launch-VsDevShell.ps1` and `Microsoft.VisualStudio.DevShell.dll` exist. Launch a developer shell with x64 host/target selection, then run from `src-tauri`:

```powershell
rtk cargo test --all-features gateway::enrichment::tests::queue_transport_failure_reports_stop_before_another_submission -- --exact --nocapture
rtk cargo test --all-features search::indexing::freshness_tests -- --nocapture
rtk cargo test --all-features search::indexing::freshness_tests::directory_batch_defers_when_generation_changes_after_delegated_reconciliation -- --exact --nocapture
```

For the alias hypothesis, repeat the focused search tests with process-local `TEMP`/`TMP` pointing to an existing short-name spelling (discover it with Windows path APIs), and compare with canonical long-path spelling. Preserve and restore the caller's original environment values. Do not change tests to stop exercising raw alias events. After fixes, rerun the search group under ordinary parallel harness scheduling and the full native suite; `-j 1` limits build concurrency, whereas `--test-threads=1` changes test scheduling and must not be used as the sole proof of a concurrency fix.

No shared native target directory is configured in repository `.cargo` files (neither root nor `src-tauri/.cargo` exists), and this checkout had no `src-tauri/target` directory when checked. The parent is independently locating a reusable local build target. A prior checked-in report, `tailwind-einui-redesign-validation.md`, documents release-profile testing as a disk-space workaround, but that older accepted workaround is not fresh evidence for this checkout. CI uses the default debug-profile `cargo test --all-features`; finish with the project's exact gates when the environment permits.

## Implemented corrections and focused evidence

Added three Windows boundary tests before production edits: expansion of a real short ancestor for root/deleted descendant events, nested verbatim component preservation, and refusal of an outside reparse route targeting the admitted root. A native `GetShortPathName` probe confirmed this host has the real `C:\PROGRA~1` spelling for `C:\Program Files`. `rtk proxy rustfmt --edition 2024 --check src-tauri/src/search/freshness_tests.rs` passed. `AGENTS.md` now describes actual Windows CI.

The parent created `.superpowers/run-native.cmd`, which selects the developer environment and uses `D:\CodexBuilds\Lumen\answer-reliability` with `CARGO_INCREMENTAL=0`. Native test execution is coordinated to avoid parallel Cargo compilation against that target.

`event_path` retains its existing lexical path admission first. When Windows spelling does not match, a bounded helper checks every existing original ancestor for `FILE_ATTRIBUTE_REPARSE_POINT`, rejects relative and parent-traversal routes and inaccessible ancestors, expands the nearest existing ancestor with [GetLongPathNameW](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getlongpathnamew), and appends the missing suffix. It does not canonicalize a new trust root. Expansion is limited to 256 ancestors and a 32,768-wide-character buffer; malformed or excessive routes remain rejected. The admitted-root and policy checks in the existing indexing callers remain authoritative. Suffix joining stayed unchanged because the nested-verbatim baseline test already passed.

The gateway test now explicitly sets its accepted stream to blocking mode before applying its existing read timeout. All original request counts and outcome assertions remain unchanged. No production gateway behavior was altered.

| Check | Fresh local result |
| --- | --- |
| Baseline path-admission tests, from compiled native binary before production edit | **RED:** short alias assertion returned `None` instead of `Some("\\\\?\\C:\\Program Files")`; existing drive/UNC/Unicode and nested-verbatim tests passed. |
| Baseline original gateway transport test | **RED:** reproduced Winsock 10035 `WouldBlock` at enrichment.rs:446 and join failure at :472. |
| `.superpowers/run-native.cmd cargo test --manifest-path src-tauri/Cargo.toml --all-features -j 2 watcher_path_admission -- --nocapture` after correction | **GREEN:** three tests passed, compilation completed in 1m48s; other binaries had zero matching tests. |
| Retained green native binary, original gateway transport test plus new reparse-route rejection | **GREEN:** two passed in 0.24s. |
| Retained green native binary, five original CI search regressions with process-local `TEMP`/`TMP` set to a real short alias of an isolated temporary directory | **GREEN:** five passed in 0.25s. The subprocess environment was restored and the verified owned temporary directory removed afterward. |
| Retained green native binary, `search::indexing::freshness_tests --nocapture`, ordinary parallel harness scheduling | **GREEN:** 38 passed, zero failed/ignored, 211 filtered out, 8.69s. This includes all five original CI failures, symlink safety, generation fencing, retry and deletion regressions. |
| `rustfmt --edition 2024 --check` on added tests and `git diff --check` | **GREEN.** |

The original five CI failures were not independently rerun with an alias on a pre-correction snapshot; the initial baseline proof for the shared cause is the newly added alias regression plus the CI failures and causal trace. The later alias subprocess used the green binary already replaced by the successful link, so it is recorded only as green evidence. `.superpowers/ci-focused-tests.exe` retains this compiled test snapshot for independent focused execution while the parent changes native answer APIs. These focused passes do not establish that the parent's later native answer edits, full Rust suite, Clippy, release packaging or subsequent hosted CI have passed; the parent owns those final gates.

Final complete-gate results are recorded in [the answer reliability report](2026-10-10-answer-reliability.md). This investigation preserves the original hypothesis and focused reproduction evidence separately from those final results.
