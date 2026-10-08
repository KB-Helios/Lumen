import {Channel, invoke} from '@tauri-apps/api/core';
import {z} from 'zod';
import type {ImprovementService} from './improvement-service';
import {approvalSchema, harnessVersionSchema, improvementEventSchema, improvementHealthSchema, improvementSettingsSchema, improvementSnapshotSchema, preferenceSchema, safeId, workflowAuthorizationSchema, workflowSchema, type ApprovalRef, type ImprovementEvent, type ImprovementSettings, type Preference} from './improvement.types';

const versionSchema = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export class TauriImprovementService implements ImprovementService {
  readonly available = true;
  readonly simulated = false;
  private generation = 0;
  private async command(name: string, args?: Record<string, unknown>) {z.union([z.null(), z.undefined()]).parse(await invoke(name, args));}
  async health() {return improvementHealthSchema.parse(await invoke('improvement_health'));}
  async snapshot() {return improvementSnapshotSchema.parse(await invoke('improvement_snapshot'));}
  async candidateBase(candidateId: string) {return harnessVersionSchema.parse(await invoke('improvement_candidate_base', {candidateId: safeId.parse(candidateId)}));}
  async setSettings(settings: ImprovementSettings) {await this.command('set_improvement_settings', {settings: improvementSettingsSchema.parse(settings)});}
  async prepare() {await this.command('prepare_improvement_runtime');}
  async analyze(onEvent: (event: ImprovementEvent) => void) {
    const generation = ++this.generation;
    let jobId: string | undefined;
    let terminal = false;
    let malformed = false;
    const channel = new Channel<unknown>((payload) => {
      if (generation !== this.generation || terminal) return;
      const parsed = improvementEventSchema.safeParse(payload);
      if (!parsed.success) {malformed = true; terminal = true; onEvent({type: 'failed', jobId: jobId ?? 'invalid-event', phase: 'validation', message: 'Invalid improvement progress payload.'}); return;}
      const event = parsed.data;
      jobId ??= event.jobId;
      if (event.jobId !== jobId) return;
      terminal = ['completed', 'failed', 'cancelled'].includes(event.type);
      onEvent(event);
    });
    try {await this.command('analyze_improvements', {onEvent: channel});}
    catch (error) {if (generation === this.generation) {terminal = true; ++this.generation;} throw error;}
    if (malformed) throw new Error('Invalid improvement progress payload.');
  }
  async cancel() {await this.command('cancel_improvements'); ++this.generation;}
  async approve(approval: ApprovalRef) {await this.command('approve_improvement', {approval: approvalSchema.parse(approval)});}
  async reject(candidateId: string) {await this.command('reject_improvement', {candidateId: safeId.parse(candidateId)});}
  async rollback(versionId: number) {await this.command('rollback_improvement', {versionId: versionSchema.parse(versionId)});}
  async clear() {await this.command('clear_improvement_data'); ++this.generation;}
  async savePreference(preference: Preference) {await this.command('save_improvement_preference', {preference: preferenceSchema.parse(preference)});}
  async workflows() {return z.array(workflowSchema).max(16).parse(await invoke('improvement_workflows'));}
  async authorizeWorkflow(workflowId: string, versionId: number) {return workflowAuthorizationSchema.parse(await invoke('authorize_improvement_workflow', {workflowId: safeId.max(64).parse(workflowId), versionId: versionSchema.parse(versionId)}));}
  async endWorkflow(runId: string, outcome: 'completed' | 'failed' | 'cancelled') {await this.command('end_improvement_workflow', {runId: safeId.parse(runId), outcome: z.enum(['completed', 'failed', 'cancelled']).parse(outcome)});}
}
