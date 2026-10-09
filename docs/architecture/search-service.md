# Search-service boundary

Lumen's React tree depends on one `SearchService` interface. It never imports a Tauri command directly. This keeps the phase-one local adapter replaceable without coupling launcher, preview, keyboard, or settings components to a future index.

```ts
interface SearchService {
  search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResponse>;
  getPreview(fileId: string, signal?: AbortSignal): Promise<FilePreview>;
  openFile(fileId: string): Promise<void>;
  openContainingFolder(fileId: string): Promise<void>;
  subscribeToStatus(listener: (status: SearchStatus) => void): () => void;
}
```

## Runtime adapters

| Adapter | Use | Data source |
| --- | --- | --- |
| `DevelopmentFileSearchService` | Normal Tauri composition and every production build | Typed native filename, FTS, recent, related, and hybrid SQLite search over selected roots |
| `DevelopmentSearchService` | Development-only `?service=memory` acceptance and recordings | Deterministic in-memory results |
| Gallery service | Development-only gallery scenarios | Scenario fixtures |
| `MemorySearchService` | Unit/component tests | Controllable test state |
| `FutureProductionSearchService` | Explicit future boundary | Throws an unavailable error in phase one |

The browser-only preview uses the file adapter without Tauri IPC; deterministic acceptance selects the memory service only when Vite is in development mode and the URL explicitly contains `service=memory`. No production bundle route can select it. The default App waits for settings hydration before mounting search or onboarding. Its file adapter independently checks settings readiness before native admission, queries, preview/open actions and status polling; initial empty defaults cannot revoke persisted roots. A held query becomes actionable when search mounts after hydration. After hydration, unpaused Indexed Roots settings are authoritative, including an empty set. Onboarding persists its selected root into those settings before completion. Cached preview and opener IDs recheck the current grants, and a preview read is checked again before its response is admitted.

## Request flow

1. The uncontrolled search input paints its value immediately and commits query work after that paint.
2. `useSearchController` increments a request sequence, creates an `AbortController`, and calls `SearchService.search`.
3. Only a response with the latest request ID may update groups, results, selection, or lifecycle.
4. Selection is reconciled by stable file ID. Keyboard intent paints imperatively; React and preview work settle afterward.
5. Preview requests are abortable and stale responses cannot replace the current selection.
6. Open and containing-folder actions resolve only IDs returned by the current service instance.

Every Tauri response is parsed with Zod before entering UI state. Invalid payloads become structured recoverable errors.

Normal queries use one native metadata/content inventory. Files without extractable text and folders remain searchable with their stored kind, extension, size, and modification time. Scope and extension/kind filters apply before the result limit. React preserves the native order and bounded rank instead of appending a separately ranked traversal. A revoked root is checked again when pending results arrive.

Filename traversal is an explicitly degraded fallback when the index is unavailable. It receives the same exclusions, hidden-file policy, file-size bound, scope, and extension/kind filters. Native filtering precedes the 10,000 response cap. Malformed fallback payloads reject with `invalid-response` when no root returns a valid contract; partial malformed roots are identified in the degraded status while usable results remain available. The bounded fallback status also counts rejected roots, traversal warnings and truncated roots without exposing rejected error text or warning paths. Recent and Related failures remain errors; they cannot be replaced by ordinary filename results. An empty root configuration still reconciles the native inventory and clears cached admission.

`search_hybrid` returns `{items: HybridHit[], semantic: {phase: 'disabled' | 'ready' | 'degraded', reason: string | null}}`, including empty searches. `search_related` retains its `HybridHit[]` response. The adapter Zod-parses both contracts and preserves native identity, metadata, rank, provenance, and pin state. Typed native snippets populate `match.fragment` for content, OCR, semantic and Related matches, bounded to 1,000 characters; filename display remains unchanged. Semantic embedding or vector lookup failure keeps working filename/content retrieval and reports `degraded` with a fixed sanitized reason; a successful vector lookup reports `ready`, even when it has no matches. Recent and requests without semantic retrieval report `disabled`. Admission under current roots precedes duplicate-path suppression.

## Freshness and worker lifecycle

`synchronize_index_roots` admits canonical root configuration immediately and returns a required Zod-validated `IndexStatus`: `{phase: 'indexing' | 'ready' | 'paused' | 'degraded', generation, pendingItems, indexedItems, queuedEnrichment, skippedItems, message}`. Configuration admission never waits for traversal or extraction. A changed root/policy/cloud grant advances the generation, clears obsolete pending signatures, prunes revoked roots and their native enrichment jobs, and schedules inventory reconciliation. The adapter caches admission rather than completed extraction; ordinary queries read current status and search SQLite. A changed native generation (including index deletion) invalidates the adapter's root signature and causes explicit re-admission. Active status subscriptions poll the typed native status once per second and stop when the final listener unsubscribes; asynchronous completion is visible without another query.

Native ownership is split between a watcher/inventory thread and a content extraction thread. The first inventory pass stores all admitted metadata before extraction starts. Query and answer-context reads do not acquire the extraction commit guard. Rust owns the `notify` 8.2.0 `RecommendedWatcher`, recursive subscriptions, both worker threads, and shutdown. Root changes cancel traversal at directory/entry boundaries; application exit closes admission. The watcher is dropped on worker exit, and runtime teardown joins the owned threads. Already executing bounded synchronous extraction finishes outside the guard and cannot commit after cancellation.

Watcher callbacks ignore read-access events and use nonblocking `try_send` into a 256-event channel. Dirty paths deduplicate into a maximum 1,024-path set with a 150 ms debounce measured from the first event; continuous changes cannot postpone work indefinitely. A full channel, oversized event, watcher error, or `Event::need_rescan()` sets an atomic reconcile flag. Reconciliation uses the same 250,000-record per-root traversal cap, exclusions, hidden-file policy, size bounds, canonical confinement, and symlink refusal as initial inventory. Directory/subtree changes reconcile under those bounds. A 30-second reconciliation interval also repairs missed changes; watcher failures remain visibly degraded. Lumen's own SQLite file and its WAL/SHM/journal are excluded even when an ancestor is selected, preventing self-triggered indexing loops.

Content signatures remain pending while paused. Extraction failures retry with five- and ten-second backoff, then enter a metadata-only failed-signature state after the third attempt. Status remains degraded with a stable skipped-file count; changed metadata or an explicit dirty refresh admits another attempt. This signature state is local to the worker lifecycle. Activity-policy commands apply immediately, and a native one-second activity poll resumes work after observed battery/fullscreen/game restrictions clear. Metadata changes and explicit file dirty events invalidate old chunks, vectors, answer caches, and native enrichment jobs before extraction. A paused changed file remains searchable by inventory metadata while its old body is unavailable to answers. Ordinary directory events reconcile metadata and preserve unchanged extracted content and enrichment, including other roots. File dirty events force extraction even when size and modification time are unchanged; rescan/overflow force a bounded content refresh for the same reason. A failed forced reconciliation retains that obligation and retries after five seconds; a complete successful pass clears it. Ordinary periodic reconciliation uses metadata signatures. Filesystem edits that preserve metadata and deliver no event become detectable when an explicit backend rescan/overflow occurs; this is a remaining metadata-only polling limit.

An incomplete traversal of a still-valid canonical root preserves its existing policy-admitted inventory, pending work and completed signatures until a complete retry observes deletions. Revoked roots, exclusions and invalid or symlink-redirected canonical boundaries still prune immediately. Safety pruning uses an uncapped minimal files inventory with optional schema-4 metadata, independent of search candidate limits; admitted schema-3 files retain pins and history while metadata is backfilled by reconciliation. A single-path deletion selects only matching root/path descendants and never deserializes unrelated inventory. A genuinely vanished file at metadata commit is skipped; database errors, permission errors and safety refusals remain errors.

Each extracted document must pass both root generation and per-file admission-token checks under a short synchronous commit guard. This prevents a revoked root or superseded same-signature edit from writing an old result. Policy and symlink ancestors are revalidated at the commit boundary. Deleting the index clears admitted roots, pending/completed signatures, and generated rows, advances the generation, and detaches old watches; selected roots rebuild only after explicit re-admission from settings or the next search.

Configuration operations in the adapter carry a monotonic operation fence and recheck the current roots and grants after asynchronous status reads, before any native admission. A late read from an older search cannot re-admit its revoked configuration. Status polling publishes the first healthy response after a polling failure, even when its native fields match the last healthy response. Metadata-only reconciliation preserves and processes delivered dirty paths; a simultaneous periodic deadline cannot discard a metadata-preserving edit notification.

All supported root-admission IPCs use the shared `admitIndexRoots` service lane, including search and the native AI service used by settings/onboarding. An already-issued configuration mutation must finish before the next mutation is sent; superseded queued requests are discarded before native invocation, and queued search admissions recheck the entire current root/policy/grant signature. A superseded caller follows the successor's completion separately from the mutation tail, so a skipped admission cannot release a search before the successor is admitted or deadlock its mutation. Search rechecks the current desired policy after an already-issued admission or status read; changed settings must be admitted before querying. The lane copies input policies and cannot be poisoned by a failed admission. Status reads, SQLite queries, inventory and content extraction are outside this lane. A newest configuration can wait for an already-issued configuration admission, but never for inventory/content completion. This is ordering through the supported services in the single main webview, not a native token guarantee for arbitrary parallel IPC clients.

Root validation compares the current canonical root with the immutable canonical boundary captured at admission and rejects symlink ancestors above or within that boundary. It also checks the canonical candidate remains inside it before extraction and at inventory/content commit. Reconciliation prunes an invalidated boundary instead of re-canonicalizing a redirected ancestor into a newly trusted root. Startup lifecycle dispatch is disabled until current roots have been admitted. Native queued enrichment reads filter by current root cloud consent, source policy and queued/current document hash; each job is checked again immediately before its individual dispatch, because an earlier HTTP submission may have awaited while a grant changed.

Individual enrichment submissions return a success/failure result. The lifecycle stops its current dispatch pass after the first paused or failed submission, preserving per-job grant checks without repeating connection timeouts across the entire queued batch. Its next activity observation and retry follow the existing one-second lifecycle interval.

Enrichment integration must capture `IndexRuntime::current_generation()` before asynchronous provider work, validate current root cloud consent and file hash before dispatch, and use `with_current_generation(generation, operation)` to admit its short native result commit. The operation must validate the current file/job hash and root grant and call a database commit helper directly; it must never hold the guard across provider I/O or call another guard-acquiring runtime method. Generation alone does not authorize cloud use. External Rivet job cancellation and hashed artifact/result admission are owned by the enrichment task; native job pruning in this worker does not claim external queue cancellation.

## Native local-file commands

The confined file lane exposes:

- `list_files`
- `search_filenames`
- `get_file_metadata`
- `get_basic_preview`
- `open_file`
- `open_containing_folder`

The durable index lane additionally exposes typed root synchronization, hybrid search, Related/Recent availability, pinning, history controls, index deletion, and native diagnostics. Filename and FTS retrieval remain usable when embeddings, the local model runtime, or `sqlite-vector` are unavailable.

Fallback traversal is blocking filesystem work moved to Tauri's async blocking pool; normal inventory traversal runs only in the owned worker. Traversal is deterministic, case-insensitive for matching, Unicode-preserving, and capped at 250,000 traversed records and 10,000 returned records. Search ranks exact, prefix, substring, then fuzzy subsequence matches.

Generated dependency and build directories are skipped by name: `.git`, `.next`, `.turbo`, `coverage`, `dist`, `node_modules`, `out`, `target`, and `vendor`. Unreadable entries are reported as bounded warnings rather than failing every usable root.

## Confinement and preview safety

- Roots must be absolute, canonical directories.
- Every metadata, preview, and opener path is canonicalized and must remain under its canonical root.
- Symlinks are not followed during traversal or folder preview.
- Visited canonical directories prevent cycles.
- Text/source/Markdown previews read at most 64 KiB and reject NUL-containing or invalid UTF-8 data.
- Raster image previews read at most 4 MiB and use passive data URLs.
- PDF, Office, archive, executable, model, audio, and video previews remain passive metadata states.
- Paths are displayed without the Windows canonical `\\?\` prefix, with extended UNC `\\?\UNC\server\share` normalized to `\\server\share` for display and admission comparisons, while filesystem operations retain canonical paths.
- Openers use Tauri's opener plugin only after confinement succeeds.

## Durable SQLite and vector retrieval

SQLite owns files, chunks, FTS rows, query/file-open history, pins, enrichment jobs, answer cache, and ordinary `vector_embeddings` rows. The checksum-pinned `@sqliteai/sqlite-vector` 1.0.0 DLL is loaded only from Lumen's fixed development or packaged resource path; extension loading is disabled immediately afterward. Vector rows are keyed by model, dimension, content hash, and index revision. A model/dimension change rebuilds only vector rows and preserves lexical data.

Hybrid ranking combines lexical, semantic, recency, and pin signals using bounded candidate sets. `Recent` is backed by durable file-open history. `Related` appears only when the active embedding route has usable vectors. Invalid or missing vector artifacts return a sanitized availability state instead of failing exact filename or FTS search.

Schema version 4 adds a durable `file_inventory` metadata row for every admitted item. Recency uses file modification and actual open-history timestamps, so rebuilding the index does not make old files artificially recent. Metadata queries do not copy stored document text into filename candidates.

## Backend evolution rule

Future index optimizations must preserve request IDs, abort behavior, stable IDs, structured errors, confinement, and the rule that exact local filename and FTS search remain available without AI. UI components should not change merely because the backend implementation evolves.
