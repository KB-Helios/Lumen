import {z} from 'zod';

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const safeId = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const executionTraceSchema = z.object({id: safeId, at: count, toolId: z.enum(['answer.generate', 'computerUse.plan', 'files.search', 'workflow.run']), model: digest, route: z.enum(['lumen.answer.local', 'lumen.answer.cloud', 'lumen.search', 'computerUse.openai', 'computerUse.gemini', 'lumen.workflow']), errorCode: z.enum(['none', 'invalidResponse', 'providerUnavailable', 'cancelled', 'verificationFailed', 'permissionDenied', 'unsupportedAction', 'budgetExceeded', 'unknownFailure']), outcome: z.enum(['completed', 'failed', 'cancelled']), verified: z.boolean(), durationMs: count, inputTokens: count.nullable(), outputTokens: count.nullable(), harnessVersion: count}).strict();
export type ExecutionTrace = z.infer<typeof executionTraceSchema>;
export const improvementSettingsSchema = z.object({enabled: z.boolean(), cloudConsent: z.boolean(), routeMode: z.enum(['local', 'cloud']), paused: z.boolean()}).strict();
export const preferenceSchema = z.discriminatedUnion('name', [
  z.object({name: z.literal('answerLanguage'), value: z.enum(['sv', 'en', 'system'])}).strict(),
  z.object({name: z.literal('answerVerbosity'), value: z.enum(['brief', 'normal', 'detailed'])}).strict(),
]);
export const workflowSchema = z.object({id: safeId.max(64), name: z.string().min(1).max(80).refine((v) => [...v].every((c) => c.charCodeAt(0) >= 32 && c.charCodeAt(0) !== 127)), steps: z.array(z.object({kind: z.enum(['search', 'answer', 'computerUseDraft'])}).strict()).min(1).max(8)}).strict().refine((w) => {
  const drafts = w.steps.filter((s) => s.kind === 'computerUseDraft').length;
  return drafts === 0 || (drafts === 1 && w.steps[w.steps.length - 1]?.kind === 'computerUseDraft');
});
export const harnessVersionSchema = z.object({id: count, parentId: count.nullable(), createdAt: count, answerInstructions: z.string(), computerUseInstructions: z.string(), toolHints: z.string(), preferences: z.array(preferenceSchema), workflows: z.array(workflowSchema).max(16)}).strict();
export const candidateManifestSchema = z.object({baseVersion: count, kind: z.enum(['memory', 'prompt', 'workflow']), summary: z.string().min(1).max(500), evidenceDigest: digest, answerInstructions: z.string().max(8192).nullable(), computerUseInstructions: z.string().max(8192).nullable(), toolHints: z.string().max(8192).nullable(), preferences: z.array(preferenceSchema), workflows: z.array(workflowSchema).max(16)}).strict();
const measurementsSchema = z.object({runs: count, successes: count, latenciesMs: z.array(count), inputTokens: count.nullable(), outputTokens: count.nullable()}).strict();
export const evaluationReportSchema = z.object({id: safeId, candidateHash: digest, baseVersion: count, configDigest: digest, suiteVersion: z.string(), complete: z.boolean(), budgetExceeded: z.boolean(), cases: z.array(z.object({id: safeId, set: z.enum(['development', 'heldOut']), safety: z.boolean(), baseline: measurementsSchema, candidate: measurementsSchema}).strict()), passed: z.boolean(), reasons: z.array(z.string()), hash: digest}).strict();
export const candidateSchema = z.object({id: safeId, baseVersion: count, kind: z.enum(['memory', 'prompt', 'workflow']), summary: z.string(), hash: digest, evidenceDigest: digest, configDigest: digest, createdAt: count, status: z.enum(['proposed', 'evaluating', 'rejected', 'awaitingApproval', 'promoted', 'stale', 'cancelled']), manifest: candidateManifestSchema, report: evaluationReportSchema.nullable()}).strict();
export const approvalSchema = z.object({candidateId: safeId, candidateHash: digest, baseVersion: count, reportHash: digest}).strict();
export const improvementSnapshotSchema = z.object({settings: improvementSettingsSchema, activeVersion: harnessVersionSchema, candidates: z.array(candidateSchema), traceCount: count, job: z.object({id: safeId, phase: z.string()}).strict().nullable(), paused: z.boolean()}).strict();
export const improvementHealthSchema = z.object({state: z.enum(['ready', 'disabled', 'unavailable', 'paused']), version: z.string(), detail: z.string().nullable(), prepared: z.boolean(), modelReady: z.boolean()}).strict();
export const improvementEventSchema = z.object({type: z.enum(['started', 'progress', 'completed', 'cancelled', 'failed']), jobId: safeId, phase: z.string(), message: z.string().nullable()}).strict();
export const workflowAuthorizationSchema = z.object({runId: safeId, versionId: count, workflow: workflowSchema}).strict();
export type ImprovementSettings = z.infer<typeof improvementSettingsSchema>;
export type HarnessVersion = z.infer<typeof harnessVersionSchema>;
export type ImprovementSnapshot = z.infer<typeof improvementSnapshotSchema>;
export type ImprovementHealth = z.infer<typeof improvementHealthSchema>;
export type ImprovementEvent = z.infer<typeof improvementEventSchema>;
export type ImprovementCandidate = z.infer<typeof candidateSchema>;
export type EvaluationReport = z.infer<typeof evaluationReportSchema>;
export type ApprovalRef = z.infer<typeof approvalSchema>;
export type Preference = z.infer<typeof preferenceSchema>;
export type WorkflowDefinition = z.infer<typeof workflowSchema>;
export type WorkflowAuthorization = z.infer<typeof workflowAuthorizationSchema>;
export const defaultImprovementSettings: ImprovementSettings = {enabled: false, cloudConsent: false, routeMode: 'local', paused: false};
export function emptyImprovementSnapshot(): ImprovementSnapshot {
  return {settings: {...defaultImprovementSettings}, activeVersion: {id: 0, parentId: null, createdAt: 0, answerInstructions: '', computerUseInstructions: '', toolHints: '', preferences: [], workflows: []}, candidates: [], traceCount: 0, job: null, paused: false};
}
export function approvalFor(candidate: ImprovementCandidate, version: number): ApprovalRef | null {
  const report = candidate.report;
  if (candidate.status !== 'awaitingApproval' || candidate.baseVersion !== version || !report?.passed || !report.complete || report.budgetExceeded || report.candidateHash !== candidate.hash || report.baseVersion !== version || report.configDigest !== candidate.configDigest) return null;
  return {candidateId: candidate.id, candidateHash: candidate.hash, baseVersion: version, reportHash: report.hash};
}
