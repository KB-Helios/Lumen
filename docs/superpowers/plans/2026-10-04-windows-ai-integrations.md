# Windows AI Integrations Implementation Plan

> **For agentic workers:** Use test-driven-development for the service and security boundaries. Use dispatching-parallel-agents for the disjoint Windows helper, Rust supervisor, and Edge adapter domains after the shared contracts exist. The primary agent integrates the UI and reviews all changes before the full quality gate.

**Goal:** Implement the approved native bridge and detected Edge APIs, Windows agent launchers, public app content indexing, and existing-surface feature controls.

**Architecture:** A fixed Windows helper exposes a closed JSON-lines protocol supervised by Rust. Typed/Zod-parsed services join native and current-host Edge capabilities; the existing launcher and settings consume these services. Package identity and preview prerequisites produce truthful availability states.

**Tech Stack:** Tauri 2, Rust, Windows App SDK/WinRT, a UI-free .NET Windows helper, React 19, TypeScript, Zod, React Aria, Bun, Vitest, and installed Edge Playwright.

## Global constraints

- Follow `docs/superpowers/specs/2026-10-04-windows-ai-integrations-design.md`; the human approved the native bridge and detected Edge API direction. Proceed under that existing authorization.
- Work in the existing `codex/windows-ai-integrations` worktree. Preserve the existing NSIS distribution, transparent close-to-hide window, least-privilege capability, and port 1420.
- Use Bun and prefix shell commands with RTK. No shell-plugin permissions or generic executable/path/provider-download arguments from React.
- Native consent and preferences are rechecked at operation time. Passive probes do not download or load a model. Microphone, cloud, and model download opt-ins remain separate.
- File tools resolve native indexed IDs and preserve root confinement, symlink rejection, 64 KiB text/4 MiB image limits. Public app content never includes personal files, history, or prompts.
- Keep all new APIs behind `src/services`; every incoming native payload/event is Zod-parsed. Unknown states fail closed.
- Native Aion is ARM64-only in the current pinned preview; Edge Aion is a distinct backend. Report actual API/provider readiness rather than inferring it from a hardware name.
- Signing assets, package installation, access tokens, and browser flags are not fabricated or changed silently. Unavailable external prerequisites are documented with actual probe evidence.

## Task 1: Shared contracts and baseline repair

**Files:** Create `src/services/windows-ai/windows-ai.types.ts`, `windows-ai-service.ts`, `catalogue.json`, `windows-ai.types.test.ts`; modify `src/design-system/animations/ActivityIndicator.test.tsx`; create `workers/windows-ai/protocol.md`.

**Interfaces:** The schemas and service interface define all names and shapes used by subsequent tasks. The native helper protocol uses `{id, operation, payload}` input and `{id, type, data|text|phase|progress|code|message}` output; `type` is `result`, `delta`, `progress`, or `error`. Request IDs are bounded ASCII identifiers. Only native code constructs helper payloads.

- [x] Write schema regressions for invalid readiness enums, unknown feature IDs, oversize text, and a ready snapshot without enabling preferences; run the focused test and observe the missing boundary.
- [x] Implement discriminated availability/event/request schemas and a `WindowsAiService` contract for status/preferences, preparation, text/image tools, public content search/index maintenance, agent invocation/registration, token setup, cancellation, and pending activation.
- [x] Provide a versioned public catalogue with stable settings/help IDs and explicit allowed page destinations.
- [x] Restore the baseline mock with `animation.setSubframe.mockReset()` in `beforeEach`; rerun the entire ActivityIndicator file that was proven order-dependent during preflight.
- [x] Commit the shared boundary and passing focused tests.

## Task 2: Native Windows helper

**Files:** Own `workers/windows-ai/**` except `protocol.md`, and `scripts/stage-windows-ai.ts`. No Rust/frontend edits in this independent task.

**Consumes:** `windows-ai.types.ts`, `catalogue.json`, and `protocol.md`. **Produces:** A published `lumen-windows-ai.exe` with required adjacent libraries staged under `src-tauri/binaries/windows-ai`; protocol operations `status`, `prepare`, `text`, `image`, `indexSync`, `indexSearch`, `indexDelete`, `agents`, `invokeAgent`, `registerAgent`, `unregisterAgent`, `shutdown`, `cancel`.

- [x] Fetch/pin actual Microsoft SDK packages and sample source; preserve licenses/provenance. Build x64 and ARM64 profiles. Aion's SDK release is `v1.0.0.0`; validate GitHub-provided SHA-256 digests before consumption.
- [x] Exercise malformed input, bounds, readiness without downloads, unavailable identity/API/runtime, and cancellation through a console self-test or dedicated helper tests before adding each operation.
- [x] Implement current Windows AI language generation/summarize/rewrite, OCR/image description, WinML provider probes, public AppContentIndexer indexing/search/delete, ODR agent discovery/registration, Windows AI Actions invocation, and the native ARM64 Aion adapter. Use actual API result statuses and newly emitted token semantics.
- [x] Use .NET cancellation and bounded serialization; no secret/raw exception output. Check package identity for identity-dependent operations. Restricted Phi Silica access is a configured native token, never a made-up entitlement.
- [x] Stage/publish the helper through Bun, verify a real `status` response on this host and typed unsupported Aion, and retain build/probe evidence.

## Task 3: Rust supervisor, identity, and answer/file safety

**Files:** Own new `src-tauri/src/windows_ai/**`, its registration in `lib.rs`, required `Cargo.toml` features, `build.rs`, `tauri.conf.json`, and `packaging/windows/**`. Do not edit frontend/C# sources.

**Consumes:** Task 1 schemas/protocol/catalogue and the helper resource layout. **Produces:** Tauri commands named by the TypeScript native adapter, a hidden fixed-resource Job Object supervisor, authoritative preferences, validated pending activations, optional sparse identity/action assets, and bounded tool/agent operations.

- [x] Add meaningful native tests first for request/consent validation, malformed activation, stale/unknown agent/catalogue IDs, decoded size caps, and persisted preference revocation.
- [x] Supervise the fixed helper with hidden process creation, a capped request queue, deadlines, finite line/output limits, one active model operation, cancellation, and kill-on-close cleanup. Runtime status is derived from probe results.
- [x] Persist validated preferences atomically under app data. Recheck native enablement/download/image/agent consent immediately before dispatch. Native access tokens use Windows Credential Manager and are not returned or logged.
- [x] Resolve image/text file IDs through the existing confined search runtime. For native answers, build the existing bounded local context and return only verified citations. No arbitrary paths from React reach the helper.
- [x] Add manifests/action definitions and build/sign/register scripts for an optional sparse identity package. Both Lumen and helper manifests identify their correct package application. Registration is opt-in and verified by a fresh Windows catalogue query.
- [x] Validate `lumen:` activation against the browser-agent identity and existing 4,000-character cap; queue cold/warm drafts once; emit a typed wakeup and consume after hydration. Never auto-run cloud Computer Use.
- [x] Run Rust format/clippy/tests and exercise a real helper probe. Record genuinely missing identity/access/ODR requirements.

## Task 4: Edge adapter

**Files:** Own `src/services/edge-ai/**` only. Consume Task 1 contracts; no UI/native changes.

**Produces:** An injectable `EdgeAiService` that probes Prompt/Summarizer/Writer/Rewriter/Detector/Translator/local SpeechRecognition, prepares approved language models, runs typed text requests, streams normalized deltas, and handles local dictation cleanup.

- [x] Write tests with realistic browser API fakes for missing APIs, availability/download requiring an explicit preparation action, invalid/oversize inputs, abort/destroy, cumulative stream chunks, unsupported language pairs, and cloud-only speech rejection.
- [x] Probe the executing host and secure-context/API presence. Do not claim WebView2 support from installed Edge. Session creation occurs from the user action when model data is already ready; preparation is separate and requires recorded consent.
- [x] Enforce local speech through `processLocally`, availability/install methods, requested language, explicit microphone permission, visible stop, and disposal. Transcripts only update the draft.
- [x] Run focused Vitest/typecheck; report which APIs the real current Edge/browser host exposes without toggling flags or downloading models.

## Task 5: Composition, controls, and launcher integration

**Files:** Own TypeScript native/browser/composed adapters under `src/services/windows-ai`, routed answer/search adapters, `src/features/windows-ai/**`, `src/app/App.tsx`, settings page sections, and the required launcher/preview/search result changes. Integrate Task 2 staging into `package.json`/`scripts/stage-sidecars.ts`.

- [x] Test observable UI/service behavior before implementation: persisted controls reject failed writes; refresh never downloads; unsupported engines cannot start; cancellation/revocation cleans active work; catalogue results open the allowlisted settings page rather than a filesystem action.
- [x] Compose authoritative native preferences with current-host Edge readiness; DEV fixtures only through explicit dev parameters. Add the local engine selector and fixed-prompt test/preparation controls to Local AI, Windows agents to AgentGateway, App content controls to Search, privacy/download/microphone controls to Privacy, and sanitized status to Diagnostics.
- [x] Add explicit bounded text/image tools in existing preview/answer surfaces, local dictation start/stop in the launcher, and Windows agent choice in Agent mode. Capture errors in accessible status text and preserve keyboard focus.
- [x] Route native Windows/Aion and explicitly selected Edge answers through `AnswerService`; preserve cloud mode/consent and file citation truth. Auto local engine uses a ready enabled Windows model then the existing runtime; unsupported explicitly selected engines fail visibly.
- [x] Add typed non-file App content results, an optional scope, stable selection, aborted/stale query protection, native semantic results plus public lexical fallback, and allowlisted navigation.
- [x] Add gallery states and an Edge e2e covering settings controls, unsupported/preparing/ready/error states, catalogue navigation, and user-action-only starts.

## Task 6: Integration review and evidence

- [x] Review the complete branch for spec coverage, native trust boundaries, process/stream cleanup, identity routing, and unsupported state accuracy. Resolve material findings before claiming completion.
- [x] Run in order: `bun run typecheck`, `bun run lint`, `bun run test`, `bun run test:e2e`, `bun run tauri build`. Include Rust fmt/clippy/all-feature tests for native code.
- [x] Regenerate `bun run capture:gallery`, `bun run record:interactions`, and `bun run profile`; inspect the rendered feature controls and verify performance budgets.
- [x] Document actual helper/Edge readiness, supported live operations exercised, package-signing/access/hardware prerequisites, and conditional acceptance lanes. Build/fixture evidence is never reported as live native activation.
- [x] Mark the goal complete only after requirement-by-requirement verification proves the integrated functionality and applicable acceptance gates. Otherwise preserve the remaining work explicitly.

## Progress ledger

- Task 1: complete; shared schemas/protocol/catalogue and baseline mock repair committed as 1f0fb4b. Focused tests passed. Patch default retention regression was additionally fixed during UI verification.
- Task 2: complete; x64 and ARM64 publication passed, with nine core checks in both lanes and eight executable protocol checks on x64. The actual x64 probe reports missing preview runtime/identity and unsupported native Aion. ARM64 execution remains conditional on target hardware.
- Task 3: complete; supervisor, native boundaries, activation and optional identity assets implemented. Final formatting/clippy passed; all-feature Rust tests passed 99 with four ignored, plus the separately run real helper probe. Optional unsigned MSIX build and manifest validation passed. Common Controls v6 was restored after a packaged startup regression; the rebuilt installer passed the installed smoke.
- Task 4: complete; 46 focused tests passed and passive installed Edge detection recorded without downloads/session/microphone activation. WebView2 and eligible-host inference are conditional lanes, accurately unavailable until exposed by the executing host.
- Task 5: complete; composition, existing-page controls, preview tools, agents, dictation and public search integrated. Full frontend suite passed 360 tests and installed Edge e2e passed 39, including the two new controls tests. All four new gallery states were rendered and inspected.
- Task 6: complete for the approved availability-checked preview scope. Material review findings were resolved; all required local quality gates and final installed smoke passed. The 57-state gallery, six recordings and profile were regenerated. The cadence-aware release gate passed; strict 240 Hz paint bounds did not. Live inference, identity-dependent indexing/agents, ARM64 execution and preview redistribution clearance remain explicitly conditional in `docs/reports/2026-10-04-windows-ai-integrations.md`.
