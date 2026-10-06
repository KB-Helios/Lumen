# Lumen

Keyboard-first Windows 11 search and Computer Use launcher. Tauri 2 + React 19 + TypeScript + Tailwind CSS v4 + React Aria Components + Motion, with an owned EinUI command palette and OpenAI Apps SDK UI icons. The current runtime includes confined local-file search, durable SQLite content indexing, supervised AgentGateway/local-runtime processes, typed native local/cloud answer routing, and separately consented browser and selected-window Computer Use. The provider/model registry, semantic/vector search and reranking, MCP, and other production phase-two services remain deferred. New backend capability must go behind the existing typed contracts (`src/services`), never into UI components.

## Environment

- Windows 11 only: requires WebView2 Runtime, Bun 1.3+, Rust stable (MSVC), and VS 2022 / Build Tools with C++ + Windows SDK. Staging Computer Use also needs a healthy Python 3.11 runtime (the script prefers `uv`; `LUMEN_PYTHON` can select another interpreter).
- Use `bun` for everything (bun.lock is the lockfile); do not use npm/yarn.
- No CI exists in this repo — verification is local, using the commands below.

## Commands

```powershell
bun install
bun run stage:sidecars # checksum-pinned native workers, including Computer Use
bun run tauri dev        # native app (beforeDevCommand runs vite on port 1420)
bun run dev              # browser-only vite, strict port 1420 (no Tauri commands available)
```

Verification order — run all of these before considering work done:

```powershell
bun run typecheck        # tsc --noEmit
bun run lint             # eslint --max-warnings 0: warnings FAIL the run
bun run test             # vitest run (unit/component, colocated src/**/*.test.ts(x))
bun run test:e2e         # playwright
bun run tauri build      # full release build when touching src-tauri
```

Focused runs:

- Single unit test: `bun run test -- src/state/appearance.store.test.ts` (add `-t "name"` to filter inside).
- Single e2e: `bun run test:e2e -- tests/e2e/foundation-shell.spec.ts` (add `-g "name"`).
- Rust (from `src-tauri`, in a Visual Studio developer shell): `cargo fmt --all -- --check`, `cargo clippy --all-targets --all-features -- -D warnings`, `cargo test --all-features`.

## Testing gotchas

- Playwright is serial (`workers: 1`, no retries) and uses the installed Edge via `channel: 'msedge'` — do not switch to a downloaded chromium.
- Playwright auto-starts `bun run dev` on `127.0.0.1:1420` and **reuses an already-running server** (`reuseExistingServer`). A stale dev server serving old code will silently affect e2e results.
- Vitest compiles Tailwind CSS v4 through the shared Vite plugin; jsdom + `@testing-library/jest-dom` setup is in `src/test/setup.ts`. Mocks restore automatically (`restoreMocks: true`).

## Dev-only URL modes (browser/e2e, gated by `import.meta.env.DEV`)

The plain browser has no Tauri IPC, so deterministic states are reached via query params (wired in `src/app/App.tsx`):

- `?service=memory` — deterministic in-memory search data; also bypasses onboarding. Used by e2e, recordings, profiler.
- `?gallery=1&scenario=<id>[&theme=...]` — 53-state visual gallery (see `artifacts/screenshots/manifest.json` for IDs).
- `?mode=foundation` — shell preview; `Ctrl+Shift+L` cycles dark/light/opaque.
- `?onboarding=1` / `?onboarded=1` — force or bypass onboarding.

## Architecture (what actually matters)

- `src/app` — composition root (`App.tsx`), providers, route/dev-mode branching.
- `src/design-system` — Tailwind CSS v4 semantic variables in `global.css`, themes, materials, motion, icons, and primitives. Product styling uses semantic Tailwind utilities; the EinUI palette is owned vendored source, and `LumenUiIcon` bridges OpenAI Apps SDK UI icons.
- `src/features` — launcher, results, preview, onboarding, settings, activity, gateway, local-AI, diagnostics, gallery.
- `src/services/search` — the key boundary: UI only knows the `SearchService` interface and never imports Tauri commands directly. Adapters: `DevelopmentFileSearchService` (default, real Tauri commands), `DevelopmentSearchService` (`?service=memory`), `MemorySearchService` (unit tests), `FutureProductionSearchService` (throws — the phase-two seam). Every native payload is Zod-parsed before entering UI state.
- `src/services/computer-use` — typed Computer Use health, targets, stream, approval, and Stop boundary. Rust owns provider requests, input admission, exact target identity, the fixed local executor and Job Object; React receives only Zod-parsed progress events. Neither provider key reaches React or the executor. See `docs/architecture/computer-use.md` and its protocol/UI contracts.
- `src/state` + feature `*.store.ts` — zustand stores. Persistence uses the Tauri Store plugin when `window.__TAURI_INTERNALS__` exists, else `localStorage`. Persisted stores must be `hydrate()`d before their state is read (see `App.tsx`).
- `src/platform` — Tauri/window abstractions.
- `src-tauri/src` — `lib.rs` (plugins, Alt+Space global shortcut, single-instance, close-to-hide), `window.rs` (owns the window-mode geometry table and native material), `search/` (confined local-file commands).

## Hard constraints (do not break)

- Security: Rust search commands canonicalize all paths, reject paths outside selected roots, never follow symlinks, skip `.git`/`node_modules`/`dist`/`target`/etc., and cap previews (64 KiB text, 4 MiB images). `src-tauri/capabilities/main.json` is least-privilege — the shell plugin is deliberately absent; do not add execute/spawn permissions.
- Computer Use controls only a fresh Edge context or an explicitly selected, revalidated non-elevated Windows window. Existing browser cloud consent does not grant desktop control or desktop cloud observation consent; both desktop grants default off. Rust owns fixed Gemini/OpenAI provider requests and a credential-free staged/source executor. Background mode never escalates to foreground; Fast requires a snapshot-scoped one-time approval. Ctrl+Alt+Esc closes native admission and kills the Job Object independently of stdin/action locks; Alt+Space shows Lumen. Retain HTTP(S) checks, 4,000 task characters, 60 provider turns and 60 input actions. Do not add webview provider calls, arbitrary scripts/process arguments, existing-profile attachment or shell permissions.
- The window is borderless/transparent with Acrylic→Mica→Blur fallback; close hides rather than destroys. Window sizes/constraints per mode are owned by Rust (`window.rs`), not the frontend.
- Vite port 1420 is `strictPort` — it must be free for dev/e2e.
- tsconfig has `noUnusedLocals`/`noUnusedParameters` — dead variables fail typecheck.
- Commit style is Conventional Commits (`feat:`, `test:`, `perf:`, `docs:`, ...), lowercase, no scope.

## Checked-in evidence

`artifacts/` is committed and expected to be regenerated after UI/perf changes:

- `bun run capture:gallery` → `artifacts/screenshots/` (53 states + contact sheet + manifest)
- `bun run record:interactions` → `artifacts/recordings/` (6 WebM studies + manifest)
- `bun run profile` → `artifacts/performance/profile-summary.json` (240 Hz frame budgets, driven via the dev-only `window.__LUMEN_DIAGNOSTICS__`)

All three auto-start a dev server if none is running. Build outputs under `src-tauri/target/release/bundle` are not committed.

## Docs

Authoritative deep-dives live in `docs/architecture/` (search-service, native-shell, design-system, motion-system, management-surfaces) and phase-one evidence in `docs/reports/`. Read `docs/architecture/search-service.md` before touching search, preview, or result-selection code.
