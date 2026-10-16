# Management surfaces

Lumen's first-run and settings experiences are part of the same native React surface as the launcher. They use Tailwind CSS-first semantic tokens, material primitives, the motion provider, and React Aria controls; no web-only settings shell or second component library is involved.

## Ownership

- `src/features/onboarding` owns the four-step first-run flow: Welcome, Indexed folder, Shortcut, and Answer choices; folder selection, keyboard progression, and durable completion state.
- `src/features/settings/SettingsShell.tsx` owns the bounded navigation rail across eleven settings pages, independently scrolling page region, page routing, and focus restoration.
- `src/features/settings/pages` owns General, Appearance, Indexed roots, Search, Local AI, AgentGateway, Computer Use, Providers, Activity, Privacy, and Diagnostics.
- `src/features/settings/pages/ProvidersPage.tsx` owns saved profiles for five fixed tools: exclusive Claude/Codex/Gemini switching and additive OpenCode/OpenClaw enablement. Add/Edit saves a profile; explicit Switch/Enable applies it through the typed `ProvidersService`. Authorization (OAuth through the cliproxy sidecar, boolean link status only) and Usage (request counts) remain separate. Unsupported presets are unavailable. Native-unavailable browser state finishes checking with an unavailable result.
- `src/state/appearance.store.ts` owns live theme, transparency, density, preview, effects, and motion preferences.
- `src/features/settings/settings.store.ts` owns management preferences and the last active settings page.
- Feature stores own presentation state. Native activity, provider routes, MCP permissions, local runtime provisioning, privacy, index data, and diagnostic truth remain authoritative in Rust.

React Aria Components provides the tabs, switches, selects, sliders, dialogs, focus semantics, collection roles, and focus restoration. Those controls are styled directly with Lumen primitives rather than wrapped by a second interaction abstraction. Overlay portals are mounted inside the themed application root so confirmation dialogs inherit the active appearance.

## Native management boundaries

Local AI provisions one closed, checksum-pinned Lemonade/Qwen/Nomic profile. AgentGateway exposes a native provider/model registry, typed routes, MCP service registry and permissioned tools through native services; credentials stay in Windows Credential Manager. The registry and MCP implementation do not imply that a provider, route, MCP service, credential, consent, or live endpoint is available on every host. React never supplies an executable path, arbitrary process argument, model download URL, provider SDK, or secret-bearing diagnostic field.

Provider profile metadata is atomically stored in native application data. API-key input crosses the typed native command once; returned profiles contain metadata and active/enabled flags, never the key. Rust stores keys in UUID slots under `com.bridgehammer.lumen.tool-profiles`, separate from gateway credentials, and resolves them for activation. A blank Edit key retains the existing credential. Rust validates fixed target enums, bounded single-line fields and absolute HTTP(S) base URLs; the UI cannot supply configuration paths. Existing fixed-path writers preserve unrelated fields and retain journal, backup, rollback and recovery behavior. Saving a profile does not activate it, and linked OAuth does not substitute for a required API key.

Live activation journals the configuration and a bounded native ownership snapshot together under `~/.lumen/profile-ownership`. Exclusive tools retain only a hash of their applied connection fields; external connection edits disable removal, while saved profile edits retain ownership of the previous live activation. Additive tools retain prior values and applied fields in a private, credential-bearing snapshot that never enters React or diagnostics. Removal restores only unchanged managed fields and preserves later user changes; reactivation removes the previous owned model before merging the edited one. An older additive activation without an ownership snapshot cannot be removed automatically: reactivation records the existing node as user-owned. Older exclusive activations require an exact live match before removal. The Codex preset uses `https://api.openai.com/v1`; OpenClaw writes `baseUrl` and `apiKey` as documented.

Onboarding awaits durable completion, root persistence and native admission before leaving the flow; a failed save retains choices and permits retry. Folder pickers and native mutations reject duplicate actions and report cancellation/failure. Indexed-root status distinguishes admitted work from completed indexing; typed observations and revision fences prevent stale success from restoring Ready. Observation/polling ownership ends on cleanup. Shared confirmations stay open on failed asynchronous work and close only after success. Appearance and settings persistence failures share a recoverable notice without rolling back newer choices.

Rejected native root removal restores the saved settings within the persistence queue before reporting failure. If that restoration also fails, memory reflects the committed disk removal and reports the combined failure. Cancelling the diagnostic save picker dismisses its confirmation normally. The root glass-intensity variable is applied only after settings hydration.

Selected-result actions track the latest ID, provenance, pin state and supported kind while selection attributes update synchronously. Answer copying reports pending/success/failure and fences stale completions. Native credential, gateway and provisioning operations retain ownership across page changes and reject obsolete completions; Start cannot overwrite a newer Cancel. These presentation safeguards do not replace Rust admission, consent or independent Stop.

Local runtime preference application can fail while answer startup owns admission. App and Local AI settings share ownership of the latest result, catch rejected application promises, and show fixed safe guidance in the existing Local AI callout. Retry reapplies the saved mode and warm preference. Preferences remain persisted; the notice and application identity are transient. Stale and unmounted operations cannot overwrite a newer result.

Windows integrations add sections to these existing pages through `src/features/windows-ai`, backed by the typed `WindowsAiService`. The helper targets stable Windows App SDK/runtime 2.5.1. Local AI owns host enablement, answer engine, readiness, explicit model preparation/test and access setup. Search owns the public App Content Search catalogue controls, but index/search operations remain blocked until Microsoft issues the separate feature ID, token and attestation. Native Aion has no verified stable redistributable contract and is unavailable on every architecture; Aion and experimental AI speech artifacts are excluded. AgentGateway owns installed-agent discovery and verified Lumen registration. Privacy owns independent download, text/image/microphone permissions and languages. Diagnostics combines actual native and executing-host Edge capability checks. Privileged defaults are off; native persistence and consent checks remain authoritative, and failed writes do not change UI policy.

Rust owns one fixed hidden Windows AI helper and its Job Object, request/deadline/output bounds, cancellation, selected-root image/text reads, native credential storage and optional package identity. Edge provider globals stay inside the browser adapter, with ready-only sessions, local speech enforcement, cleanup and no cloud fallback. The public AppContentIndexer catalogue contains only shipped non-sensitive help/actions; file results retain the separate confined SQLite path. Its allowlisted results navigate to settings rather than entering filesystem open/pin actions. Agent URI activations create drafts after hydration and never bypass Computer Use consent or Run.

Activity classification observes only hashed executable identity, fullscreen/video state, and power state needed to enforce indexing policy. Indexed-root edits persist before native synchronization. History clearing and index deletion operate on durable SQLite data and preserve selected roots and source files. Destructive actions require confirmation.

Diagnostics Refresh requests one typed native snapshot covering index/vector, activity, AgentGateway, MCP, local runtime, provisioning, and provider-route counts. Export combines it with bounded frontend timing samples, sanitizes again in Rust, and uses a native save dialog. Prompts, contents, raw errors/logs, credentials, authorization values, runtime directories, and drive/UNC paths are excluded.

## Keyboard and focus

- `Ctrl+,` opens Settings from the launcher.
- Arrow keys move through the vertical settings tabs; `Enter` activates a page.
- `Escape` closes Settings and restores focus to the launcher search field.
- Onboarding exposes a single primary action per scene, supports `Enter`, and provides Back and `Escape` where navigation is reversible.
- Confirmation dialogs trap focus and return it to their trigger when dismissed.

## Appearance and accessibility

The application root selects one complete Tailwind CSS semantic color/material theme at a time: light, dark, light opaque, dark opaque, or forced high contrast. This avoids partial theme contracts resetting one another. One System/Full/Reduced motion preference drives the shared provider and CSS policy; the former synchronize-reduced-motion switch is removed. Glass intensity scales only decorative material layers, with 72 preserving the original appearance; opaque, reduced-effects and forced-colors rules take precedence. Foreground text opacity remains unchanged. Typography uses `rem` tokens so Windows/browser text scaling reaches management content.

The navigation rail wraps labels and scrolls vertically independently from the page panel, including at 200 percent text size. Named settings-content container queries stack label/control rows below 32rem. Fields, routes, credential actions, and popovers stay bounded by that content region; stable pixel gutters leave space for enlarged text. Navigation immediately exposes one accessible active panel, gives it a short entrance, and resets its scroll position while preserving navigation focus.

Onboarding keeps its header and primary actions anchored around an independently scrolling scene region. Scene changes reset scrolling and retain the existing directional transition and completion behavior. Computer Use follows the same bounded content and wrapping action rules, preserving every approval, denial, and cancellation action.

## Diagnostics sampling

Diagnostics uses bounded buffers populated by User Timing, `PerformanceObserver` long-task samples when supported, and the React Profiler callback. It does not run a permanent per-frame React render loop. The `Ctrl+Shift+D` overlay is an inspection surface only and can be closed without changing launcher focus or search state.

Packaged acceptance uses `LUMEN_PACKAGED_SMOKE=1` only inside the isolated installer smoke script. The installed application runs exact sqlite-vector retrieval, disabled-vector lexical fallback, show/hide lifecycle, and sanitized report generation against temporary app data, then exits. Normal launches never enter this path.
