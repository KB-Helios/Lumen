# Native Computer Use UI contract

The frontend extends its existing service. No executor operations, provider requests or keys live in React.

Request: `{taskId,task,provider,model,executionMode,target,cloudConsent,desktopControlConsent,desktopCloudConsent}`. Provider is `gemini|openai`; mode is `fast|background`. Target is `{kind:"browser",initialUrl,visible?:boolean}` or `{kind:"window",targetId}` (opaque native discovery ID). `visible` defaults false; an explicit UI checkbox can request visible launch in Fast mode. Background rejects visible launch. Browser consent remains the existing flag; both desktop flags default false and must be persisted before native start.

`computer_use_targets` returns `{targetId,title,processName,available,reason?}[]`. Unavailable/elevated windows may be shown with a reason but cannot start.

`computer_use_health` returns `{state:"ready"|"unavailable",mode:"packaged"|"python"|"missing",browser:"Microsoft Edge",credentialConfigured,detail?,nativeStop:{available,reason?},routes:{browser:{available,reason?},desktop:{available,reason?},foreground:{available,reason?}},providers:{gemini:{credentialConfigured,available,models:string[],reason?},openai:{credentialConfigured,available,models:string[],reason?}}}`. `credentialConfigured` preserves the previous Gemini field. Providers list verified available reviewed model IDs, not unbounded server model names. An unsupported saved model remains selected with an unavailable explanation.

Every event has `taskId,runId,generation,targetId` plus:

- `started`: `provider,model,executionMode,browser`.
- `reasoning`: `text` (short user-facing progress, never chain of thought).
- `action`: `actionId,action` (content-free action label).
- `observation`: `snapshotId,url?`.
- `approvalRequired`: `approvalId,actionId,snapshotId,scope:"safety"|"foreground"|"visibleBrowser",explanation`.
- `approvalResolved`: `approvalId,approved`.
- `completed`: `summary`.
- `stopped`: `reason:"stop"|"takeOver"|"consentRevoked",uncertain:boolean`.
- `failed`: `message,code`.

`respond_computer_use_approval` retains `{taskId,approvalId,approved}`. Native pending approval stores the full run/generation/target/snapshot/action scope; stale or replayed IDs fail.

`stop_computer_use` accepts `{taskId,reason:"stop"|"takeOver"|"consentRevoked"}` and returns after native gate closure/teardown dispatch. `cancel_computer_use` remains a compatibility alias. Stop must be sent immediately, including while start is pending; the stream stays open until native terminal acknowledgment. `stream` also accepts an optional scoped `onStopped` callback carrying only a validated, admitted stopped event; it preserves native acknowledgment if a damaged generator has ended and cleanup IPC rejects. The controller applies the same identity and terminal admission to that callback and the stream. Frontend shows `stopping` until `stopped`. Take Over ends the run permanently.

Settings add `provider` (Gemini), `executionMode` (Fast), `desktopControlConsent` (false), `desktopCloudConsent` (false), and `openaiModel` (`gpt-6.1-sol`). Existing `model` is the saved Gemini selection; new configurations use `gemini-3.8-flash`. Target windows are never persisted as reusable HWNDs. Persisted grant updates use the existing write-before-publish path. Revocation stops the current run and any warm executor.
