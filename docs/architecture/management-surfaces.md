# Management surfaces

Lumen's first-run and settings experiences are part of the same native React surface as the launcher. They use Tailwind CSS-first semantic tokens, material primitives, the motion provider, and React Aria controls; no web-only settings shell or second component library is involved.

## Ownership

- `src/features/onboarding` owns the eight first-run scenes, folder selection, keyboard progression, and completion state.
- `src/features/settings/SettingsShell.tsx` owns the bounded navigation rail, independently scrolling page region, page routing, and focus restoration.
- `src/features/settings/pages` owns General, Appearance, Indexed roots, Search, Local AI, AgentGateway, Computer Use, Providers, Activity, Privacy, and Diagnostics.
- `src/features/settings/pages/ProvidersPage.tsx` owns the Providers page: the Switch/Additive provider list, the Authorization center (OAuth sign-in through the cliproxy sidecar, boolean link status only), and the Usage panel (per-provider request counts). Provider truth stays in Rust (`src-tauri/src/provider_switcher`): the `cliproxy-sidecar` lifecycle, the loopback `/v8/management` client, and the atomic file-switch engine. Secrets never reach the webview.
- `src/state/appearance.store.ts` owns live theme, transparency, density, preview, effects, and motion preferences.
- `src/features/settings/settings.store.ts` owns management preferences and the last active settings page.
- Feature stores own presentation state. Native activity, provider routes, MCP permissions, local runtime provisioning, privacy, index data, and diagnostic truth remain authoritative in Rust.

React Aria Components provides the tabs, switches, selects, sliders, dialogs, focus semantics, collection roles, and focus restoration. Those controls are styled directly with Lumen primitives rather than wrapped by a second interaction abstraction. Overlay portals are mounted inside the themed application root so confirmation dialogs inherit the active appearance.

## Native management boundaries

Local AI provisions one closed, checksum-pinned Lemonade/Qwen/Nomic profile. AgentGateway health, provider credentials, typed routes, MCP permissions, and route tests use native services; credentials stay in Windows Credential Manager. React never supplies an executable path, arbitrary process argument, model download URL, provider SDK, or secret-bearing diagnostic field.

Local runtime preference application can fail while answer startup owns admission. App and Local AI settings share ownership of the latest result, catch rejected application promises, and show fixed safe guidance in the existing Local AI callout. Retry reapplies the saved mode and warm preference. Preferences remain persisted; the notice and application identity are transient. Stale and unmounted operations cannot overwrite a newer result.

Windows integrations add sections to these existing pages through `src/features/windows-ai`, backed by the typed `WindowsAiService`. Local AI owns host enablement, answer engine, readiness, explicit model preparation/test and access setup. Search owns public app-content opt-in, rebuild and deletion. AgentGateway owns installed-agent discovery and verified Lumen registration. Privacy owns independent download, text/image/microphone permissions and languages. Diagnostics combines actual native and executing-host Edge capability checks. Privileged defaults are off; native persistence and consent checks remain authoritative, and failed writes do not change UI policy.

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

The application root selects one complete Tailwind CSS semantic color/material theme at a time: light, dark, light opaque, dark opaque, or forced high contrast. This avoids partial theme contracts resetting one another. Reduced motion is enforced by the motion provider and a CSS duration override; reduced effects remove decorative noise and lower blur. Typography uses `rem` tokens so Windows/browser text scaling reaches management content.

The navigation rail wraps labels and scrolls vertically independently from the page panel, including at 200 percent text size. Named settings-content container queries stack label/control rows below 32rem. Fields, routes, credential actions, and popovers stay bounded by that content region; stable pixel gutters leave space for enlarged text. Navigation immediately exposes one accessible active panel, gives it a short entrance, and resets its scroll position while preserving navigation focus.

Onboarding keeps its header and primary actions anchored around an independently scrolling scene region. Scene changes reset scrolling and retain the existing directional transition and completion behavior. Computer Use follows the same bounded content and wrapping action rules, preserving every approval, denial, and cancellation action.

## Diagnostics sampling

Diagnostics uses bounded buffers populated by User Timing, `PerformanceObserver` long-task samples when supported, and the React Profiler callback. It does not run a permanent per-frame React render loop. The `Ctrl+Shift+D` overlay is an inspection surface only and can be closed without changing launcher focus or search state.

Packaged acceptance uses `LUMEN_PACKAGED_SMOKE=1` only inside the isolated installer smoke script. The installed application runs exact sqlite-vector retrieval, disabled-vector lexical fallback, show/hide lifecycle, and sanitized report generation against temporary app data, then exits. Normal launches never enter this path.
