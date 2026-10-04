# Windows AI integrations for Lumen

Date: 2026-10-04

Status: The user approved previews with availability checks and the native bridge plus detected Edge API approach. This written specification is awaiting user review before implementation.

## Outcome

Lumen gains Windows agent discovery and invocation, optional registration of its browser agent, native on-device answers and text/image tools, semantic search over its public app content, and supported Edge on-device language and speech tools. Users control engines, downloads, registration, and permissions through the existing settings and launcher. Every capability reports its actual availability. Ordinary local-file search continues to work independently.

## Decisions and alternatives

The approved approach retains Tauri and adds one supervised native Windows AI bridge plus feature-detected Edge web adapters. A direct Rust WinRT projection would avoid a managed bridge but require maintaining projections for experimental Windows App SDK and Aion metadata. An Edge-only implementation would be smaller but would not provide Windows App Actions or App Content Search. The native bridge concentrates these dependencies behind a versioned protocol while preserving Lumen's established service boundaries.

The integration is divided into independently verifiable slices: capability/control foundation, native inference and tools, agent integration and identity, app content indexing, and Edge tools. They share the same capability and preference contracts; completion requires all slices and the applicable acceptance checks below.

## Research constraints

Documentation was checked through Context7 and the Microsoft sources on 2026-10-04. Context7 returned Windows App SDK samples and packaging guidance; its Edge query had no matching documentation and its Aion result described an unrelated product, so the linked Microsoft documentation and sample are the authority for those features.

| Capability | Verified constraint | Consequence for Lumen |
| --- | --- | --- |
| Windows agent launchers | Agent definitions reference an App Action. Registration requires package identity; discovery uses ODR and invocation uses Windows AI Actions. | Supply action/agent manifests and optional identity packaging. Probe discovery and invocation separately. |
| Windows AI | Hardware, model readiness, and API access vary by feature. Phi Silica currently requires a Limited Access Feature token; Microsoft documents a transition to Aion. | Probe each API; provide an access-required state and secure token setup. Never infer availability from a processor name. |
| NPU acceleration | Windows ML handles execution-provider discovery. A Copilot+ label does not establish that any particular model is usable. | Report certified/ready providers and API readiness. Do not promise an NPU/CPU/GPU selector for system models. |
| App Content Search | Experimental, package identity required, and intended for non-sensitive application content. | Index only Lumen's shipped public help/action catalogue. Keep personal-file indexing in confined SQLite search. |
| Edge AI | Prompt/writing previews, translation/detection, and local speech have different browser/channel requirements. The documentation does not establish WebView2 support. | Detect the APIs in the executing host. Show unavailable with setup guidance when absent; do not equate installed Edge with WebView2 support. |
| Native Aion preview | Currently ARM64 Snapdragon/QNN only, certified ready NPU provider required, no CPU fallback. Both packaged and unpackaged integration paths exist. | Compile the ARM64 adapter and show unsupported hardware on x64. Treat Edge's Aion model as a separate backend with its own requirements. |

Local inspection found Windows 11 Pro build 26300, an x64 AMD Ryzen AI 9 HX 370, .NET 10 SDKs, and Windows App Runtimes 1.8 and 2. ODR was absent from command lookup. These are development observations, not capability acceptance results; the new bridge must produce its own live probes.

## Architecture and ownership

### Typed services

Add a `src/services/windows-ai` boundary with Zod schemas, an interface, a Tauri adapter, and explicit unavailable/development adapters. It owns capability refresh, persisted preferences, feature preparation, local text/image requests, app-content queries, and agent operations. Components consume these methods and typed snapshots; they do not import Windows SDKs, invoke Tauri commands directly, launch processes, or choose download URLs.

Add an Edge adapter under `src/services` for browser-provided AI. Only this adapter inspects browser globals or uses the web APIs. Its availability belongs to the current web host; native and Edge capability snapshots are combined in the service layer. Development fixtures are restricted to the existing DEV modes and cannot mark production features ready.

A capability snapshot includes feature ID, execution host, availability, enabled preference, observed model/provider identity when supplied by the API, and a bounded reason code/message. Availability distinguishes ready, downloadable, preparing, unsupported hardware, missing API/runtime/identity, access required, disabled by policy, and failed. Unknown enum values and invalid payloads fail closed into a recoverable state.

Preferences are versioned and hydrated before use. Backend consent and native enablement are authoritative in Rust, including revalidation immediately before every privileged operation. Requested enablement and operational readiness remain distinct, so a removed model does not retain a misleading ready badge.

### Native bridge

Place a UI-free Windows helper under `workers/windows-ai`. Use a current supported .NET target and explicit, pinned Windows App SDK/CsWinRT references. The Aion projection is included in the ARM64 build using a checksum-pinned official SDK release; x64 produces a truthful unsupported Aion state without requiring the ARM64 model.

Rust owns the fixed helper executable, packaged/development resource selection, hidden process creation, Job Object lifetime, request IDs, deadlines, input/output limits, and cancellation. A closed JSON-lines protocol permits only capability probes, consented preparation, inference/tools, public-content indexing, agent operations, and cancellation. No arbitrary executable, command line, package family, model URL, script, or filesystem path is accepted from React.

Use one helper process with serialized model operations and a bounded request queue. Refreshing capability status does not load large models or download anything. Reuse sessions for compatible requests and dispose them after bounded idle time; honor the existing keep-local-warm setting. Cancellation, crash, protocol failure, and app exit release operations and descendants. Late events are ignored by request ID.

Windows-owned models and execution providers are prepared through their supported readiness mechanisms. Preparation is a separate user action after storage/network disclosure; passive refresh, opening Settings, typing, and auto routing cannot initiate downloads. Show real progress when supplied, otherwise show an indeterminate preparing state. Distinguish cancellation of Lumen's wait from system-owned downloads that may continue through Windows Update.

### Native inference and tools

Extend the existing `AnswerService` flow with local engine policy: Automatic, existing local runtime, Windows AI, native Aion preview, or Edge AI. Automatic selects a ready enabled Windows engine and then the existing local runtime; Edge requires explicit selection. Aion is selected explicitly during its preview. A missing explicitly selected engine produces an actionable error instead of silently changing engines or sending content elsewhere.

Retain Local/Auto/Cloud routing and the existing cloud-answer consent boundary. Windows and Edge engines are local classifications. Cloud remains possible only under the existing mode and recorded consent policy. No new provider is classified as cloud simply because it is different from the existing `local` enum value.

Native answers reuse Rust's bounded retrieval context and verified file citations. Edge general answers use the submitted prompt; Edge file tools receive only the bounded preview selected by the user through the typed service. Never invent file citations or expose an unrestricted file-reading method to Edge.

Expose summarize and rewrite for bounded selected text, plus OCR and image descriptions for selected confined images. Rust resolves an indexed file ID, repeats root/symlink checks, enforces the current text/image preview limits, and checks the relevant privacy switch before dispatch. Results appear in the existing preview/answer region and do not modify source files. Each engine advertises the specific supported tools; a text-only engine cannot be used for image descriptions.

Text inputs have an explicit finite budget derived from the selected model's context and Lumen's 64 KiB preview ceiling. Oversized input reports a clear limit. Aion context exhaustion returns a restart/new-request affordance; streaming appends newly emitted tokens and checks the terminal result status.

Image/video editing and LoRA training are outside this search-and-launcher integration. Their presence in the Windows AI API catalogue does not add a separate editor or training product.

### Agent launchers and package identity

Discover registered agents through ODR from a Windows-owned executable location, with a timeout and capped output. Validate the returned metadata and cache the identifiers in Rust. Invoke only an agent from the current native catalogue, resolving its package/action pair through Windows AI Actions. Selecting an external agent and submitting a prompt is explicit; disclose that the receiving agent controls its own processing/privacy. Do not attach local files in this first integration.

Register Lumen's browser agent using action and agent JSON manifests. Required `agentName` and `prompt` text inputs open the visible Agent interface. URI activation validates the scheme/action, agent identity, percent-decoding, duplicates, and existing 4,000-character task limit. Cold and warm launches queue the validated draft until hydration is complete and consume it once. Receiving an activation never automatically starts Gemini, grants cloud consent, or bypasses a safety approval.

Add an optional sparse MSIX identity package alongside the existing NSIS distribution, including App Action/agent declarations and the exact system AI capability required by the selected SDK. The native helper must also operate with the required package identity; verify this in a running process rather than assuming that child processes inherit it.

Identity assets have a documented publisher/signing configuration and build validation. Development registration is an explicit script; production packages use the release signing chain. Do not silently enable Developer Mode, install a trusted certificate, change Windows registry feature flags, or run upstream bootstrap scripts. If a trusted signed identity package is absent, the UI reports setup required and the affected controls remain unavailable. Identity setup/removal and Lumen agent registration/removal affect only Lumen's own package.

Registration is opt-in. Report registered only after re-querying Windows and finding the expected package/action/agent tuple. A preference toggle or successful manifest build is insufficient evidence.

### App Content Search

Create one named app-managed index for a versioned, shipped public catalogue of Lumen help and actions. Entries have stable IDs mapping to allowed settings navigation, help, and existing launcher actions. They contain no paths, personal files, prompt history, conversation output, or secrets.

Index with AppContentIndexer, query its semantic/lexical results, and resolve returned IDs through the current catalogue. Unknown/stale IDs are dropped. Index work runs off the UI thread, observes activity/battery policy, and releases index handles when idle. The index is reconciled when catalogue version changes, and users can rebuild or delete it independently of their file index.

Present an App content result group and optional scope through the existing search boundary. Model non-file results explicitly; never pass app-content IDs to `open_file`. Selection and opening dispatch to the typed app-action method. Queries remain abortable, preserve stable selection, and reject stale responses. A delayed or unavailable Windows index cannot delay filename/SQLite results; the public catalogue has a local lexical fallback.

### Edge tools

Probe Prompt, Summarizer, Writer, Rewriter, LanguageDetector, Translator, and local SpeechRecognition separately. Check secure-context/API presence and the exact request's availability (including language pair). The model selected internally by Edge is reported only when exposed; Lumen cannot promise or force an Aion model through an undocumented option.

Downloads/session creation requiring user activation start directly from the user's action, after the relevant consent is already recorded. Monitor available progress; cancel through AbortSignal where supported and destroy sessions/readers on completion or abandonment. Streaming adapters normalize each API's actual chunk semantics rather than assuming all streams are deltas.

Translation and language detection operate on explicit user text or the selected bounded text preview. Source/target languages are validated and availability is checked per pair. Writing assistance shares the existing text-tool controls.

Dictation requires a separate microphone opt-in and a visible start/stop control in the launcher. Use only verified local recognition with `processLocally` and the requested language pack. An API with cloud-only speech support is unavailable for this feature. Capture stops on navigation, close/hide, cancellation, and error; results update the draft and never submit a search/agent task automatically.

## UI controls

Use existing semantic tokens, React Aria controls, settings components, focus restoration, and motion behavior. Keep the navigation structure and add focused sections to its current pages.

| Surface | Controls and behavior |
| --- | --- |
| Local AI | Local engine selector; per-engine availability/reason; Refresh; Prepare/download with confirmation; Stop preparation when supported; test a fixed harmless prompt; existing keep-warm control. Limited-access token entry/status uses native secure storage and never reads a token back to React. |
| AgentGateway | Windows agents section with refresh, discovered agents, explicit invocation, and Lumen registration status/toggle. Separate identity/runtime setup guidance from gateway provider state. |
| Search | App content search enablement, index status, rebuild/delete controls, and app-content scope. Personal-file roots remain configured through the existing Indexed roots page. |
| Privacy | Windows text/image tool enablement, model-download consent, Edge language-tool enablement, and microphone opt-in. Existing OCR/image-analysis switches gate native image operations. Revocation cancels active relevant operations. |
| Launcher and preview | Explicit text/image tool actions, translation language choices, local dictation start/stop, app-content results, and external-agent selection with a submit action. Busy/error states remain keyboard accessible and cancellable. |
| Diagnostics | Sanitized capability states, runtime/package versions, readiness, operation timing, and bounded failure codes. Exclude prompts, contents, agent payloads, raw process output, credentials, and paths. |

Unavailable features explain the observed requirement and offer relevant setup documentation. Disabled controls cannot mutate operational state. First-run onboarding is not expanded; opt-in setup happens where each feature is controlled.

## Verification and completion

Use meaningful regression tests for consent, request bounds, cancellation, routing, stale events, and native payload parsing. Exercise the new controls through Edge Playwright with deterministic DEV adapters; those results establish UI behavior, not native feature availability.

| Acceptance lane | Required evidence |
| --- | --- |
| Native bridge | Compile/publish supported architectures; real capability probe on this Windows host; bounded protocol/error tests; cancellation and descendant cleanup. Missing runtime/access/identity produces typed states. |
| Local answers/tools | A real streamed response/tool result on supported hardware when prerequisites are present, terminal result checking, cancellation, and root/preview confinement. Unsupported Aion on x64 must be verified explicitly. |
| Agent integration | Manifest validation; malformed activation tests; cold/warm one-time draft delivery; live ODR registration/discovery/invocation on an identity-enabled host when ODR is available. |
| App content | Versioned catalogue reconciliation; live add/query/delete on an identity-enabled supported preview; stale/unknown ID rejection; lexical fallback and no personal content submission. |
| Edge | API-absent host and mocked contract tests; real detected APIs in an eligible Edge host when available; language-pair/download/session checks; speech stays local and stops cleanly. |
| UX | Keyboard/focus and unavailable/setup/preparing/ready/error states; accessible labels; settings at 200 percent text scale; regression coverage for existing file search and Computer Use. |

Run the repository's required verification order: `bun run typecheck`, `bun run lint`, `bun run test`, `bun run test:e2e`, and `bun run tauri build`. Run Rust format, clippy with warnings denied, and all-feature tests for the native changes. Regenerate gallery screenshots, interaction recordings, and performance evidence after the UI changes.

Document exactly which native and Edge acceptance lanes ran, the observed host/prerequisites, and which could not execute because Microsoft access, hardware, trusted signing, or optional OS/browser features are unavailable. A local build or deterministic fixture never establishes activation on a user's installed Windows system. The integration may support an unavailable capability correctly, but its live inference/registration must be labeled unverified until actually exercised.

## Sources

- [Agent Launchers overview](https://learn.microsoft.com/en-us/windows/ai/agent-launchers/) and [registration, discovery, and invocation](https://learn.microsoft.com/en-us/windows/ai/agent-launchers/agents-get-started).
- [Windows AI API catalogue](https://learn.microsoft.com/en-us/windows/ai/apis/), [setup and capabilities](https://learn.microsoft.com/en-us/windows/ai/apis/get-started), and [Phi Silica access/readiness and Aion transition](https://learn.microsoft.com/en-us/windows/ai/apis/phi-silica).
- [Copilot+ NPU and Windows ML guidance](https://learn.microsoft.com/en-us/windows/ai/npu-devices/).
- [App Content Search constraints](https://learn.microsoft.com/en-us/windows/ai/apis/app-content-search) and [AppContentIndexer integration](https://learn.microsoft.com/en-us/windows/ai/apis/app-content-search-tutorial).
- [Edge's June 2026 on-device AI announcement](https://blogs.windows.com/msedgedev/2026/06/02/expanding-on-device-ai-in-microsoft-edge-new-models-and-apis-for-the-web/), [Prompt API](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/prompt-api), [writing assistance](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/writing-assistance-apis), [language detection](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/languagedetector-api), [translation](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/translator-api), and [local speech](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/speech-recognition-api).
- [Microsoft Aion Instruct Preview sample, prerequisites, and unpackaged integration](https://github.com/microsoft/Aion-Instruct-Preview-Sample/).
- [Windows App SDK native unpackaged sample](https://github.com/microsoft/WindowsAppSDK-Samples/tree/main/Samples/WindowsAIFoundry/cpp-console-sparse).

## Review

Self-review checked scope, service/backend ownership, package identity, conditional support, download/microphone/cloud consent, source-file confinement, routing fallback, and the distinction between fixture/build evidence and live activation. Implementation begins after the user reviews this written specification.
