import type {ImprovementService} from './improvement-service';
import {approvalFor, approvalSchema, emptyImprovementSnapshot, improvementSettingsSchema, improvementSnapshotSchema, preferenceSchema, safeId, type ApprovalRef, type ImprovementCandidate, type ImprovementEvent, type ImprovementHealth, type ImprovementSettings, type Preference} from './improvement.types';

const hash = 'a'.repeat(64);
export class DevelopmentImprovementService implements ImprovementService {
  readonly simulated = true;
  readonly available = true;
  private data = emptyImprovementSnapshot();
  private prepared = false;
  private cancelled = false;
  private nextVersion = 1;
  private readonly versions = new Map([[0, structuredClone(this.data.activeVersion)]]);
  private readonly runs = new Set<string>();
  async health(): Promise<ImprovementHealth> {
    return {state: !this.data.settings.enabled ? 'disabled' : this.data.settings.paused ? 'paused' : this.prepared ? 'ready' : 'unavailable', version: '0.9.8', detail: 'Simulated development fixture; no Docker or model execution.', prepared: this.data.settings.enabled && this.prepared, modelReady: this.data.settings.enabled && this.prepared};
  }
  async snapshot() {return improvementSnapshotSchema.parse(structuredClone(this.data));}
  async candidateBase(candidateId: string) {
    const candidate = this.data.candidates.find((item) => item.id === safeId.parse(candidateId));
    const base = candidate && this.versions.get(candidate.baseVersion);
    if (!base) throw new Error('The original candidate base is unavailable.');
    return structuredClone(base);
  }
  async setSettings(settings: ImprovementSettings) {this.data.settings = improvementSettingsSchema.parse(settings); this.data.paused = settings.paused;}
  async prepare() {if (!this.data.settings.enabled) throw new Error('Enable improvement first.'); this.prepared = true;}
  async analyze(onEvent: (event: ImprovementEvent) => void) {
    const settings = this.data.settings;
    if (!settings.enabled || settings.paused || !this.prepared || (settings.routeMode === 'cloud' && !settings.cloudConsent)) throw new Error('Improvement analysis is unavailable.');
    this.cancelled = false;
    const jobId = `fixture-job-${this.nextVersion}`;
    this.data.job = {id: jobId, phase: 'evaluation'};
    onEvent({type: 'started', jobId, phase: 'analysis', message: 'Simulated analysis'});
    await new Promise((resolve) => setTimeout(resolve, 50));
    if (this.cancelled) {onEvent({type: 'cancelled', jobId, phase: 'cancelled', message: null}); return;}
    const baseVersion = this.data.activeVersion.id;
    const make = (kind: 'prompt' | 'workflow'): ImprovementCandidate => ({
      id: `fixture-${kind}-${this.nextVersion}`, baseVersion, kind, summary: kind === 'prompt' ? 'Simulated clarification improvement' : 'Simulated find, answer and draft workflow', hash, evidenceDigest: hash, configDigest: hash, createdAt: 1, status: 'awaitingApproval',
      manifest: {baseVersion, kind, summary: 'Simulated evaluation fixture', evidenceDigest: hash, answerInstructions: kind === 'prompt' ? 'Ask for clarification when the request is ambiguous.' : null, computerUseInstructions: null, toolHints: null, preferences: [], workflows: kind === 'workflow' ? [{id: 'find-answer-draft', name: 'Find, answer and draft', steps: [{kind: 'search'}, {kind: 'answer'}, {kind: 'computerUseDraft'}]}] : []},
      report: {id: `fixture-report-${kind}`, candidateHash: hash, baseVersion, configDigest: hash, suiteVersion: 'synthetic-fixture-1', complete: true, budgetExceeded: false, passed: true, reasons: ['Simulated data; measurements do not demonstrate native model quality.'], hash,
        cases: [{id: 'ambiguous-request', set: 'development', safety: false, baseline: {runs: 3, successes: 1, latenciesMs: [100, 101, 102], inputTokens: 90, outputTokens: 30}, candidate: {runs: 3, successes: 3, latenciesMs: [100, 101, 102], inputTokens: 90, outputTokens: 30}}, {id: 'held-out-safety', set: 'heldOut', safety: true, baseline: {runs: 3, successes: 3, latenciesMs: [100, 101, 102], inputTokens: 90, outputTokens: 30}, candidate: {runs: 3, successes: 3, latenciesMs: [100, 101, 102], inputTokens: 90, outputTokens: 30}}]},
    });
    this.data.candidates = [make('prompt'), make('workflow')];
    this.data.job = null;
    onEvent({type: 'completed', jobId, phase: 'review', message: 'Simulated candidates ready for review.'});
  }
  async cancel() {this.cancelled = true; this.data.job = null;}
  async approve(input: ApprovalRef) {
    const approval = approvalSchema.parse(input);
    const candidate = this.data.candidates.find((c) => c.id === approval.candidateId);
    const expected = candidate && approvalFor(candidate, this.data.activeVersion.id);
    if (!candidate || !expected || JSON.stringify(approval) !== JSON.stringify(expected)) throw new Error('Candidate approval is stale or failed.');
    const base = this.data.activeVersion;
    this.data.activeVersion = {...base, id: this.nextVersion++, parentId: base.id, createdAt: 1, answerInstructions: candidate.manifest.answerInstructions ?? base.answerInstructions, computerUseInstructions: candidate.manifest.computerUseInstructions ?? base.computerUseInstructions, toolHints: candidate.manifest.toolHints ?? base.toolHints, workflows: candidate.kind === 'workflow' ? candidate.manifest.workflows : base.workflows};
    this.versions.set(this.data.activeVersion.id, structuredClone(this.data.activeVersion));
    for (const item of this.data.candidates) item.status = item === candidate ? 'promoted' : 'stale';
  }
  async reject(candidateId: string) {const candidate = this.data.candidates.find((c) => c.id === safeId.parse(candidateId)); if (!candidate) throw new Error('Candidate unavailable.'); candidate.status = 'rejected';}
  async rollback(versionId: number) {const version = this.versions.get(versionId); if (!version) throw new Error('Version unavailable.'); this.data.activeVersion = structuredClone(version); for (const c of this.data.candidates) if (c.status === 'awaitingApproval') c.status = 'stale';}
  async clear() {await this.cancel(); this.data = emptyImprovementSnapshot(); this.prepared = false; this.versions.clear(); this.versions.set(0, structuredClone(this.data.activeVersion)); this.runs.clear();}
  async savePreference(input: Preference) {const preference = preferenceSchema.parse(input); const base = this.data.activeVersion; this.data.activeVersion = {...base, id: this.nextVersion++, parentId: base.id, preferences: [...base.preferences.filter((p) => p.name !== preference.name), preference]}; this.versions.set(this.data.activeVersion.id, structuredClone(this.data.activeVersion)); for (const c of this.data.candidates) if (c.status === 'awaitingApproval') c.status = 'stale';}
  async workflows() {return structuredClone(this.data.activeVersion.workflows);}
  async authorizeWorkflow(workflowId: string, versionId: number) {const workflow = this.data.activeVersion.workflows.find((w) => w.id === workflowId); if (!workflow || versionId !== this.data.activeVersion.id || !this.data.settings.enabled || this.data.paused) throw new Error('Workflow authorization is stale or unavailable.'); const runId = `fixture-run-${Date.now()}`; this.runs.add(runId); return {runId, versionId, workflow: structuredClone(workflow)};}
  async endWorkflow(runId: string) {this.runs.delete(safeId.parse(runId));}
}
