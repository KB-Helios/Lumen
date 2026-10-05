# Windows and Edge AI integration verification

Implemented and verified locally on 2026-10-04 in `codex/windows-ai-integrations`, under the approved native bridge plus detected Edge API design. Preview capabilities are included with actual availability checks. The existing Tauri application and NSIS installer remain the distribution path; identity-dependent integrations have an optional sparse package.

The results below describe the initial 2026-10-04 verification. The checked-in smoke, gallery, recordings and profile were subsequently refreshed for the [2026-10-05 PR review fixes](2026-10-05-windows-ai-review-fixes.md); that report records their current measurements and installer hash.

## Feature coverage and controls

| Integration | Implemented behavior | User controls |
| --- | --- | --- |
| Windows AI | Native streamed answers, summarization, rewriting/writing, OCR and image descriptions through pinned Windows App SDK projections. Rust validates consent, requests, confined file context and citations. | Local AI: enablement, engine, capability refresh, explicit preparation, cancellable fixed-prompt test and secure access-token setup. Privacy: separate text/OCR/image/download permissions. Preview: explicit tools with cancellable read-only output. |
| NPU readiness | Windows ML execution-provider discovery reports actual certification/readiness. Model capability checks determine usability independently of the processor brand. | Diagnostics: runtime, package identity, providers and per-feature availability. |
| Native Aion | Checksum-pinned official ARM64 SDK, framework dependency, certified ready QNN provider, bounded text sessions and terminal-status checking. Fresh helper requests can use an installed model without a prior process-local preparation cache. | Explicit Aion engine selection and preparation. Unsupported x64 hardware is reported accurately. |
| Agent Launchers and App Actions | Windows-owned ODR discovery, validated package/action invocation, verified opt-in Lumen registration/removal and fixed browser-agent activation assets. Incoming activations create reviewed drafts and never start Computer Use. | AgentGateway: discovery and registration. Agent launcher mode: explicit external-agent choice and Run, with recipient disclosure. |
| App Content Search | One versioned index containing ten shipped public help/action items. Preparation, rebuild, delete and semantic search use AppContentIndexer. Trusted catalogue IDs map only to allowed settings pages. Fast lexical help results remain available without waiting for a Windows model. | Search: catalogue opt-in, index state, preparation/rebuild/delete. Launcher: App content scope and help results. |
| Edge AI | Current-realm Prompt, Summarizer, Writer, Rewriter, LanguageDetector, Translator and local SpeechRecognition detection. Exact language availability, user-activated preparation, bounded requests, streaming, cancellation and session destruction. | Local AI: Edge enablement and explicit engine selection. Privacy: language settings, download and microphone opt-ins. Preview: text/language tools. Launcher: local dictation Start/Stop that updates the draft. |

All new operations are behind typed services. Native IPC and helper payloads are validated. Privileged preferences default to false and remain authoritative in Rust; changing languages preserves existing permission values. Revocation, cancellation, navigation and native hide events dispose relevant work. Passive refresh does not create model sessions, download models or start microphone capture. Early cancellation survives helper startup, and a helper that does not acknowledge cancellation is terminated through its owned Job Object. Model work is serialized and bounded; keep-warm is opt-in.

The optional identity package declares fixed main/helper identities, the exact preview framework dependency and `systemAIModels`. Its manifests and assets validate, and an unsigned package was built with Windows SDK MakeAppx. Signing/trust/registration require explicit setup with an existing certificate; these steps were not performed on this host. See [identity setup](../../packaging/windows/README.md).

## Quality gates

| Gate | Fresh result |
| --- | --- |
| `bun run typecheck` | Passed. |
| `bun run lint` | Passed with zero warnings. |
| `bun run test` | 51 files, 360 tests passed. |
| `bun run test:e2e` | 39 tests passed in installed Microsoft Edge, serial execution. Includes permission persistence, passive settings behavior, catalogue navigation and four Windows AI UI states. |
| Rust formatting | `cargo fmt --all -- --check` passed. |
| Rust lint | `cargo clippy --all-targets --all-features -- -D warnings` passed after the final native changes. |
| Rust tests | `cargo test --all-features`: 99 passed, four explicitly ignored. The real staged Windows AI helper test was run separately and passed through the actual Rust supervisor. |
| Helper publication | x64 and ARM64 builds passed with warnings denied; nine core checks passed in both lanes and eight executable protocol checks passed on x64. ARM64 execution was not exercised. |
| `bun run tauri build` | Final full release build and NSIS installer generation passed. |
| Installed native smoke | Passed with a clean isolated profile: exact vector search, lexical fallback, native window show/hide, sanitized diagnostics, uninstall and profile cleanup. |
| Visual evidence | 57 gallery states regenerated and the new controls inspected; six interaction recordings regenerated. |
| Performance | Existing cadence-aware release gate passed. Strict 240 Hz selection/hover bounds were not met; see measurements below. |

The packaged startup test initially exposed a real manifest regression before Rust entry: the custom fusion manifest had dropped Tauri's Common Controls v6 dependency. Adding only that dependency to an isolated executable reproduced successful startup. The source manifest now preserves it, identity validation enforces it, and the rebuilt installer passed the full installed smoke. Fixed, secret-free startup checkpoints improve future smoke diagnostics.

The successful smoke used explicit imports of the Windows PowerShell Utility and Security modules from `$PSHOME`: the session's mixed PowerShell module paths had prevented automatic `Get-FileHash` loading during an earlier report-writing attempt. The native checks and uninstall had already succeeded; the complete rerun produced current hash and cleanup evidence.

Installer evidence is recorded at [packaged-smoke.json](../../artifacts/packaged/packaged-smoke.json), timestamp `2026-10-04T17:29:30.1368874Z`, SHA-256 `79106979c47094f4b16721a72d8c0f39fd4aaa2f6bef3e090b182915d841c36c`. The installer is unsigned; build outputs are not committed. Verification is local, with no hosted CI claim.

## Actual availability and conditional acceptance

The native x64 host is Windows build `10.0.26300.0` on AMD Ryzen AI 9 HX 370. The live bridge reported stable Windows App Runtime `2.5.1.0`, no Lumen package identity, and `VitisAIExecutionProvider (Certified, NotReady)`. Readiness is dynamic and refreshed through the SDK. The required separately pinned `2.5.4.0` experimentalF runtime was absent.

| Capability | Live host observation | Remaining eligible-machine check |
| --- | --- | --- |
| Windows language/text/OCR/descriptions | `runtimeRequired`. No fabricated ready state. | Install the permitted preview runtime, configure valid limited-access entitlement where required, then exercise real preparation, results, streaming and cancellation. |
| Native Aion | `unsupported` on x64. ARM64 compilation passed. | Snapdragon ARM64 with the Microsoft-signed Aion framework and certified ready QNN provider: model preparation, generation, context limits and cancellation. |
| App Content Search | `identityRequired`. Public lexical fallback and safe navigation passed. | Trusted optional identity plus supported preview runtime: live preparation/add/query/rebuild/delete and persistent index statistics. |
| Agent discovery/invocation/registration | ODR unavailable; registration required identity. The bounded passive App Actions probe remained unavailable. | Identity-enabled host with ODR/App Actions: registration/removal verification, discovery, explicit invocation and OS activation delivery. Native activation parsing/one-time consumption regressions passed locally. |
| Edge | Installed Edge `154.0.4258.53` exposed Summarizer, LanguageDetector, Translator and local SpeechRecognition, but reported them unavailable for the requested languages. Prompt/Writer/Rewriter were absent. | Eligible current executing host with ready models/language packs: real inference, explicit downloads, translation/detection and local microphone lifecycle. |
| WebView2 | Native window lifecycle passed; installed Edge's AI probe does not establish WebView2 AI support. | Refresh availability inside the actual installed WebView2 realm. Features remain unavailable unless that realm exposes the required APIs. |

The passive [Edge host probe](../../src/services/edge-ai/current-host-probe.json) created no sessions, requested no model downloads, used no microphone and enabled no experimental flags. Native probing left all privileged permissions false. Verification did not install models, execution providers, preview frameworks, certificates, optional identity or browser flags. Build, mock and gallery results establish implementation/UI behavior; live preview inference and identity-dependent operations remain explicitly unverified on this unconfigured host.

Engineering Preview SDK terms restrict production use and redistribution without the applicable Microsoft agreement. Provenance, hashes and license texts are retained in [the helper notices](../../workers/windows-ai/THIRD_PARTY.md). This integration and its local evidence do not establish production distribution clearance.

## Performance and evidence interpretation

The regenerated [profile](../../artifacts/performance/profile-summary.json) measured the deterministic browser adapter: warm launcher P95 3.4 ms, input P95 0.1 ms, selection-to-paint P95 4.9 ms and hover-to-paint P95 13.8 ms. The paired hover frame P95 was 17.1 ms, with maximum synchronous hover dispatch 0.7 ms. No repeated/hover tasks exceeded 50 ms; settled animations and activity indicators were zero. Idle CPU was 0.434 percent and JS heap 29.666 MB.

All existing cadence-aware checks passed, while `strict240Hz.passed` is false and `environmentEligibility.strict240HzCadence` is false. These measurements do not establish model-inference performance. Screenshots, recordings and profile metadata identify capture-time HEAD `1f0fb4b`; they were generated against the implemented working tree before its final commit. Only native/manifests/documentation changed afterward.

## References

- [Approved design](../superpowers/specs/2026-10-04-windows-ai-integrations-design.md), [implementation plan](../superpowers/plans/2026-10-04-windows-ai-integrations.md), [native verification](2026-10-04-windows-ai-native.md), [helper implementation](../../workers/windows-ai/IMPLEMENTATION.md) and [Edge adapter notes](../../src/services/edge-ai/IMPLEMENTATION.md).
- [Agent Launchers](https://learn.microsoft.com/en-us/windows/ai/agent-launchers/), [NPU devices](https://learn.microsoft.com/en-us/windows/ai/npu-devices/), [Windows AI APIs](https://learn.microsoft.com/en-us/windows/ai/apis/), [App Content Search](https://learn.microsoft.com/en-us/windows/ai/apis/app-content-search), [Edge's June 2026 on-device AI announcement](https://blogs.windows.com/msedgedev/2026/06/02/expanding-on-device-ai-in-microsoft-edge-new-models-and-apis-for-the-web/) and [Microsoft Aion sample](https://github.com/microsoft/Aion-Instruct-Preview-Sample/).
