import {afterEach, describe, expect, it} from 'vitest';
import {DevelopmentImprovementService} from '../../services/improvement/development-improvement-service';
import type {ImprovementEvent} from '../../services/improvement/improvement.types';
import {useImprovementStore} from './improvement.store';

afterEach(() => useImprovementStore.getState().reset());
describe('improvement job controls', () => {
  it('clears in-flight state and ignores later events after deleting learning data', async () => {
    let publish: ((event: ImprovementEvent) => void) | undefined;
    const service = new DevelopmentImprovementService();
    service.analyze = async (onEvent) => {publish = onEvent;};
    await useImprovementStore.getState().analyze(service);
    expect(useImprovementStore.getState().analyzing).toBe(true);
    await useImprovementStore.getState().clear(service);
    publish!({type: 'progress', jobId: 'old', phase: 'old', message: 'Old job still running'});
    expect(useImprovementStore.getState().analyzing).toBe(false);
    expect(useImprovementStore.getState().message).not.toContain('Old job');
    expect(useImprovementStore.getState().snapshot.settings.enabled).toBe(false);
  });
});
