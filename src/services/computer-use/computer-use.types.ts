import {z} from 'zod';

export const computerUseModels = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-3.5-flash', 'gemini-2.5-computer-use-preview-10-2025', 'gemini-3-flash-preview'] as const;
// Saved model selections survive migration; native health determines current availability.
export const computerUseModelSchema = z.string().min(1).max(200);
export type ComputerUseModel = z.infer<typeof computerUseModelSchema>;
export const computerUseProviderSchema = z.enum(['gemini', 'openai']);
export const computerUseExecutionModeSchema = z.enum(['fast', 'background']);
export const computerUseStopReasonSchema = z.enum(['stop', 'takeOver', 'consentRevoked']);
export type ComputerUseProvider = z.infer<typeof computerUseProviderSchema>;
export type ComputerUseExecutionMode = z.infer<typeof computerUseExecutionModeSchema>;
export type ComputerUseStopReason = z.infer<typeof computerUseStopReasonSchema>;
export const computerUseWebUrlSchema = z.url().refine((value) => {
  const url = new URL(value);
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
}, 'The start page must be an absolute HTTP or HTTPS URL without credentials.');
export const computerUseTargetSchema = z.discriminatedUnion('kind', [
  z.object({kind: z.literal('browser'), initialUrl: computerUseWebUrlSchema, visible: z.boolean().optional()}).strict(),
  z.object({kind: z.literal('window'), targetId: z.string().min(1)}).strict(),
]);
export type ComputerUseTarget = z.infer<typeof computerUseTargetSchema>;
export const computerUseRequestSchema = z.object({
  taskId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), task: z.string().trim().min(1).refine((value) => Array.from(value).length <= 4_000, 'Tasks are limited to 4,000 characters.'),
  provider: computerUseProviderSchema, model: computerUseModelSchema, executionMode: computerUseExecutionModeSchema,
  target: computerUseTargetSchema, cloudConsent: z.boolean(), desktopControlConsent: z.boolean(), desktopCloudConsent: z.boolean(),
}).strict().refine((request) => !(request.executionMode === 'background' && request.target.kind === 'browser' && request.target.visible), 'Background mode cannot launch a visible browser.');
export type ComputerUseRequest = z.infer<typeof computerUseRequestSchema>;

const identity = {taskId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), runId: z.string().min(1), targetId: z.string().min(1)};
const ordinary = {...identity, generation: z.literal(1)};
const terminal = {...identity, generation: z.literal(2)};
export const computerUseEventSchema = z.discriminatedUnion('type', [
  z.object({...ordinary, type: z.literal('started'), provider: computerUseProviderSchema, model: computerUseModelSchema, executionMode: computerUseExecutionModeSchema, browser: z.string().min(1)}).strict(),
  z.object({...ordinary, type: z.literal('reasoning'), text: z.string()}).strict(),
  z.object({...ordinary, type: z.literal('action'), actionId: z.string().min(1), action: z.string().min(1)}).strict(),
  z.object({...ordinary, type: z.literal('observation'), snapshotId: z.string().min(1), url: z.string().optional()}).strict(),
  z.object({...ordinary, type: z.literal('approvalRequired'), approvalId: z.string().min(1), actionId: z.string().min(1), snapshotId: z.string().min(1), scope: z.enum(['safety', 'foreground', 'visibleBrowser']), explanation: z.string().min(1)}).strict(),
  z.object({...ordinary, type: z.literal('approvalResolved'), approvalId: z.string().min(1), approved: z.boolean()}).strict(),
  z.object({...terminal, type: z.literal('completed'), summary: z.string()}).strict(),
  z.object({...terminal, type: z.literal('stopped'), reason: computerUseStopReasonSchema, uncertain: z.boolean()}).strict(),
  z.object({...terminal, type: z.literal('failed'), message: z.string(), code: z.string()}).strict(),
]);
export type ComputerUseEvent = z.infer<typeof computerUseEventSchema>;
const availability = z.object({available: z.boolean(), reason: z.string().optional()}).strict();
const providerHealth = z.object({credentialConfigured: z.boolean(), available: z.boolean(), models: z.array(computerUseModelSchema), reason: z.string().optional()}).strict();
export const computerUseHealthSchema = z.object({
  state: z.enum(['ready', 'unavailable']), mode: z.enum(['packaged', 'python', 'missing']), browser: z.literal('Microsoft Edge'),
  credentialConfigured: z.boolean(), detail: z.string().optional(), nativeStop: availability,
  routes: z.object({browser: availability, desktop: availability, foreground: availability}).strict(),
  providers: z.object({gemini: providerHealth, openai: providerHealth}).strict(),
}).strict();
export type ComputerUseHealth = z.infer<typeof computerUseHealthSchema>;
export const computerUseWindowTargetSchema = z.object({targetId: z.string().min(1), title: z.string(), processName: z.string(), available: z.boolean(), reason: z.string().optional()}).strict();
export const computerUseTargetsSchema = z.array(computerUseWindowTargetSchema);
export type ComputerUseWindowTarget = z.infer<typeof computerUseWindowTargetSchema>;

export function unavailableComputerUseHealth(detail = 'Computer Use requires the native Lumen app.'): ComputerUseHealth {
  const unavailable = {available: false, reason: detail};
  const provider = {...unavailable, credentialConfigured: false, models: []};
  return {state: 'unavailable', mode: 'missing', browser: 'Microsoft Edge', credentialConfigured: false, detail, nativeStop: unavailable, routes: {browser: unavailable, desktop: unavailable, foreground: unavailable}, providers: {gemini: provider, openai: provider}};
}

/** One request owns one native run. Old identities and replayed scopes never enter UI state. */
export class ComputerUseEventAdmission {
  private identity?: {runId: string; targetId: string};
  private finished = false;
  private started = false;
  private snapshot?: string;
  private pendingApproval?: string;
  private readonly seen = new Set<string>();
  constructor(private readonly request: ComputerUseRequest) {}
  admit(event: ComputerUseEvent) {
    if (this.finished || event.taskId !== this.request.taskId) return false;
    if (this.request.target.kind === 'window' && event.targetId !== this.request.target.targetId) return false;
    if (this.identity && (event.runId !== this.identity.runId || event.targetId !== this.identity.targetId)) return false;
    if (event.type === 'started' && (this.started || event.provider !== this.request.provider || event.model !== this.request.model || event.executionMode !== this.request.executionMode)) return false;
    if (event.type === 'approvalRequired' && event.scope === 'foreground' && this.request.executionMode === 'background') return false;
    if (event.type === 'approvalRequired' && event.scope === 'visibleBrowser' && (this.request.executionMode !== 'fast' || this.request.target.kind !== 'browser' || !this.request.target.visible || event.snapshotId !== 'startup')) return false;
    if (event.type === 'approvalRequired' && !(event.scope === 'visibleBrowser' && event.snapshotId === 'startup') && event.snapshotId !== this.snapshot) return false;
    if (event.type === 'approvalResolved' && event.approvalId !== this.pendingApproval) return false;
    const replayId = event.type === 'action' ? `action:${event.actionId}` : event.type === 'observation' ? `snapshot:${event.snapshotId}` : event.type === 'approvalRequired' ? `approval:${event.approvalId}` : undefined;
    if (replayId && this.seen.has(replayId)) return false;
    this.identity ??= {runId: event.runId, targetId: event.targetId};
    if (replayId) this.seen.add(replayId);
    if (event.type === 'started') this.started = true;
    if (event.type === 'observation') {this.snapshot = event.snapshotId; this.pendingApproval = undefined;}
    if (event.type === 'approvalRequired') this.pendingApproval = event.approvalId;
    if (event.type === 'approvalResolved') this.pendingApproval = undefined;
    this.finished = event.generation === 2;
    return true;
  }
}
