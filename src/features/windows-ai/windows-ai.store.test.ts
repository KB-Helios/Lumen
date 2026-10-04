import {describe, expect, it, vi} from 'vitest';
import {UnavailableWindowsAiService} from '../../services/windows-ai/unavailable-windows-ai-service';
import {createWindowsAiStore} from './windows-ai.store';

describe('Windows AI persisted controls', () => {
  it('retains the previous preference if a durable write fails', async () => {
    const service = new UnavailableWindowsAiService({getItem: () => null, setItem: () => { throw new Error('Storage unavailable'); }});
    const store = createWindowsAiStore(service);
    await store.getState().refresh();
    await store.getState().update({modelDownloadsAllowed: true});
    expect(store.getState().snapshot?.preferences.modelDownloadsAllowed).toBe(false);
    expect(store.getState().message).toBe('Storage unavailable');
    expect(store.getState().busy).toBe(false);
  });
  it('refreshes passive readiness without preparing any model', async () => {
    const service = new UnavailableWindowsAiService();
    const prepare = vi.spyOn(service, 'prepare');
    const store = createWindowsAiStore(service);
    await store.getState().refresh();
    expect(store.getState().snapshot?.features.every((feature) => feature.availability === 'unsupported')).toBe(true);
    expect(prepare).not.toHaveBeenCalled();
  });
  it('keeps previously recorded permissions when another preference is updated', async () => {
    const service = new UnavailableWindowsAiService({getItem: () => null, setItem: () => undefined});
    const store = createWindowsAiStore(service);
    await store.getState().refresh();
    await store.getState().update({modelDownloadsAllowed: true});
    await store.getState().update({appContentEnabled: true});
    expect(store.getState().snapshot?.preferences.modelDownloadsAllowed).toBe(true);
    expect(store.getState().snapshot?.preferences.appContentEnabled).toBe(true);
  });
});
