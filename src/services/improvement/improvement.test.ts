import {describe, expect, it} from 'vitest';
import {approvalFor, executionTraceSchema, improvementEventSchema, improvementSnapshotSchema, preferenceSchema, workflowSchema} from './improvement.types';
import {DevelopmentImprovementService} from './development-improvement-service';
import {UnavailableImprovementService} from './unavailable-improvement-service';

describe('improvement boundaries', () => {
  it('rejects source content in metadata, arbitrary workflow arguments and unapproved preference values', async () => {
    const service = new DevelopmentImprovementService();
    const snapshot = await service.snapshot();
    expect(improvementSnapshotSchema.safeParse({...snapshot, task: 'secret task'}).success).toBe(false);
    const trace = {id: 'synthetic-run', at: 1, toolId: 'files.search', model: 'a'.repeat(64), route: 'lumen.search', errorCode: 'none', outcome: 'completed', verified: false, durationMs: 3, inputTokens: null, outputTokens: null, harnessVersion: 0};
    expect(executionTraceSchema.safeParse(trace).success).toBe(true);
    for (const field of ['task', 'prompt', 'path', 'fileContent', 'screenshot', 'controlValue', 'credentials']) expect(executionTraceSchema.safeParse({...trace, [field]: 'private'}).success).toBe(false);
    expect(executionTraceSchema.safeParse({...trace, model: 'C:/secret'}).success).toBe(false);
    expect(workflowSchema.safeParse({id: 'w', name: 'Work', steps: [{kind: 'search', args: 'script'}]}).success).toBe(false);
    expect(workflowSchema.safeParse({id: 'w', name: 'Work', steps: Array.from({length: 9}, () => ({kind: 'search'}))}).success).toBe(false);
    expect(workflowSchema.safeParse({id: 'w', name: 'Work', steps: [{kind: 'computerUseDraft'}, {kind: 'answer'}]}).success).toBe(false);
    expect(preferenceSchema.safeParse({name: 'answerLanguage', value: 'password'}).success).toBe(false);
    expect(improvementEventSchema.safeParse({type: 'completed', jobId: 'j', phase: 'done', message: null, path: 'C:/secret'}).success).toBe(false);
  });
  it('defaults off and grants improvement cloud consent independently', async () => {
    const service = new DevelopmentImprovementService();
    expect((await service.snapshot()).settings).toEqual({enabled: false, cloudConsent: false, routeMode: 'local', paused: false});
    await service.setSettings({enabled: true, cloudConsent: true, routeMode: 'cloud', paused: false});
    expect((await service.snapshot()).settings.cloudConsent).toBe(true);
  });
  it('only binds passing current reports and rejects stale approval references', async () => {
    const service = new DevelopmentImprovementService();
    await service.setSettings({enabled: true, cloudConsent: false, routeMode: 'local', paused: false});
    await service.prepare();
    await service.analyze(() => undefined);
    const snapshot = await service.snapshot();
    const candidate = snapshot.candidates[0]!;
    const approval = approvalFor(candidate, snapshot.activeVersion.id)!;
    expect(approval).toEqual({candidateId: candidate.id, candidateHash: candidate.hash, baseVersion: 0, reportHash: candidate.report!.hash});
    expect(approvalFor({...candidate, report: {...candidate.report!, passed: false}}, 0)).toBeNull();
    expect(approvalFor(candidate, 1)).toBeNull();
    await service.approve(approval);
    await expect(service.approve(approval)).rejects.toThrow();
    await service.rollback(0);
    expect((await service.snapshot()).activeVersion.id).toBe(0);
  });
  it('ordinary browsers cannot prepare, analyze or save successful changes', async () => {
    const service = new UnavailableImprovementService();
    expect((await service.health()).state).toBe('unavailable');
    await expect(service.prepare()).rejects.toThrow('native');
    await expect(service.savePreference({name: 'answerLanguage', value: 'en'})).rejects.toThrow('native');
  });
  it('returns the frozen candidate base after preferences create a different active version', async () => {
    const service = new DevelopmentImprovementService();
    await service.setSettings({enabled: true, cloudConsent: false, routeMode: 'local', paused: false});
    await service.prepare();
    await service.analyze(() => undefined);
    const candidate = (await service.snapshot()).candidates[0]!;
    await service.savePreference({name: 'answerLanguage', value: 'en'});
    const base = await service.candidateBase(candidate.id);
    expect(base.id).toBe(candidate.baseVersion);
    expect(base.preferences).toEqual([]);
    base.answerInstructions = 'Mutation outside the service';
    expect((await service.candidateBase(candidate.id)).answerInstructions).toBe('');
    expect((await service.snapshot()).activeVersion.preferences).toEqual([{name: 'answerLanguage', value: 'en'}]);
  });
});
