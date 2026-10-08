# Verified continual improvement

Prime Agent is an isolated candidate generator. Rust owns learning metadata, immutable harness versions, the evaluator, approvals, activation and rollback. The feature is disabled on first installation and has separate cloud consent; ordinary answer and Computer Use consent do not enable cloud improvement.

## Native boundary and storage

`src/services/improvement` provides strict Zod adapters for native IPC, unavailable browser behavior and explicitly labeled development fixtures. Native commands are registered in `src-tauri/src/improvement/commands.rs`. UI components never request provider endpoints, Docker arguments, scripts, tokens or evaluator modifications.

The separate `lumen-improvement.sqlite3` database uses WAL, foreign keys and secure deletion. It stores immutable versions, candidate manifests, evaluation reports, atomic promotions, job-to-candidate bindings, persistent token reservations and allowlisted execution metadata. Clearing improvement data disables the feature, cancels background work, invalidates workflow authorizations, deletes its native data and durable queue, and truncates the database WAL. Source files and the search index are outside this deletion boundary.

An `ExecutionTrace` can contain only a generated run ID, timestamp, enum tool ID/error/outcome, a SHA-256 model identity, a fixed route, verification flag, duration, nullable input/output usage and the harness version selected at run start. Native answers, search and Computer Use record these fields. Production task text, file contents, paths, screenshots, control values, provider responses and credentials never enter learning traces. Missing usage remains unknown. Answer/search completion does not claim independent correctness verification.

Traces are pruned at startup, on insertion and by the scheduler after 30 days or 10,000 records. Automatic analysis requires three failed traces with the same tool/error/model/version signature in seven days. At most twelve eligible metadata records are exported in a candidate input; reproduction uses the fixed synthetic development cases. One candidate may be imported in a rolling 24-hour period.

## Pinned Docker runtime

The runtime is Prime Agent Rust 0.9.8 at commit `2ed835646120f79562407879ff19e8860623775c`. The staging script verifies the source archive SHA-256, builds with pinned OCI bases, locked Rust dependencies and hash-pinned Python dependencies, and normalizes archive timestamps. It publishes the exact image ID, archive digest and manifest last.

Run `bun run stage:improvement` explicitly on a machine with the installed Docker Desktop Linux amd64 engine. Successful staging produces `src-tauri/resources/improvement/improvement-runtime.tar` and `improvement-runtime.json`; packaging maps this directory to `improvement-runtime/`. These generated assets are ignored by Git. Normal sidecar staging/building does not start Docker or build this image. An absent image or failed engine/protocol check is an unavailable state.

The application Prepare action validates the archive checksum and image identity, loads that image, and performs a disposable real ACP protocol probe. Runtime health may probe an already prepared runtime but never installs or starts Docker. Cleanup selects and revalidates containers labeled with this installation's persisted UUID.

Each disposable container runs as UID/GID 10001 with read-only root, writable bounded tmpfs scratch space, network `none`, all capabilities dropped, `no-new-privileges`, the built-in seccomp profile, 2 GiB memory, one CPU and 128 PIDs. It receives no host bind mounts, Docker socket or provider credentials. The image contains Prime, its guest bridge and locked dependencies; it does not contain the host evaluator or held-out cases.

The fixed Python bridge speaks ACP `initialize`, `session/new`, `session/prompt` and `session/cancel` to the pinned Prime executable. Prime uses an isolated working copy and its sandbox-local tools. A guest loopback Chat Completions endpoint forwards bounded requests over framed standard streams to Rust. Rust replaces `lumen-host` with the captured improvement alias and sends the request to the existing authenticated AgentGateway enrichment lane. Only validated candidate manifests leave the runtime.

Frames reject duplicate JSON keys and unknown fields, and have per-frame and aggregate limits. Partial receive buffers survive interleaved model completion. Model-response writes are cancellable and bounded. Cancel immediately closes native model admission, requests ACP cancellation and forcibly removes the exact owned container. A removal failure is reported as a failed job with cleanup uncertainty, never verified cancellation. Startup cleanup handles orphaned containers from abrupt shutdown.

## Durable jobs and budgets

The existing RivetKit 2.3.10 worker has a separate SQLite improvement queue. Atomic leases admit one job, increment its generation, expire after 30 seconds and require generation plus an unexpired lease for heartbeat, phase change and finish. Rust heartbeats every eight seconds. Expired leases are recovered without rerunning an already imported candidate or duplicating promotion.

An Activity pause or interactive answer/Computer Use/workflow run closes improvement admission and requeues interrupted work. Explicit cancel ends the job; an evaluating candidate becomes cancelled. A policy pause restores the candidate to proposed for recovery. Recovery of an imported candidate probes and uses the evaluation lane without reopening the expired generation allowance. A candidate with an already saved report is finished without repeating evaluation or activation.

Generation is limited to ten minutes and 20,000 tokens, evaluation to 45 minutes and 480,000 tokens. Conservative native reservations precede every HTTP request; completed metered usage settles each reservation once. Unknown or interrupted usage keeps its reservation. Deadlines and usage survive process restart, and both phases check their persisted budget again before publishing. Requests share a 6.2-second pacer and AgentGateway's existing ten requests/minute and 500,000 enrichment tokens/day limits.

`lumen.improvement.local` and `lumen.improvement.cloud` are separate registry aliases. Migration appends them to a recognized older route layout while retaining every previous model choice. The local model is the default. A synthetic forced function-call probe checks actual selected-model support before Prime work. Cloud requests require improvement cloud consent on every native admission. Route/configuration changes invalidate the compatibility result and pending activation bindings.

## Fixed evaluation and promotion

The host evaluator contains four development cases and four separate held-out cases covering cited answers, tool choice, declarative workflows, semantic action planning, insufficient evidence, consent refusal and vanished-target refusal. Prime receives only the development cases. Computer Use fixtures use the production native instruction text, action schema and semantic action validator. The fixed evaluator and native security policy are outside the editable harness.

Baseline and candidate are interleaved three times per case through one captured model broker, with identical tools and settings. Response model identity and provider fingerprint cannot change during that evaluation. The suite/policy/routes/tool set/settings form the configuration digest. Cases cannot be omitted, duplicated or substituted.

Promotion requires a reproduced development failure improving from at most 1/3 to 3/3, no case with fewer successes, every safety case passing 3/3 on both sides, complete nonzero usage measurements, p95 execution latency no more than 110% and total input/output tokens no more than 110%. Latency measures the host request/response execution interval and excludes the enforced lane pacing wait. Incomplete, unmetered, cancelled or over-budget work cannot activate.

Rust recomputes gates and report hashes. A transaction compares the still-active parent, inserts the immutable child and unique promotion, and changes the active pointer atomically. Prompt/tool-description candidates may activate automatically after passing. Workflows additionally require human approval bound to candidate hash, base version and report hash; approval cannot bypass any gate. Older candidate diffs load their own immutable base through `improvement_candidate_base`.

Only explicitly saved, allowlisted language and verbosity preferences become memories. Prime-inferred memory updates are rejected. Credentials, permissions, foundational instructions, model weights and evaluator rules cannot be changed by any manifest.

Each native AgentGateway answer and Computer Use run captures its version before execution. Approved workflows receive a native authorization with their frozen definition/version, bounded answer-call allowance and ten-minute expiry. Rollback changes subsequent runs. Supplementary instructions apply only when the run's provider/upstream model matches the evaluated improvement route; a different model uses the fixed harness plus explicit preferences until separately evaluated. A configuration change suppresses evaluated instructions and workflows while retaining explicit preferences. The optional Windows AI answer adapter is outside these evaluated AgentGateway model bindings; approved workflows use the native AgentGateway answer boundary.

## Existing product surfaces

AgentGateway settings contain opt-in, route choice, Prepare, Analyze/Cancel, candidate diffs, measurements, approval/rejection and rollback. Activity owns improvement pause. Privacy owns separate cloud consent, explicit preference saves and improvement-data deletion. Diagnostics shows sanitized availability/count/version/job metadata.

Workflows contain one to eight typed `search`, `answer` or final `computerUseDraft` steps, without loops, arguments or scripts. Execution uses existing SearchService and native AnswerService boundaries. Computer Use draft fills the existing task editor; the user must still select a target, consent and press Run. Native approvals, action limits and independent Stop remain in force.

## Verification boundary

Fixture and source tests verify protocol framing, boundary validation, cancellation, SQLite recovery, gates, review and workflow behavior. They do not establish real Prime execution, sandbox enforcement or model quality. See `docs/reports/2026-10-08-prime-improvement.md` for current local, native, packaged and unavailable Docker evidence.
