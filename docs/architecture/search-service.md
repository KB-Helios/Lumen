# Search-service boundary

Lumen's React tree depends on one `SearchService` interface. It never imports a Tauri command directly. The normal Tauri runtime uses `DevelopmentFileSearchService` with the native SQLite index. `FutureProductionSearchService` remains an explicitly unavailable adapter stub for a future alternative; it does not describe the current native index as a stub.

AI answers consume that admitted index context through a separate typed service. Its attempt, framing, deadline, and ownership rules are documented in [AI answer streaming](answer-service.md).

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

Vector embedding, semantic retrieval, related results and hybrid ranking have implemented native paths. The local embedding route and vector extension must be available, and usable vectors must exist before the host reports semantic or Related search as ready. Semantic retrieval and reranking remain user-controlled options; exact filename and content search continue when the optional route or vector support is unavailable. The separate `FutureProductionSearchService` stub remains unavailable and is not the adapter used by the current native app.

## Freshness and worker lifecycle

The native worker defers inventory and content mutation until a root policy has been successfully admitted. Reopening a saved database does not authorize periodic reconciliation of default empty roots. Periodic deadlines, dirty paths, overflow and forced retry obligations remain outstanding while admission is deferred; cancelled generation work cannot report successful reconciliation. An explicitly admitted empty policy still revokes saved rows immediately, and a paused policy admits metadata while retaining pending content. Native reconciliation and dirty-path commits recheck admission, generation and Stop under the existing synchronization boundary.

Inventory retention and subtree removal stage exact affected file IDs in a connection-private temporary table inside the SQLite transaction. Each batch executes one scoped FTS deletion, then deletes only affected files and vectors, with dependent rows cascading through indexed foreign-key lookups. Empty/no-op batches skip the FTS scan. Commit drops the temporary table; rollback restores rows and removes the staging table. This removes repeated unindexed FTS scans per deleted file without capping safety inventory or changing selected-root admission.

`synchronize_index_roots` admits canonical root configuration immediately and returns a required Zod-validated `IndexStatus`: `{phase: 'indexing' | 'ready' | 'paused' | 'degraded', generation, pendingItems, indexedItems, queuedEnrichment, skippedItems, message}`. Configuration admission never waits for traversal or extraction. A changed root/policy/cloud grant advances the generation, clears obsolete pending signatures, prunes revoked roots and their native enrichment jobs, and schedules inventory reconciliation. The adapter caches admission rather than completed extraction; ordinary queries read current status and search SQLite. A changed native generation (including index deletion) invalidates the adapter's root signature and causes explicit re-admission. Active status subscriptions poll the typed native status once per second and stop when the final listener unsubscribes; asynchronous completion is visible without another query.

Native ownership is split between a watcher/inventory thread and a content extraction thread. The first inventory pass stores all admitted metadata before extraction starts. Query and answer-context reads do not acquire the extraction commit guard. Rust owns the `notify` 8.2.0 `RecommendedWatcher`, recursive subscriptions, both worker threads, and shutdown. Root changes cancel traversal at directory/entry boundaries; application exit closes admission. The watcher is dropped on worker exit, and runtime teardown joins the owned threads. Already executing bounded synchronous extraction finishes outside the guard and cannot commit after cancellation.

Watcher callbacks ignore read-access events and use nonblocking `try_send` into a 256-event channel. Dirty paths deduplicate into a maximum 1,024-path set with a 150 ms debounce measured from the first event; continuous changes cannot postpone work indefinitely. A full channel, oversized event, watcher error, or `Event::need_rescan()` sets an atomic reconcile flag. Reconciliation uses the same 250,000 accepted-record per-root traversal cap (including directories), exclusions, hidden-file policy, size bounds, canonical confinement, and symlink refusal as initial inventory. Directory/subtree changes reconcile under those bounds. A 30-second reconciliation interval measured after the last completed attempt also repairs missed changes; failed dirty-path work retains a five-second retry obligation. Traversal truncation reports incomplete inventory separately from watcher failure, so a later complete scan can clear only the incomplete state. Lumen's own SQLite file and its WAL/SHM/journal are excluded even when an ancestor is selected, preventing self-triggered indexing loops.

Content work selects the first due path from an ordered pending index. The worker attempts at most eight documents between its existing 25 ms rests and checks activity, inventory and Stop before every attempt; extraction and commit retain their admission, signature and generation fences. The pending queue maintains its retry-entry count across insertion, replacement, retry, removal, pruning and clearing, so publishing status after each content commit does not scan every remaining job. Unchanged inventory metadata returns from a read-only transaction after comparing current metadata and stored root/path/name. Explicit watcher dirty events still invalidate content even when size and modification time match. Per-file FTS replacement uses rowid lookups only after verifying each chunk's link, retaining the file-ID fallback for older unaligned rows. Derived vector dimension reset replaces its table in one transaction, preserving the previous table when interrupted.

Content signatures remain pending while paused. Extraction failures retry with five- and ten-second backoff, then enter a metadata-only failed-signature state after the third attempt. Status remains degraded with a stable skipped-file count; changed metadata or an explicit dirty refresh admits another attempt. This signature state is local to the worker lifecycle. Activity-policy commands apply immediately, and a native one-second activity poll resumes work after observed battery/fullscreen/game restrictions clear. Metadata changes and explicit file dirty events invalidate old chunks, vectors, answer caches, and native enrichment jobs before extraction. A paused changed file remains searchable by inventory metadata while its old body is unavailable to answers. Ordinary directory events reconcile metadata and preserve unchanged extracted content and enrichment, including other roots. File dirty events force extraction even when size and modification time are unchanged; rescan/overflow force a bounded content refresh for the same reason. A failed forced reconciliation retains that obligation and retries after five seconds; a complete successful pass clears it. Ordinary periodic reconciliation uses metadata signatures. Filesystem edits that preserve metadata and deliver no event become detectable when an explicit backend rescan/overflow occurs; this is a remaining metadata-only polling limit.

An incomplete traversal of a still-valid canonical root preserves its existing policy-admitted inventory, pending work and completed signatures until a complete retry observes deletions. Revoked roots, exclusions and invalid or symlink-redirected canonical boundaries still prune immediately. Safety pruning uses an uncapped minimal files inventory with optional schema-4 metadata, independent of search candidate limits; admitted schema-3 files retain pins and history while metadata is backfilled by reconciliation. A single-path deletion selects only matching root/path descendants and never deserializes unrelated inventory. A genuinely vanished file at metadata commit is skipped; database errors, permission errors and safety refusals remain errors.

Each extracted document must pass both root generation and per-file admission-token checks under a short synchronous commit guard. This prevents a revoked root or superseded same-signature edit from writing an old result. Policy and symlink ancestors are revalidated at the commit boundary. Deleting the index clears admitted roots, pending/completed signatures, and generated rows, advances the generation, and detaches old watches; selected roots rebuild only after explicit re-admission from settings or the next search.

Configuration operations in the adapter carry a monotonic operation fence and recheck the current roots and grants after asynchronous status reads, before any native admission. A late read from an older search cannot re-admit its revoked configuration. Status polling publishes the first healthy response after a polling failure, even when its native fields match the last healthy response. Metadata-only reconciliation preserves and processes delivered dirty paths; a simultaneous periodic deadline cannot discard a metadata-preserving edit notification.

All supported root-admission IPCs use the shared `admitIndexRoots` service lane, including search and the native AI service used by settings/onboarding. An already-issued configuration mutation must finish before the next mutation is sent; superseded queued requests are discarded before native invocation, and queued search admissions recheck the entire current root/policy/grant signature. A superseded caller follows the successor's completion separately from the mutation tail, so a skipped admission cannot release a search before the successor is admitted or deadlock its mutation. Search rechecks the current desired policy after an already-issued admission or status read; changed settings must be admitted before querying. The lane copies input policies and cannot be poisoned by a failed admission. Status reads, SQLite queries, inventory and content extraction are outside this lane. A newest configuration can wait for an already-issued configuration admission, but never for inventory/content completion. This is ordering through the supported services in the single main webview, not a native token guarantee for arbitrary parallel IPC clients.

Root validation compares the current canonical root with the immutable canonical boundary captured at admission and rejects symlink ancestors above or within that boundary. It also checks the canonical candidate remains inside it before extraction and at inventory/content commit. Reconciliation prunes an invalidated boundary instead of re-canonicalizing a redirected ancestor into a newly trusted root. Startup lifecycle dispatch is disabled until current roots have been admitted. Native queued enrichment reads filter by current root cloud consent, source policy and queued/current document hash; each job is checked again immediately before its individual dispatch, because an earlier HTTP submission may have awaited while a grant changed.

Individual enrichment submissions return a success/failure result. The lifecycle stops its current dispatch pass after the first paused or failed submission, preserving per-job grant checks without repeating connection timeouts across the entire queued batch. Its next activity observation and retry follow the existing one-second lifecycle interval.

The native enrichment consumer captures `IndexRuntime::current_generation()` before asynchronous provider work, revalidates root consent/source policy/hash before dispatch, and uses the short current-generation guard for transactional artifact/chunk/FTS/job completion. It checks source bytes again at commit and never holds the guard across provider I/O. Generation alone does not authorize cloud use. The credential-free Rivet queue leases one job for 30 seconds with a monotonically increasing lease generation, heartbeat, fenced completion, expiry recovery and three attempts with five-/ten-second backoff. Pause, cancellation and budget deferral release the lease without consuming an attempt. Current native jobs bound external queue retention; exhausted jobs expose degraded status while retaining searchable metadata.

Fixed OpenAI transport supports scanned PDF and PNG/JPEG/WebP/GIF OCR through the configured vision alias on AgentGateway Responses, and FLAC/MP3/MP4/M4A/OGG/WAV/WebM transcription through the native fixed OpenAI endpoint and configured audio model. Uploads are bounded to 20 MiB, with raster images bounded to 4 MiB and returned text to 64 KiB. Unsupported provider routes or formats fail explicitly. Searchable local HTTP/SQL fixtures cover these contracts; normal unpatched Rivet startup and compiled-worker recovery remain separate production acceptance requirements.

`GatewaySupervisor` owns one durable SQLite enrichment ledger shared by embeddings, improvement model calls and OCR/transcription: 10 requests per minute and 500,000 tokens per 24 hours, alongside existing gateway metering. Each dispatch reserves tokens before I/O and amends the reservation with validated provider usage. Bounded text reserves UTF-8 bytes plus output/protocol overhead; multimodal requests reserve the remaining daily allowance because compressed file cost has no reliable local token ceiling. Actual usage may exceed an estimate: debt blocks further dispatch until refill. Missing usage or cancellation after dispatch blocks the window, including across restart; proven unsent cancellation refunds admission. This preserves estimate/amend behavior, not a strict physical token or billing ceiling. Budget deferrals retain queued work without burning retries.

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
- PDF, DOCX and PPTX previews may show the first current indexed text excerpt (at most 64 KiB), rendered as escaped text. Selection never parses a PDF or starts OCR/provider work. Missing, stale, legacy-version or metadata-only content retains an explicit passive unavailable state. See the [2026-10-15 bounded document-preview report](../reports/2026-10-15-bounded-document-previews.md) for the source milestone, verification scope and remaining parser limits.
- Cached excerpts require an admitted local root and current policy, original-path symlink/reparse refusal, canonical confinement, matching current source SHA-256, generation/Stop and indexed hash/revision checks before delivery. Preview privacy is checked before work and again before delivery. These are freshness fences, not an atomic snapshot against concurrent future writes. Local previews do not require cloud consent.
- Extraction version `lumen-extract-v2` parses Office/PDF from the same bounded captured buffer that is hashed. Older versions cannot supply preview text; ordinary root admission in a fresh worker re-extracts them while preserving stable IDs, pins and history. Existing background PDF parsing still has its previous expanded-stream/output limitations; the 64 MiB source cap does not establish an expanded-PDF memory bound.
- XLSX previews decode only `xl/worksheets/sheet1.xml`, labelled by that filename, in A1:L40 (40 rows, 12 columns). Shared and inline rich strings, sparse cell coordinates, numeric/boolean/error/date and formula cached values are passive strings. Formulas are never evaluated; external relationships, links, macros and other sheets are not followed. A missing supported sheet or invalid/over-budget data has an unavailable state.
- The shared Office reader enforces actual aggregate decompressed XML bytes as well as declared sizes (16 MiB). XLSX preview bodies, including column labels, must fit the aggregate 64 KiB UTF-8 budget. Native DTO and public Zod contracts enforce the same 40-by-12 and body limits. Text truncation metadata/notice stays outside the retained text body, preserving its full valid prefix.
- Legacy Office/OpenDocument, archive, executable, model, audio, and video previews retain their existing passive metadata behavior.
- Paths are displayed without the Windows canonical `\\?\` prefix, with extended UNC `\\?\UNC\server\share` normalized to `\\server\share` for display and admission comparisons, while filesystem operations retain canonical paths.
- Openers use Tauri's opener plugin only after confinement succeeds.

## Durable SQLite and vector retrieval

SQLite owns files, chunks, FTS rows, query/file-open history, pins, enrichment jobs, answer cache, and ordinary `vector_embeddings` rows. The checksum-pinned `@sqliteai/sqlite-vector` 1.0.0 DLL is loaded only from Lumen's fixed development or packaged resource path; extension loading is disabled immediately afterward. Vector rows are keyed by model, dimension, content hash, and index revision. A model/dimension change rebuilds only vector rows and preserves lexical data.

Hybrid ranking combines lexical, semantic, recency, and pin signals using bounded candidate sets. `Recent` is backed by durable file-open history. `Related` appears only when the active embedding route has usable vectors. Invalid or missing vector artifacts return a sanitized availability state instead of failing exact filename or FTS search.

Schema version 4 adds a durable `file_inventory` metadata row for every admitted item. Recency uses file modification and actual open-history timestamps, so rebuilding the index does not make old files artificially recent. Metadata queries do not copy stored document text into filename candidates.

## Backend evolution rule

Future index optimizations must preserve request IDs, abort behavior, stable IDs, structured errors, confinement, and the rule that exact local filename and FTS search remain available without AI. UI components should not change merely because the backend implementation evolves.
