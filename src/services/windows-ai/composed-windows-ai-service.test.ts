import {describe, expect, it, vi} from 'vitest';
import {EdgeAiService} from '../edge-ai/edge-ai-service';
import {ComposedWindowsAiService} from './composed-windows-ai-service';
import {UnavailableWindowsAiService} from './unavailable-windows-ai-service';
import type {WindowsAiFeature} from './windows-ai.types';

describe('combined host readiness', () => {
  it('cannot restore revoked consent when an older probe resolves late', async () => {
    const native = new UnavailableWindowsAiService({getItem: () => '{"edgeEnabled":true,"dictationEnabled":true}', setItem: () => undefined});
    const edge = new EdgeAiService();
    let resolveOld!: (features: WindowsAiFeature[]) => void;
    vi.spyOn(edge, 'status').mockImplementationOnce(() => new Promise((resolve) => {resolveOld = resolve;})).mockResolvedValue([]);
    const dictate = vi.spyOn(edge, 'startDictation').mockResolvedValue({stop: vi.fn()});
    const service = new ComposedWindowsAiService(native, edge);
    const old = service.status();
    await vi.waitFor(() => expect(resolveOld).toBeTypeOf('function'));
    await service.updatePreferences({dictationEnabled: false});
    resolveOld([]);
    expect((await old).preferences.dictationEnabled).toBe(false);
    await service.startDictation({onText: vi.fn(), onEnd: vi.fn(), onError: vi.fn()});
    expect(dictate).toHaveBeenCalledWith(expect.objectContaining({dictationEnabled: false}), expect.anything());
  });
});
