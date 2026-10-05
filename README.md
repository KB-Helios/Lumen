# Lumen

Lumen is a keyboard-first Windows 11 search and browser-agent experience built with Tauri 2, React 19, TypeScript, Tailwind CSS v4, React Aria Components, and Motion. Its owned EinUI command palette uses OpenAI Apps SDK UI icons within Lumen's semantic glass theme. It combines confined local-file search, local/cloud answers behind AgentGateway, and an explicitly consented Gemini Computer Use mode for browser-only tasks.

![Lumen phase-one visual state gallery](artifacts/screenshots/contact-sheet.png)

## Phase-one product

- Persistent borderless native window with Acrylic, Mica, Blur, and opaque fallbacks.
- Global `Alt+Space` invocation, single-instance redirection, active-monitor placement, and hide-on-close lifecycle.
- Collapsed launcher and expanded search workspace with scopes, filters, stable selection, action bar, virtualized 10,000-result handling, and responsive preview.
- Keyboard-complete search, details, open, containing-folder, settings, onboarding, and dialog flows.
- Eight-scene onboarding and ten settings pages covering appearance, roots, search, local AI, AgentGateway, Computer Use, activity, privacy, and diagnostics.
- Light, dark, opaque, reduced-effects, reduced-motion, and forced-colors/high-contrast presentation.
- Typed local-file search, metadata, preview, and opener commands confined to user-selected roots.
- A supervised Gemini Computer Use sidecar that controls a fresh Microsoft Edge context, pauses model-requested sensitive actions for approval, and stops with Lumen.
- Availability-checked Windows AI, App Content Search, Agent Launchers and current-host Edge AI integrations, with controls in the existing settings pages.
- Development-only 57-scenario visual gallery, screenshot set, contact sheet, six interaction recordings, accessibility/DPI suites, and a strict high-refresh profiler.

The normal Tauri application always uses the real local-file adapter. Deterministic memory data is available only to development tests, recordings, and gallery routes.

The shipped answer path is provider-neutral at the React boundary and routes typed requests through native services. A general provider/model registry, semantic/vector search and reranking, MCP, and other production phase-two services remain explicit follow-up work rather than preview claims.

## Requirements

- Windows 11 with the Microsoft Edge WebView2 Runtime.
- Bun 1.3 or newer.
- Rust stable with the MSVC target.
- Visual Studio 2022 or Build Tools with Desktop development with C++ and the Windows SDK.
- Python 3.11 (directly or through `uv`) when staging the Computer Use sidecar from source; installed applications include the compiled worker.
- .NET 10 SDK when building the Windows AI helper from source; staged helpers include their .NET runtime.

Install dependencies and start the native development app:

```powershell
bun install
bun run stage:sidecars
bun run tauri dev
```

The first run asks for one development search root. Press `Alt+Space` from another application to reopen the warm launcher.

## Windows integrations

Open Settings with `Ctrl+,`. Local AI contains the Windows/Edge enable switches, local answer engine, capability status, explicit preparation, engine test and native access-token setup. Privacy contains separate permissions for downloads, selected-preview text tools, OCR, image descriptions and local microphone dictation, plus language settings. Search controls Lumen's public help catalogue and its optional Windows semantic index. AgentGateway controls installed Windows agents and Lumen's opt-in agent registration. Diagnostics reports the current host, runtime, provider and per-feature availability.

The launcher uses only ready, enabled engines. Automatic local answers prefer a ready Windows model and otherwise use the existing local runtime. An explicitly selected unsupported engine shows an error; cloud answers retain their separate consent. Preview tools run on an explicit press. Local dictation updates the draft and exposes Stop. Windows agent activations fill a browser-task draft that still needs the user's Run action and cloud consent.

The Windows helper is built and verified by `bun run stage:windows-ai`, also included in `stage:sidecars` and release builds. Preview features require their actual Windows runtime, hardware and access prerequisites. Identity-dependent APIs additionally need [the optional signed identity package](packaging/windows/README.md). Aion native preview is ARM64 Snapdragon/QNN only. Edge APIs are detected in the executing browser/WebView2 realm; an installed Edge version does not establish their availability. Availability refresh never downloads models or starts microphone capture.

App Content Search indexes only the shipped public help/action catalogue. Personal file content stays in the confined SQLite index. Preview SDK provenance and distribution terms are recorded in [the helper notices](workers/windows-ai/THIRD_PARTY.md); local preview build evidence does not establish production redistribution rights.

The [Windows and Edge verification report](docs/reports/2026-10-04-windows-ai-integrations.md) records the implemented controls, current host availability, local quality gates and remaining checks on eligible preview hardware.

## Verification and evidence

```powershell
bun run typecheck
bun run lint
bun run test
bun run test:e2e
bun run profile
bun run capture:gallery
bun run record:interactions
bun run tauri build
```

Rust validation runs from `src-tauri` inside a Visual Studio developer shell:

```powershell
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all-features
```

Generated evidence is checked in under `artifacts`:

- `artifacts/screenshots/contact-sheet.png` and `manifest.json`: all 57 deterministic states.
- `artifacts/recordings/manifest.json`: six silent WebM interaction studies.
- `artifacts/performance/profile-summary.json`: machine-readable budgets, measurements, burst guards, browser version, and source SHA.
- `artifacts/performance/interaction-trace.zip`: Playwright trace for the measured interaction run.

The NSIS installer is generated under `src-tauri/target/release/bundle/nsis`. Build outputs are not committed.

## Architecture

- `src/app`: composition, startup, route boundaries, and providers.
- `src/design-system`: semantic tokens, themes, material, icons, type, primitives, and motion.
- `src/features`: launcher, results, preview, onboarding, settings, activity, gateway, local-AI, diagnostics, and gallery surfaces.
- `src/services`: search, answer, Computer Use, Windows AI, Edge AI and settings contracts plus native, browser, deterministic, and unavailable adapters.
- `src/platform`: Tauri/window abstractions.
- `src-tauri/src`: native window lifecycle and confined local-file commands.
- `tests/e2e`: keyboard, accessibility, DPI, visual, responsive, and performance acceptance.
- `docs/architecture`: design, motion, shell, management, and search-service boundaries.
- `docs/reports`: accessibility, DPI, high-refresh, and phase-one validation evidence.

Start with [the Computer Use architecture](docs/architecture/computer-use.md), [the search-service boundary](docs/architecture/search-service.md), and [native shell architecture](docs/architecture/native-shell.md).

## Security and scope boundary

Local search commands canonicalize every root and requested path. Paths outside a selected root are rejected, symlinks are not followed, generated dependency/build directories are skipped, text previews are capped at 64 KiB, image previews at 4 MiB, and binary text is not returned to the webview. The Tauri capability does not grant shell execute or spawn permissions.

The webview cannot launch arbitrary processes, contact Gemini directly, or read provider credentials. Computer Use accepts only a typed task request, approval responses, and cancellation through Rust IPC. The task, visited page URLs, and browser screenshots leave the device only after explicit consent; the Gemini key is read from Windows Credential Manager and passed directly to the fixed worker process.
