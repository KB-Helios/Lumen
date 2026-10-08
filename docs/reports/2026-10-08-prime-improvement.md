# Prime Agent and verified improvement acceptance

Implementation date: 2026-10-07 to 2026-10-08. Workspace: managed Lumen worktree `af24`, based on merge HEAD `4e0e545` (the same source tree as `fec9bd3`). The verification below was recorded before PR publication.

The five implementation stages are present in source: private native trace/version storage, pinned Docker/ACP candidate runtime, durable Rivet jobs and improvement routes, fixed synthetic evaluation and atomic promotion, and controls in the existing settings surfaces. The feature defaults off, uses the local route and requires independent improvement cloud consent. Actual Docker/Prime acceptance remains blocked; this report does not describe the feature as production-ready.

## Verified local behavior

| Check | Result |
| --- | --- |
| `bun run typecheck` | Passed |
| `bun run lint` | Passed with zero warnings |
| `bun run test` | 446 passed across 64 files |
| Focused historical candidate review/service/workflow tests | 26 passed across six files |
| `bun run test:e2e` | 53 passed using installed Microsoft Edge, serial/no retries |
| Python guest/archive/ACP fixture tests | 12 passed |
| `bun test workers/improvement-queue.test.ts` | Two SQLite queue tests passed |
| Focused native improvement tests | 26 passed; one actual Docker test explicitly ignored |
| Rust fmt | Passed |
| Rust clippy, all targets/all features | Passed with warnings denied |
| `cargo test --all-features -j 1` | 191 passed, 12 explicitly ignored across five suites |
| Checksum-pinned AgentGateway configuration acceptance | Actual sidecar accepted the generated nine-route configuration |
| Full Tauri release/NSIS build | Passed, including staged sidecars and the optimized native executable |
| Packaged native smoke | Passed with isolated app data; improvement defaults and bundled resource verified |
| Gallery regeneration | 57 states and contact sheet captured using installed Edge |
| Focused UI screenshots | Candidate diff/report and Privacy controls captured and visually inspected; explicitly simulated fixtures |
| Interaction recordings | Six WebM studies and manifest regenerated |
| Performance regeneration | Passed measured release checks; strict nominal 240 Hz remains false |

The first complete frontend run timed out in an existing keyboard coordination test under concurrent build load; all six keyboard tests then passed in isolation and the complete 446-test run passed. A later concurrent native rerun failed with memory-allocation errors. Its serial rerun passed all 191 tests. These failures are retained as environment evidence, not counted as passing attempts.

Source/fixture coverage includes private-field rejection, bounded workflows, stale approvals, atomic and unique activation, immutable rollback snapshots, persisted budgets, imported-candidate recovery, explicit cancellation versus policy pause, fixed-suite completeness, improved and degraded synthetic candidates, separate cloud admission, actual loopback HTTP cancellation/model identity/usage enforcement, partial protocol-frame preservation and cancellable blocked guest writes. The synthetic evaluator integration executes three baseline/candidate repetitions for all eight cases and proves good-candidate activation, bad-candidate rejection and rollback. It uses a deterministic model broker, not a live provider.

Guest ACP tests use real subprocess pipes and a test-only ACP peer plus loopback HTTP/SSE. They validate initialize/session/prompt/cancel framing and stream adaptation. The test peer is excluded from the image. Native protocol tests inspect generated sandbox arguments and ownership checks; they do not prove Docker enforcement.

## External runtime blockers

`bun run stage:improvement` fails its real engine check because the fixed Docker Desktop Linux engine named pipe is unavailable. Docker Desktop was already installed and was launched for developer acceptance; its backend failed in Inference Manager Unix-socket initialization. No Docker factory reset, configuration change, data deletion or installation was performed. No image archive or checksum manifest was generated.

Consequently, the pinned Dockerfile has not been built here. Actual Prime Rust compilation/import completeness, independent-build checksum reproducibility, real Prime ACP candidate delivery, no-network/no-host-file enforcement, guest credential absence, resource limits, forced removal and cross-installation cleanup against actual containers remain unverified. The explicit actual-Docker acceptance test remains ignored with its prerequisites stated. Good/bad/rollback acceptance through real Docker is also outstanding.

The actual Rivet improvement recovery test reaches the staged Rivet 2.3.10 Windows GNU engine but it exits before readiness with `0xc0000005`, before producing a log. Its `--version` and `start --help` commands succeed. The startup failure repeated under reduced concurrent load. The compiled worker's actual durable recovery therefore remains unverified on this machine. Direct SQLite tests establish idempotency, atomic admission, expiry/recovery and generation fencing using the same production SQL. Native improvement health now requires a running enrichment worker and reports queue unavailability instead of readiness when it is stopped.

## Review and packaging boundaries

Independent runtime review reproduced and verified fixes for lost partial frames and blocked response writes. Final review found two lifecycle issues: explicit cancellation retaining Evaluating status and recovered evaluation using the expired generation probe. Both were fixed and independently rechecked. Candidate review now loads its immutable historical parent, even after preferences or rollback change the active version.

Normal packaging includes an optional `improvement-runtime/` resource directory. A README is bundled when generated runtime assets are absent, while Prepare remains unavailable. This is truthful unavailable behavior and does not certify a prepared Prime runtime. Model-scoped supplements and configuration invalidation prevent evaluated guidance/workflows from being applied to an untested model configuration.

The actual NSIS installer is 186,517,251 bytes, SHA-256 `fb579a4947fc71a474abf3fe7021e76d2f763242a33ad9da0593db612694f265`. Its installed native smoke verified disabled/local/no-cloud improvement defaults, version zero and no traces, the bundled improvement resource, all 275 checksum-verified Computer Use runtime files, native Stop, browser/desktop health, exact vector search, lexical fallback, native show/hide and sanitized diagnostics. The temporary installation was uninstalled and its profile cleaned. Signature status is unavailable from this host's toolchain, so Authenticode validation was not established. Evidence: `artifacts/packaged/packaged-smoke.json`.

The first gallery attempt under concurrent build load timed out waiting for a model preview. After the optimized compilation completed, the full 57-state gallery and contact sheet passed. These browser screenshots are UI evidence; they do not demonstrate live Prime execution.

Browser evidence was regenerated against the modified working tree at parent HEAD `4e0e545` using Microsoft Edge 154.0.4258.62. The deterministic profile measured warm-launch p95 3.8 ms, input p95 0.1 ms, selection-to-paint p95 4.8 ms, hover-to-paint p95 12.8 ms and an observed cadence estimate of 238 Hz. The cadence-aware checks passed; strict nominal 240 Hz selection and hover checks did not. There were no repeated browser long tasks above 50 ms or active animations/indicators after settling. This is browser instrumentation, not a fresh native WebView2 performance or live-model quality measurement.

Focused screenshots in `artifacts/improvement/` show the candidate's original-base diff and test measurements, plus separate improvement cloud consent, explicit preference saves and data deletion. Their manifest marks the development-only fixture source. They establish UI appearance and controls, not actual candidate quality or runtime readiness.

Build-cache cleanup was limited to this run's Git-ignored `src-tauri/target/debug` output after native checks completed. Absolute containment, absence of reparse points and compiler inactivity were checked before removal. Source, other worktrees, user data and application settings were preserved.

## Completing real acceptance

On a machine with a healthy Docker Desktop Linux amd64 engine and healthy pinned Rivet worker, run `bun run stage:improvement`, then use Prepare explicitly. Set `LUMEN_IMPROVEMENT_ASSETS` to the generated asset directory and run the opt-in actual-Docker acceptance test. Perform one improved candidate, one degraded candidate and rollback through the real Docker/ACP plus host evaluation path. Record live-provider model identity, complete usage, budgets and fixed-suite results separately from the deterministic broker evidence above.

From a Visual Studio developer shell in `src-tauri`, the opt-in runtime tests are:

```powershell
$env:LUMEN_IMPROVEMENT_ASSETS = (Resolve-Path ./resources/improvement).Path
cargo test --all-features actual_docker_prime_acceptance_generation_cancel_and_ownership -- --ignored --nocapture
cargo test --all-features improvement_worker_recovers_crash_and_fences_old_generation -- --ignored --nocapture
```

The first test uses real Docker/Prime with a deterministic model broker. Passing it is a prerequisite to, rather than a substitute for, the improved/degraded/rollback end-to-end evaluation and live-provider checks.

See `docs/architecture/improvement.md` for contracts, model scoping, security, retention, budgets and activation rules.
