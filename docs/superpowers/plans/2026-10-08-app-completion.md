# Lumen App Completion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the audited security/search defects, finish the existing native features, verify distribution and real runtime behavior, optimize filesystem search, and publish one reviewable PR.

**Architecture:** Preserve typed `src/services` contracts with Rust as the owner of credentials, filesystem authority, workers, and provider requests. SQLite becomes the filename and content inventory; native incremental updates replace per-query recursive walks. Complete existing settings/dialog surfaces and retain explicit consent and unavailable states.

**Tech Stack:** Windows 11, Bun, Tauri 2, React 19/TypeScript/Zod, Rust/rusqlite/reqwest, RivetKit, installed Microsoft Edge.

## Global Constraints

- Follow `AGENTS.md` and `C:/Users/kevin/.codex/RTK.md`; prefix shell calls with `rtk`, use Bun, and do not add shell capabilities.
- Keep text/image preview limits of 64 KiB/4 MiB, no symlink traversal, selected-root confinement, and native owned-process teardown.
- Browser cloud consent, desktop control consent, desktop cloud consent, root enrichment consent, and improvement cloud consent remain independent and default off.
- Computer Use retains HTTP(S), 4,000 task characters, 60 provider turns, 60 input actions, exact target identity, snapshot-scoped Fast approval, and Ctrl+Alt+Esc native Stop.
- Use test-first behavioral regression cycles, isolated test homes and app data, owned processes only, and no real user tool-file edits in tests.
- Execute implementation tasks serially, with spec/quality review after each; controller may investigate upcoming work without modifying overlapping files.
- Every task report distinguishes fresh execution, fixtures, ignored acceptance, and external blockers. Never weaken a gate or redefine completion to bypass a missing prerequisite.
- Conventional Commits, lowercase without scopes; branch `codex/complete-app`; one PR to `main`, attached to this chat.

## Task 1: Security boundaries and native test prerequisite

**Files:** `src/app/App.tsx`, `src/app/App.test.tsx`, `src/services/search/development-file-search-service.ts`, its colocated tests; `src-tauri/src/provider_switcher/client.rs`, `src-tauri/tests/cliproxy_client.rs`; `src/features/settings/components/UsagePanel.tsx`, `src/services/api/providers.ts`, provider DTO/schema files; `scripts/stage-clipproxy.ts` and its tests.

**Interfaces:** Keep `SearchService` stable. Replace raw usage/config IPC values with allowlisted DTOs; usage rows have `{provider, success, failed, total}` only. Staging consumes the official CLIProxyAPI Windows amd64 release and immutable SHA-256; source siblings/Go are unnecessary.

- [ ] Reproduce empty/all-paused roots after completed onboarding using the actual default app composition; reproduce cached open/preview after revocation through the real file service.
- [ ] Add native usage/config fixtures containing literal `sk-audit-secret` map keys and nested fields; assert serialized DTOs contain no secret and retain hand-derived counters.

  ```rust
  assert!(!serde_json::to_string(&safe).unwrap().contains("sk-audit-secret"));
  assert_eq!(safe[0].success, 3);
  assert_eq!(safe[0].failed, 2);
  ```

- [ ] Stage the official pinned v8 proxy to unblock the native build script. Verify archive and extracted executable; test bad checksums fail and do not replace a valid output. Run the real executable with isolated configuration, without credentials or OAuth.
- [ ] Observe security regressions fail, then remove onboarding fallback after saved settings, revalidate cached-file roots, aggregate management data in Rust, and Zod-parse safe DTOs before state.
- [ ] Run focused App/file-service/usage tests and actual native proxy boundary tests; run typecheck/lint. Commit and write the task report with red/green evidence and exact pinned asset provenance.

## Task 2: Unified search correctness

**Files:** `src/services/search/development-file-search-service.ts` and tests; `src-tauri/src/search/index.rs`, `indexing.rs`, `matching.rs`, `ranking.rs`, `types.rs`, `commands.rs`, traversal/policy tests as needed.

**Interfaces:** Search input keeps request IDs/scopes/filters/preferences. Indexed metadata includes unsupported-content files and folders; native results preserve stable ID, bounded rank, metadata, provenance, and pin state. Root changes prune revoked inventory even with content indexing paused.

- [ ] Add failing production-service regressions: `.md` filter removes `.tmp`, root exclusions remove cache files, native order survives duplicate merge, Recent/Related index failures reject, actual fallback reports degraded, and empty roots clear cached admission.

  ```ts
  expect(response.groups.flatMap(group => group.items).map(item => item.name)).toEqual(['report.md']);
  await expect(service.search({...request, scope: 'recent'})).rejects.toMatchObject({recoverable: true});
  ```

- [ ] Add native real-file/SQLite cases for each filter, policy, folder/file type, exact/recency/pin ordering, and revoked roots while paused. Observe expected failures.
- [ ] Route queries through one policy-aware metadata/content inventory and native ranking; preserve exact search when models/vector extension are unavailable. Surface invalid index payloads and native failures accurately.
- [ ] Run covering frontend and native search suites. Commit and write report; specify any new DTO fields consumed by Task 3 verbatim.

## Task 3: Index freshness and cancellable incremental work

**Files:** `src-tauri/src/search/indexing.rs`, `index.rs`, new focused index-worker/watch module, `src-tauri/src/lib.rs`, `src-tauri/Cargo.toml`/lock if necessary; search/native-AI typed contracts and adapter tests; relevant Activity/index deletion integration.

**Interfaces:** Preserve `synchronize_index_roots`; return truthful status/generation. Root configuration admission is immediate, extraction runs independently, and native worker owns its watch lifecycle. Change events never admit paths outside saved roots. Pending/paused work is retried rather than cached as complete.

- [ ] Write failing real-filesystem tests: edit changes content, rename/deletion removes old hits, symlink/excluded events never appear, pause/resume catches pending content, root removal cancels and prunes, index deletion rebuilds deliberately, overflow triggers bounded reconciliation.
- [ ] Verify a blocked first extraction does not block an inventory query and cancellation/root-generation changes prevent stale writes.
- [ ] Implement debounced incremental metadata/extraction updates, bounded queue/overflow reconciliation, activity-aware retry, and lifecycle cancellation. Fetch current watcher documentation with Context7 before choosing library-specific API syntax.
- [ ] Remove ordinary-query recursive traversal and unconditional synchronization waits. Retain a truthful indexing UI state while inventory is prepared.
- [ ] Run real native worker/search tests plus adapter tests and native fmt/clippy. Commit and document the watcher/debounce/reconciliation contracts for benchmarks.

## Task 4: Reliable answer streaming

**Files:** `src-tauri/src/gateway/answer.rs`, focused event-parser module/tests if needed, `src/features/answer/useAnswerController.ts` and tests, typed answer event/service schemas.

**Interfaces:** An attempt boundary clears partial answer text/usage and updates provider/model while source citations remain bounded. Deadline/cancellation covers connecting, headers, error-body reads, and event streaming.

- [ ] Reproduce cloud partial delta then local fallback through the real controller; expect only the replacement answer and local usage.

  ```ts
  expect(result.current.text).toBe('Replacement local answer.');
  expect(result.current.provider).toBe('local');
  ```

- [ ] Add actual loopback server cases for stalled headers, blocked bodies, cancellation, split UTF-8, LF/CRLF, optional data-field spaces, multiline frames, provider errors, and incomplete completion.
- [ ] Observe failures, then implement explicit attempt boundaries, fixed request deadlines/cancellation selects, bounded byte/event parsing, and validated event consumption.
- [ ] Run covering controller/native protocol tests and fmt/clippy; commit and report cancellation timing and parser cases.

## Task 5: Provider setup and switching

**Files:** provider-switcher native config/supervisor/files and focused provider catalogue storage; registered commands in `lib.rs`; `src/services/providers`, `src/services/api/providers.ts`, existing ProvidersPage/AddProviderDialog/EditProviderDialog/Usage/AuthCenter tests and e2e.

**Interfaces:** Add/update/list/switch/remove have registered typed camelCase IPC. Saved keys never appear in list/overview/usage/error DTOs. Existing atomic file writers/backups remain the source of tool switching behavior.

- [ ] Add failing isolated-home native integration cases for first-run config, save/edit preserving a stored key, switch/additive writes, removal, malformed inputs, rollback on write failure, and sanitized errors.
- [ ] Add real-component tests that open and submit the existing dialogs and render safe returned provider metadata; native invocation tests catch argument-name mismatches.
- [ ] Generate private management/client keys, correctly escape Windows YAML paths, verify readiness with bounded checks, persist a native provider catalogue, register missing commands, and connect existing UI actions.
- [ ] Run native tests and installed-Edge provider workflow tests against isolated boundaries. Commit and report actual proxy health/config acceptance separately from OAuth accounts requiring user interaction.

## Task 6: Working enrichment and Windows queue runtime

**Files:** `workers/enrichment-worker.ts` and queue tests, sidecar staging/runtime supervision, `src-tauri/src/gateway/enrichment.rs`, new native consumer, `src-tauri/src/search/index.rs`/extraction/indexing, provider route integration, compiled-worker acceptance.

**Interfaces:** Lease identity includes generation/hash/kind/route. Native consumer owns file reads, consent, credentialed provider calls, bounded OCR/transcription output, and transactional artifact/chunk/job completion. Worker receives no provider key or arbitrary command.

- [ ] Reproduce the actual pinned Rivet Windows startup failure in isolated directories; inspect primary upstream source and diagnose the failing component. Repair staging/startup with a pinned supported build and record executable provenance.
- [ ] Add failing actual queue/SQLite/provider-loopback cases for OCR/transcription results becoming searchable, duplicate delivery, crash recovery, expired leases, changed hash, revoked root/consent, cancellation, output bounds, and retry exhaustion.
- [ ] Implement consumer lease/heartbeat/complete with immutable root/hash revalidation, fixed vision/audio request contracts, cancellation/activity limits, and atomic indexed-artifact completion.
- [ ] Run compiled worker startup/recovery/fencing and content-search acceptance. Run controlled real-provider vision/audio acceptance when native credentials and explicit grants are available; otherwise preserve the external requirement.
- [ ] Commit and report which real runtime checks passed and which remain blocked; Task 7 must consume those blockers rather than masking them.

## Task 7: Release and live acceptance

**Files:** staging tests/manifests, `.github/workflows/ci.yml`, packaging/signing/installed-smoke helpers, `src-tauri/tauri.conf.json`, Computer Use/Windows AI/Prime acceptance evidence, release docs.

**Interfaces:** Clean checkout produces mandatory pinned resources. Signed-release verification checks actual Authenticode status and owner-approved signing configuration; installed smoke uses isolated app data and restores owned test installation state.

- [ ] Run staging from a clean output directory and reject absent/corrupted mandatory assets. Verify release version agreement including Cargo.
- [ ] Implement/run signing and install/upgrade/uninstall checks with real artifacts. Inspect available signing identity without outputting private material; request owner prerequisite if unavailable and continue all independent work.
- [ ] Run actual supported Computer Use/native Stop fixtures, Windows AI availability/eligible runtime checks, configured provider checks, real Rivet recovery, and Docker/Prime ACP isolation/evaluation/rollback. Missing eligible hardware/credentials/engine remains an explicit incomplete gate.
- [ ] Run full typecheck, zero-warning lint, unit, Edge e2e, Rust fmt/clippy/tests, and Tauri release build in the required order. Record current-source outputs, ignored tests and hosted status separately.
- [ ] Commit release changes and an evidence report. Never mark the overall goal complete while a named live acceptance gate remains unresolved.

## Task 8: Native performance and existing preview completion

**Files:** native benchmark harness/tests and `artifacts/performance`; common-document preview native/service/render paths; gallery/recording/profiler artifacts; architecture docs.

**Interfaces:** Benchmarks use the real `IndexRuntime`/SQLite/filesystem worker and contain no personal paths/content in committed evidence. Preview reads remain confined and bounded; document text/spreadsheet rows reuse existing extraction.

- [ ] Run native workloads at 1,000 and 50,000 files and a traversal-cap case; record cold inventory/content completion, warm filename/content p50/p95, edit/delete propagation, cancellation, settled memory/CPU and scan counts.
- [ ] Confirm repeated warm queries perform zero recursive scans; address measured bottlenecks without weakening correctness/security or adding unexplained caches.
- [ ] Add failing meaningful document/spreadsheet preview cases, implement bounded native text/rows and source/page information in existing preview UI, and retain honest unsupported media states.
- [ ] Regenerate gallery, six recordings, browser profile, and native benchmark evidence for final source. Report strict nominal refresh failures faithfully.
- [ ] Commit optimization/preview/evidence changes and update stale README/AGENTS architecture and CI claims.

## Task 9: Whole-branch review and PR publication

**Files:** final evidence/report and PR description; all implementation diff reviewed independently.

- [ ] Generate a whole-branch diff package from base `22ef8113f2cd17687cf56064c43d6991516ef436`; independently review security, correctness, lifecycle, contracts, tests and unverified acceptance.
- [ ] Address actionable review findings, rerun amended gates, and verify clean Git state. Produce a requirement-to-evidence matrix for all nineteen audit findings and every gate in the approved design.
- [ ] Push `codex/complete-app`, create the requested PR using a body file, and attach its URL with `attach_artifact`. Use draft status if any required acceptance is still incomplete; name the exact remaining prerequisite.
- [ ] Inspect hosted checks at the pushed revision. Only mark the goal complete after every requested fix and acceptance gate is proven and the PR is attached; otherwise continue independent work and maintain the progress ledger.
