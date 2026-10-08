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

The browser-only preview uses the file adapter without Tauri IPC; deterministic acceptance selects the memory service only when Vite is in development mode and the URL explicitly contains `service=memory`. No production bundle route can select it. After hydration, unpaused Indexed Roots settings are authoritative, including an empty set. Onboarding persists its selected root into those settings before completion. Cached preview and opener IDs recheck the current grants, and a preview read is checked again before its response is admitted.

## Request flow

1. The uncontrolled search input paints its value immediately and commits query work after that paint.
2. `useSearchController` increments a request sequence, creates an `AbortController`, and calls `SearchService.search`.
3. Only a response with the latest request ID may update groups, results, selection, or lifecycle.
4. Selection is reconciled by stable file ID. Keyboard intent paints imperatively; React and preview work settle afterward.
5. Preview requests are abortable and stale responses cannot replace the current selection.
6. Open and containing-folder actions resolve only IDs returned by the current service instance.

Every Tauri response is parsed with Zod before entering UI state. Invalid payloads become structured recoverable errors.

Normal queries use one native metadata/content inventory. Files without extractable text and folders remain searchable with their stored kind, extension, size, and modification time. Scope and extension/kind filters apply before the result limit. React preserves the native order and bounded rank instead of appending a separately ranked traversal. A revoked root is checked again when pending results arrive.

Filename traversal is an explicitly degraded fallback when the index is unavailable. It receives the same exclusions, hidden-file policy, and file-size bound. Recent and Related failures remain errors; they cannot be replaced by ordinary filename results. An empty root configuration still reconciles the native inventory and clears cached admission.

## Native local-file commands

The confined file lane exposes:

- `list_files`
- `search_filenames`
- `get_file_metadata`
- `get_basic_preview`
- `open_file`
- `open_containing_folder`

The durable index lane additionally exposes typed root synchronization, hybrid search, Related/Recent availability, pinning, history controls, index deletion, and native diagnostics. Filename and FTS retrieval remain usable when embeddings, the local model runtime, or `sqlite-vector` are unavailable.

Traversal is blocking filesystem work moved to Tauri's async blocking pool. It is deterministic, case-insensitive for matching, Unicode-preserving, and capped at 250,000 traversed records and 10,000 returned records. Search ranks exact, prefix, substring, then fuzzy subsequence matches.

Generated dependency and build directories are skipped by name: `.git`, `.next`, `.turbo`, `coverage`, `dist`, `node_modules`, `out`, `target`, and `vendor`. Unreadable entries are reported as bounded warnings rather than failing every usable root.

## Confinement and preview safety

- Roots must be absolute, canonical directories.
- Every metadata, preview, and opener path is canonicalized and must remain under its canonical root.
- Symlinks are not followed during traversal or folder preview.
- Visited canonical directories prevent cycles.
- Text/source/Markdown previews read at most 64 KiB and reject NUL-containing or invalid UTF-8 data.
- Raster image previews read at most 4 MiB and use passive data URLs.
- PDF, Office, archive, executable, model, audio, and video previews remain passive metadata states.
- Paths are displayed without the Windows canonical `\\?\` prefix, while filesystem operations retain canonical paths.
- Openers use Tauri's opener plugin only after confinement succeeds.

## Durable SQLite and vector retrieval

SQLite owns files, chunks, FTS rows, query/file-open history, pins, enrichment jobs, answer cache, and ordinary `vector_embeddings` rows. The checksum-pinned `@sqliteai/sqlite-vector` 1.0.0 DLL is loaded only from Lumen's fixed development or packaged resource path; extension loading is disabled immediately afterward. Vector rows are keyed by model, dimension, content hash, and index revision. A model/dimension change rebuilds only vector rows and preserves lexical data.

Hybrid ranking combines lexical, semantic, recency, and pin signals using bounded candidate sets. `Recent` is backed by durable file-open history. `Related` appears only when the active embedding route has usable vectors. Invalid or missing vector artifacts return a sanitized availability state instead of failing exact filename or FTS search.

Schema version 4 adds a durable `file_inventory` metadata row for every admitted item. Recency uses file modification and actual open-history timestamps, so rebuilding the index does not make old files artificially recent. Metadata queries do not copy stored document text into filename candidates.

## Backend evolution rule

Future index optimizations must preserve request IDs, abort behavior, stable IDs, structured errors, confinement, and the rule that exact local filename and FTS search remain available without AI. UI components should not change merely because the backend implementation evolves.
