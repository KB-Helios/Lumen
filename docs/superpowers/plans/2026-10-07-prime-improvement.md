# Verified continual improvement implementation plan

Goal: integrate Prime Agent as a candidate generator; native Lumen owns evidence, evaluation, promotion and rollback.

## Global constraints

- Windows 11, Bun only, existing Tauri service boundary and Zod payload parsing.
- Off on installation/migration; local model by default; independent cloud improvement consent.
- Only allowlisted metadata; no production task content, paths, screenshots, values or credentials in learning traces.
- Prime 0.9.8, source revision `2ed835646120f79562407879ff19e8860623775c`; Docker Linux containers with no host mounts, network, privileges or secrets.
- Fixed Rust security, permissions, evaluator and model weights are outside the editable harness.
- Three repetitions per case; improvement from baseline <=1/3 to candidate 3/3; no regressions; security 100%; latency p95 and total tokens <=110% baseline; incomplete/unmetered/budget-limited evaluation never promotes.
- Workflow <=8 typed steps, no arbitrary scripts or loops; Computer Use retains explicit Run and all native admission/consent/Stop rules.
- One job, automatic trigger after three matching failures in seven days, one candidate/day; generation 10 minutes/20,000 tokens; evaluation 45 minutes; existing enrichment daily budget.
- Trace retention 30 days / 10,000 entries.

## Tasks

### Task 1: Native policy, SQLite and lifecycle

Implement strict native types, trace capture, immutable version store, candidates and promotion transactions, approval hash binding, rollback and deletion. Publish ImprovementService IPC contract. Integrate normal answer and Computer Use traces/version snapshots. No simulated success in native health/evaluation.

### Task 2: Docker / ACP runtime

Implement the isolated runtime and guest bridge, image packaging/preparation and protocol/sandbox tests. Pin the Prime source revision above and its Python dependencies. Use a non-root, read-only, network-disabled container with temporary working storage, resource limits and no host mounts or credentials. Forward model requests over the guest's standard streams to a fixed native AgentGateway route. Package a checksum-verified image archive and verify ACP initialize/session/prompt/cancel compatibility during explicit Prepare.

### Task 3: Queue, fixed evaluator and workflows

Extend existing Rivet worker with an independent durable improvement queue. Rust claims fenced jobs and coordinates analysis and fixed synthetic model tests. Keep held-out cases outside candidate inputs. Add registry aliases without resetting existing routes. Execute approved declarative workflows through existing services and explicit Computer Use drafts/Run.

### Task 4: Typed frontend and management controls

Add Zod contracts, native/unavailable/development adapters, and management controls in AgentGateway, Activity, Privacy and Diagnostics. Use existing components and styles. Show diffs, measurements, stale candidates, approval and rollback. Browser fixtures are dev-only.

### Task 5: Review and acceptance

Run typecheck, lint, unit/component tests, Edge e2e, Rust fmt/clippy/tests, Tauri build. Regenerate gallery, recordings and profiling. Test actual Docker/ACP where runtime available; document exact missing evidence instead of claiming native success from mocks.

## Shared frontend/native contract

All fields camelCase. All objects strict/deny_unknown_fields.

- Settings: { enabled: boolean, cloudConsent: boolean, routeMode: 'local'|'cloud', paused: boolean }.
- HarnessVersion: { id: number, parentId: number|null, createdAt: number, answerInstructions: string, computerUseInstructions: string, toolHints: string, preferences: [{name:'answerLanguage'|'answerVerbosity',value:string}], workflows: WorkflowDefinition[] }.
- WorkflowDefinition: { id: string, name: string, steps: [{kind:'search'|'answer'|'computerUseDraft'}] }; 1..8 steps, at most one Computer Use draft, draft must be last; no embedded user task/URLs/scripts/arguments.
- CandidateManifest: {baseVersion:number,kind:'memory'|'prompt'|'workflow',summary:string,evidenceDigest:string,answerInstructions:string|null,computerUseInstructions:string|null,toolHints:string|null,preferences:Preference[],workflows:WorkflowDefinition[]}.
- Candidate: { id:string, baseVersion:number, kind:string, summary:string, hash:string, evidenceDigest:string, configDigest:string, createdAt:number, status:'proposed'|'evaluating'|'rejected'|'awaitingApproval'|'promoted'|'stale'|'cancelled', manifest:CandidateManifest, report:EvaluationReport|null }.
- EvaluationReport: {id:string,candidateHash:string,baseVersion:number,configDigest:string,suiteVersion:string,complete:boolean,budgetExceeded:boolean,cases:EvaluationCase[],passed:boolean,reasons:string[],hash:string}.
- EvaluationCase: {id:string,set:'development'|'heldOut',safety:boolean,baseline:CaseMeasurements,candidate:CaseMeasurements}.
- CaseMeasurements: {runs:number,successes:number,latenciesMs:number[],inputTokens:number|null,outputTokens:number|null}.
- Snapshot: {settings:Settings,activeVersion:HarnessVersion,candidates:Candidate[],traceCount:number,job:{id:string,phase:string}|null,paused:boolean}.
- Health: {state:'ready'|'disabled'|'unavailable'|'paused',version:string,detail:string|null,prepared:boolean,modelReady:boolean}.
- ApprovalRef: {candidateId:string,candidateHash:string,baseVersion:number,reportHash:string}.
- Commands: improvement_health, improvement_snapshot, set_improvement_settings(settings), prepare_improvement_runtime, analyze_improvements(onEvent), cancel_improvements, approve_improvement(approval), reject_improvement(candidateId), rollback_improvement(versionId), clear_improvement_data, save_improvement_preference(preference), improvement_workflows, improvement_candidate_base(candidateId), authorize_improvement_workflow(workflowId), end_improvement_workflow(runId, outcome).
- Event: {type:'started'|'progress'|'completed'|'cancelled'|'failed',jobId:string,phase:string,message:string|null}; native errors are bounded fixed messages.

The controller owns types.rs, store.rs, coordinator.rs, evaluation.rs, commands.rs and module/application integration. Runtime worker owns docker.rs and workers/improvement-runtime plus its dedicated staging script/tests only.
