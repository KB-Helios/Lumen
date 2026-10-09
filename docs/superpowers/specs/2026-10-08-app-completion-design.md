# Lumen app completion

## Approved scope

The user approved the audited fixes and requested a pull request in this order: security, search correctness, feature completion, release readiness, and optimization. This work completes those existing flows in the current architecture. A missing external prerequisite is recorded as incomplete acceptance, never replaced with a simulated success.

## Native authority and privacy

Saved Indexed Roots are the authority after settings hydration. Empty and paused root sets remain empty; onboarding adds its selected root through the existing completion action. Opening an old result rechecks the current root grants. Root revocation also removes native inventory, queued enrichment, and cached result admission, including while background indexing is paused.

Provider keys and management secrets stay in Rust and the sidecar. Management responses crossing IPC use explicit allowlists: provider counts, safe connection metadata, and link status. Configuration, usage map keys, credential contents, and raw upstream errors are never returned wholesale. Initial proxy configuration uses independently generated private keys, loopback binding, and no control-panel downloads.

## One search inventory

Rust/SQLite own filename inventory, extracted content, filters, rankings, and root policies. Ordinary queries read this inventory instead of traversing the filesystem. Every allowed item type, including folders and files without extractable text, has metadata inventory. Native ranking is the displayed ranking, with stable identity and provenance preserved. A content/index error reports a recoverable failure or a genuinely available degraded fallback.

Root configuration is reconciled independently of queries. A native background worker performs the initial inventory/extraction and debounced incremental updates, with a bounded change queue and full reconciliation after overflow. It never follows symlinks or generated directories. Activity pause stops content work, resume retries it, and changing roots or deleting the index invalidates pending generations. Returning indexing/paused status does not count as completed extraction.

## Completed existing features

Answer attempts have explicit boundaries; fallback clears partial text and usage while retaining source grounding. Native requests enforce connection/response deadlines and cancellation before headers as well as during the stream. The event parser buffers bytes and accepts standard LF/CRLF framing, optional spaces, multiline data, and split Unicode.

Providers uses the existing dialogs and settings page. Native saved-provider metadata contains no returned keys. Add, edit, switch, and removal use registered typed commands, atomic existing tool-file writers, and backups. No live user tool configuration is changed by tests: they use isolated homes.

Enrichment has a real job consumer: lease, revalidate file hash/root/consent, call the fixed native vision/audio route, commit bounded chunks/artifact and job completion atomically, then acknowledge the queue generation. Revoked, stale, interrupted, and failed jobs cannot publish text. Repair the Windows Rivet engine startup rather than calling a queue-only implementation complete. Prime remains off until real Docker/ACP, recovery, isolation, improved/degraded candidate, and rollback acceptance pass.

## Release and evidence

Required sidecars use exact immutable releases and committed expected SHA-256 values. Stage CLIProxyAPI as a native-test prerequisite because the build script requires it even for security tests. Missing assets and checksum failures stop staging. Signed release validation verifies actual Authenticode status; absence of owner signing material is an external prerequisite, not permission to claim a signed release. Installation acceptance uses isolated data and verifies upgrade/uninstall behavior and owned-process cleanup.

Real native search benchmarks record source revision, host, workload size, cold indexing, warm-query p50/p95, edit/delete propagation, cancellation, and settled resource usage. Existing browser gallery, recordings, and profiler remain a separate evidence class; strict refresh-rate failures are retained. Full local gates and independent task/final reviews precede PR publication, and hosted status is reported independently.

## Acceptance

- Stored-key fixtures cannot appear in any serialized webview DTO or error.
- Pausing/removing the last root produces no search, preview, or open admission for that root.
- Filters/exclusions, pins/recency/reranking, stale edits/deletes, paused/resumed indexing, and index failures have behavioral regressions through production code.
- Provider flows, fallback/Stop/event parsing, and enrichment completion execute through their actual native boundaries and isolated fixtures.
- A clean checkout stages every mandatory resource and creates an installer; signed release and actual installation evidence are verified separately.
- Actual Rivet recovery, Docker/Prime isolation/evaluation/rollback, supported Computer Use, configured live providers, and eligible Windows AI acceptance remain explicit gates.
- Native queries stop performing recursive traversal; realistic filesystem benchmarks and regenerated UI evidence cover the final source.
