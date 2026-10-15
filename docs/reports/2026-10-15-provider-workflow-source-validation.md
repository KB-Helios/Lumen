# Provider workflow source validation — 2026-10-15

Task 7 remains **partially verified**. This change fixes reproduced startup and OAuth cancellation defects with owned fixtures; it does not establish live provider or actual tool-client acceptance.

The source baseline was `589c057cdd9824755cc88bfb60731bcc67b39c65` on `codex/production-readiness`. The only pre-existing untracked file was the production-readiness plan; it is excluded from this change.

## Changes

- Clean Cliproxy startup now creates a loopback-only config, native-generated management/client keys, and its auth directory before spawning the fixed executable. Existing config, port, management key and auth files are preserved. Incomplete state, relative/traversing paths, non-files, symlinks and Windows reparse ancestors fail closed. Creation reuses the existing private atomic writer. Windows paths and keys are quoted as YAML-compatible JSON strings. An inherited `MANAGEMENT_PASSWORD` cannot silently override the config's management authentication.
- Native OAuth cancellation now requires `status: "ok"` and an explicit boolean `cancelled`. Malformed acknowledgement produces a fixed error rather than being classified as an absent session. Explicit `false` remains distinguishable from cancellation success.
- The authorization panel clears a session after confirmed cancellation or a confirmed-absent response. For `false`, it refreshes linked status and returns to a fresh sign-in control without claiming cancellation succeeded. Rejected/unconfirmed cancellation retains the session, error and Cancel control for retry. A cancellation request immediately fences pending/future polling so a late response cannot claim sign-in or discard retry ownership.
- Cargo formatting also reflows one existing error return in `profile_ownership.rs`; it has no behavior change.

## Verification

Fresh recovered-worktree verification used RTK, explicit Windows PowerShell without login initialization, and Bun. Native commands ran serially through `.superpowers/run-native.ps1` with `D:/CodexBuilds/Lumen/production-readiness`, `-j 1`, and one test thread. Exact commands, exits and observed output excerpts are in the ignored local Task 7 report.

Fix round 1 addresses the reviewed recovery defect. A repeated-false regression verifies linked-state reconciliation and starting a second OAuth session without remounting. The existing deferred-poll race now verifies that a late `done` result stays fenced, then that an absent-session acknowledgement restores the sign-in control without displaying `Signed in`. Thrown cancellation still retains the original session and retry control. The final focused settings suite passed 10/10; typecheck and scoped zero-warning ESLint passed. Exact RED/GREEN and intermediate correction outputs are appended to the local Task 7 report.

Fresh runs passed the six config tests (including Windows path quoting and reparse refusal), the clean-start config initialization test, the native malformed/already-gone cancellation acknowledgement test, two focused settings test files (10 tests), typecheck, scoped zero-warning ESLint, and `git diff --check`. An initial corrected-path attempt ran one file and passed seven tests; the actual second file, `ProviderDialogs.test.tsx`, was then run and the combined result was 10 tests. The predecessor's frontend count of 12 was not reproduced and is not claimed.

The predecessor reported a 45-test provider-switcher run, 16 staged CLIProxyAPI integration tests, strict Clippy and formatting success, plus an executable SHA-256 of `417e118bd81af7a8a1c20c3fa437f2c763d405e13e41924e2b97d18968b5f87a`. No Task 7 raw logs or evidence directory were present when this worktree was recovered; these are predecessor reports, not fresh results here. The staged binary was not re-hashed or re-exercised during recovery.

## Pending acceptance

| Gate | Status / prerequisite |
| --- | --- |
| Local/cloud/Auto answer inference, valid/expired auth, unavailable model, real rate-limit behavior, fallback attribution/reset, Stop/Retry and process reopen | Unverified. Requires owner-approved accounts/models plus an isolated Windows credential namespace and synthetic-only index/app state. The configuration-only “Test route” behavior is unchanged. |
| Actual Claude Code, Codex CLI, Gemini CLI, OpenCode and OpenClaw inference | Unverified. Requires approved executable versions and independently confirmed isolated homes/configuration for each actual client. Profile writer fixtures do not establish client inference. |
| Live OAuth start, successful sign-in, cancellation, expiry and restart | Unverified. The staged test checks local management and an absent state only. Requires owned initialized runtime and explicit account authorization. |
| Installed application / packaged WebView, final full frontend/Edge/native suites, staging and release build | Pending Task 14. This source milestone did not launch the ordinary application or run installer acceptance. |
| Docker acceptance | Explicitly pending. No Docker lifecycle, staging or runtime attempt was performed. |

No ordinary client configuration, Windows Credential Manager slot or index was changed. If cancellation returns `false`, the server confirmed the old session is absent: the UI clears that session and reconciles the provider's linked status, permitting a fresh sign-in. Only an unconfirmed cancellation error retains the session and retry control. Interrupted bootstrap state is preserved and refused rather than silently replacing a key or config. Live/installed acceptance and recovery of such existing incomplete state remain separate from these fixture checks.
