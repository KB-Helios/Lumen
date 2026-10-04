# Edge on-device AI adapter

Implemented 2026-10-04 under Task 4 of the approved Windows AI integrations plan. This work owns `src/services/edge-ai/**` only. Shared contracts, UI, native code, preferences persistence, and release integration remain owned by the primary task.

## Files and integration

- `edge-ai-service.ts` exports `EdgeAiService`, `EdgeAiHost`, and sanitized `EdgeAiError`.
- `edge-ai-service.test.ts` contains 46 focused regressions and browser-contract cases.
- `probe-current-host.mjs` bundles the actual adapter with Bun and runs a passive installed-Edge probe through the repository's Node-hosted Playwright pattern.
- `probe-browser-host.mjs` owns that fixed verification browser session and closes it after inspection.
- `current-host-probe.json` records observed current-host capability evidence without prompts, transcripts, secrets, or model names inferred from browser/hardware versions.

The agreed adapter interface is unchanged:

```ts
new EdgeAiService(host?: EdgeAiHost)
status(preferences): Promise<WindowsAiFeature[]>
prepare(featureId, requestId, preferences, onEvent?, signal?): Promise<void>
text(request, preferences, onEvent?, signal?): Promise<WindowsAiTextResult>
startDictation(preferences, listener): Promise<DictationSession>
cancel(requestId): void
dispose(): void
```

`dispose()` releases owned resources and permanently closes this adapter instance. The composition layer passes authoritative validated preferences to every operation. Refreshing `status()` with revoked preferences cancels relevant active work. The caller must stop the returned dictation session on in-app navigation, native hide/close, and launcher intent changes; the adapter also stops on `pagehide`, document visibility loss, timeout, and recognition errors. `onText(text, final)` delivers the full current transcript snapshot, with `final` true when every retained recognition result is final. It never submits a task or persists a transcript.

## Boundaries implemented

All browser globals are accessed inside the adapter. Presence is checked in the executing realm; installed Microsoft Edge does not prove an API exists in Lumen's WebView2. Secure context is required. Each of LanguageModel, Summarizer, Writer, Rewriter, LanguageDetector, Translator, and local SpeechRecognition has its own capability state. Unknown availability fails closed.

Passive status calls only `availability()`/local `available()`. It never creates a model/recognition session, installs a pack, requests microphone permission, or calls a model operation. Prompt requires `edgeEnabled`; writing/detection/translation tools require both `edgeEnabled` and `textToolsEnabled`; speech requires `edgeEnabled` and the independent `dictationEnabled` opt-in. Explicit preparation additionally requires recorded `modelDownloadsAllowed` consent and active browser user activation, checked before the readiness probe and again before creation/installation. Text and dictation starts also require current user activation.

Shared Zod schemas validate preferences, request/feature IDs, text requests, features, events, results, and detector result fields. Text inputs are bounded by both the shared character limit and 65,536 UTF-8 bytes. Output is bounded by 262,144 characters/UTF-8 bytes and 16,384 stream chunks. Emitted deltas are split into at most 65,536 characters per event. Browser input/context quotas are measured when exposed. Probes have a 5-second deadline, text a 120-second deadline, preparation a 600-second deadline, and dictation a 120-second deadline plus a 4,000-character transcript limit. Only one text/preparation operation and one dictation session can be active per instance.

The same request options are used for readiness and creation: Prompt text input/output languages, writing-assistance input/output languages and plain-text format, detector expected input language, the exact translator source/target pair, or the requested speech locale with `processLocally: true`. Text starts reject every state other than `available` and never intentionally prepare a model. Preparation monitors actual valid `loaded / total` events and rechecks availability before reporting completion. Speech installation has indeterminate progress because its API exposes no monitor.

Current official Edge playgrounds append stream chunks as deltas. That is the default for every streaming text API here. A known older/alternate host can explicitly inject `streamSemantics: {edgePrompt: 'cumulative'}` (or the corresponding task ID). Cumulative chunks must preserve the entire previous prefix; only the new suffix becomes a delta. Rewritten cumulative prefixes fail closed. No heuristic strips repeated delta tokens. Detection is non-streaming, validates the returned language/confidence list, and returns the highest-confidence result. APIs that expose only the documented non-streaming text method are supported with the same output bounds.

An AbortSignal is passed into model creation and operations. Stop, consent revocation, navigation, disposal, timeout, failure, and completion release sessions, readers, monitor/lifecycle listeners, and timers. A session resolving after cancellation is destroyed immediately. Cancellation suppresses late text/progress. Errors use fixed bounded messages rather than raw browser exceptions or submitted content. Results have `engine: 'edge'`, `model: null`, and no fabricated file citations; no standard inspected API exposes a reliable model name.

Local speech requires the unprefixed SpeechRecognition API, a real `processLocally` prototype property, static local `available()` and `install()` methods, requested-locale readiness, and readback of `processLocally === true` before capture. Prefixed/cloud-only recognition is rejected. Browser microphone permission is enforced by recognition start, and permission/errors stop capture without a cloud fallback.

## Verification evidence

Meaningful red runs preceded implementation: the initial capability/consent suite had 18 failures, local dictation had 5 failures after the passive boundary existed, and unexpected-download/ready-initialization cases had 2 failures before the monitor safeguard. The initial full service scaffold also failed all 34 then-written cases. Promise rejection handling in pending-operation tests was corrected before the passing runs.

Fresh verification after implementation:

```powershell
rtk bun run typecheck
rtk proxy bun x eslint src/services/edge-ai --max-warnings 0
rtk bun run test -- src/services/edge-ai/edge-ai-service.test.ts
rtk proxy bun src/services/edge-ai/probe-current-host.mjs
```

The focused suite passes 46/46 tests. Typecheck and focused lint pass. The primary task must still run the complete integrated quality gate, native verification, UI/e2e coverage, and required evidence regeneration; these scoped results do not establish those lanes.

The passive host probe completed at `2026-10-04T14:35:28.019Z` using installed Microsoft Edge **154.0.4258.53**, a fresh headless automation profile, and a secure loopback origin. No AI experiment flags were enabled. Playwright uses its standard automation launch options; this is not a claim about the user's ordinary browser profile or Tauri/WebView2. No model `create()`, speech `install()`, or microphone start was called.

| API | Exposed in probed realm | Requested readiness |
| --- | --- | --- |
| LanguageModel | No | Unsupported |
| Summarizer | Yes | Unavailable (`en` input/output, plain text) |
| Writer | No | Unsupported |
| Rewriter | No | Unsupported |
| LanguageDetector | Yes | Unavailable (`en` expected input) |
| Translator | Yes | Unavailable (`en` to `sv`) |
| SpeechRecognition | Yes, including local API shape | Unavailable (`en-US`, local processing) |

`webkitSpeechRecognition` was also present, but it is never used as a fallback. No live inference, translation, model preparation, or microphone capture was exercised because verification must not download models or activate the microphone. WebView2 readiness is unverified and is not inferred from this Edge result.

The first probe, hosted directly in Bun 1.3.14 on Windows, stalled in Playwright's browser launch handshake and timed out. A second bounded 15-second launch reproduced that boundary. Moving only Playwright execution to the repository's existing Node-hosted pattern (Node 24.15.0), while retaining Bun as command/bundler, completed the same passive probe in about three seconds. Browser/profile/AI flags were not changed to obtain that result.

## Browser-controlled limits and concerns

1. `create()` has no atomic "never download" option. A model can be evicted between the ready probe and session creation. The adapter aborts creation if its monitor observes an intermediate download fraction during an ordinary text start. Ready sessions also emit 0/1 initialization events, so those alone cannot prove a download. Already-started browser download bytes cannot be undone, and an instantaneous/unreported download cannot be conclusively vetoed by the API. This limitation is documented rather than hidden behind a consent claim.
2. SpeechRecognition `install()` exposes neither AbortSignal nor progress. Stop/disposal ends Lumen's observation and prevents a later capture start; the browser may continue an already-started pack installation. Model APIs similarly manage shared downloads, and their cancellation does not guarantee deletion of browser-cached resources. UI wording should say stop preparation/work where supported, without promising all browser network transfer stops.
3. Availability reflects the browser's implementation for the supplied language options. Older preview implementations may ignore options added by later drafts. The adapter passes the exact standard options and rejects API failures; it cannot certify multilingual output quality or API conformance without live inference on a supported host.
4. User activation is checked again after the passive readiness probe. A slow probe can consume the transient activation window and require another explicit user action. No timer/background call bypasses that requirement.

## Documentation consulted

Context7 was resolved first to `/microsoftedge/microsoftedge-documentation`; its query returned no matching on-device API documentation. Official Microsoft sources and the linked drafts were then used:

- [Microsoft Edge June 2026 announcement](https://blogs.windows.com/msedgedev/2026/06/02/expanding-on-device-ai-in-microsoft-edge-new-models-and-apis-for-the-web/)
- [Prompt API](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/prompt-api)
- [Writing Assistance APIs](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/writing-assistance-apis)
- [Language Detector API](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/languagedetector-api)
- [Translator API](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/translator-api)
- [Local SpeechRecognition](https://learn.microsoft.com/en-us/microsoft-edge/web-platform/speech-recognition-api)
- [Microsoft's current prompt playground source](https://github.com/MicrosoftEdge/Demos/blob/main/built-in-ai/static/prompt-api.js)
- [Microsoft's current translator playground source](https://github.com/MicrosoftEdge/Demos/blob/main/built-in-ai/static/translator-api.js)
- [Prompt API draft](https://webmachinelearning.github.io/prompt-api/)
- [Writing Assistance draft and shared creation/cancellation semantics](https://webmachinelearning.github.io/writing-assistance-apis/)
- [Translation and language detection draft](https://webmachinelearning.github.io/translation-api/)
