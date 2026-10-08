import {afterEach, describe, expect, it, vi} from 'vitest';
import {TauriImprovementService} from './tauri-improvement-service';
import {TauriProviderRegistryService} from '../ai/provider-registry-service';
import {emptyImprovementSnapshot} from './improvement.types';
const tauri = vi.hoisted(() => ({channels: [] as Array<(payload: unknown) => void>, invoke: vi.fn()}));
vi.mock('@tauri-apps/api/core', () => ({Channel: class {constructor(listener: (payload: unknown) => void) {tauri.channels.push(listener);}}, invoke: tauri.invoke}));
afterEach(() => {tauri.channels.length = 0; tauri.invoke.mockReset();});
describe('native improvement admission', () => {
  it('excludes cancelled runs, foreign jobs, extra fields and duplicate terminal events', async () => {
    tauri.invoke.mockResolvedValue(undefined);
    const service = new TauriImprovementService();
    const events: string[] = [];
    await service.analyze((event) => events.push(event.type));
    const first = tauri.channels[0];
    first({type: 'started', jobId: 'j', phase: 'analysis', message: null});
    first({type: 'progress', jobId: 'foreign', phase: 'analysis', message: null});
    await service.cancel();
    first({type: 'completed', jobId: 'j', phase: 'done', message: null});
    await service.analyze((event) => events.push(event.type));
    const second = tauri.channels[1];
    second({type: 'started', jobId: 'second', phase: 'analysis', message: null});
    second({type: 'progress', jobId: 'second', phase: 'analysis', message: null, task: 'secret'});
    second({type: 'completed', jobId: 'second', phase: 'done', message: null});
    expect(events).toEqual(['started', 'started', 'failed']);
  });
  it('native startup rejection cannot later report completion', async () => {
    tauri.invoke.mockRejectedValue(new Error('native startup failed'));
    const service = new TauriImprovementService();
    const events: string[] = [];
    await expect(service.analyze((event) => events.push(event.type))).rejects.toThrow('native startup failed');
    tauri.channels[0]({type: 'completed', jobId: 'j', phase: 'done', message: null});
    expect(events).toEqual([]);
  });
  it('rejects injected reports and scripts before invoking native', async () => {
    const service = new TauriImprovementService();
    await expect(service.approve({candidateId: 'c', candidateHash: 'a'.repeat(64), baseVersion: 0, reportHash: 'b'.repeat(64), report: {passed: true}} as never)).rejects.toThrow();
    await expect(service.setSettings({enabled: true, cloudConsent: false, routeMode: 'local', paused: false, executable: 'evil'} as never)).rejects.toThrow();
    expect(tauri.invoke).not.toHaveBeenCalled();
  });
  it('accepts improvement registry aliases while preserving existing aliases', async () => {
    const registry = new TauriProviderRegistryService(async () => ({providers: [], models: [], routes: ['lumen.answer.local', 'lumen.improvement.local', 'lumen.improvement.cloud'].map((alias) => ({alias, capability: 'answer', providerId: 'local', modelId: 'local:model', status: 'ready', baseUrl: null, upstreamModel: null}))}));
    expect((await registry.list()).routes).toHaveLength(3);
  });
  it('refuses unexpected response fields on a void preparation command', async () => {
    tauri.invoke.mockResolvedValue({prepared: true, path: 'C:/private'});
    await expect(new TauriImprovementService().prepare()).rejects.toThrow();
  });
  it('requests a candidate-bound original harness and strictly rejects extra response fields', async () => {
    const service = new TauriImprovementService();
    const base = emptyImprovementSnapshot().activeVersion;
    tauri.invoke.mockResolvedValue(base);
    await expect(service.candidateBase('candidate-one')).resolves.toEqual(base);
    expect(tauri.invoke).toHaveBeenCalledWith('improvement_candidate_base', {candidateId: 'candidate-one'});
    tauri.invoke.mockResolvedValue({...base, path: 'C:/private'});
    await expect(service.candidateBase('candidate-one')).rejects.toThrow();
  });
});
